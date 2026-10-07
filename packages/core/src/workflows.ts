// SPDX-License-Identifier: Apache-2.0
// Durable workflow definitions: tasks tied to existing issues and agents, run either independently
// or in dependency order. Pure validation and derivation shared by the daemon and the browser.
import type { ControlState } from './entities.ts';
import { scopesOverlap } from './pathScope.ts';
import { COORDINATION_LABELS } from './preflight.ts';

export const WORKFLOW_MODES = ['independent', 'collaborative'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

/** code = writes on its own branch; review = independent read-only review of a code task at its SHA. */
export const WORKFLOW_TASK_KINDS = ['code', 'review', 'coordination'] as const;
export type WorkflowTaskKind = (typeof WORKFLOW_TASK_KINDS)[number];

export interface WorkflowTaskDef {
  id: string;
  title: string;
  workItemId: string;
  agentId: string;
  kind: WorkflowTaskKind;
  dependsOn: string[];
  allowedPaths: string[];
  /** Null = the project's required checks. */
  requiredChecks: string[] | null;
  /** Review tasks: the code task being reviewed. */
  reviewOf: string | null;
}

export interface WorkflowDefinition {
  name: string;
  mode: WorkflowMode;
  tasks: WorkflowTaskDef[];
}

export const WORKFLOW_STATUSES = ['draft', 'running', 'paused', 'blocked', 'failed', 'completed', 'canceled'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export type WorkflowTaskStatus = 'pending' | 'queued' | 'running' | 'verifying' | 'done' | 'changes_requested' | 'blocked' | 'failed' | 'canceled';

export interface WorkflowTaskState {
  status: WorkflowTaskStatus;
  assignmentId: string | null;
  reason: string | null;
  /** Code tasks: the verified head SHA the task completed at. Review tasks: the reviewed SHA. */
  completedSha: string | null;
  /** Evidence ids (verified commit/check evidence) that justified completion. */
  evidenceIds: string[];
  reviewId: string | null;
  attempts: number;
  updatedAt: string;
}

export interface Workflow {
  id: string;
  version: number;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  statusReason: string | null;
  tasks: Record<string, WorkflowTaskState>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export const ACTIVE_WORKFLOW_STATUSES: readonly WorkflowStatus[] = ['running', 'paused', 'blocked'];
export const isActiveWorkflow = (w: Pick<Workflow, 'status'>): boolean => ACTIVE_WORKFLOW_STATUSES.includes(w.status);
const TASK_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface WorkflowIssue {
  code:
    | 'empty'
    | 'name'
    | 'bad_id'
    | 'duplicate_task'
    | 'unknown_item'
    | 'unknown_agent'
    | 'agent_disabled'
    | 'unknown_dependency'
    | 'self_dependency'
    | 'cycle'
    | 'independent_dependency'
    | 'overlap'
    | 'duplicate_writer'
    | 'coordinator_code'
    | 'coordinator_label'
    | 'review_target'
    | 'review_self'
    | 'review_item'
    | 'item_terminal'
    | 'item_untracked'
    | 'item_in_other_workflow'
    | 'unknown_check';
  message: string;
  taskId?: string;
}

export function emptyTaskState(at: string): WorkflowTaskState {
  return { status: 'pending', assignmentId: null, reason: null, completedSha: null, evidenceIds: [], reviewId: null, attempts: 0, updatedAt: at };
}

/** Fill defaults and the implicit review → target edge. Never invents items or agents. */
export function normalizeWorkflow(input: unknown): WorkflowDefinition {
  const raw = (input ?? {}) as Partial<WorkflowDefinition> & { tasks?: Partial<WorkflowTaskDef>[] };
  const mode: WorkflowMode = raw.mode === 'independent' ? 'independent' : 'collaborative';
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map((t) => {
    const kind: WorkflowTaskKind = (WORKFLOW_TASK_KINDS as readonly string[]).includes(String(t.kind)) ? (t.kind as WorkflowTaskKind) : 'code';
    const reviewOf = kind === 'review' && typeof t.reviewOf === 'string' && t.reviewOf ? t.reviewOf : null;
    const dependsOn = [...new Set([...(Array.isArray(t.dependsOn) ? t.dependsOn.map(String).filter(Boolean) : []), ...(reviewOf ? [reviewOf] : [])])];
    return {
      id: String(t.id ?? '').trim(),
      title: String(t.title ?? '').trim().slice(0, 200),
      workItemId: String(t.workItemId ?? ''),
      agentId: String(t.agentId ?? ''),
      kind,
      dependsOn,
      allowedPaths: Array.isArray(t.allowedPaths) ? t.allowedPaths.map((p) => String(p).trim()).filter(Boolean) : [],
      requiredChecks: Array.isArray(t.requiredChecks) ? t.requiredChecks.map(String) : null,
      reviewOf,
    } satisfies WorkflowTaskDef;
  });
  // A review always targets the reviewed task's issue.
  for (const t of tasks) {
    if (t.kind !== 'review' || !t.reviewOf) continue;
    const target = tasks.find((x) => x.id === t.reviewOf);
    if (target && !t.workItemId) t.workItemId = target.workItemId;
  }
  return { name: String(raw.name ?? '').trim().slice(0, 120), mode, tasks };
}

/** Task ids each task (transitively) depends on. Assumes the graph is acyclic. */
export function ancestors(def: WorkflowDefinition): Map<string, Set<string>> {
  const byId = new Map(def.tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    if (stack.has(id)) return out;
    stack.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      out.add(dep);
      for (const a of visit(dep, stack)) out.add(a);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const t of def.tasks) visit(t.id, new Set());
  return memo;
}

/** First dependency cycle found, as a path of task ids, or null. */
export function findCycle(def: WorkflowDefinition): string[] | null {
  const byId = new Map(def.tasks.map((t) => [t.id, t]));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const c = color.get(dep) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (c === 0) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const t of def.tasks) if ((color.get(t.id) ?? 0) === 0) {
    const c = dfs(t.id);
    if (c) return c;
  }
  return null;
}

/** Topological order (dependencies first); input order breaks ties. */
export function topoOrder(def: WorkflowDefinition): string[] {
  const done = new Set<string>();
  const out: string[] = [];
  const ids = new Set(def.tasks.map((t) => t.id));
  let progress = true;
  while (progress && out.length < def.tasks.length) {
    progress = false;
    for (const t of def.tasks) {
      if (done.has(t.id)) continue;
      if (t.dependsOn.every((d) => done.has(d) || !ids.has(d))) {
        done.add(t.id);
        out.push(t.id);
        progress = true;
      }
    }
  }
  for (const t of def.tasks) if (!done.has(t.id)) out.push(t.id);
  return out;
}

export interface ValidateOptions {
  /** The workflow being validated, so it does not conflict with itself. */
  workflowId?: string | null;
  /** Starting requires every issue to be confirmed in the tracker (no issue, no dispatch). */
  forStart?: boolean;
  projectChecks?: Record<string, string>;
}

export function validateWorkflow(def: WorkflowDefinition, state: Pick<ControlState, 'workItems' | 'agents'> & { workflows?: ControlState['workflows'] }, o: ValidateOptions = {}): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (code: WorkflowIssue['code'], message: string, taskId?: string) => issues.push({ code, message, ...(taskId ? { taskId } : {}) });
  if (!def.name) add('name', 'Give the workflow a name.');
  if (def.tasks.length === 0) add('empty', 'Add at least one task.');
  if (def.tasks.length > 64) add('empty', 'A workflow can have at most 64 tasks.');
  const ids = new Set<string>();
  for (const t of def.tasks) {
    if (!TASK_ID.test(t.id)) add('bad_id', `Task id "${t.id}" must be lowercase letters, digits and dashes (max 32).`, t.id);
    if (ids.has(t.id)) add('duplicate_task', `Task id ${t.id} is used twice.`, t.id);
    ids.add(t.id);
  }
  const byId = new Map(def.tasks.map((t) => [t.id, t]));
  for (const t of def.tasks) {
    const item = state.workItems[t.workItemId];
    const agent = state.agents[t.agentId];
    if (!item) add('unknown_item', `${t.id}: issue ${t.workItemId || '(none)'} does not exist in this project.`, t.id);
    else {
      if (item.state === 'verified' || item.state === 'canceled') add('item_terminal', `${t.id}: ${item.key ?? item.title} is ${item.state}.`, t.id);
      if (o.forStart && (!item.key || !item.trackerId)) add('item_untracked', `${t.id}: ${item.title} is not confirmed in the tracker yet (no issue, no dispatch).`, t.id);
    }
    if (!agent) add('unknown_agent', `${t.id}: agent ${t.agentId || '(none)'} does not exist in this project.`, t.id);
    else {
      if (agent.config.enabled === false) add('agent_disabled', `${t.id}: ${agent.config.name} is a saved draft; enable it first.`, t.id);
      if (agent.config.mode === 'coordinator-only') {
        if (t.kind !== 'coordination') add('coordinator_code', `${t.id}: ${agent.config.name} is coordinator-only and cannot take ${t.kind} tasks. Give them to an engineer or reviewer.`, t.id);
        else if (item && !item.labels.some((l) => COORDINATION_LABELS.includes(l.toLowerCase()))) add('coordinator_label', `${t.id}: coordinator-only work needs one of the labels ${COORDINATION_LABELS.join(', ')} on ${item.key ?? item.title}.`, t.id);
      }
    }
    for (const dep of t.dependsOn) {
      if (dep === t.id) add('self_dependency', `${t.id} depends on itself.`, t.id);
      else if (!byId.has(dep)) add('unknown_dependency', `${t.id} depends on unknown task ${dep}.`, t.id);
    }
    if (def.mode === 'independent' && t.dependsOn.some((d) => d !== t.reviewOf)) add('independent_dependency', `${t.id}: independent workflows run tasks in parallel; switch to collaborative to order tasks.`, t.id);
    if (t.kind === 'review') {
      const target = t.reviewOf ? byId.get(t.reviewOf) : undefined;
      if (!target || target.kind !== 'code') add('review_target', `${t.id}: a review must target a code task in this workflow.`, t.id);
      else {
        if (target.agentId === t.agentId) add('review_self', `${t.id}: ${target.agentId} cannot review its own work; choose a different reviewer.`, t.id);
        if (target.workItemId !== t.workItemId) add('review_item', `${t.id}: a review must be on the same issue as ${target.id}.`, t.id);
      }
    }
    for (const c of t.requiredChecks ?? []) if (o.projectChecks && !(c in o.projectChecks)) add('unknown_check', `${t.id}: unknown check ${c}.`, t.id);
  }
  const cycle = findCycle(def);
  if (cycle) add('cycle', `Dependency cycle: ${cycle.join(' → ')}.`, cycle[0]);

  // Writers: one code task per issue, and no two writers that can run at once may share paths.
  const writers = def.tasks.filter((t) => t.kind === 'code');
  const anc = cycle ? new Map<string, Set<string>>() : ancestors(def);
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i];
      const b = writers[j];
      if (a.workItemId && a.workItemId === b.workItemId) add('duplicate_writer', `${a.id} and ${b.id} both write ${state.workItems[a.workItemId]?.key ?? a.workItemId}; one code task per issue.`, b.id);
      const ordered = anc.get(a.id)?.has(b.id) || anc.get(b.id)?.has(a.id);
      if (!ordered && scopesOverlap(a.allowedPaths, b.allowedPaths)) add('overlap', `${a.id} (${a.allowedPaths.join(', ') || 'whole repo'}) and ${b.id} (${b.allowedPaths.join(', ') || 'whole repo'}) can run at the same time with overlapping paths. Narrow the paths or add a dependency.`, b.id);
    }
  }
  // Other active workflows still own their issues and unfinished writers.
  for (const other of Object.values(state.workflows ?? {})) {
    if (other.id === o.workflowId || !isActiveWorkflow(other)) continue;
    for (const ot of other.definition.tasks) {
      const st = other.tasks[ot.id];
      if (st && (st.status === 'done' || st.status === 'canceled')) continue;
      for (const t of def.tasks) {
        if (t.workItemId === ot.workItemId) add('item_in_other_workflow', `${t.id}: ${state.workItems[t.workItemId]?.key ?? t.workItemId} is already in active workflow "${other.definition.name}".`, t.id);
        else if (t.kind === 'code' && ot.kind === 'code' && scopesOverlap(t.allowedPaths, ot.allowedPaths)) add('overlap', `${t.id} overlaps paths with ${ot.id} in active workflow "${other.definition.name}".`, t.id);
      }
    }
  }
  return dedupe(issues);
}

function dedupe(issues: WorkflowIssue[]): WorkflowIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}:${i.taskId ?? ''}:${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Pending tasks whose dependencies are all done. */
export function readyTaskIds(w: Workflow): string[] {
  return topoOrder(w.definition).filter((id) => {
    const t = w.definition.tasks.find((x) => x.id === id)!;
    return w.tasks[id]?.status === 'pending' && t.dependsOn.every((d) => w.tasks[d]?.status === 'done');
  });
}

export function workflowProgress(w: Workflow): { done: number; total: number; byStatus: Partial<Record<WorkflowTaskStatus, number>> } {
  const byStatus: Partial<Record<WorkflowTaskStatus, number>> = {};
  for (const t of w.definition.tasks) {
    const s = w.tasks[t.id]?.status ?? 'pending';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { done: byStatus.done ?? 0, total: w.definition.tasks.length, byStatus };
}

/**
 * Status implied by the tasks for a workflow that is executing. Explicit owner states (paused,
 * canceled) and draft are never overridden here.
 */
export function deriveWorkflowStatus(w: Workflow): { status: WorkflowStatus; reason: string | null } {
  if (w.status === 'draft' || w.status === 'paused' || w.status === 'canceled') return { status: w.status, reason: w.statusReason };
  const tasks = w.definition.tasks.map((t) => ({ def: t, st: w.tasks[t.id] }));
  if (tasks.every((t) => t.st?.status === 'done')) return { status: 'completed', reason: 'every task finished with recorded evidence' };
  const failed = tasks.find((t) => t.st?.status === 'failed');
  if (failed) return { status: 'failed', reason: `${failed.def.id}: ${failed.st.reason ?? 'failed'}` };
  const active = tasks.some((t) => ['queued', 'running', 'verifying'].includes(t.st?.status ?? ''));
  const ready = readyTaskIds(w).length > 0;
  const stuck = tasks.find((t) => t.st?.status === 'blocked' || t.st?.status === 'changes_requested');
  if (stuck && !active && !ready) return { status: 'blocked', reason: `${stuck.def.id}: ${stuck.st.reason ?? stuck.st.status}` };
  return { status: 'running', reason: null };
}

/** Workflows that include an issue, newest first. */
export function workflowsForItem(state: Pick<ControlState, 'workflows'>, workItemId: string): Workflow[] {
  return Object.values(state.workflows ?? {})
    .filter((w) => w.definition.tasks.some((t) => t.workItemId === workItemId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
