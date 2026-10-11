// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { describe, expect, it } from 'vitest';
import { emptyHistory, HISTORY_LIMIT, MERGE_MS, record, redoStep, undoStep } from '../src/lib/history';

describe('canvas undo history', () => {
  it('undoes and redoes in order', () => {
    let h = record(emptyHistory<string>(), 'a', 0);
    h = record(h, 'b', MERGE_MS * 2);
    const u1 = undoStep(h, 'c')!;
    expect(u1.value).toBe('b');
    const u2 = undoStep(u1.history, u1.value)!;
    expect(u2.value).toBe('a');
    expect(undoStep(u2.history, u2.value)).toBeNull();
    const r1 = redoStep(u2.history, u2.value)!;
    expect(r1.value).toBe('b');
    expect(redoStep(redoStep(r1.history, r1.value)!.history, 'c')).toBeNull();
  });

  it('merges rapid edits into one step', () => {
    let h = record(emptyHistory<string>(), 'a', 0);
    h = record(h, 'b', 100);
    h = record(h, 'c', 200);
    expect(h.past).toEqual(['a']);
  });

  it('drops redo history on a new edit and starts a fresh step after undo', () => {
    let h = record(emptyHistory<string>(), 'a', 0);
    h = record(h, 'b', MERGE_MS * 2);
    const u = undoStep(h, 'c')!;
    expect(u.history.future).toEqual(['c']);
    const next = record(u.history, 'b', Date.now());
    expect(next.future).toEqual([]);
    expect(next.past).toEqual(['a', 'b']);
  });

  it('caps the history length', () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = record(h, i, i * MERGE_MS * 2);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[h.past.length - 1]).toBe(HISTORY_LIMIT + 19);
  });
});
