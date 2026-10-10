// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Durable workflow execution. Every task runs through the normal assignment → preflight → dispatch
// path (so Now/Next and shared subscription capacity apply). A task only completes, and its
// dependents only start, from recorded lifecycle evidence: verified commits and daemon-run checks
// for code, a typed review record for reviews. All state is event-sourced and survives restart.
import type { Actor, Assignment, EventEnvelope, NewEvent, Run, Workflow, WorkflowDefinition, WorkflowIssue, WorkflowTaskDef, WorkflowTaskState } from '@acc/core';
import { checksAt, checkRuntimeKey, deriveWorkflowStatus, emptyTaskState, HUMAN, isActiveRun, newId, normalizeWorkflow, readyTaskIds, requiredCheckNames, SYSTEM, topoOrder, validateWorkflow } from '@acc/core';
import { revParse } from './adapters/vcs/git.ts';
import { CommandError, type Daemon } from './daemon.ts';
import { applyWorkflowOptions, terminateWithPickup } from './workflowOptions.ts';

const AFTER_HANDOFF = new Set(['handoff_received', 'in_review', 'approved', 'changes_requested', 'merged', 'release_candidate', 'deployed', 'verified']);
const TRIGGERS = new Set(['run.created', 'run.started', 'run.ended', 'run.handoff', 'work_item.transitioned', 'work_item.evidence_added', 'assignment.positioned', 'review.recorded', 'review.invalidated', 'merge.completed']);
const short = (s: string | null | undefined) => (s ? s.slice(0, 10) : 'none');
type TaskPatch = Partial<Omit<WorkflowTaskState, 'updatedAt'>>;

export class WorkflowEngine {
  readonly d: Daemon;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = new Set<string>();
  private scheduled = false;
  private listening = false;
  /** Restart recovery: re-run checks once per run that ended before its checks were recorded. */
  private rechecked = new Set<string>();
  private readonly onEvents = (events: EventEnvelope[]) => this.react(events);

  constructor(d: Daemon) {
    this.d = d;
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.d.bus.on('events', this.onEvents);
    for (const w of Object.values(this.d.state.workflows ?? {})) if (this.tracked(w)) this.schedule(w.id, true);
  }

  stop(): void {
    this.listening = false;
    this.d.bus.off('events', this.onEvents);
    this.pending.clear();
  }

  /** Resolves once no evaluation is scheduled or running (tests and HTTP responses). */
  async idle(): Promise<void> {
    for (let i = 0; i < 50 && (this.pending.size || this.scheduled); i++) {
      await new Promise((r) => setImmediate(r));
      await this.chain.catch(() => undefined);
    }
    await this.chain.catch(() => undefined);
  }

  list(): Workflow[] {
    return Object.values(this.d.state.workflows ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Workflow {
    const w = this.d.state.workflows?.[id];
    if (!w) throw new CommandError(`unknown workflow ${id}`, 404);
    return w;
  }

  private tracked(w: Workflow): boolean {
    // Completion remains conditional on the source/check/review evidence. Observing a completed
    // workflow must never dispatch its finished tasks again, but invalidations still matter.
    return w.status === 'running' || w.status === 'paused' || w.status === 'blocked' || w.status === 'failed' || w.status === 'completed';
  }

  // ---- definition --------------------------------------------------------------------------

  validate(input: unknown, o: { workflowId?: string | null; forStart?: boolean } = {}): { definition: WorkflowDefinition; issues: WorkflowIssue[] } {
    const definition = normalizeWorkflow(input);
    const issues = validateWorkflow(definition, this.d.state, { workflowId: o.workflowId ?? null, forStart: o.forStart, projectChecks: this.d.config.project.checks, builtinSkills: this.d.designer.skills().map(s => s.id), denylist: this.d.denylist() });
    if (o.forStart) {
      for (const t of definition.tasks) {
        if (t.kind === 'review') continue;
        const busy = Object.values(this.d.state.assignments).find((a) => a.workItemId === t.workItemId && a.kind !== 'review' && (a.position === 'now' || a.position === 'next') && a.workflowId !== o.workflowId);
        if (busy) issues.push({ code: 'overlap', taskId: t.id, message: `${t.id}: ${this.d.state.workItems[t.workItemId]?.key ?? t.workItemId} already has an active assignment for ${this.d.state.agents[busy.agentId]?.config.name ?? busy.agentId}; finish or cancel it first.` });
      }
    }
    return { definition, issues };
  }

  save(input: { id?: string | null; definition: unknown; expectedVersion?: number | null }, actor: Actor = HUMAN): Workflow {
    const existing = input.id ? this.d.state.workflows?.[input.id] : null;
    if (input.id && !existing) throw new CommandError(`unknown workflow ${input.id}`, 404);
    if (existing && existing.status !== 'draft') throw new CommandError(`"${existing.definition.name}" is ${existing.status}; only drafts can be edited. Cancel it and save a copy instead.`, 409);
    if (existing && input.expectedVersion != null && input.expectedVersion !== existing.version) throw new CommandError('this workflow changed since you opened it; reload and try again', 409);
    const { definition, issues } = this.validate(input.definition, { workflowId: existing?.id ?? null });
    if (issues.length) throw new CommandError(issues.map((i) => i.message).join(' '), 422, issues);
    const now = this.d.nowIso();
    const workflow: Workflow = {
      id: existing?.id ?? newId('wf'),
      version: (existing?.version ?? 0) + 1,
      definition,
      status: 'draft',
      statusReason: null,
      tasks: Object.fromEntries(definition.tasks.map((t) => [t.id, emptyTaskState(now)])),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
    };
    this.d.commit([{ type: 'workflow.saved', actor, data: { workflow } }]);
    return this.get(workflow.id);
  }

  // ---- controls ----------------------------------------------------------------------------

  async launch(id: string, actor: Actor = HUMAN, extra: NewEvent[] = []): Promise<Workflow> {
    const w = this.get(id);
    if (w.status !== 'draft') throw new CommandError(`"${w.definition.name}" is already ${w.status}`, 409);
    const { issues } = this.validate(w.definition, { workflowId: id, forStart: true });
    if (issues.length) throw new CommandError(issues.map((i) => i.message).join(' '), 422, issues);
    this.d.commit([{ type: 'workflow.status', actor, data: { workflowId: id, status: 'running', reason: `started by ${actor.type === 'human' ? 'the owner' : actor.id}` } }, ...extra]);
    await this.evaluate(id);
    return this.get(id);
  }

  async pause(id: string, actor: Actor = HUMAN): Promise<Workflow> {
    const w = this.get(id);
    if (!['running', 'blocked', 'failed'].includes(w.status)) throw new CommandError(`"${w.definition.name}" is ${w.status}`, 409);
    await this.serial(async () => {
      const events: NewEvent[] = [{ type: 'workflow.status', actor, data: { workflowId: id, status: 'paused', reason: 'paused by the owner; running agents finish their current run' } }];
      for (const t of w.definition.tasks) {
        const st = w.tasks[t.id];
        const a = st?.assignmentId ? this.d.state.assignments[st.assignmentId] : null;
        if (st?.status !== 'queued' || !a || this.d.runs.activeRunFor(a.id)) continue;
        // Not started yet: take it out of Next so the slot goes back to other work.
        if (a.position === 'next' || a.position === 'draft') this.cancelQuietly(a, actor);
        events.push(this.taskEvent(id, t.id, { status: 'pending', assignmentId: null, reason: 'paused before it started' }, actor));
      }
      this.d.commit(events);
    });
    return this.get(id);
  }

  async resume(id: string, actor: Actor = HUMAN): Promise<Workflow> {
    const w = this.get(id);
    if (w.status !== 'paused') throw new CommandError(`"${w.definition.name}" is ${w.status}, not paused`, 409);
    this.d.commit([{ type: 'workflow.status', actor, data: { workflowId: id, status: 'running', reason: 'resumed by the owner' } }]);
    await this.evaluate(id);
    return this.get(id);
  }

  async cancel(id: string, actor: Actor = HUMAN): Promise<Workflow> {
    const w = this.get(id);
    if (w.status === 'canceled' || w.status === 'completed') throw new CommandError(`"${w.definition.name}" is already ${w.status}`, 409);
    // Mark canceled first so nothing promotes while runs stop.
    this.d.commit([{ type: 'workflow.status', actor, data: { workflowId: id, status: 'canceled', reason: 'canceled by the owner' } }]);
    const stops: Promise<void>[] = [];
    for (const t of w.definition.tasks) {
      const a = w.tasks[t.id]?.assignmentId ? this.d.state.assignments[w.tasks[t.id].assignmentId!] : null;
      const run = a ? this.d.runs.activeRunFor(a.id) : null;
      if (run) stops.push(this.d.runs.stop(run.id, 'workflow canceled', actor).catch(() => undefined));
    }
    await Promise.all(stops);
    await this.serial(async () => {
      const cur = this.get(id);
      const events: NewEvent[] = [];
      for (const t of cur.definition.tasks) {
        const st = cur.tasks[t.id];
        if (!st || st.status === 'done' || st.status === 'canceled') continue;
        const a = st.assignmentId ? this.d.state.assignments[st.assignmentId] : null;
        if (a && a.position !== 'done' && a.position !== 'canceled') this.cancelQuietly(a, actor);
        events.push(this.taskEvent(id, t.id, { status: 'canceled', reason: 'workflow canceled' }, actor));
      }
      this.d.commit(events);
    });
    return this.get(id);
  }

  /** Capture bounded pickup points before cancellation; no provider fallback. */
  terminateWithPickup(id: string, actor: Actor = HUMAN): Promise<Record<string, string | null>> {
    return terminateWithPickup(this.d, id, actor);
  }

  /** Run a task again (and reset everything downstream of it). */
  async retry(id: string, taskId: string, actor: Actor = HUMAN): Promise<Workflow> {
    const w = this.get(id);
    if (!['running', 'blocked', 'failed', 'paused'].includes(w.status)) throw new CommandError(`"${w.definition.name}" is ${w.status}`, 409);
    const def = w.definition.tasks.find((t) => t.id === taskId);
    if (!def) throw new CommandError(`unknown task ${taskId}`, 404);
    const st = w.tasks[taskId];
    if (st.status === 'running' || st.status === 'queued' || st.status === 'verifying') throw new CommandError(`${taskId} is ${st.status}; wait for it or stop the run first`, 409);
    const reset = new Set([taskId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of w.definition.tasks) if (!reset.has(t.id) && t.dependsOn.some((x) => reset.has(x))) { reset.add(t.id); grew = true; }
    }
    for (const t of reset) {
      const a = w.tasks[t]?.assignmentId ? this.d.state.assignments[w.tasks[t].assignmentId!] : null;
      if (a && this.d.runs.activeRunFor(a.id)) throw new CommandError(`${t} depends on ${taskId} and is still running; stop it first`, 409);
    }
    await this.serial(async () => {
      const events: NewEvent[] = [];
      for (const t of reset) {
        const cur = this.get(id).tasks[t];
        const a = cur.assignmentId ? this.d.state.assignments[cur.assignmentId] : null;
        if (a && (a.position === 'next' || a.position === 'draft')) this.cancelQuietly(a, actor);
        events.push(this.taskEvent(id, t, { status: 'pending', assignmentId: null, reason: t === taskId ? 'retry requested by the owner' : `reset because ${taskId} is being retried`, completedSha: null, evidenceIds: [], reviewId: null }, actor));
      }
      if (w.status !== 'paused') events.push({ type: 'workflow.status', actor, data: { workflowId: id, status: 'running', reason: `retrying ${taskId}` } });
      this.d.commit(events);
    });
    await this.evaluate(id);
    return this.get(id);
  }

  private cancelQuietly(a: Assignment, actor: Actor): void {
    try {
      this.d.cancelAssignment(a.id, actor);
    } catch {
      // Already started or gone; the evaluator will observe its run.
    }
  }

  // ---- evaluation --------------------------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private react(events: EventEnvelope[]): void {
    if (!events.some((e) => TRIGGERS.has(e.type))) return;
    for (const w of Object.values(this.d.state.workflows ?? {})) {
      if (!this.tracked(w)) continue;
      const items = new Set(w.definition.tasks.map((t) => t.workItemId));
      if (events.some((e) => TRIGGERS.has(e.type) && ((e.workItemId && items.has(e.workItemId)) || (e.runId && items.has(this.d.state.runs[e.runId]?.workItemId))))) this.schedule(w.id);
    }
  }

  private schedule(id: string, recovering = false): void {
    if (recovering) this.recover(id);
    this.pending.add(id);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const ids = [...this.pending];
      this.pending.clear();
      for (const wid of ids) void this.evaluate(wid).catch((e) => this.d.alert({ kind: 'workflow', severity: 'warn', message: `workflow ${wid}: ${(e as Error).message}`, dedupeKey: `workflow-eval:${wid}` }));
    });
  }

  /** After a restart, a code task whose run ended before checks were recorded gets its checks re-run once. */
  private recover(id: string): void {
    const w = this.d.state.workflows?.[id];
    if (!w) return;
    for (const t of w.definition.tasks) {
      const st = w.tasks[t.id];
      if (t.kind !== 'code' || st?.status !== 'verifying' || !st.assignmentId) continue;
      const run = this.latestRun(st.assignmentId);
      if (!run || isActiveRun(run) || run.exit?.kind !== 'completed' || this.rechecked.has(run.id)) continue;
      this.rechecked.add(run.id);
      void this.d.runs.track(this.d.runs.postRunChecks(run.id)).catch(() => undefined);
    }
  }

  evaluate(id: string): Promise<void> {
    return this.serial(() => this.evaluateNow(id));
  }

  private latestRun(assignmentId: string): Run | null {
    return Object.values(this.d.state.runs).filter((r) => r.assignmentId === assignmentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
  }

  private taskEvent(workflowId: string, taskId: string, patch: TaskPatch, actor: Actor = SYSTEM): NewEvent {
    return { type: 'workflow.task_updated', actor, data: { workflowId, taskId, patch } };
  }

  private changed(st: WorkflowTaskState, patch: TaskPatch): boolean {
    return Object.entries(patch).some(([k, v]) => JSON.stringify((st as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v));
  }

  private async evaluateNow(id: string): Promise<void> {
    const d = this.d;
    if (d.closed) return;
    let w = d.state.workflows?.[id];
    if (!w || !this.tracked(w)) return;

    // 1. Observe facts for every task that has an assignment.
    const facts: NewEvent[] = [];
    for (const t of w.definition.tasks) {
      const st = w.tasks[t.id];
      if (!st) continue;
      const patch = await this.observe(t, st, w);
      if (d.closed || d.state.workflows[id]?.status === 'canceled') return;
      if (patch && this.changed(st, patch)) facts.push(this.taskEvent(id, t.id, patch));
    }
    if (facts.length) d.commit(facts);
    w = d.state.workflows[id];

    // Previously completed downstream work is no longer ready when its upstream proof changes.
    // Keep live process state honest and preserve its history; do not claim that finishing the
    // existing run repairs the dependency. The owner retries the invalidated chain explicitly.
    for (const taskId of topoOrder(w.definition)) {
      const t = w.definition.tasks.find((task) => task.id === taskId)!;
      const st = d.state.workflows[id].tasks[taskId];
      if (st.status === 'pending' || st.status === 'canceled' || st.status === 'failed' || st.status === 'changes_requested' || !st.assignmentId) continue;
      const dependency = t.dependsOn.find((dep) => d.state.workflows[id].tasks[dep]?.status !== 'done');
      if (!dependency) continue;
      const a = d.state.assignments[st.assignmentId];
      const active = a && d.runs.activeRunFor(a.id);
      if (!active && a && (a.position === 'next' || a.position === 'draft')) this.cancelQuietly(a, SYSTEM);
      const patch: TaskPatch = {
        status: active ? 'running' : 'blocked',
        reason: `upstream task ${dependency} is no longer ready; retry the affected task and its dependents`,
        completedSha: null,
        evidenceIds: [],
      };
      if (this.changed(st, patch)) d.commit([this.taskEvent(id, taskId, patch)]);
    }
    w = d.state.workflows[id];

    // 2. Promote ready tasks while the workflow is running.
    if (w.status === 'running' || w.status === 'blocked') {
      for (const taskId of readyTaskIds(w)) {
        if (d.closed || d.state.workflows[id].status === 'canceled' || d.state.workflows[id].status === 'paused') break;
        await this.promote(d.state.workflows[id], taskId);
      }
    }

    // 3. Derive the workflow status from its tasks.
    w = d.state.workflows[id];
    if (w.status === 'paused' || w.status === 'canceled') return;
    const next = deriveWorkflowStatus(w);
    if (next.status !== w.status || next.reason !== w.statusReason) {
      d.commit([{ type: 'workflow.status', actor: SYSTEM, data: { workflowId: id, status: next.status, reason: next.reason } }]);
      if (next.status === 'failed' || next.status === 'blocked') d.alert({ kind: 'workflow', severity: next.status === 'failed' ? 'critical' : 'warn', message: `Workflow "${w.definition.name}" is ${next.status}: ${next.reason ?? ''}`, dedupeKey: `workflow:${id}:${next.status}:${next.reason ?? ''}` });
      if (next.status === 'completed') d.resolveAlerts((a) => Boolean(a.dedupeKey?.startsWith(`workflow:${id}:`)), 'workflow completed');
    }
  }

  /** What the recorded events say about one task. Agents' claims alone never complete a task. */
  private async observe(t: WorkflowTaskDef, st: WorkflowTaskState, w: Workflow): Promise<TaskPatch | null> {
    const d = this.d;
    if (st.status === 'pending' || st.status === 'canceled') return null;
    const dependency = t.dependsOn.find(dep => w.tasks[dep]?.status !== 'done');
    if (dependency && st.assignmentId && st.status !== 'failed' && st.status !== 'changes_requested') {
      // A review's actual request for changes remains visible even when it also invalidates the
      // author's readiness. It cannot unblock anything, and should not be hidden as a generic block.
      const review = t.kind === 'review' ? Object.values(d.state.reviews).find(r => r.assignmentId === st.assignmentId) : null;
      if (review && !review.staleAt && review.verdict === 'request_changes') return { status: 'changes_requested', reason: review.summary || `${review.findings.length} finding(s)`, reviewId: review.id, completedSha: review.targetSha };
      const active = d.runs.activeRunFor(st.assignmentId);
      return { status: active ? 'running' : 'blocked', reason: `upstream task ${dependency} is no longer ready; retry the affected task and its dependents`, completedSha: null, evidenceIds: [] };
    }
    if (st.status === 'done') {
      if (t.kind === 'review') {
        const review = st.reviewId ? d.state.reviews[st.reviewId] : null;
        if (!review || review.staleAt || review.verdict !== 'approve' || review.targetSha !== st.completedSha) return { status: 'blocked', reason: `review is stale: ${review?.staleReason ?? 'approval is no longer current'}; retry the review`, completedSha: null, evidenceIds: [] };
      }
      if (t.kind === 'code') {
        const a = st.assignmentId ? d.state.assignments[st.assignmentId] : null;
        const item = a ? d.state.workItems[a.workItemId] : null;
        if (!a?.branch || !item) return { status: 'blocked', reason: 'completed task assignment or issue is missing', completedSha: null, evidenceIds: [] };
        const head = await revParse(d.config.project.repo, `refs/heads/${a.branch}`);
        if (!head || head !== st.completedSha) return { status: 'blocked', reason: `${a.branch} moved from ${short(st.completedSha)} to ${short(head)}; retry the code task`, completedSha: null, evidenceIds: [] };
        if (item.state === 'changes_requested' || item.state === 'blocked' || item.state === 'failed' || item.state === 'canceled') return { status: 'blocked', reason: `the issue is ${item.state.replace(/_/g, ' ')}; retry the affected task`, completedSha: null, evidenceIds: [] };
        const checks = checksAt(item, d.config.project, requiredCheckNames(d.config.project, a), head);
        const failed = checks.filter(c => c.status === 'fail');
        if (failed.length) return { status: 'failed', reason: `${failed.map(c => c.name).join(', ')} failed at ${short(head)}`, completedSha: null, evidenceIds: [] };
        const runtime = checkRuntimeKey(d.config.project.check_runtime);
        if (checks.some(c => c.status !== 'pass' || !runtime || c.evidence?.checkRuntime !== runtime)) return { status: 'blocked', reason: `checks at ${short(head)} need current configured runtime evidence; retry the code task`, completedSha: null, evidenceIds: [] };
      }
      return null;
    }
    const a = st.assignmentId ? d.state.assignments[st.assignmentId] : null;
    if (!a) return st.status === 'blocked' || st.status === 'failed' ? null : { status: 'blocked', reason: 'its assignment is missing' };
    const run = this.latestRun(a.id);
    if (run && isActiveRun(run)) return { status: 'running', reason: null };
    if (!run) {
      if (a.position === 'canceled') return { status: 'blocked', reason: 'the assignment was canceled outside the workflow' };
      return st.status === 'blocked' ? null : { status: 'queued', reason: a.position === 'next' ? `waiting in ${d.state.agents[a.agentId]?.config.name ?? a.agentId}'s Next queue` : st.reason };
    }
    const exit = run.exit;
    if (!exit) return null;
    if (exit.kind !== 'completed') {
      const stopped = exit.kind === 'stopped' || exit.kind === 'killed';
      return { status: stopped ? 'blocked' : 'failed', reason: `run ${stopped ? 'stopped' : 'failed'}: ${exit.message}` };
    }
    const item = d.state.workItems[a.workItemId];
    if (t.kind === 'review') {
      const review = Object.values(d.state.reviews ?? {}).find((r) => r.assignmentId === a.id);
      if (review) {
        if (review.staleAt) return { status: 'blocked', reason: `review is stale: ${review.staleReason ?? 'new commit'}`, reviewId: review.id };
        return review.verdict === 'approve'
          ? { status: 'done', reason: null, completedSha: review.targetSha, reviewId: review.id, evidenceIds: review.evidenceIds }
          : { status: 'changes_requested', reason: review.summary || `${review.findings.length} finding(s)`, reviewId: review.id, completedSha: review.targetSha };
      }
      if (run.handoff?.verdict && run.handoff.source !== 'skeleton') return { status: 'verifying', reason: 'recording the review' };
      return { status: 'blocked', reason: 'the reviewer finished without a verdict' };
    }
    if (item.state === 'blocked') return { status: 'blocked', reason: item.blockedOn?.reason ?? 'the issue is blocked' };
    if (t.kind === 'coordination') {
      if (run.handoff && run.handoff.source !== 'skeleton' && AFTER_HANDOFF.has(item.state)) return { status: 'done', reason: null };
      return { status: 'blocked', reason: 'waiting for a handoff (accept or replace the generated skeleton)' };
    }
    if (!AFTER_HANDOFF.has(item.state)) return { status: 'blocked', reason: run.handoff?.source === 'skeleton' ? 'the agent left no handoff; accept or replace the generated skeleton' : `the issue is ${item.state.replace(/_/g, ' ')}, not handed off` };
    if (!a.branch) return { status: 'failed', reason: 'no branch recorded for the run' };
    const head = await revParse(d.config.project.repo, `refs/heads/${a.branch}`);
    const commit = item.evidence.filter((e) => e.kind === 'commit' && e.verified && e.branch === a.branch && e.sha === head).at(-1);
    if (!head || !commit) return { status: 'blocked', reason: head && head === a.baseSha ? 'finished without a commit' : `no verified commit evidence for ${a.branch} @ ${short(head)}` };
    const checks = checksAt(item, d.config.project, requiredCheckNames(d.config.project, a), head);
    const failed = checks.filter((c) => c.status === 'fail');
    if (failed.length) return { status: 'failed', reason: `${failed.map((c) => c.name).join(', ')} failed at ${short(head)}`, completedSha: null };
    const missing = checks.filter((c) => c.status === 'missing');
    if (missing.length) return { status: 'verifying', reason: `waiting for ${missing.map((c) => c.name).join(', ')} at ${short(head)}` };
    const runtime = checkRuntimeKey(d.config.project.check_runtime);
    if (checks.some(c => !runtime || c.evidence?.checkRuntime !== runtime)) return { status: 'blocked', reason: `checks at ${short(head)} need current configured runtime evidence; retry the code task` };
    return { status: 'done', reason: null, completedSha: head, evidenceIds: [commit.id, ...checks.flatMap((c) => (c.evidence ? [c.evidence.id] : []))] };
  }

  /** Create the task's assignment and send it through the normal dispatch path. */
  private async promote(w: Workflow, taskId: string): Promise<void> {
    const d = this.d;
    const t = w.definition.tasks.find((x) => x.id === taskId)!;
    const st = w.tasks[taskId];
    let a: Assignment;
    try {
      if (t.kind === 'review') {
        const target = w.tasks[t.reviewOf!];
        a = await d.reviewMerge.createReviewAssignment({ workItemId: t.workItemId, reviewerAgentId: t.agentId, targetSha: target.completedSha, authorAssignmentId: target.assignmentId, workflowId: w.id, taskId, scope: t.title || undefined }, SYSTEM);
      } else {
        a = d.createAssignment({ workItemId: t.workItemId, agentId: t.agentId, allowedPaths: t.allowedPaths, scope: t.title, ...(t.requiredChecks ? { requiredChecks: t.requiredChecks } : {}), baseRef: this.baseRefFor(w, t), workflowId: w.id, taskId }, SYSTEM);
      }
    } catch (e) {
      d.commit([this.taskEvent(w.id, taskId, { status: 'blocked', reason: (e as Error).message })]);
      return;
    }
    try { a = applyWorkflowOptions(d, a, t); }
    catch (e) {
      this.cancelQuietly(a, SYSTEM);
      d.commit([this.taskEvent(w.id, taskId, { status: 'blocked', reason: (e as Error).message })]);
      return;
    }
    d.commit([this.taskEvent(w.id, taskId, { status: 'queued', assignmentId: a.id, attempts: st.attempts + 1, reason: null, completedSha: null, evidenceIds: [], reviewId: null })]);
    try {
      const r = await d.dispatch(a.id, { actor: SYSTEM });
      const cur = d.state.workflows[w.id].tasks[taskId];
      if (cur.assignmentId === a.id && cur.status === 'queued') {
        const patch: TaskPatch = r.started ? { status: 'running', reason: null } : { status: 'queued', reason: `waiting in ${d.state.agents[t.agentId]?.config.name ?? t.agentId}'s Next queue` };
        d.commit([this.taskEvent(w.id, taskId, patch)]);
      }
    } catch (e) {
      d.commit([this.taskEvent(w.id, taskId, { status: 'blocked', reason: (e as Error).message })]);
    }
  }

  /** Collaborative hand-off: start from the one upstream code task's verified SHA, else integration. */
  private baseRefFor(w: Workflow, t: WorkflowTaskDef): string {
    const shas = new Set<string>();
    for (const dep of t.dependsOn) {
      const def = w.definition.tasks.find((x) => x.id === dep);
      const code = def?.kind === 'review' ? w.definition.tasks.find((x) => x.id === def.reviewOf) : def;
      const sha = code?.kind === 'code' ? w.tasks[code.id]?.completedSha : null;
      if (sha) shas.add(sha);
    }
    return shas.size === 1 ? [...shas][0] : this.d.config.project.integration_branch;
  }
}
