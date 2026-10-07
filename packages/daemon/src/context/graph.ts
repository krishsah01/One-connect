// SPDX-License-Identifier: Apache-2.0
// graphify code knowledge graph of the integration branch. The control center keeps a private,
// detached worktree of the integration branch and runs `graphify update` there (AST only, no
// LLM, no cost) whenever the branch moves. Agents query it through the acc MCP tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GraphifyConfig, GraphStatus } from '@acc/core';
import { run } from '../exec.ts';
import { whichAll } from '../adapters/agents/detect.ts';
import { git, revParse } from '../adapters/vcs/git.ts';

/** LLM API keys graphify could pick up; stripped unless semantic extraction is opted in. */
const LLM_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY'];

export class GraphContext {
  readonly cfg: GraphifyConfig;
  readonly repo: string;
  readonly branch: string;
  readonly dir: string;
  private building: Promise<GraphStatus> | null = null;
  private abort=new AbortController();
  private redact:(s:string)=>string;
  stop(){this.abort.abort();}
  status: GraphStatus;

  constructor(cfg: GraphifyConfig, o: { repo: string; branch: string; dir: string; redact?:(s:string)=>string }) {
    this.cfg = cfg;
    this.repo = o.repo;
    this.branch = o.branch;
    this.dir = o.dir;
    this.redact=o.redact??(s=>s);
    this.status = this.readStatus();
  }

  binary(): string | null {
    const cands = [this.cfg.binary, ...whichAll(['graphify']), path.join(os.homedir(), '.local', 'bin', 'graphify')].filter(Boolean) as string[];
    return cands.find((p) => fs.existsSync(p)) ?? null;
  }

  graphPath(): string {
    return path.join(this.dir, 'graphify-out', 'graph.json');
  }

  reportPath(): string {
    return path.join(this.dir, 'graphify-out', 'GRAPH_REPORT.md');
  }

  private env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (!this.cfg.semantic) for (const k of LLM_KEYS) delete env[k];
    return env;
  }

  private readStatus(extra: Partial<GraphStatus> = {}): GraphStatus {
    const g = this.graphPath();
    let nodes = 0;
    let edges = 0;
    let builtAt: string | null = null;
    if (fs.existsSync(g)) {
      try {
        const j = JSON.parse(fs.readFileSync(g, 'utf8')) as { nodes?: unknown[]; links?: unknown[]; edges?: unknown[] };
        nodes = j.nodes?.length ?? 0;
        edges = (j.links ?? j.edges ?? []).length;
        builtAt = fs.statSync(g).mtime.toISOString();
      } catch {
        /* corrupt: treated as missing */
      }
    }
    let sha: string | null = null;
    try {
      const recorded=fs.readFileSync(path.join(this.dir, 'graphify-out', '.acc-sha'), 'utf8').trim();
      sha=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(recorded)?recorded:null;
    } catch {
      /* never built */
    }
    return {
      state: !this.binary() ? 'unavailable' : builtAt&&sha ? 'ready' : 'missing',
      sha,
      builtAt,
      nodes,
      edges,
      durationMs: null,
      graphPath: builtAt ? g : null,
      semantic: this.cfg.semantic,
      error: !this.binary() ? 'graphify is not installed (pip install graphifyy, or uv tool install graphifyy)' : null,
      ...extra,
    };
  }

  /** Integration-branch HEAD, or null if the branch doesn't exist yet. */
  async integrationSha(): Promise<string | null> {
    return revParse(this.repo, `refs/heads/${this.branch}`);
  }

  async needsRebuild(): Promise<boolean> {
    const sha = await this.integrationSha();
    return Boolean(sha && (this.status.state !== 'ready' || this.status.sha !== sha));
  }

  /** In-memory readiness is insufficient if the graph or its revision marker was removed. */
  current(sha:string):boolean {
    const disk=this.readStatus();return disk.state==='ready'&&disk.sha===sha;
  }

  /** One Answer gives Graphify an already redacted immutable snapshot, never the live repo. */
  rebuildSource(sha:string,onStart?:(s:GraphStatus)=>void):Promise<GraphStatus> {
    if(this.building)return this.building;
    this.building=(async()=>{
      const bin=this.binary();
      if(!bin)return this.status=this.readStatus();
      this.status={...this.status,state:'building',error:null};onStart?.(this.status);
      const start=Date.now();
      try {
        // AST extraction only. Paid semantic extraction is a separately approved integration.
        const env=this.env();for(const k of LLM_KEYS)delete env[k];
        const r=await run(bin,['update','.','--force'],{cwd:this.dir,env,signal:this.abort.signal,timeoutMs:10*60_000});
        if(r.code!==0)throw new Error(`Graphify AST extraction failed (${r.code ?? 'no exit code'})`);
        fs.writeFileSync(path.join(this.dir,'graphify-out','.acc-sha'),sha);
        this.status=this.readStatus({durationMs:Date.now()-start,semantic:false});
        if(this.status.state!=='ready')throw new Error('Graphify wrote no readable graph');
      }catch(e){this.status=this.readStatus({state:'error',error:this.redact((e as Error).message),durationMs:Date.now()-start,semantic:false});}
      return this.status;
    })().finally(()=>{this.building=null;});return this.building;
  }

  /** Build or refresh the graph at the current integration HEAD. Concurrent calls share one build. */
  rebuild(onStart?: (s: GraphStatus) => void): Promise<GraphStatus> {
    if (this.building) return this.building;
    this.building = (async () => {
      const bin = this.binary();
      if (!bin) return (this.status = this.readStatus());
      const sha = await this.integrationSha();
      if (!sha) return (this.status = this.readStatus({ state: 'error', error: this.redact(`branch ${this.branch} does not exist yet`) }));
      this.status = { ...this.status, state: 'building', error: null };
      onStart?.(this.status);
      const t0 = Date.now();
      try {
        if (!fs.existsSync(path.join(this.dir, '.git'))) {
          fs.mkdirSync(path.dirname(this.dir), { recursive: true });
          await git(this.repo, ['worktree', 'prune'], { allowFail: true });
          await git(this.repo, ['worktree', 'add', '--detach', this.dir, sha]);
        } else {
          await git(this.dir, ['checkout', '--detach', '--force', sha]);
        }
        const args = this.cfg.semantic ? ['extract', '.', ...(this.cfg.semantic_backend ? ['--backend', this.cfg.semantic_backend] : [])] : ['update', '.', '--force'];
        const r = await run(bin, args, { cwd: this.dir, env: this.env(), timeoutMs: 10 * 60_000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `graphify exited ${r.code}`);
        fs.writeFileSync(path.join(this.dir, 'graphify-out', '.acc-sha'), sha);
        this.status = this.readStatus({ durationMs: Date.now() - t0 });
        if (this.status.state !== 'ready') this.status = { ...this.status, state: 'error', error: 'graphify finished but wrote no graph.json' };
      } catch (e) {
        this.status = this.readStatus({ state: 'error', error: this.redact((e as Error).message), durationMs: Date.now() - t0 });
      }
      return this.status;
    })().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async cli(args: string[]): Promise<string> {
    const bin = this.binary();
    if (!bin) throw new Error('graphify is not installed');
    if (!fs.existsSync(this.graphPath())) throw new Error('the code graph has not been built yet');
    const r = await run(bin, [...args, '--graph', this.graphPath()], { cwd: this.dir, env: this.env(), timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(this.redact((r.stderr || r.stdout).trim() || `graphify exited ${r.code}`));
    return this.redact(r.stdout.trim());
  }

  query(question: string, o: { budget?: number; dfs?: boolean } = {}): Promise<string> {
    return this.cli(['query', this.redact(question), '--budget', String(o.budget ?? this.cfg.budget), ...(o.dfs ? ['--dfs'] : [])]);
  }

  path(from: string, to: string): Promise<string> {
    return this.cli(['path', this.redact(from), this.redact(to)]);
  }

  explain(node: string): Promise<string> {
    return this.cli(['explain', this.redact(node)]);
  }

  report(): string | null {
    try {
      return this.redact(fs.readFileSync(this.reportPath(), 'utf8'));
    } catch {
      return null;
    }
  }
}
