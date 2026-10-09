// SPDX-License-Identifier: Apache-2.0
// Project canvas: where workflow frames and their nodes sit, which finalized workflows are hidden
// and when they come back, and unsaved workflow sketches. Pure; the daemon stores it, the browser
// renders it. Workflows themselves stay the source of truth for what runs.
import type { ControlState } from './entities.ts';
import { normalizeWorkflow, type Workflow, type WorkflowDefinition, type WorkflowMode, type WorkflowTaskKind } from './workflows.ts';

export interface CanvasPoint { x: number; y: number }
/** When a hidden workflow comes back on the canvas. */
export interface CanvasShowWhen { input: boolean; failure: boolean; finished: boolean }
export interface CanvasFrame { x: number; y: number; hidden: boolean; showWhen: CanvasShowWhen }

export interface CanvasSketchTask {
  id: string;
  title: string;
  kind: WorkflowTaskKind;
  agentId: string;
  workItemId: string;
  dependsOn: string[];
  reviewOf: string | null;
  allowedPaths: string[];
  /** Carried over when a terminated workflow is reopened: where the previous attempt stopped. */
  pickup: string | null;
}

/** An editable workflow that may not be valid yet. Saving turns it into a draft workflow. */
export interface CanvasSketch {
  id: string;
  name: string;
  mode: WorkflowMode;
  /** The draft workflow this sketch edits, or null for a new one. */
  workflowId: string | null;
  version: number | null;
  /** The workflow this sketch continues after a terminate. */
  continues: string | null;
  tasks: CanvasSketchTask[];
  /** Issues placed in the frame without a task yet. */
  issues: string[];
  updatedAt: string;
}

export interface CanvasLayout {
  version: 1;
  frames: Record<string, CanvasFrame>;
  /** `${frameId}/${nodeId}` → position inside the canvas. */
  nodes: Record<string, CanvasPoint>;
  sketches: Record<string, CanvasSketch>;
}

export const CANVAS_LIMITS = { bytes: 256 * 1024, frames: 200, nodes: 4000, sketches: 100, tasks: 64, issues: 64, text: 200, pickup: 2000 } as const;
export const DEFAULT_SHOW_WHEN: CanvasShowWhen = { input: true, failure: true, finished: false };

export const emptyCanvas = (): CanvasLayout => ({ version: 1, frames: {}, nodes: {}, sketches: {} });

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,95}$/;
const NODE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9:._-]{0,95}$/;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, Math.round(n))) : 0; };
const str = (v: unknown, max: number = CANVAS_LIMITS.text) => String(v ?? '').slice(0, max);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const KINDS: readonly WorkflowTaskKind[] = ['code', 'review', 'coordination'];

function showWhen(v: unknown): CanvasShowWhen {
  const o = (v ?? {}) as Partial<CanvasShowWhen>;
  return { input: bool(o.input, DEFAULT_SHOW_WHEN.input), failure: bool(o.failure, DEFAULT_SHOW_WHEN.failure), finished: bool(o.finished, DEFAULT_SHOW_WHEN.finished) };
}

function sketchTask(v: unknown): CanvasSketchTask {
  const t = (v ?? {}) as Partial<CanvasSketchTask>;
  const kind = KINDS.includes(t.kind as WorkflowTaskKind) ? (t.kind as WorkflowTaskKind) : 'code';
  return {
    id: str(t.id, 32),
    title: str(t.title),
    kind,
    agentId: str(t.agentId, 96),
    workItemId: str(t.workItemId, 96),
    dependsOn: Array.isArray(t.dependsOn) ? [...new Set(t.dependsOn.map((d) => str(d, 32)).filter(Boolean))].slice(0, CANVAS_LIMITS.tasks) : [],
    reviewOf: kind === 'review' && t.reviewOf ? str(t.reviewOf, 32) : null,
    allowedPaths: Array.isArray(t.allowedPaths) ? t.allowedPaths.map((p) => str(p)).filter(Boolean).slice(0, 32) : [],
    pickup: t.pickup ? str(t.pickup, CANVAS_LIMITS.pickup) : null,
  };
}

/** Bound and sanitize a stored or submitted layout. Unknown fields are dropped, never trusted. */
export function normalizeCanvas(input: unknown): CanvasLayout {
  const raw = (input ?? {}) as Partial<Record<keyof CanvasLayout, unknown>>;
  const out = emptyCanvas();
  for (const [id, f] of Object.entries((raw.frames ?? {}) as Record<string, Partial<CanvasFrame>>).slice(0, CANVAS_LIMITS.frames)) {
    if (!ID.test(id) || !f || typeof f !== 'object') continue;
    out.frames[id] = { x: num(f.x), y: num(f.y), hidden: bool(f.hidden, false), showWhen: showWhen(f.showWhen) };
  }
  for (const [key, p] of Object.entries((raw.nodes ?? {}) as Record<string, Partial<CanvasPoint>>).slice(0, CANVAS_LIMITS.nodes)) {
    if (!NODE_KEY.test(key) || !p || typeof p !== 'object') continue;
    out.nodes[key] = { x: num(p.x), y: num(p.y) };
  }
  for (const [id, s] of Object.entries((raw.sketches ?? {}) as Record<string, Partial<CanvasSketch>>).slice(0, CANVAS_LIMITS.sketches)) {
    if (!ID.test(id) || !s || typeof s !== 'object') continue;
    out.sketches[id] = {
      id,
      name: str(s.name, 120),
      mode: s.mode === 'independent' ? 'independent' : 'collaborative',
      workflowId: s.workflowId ? str(s.workflowId, 96) : null,
      version: typeof s.version === 'number' && Number.isInteger(s.version) ? s.version : null,
      continues: s.continues ? str(s.continues, 96) : null,
      tasks: (Array.isArray(s.tasks) ? s.tasks : []).slice(0, CANVAS_LIMITS.tasks).map(sketchTask),
      issues: Array.isArray(s.issues) ? [...new Set(s.issues.map((i) => str(i, 96)).filter(Boolean))].slice(0, CANVAS_LIMITS.issues) : [],
      updatedAt: str(s.updatedAt, 40),
    };
  }
  return out;
}

/** The definition a sketch would save as. Validation stays with `validateWorkflow`. */
export function sketchDefinition(s: CanvasSketch): WorkflowDefinition {
  return normalizeWorkflow({ name: s.name, mode: s.mode, tasks: s.tasks.map((t) => ({ ...t, reviewOf: t.kind === 'review' ? t.reviewOf : null })) });
}

export function sketchFromWorkflow(w: Workflow, at: string): CanvasSketch {
  return {
    id: w.id,
    name: w.definition.name,
    mode: w.definition.mode,
    workflowId: w.id,
    version: w.version,
    continues: null,
    tasks: w.definition.tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, agentId: t.agentId, workItemId: t.workItemId, dependsOn: t.dependsOn.filter((d) => d !== t.reviewOf), reviewOf: t.reviewOf, allowedPaths: t.allowedPaths, pickup: null })),
    issues: [],
    updatedAt: at,
  };
}

/** A workflow can be edited only while it is a draft; the daemon enforces the same rule. */
export const isWorkflowLocked = (w: Pick<Workflow, 'status'>): boolean => w.status !== 'draft';

export interface WorkflowAttention {
  /** Open questions, approvals and decisions raised by this workflow's runs or issues. */
  input: number;
  failure: boolean;
  finished: boolean;
}

export function workflowAttention(w: Workflow, s: Pick<ControlState, 'approvals' | 'decisions' | 'runs'>): WorkflowAttention {
  const assignments = new Set(Object.values(w.tasks).map((t) => t.assignmentId).filter((a): a is string => Boolean(a)));
  const items = new Set(w.definition.tasks.map((t) => t.workItemId));
  const runs = new Set(Object.values(s.runs).filter((r) => assignments.has(r.assignmentId)).map((r) => r.id));
  const approvals = Object.values(s.approvals).filter((a) => !a.resolvedAt && runs.has(a.runId)).length;
  const decisions = Object.values(s.decisions).filter((d) => !d.answeredAt && !d.consumedAt && d.workItemId && items.has(d.workItemId)).length;
  const taskTrouble = Object.values(w.tasks).some((t) => t.status === 'failed' || t.status === 'blocked' || t.status === 'changes_requested');
  return { input: approvals + decisions, failure: w.status === 'failed' || w.status === 'blocked' || taskTrouble, finished: w.status === 'completed' || w.status === 'canceled' };
}

/** Whether a frame is drawn. Hidden workflows come back only for the reasons their owner chose. */
export function frameVisible(frame: CanvasFrame | undefined, a: WorkflowAttention): boolean {
  if (!frame?.hidden) return true;
  return (frame.showWhen.input && a.input > 0) || (frame.showWhen.failure && a.failure) || (frame.showWhen.finished && a.finished);
}

/**
 * Where an unfinished task's previous attempt stopped, from what the daemon already recorded:
 * the latest run's handoff (next step, blocker, what was done) or its exit message.
 */
export function pickupPoint(w: Workflow, taskId: string, s: Pick<ControlState, 'runs'>): string | null {
  const assignmentId = w.tasks[taskId]?.assignmentId;
  if (!assignmentId) return null;
  const run = Object.values(s.runs).filter((r) => r.assignmentId === assignmentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!run) return null;
  const h = run.handoff;
  const parts = h ? [h.done && `Done: ${h.done}`, h.next && `Next: ${h.next}`, h.blocked && `Blocked: ${h.blocked.what}${h.blocked.on ? ` (on ${h.blocked.on})` : ''}`, h.commit && `Last commit: ${h.commit.sha.slice(0, 12)}${h.commit.branch ? ` on ${h.commit.branch}` : ''}`] : [run.exit?.message && `Stopped: ${run.exit.message}`];
  const text = parts.filter(Boolean).join('\n');
  return text ? text.slice(0, CANVAS_LIMITS.pickup) : null;
}

/**
 * The draft that continues a terminated workflow: finished tasks are left out (their evidence
 * stays on the original), unfinished ones keep their wiring and carry a pickup point.
 */
export function continuationSketch(w: Workflow, s: Pick<ControlState, 'runs'>, id: string, at: string): CanvasSketch {
  const done = new Set(Object.entries(w.tasks).filter(([, t]) => t.status === 'done').map(([k]) => k));
  const tasks = w.definition.tasks.filter((t) => !done.has(t.id)).map((t) => ({
    id: t.id, title: t.title, kind: t.kind, agentId: t.agentId, workItemId: t.workItemId,
    dependsOn: t.dependsOn.filter((d) => !done.has(d) && d !== t.reviewOf),
    reviewOf: t.reviewOf && !done.has(t.reviewOf) ? t.reviewOf : null,
    allowedPaths: t.allowedPaths,
    pickup: pickupPoint(w, t.id, s),
  }));
  return { id, name: `${w.definition.name} (continued)`.slice(0, 120), mode: w.definition.mode, workflowId: null, version: null, continues: w.id, tasks, issues: [], updatedAt: at };
}
