// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Undo/redo bookkeeping for immutable snapshots. Pure: the canvas hook owns the state and the clock.

export interface History<T> { past: T[]; future: T[]; at: number }

/** Edits closer together than this share one undo step (typing, rapid multi-part operations). */
export const MERGE_MS = 600;
export const HISTORY_LIMIT = 100;

export const emptyHistory = <T,>(): History<T> => ({ past: [], future: [], at: 0 });

/** Note that `prev` was replaced by a new state at time `now`. */
export function record<T>(h: History<T>, prev: T, now: number): History<T> {
  if (h.past.length > 0 && now - h.at < MERGE_MS) return { past: h.past, future: [], at: now };
  return { past: [...h.past, prev].slice(-HISTORY_LIMIT), future: [], at: now };
}

/** Step back from `current`; null when there is nothing to undo. */
export function undoStep<T>(h: History<T>, current: T): { history: History<T>; value: T } | null {
  if (h.past.length === 0) return null;
  return { value: h.past[h.past.length - 1], history: { past: h.past.slice(0, -1), future: [current, ...h.future], at: 0 } };
}

/** Step forward from `current`; null when there is nothing to redo. */
export function redoStep<T>(h: History<T>, current: T): { history: History<T>; value: T } | null {
  if (h.future.length === 0) return null;
  return { value: h.future[0], history: { past: [...h.past, current], future: h.future.slice(1), at: 0 } };
}
