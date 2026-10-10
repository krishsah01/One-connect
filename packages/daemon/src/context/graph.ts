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
  private stopped=false;
  private redact:(s:string)=>string;
  /** Shutdown: permanent. */
  stop(){this.stopped=true;this.abort.abort();}
  /** Cancel the current build only; later builds get a fresh signal. */
  cancel(){this.abort.abort();if(!this.stopped)this.abort=new AbortController();}
  /** Obsolete privacy/scope caches must not survive a policy change, even if rebuilding fails. */
  invalidateSourcePolicy():void {
    if(this.building)throw new Error('Cannot change the graph source policy during a build');
    for(const dir of [this.dir,`${this.dir}.previous`,`${this.dir}.next`])fs.rmSync(dir,{recursive:true,force:true});
    this.status=this.readStatus();
  }
  status: GraphStatus;

  constructor(cfg: GraphifyConfig, o: { repo: string; branch: string; dir: string; redact?:(s:string)=>string }) {
    this.cfg = cfg;
    this.repo = o.repo;
    this.branch = o.branch;
    this.dir = o.dir;
    this.redact=o.redact??(s=>s);
    this.recoverPublished();
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

  /** Validate before promotion, including shape, size and owned regular-file boundaries. */
  private readableGraph(root:string):{nodes:number;edges:number;builtAt:string}|null {
    try {
      if(fs.lstatSync(root).isSymbolicLink())return null;
      const output=path.join(root,'graphify-out');
      if(!fs.lstatSync(output).isDirectory()||fs.lstatSync(output).isSymbolicLink())return null;
      const file=path.join(output,'graph.json'),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.nlink!==1||stat.size>32*1024*1024)return null;
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {
        const current=fs.fstatSync(fd);
        if(current.size>32*1024*1024||current.ino!==stat.ino)return null;
        const j=JSON.parse(fs.readFileSync(fd,'utf8')) as {nodes?:unknown;links?:unknown;edges?:unknown};
        const edges=j.links??j.edges;
        if(!Array.isArray(j.nodes)||!Array.isArray(edges)||[...j.nodes,...edges].some(x=>!x||typeof x!=='object'||Array.isArray(x)))return null;
        return {nodes:j.nodes.length,edges:edges.length,builtAt:current.mtime.toISOString()};
      }finally{fs.closeSync(fd);}
    }catch{return null;}
  }

  private recordedSha(root:string):string|null {
    try {
      const file=path.join(root,'graphify-out','.acc-sha'),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.nlink!==1||stat.size>128)return null;
      const sha=fs.readFileSync(file,'utf8').trim();
      return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)?sha:null;
    }catch{return null;}
  }

  private recordedGeneration():string|null {
    try {
      const file=path.join(this.dir,'graphify-out','.acc-generation'),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.nlink!==1||stat.size!==64)return null;
      const value=fs.readFileSync(file,'utf8');
      return /^[a-f0-9]{64}$/.test(value)?value:null;
    }catch{return null;}
  }

  /** A crash between the two directory renames must retain the last verified graph. */
  private recoverPublished():void {
    const previous=`${this.dir}.previous`;
    if(this.readableGraph(this.dir)&&this.recordedSha(this.dir))return;
    if(!this.readableGraph(previous)||!this.recordedSha(previous))return;
    try {
      fs.rmSync(this.dir,{recursive:true,force:true});
      fs.renameSync(previous,this.dir);
    }catch{/* keep the backup intact; a later build can retry recovery */}
  }

  private readStatus(extra: Partial<GraphStatus> = {}): GraphStatus {
    const g = this.graphPath(),graph=this.readableGraph(this.dir);
    const nodes=graph?.nodes??0,edges=graph?.edges??0,builtAt=graph?.builtAt??null;
    let sha: string | null = null;
    try {
      sha=this.recordedSha(this.dir);
    } catch {
      /* never built */
    }
    return {
      state: !this.binary() ? 'unavailable' : builtAt&&sha ? 'ready' : 'missing',
      sha,
      generation:this.recordedGeneration(),
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
  current(sha:string,generation?:string):boolean {
    const disk=this.readStatus();return disk.state==='ready'&&disk.sha===sha&&(!generation||disk.generation===generation);
  }

  /**
   * Dictionary gives Graphify an already redacted immutable snapshot, never the live repo. The
   * snapshot is built in a private staging directory; the current graph is replaced only after a
   * successful AST build, so a failure leaves the previous graph in place, labelled with its own
   * revision (and therefore visibly stale), instead of an empty or half-written one.
   */
  buildSnapshot(sha:string,files:Iterable<{path:string;content:string}>,onStart?:(s:GraphStatus)=>void,generation?:string):Promise<GraphStatus> {
    if(this.building)return this.building;
    this.building=(async()=>{
      const bin=this.binary();
      if(!bin)return this.status=this.readStatus();
      if(this.stopped)return this.status;
      const signal=this.abort.signal,stage=`${this.dir}.next`,previous=`${this.dir}.previous`;
      let movedOld=false,promoted=false;
      this.status={...this.readStatus(),state:'building',error:null};onStart?.(this.status);
      const start=Date.now();
      try {
        fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true,mode:0o700});
        for(const file of files){
          const dest=path.resolve(stage,file.path);
          if(!dest.startsWith(stage+path.sep))continue; // snapshot paths are validated upstream; never escape the stage
          fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,file.content,{mode:0o600});
        }
        // AST extraction only. Paid semantic extraction is a separately approved integration.
        const env=this.env();for(const k of LLM_KEYS)delete env[k];
        const r=await run(bin,['update','.','--force'],{cwd:stage,env,signal,timeoutMs:10*60_000});
        if(signal.aborted)throw new Error('Graphify build was cancelled');
        if(r.code!==0)throw new Error(`Graphify AST extraction failed (${r.code ?? 'no exit code'})`);
        if(!this.readableGraph(stage))throw new Error('Graphify wrote no readable graph');
        if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))throw new Error('Graphify source revision is invalid');
        fs.writeFileSync(path.join(stage,'graphify-out','.acc-sha'),sha,{flag:'wx',mode:0o600});
        if(generation){
          if(!/^[a-f0-9]{64}$/.test(generation))throw new Error('Graphify source generation is invalid');
          fs.writeFileSync(path.join(stage,'graphify-out','.acc-generation'),generation,{flag:'wx',mode:0o600});
        }
        this.recoverPublished();
        if(fs.existsSync(previous)&&!this.readableGraph(this.dir))throw new Error('Previous graph recovery is required before replacing it');
        fs.rmSync(previous,{recursive:true,force:true});
        if(fs.existsSync(this.dir)){fs.renameSync(this.dir,previous);movedOld=true;}
        fs.renameSync(stage,this.dir);promoted=true;
        this.status=this.readStatus({durationMs:Date.now()-start,semantic:false});
        if(this.status.state!=='ready')throw new Error('Graphify wrote no readable graph');
        // The new graph is verified. Cleanup failure need not invalidate that publication.
        try{fs.rmSync(previous,{recursive:true,force:true});}catch{/* recoverable cache cleanup */}
      }catch(e){
        if(movedOld) {
          try {
            if(promoted)fs.rmSync(this.dir,{recursive:true,force:true});
            fs.renameSync(previous,this.dir);
          }catch{/* preserve .previous for recovery on restart */}
        }
        try{fs.rmSync(stage,{recursive:true,force:true});}catch{/* private staging cleanup */}
        this.status=this.readStatus({state:'error',error:this.redact((e as Error).message),durationMs:Date.now()-start,semantic:false});
      }
      return this.status;
    })().finally(()=>{this.building=null;});return this.building;
  }

  /** Back-compatible entry: build from files already written to `dir`. */
  rebuildSource(sha:string,onStart?:(s:GraphStatus)=>void):Promise<GraphStatus> {
    const files:{path:string;content:string}[]=[];
    const walk=(d:string,rel:string)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==='graphify-out')continue;const p=path.join(d,e.name),r=rel?`${rel}/${e.name}`:e.name;if(e.isDirectory())walk(p,r);else if(e.isFile())files.push({path:r,content:fs.readFileSync(p,'utf8')});}};
    try{walk(this.dir,'');}catch{/* empty snapshot */}
    return this.buildSnapshot(sha,files,onStart);
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
