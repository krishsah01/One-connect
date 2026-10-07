// SPDX-License-Identifier: Apache-2.0
// Keeps shared context current: Obsidian notes (contract, brief, issues, handoffs, decisions)
// rewritten from live state on change, and the graphify graph rebuilt when integration moves.
import path from 'node:path';
import fs from 'node:fs';
import type { EventEnvelope } from '@acc/core';
import { KnowledgeConfigSchema,GraphifyConfigSchema } from '@acc/core';
import type { Daemon } from '../daemon.ts';
import { expandHome } from '../paths.ts';
import { GraphContext } from './graph.ts';
import { briefNote, contractNote, decisionNote, handoffNote, issueNote, noteLinks, type NoteLinks } from './notes.ts';
import { Vault,projectNamespace } from './vault.ts';
import { AskDocs } from './docs.ts';
import { OneAnswer } from './one-answer.ts';
import { designMarkdown } from '@acc/core';

export class ContextSync {
  readonly d: Daemon;
  readonly vault: Vault | null;
  readonly graph: GraphContext | null;
  readonly links: NoteLinks | null;
  readonly docs: AskDocs | null;
  readonly answer:OneAnswer;
  readonly privateVault:boolean;
  readonly knowledgeConfig;
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private dirtyItems = new Set<string>();
  private dirtyRuns = new Set<string>();
  private dirtyDecisions = new Set<string>();
  private briefDirty = false;
  private contractDirty = false;
  private onEvents = (events: EventEnvelope[]) => this.mark(events);

  constructor(d: Daemon) {
    this.d = d;
    this.privateVault=!d.config.knowledge;
    const privateRoot=path.join(d.paths.root,'context','vault');
    if(this.privateVault)fs.mkdirSync(privateRoot,{recursive:true,mode:0o700});
    const k = d.config.knowledge??KnowledgeConfigSchema.parse({vault:privateRoot,folder:'One Connect',obsidian_cli:'off'});
    this.knowledgeConfig=k;
    const owner=projectNamespace(d.config.project.repo);
    this.vault = k ? new Vault(k, expandHome(k.vault),owner) : null;
    this.links = this.vault ? noteLinks(this.vault.folder, (rel, label) => this.vault!.link(rel, label)) : null;
    this.docs = this.vault ? new AskDocs(this.vault, path.join(d.paths.root, 'context', 'docs.sqlite'), d.egress.fetch, text => d.redactText(text)) : null;
    const g = d.config.graphify??GraphifyConfigSchema.parse({});
    this.graph = g.enabled ? new GraphContext(g, { repo: d.config.project.repo, branch: d.config.project.integration_branch, dir: path.join(d.paths.root, 'context', owner, 'one-answer-source'),redact:s=>d.redactText(s) }) : null;
    this.answer=new OneAnswer(d,this.vault!,this.docs!,this.graph);
  }

  get enabled(): boolean {
    return Boolean(this.vault || this.graph);
  }

  /** Paths the assignment template points agents (and relay humans) at. */
  templateContext() {
    if (!this.enabled) return undefined;
    const abs = (rel: string) => (this.vault ? path.join(this.vault.root, rel) : rel);
    return {
      contractNote: this.vault && this.links && this.vault.cfg.write.contract ? abs(this.links.contract) : null,
      briefNote: this.vault && this.links && this.vault.cfg.write.brief ? abs(this.links.brief) : null,
      graph: Boolean(this.graph && this.graph.status.state !== 'unavailable'),
      vault: Boolean(this.vault),
    };
  }

  start(): void {
    if (!this.enabled) return;
    this.d.bus.on('events', this.onEvents);
    this.d.commit([{type:'context.answer',data:{status:this.answer.status}}]);
    this.contractDirty = this.briefDirty = true;
    for (const w of Object.values(this.d.state.workItems)) if (w.key) this.dirtyItems.add(w.id);
    for (const r of Object.values(this.d.state.runs)) if (r.handoff) this.dirtyRuns.add(r.id);
    for (const a of Object.values(this.d.state.approvals)) if (a.resolvedAt && a.decision !== 'expired') this.dirtyDecisions.add(a.id);
    this.schedule(50);
    if (this.graph) {
      this.d.commit([{ type: 'context.graph', data: { status: this.graph.status } }]);
      if (this.graph.cfg.auto_update) {
        this.poll = setInterval(() => void this.answer.refresh(false), 60_000);
      }
    }
    void this.answer.refresh(false);
  }

  stop(): void {
    this.answer.stop();
    this.d.bus.off('events', this.onEvents);
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = this.poll = null;
  }

  private mark(events: EventEnvelope[]): void {
    let any = false;
    for (const e of events) {
      if (e.type.startsWith('context.')) continue;
      if (e.kind === 'transcript') continue; // the brief changes on control events only
      any = true;
      if (e.workItemId) this.dirtyItems.add(e.workItemId);
      if (e.type === 'run.handoff' && e.runId) this.dirtyRuns.add(e.runId);
      if (e.type === 'approval.resolved') this.dirtyDecisions.add(e.data.approvalId);
      if (e.type === 'config.loaded' || e.type === 'agent.registered' || e.type === 'rule.toggled') this.contractDirty = true;
    }
    if (any) {
      this.briefDirty = true;
      this.schedule();
    }
  }

  private schedule(ms = 1500): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
  }

  /** Write every dirty note now. Returns the number of files actually changed. */
  flush(): number {
    const v = this.vault;
    const L = this.links;
    if (!v || !L || this.d.closed) return 0;
    const s = this.d.state;
    const cfg = this.d.config;
    const w = v.cfg.write;
    let n = 0;
    const put = (rel: string, content: string) => {
      try {
        if (v.write(rel, this.d.redactText(content))) n++;
      } catch {
        /* surfaced through vault status */
      }
    };
    if (this.contractDirty && w.contract) put(L.contract, contractNote(cfg, s, L, Boolean(this.graph)));
    if (this.briefDirty && w.brief) put(L.brief, briefNote(cfg, s, L, this.d.nowIso()));
    if(s.design)put(v.notePath('DESIGN.md'),designMarkdown(s.design));
    if(s.mocks&&Object.keys(s.mocks).length)put(v.notePath('Design artifacts.md'),this.d.mocks.contextNote());
    if (w.issues) for (const id of this.dirtyItems) {
      const item = s.workItems[id];
      if (item?.key) put(L.issue(item.key), issueNote(item, s, L));
    }
    if (w.handoffs) for (const id of this.dirtyRuns) {
      const r = s.runs[id];
      if (r?.handoff) put(L.handoff({ ...r, workItemKey: s.workItems[r.workItemId]?.key }), handoffNote(r, s, L));
    }
    if (w.decisions) for (const id of this.dirtyDecisions) {
      const a = s.approvals[id];
      if (a?.resolvedAt && a.decision !== 'expired') put(L.decision(a), decisionNote(a, s, L));
    }
    this.contractDirty = this.briefDirty = false;
    this.dirtyItems.clear();
    this.dirtyRuns.clear();
    this.dirtyDecisions.clear();
    const status = v.status();
    if (n > 0 || JSON.stringify({ ...status, lastWriteAt: null }) !== JSON.stringify({ ...(s.context?.vault ?? {}), lastWriteAt: null })) {
      this.d.commit([{ type: 'context.vault', data: { status } }]);
    }
    return n;
  }

  /** Rebuild the code graph if integration moved (or always, when forced). */
  async refreshGraph(force: boolean): Promise<void> {
    await this.answer.refresh(force);
  }

  /** Human or agent context search across notes and the code graph. */
  async search(query: string, o: { limit?: number; graph?: boolean } = {}): Promise<{ notes: { backend: string; hits: { path: string; snippet: string }[] } | null; graph: string | null }> {
    await this.answer.refresh(false);
    const retrieval = this.docs ? this.answer.cite(await this.docs.search(query, { limit: o.limit })) : null;
    const notes = retrieval ? { backend: retrieval.backend, hits: retrieval.citations.map(c => ({ path:c.path, snippet:c.excerpt, line:c.line, endLine:c.endLine, source:c.id,projectSource:c.projectSource })), warning:retrieval.warning } : null;
    let graph: string | null = null;
    if (o.graph !== false && this.graph?.status.state === 'ready') graph = this.d.redactText(await this.graph.query(this.d.redactText(query), { budget: 800 }).catch((e) => `graph query failed: ${(e as Error).message}`));
    if(this.docs && !this.d.closed) this.d.commit([{type:'context.docs',data:{status:this.docs.status()}}]);
    return { notes, graph };
  }

  brief(): string {
    const L = this.links ?? noteLinks('Agent Control Center', (rel, label) => `[[${rel.replace(/\.md$/, '')}${label ? `|${label}` : ''}]]`);
    return briefNote(this.d.config, this.d.state, L, this.d.nowIso());
  }
}
