// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// One lifecycle state machine shared by every view, the daemon and the tracker sync.

export const MAIN_STATES = [
  'backlog',
  'selected',
  'assigned_next',
  'assigned_now',
  'running',
  'handoff_received',
  'in_review',
  'changes_requested',
  'approved',
  'merged',
  'release_candidate',
  'deployed',
  'verified',
] as const;

export const SIDE_STATES = ['blocked', 'stalled', 'failed', 'canceled'] as const;

export type MainState = (typeof MAIN_STATES)[number];
export type SideState = (typeof SIDE_STATES)[number];
export type LifecycleState = MainState | SideState;

export const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
  backlog: 'Backlog',
  selected: 'Selected',
  assigned_next: 'Assigned (Next)',
  assigned_now: 'Assigned (Now)',
  running: 'Running',
  handoff_received: 'Handoff received',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  merged: 'Merged to integration',
  release_candidate: 'Release candidate',
  deployed: 'Deployed',
  verified: 'Verified (Done)',
  blocked: 'Blocked',
  stalled: 'Stalled',
  failed: 'Failed',
  canceled: 'Canceled',
};

export type BlockedOn = { kind: 'human' | 'issue' | 'agent'; ref?: string; reason: string };

/** Tracker-neutral status buckets; each tracker adapter maps these to its own names. */
export type TrackerCategory = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';

export const DEFAULT_TRACKER_CATEGORY: Record<LifecycleState, TrackerCategory> = {
  backlog: 'backlog',
  selected: 'todo',
  assigned_next: 'todo',
  assigned_now: 'todo',
  running: 'in_progress',
  handoff_received: 'in_review',
  in_review: 'in_review',
  changes_requested: 'in_progress',
  approved: 'in_review',
  merged: 'in_review',
  release_candidate: 'in_review',
  deployed: 'in_review',
  verified: 'done',
  blocked: 'in_progress',
  stalled: 'in_progress',
  failed: 'in_progress',
  canceled: 'canceled',
};

const T: Record<LifecycleState, readonly LifecycleState[]> = {
  backlog: ['selected', 'assigned_next', 'assigned_now', 'canceled', 'blocked'],
  selected: ['backlog', 'assigned_next', 'assigned_now', 'canceled', 'blocked'],
  assigned_next: ['assigned_now', 'selected', 'backlog', 'canceled', 'blocked'],
  assigned_now: ['running', 'assigned_next', 'selected', 'canceled', 'blocked', 'failed'],
  running: ['handoff_received', 'stalled', 'failed', 'blocked', 'canceled', 'assigned_now'],
  stalled: ['running', 'failed', 'canceled', 'assigned_now', 'blocked', 'handoff_received'],
  failed: ['assigned_now', 'assigned_next', 'running', 'selected', 'canceled', 'blocked'],
  handoff_received: ['in_review', 'running', 'assigned_now', 'changes_requested', 'blocked', 'canceled'],
  in_review: ['changes_requested', 'approved', 'blocked', 'canceled'],
  changes_requested: ['assigned_now', 'assigned_next', 'running', 'blocked', 'canceled'],
  approved: ['merged', 'changes_requested', 'blocked', 'canceled'],
  merged: ['release_candidate', 'verified', 'blocked'],
  release_candidate: ['deployed', 'blocked', 'merged'],
  deployed: ['verified', 'blocked', 'release_candidate'],
  verified: [],
  // Blocked resumes to wherever the work actually is; validated against `resumeTo` by callers.
  blocked: ['backlog', 'selected', 'assigned_next', 'assigned_now', 'running', 'handoff_received', 'in_review', 'changes_requested', 'approved', 'merged', 'release_candidate', 'deployed', 'canceled'],
  canceled: ['backlog'],
};

export interface EvidenceLike {
  kind: string;
  verified: boolean;
  env?: string;
}

export interface TransitionContext {
  evidence?: readonly EvidenceLike[];
  /** Acceptance needs production or real-device verification before Done. */
  requiresProductionVerification?: boolean;
}

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function allowedTransitions(from: LifecycleState): readonly LifecycleState[] {
  return T[from];
}

export function canTransition(from: LifecycleState, to: LifecycleState, ctx: TransitionContext = {}): TransitionCheck {
  if (from === to) return { ok: false, reason: `already ${from}` };
  if (!T[from].includes(to)) return { ok: false, reason: `${LIFECYCLE_LABELS[from]} → ${LIFECYCLE_LABELS[to]} is not a valid transition` };
  if (to === 'verified') {
    const ev = ctx.evidence ?? [];
    const merge = ev.some((e) => e.kind === 'merge' && e.verified);
    const acceptance = ev.filter((e) => e.kind === 'acceptance' && e.verified);
    if (!merge) return { ok: false, reason: 'Done requires verified merge evidence' };
    if (acceptance.length === 0) return { ok: false, reason: 'Done requires verified acceptance evidence' };
    if (ctx.requiresProductionVerification && !acceptance.some((e) => e.env === 'production' || e.env === 'device')) {
      return { ok: false, reason: 'Acceptance needs production or real-device evidence before Done' };
    }
  }
  return { ok: true };
}

/**
 * Shortest valid path from → to (excluding `from`), stepping only through ordinary forward
 * states, e.g. backlog → running = [assigned_now, running]. Null if unreachable.
 */
export function transitionPath(from: LifecycleState, to: LifecycleState): LifecycleState[] | null {
  if (from === to) return [];
  const via = new Set<LifecycleState>(['selected', 'assigned_next', 'assigned_now', 'running', 'handoff_received', 'in_review', 'approved', 'merged', 'release_candidate', 'deployed']);
  const prev = new Map<LifecycleState, LifecycleState>();
  const queue: LifecycleState[] = [from];
  const seen = new Set<LifecycleState>([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of T[cur]) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      if (n === to) {
        const path: LifecycleState[] = [n];
        for (let p = prev.get(n)!; p !== from; p = prev.get(p)!) path.unshift(p);
        return path;
      }
      if (via.has(n)) queue.push(n);
    }
  }
  return null;
}

export function isTerminal(s: LifecycleState): boolean {
  return s === 'verified' || s === 'canceled';
}

export function isActiveWork(s: LifecycleState): boolean {
  return s === 'running' || s === 'stalled';
}

/** Board column grouping used by the Work Board and the pipeline strip. */
export const PIPELINE: { id: string; label: string; states: LifecycleState[] }[] = [
  { id: 'backlog', label: 'Backlog', states: ['backlog'] },
  { id: 'ready', label: 'Ready', states: ['selected'] },
  { id: 'assigned', label: 'Assigned', states: ['assigned_next', 'assigned_now'] },
  { id: 'running', label: 'Running', states: ['running'] },
  { id: 'handoff', label: 'Handoff', states: ['handoff_received'] },
  { id: 'review', label: 'Review', states: ['in_review', 'changes_requested', 'approved'] },
  { id: 'merged', label: 'Merged', states: ['merged', 'release_candidate', 'deployed'] },
  { id: 'done', label: 'Done', states: ['verified'] },
  { id: 'attention', label: 'Needs attention', states: ['blocked', 'stalled', 'failed'] },
];
