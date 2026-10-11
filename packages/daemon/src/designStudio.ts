// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Designer studio orchestration. A brief becomes an ordinary issue and draft assignment that the
// human reviews and dispatches through the existing pre-flight; refinements continue the same
// session or get a scoped child issue; engineering handoffs bind to one approved identity. Nothing
// here runs a model, a shell or a browser. Runs stay in the durable run stream.
import fs from 'node:fs';
import path from 'node:path';
import {
  briefPages, containsSecret, designAgentEligibility, DesignBriefSchema, designIssueText, designSlug, engineeringIssueText, HUMAN, isActiveRun,
  jobStatus, mockGate, MOCK_DIR_RE, newId, refineMessage, SYSTEM,
  type Actor, type Assignment, type CaptureAttempt, type DesignJob, type DesignStudioEvent, type EventEnvelope, type MockRevision,
} from '@acc/core';
import { adapterFor } from './adapters/agents/index.ts';
import { CommandError } from './errors.ts';
import type { Kernel, WorkCommands } from './kernel.ts';
import type { Designer } from './designer.ts';
import type { DesignMocks } from './mocks.ts';
import type { RunManager } from './runManager.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type DesignStudioDeps = Kernel & Pick<WorkCommands, 'agentFree' | 'cancelAssignment' | 'createAssignment' | 'createIssue' | 'preflight' | 'updateAssignment'> & { readonly designer: Designer; readonly mocks: DesignMocks; readonly runs: RunManager };

const REFINE_MAX = 4000;

export class DesignStudio {
  readonly d: DesignStudioDeps;
  /** Runs whose completion already triggered an automatic capture attempt in this process. */
  private readonly autoCaptured = new Set<string>();
  private readonly captures=new Set<Promise<void>>();
  private stopped=false;
  private readonly eventListener=(events:EventEnvelope[])=>this.onEvents(events);
  constructor(d: DesignStudioDeps) {
    this.d = d;
    d.bus.on('events',this.eventListener);
  }

  /** Recover a completed run interrupted before its scheduled capture produced a receipt. */
  start():void {
    for(const run of Object.values(this.d.state.runs)) {
      if(run.state!=='finished'||run.exit?.kind!=='completed')continue;
      const job=this.jobForAssignment(run.assignmentId)??this.jobs().find(j=>j.assignmentId===run.assignmentId&&j.mode==='follow-up'&&j.runId===run.id&&!j.canceledAt);
      if(!job||!['generate','refine'].includes(job.kind))continue;
      const recorded=Object.values(this.d.state.designStudio?.captures??{}).some(c=>c.runId===run.id&&(c.ok||c.trigger==='auto'));
      if(!recorded)this.scheduleCapture(run.id,run.assignmentId,job.dir);
    }
  }

  async close():Promise<void>{
    this.stopped=true;this.d.bus.off('events',this.eventListener);
    await Promise.allSettled([...this.captures]);
  }

  private scheduleCapture(runId:string,assignmentId:string,dir:string):void {
    if(this.stopped||this.autoCaptured.has(runId))return;
    this.autoCaptured.add(runId);
    const task=new Promise<void>(resolve=>setImmediate(()=>{
      // Shutdown before this task started leaves no false failure receipt. Startup retries it.
      if(this.stopped){resolve();return;}
      void this.autoCapture(assignmentId,dir,runId).then(resolve,resolve);
    }));
    this.captures.add(task);void task.finally(()=>this.captures.delete(task));
  }

  private jobs(): DesignJob[] { return Object.values(this.d.state.designStudio?.jobs ?? {}); }
  job(id: string): DesignJob {
    const j = this.d.state.designStudio?.jobs[id];
    if (!j) throw new CommandError('Unknown design job', 404);
    return j;
  }
  /** The job whose deliverable an assignment's prompt describes (follow-ups reuse the original). */
  jobForAssignment(assignmentId: string): DesignJob | null {
    return this.jobs().filter(j => j.assignmentId === assignmentId && j.mode === 'new-assignment' && !j.canceledAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  }
  /** A refinement on its own assignment continues an existing artifact rather than starting one. */
  continuedArtifact(assignmentId: string, dir: string): string | null {
    const j = this.jobForAssignment(assignmentId);
    return j?.kind === 'refine' && j.artifactId && j.dir === dir ? j.artifactId : null;
  }

  private record(e: DesignStudioEvent, actor: Actor, refs: { workItemId?: string | null; assignmentId?: string | null; agentId?: string | null; runId?: string | null } = {}) {
    this.d.commit([{ type: 'design.studio', actor, workItemId: refs.workItemId ?? null, assignmentId: refs.assignmentId ?? null, agentId: refs.agentId ?? null, runId: refs.runId ?? null, data: e }]);
  }
  /** Re-render the assignment text now that its job exists (edited prompts are left alone). */
  private refreshPrompt(a: Assignment) {
    if (!a.promptEdited) this.d.updateAssignment(a.id, {}, HUMAN);
  }

  view(job: DesignJob) {
    const st = jobStatus(job, this.d.state);
    const a = this.d.state.assignments[job.assignmentId], item = this.d.state.workItems[job.workItemId];
    return {
      job,
      status: { ...st, runs: st.runs.map(r => ({ id: r.id, state: r.state, createdAt: r.createdAt, endedAt: r.endedAt, exit: r.exit })), run: st.run ? { id: st.run.id, state: st.run.state, exit: st.run.exit } : null, revision: st.revision ? { rev: st.revision.rev, hash: st.revision.hash } : null },
      issue: item ? { id: item.id, key: item.key, title: item.title, state: item.state } : null,
      assignment: a ? { id: a.id, agentId: a.agentId, position: a.position, allowedPaths: a.allowedPaths, worktree: a.worktree, branch: a.branch, designRevision: a.designRevision ?? null, promptEdited: a.promptEdited, preflight: a.preflight } : null,
    };
  }

  overview() {
    const agents = Object.values(this.d.state.agents).map(a => ({ id: a.id, name: a.config.name, adapter: a.config.adapter, status: a.status, eligibility: designAgentEligibility(a) }));
    return {
      contract: this.d.state.design ? { hash: this.d.state.design.hash, version: this.d.state.design.version } : null,
      agents,
      jobs: this.jobs().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(j => this.view(j)),
      tooling: this.tooling(),
    };
  }

  /** Locates installed browser tooling on PATH without executing or installing anything. */
  tooling() {
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const find = (name: string) => dirs.map(d => path.join(d, name)).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
    const cli = find('playwright-cli') ?? find('playwright');
    return { playwright: cli ? { found: true, path: cli, note: 'Found on PATH. One Connect does not run it; an agent may use it inside its run, where commands are verified against the transcript.' } : { found: false, path: null, note: 'Not found on PATH. Browser checks stay pending; nothing is installed automatically.' } };
  }

  private uniqueSlug(base: string): string {
    const used = new Set([...this.jobs().map(j => j.slug), ...Object.values(this.d.state.mocks ?? {}).map(m => m.dir.replace(/^design\//, ''))]);
    let slug = base, n = 2;
    while (used.has(slug)) slug = `${base.slice(0, 60)}-${n++}`;
    return slug;
  }
  private requireAgent(agentId: string) {
    const agent = this.d.state.agents[agentId];
    if (!agent) throw new CommandError('Unknown agent', 404);
    const e = designAgentEligibility(agent);
    if (!e.ok) throw new CommandError(`${agent.config.name} cannot run design work here: ${e.reason}`, 412);
    return agent;
  }
  private clean(text: string, label: string, max: number) {
    const t = String(text ?? '').trim();
    if (!t) throw new CommandError(`${label} is required`);
    if (t.length > max) throw new CommandError(`${label} is longer than ${max} characters`);
    if (containsSecret(t, { denylist: this.d.denylist() }).length) throw new CommandError(`Remove credentials from the ${label.toLowerCase()}.`);
    return t;
  }

  /**
   * Brief → issue → draft assignment frozen to the current contract and skills. Nothing is
   * dispatched: the human reviews the exact prompt and pre-flight, then dispatches.
   */
  createJob(input: unknown, actor: Actor = HUMAN) {
    if (actor.type !== 'human') throw new CommandError('Only a human creates design jobs', 403);
    const parsed = DesignBriefSchema.safeParse(input);
    if (!parsed.success) throw new CommandError(parsed.error.issues.map(i => i.message).join('; '));
    const brief = parsed.data;
    if (containsSecret(JSON.stringify(brief), { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from the brief. Briefs are shown to agents.');
    const contract = this.d.state.design;
    if (!contract) throw new CommandError('Save a project design system first. Design jobs freeze the saved contract.', 412);
    const agent = this.requireAgent(brief.agentId);
    const slug = this.uniqueSlug(brief.slug ?? designSlug(brief.title));
    const dir = `design/${slug}`;
    if (!MOCK_DIR_RE.test(dir)) throw new CommandError('Invalid mock folder');
    const text = designIssueText(brief, dir);
    const item = this.d.createIssue(text, actor);
    const a = this.d.createAssignment({ workItemId: item.id, agentId: agent.id, allowedPaths: [`${dir}/**`], scope: `Create the mock described in the goal inside ${dir}/ only. Do not change application code, publish or deploy.` }, actor);
    const job: DesignJob = {
      id: newId('dj'), kind: 'generate', title: brief.title, brief, slug, dir, workItemId: item.id, assignmentId: a.id, artifactId: null, fromRev: null, identity: null,
      request: null, mode: 'new-assignment', runId: null, designRevision: { hash: contract.hash, version: contract.version }, createdAt: this.d.nowIso(), by: actor,
    };
    this.record({ kind: 'job_created', job }, actor, { workItemId: item.id, assignmentId: a.id, agentId: agent.id });
    this.refreshPrompt(this.d.state.assignments[a.id]);
    this.d.preflight(a.id);
    return this.view(this.job(job.id));
  }

  cancel(jobId: string, actor: Actor = HUMAN) {
    const j = this.job(jobId);
    if (j.canceledAt) return this.view(j);
    const a = this.d.state.assignments[j.assignmentId];
    if (Object.values(this.d.state.runs).some(r => r.assignmentId === j.assignmentId && isActiveRun(r))) throw new CommandError('Stop the active run first. Its transcript stays available.', 409);
    if (a && j.mode === 'new-assignment' && (a.position === 'draft' || a.position === 'next')) this.d.cancelAssignment(a.id, actor);
    this.record({ kind: 'job_updated', jobId, patch: { canceledAt: this.d.nowIso() } }, actor, { workItemId: j.workItemId, assignmentId: j.assignmentId });
    return this.view(this.job(jobId));
  }

  // ---- capture ---------------------------------------------------------------------------------

  /** Records every capture outcome so failures are visible instead of silently lost. */
  recordCapture(o: { assignmentId: string; dir: string; runId: string | null; trigger: CaptureAttempt['trigger']; actor: Actor; ok: boolean; error?: string | null; artifactId?: string | null; rev?: number | null; unchanged?: boolean }) {
    const a = this.d.state.assignments[o.assignmentId];
    if (!a) return;
    const job = this.jobs().filter(j => j.assignmentId === o.assignmentId && j.dir === o.dir && !j.canceledAt).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0] ?? null;
    const attempt: CaptureAttempt = { id: newId('dca'), jobId: job?.id ?? null, assignmentId: o.assignmentId, runId: o.runId, dir: o.dir, trigger: o.trigger, ok: o.ok, error: o.error ? String(o.error).slice(0, 600) : null, artifactId: o.artifactId ?? null, rev: o.rev ?? null, ...(o.unchanged ? { unchanged: true } : {}), at: this.d.nowIso(), by: o.actor };
    this.record({ kind: 'capture_recorded', attempt }, o.actor, { workItemId: a.workItemId, assignmentId: a.id, agentId: a.agentId, runId: o.runId });
  }

  /** Human "capture now" for a job, e.g. after a run finished without registering its mock. */
  async captureJob(jobId: string, actor: Actor = HUMAN) {
    const j = this.job(jobId);
    const run = jobStatus(j, this.d.state).run;
    return this.d.mocks.capture(j.assignmentId, j.dir, actor, { runId: run?.id ?? null, trigger: 'human' });
  }

  private onEvents(events: EventEnvelope[]) {
    if(this.stopped)return;
    for (const e of events) {
      if (e.type !== 'run.ended' || e.data.exit.kind !== 'completed' || !e.runId || !e.assignmentId) continue;
      const job = this.jobForAssignment(e.assignmentId) ?? this.jobs().find(j => j.assignmentId === e.assignmentId && j.mode === 'follow-up' && j.runId === e.runId && !j.canceledAt);
      if (!job || (job.kind !== 'generate' && job.kind !== 'refine') || this.autoCaptured.has(e.runId)) continue;
      this.scheduleCapture(e.runId,e.assignmentId,job.dir);
    }
  }

  /** After a completed run, capture its folder unless the agent already registered it in that run. */
  private async autoCapture(assignmentId: string, dir: string, runId: string) {
    const already = Object.values(this.d.state.mocks ?? {}).some(m => m.revisions.some(r => r.runId === runId));
    if (already) return;
    try { await this.d.mocks.capture(assignmentId, dir, SYSTEM, { runId, trigger: 'auto' }); }
    catch { /* recorded by capture() */ }
  }

  // ---- refine ----------------------------------------------------------------------------------

  /**
   * Refine the latest revision. Prefer continuing the same assignment session (same issue, worktree
   * and frozen contract); otherwise create a scoped child issue whose draft assignment starts from
   * the source branch and whose captures continue the same artifact.
   */
  async refine(artifactId: string, rev: number, request: string, o: { agentId?: string; mode?: 'auto' | 'new-assignment' } = {}, actor: Actor = HUMAN) {
    if (actor.type !== 'human') throw new CommandError('Only a human requests refinements', 403);
    const art = this.d.mocks.get(artifactId);
    const source = this.d.mocks.rev(art, rev);
    const latest = art.revisions.at(-1)!;
    if (source.rev !== latest.rev) throw new CommandError(`Refine the latest revision (${latest.rev}). To go back, load files from revision ${source.rev} into the source editor and save them as a new revision first.`, 409);
    const text = this.clean(request, 'Refinement request', REFINE_MAX);
    const srcAssignment = this.d.state.assignments[source.assignmentId ?? art.assignmentId];
    if (!srcAssignment) throw new CommandError('The assignment that produced this revision no longer exists', 409);
    const lastRun = Object.values(this.d.state.runs).filter(r => r.assignmentId === srcAssignment.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (lastRun && isActiveRun(lastRun)) throw new CommandError('A run is still active on this mock. Answer it or wait for it to finish; messages to a running agent go through its run.', 409);
    const designRevision = srcAssignment.designRevision ? this.d.designer.revision(srcAssignment.designRevision) : null;
    const base = { title: art.title, slug: art.dir.replace(/^design\//, ''), dir: art.dir, artifactId: art.id, fromRev: source.rev, identity: { contentHash: source.hash, designHash: source.designRevision?.hash ?? null, designVersion: source.designRevision?.version ?? null }, request: text, designRevision: designRevision ? { hash: designRevision.hash, version: designRevision.version } : null, by: actor, brief: null };
    const agentId = o.agentId ?? srcAssignment.agentId;
    const canFollow = o.mode !== 'new-assignment' && agentId === srcAssignment.agentId && srcAssignment.position !== 'canceled' && srcAssignment.worktree && fs.existsSync(srcAssignment.worktree)
      && lastRun?.sessionId && adapterFor(lastRun.adapter).capabilities.resume && this.d.agentFree(agentId);
    if (canFollow) {
      this.requireAgent(agentId);
      const job: DesignJob = { ...base, id: newId('dj'), kind: 'refine', workItemId: srcAssignment.workItemId, assignmentId: srcAssignment.id, mode: 'follow-up', runId: null, createdAt: this.d.nowIso() };
      this.record({ kind: 'job_created', job }, actor, { workItemId: job.workItemId, assignmentId: job.assignmentId, agentId });
      try {
        const runId = await this.d.runs.followUp(lastRun!.id, refineMessage(job, source), actor);
        this.record({ kind: 'job_updated', jobId: job.id, patch: { runId } }, actor, { workItemId: job.workItemId, assignmentId: job.assignmentId, runId });
      } catch (e) {
        this.record({ kind: 'job_updated', jobId: job.id, patch: { canceledAt: this.d.nowIso() } }, actor, { workItemId: job.workItemId, assignmentId: job.assignmentId });
        throw e;
      }
      return this.view(this.job(job.id));
    }
    this.requireAgent(agentId);
    const parent = this.d.state.workItems[art.workItemId];
    const item = this.d.createIssue({
      title: `Refine design: ${art.title}`.slice(0, 120),
      description: `${text}\n\nRefines mock "${art.title}" (${art.dir}/), artifact ${art.id}, revision ${source.rev} (content ${source.hash.slice(0, 12)}${source.designRevision ? `, contract v${source.designRevision.version}` : ''}${parent?.key ? `, from ${parent.key}` : ''}). Created in the One Connect Designer studio.`,
      acceptance: ['The requested change is made in a newly captured revision of the same mock', 'Pages and states not named in the request stay intact', 'The frozen contract tokens are still used'],
      labels: ['design', 'ui', 'mock'],
      parentKey: parent?.key ?? null,
    }, actor);
    const baseRef = srcAssignment.branch ?? source.gitSha ?? undefined;
    const a = this.d.createAssignment({ workItemId: item.id, agentId, allowedPaths: [`${art.dir}/**`], scope: `Refine ${art.dir}/ as requested in the goal. Do not change application code, publish or deploy.`, ...(baseRef ? { baseRef } : {}) }, actor);
    const frozen = a.designRevision ? this.d.designer.revision(a.designRevision) : null;
    const job: DesignJob = { ...base, id: newId('dj'), kind: 'refine', workItemId: item.id, assignmentId: a.id, mode: 'new-assignment', runId: null, createdAt: this.d.nowIso(), designRevision: frozen ? { hash: frozen.hash, version: frozen.version } : null };
    this.record({ kind: 'job_created', job }, actor, { workItemId: item.id, assignmentId: a.id, agentId });
    this.refreshPrompt(this.d.state.assignments[a.id]);
    this.d.preflight(a.id);
    return this.view(this.job(job.id));
  }

  // ---- independent review ----------------------------------------------------------------------

  /** A read-only review assignment for an agent who did not author the revision. */
  requestReview(artifactId: string, rev: number, agentId: string, actor: Actor = HUMAN) {
    if (actor.type !== 'human') throw new CommandError('Only a human requests a design review', 403);
    const art = this.d.mocks.get(artifactId), r = this.d.mocks.rev(art, rev);
    const author = r.authoredBy ?? r.by;
    if (author.type === 'agent' && author.id === agentId) throw new CommandError('The author cannot review their own revision. Choose another agent.', 409);
    this.requireAgent(agentId);
    const item = this.d.createIssue({
      title: `Design review: ${art.title} rev ${r.rev}`.slice(0, 120),
      description: `Independent review of mock "${art.title}" (${art.dir}/), artifact ${art.id}, revision ${r.rev}, content ${r.hash}${r.designRevision ? `, contract v${r.designRevision.version} (${r.designRevision.hash})` : ''}. Review only; do not edit the mock.`,
      acceptance: ['A structured review with every checklist item and its basis is submitted for this exact revision'],
      labels: ['design-review'],
      parentKey: this.d.state.workItems[art.workItemId]?.key ?? null,
    }, actor);
    const a = this.d.createAssignment({ workItemId: item.id, agentId, allowedPaths: ['notes/design-reviews/**'], scope: `Review ${art.dir}/ revision ${r.rev} only. Do not modify the mock or application code.`, requiredChecks: [] }, actor);
    const job: DesignJob = { id: newId('dj'), kind: 'review', title: art.title, brief: null, slug: art.dir.replace(/^design\//, ''), dir: art.dir, workItemId: item.id, assignmentId: a.id, artifactId: art.id, fromRev: r.rev, identity: { contentHash: r.hash, designHash: r.designRevision?.hash ?? null, designVersion: r.designRevision?.version ?? null }, request: null, mode: 'new-assignment', runId: null, designRevision: r.designRevision, createdAt: this.d.nowIso(), by: actor };
    this.record({ kind: 'job_created', job }, actor, { workItemId: item.id, assignmentId: a.id, agentId });
    this.refreshPrompt(this.d.state.assignments[a.id]);
    this.d.preflight(a.id);
    return this.view(this.job(job.id));
  }

  /** Review jobs may read the revision under review; anything else stays scoped to the agent's own mocks. */
  reviewJobFor(assignmentId: string, artifactId: string, rev?: number): DesignJob | null {
    return this.jobs().find(j => j.kind === 'review' && j.assignmentId === assignmentId && j.artifactId === artifactId && (rev === undefined || j.fromRev === rev) && !j.canceledAt) ?? null;
  }

  // ---- engineering handoff ---------------------------------------------------------------------

  /** Engineering work bound to one approved revision and its exact, still-current contract. */
  prepareEngineering(artifactId: string, rev: number, o: { agentId: string; allowedPaths?: string[]; notes?: string }, actor: Actor = HUMAN) {
    if (actor.type !== 'human') throw new CommandError('Only a human prepares engineering work from a design', 403);
    const art = this.d.mocks.get(artifactId), r = this.d.mocks.rev(art, rev);
    const current = this.d.state.design;
    const gate = mockGate(r, current?.hash ?? null);
    if (gate.state !== 'approved') throw new CommandError(`Revision ${r.rev} is ${gate.state.replace(/_/g, ' ')}, not approved. Only an approved revision can be handed to engineering.`, 409);
    if (!r.designRevision || !current || r.designRevision.hash !== current.hash) throw new CommandError(`Revision ${r.rev} was built on contract v${r.designRevision?.version ?? '?'}, but the project contract is now v${current?.version ?? '?'}. Refine and approve a revision on the current contract before engineering implements it.`, 409);
    const agent = this.requireAgent(o.agentId);
    const paths = (o.allowedPaths ?? []).map(p => String(p).trim()).filter(Boolean);
    if (paths.some(p => p.split('/').includes('..') || p.startsWith('/'))) throw new CommandError('Allowed paths must stay inside the repository');
    const notes = String(o.notes ?? '').trim().slice(0, 2000);
    if (notes && containsSecret(notes, { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from the notes.');
    const approval = gate.approval!.review;
    const pages = r.files.filter(f => f.kind === 'html').map(f => f.path);
    const checks = this.d.config.project.required_checks ?? Object.keys(this.d.config.project.checks);
    const text = engineeringIssueText({ title: art.title, artifactId: art.id, dir: art.dir, revision: r, contract: { version: current.version, hash: current.hash }, approvedBy: approval.by.id, approvedAt: approval.at, pages, states: r.handoff?.states ?? [], notes, checks });
    const item = this.d.createIssue({ ...text, parentKey: this.d.state.workItems[art.workItemId]?.key ?? null }, actor);
    const a = this.d.createAssignment({ workItemId: item.id, agentId: agent.id, allowedPaths: paths, scope: 'Implement the approved design identity in the goal. Do not publish or deploy.' }, actor);
    if (a.designRevision !== current.hash) throw new CommandError('The contract changed while preparing this task. Try again.', 409);
    const job: DesignJob = { id: newId('dj'), kind: 'engineering', title: art.title, brief: null, slug: art.dir.replace(/^design\//, ''), dir: art.dir, workItemId: item.id, assignmentId: a.id, artifactId: art.id, fromRev: r.rev, identity: { contentHash: r.hash, designHash: current.hash, designVersion: current.version }, request: null, mode: 'new-assignment', runId: null, designRevision: { hash: current.hash, version: current.version }, createdAt: this.d.nowIso(), by: actor };
    this.record({ kind: 'job_created', job }, actor, { workItemId: item.id, assignmentId: a.id, agentId: agent.id });
    this.refreshPrompt(this.d.state.assignments[a.id]);
    this.d.preflight(a.id);
    return this.view(this.job(job.id));
  }

  /** Brief pages, for previews of a draft brief before anything is created. */
  previewBrief(input: unknown) {
    const parsed = DesignBriefSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, errors: parsed.error.issues.map(i => `${i.path.join('.') || 'brief'}: ${i.message}`) };
    const slug = this.uniqueSlug(parsed.data.slug ?? designSlug(parsed.data.title));
    const dir = `design/${slug}`;
    return { ok: true as const, dir, pages: briefPages(parsed.data), issue: designIssueText(parsed.data, dir), eligibility: this.d.state.agents[parsed.data.agentId] ? designAgentEligibility(this.d.state.agents[parsed.data.agentId]) : null };
  }

  /** Lineage of one artifact: the jobs that produced, refined, reviewed or implemented it. */
  lineage(artifactId: string) {
    const art = this.d.mocks.get(artifactId);
    return this.jobs().filter(j => j.artifactId === art.id || (j.dir === art.dir && j.assignmentId === art.assignmentId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(j => this.view(j));
  }

  sourceRevision(job: DesignJob): MockRevision | null {
    const art = job.artifactId ? this.d.state.mocks?.[job.artifactId] : null;
    return art?.revisions.find(r => r.rev === job.fromRev) ?? null;
  }
}
