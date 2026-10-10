// SPDX-License-Identifier: Apache-2.0
// Shared Designer studio types, server-backed drafts and accessible tabs.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  AgentEligibility, artifactStatus, DesignChange, DesignCheck, DesignJob, DesignRevision, DesignSkill, DesignSystem, JobStatus, MockArtifact, MockGate, MockRevision,
  PreflightResult, REVIEW_CHECKLIST,
} from '@acc/core';
import { api } from '../../lib/api';
import { activeProject, isDesktop, onBeforeProjectSwitch } from '../../lib/desktop';
import { identityRevision } from '../../lib/remote';
import type { Tone } from '../../lib/format';

export interface Draft<T = unknown> { key: string; value: T; savedAt: string; base: string | null }
export interface FullExports { revision: DesignRevision; markdown: string; css: string; checks: DesignCheck[]; schema: 1 | 2; tokens: Record<string, unknown>; specimen: string; diff: DesignChange[]; parent: { hash: string; version: number } | null }
export interface HistoryEntry { version: number; hash: string; createdAt: string; by: { type: string; id: string } | null; parent: string | null; note: string | null; schema: 1 | 2 }
export interface ContractResponse {
  current: FullExports | null;
  history: HistoryEntry[];
  draft: Draft<DesignSystem> | null;
  skills: (DesignSkill & { purpose: string })[];
  skillSets: { design: string[]; implementation: readonly string[]; review: readonly string[] };
  checklist: typeof REVIEW_CHECKLIST;
}
export interface Validation { ok: boolean; errors: string[]; system?: DesignSystem; hash?: string; unchanged?: boolean; checks?: DesignCheck[]; warnings?: string[]; diff?: DesignChange[]; current: { hash: string; version: number } | null }
export interface StudioAgent { id: string; name: string; adapter: string; status: string; eligibility: AgentEligibility }
export interface StudioOverview { contract: { hash: string; version: number } | null; agents: StudioAgent[]; jobs: unknown[]; tooling: { playwright: { found: boolean; path: string | null; note: string } } }
export type GateView = MockGate;
export type RevisionView = MockRevision & { gate: GateView };
export type MockView = Omit<MockArtifact, 'revisions'> & { issue: { id: string; key: string | null; title: string } | null; status: ReturnType<typeof artifactStatus>; revisions: RevisionView[] };
export interface JobView { job: DesignJob; status: JobStatus; prompt?: string }
export interface AssignmentLite { id: string; position: string; preflight: PreflightResult | null }

export const GATE_LABEL: Record<GateView['state'], [Tone, string]> = {
  clear: ['ok', 'no open findings'], needs_review: ['warn', 'needs review'], excepted: ['info', 'excepted'], approved: ['ok', 'approved'],
  changes_requested: ['crit', 'changes requested'], needs_independent_review: ['warn', 'needs independent review'],
};
export const shortSha = (s: string | null | undefined) => (s ? s.slice(0, 12) : '—');
export const draftUrl = (key: string) => `/api/designer/drafts/${encodeURIComponent(key)}`;

/**
 * A draft kept on this project's daemon, so it survives reloads, project switches and long agent
 * runs. Autosaves after a short pause; never becomes an approved contract by itself.
 */
export function useServerDraft<T>(key: string | null, fallback: () => T) {
  const fallbackRef = useRef(fallback); fallbackRef.current = fallback;
  const [value, setValueState] = useState<T>(() => fallback());
  const [loaded, setLoaded] = useState(false), [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null), [error, setError] = useState('');
  type Context = { key: string; project?: string; identity: number; alive: boolean; loaded: boolean; value: T; revision: number; saved: number; tail: Promise<void>; timer?: ReturnType<typeof setTimeout> };
  const context = useRef<Context | null>(null);
  const request = <R,>(c: Context, method = 'GET', body?: unknown) => {
    if (identityRevision() !== c.identity || (isDesktop && activeProject()?.project !== c.project)) return Promise.reject(new Error('Project or sign-in changed; draft was not sent.'));
    return api<R>(draftUrl(c.key), { method, body, project: c.project }).then(r => {
      if (identityRevision() !== c.identity || (isDesktop && activeProject()?.project !== c.project)) throw new Error('Project or sign-in changed; draft receipt was discarded.');
      return r;
    });
  };
  // Every write for this mounted draft is serialized, including discard. A late receipt only
  // confirms the revision it wrote; it can never mark newer edits as saved.
  const flushContext = useCallback((c: Context): Promise<void> => {
    if (c.timer) clearTimeout(c.timer);
    const task = c.tail.catch(() => undefined).then(async () => {
      if (!c.loaded || c.revision === c.saved) return;
      const revision = c.revision, snapshot = c.value;
      try {
        const r = await request<{ draft: Draft<T> }>(c, 'PUT', { value: snapshot });
        c.saved = revision;
        if (c.alive && context.current === c) { setSavedAt(r.draft.savedAt); setError(''); setDirty(c.revision !== c.saved); }
      } catch (e) {
        if (c.alive && context.current === c) setError(`Draft not saved: ${(e as Error).message}`);
        throw e;
      }
    });
    c.tail = task;
    return task;
  }, []);
  useEffect(() => {
    setLoaded(false); setDirty(false); setSavedAt(null); setError('');
    if (!key) { context.current = null; return; }
    const c: Context = { key, project: isDesktop ? activeProject()?.project : undefined, identity: identityRevision(), alive: true, loaded: false, value: fallbackRef.current(), revision: 0, saved: 0, tail: Promise.resolve() };
    context.current = c;
    void request<{ draft: Draft<T> | null }>(c).then(r => {
      if (!c.alive || context.current !== c) return;
      c.value = r.draft ? r.draft.value : fallbackRef.current(); c.loaded = true;
      setValueState(c.value); setSavedAt(r.draft?.savedAt ?? null); setLoaded(true);
    }).catch(e => { if (c.alive && context.current === c) setError(`Could not load draft: ${(e as Error).message}. Reload before editing.`); });
    const off = onBeforeProjectSwitch(() => flushContext(c));
    return () => { off(); c.alive = false; if (c.timer) clearTimeout(c.timer); void flushContext(c).catch(() => undefined); };
  }, [key, flushContext]);
  const setValue = useCallback((next: T | ((x: T) => T)) => {
    const c = context.current; if (!c?.loaded || !c.alive) return;
    c.value = typeof next === 'function' ? (next as (x: T) => T)(c.value) : next;
    c.revision++; setValueState(c.value); setDirty(true);
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(() => { void flushContext(c).catch(() => undefined); }, 700);
  }, [flushContext]);
  const flush = useCallback(() => context.current ? flushContext(context.current) : Promise.resolve(), [flushContext]);
  const discard = useCallback(async () => {
    const c = context.current; if (!c?.loaded || !c.alive) return;
    if (c.timer) clearTimeout(c.timer);
    const task = c.tail.catch(() => undefined).then(async () => {
      try {
        await request(c, 'DELETE');
        c.value = fallbackRef.current(); c.revision++; c.saved = c.revision;
        if (c.alive && context.current === c) { setSavedAt(null); setValueState(c.value); setDirty(false); setError(''); }
      } catch (e) { if (c.alive && context.current === c) setError(`Draft not cleared: ${(e as Error).message}`); }
    });
    c.tail = task; await task;
  }, []);
  const reset = useCallback((v: T) => {
    const c = context.current; if (!c?.loaded || !c.alive) return;
    if (c.timer) clearTimeout(c.timer);
    c.value = v; c.revision++; c.saved = c.revision;
    setValueState(v); setDirty(false); setSavedAt(null);
  }, []);
  return { value, setValue, loaded, savedAt, error, discard, reset, dirty, flush };
}

/** WAI-ARIA tabs: arrow keys, Home and End move between tabs; only the selected tab is tabbable. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idBase, className = 'studio-tabs' }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void; label: string; idBase: string; className?: string }) {
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = tabs.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    document.getElementById(`${idBase}-tab-${tabs[next].id}`)?.focus();
  };
  return <div role="tablist" aria-label={label} className={className}>
    {tabs.map((t, i) => <button key={t.id} type="button" role="tab" id={`${idBase}-tab-${t.id}`} aria-selected={value === t.id} aria-controls={`${idBase}-panel-${t.id}`} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)} onKeyDown={e => onKey(e, i)}>{t.label}</button>)}
  </div>;
}
export const tabPanel = (idBase: string, id: string) => ({ role: 'tabpanel' as const, id: `${idBase}-panel-${id}`, 'aria-labelledby': `${idBase}-tab-${id}`, tabIndex: 0 });

export function DraftStatus({ savedAt, error, label = 'Draft' }: { savedAt: string | null; error: string; label?: string }) {
  if (error) return <span className="small text-warn" role="status">{error}</span>;
  return <span className="small faint" role="status">{savedAt ? `${label} saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · not approved` : `${label} not saved yet`}</span>;
}

export function download(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
