// SPDX-License-Identifier: Apache-2.0
import type { Actor, EventEnvelope, NewEvent, WorkflowLink } from '@acc/core';
import { containsSecret, HUMAN, newId, SYSTEM, WorkflowLinkInputSchema } from '@acc/core';
import { CommandError, type Daemon } from './daemon.ts';
import type { AnswerOptions } from './decisions.ts';
import { JEV_ACTOR } from './jev.ts';

export class WorkflowLinks {
  private chain: Promise<unknown> = Promise.resolve();
  private listening = false;
  private scheduled = false;
  private pending = new Set<string>();
  private changed = (events: EventEnvelope[]) => {
    if (events.some(e => ['workflow.status', 'workflow.saved', 'workflow_link.saved', 'decision.advisory', 'decision.answered'].includes(e.type))) {
      for (const link of this.list()) if (!['started', 'canceled'].includes(link.status)) this.schedule(link.id);
    }
  };
  readonly d: Daemon;
  constructor(d: Daemon) { this.d = d; }
  start() { if (this.listening) return; this.listening = true; this.d.bus.on('events', this.changed); for (const link of this.list()) this.schedule(link.id); }
  stop() { this.listening = false; this.d.bus.off('events', this.changed); this.pending.clear(); }
  async idle() { for (let i = 0; i < 100 && (this.pending.size || this.scheduled); i++) { await new Promise(r => setImmediate(r)); await this.chain; } await this.chain; }
  list(): WorkflowLink[] { return Object.values(this.d.state.workflowLinks ?? {}); }
  get(id: string): WorkflowLink { const link = this.d.state.workflowLinks?.[id]; if (!link) throw new CommandError('Unknown workflow link', 404); return link; }
  private requireHuman(actor: Actor) { if (actor.type !== 'human' || /^jev$/i.test(actor.id)) throw new CommandError('Only the owner can configure or choose a workflow link', 403); }
  private event(link: WorkflowLink, actor: Actor = SYSTEM): NewEvent { return { type: 'workflow_link.saved', actor, data: { link } }; }
  private persist(link: WorkflowLink, actor: Actor = SYSTEM) { this.d.commit([this.event(link, actor)]); }
  save(raw: unknown, actor: Actor = HUMAN): WorkflowLink {
    this.requireHuman(actor);
    const parsed = WorkflowLinkInputSchema.safeParse(raw);
    if (!parsed.success) throw new CommandError(parsed.error.issues.map(i => i.message).join('; '), 422);
    const input = parsed.data;
    if (containsSecret(JSON.stringify(input), { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from workflow links');
    const old = input.id ? this.d.state.workflowLinks?.[input.id] : null;
    if (input.id && !old) throw new CommandError('Unknown workflow link', 404);
    if (old && old.status !== 'waiting') throw new CommandError('Only waiting links can be edited', 409);
    const source = this.d.workflows.get(input.from);
    if (source.status === 'canceled') throw new CommandError('Source workflow is canceled', 409);
    if (input.to.includes(input.from) || new Set(input.to).size !== input.to.length) throw new CommandError('Targets must be distinct and cannot include the source');
    const versions: Record<string, number> = {};
    for (const id of input.to) { const w = this.d.workflows.get(id); if (w.status !== 'draft') throw new CommandError('Targets must be saved drafts', 409); versions[id] = w.version; }
    if (input.gate) {
      if (new Set(input.gate.options.map(o => o.label)).size !== input.gate.options.length || new Set(input.gate.options.map(o => o.to)).size !== input.to.length || input.gate.options.length !== input.to.length || input.gate.options.some(o => !input.to.includes(o.to))) throw new CommandError('Gate options must name each target exactly once with unique labels');
      if (input.gate.kind === 'human' && input.gate.jev) throw new CommandError('Human gates cannot have a Jev policy');
      if (input.gate.jev) {
        const c = this.d.jev.config();
        if (!c.enabled || input.gate.jev.host !== new URL(c.endpoint).host) throw new CommandError('Enable Jev and confirm its exact configured host first', 428);
        // Authentication proves this save is an owner action; confirmation identity is server-authored.
        input.gate.jev = { ...input.gate.jev, confirmedAt: this.d.nowIso(), confirmedBy: actor.id };
      }
    }
    const edges = this.list().filter(l => l.id !== old?.id && l.status !== 'canceled');
    const reaches = (id: string, seen = new Set<string>()): boolean => { if (id === input.from) return true; if (seen.has(id)) return false; seen.add(id); return edges.filter(l => l.from === id).some(l => l.to.some(to => reaches(to, seen))); };
    if (input.to.some(id => reaches(id))) throw new CommandError('Workflow links cannot form a cycle');
    if (edges.some(l => !['started', 'canceled'].includes(l.status) && l.to.some(id => input.to.includes(id)))) throw new CommandError('A target already belongs to another pending link', 409);
    const link: WorkflowLink = { id: old?.id ?? newId('wfl'), from: input.from, to: input.to, gate: input.gate, status: 'waiting', decision: null, decisionId: null, targetVersions: versions, started: [], jevAttempted: false, reason: null };
    this.persist(link, actor); return this.get(link.id);
  }
  cancel(id: string, actor: Actor = HUMAN): WorkflowLink {
    this.requireHuman(actor); return this.cancelInternal(id, actor);
  }
  private cancelInternal(id: string, actor: Actor = SYSTEM): WorkflowLink {
    const link = this.get(id);
    if (link.status === 'canceled') return link;
    if (link.status === 'started') throw new CommandError('The next workflow already started; cancel it directly', 409);
    const events = [this.event({ ...link, status: 'canceled', reason: 'Link canceled' }, actor)];
    if (link.decisionId && !this.d.state.decisions[link.decisionId]?.consumedAt) events.push({ type: 'decision.consumed', actor, data: { decisionId: link.decisionId, outcome: 'workflow link canceled' } });
    this.d.commit(events); return this.get(id);
  }
  async decide(id: string, option: string, actor: Actor = HUMAN, options: AnswerOptions = {}): Promise<WorkflowLink> {
    this.requireHuman(actor);
    const link = this.get(id);
    if (link.status !== 'open' || !link.gate || !link.decisionId) throw new CommandError('This workflow gate is not open', 409);
    if (this.d.workflows.get(link.from).status !== 'completed') throw new CommandError('Source workflow no longer has completion evidence', 409);
    if (!link.gate.options.some(o => o.label === option)) throw new CommandError('Choose one of this gate’s predefined options');
    const next = { ...link, status: 'decided' as const, decision: { option, by: 'human' as const, at: this.d.nowIso() }, reason: null };
    this.d.decisions.answerAtomic(link.decisionId, option, options, actor, [this.event(next, actor), { type: 'decision.consumed', actor, data: { decisionId: link.decisionId, outcome: 'workflow target selected' } }]);
    await this.evaluate(id); return this.get(id);
  }
  private schedule(id: string) {
    if (!this.listening) return;
    this.pending.add(id); if (this.scheduled) return; this.scheduled = true;
    setImmediate(() => { this.scheduled = false; const ids = [...this.pending]; this.pending.clear(); if (!this.listening) return; for (const next of ids) void this.evaluate(next); });
  }
  evaluate(id: string): Promise<void> {
    const p = this.chain.then(() => this.evaluateNow(id));
    this.chain = p.catch(e => { if (!this.d.closed) this.d.alert({ kind: 'workflow', severity: 'warn', message: `Workflow link ${id}: ${(e as Error).message}`, dedupeKey: `workflow-link:${id}` }); });
    return this.chain as Promise<void>;
  }
  private async evaluateNow(id: string) {
    if (!this.listening || this.d.closed) return;
    let link = this.get(id);
    if (['started', 'canceled'].includes(link.status)) return;
    const source = this.d.workflows.get(link.from);
    if (source.status === 'canceled') { this.cancelInternal(id); return; }
    if (source.status !== 'completed') return;
    if (link.status === 'waiting') {
      if (!link.gate) this.persist({ ...link, status: 'decided' });
      else this.d.decisions.createBound({ question: link.gate.question, options: link.gate.options.map(o => o.label), kind: 'question', irreversible: false, risk: 'low', action: null, evidence: [{ label: 'Source workflow', detail: `${link.from} completed; options start only saved draft workflows.`, ok: true }] }, SYSTEM,
        decisionId => [this.event({ ...link, status: 'open', decisionId })],
        decisionId => this.d.store.kvSet(`workflow-link:decision:${decisionId}`, id));
      link = this.get(id);
    }
    if (link.status === 'open' && link.gate?.kind === 'jev' && link.gate.jev && !link.jevAttempted) {
      this.persist({ ...link, jevAttempted: true });
      try { await this.d.jev.requestWorkflowGate(id); }
      catch (e) { if (this.get(id).status === 'open') this.persist({ ...this.get(id), reason: `Jev unavailable; owner must choose: ${this.d.redactText((e as Error).message).slice(0, 300)}` }); }
      if (!this.listening || this.d.closed) return;
      link = this.get(id);
    }
    // A persisted advisory can be consumed after restart; no second metered request is made.
    if (link.status === 'open' && link.gate?.jev?.autoDecide && link.decisionId) {
      const dec = this.d.state.decisions[link.decisionId], advisory = dec?.advisory;
      if (advisory && !advisory.stale && link.gate.options.some(o => o.label === advisory.recommendation)) {
        try {
          this.d.jev.assertWorkflowGate(id);
          if (this.d.jev.buildEvidence(dec).hash !== advisory.inputHash) throw new CommandError('Gate evidence changed');
          this.d.commit([this.event({ ...link, status: 'decided', decision: { option: advisory.recommendation, by: 'jev', at: this.d.nowIso(), advisoryId: `${dec.id}:${advisory.inputHash}` }, reason: null }, JEV_ACTOR), { type: 'decision.consumed', actor: JEV_ACTOR, data: { decisionId: dec.id, outcome: 'owner-configured workflow routing policy selected a target; no action approval granted' } }]);
          link = this.get(id);
        } catch { /* Human decision stays open if policy, host or evidence no longer match. */ }
      }
    }
    if (link.status !== 'decided') return;
    const targets = link.gate ? [link.gate.options.find(o => o.label === link.decision?.option)!.to] : link.to;
    for (const target of targets) {
      link = this.get(id);
      if (!this.listening || this.d.closed || link.status === 'canceled' || this.d.workflows.get(link.from).status !== 'completed') return;
      if (link.started.includes(target)) continue;
      const w = this.d.workflows.get(target);
      if (w.status !== 'draft' || w.version !== link.targetVersions[target]) { if (!link.reason) this.persist({ ...link, reason: 'Target changed since link confirmation; cancel and configure a new link.' }); return; }
      // Target start and the durable receipt are one event-store transaction.
      await this.d.workflows.launch(target, SYSTEM, [this.event({ ...link, started: [...link.started, target] })]);
    }
    link = this.get(id);
    if (link.status !== 'canceled') this.persist({ ...link, status: 'started', reason: null });
  }
}
