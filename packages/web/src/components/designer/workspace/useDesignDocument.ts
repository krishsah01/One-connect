// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Keeps one structured design in sync with the daemon. Edits apply locally at once (the same
// validated operations the daemon runs), then go to the daemon one batch at a time. When another
// tab or an agent changed the design first, queued edits are re-applied on the newer version; an
// edit that no longer fits is saved as a conflict proposal, so both versions survive. Unsent edits
// are kept in this browser until the daemon confirms them, so a reload doesn't lose work.
import { useCallback, useEffect, useRef, useState } from 'react';
import { applyDesignOperations, applyDesignPatch, diffDesignDocuments, type Actor, type DesignDocument, type DesignOperation, type DesignPatch } from '@acc/core';
import { api, ApiError, post } from '../../../lib/api';
import { live } from '../../../lib/store';

export interface ProposalView {
  id: string; kind: 'agent' | 'conflict' | 'library' | 'repair'; baseVersion: number; summary: string; operations: DesignOperation[];
  by: Actor; status: 'pending' | 'applied' | 'discarded'; createdAt: string; changes: string[]; screens: string[];
  assignmentId?: string | null; runId?: string | null; library?: { kitId: string; version: number } | null;
}
export interface JobView { assignmentId: string; request: string; selection: string[]; files: string[]; kind: string; skills: { id: string; why: string }[]; createdAt: string }
export interface RecordView {
  document: DesignDocument; proposals: ProposalView[]; jobs: JobView[]; assignments: string[]; authors: Actor[];
  updatedAt: string; artifactId: string | null; undo: { count: number; label: string | null }; redo: { count: number; label: string | null };
}
interface Ack { id: string; version: number; updatedAt: string; patch: DesignPatch; undo: RecordView['undo']; redo: RecordView['redo'] }
interface Pending { ops: DesignOperation[]; label: string; retried?: boolean }
export type SyncState = 'loading' | 'saved' | 'saving' | 'offline' | 'error';

const storeKey = (id: string) => `one-connect.designer.pending.${id}`;
const canon = (v: unknown) => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
/** Whether a document already includes every change in a patch (an edit whose receipt was lost). */
function contains(d: DesignDocument, patch: DesignPatch): boolean {
  for (const [key, value] of Object.entries(patch)) {
    const cur = (d as unknown as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && ['nodes', 'components', 'tokens', 'assets', 'fixtures'].includes(key)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const have = (cur as Record<string, unknown>)[k];
        if (v === null ? have !== undefined : canon(have) !== canon(v)) return false;
      }
    } else if (canon(cur) !== canon(value)) return false;
  }
  return true;
}
function readPending(id: string): { base: number; queue: Pending[] } | null {
  try { const raw = localStorage.getItem(storeKey(id)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writePending(id: string, base: number, queue: Pending[]) {
  try { if (queue.length) localStorage.setItem(storeKey(id), JSON.stringify({ base, queue })); else localStorage.removeItem(storeKey(id)); } catch { /* private window: edits still sync while open */ }
}

export function useDesignDocument(id: string | null) {
  const [record, setRecord] = useState<RecordView | null>(null);
  const [doc, setDoc] = useState<DesignDocument | null>(null);
  const [sync, setSync] = useState<SyncState>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const base = useRef<DesignDocument | null>(null);
  const shown = useRef<DesignDocument | null>(null);
  const queue = useRef<Pending[]>([]);
  const sending = useRef(false);
  const alive = useRef(true);
  const recordRef = useRef<RecordView | null>(null);
  recordRef.current = record;

  const show = (d: DesignDocument) => { shown.current = d; setDoc(d); };
  /** Re-apply queued edits on a newer base. Those that no longer fit become conflict proposals. */
  const rebase = useCallback(async (next: DesignDocument, previousVersion: number) => {
    let cur = next;
    const kept: Pending[] = [], lost: Pending[] = [];
    for (const p of queue.current) {
      try { cur = applyDesignOperations(cur, p.ops); kept.push(p); } catch { lost.push(p); }
    }
    queue.current = kept;
    for (const p of lost) await post(`/api/designer/documents/${next.id}/conflicts`, { baseVersion: previousVersion, operations: p.ops, label: p.label }).catch(() => undefined);
    if (lost.length) setNotice(`${lost.length === 1 ? 'One change' : `${lost.length} changes`} couldn’t be combined with a newer version. ${lost.length === 1 ? 'It’s' : 'They’re'} saved under Assistant → Changes to review.`);
    else if (kept.length) setNotice('This design changed in another tab. Your edits were combined with that version.');
    return cur;
  }, []);

  const load = useCallback(async (reason: 'open' | 'refresh' = 'refresh') => {
    if (!id) return;
    const r = await api<RecordView>(`/api/designer/documents/${id}`);
    if (!alive.current) return;
    const before = base.current;
    base.current = r.document;
    setRecord(r);
    if (reason === 'open') {
      const saved = readPending(id);
      if (saved?.queue.length) {
        queue.current = saved.queue;
        const merged = saved.base === r.document.version ? applyAll(r.document, saved.queue) : await rebase(r.document, saved.base);
        show(merged);
        setNotice('Unsaved edits from your last visit were restored and are being saved.');
        void pump();
        return;
      }
    }
    if (!queue.current.length && !sending.current) show(r.document);
    else if (before && before.version !== r.document.version) show(await rebase(r.document, before.version));
    setSync(queue.current.length ? 'saving' : 'saved');
  }, [id, rebase]); // eslint-disable-line react-hooks/exhaustive-deps

  const pump = useCallback(async () => {
    if (sending.current || !id || !queue.current.length || !base.current) return;
    sending.current = true;
    setSync('saving');
    try {
      while (queue.current.length && alive.current) {
        const p = queue.current[0];
        writePending(id, base.current!.version, queue.current);
        try {
          const ack = await post<Ack>(`/api/designer/documents/${id}/operations`, { expected: base.current!.version, operations: p.ops, label: p.label });
          base.current = applyDesignPatch(base.current!, ack.patch, ack.version);
          queue.current.shift();
          setRecord(r => r && { ...r, document: base.current!, updatedAt: ack.updatedAt, undo: ack.undo, redo: ack.redo });
        } catch (e) {
          // Decide from the daemon's current state, not the error: desktop bridges report any failed
          // write as an unknown receipt, and a lost receipt may hide an edit that did land.
          const status = e instanceof ApiError ? e.status : 0;
          let latest: RecordView;
          try { latest = await api<RecordView>(`/api/designer/documents/${id}`); }
          catch { setSync('offline'); setError('Can’t reach One Connect right now. Your edits are kept on this device and will be saved when it’s back.'); setTimeout(() => { sending.current = false; void pump(); }, 4000); return; }
          const previous = base.current!;
          if (latest.document.version === previous.version) {
            // Not applied. A lost connection gets one retry; a refusal is dropped and explained.
            if (status === 0 && !p.retried) { p.retried = true; continue; }
            queue.current.shift();
            setError(e instanceof ApiError && e.status === 0 ? 'One Connect couldn’t save that change.' : (e as Error).message);
            show(applyAll(base.current!, queue.current));
            continue;
          }
          base.current = latest.document;
          setRecord(latest);
          let landed = false;
          try { landed = contains(latest.document, diffDesignDocuments(previous, applyDesignOperations(previous, p.ops)).forward); } catch { /* not applicable to the old base */ }
          if (landed) queue.current.shift();
          show(await rebase(latest.document, previous.version));
          continue;
        }
      }
      writePending(id, base.current!.version, queue.current);
      if (!queue.current.length) { show(base.current!); setSync('saved'); setError(''); }
    } finally { sending.current = false; }
  }, [id, rebase]);

  /** Apply operations now and save them. Returns false (and explains) when they don't fit. */
  const apply = useCallback((ops: DesignOperation[], label = 'Edit'): boolean => {
    const cur = shown.current;
    if (!cur || !ops.length) return false;
    try { show(applyDesignOperations(cur, ops)); }
    catch (e) { setError((e as Error).message); return false; }
    setError('');
    const last = queue.current.at(-1);
    // Typing into one field produces many small edits; merge consecutive edits with the same label.
    if (last && !sending.current && last.label === label && label.startsWith('Edit ') && queue.current.length === 1) last.ops = [...last.ops, ...ops].slice(-500);
    else queue.current.push({ ops, label });
    void pump();
    return true;
  }, [pump]);

  const flush = useCallback(async () => {
    for (let i = 0; i < 200 && (queue.current.length || sending.current); i++) { void pump(); await new Promise(r => setTimeout(r, 25)); }
  }, [pump]);

  const step = useCallback(async (direction: 'undo' | 'redo') => {
    if (!id) return;
    await flush();
    try {
      const ack = await post<Ack>(`/api/designer/documents/${id}/history`, { expected: base.current!.version, direction });
      base.current = applyDesignPatch(base.current!, ack.patch, ack.version);
      show(base.current);
      setRecord(r => r && { ...r, document: base.current!, undo: ack.undo, redo: ack.redo });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await load();
      setError((e as Error).message);
    }
  }, [id, flush, load]);

  /** Run a request that changes the record on the daemon, then show its result. */
  const mutate = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    await flush();
    try {
      const out = await fn();
      if (out && typeof out === 'object' && 'document' in (out as object) && 'proposals' in (out as object)) {
        const r = out as unknown as RecordView;
        base.current = r.document; setRecord(r); show(r.document);
      } else await load();
      setError('');
      return out;
    } catch (e) { setError((e as Error).message); await load().catch(() => undefined); return undefined; }
  }, [flush, load]);

  useEffect(() => {
    alive.current = true;
    base.current = null; shown.current = null; queue.current = []; sending.current = false;
    setRecord(null); setDoc(null); setError(''); setNotice(''); setSync('loading');
    if (id) void load('open').catch(e => { setError((e as Error).message); setSync('error'); });
    return () => { alive.current = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Changes from other tabs, agents and the review flow arrive as events.
  useEffect(() => {
    if (!id) return;
    let timer = 0;
    const off = live.onEvents(events => {
      const mine = events.filter(e => e.type === 'design.document_changed' && (e.data as { id?: string }).id === id);
      const versionAhead = mine.some(e => (e.data as { version: number }).version > (base.current?.version ?? 0));
      const recordChanged = mine.some(e => ['proposal', 'proposal-discarded', 'ai-requested', 'kit-saved'].includes((e.data as { action: string }).action));
      const reviewChanged = events.some(e => e.type === 'design.mock_captured' || e.type === 'design.mock_reviewed');
      if (!versionAhead && !recordChanged && !reviewChanged) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => { if (!sending.current && !queue.current.length) void load().catch(() => undefined); }, 250);
    });
    return () => { clearTimeout(timer); off(); };
  }, [id, load]);

  return { record, doc, sync, error, notice, setError, setNotice, apply, undo: () => step('undo'), redo: () => step('redo'), reload: load, mutate, flush, pending: () => queue.current.length };
}

function applyAll(d: DesignDocument, queue: Pending[]): DesignDocument {
  let cur = d;
  for (const p of queue) try { cur = applyDesignOperations(cur, p.ops); } catch { /* reported when it is sent */ }
  return cur;
}
