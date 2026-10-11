// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Choose a finalized mock for a workflow's Design node and see it: the attached revision renders as
// a miniature right in the inspector. Finalized means a revision whose approval holds on the current
// project design system; everything else is listed with the reason it is not ready and a way into
// the Designer or Mocks to finish it.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { mockGate, type ControlState, type DesignDocument, type MockArtifact, type MockRevision } from '@acc/core';
import { Badge } from '../common';
import { api } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { loadPreview, StaticFrame } from './MockStage';
import { DocumentRenderer } from './workspace/DocumentRenderer';

export interface DesignPick { artifactId: string; rev: number }
type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'idle';
const GATE: Record<ReturnType<typeof mockGate>['state'], [Tone, string, string]> = {
  approved: ['ok', 'Approved', ''],
  needs_independent_review: ['warn', 'Needs independent review', 'Approved by its author; another agent must review it before it can be used.'],
  needs_review: ['warn', 'Needs review', 'Open findings need a decision.'],
  changes_requested: ['crit', 'Changes requested', 'Make the requested changes and release again.'],
  excepted: ['info', 'Not approved yet', 'Findings are excepted; a human approval is still needed.'],
  clear: ['idle', 'Not approved yet', 'Review and approve it to finalize.'],
};
const MINI_WIDTH = 1280;

function describe(r: MockRevision) {
  if (r.document) return `Design release · rev ${r.rev} · v${r.document.version}`;
  const pages = r.files.filter(f => f.kind === 'html').length;
  return `Mock · rev ${r.rev} · ${pages} page${pages === 1 ? '' : 's'}`;
}
const openHref = (a: MockArtifact, r: MockRevision) => r.document ? `/designer?document=${encodeURIComponent(r.document.id)}&sheet=review` : `/mocks/${encodeURIComponent(a.id)}?rev=${r.rev}`;

export function DesignPicker({ state, value, onPick, disabled, onDesign }: { state: ControlState; value: DesignPick | null; onPick: (pick: DesignPick | null) => void; disabled?: boolean; onDesign: () => void }) {
  const [query, setQuery] = useState('');
  const current = state.design?.hash ?? null;
  const artifacts = Object.values(state.mocks ?? {}).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  const q = query.trim().toLowerCase();
  const shown = artifacts.filter(a => !q || a.title.toLowerCase().includes(q));
  const finalized = shown.flatMap(a => [...a.revisions].reverse().filter(r => mockGate(r, current).state === 'approved').map(r => ({ a, r })));
  const pending = shown.filter(a => !a.revisions.some(r => mockGate(r, current).state === 'approved')).map(a => ({ a, r: a.revisions.at(-1)!, gate: mockGate(a.revisions.at(-1)!, current) }));
  const chosen = value ? state.mocks?.[value.artifactId] : undefined;
  const chosenRev = chosen?.revisions.find(r => r.rev === value!.rev);
  const chosenGate = chosenRev ? mockGate(chosenRev, current) : null;

  return <div className="dp">
    {value && <div className={`dp-chosen${chosenGate?.state === 'approved' ? '' : ' stale'}`} aria-label="Attached mock">
      {chosen && chosenRev && <DesignMiniature artifact={chosen} revision={chosenRev} />}
      <div className="dp-chosen-row">
        <div className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
          <b>{chosen?.title ?? 'Missing mock'}</b>
          <span className="small muted">{chosenRev ? describe(chosenRev) : `${value.artifactId} rev ${value.rev} is no longer available`}</span>
          {chosenGate && chosenGate.state !== 'approved' && <span className="small text-warn">{chosenGate.approval?.reason ?? GATE[chosenGate.state][2] ?? 'This revision is not approved any more.'}</span>}
        </div>
        {chosen && chosenRev && <Link className="btn sm" to={openHref(chosen, chosenRev)}>Open</Link>}
        <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => onPick(null)}>Detach</button>
      </div>
    </div>}
    {artifacts.length > 4 && <input aria-label="Search mocks" placeholder="Search mocks" value={query} onChange={e => setQuery(e.target.value)} />}
    <span className="small muted">Finalized · {finalized.length}</span>
    {finalized.length === 0 && <p className="small faint" style={{ margin: 0 }}>{artifacts.length ? 'Nothing is approved on the current design system yet.' : 'No mocks yet. Design one, review it, and it appears here.'}</p>}
    {finalized.length > 0 && <ul className="dp-list" aria-label="Finalized mocks">{finalized.map(({ a, r }) => {
      const picked = value?.artifactId === a.id && value.rev === r.rev;
      return <li key={`${a.id}#${r.rev}`} className={picked ? 'picked' : ''}>
        <div className="col" style={{ gap: 2, minWidth: 0 }}><b>{a.title}</b><span className="small muted">{describe(r)}</span></div>
        <Badge tone="ok">Approved</Badge>
        <button type="button" className={`btn sm${picked ? '' : ' primary'}`} disabled={disabled || picked} aria-pressed={picked} onClick={() => onPick({ artifactId: a.id, rev: r.rev })}>{picked ? 'Attached' : 'Use'}</button>
      </li>;
    })}</ul>}
    {pending.length > 0 && <>
      <span className="small muted">Not finalized · {pending.length}</span>
      <ul className="dp-list" aria-label="Mocks not yet finalized">{pending.map(({ a, r, gate }) => <li key={a.id}>
        <div className="col" style={{ gap: 2, minWidth: 0 }}><b>{a.title}</b><span className="small muted">{describe(r)}</span><span className="small faint">{gate.approval?.reason ?? GATE[gate.state][2]}</span></div>
        <Badge tone={GATE[gate.state][0]}>{GATE[gate.state][1]}</Badge>
        <Link className="btn sm" to={openHref(a, r)}>{r.document ? 'Finish in Designer' : 'Open mock'}</Link>
      </li>)}</ul>
    </>}
    <button type="button" className="btn sm" onClick={onDesign}>Design a new mock</button>
  </div>;
}

/** A read-only miniature of one revision: the structured runtime for design releases, the sandboxed static render for HTML mocks. */
export function DesignMiniature({ artifact, revision: r }: { artifact: MockArtifact; revision: MockRevision }) {
  return r.document ? <StructuredMiniature artifactId={artifact.id} rev={r.rev} /> : <MockMiniature artifact={artifact} revision={r} />;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  useEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setWidth(Math.max(120, el.clientWidth));
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function StructuredMiniature({ artifactId, rev }: { artifactId: string; rev: number }) {
  const [doc, setDoc] = useState<DesignDocument | null>(null), [assets, setAssets] = useState<Record<string, string>>({}), [error, setError] = useState('');
  const [screen, setScreen] = useState('');
  const { ref, width } = useWidth();
  const dark = useTheme().mode === 'dark';
  useEffect(() => {
    let alive = true; setDoc(null); setError('');
    void api<{ document: DesignDocument; source: Record<string, string> }>(`/api/designer/releases/${encodeURIComponent(artifactId)}/${rev}`).then(res => {
      if (!alive) return;
      setDoc(res.document); setScreen(res.document.screens.find(s => s.kind !== 'dialog' && s.kind !== 'drawer')?.id ?? res.document.screens[0]?.id ?? '');
      setAssets(Object.fromEntries(Object.values(res.document.assets).map(a => [a.id, `data:${a.mime};base64,${res.source[`assets/${a.hash}`] ?? ''}`])));
    }, e => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [artifactId, rev]);
  const zoom = width / MINI_WIDTH;
  const pages = doc?.screens.filter(s => s.kind !== 'dialog' && s.kind !== 'drawer') ?? [];
  return <div className="dp-mini" ref={ref} aria-label={`Miniature of revision ${rev}`}>
    {error ? <span className="small text-warn">Preview unavailable: {error}</span> : !doc ? <span className="small muted" role="status">Rendering revision {rev}…</span> : <>
      <div className="dp-mini-frame" style={{ height: Math.round(MINI_WIDTH * 0.625 * zoom) }}>
        <div style={{ zoom, width: MINI_WIDTH, pointerEvents: 'none' }} aria-hidden="true"><DocumentRenderer document={doc} screenId={screen} width={MINI_WIDTH} dark={dark} assetUrl={id => assets[id]} /></div>
      </div>
      {pages.length > 1 && <div className="dp-mini-pages" role="group" aria-label="Screens">{pages.slice(0, 6).map(s => <button key={s.id} type="button" aria-pressed={screen === s.id} onClick={() => setScreen(s.id)}>{s.name}</button>)}</div>}
    </>}
  </div>;
}

function MockMiniature({ artifact, revision: r }: { artifact: MockArtifact; revision: MockRevision }) {
  const pages = r.files.filter(f => f.kind === 'html').map(f => f.path);
  const [page, setPage] = useState(r.entry || pages[0] || 'index.html');
  const [doc, setDoc] = useState<string | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true; setDoc(null); setError('');
    loadPreview(artifact.id, r.rev, page).then(p => alive && setDoc(p.static), e => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [artifact.id, r.rev, page]);
  return <div className="dp-mini" aria-label={`Miniature of revision ${r.rev}`}>
    {error ? <span className="small text-warn">Preview unavailable: {error}</span> : doc === null ? <span className="small muted" role="status">Rendering revision {r.rev}…</span>
      : <div className="dp-mini-frame"><StaticFrame doc={doc} viewport={{ name: 'Desktop', width: MINI_WIDTH, height: 800 }} title={`${artifact.title}: ${page}, revision ${r.rev}, miniature`} /></div>}
    {pages.length > 1 && <div className="dp-mini-pages" role="group" aria-label="Pages">{pages.slice(0, 6).map(p => <button key={p} type="button" aria-pressed={page === p} onClick={() => setPage(p)}>{p.replace(/\.html$/, '')}</button>)}</div>}
  </div>;
}
