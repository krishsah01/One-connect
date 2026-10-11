// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// One design on a canvas. Screens sit side by side; a floating ask bar talks to the agent; a panel
// appears only when a layer is selected; Review and Design system are sheets. Agent proposals land on
// the canvas next to the screens they change and wait for Keep or Discard.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { applyDesignOperations, designDocumentFindings, mockGate, newDesignNode, type ControlState, type DesignDocument, type DesignScreen } from '@acc/core';
import { api, post } from '../../../lib/api';
import { useAppearance } from '../../../lib/theme';
import { DocumentRenderer, Icon } from '../workspace/DocumentRenderer';
import { useDesignDocument, type ProposalView } from '../workspace/useDesignDocument';
import { AskBar, type AskDraft } from './AskBar';
import { designAgents, designStatus, jobThread, screenOfNode, VIEWPORTS } from './model';
import { ReviewSheet } from './ReviewSheet';
import { SelectionPanel, newId } from './SelectionPanel';
import { SystemSheet } from './SystemSheet';

type Sheet = 'review' | 'system' | null;
const CARD_W = 420;

export function DesignerStudio({ state, id, onBack }: { state: ControlState; id: string; onBack: () => void }) {
  const { record, doc, sync, error, notice, setError, setNotice, apply, undo, redo, reload, mutate } = useDesignDocument(id);
  const [params, setParams] = useSearchParams();
  const sheet = (params.get('sheet') === 'review' || params.get('sheet') === 'system' ? params.get('sheet') : null) as Sheet;
  const setSheet = (s: Sheet) => setParams(p => { const n = new URLSearchParams(p); if (s) n.set('sheet', s); else n.delete('sheet'); return n; }, { replace: true });
  const [selected, setSelected] = useState<string[]>([]);
  const [width, setWidth] = useState<number>(1280);
  const [play, setPlay] = useState(false);
  const [screen, setScreen] = useState('');
  const [renaming, setRenaming] = useState(false);
  const { mode } = useAppearance();
  const dark = mode === 'dark';
  const agents = designAgents(state);
  const [agent, setAgent] = useState('');
  const agentId = agents.some(a => a.id === agent) ? agent : agents[0]?.id ?? '';
  const [draft, setDraft] = useState<AskDraft>({ text: '', kind: 'edit' });
  const [assets, setAssets] = useState<Record<string, string>>({});
  const root = useRef<HTMLDivElement>(null);

  const findings = useMemo(() => (doc ? designDocumentFindings(doc) : []), [doc]);
  const thread = useMemo(() => (record ? jobThread(record, state) : []), [record, state]);
  const artifact = record?.artifactId ? state.mocks?.[record.artifactId] : null, rev = artifact?.revisions.at(-1);
  const released = Boolean(doc && rev?.document && rev.document.version === doc.version);
  const approved = Boolean(released && rev && mockGate(rev, state.design?.hash ?? null).state === 'approved');
  const status = designStatus(thread, findings, approved, released);
  const node = doc && selected.length === 1 ? doc.nodes[selected[0]] ?? null : null;
  useEffect(() => { if (doc && !doc.screens.some(s => s.id === screen)) setScreen(doc.screens[0]?.id ?? ''); }, [doc, screen]);
  useEffect(() => { if (selected.some(k => doc && !doc.nodes[k])) setSelected(s => s.filter(k => doc?.nodes[k])); }, [doc, selected]);
  const assetKey = doc ? Object.values(doc.assets).map(a => a.hash).join(',') : '';
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    void Promise.all(Object.values(doc.assets).map(async a => { const v = await api<{ mime: string; base64: string }>(`/api/designer/assets/${a.hash}/data`); return [a.id, `data:${v.mime};base64,${v.base64}`] as const; }))
      .then(v => { if (alive) setAssets(Object.fromEntries(v)); }, () => undefined);
    return () => { alive = false; };
  }, [doc?.id, assetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (nodeId: string | undefined, screenId?: string) => {
    if (doc && (screenId || nodeId)) setScreen(screenId ?? screenOfNode(doc, nodeId!) ?? screen);
    setSelected(nodeId ? [nodeId] : []);
    if (nodeId) setSheet(null);
  };
  const decide = (p: ProposalView, decision: 'apply' | 'discard') => void mutate(() => post(`/api/designer/documents/${id}/proposals/${p.id}`, { decision, expected: doc?.version, rebase: decision === 'apply' && p.baseVersion !== doc?.version ? true : undefined }));
  const addScreen = () => {
    if (!doc) return;
    const rootNode = newDesignNode(newId('root'), 'frame', 'Screen');
    rootNode.props = { background: 'canvas', color: 'text' }; rootNode.layout = { direction: 'column', gap: 'space-5', padding: 'space-6' };
    const sid = newId('screen');
    if (apply([{ type: 'add-screen', screen: { id: sid, name: `Screen ${doc.screens.length + 1}`, root: rootNode.id, states: ['success', 'empty', 'loading', 'error'] }, root: rootNode }], 'Add screen')) { setScreen(sid); setSelected([rootNode.id]); }
  };
  const keyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? redo() : undo()); }
    else if (meta && e.key.toLowerCase() === 'd' && node) { e.preventDefault(); const copy = newId('copy'); if (apply([{ type: 'duplicate-node', id: node.id, newId: copy }], 'Duplicate')) setSelected([copy]); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && node && !node.locked && doc && !doc.screens.some(s => s.root === node.id)) { e.preventDefault(); if (apply([{ type: 'remove-node', id: node.id }], 'Delete layer')) setSelected([]); }
    else if (e.key === 'Escape') { if (sheet) setSheet(null); else if (selected.length) setSelected([]); else if (play) setPlay(false); }
  };

  if (!doc || !record) return <div className="dz"><div className="dz-notice" role={error ? 'alert' : 'status'}>{error || 'Opening your design…'}<span className="spacer" />{error && <button type="button" className="btn sm" onClick={() => void reload()}>Try again</button>}<button type="button" className="btn sm ghost" onClick={onBack}>Back to designs</button></div></div>;

  const pending = record.proposals.filter(p => p.status === 'pending');
  const panel: ReactNode = sheet === 'review' ? <ReviewSheet doc={doc} record={record} state={state} agentId={agentId} findings={findings} onClose={() => setSheet(null)} onSelect={(n, s) => select(n, s)} onAsk={(text, kind) => { setDraft({ text, kind }); setSheet(null); setTimeout(() => root.current?.querySelector<HTMLTextAreaElement>('#dz-ask')?.focus(), 0); }} mutate={mutate} onNotice={setNotice} />
    : sheet === 'system' ? <SystemSheet doc={doc} apply={apply} state={state} dark={dark} mutate={mutate} onClose={() => setSheet(null)} onNotice={setNotice} />
    : node ? <SelectionPanel key={node.id} doc={doc} node={node} apply={apply} disabled={sync === 'offline'} onClose={() => setSelected([])} onSelect={n => select(n)} /> : null;
  const syncLabel = sync === 'saving' ? 'Saving…' : sync === 'offline' ? 'Offline · edits kept here' : sync === 'error' ? 'Not saved' : 'Saved';

  return <div className="dz" ref={root} onKeyDown={keyDown}>
    <header className="dz-top">
      <button type="button" className="dz-icon-btn" aria-label="Back to designs" onClick={onBack}><Icon name="arrow-left" size={16} /></button>
      {renaming ? <form className="name" onSubmit={e => { e.preventDefault(); const v = new FormData(e.currentTarget).get('name'); if (typeof v === 'string' && v.trim() && v.trim() !== doc.name) apply([{ type: 'rename', name: v.trim() }], 'Rename design'); setRenaming(false); }}>
        <input name="name" aria-label="Design name" defaultValue={doc.name} autoFocus maxLength={150} onBlur={e => e.currentTarget.form?.requestSubmit()} onKeyDown={e => { if (e.key === 'Escape') setRenaming(false); }} /></form>
        : <button type="button" className="name" title="Rename" onClick={() => setRenaming(true)}>{doc.name}</button>}
      <span className="dz-pill" data-tone={status === 'Approved' ? 'ok' : status === 'Needs you' || status === 'Needs attention' ? 'warn' : status === 'Agent working' ? 'accent' : undefined}>{status === 'Agent working' && <i aria-hidden="true" />}{status}</span>
      <span className="sync" role="status">{syncLabel}</span>
      <span className="spacer" />
      <button type="button" className="dz-icon-btn" aria-label={`Undo${record.undo.label ? ` ${record.undo.label}` : ''}`} title="Undo (⌘Z)" disabled={!record.undo.count} onClick={() => void undo()}><Icon name="arrow-left" size={15} /></button>
      <button type="button" className="dz-icon-btn" aria-label={`Redo${record.redo.label ? ` ${record.redo.label}` : ''}`} title="Redo (⇧⌘Z)" disabled={!record.redo.count} onClick={() => void redo()}><Icon name="arrow-right" size={15} /></button>
      <div className="dz-seg" role="group" aria-label="Viewport">{VIEWPORTS.map(v => <button key={v.width} type="button" aria-pressed={width === v.width} onClick={() => setWidth(v.width)}>{v.label}</button>)}</div>
      <button type="button" className={`btn sm${play ? ' primary' : ''}`} aria-pressed={play} onClick={() => setPlay(v => !v)}>{play ? 'Stop playing' : 'Play'}</button>
      <button type="button" className="btn sm" aria-pressed={sheet === 'system'} onClick={() => setSheet(sheet === 'system' ? null : 'system')}>Design system{state.design ? ` · v${state.design.version}` : ''}</button>
      <button type="button" className="btn sm primary" aria-pressed={sheet === 'review'} onClick={() => setSheet(sheet === 'review' ? null : 'review')}>Review{findings.some(f => f.severity === 'error') ? ` · ${findings.filter(f => f.severity === 'error').length}` : ''}</button>
    </header>
    {(error || notice) && <div className="dz-notice" role={error ? 'alert' : 'status'}>{error || notice}<span className="spacer" />{error && <button type="button" className="btn sm" onClick={() => void reload()}>Reload</button>}<button type="button" className="dz-icon-btn" aria-label="Dismiss" onClick={() => { setError(''); setNotice(''); }}><Icon name="close" size={13} /></button></div>}
    <div className="dz-body">
      <main className="dz-canvas" aria-label="Canvas">
        {play ? <PlayView doc={doc} screen={screen} width={width} dark={dark} assets={assets} onScreen={setScreen} />
          : <div className="dz-canvas-scroll" onPointerDown={e => { if (e.target === e.currentTarget) setSelected([]); }}>
            {doc.screens.length === 0 && <div className="dz-empty-canvas"><b>No screens yet</b><span>Ask the agent for the first screen below, or add one.</span></div>}
            {doc.screens.map(s => <ScreenCard key={s.id} doc={doc} screen={s} width={width} dark={dark} assets={assets} selected={selected} active={screen === s.id} findings={findings.filter(f => f.screenId === s.id || (f.nodeId && screenOfNode(doc, f.nodeId) === s.id)).length}
              onSelect={(nid, mods) => { setScreen(s.id); setSelected(mods.shift || mods.meta ? (selected.includes(nid) ? selected.filter(k => k !== nid) : [...selected, nid]) : [nid]); if (sheet) setSheet(null); }}
              onText={(nid, text, instance) => apply(instance ? [{ type: 'update-node', id: instance, patch: { props: { overrides: { ...doc.nodes[instance]?.props.overrides, [nid]: { ...doc.nodes[instance]?.props.overrides?.[nid], text } } } } }] : [{ type: 'update-node', id: nid, patch: { props: { text } } }], `Edit ${doc.nodes[nid]?.name ?? 'text'}`)}
              onTitle={() => { setScreen(s.id); setSelected([s.root]); if (sheet) setSheet(null); }} onFindings={() => setSheet('review')} onPlay={() => { setScreen(s.id); setPlay(true); }} />)}
            {pending.map(p => <ProposalCard key={p.id} doc={doc} proposal={p} width={width} dark={dark} assets={assets} onDecide={decide} />)}
            <button type="button" className="dz-add-screen" onClick={addScreen}><Icon name="plus" size={16} />Add screen</button>
          </div>}
        <AskBar doc={doc} record={record} state={state} agents={agents} agentId={agentId} onAgent={setAgent} selected={selected} onClearSelection={() => setSelected([])} draft={draft} onDraft={setDraft} mutate={mutate} onNotice={setNotice} onProposal={decide} />
      </main>
      {panel}
    </div>
  </div>;
}

function ScreenCard({ doc, screen: s, width, dark, assets, selected, active, findings, onSelect, onText, onTitle, onFindings, onPlay }: {
  doc: DesignDocument; screen: DesignScreen; width: number; dark: boolean; assets: Record<string, string>; selected: string[]; active: boolean; findings: number;
  onSelect: (id: string, mods: { shift: boolean; meta: boolean }) => void; onText: (id: string, text: string, instance?: string) => void; onTitle: () => void; onFindings: () => void; onPlay: () => void;
}) {
  const zoom = Math.min(1, CARD_W / width);
  return <section className="dz-screen" aria-label={`${s.name} screen`} style={{ '--card-w': `${Math.round(width * zoom)}px` } as React.CSSProperties}>
    <div className="dz-screen-head">
      <button type="button" className="title" aria-pressed={active && selected.includes(s.root)} onClick={onTitle}>{s.name}</button>
      <span>{s.kind === 'dialog' ? 'dialog' : s.kind === 'drawer' ? 'drawer' : width}</span>
      <span className="spacer" />
      {findings > 0 && <button type="button" className="count" onClick={onFindings}><Icon name="warning" size={12} />{findings} finding{findings === 1 ? '' : 's'}</button>}
      <button type="button" className="dz-icon-btn" style={{ width: 24, height: 24 }} aria-label={`Play from ${s.name}`} onClick={onPlay}><Icon name="arrow-right" size={13} /></button>
    </div>
    <div className={`dz-frame${s.kind === 'dialog' || s.kind === 'drawer' ? ' dialog' : ''}`}>
      <div className="dz-frame-inner" style={{ zoom, width }}>
        <DocumentRenderer document={doc} screenId={s.id} width={width} dark={dark} editing selected={selected} onSelect={onSelect} onText={onText} assetUrl={id => assets[id]} />
      </div>
    </div>
  </section>;
}

function ProposalCard({ doc, proposal: p, width, dark, assets, onDecide }: { doc: DesignDocument; proposal: ProposalView; width: number; dark: boolean; assets: Record<string, string>; onDecide: (p: ProposalView, d: 'apply' | 'discard') => void }) {
  const preview = useMemo(() => { try { return applyDesignOperations(doc, p.operations); } catch { return null; } }, [doc, p]);
  const stale = p.baseVersion !== doc.version;
  const screens = preview ? (p.screens.length ? preview.screens.filter(s => p.screens.includes(s.id)) : preview.screens.filter(s => !doc.screens.some(x => x.id === s.id))).slice(0, 3) : [];
  const zoom = Math.min(1, CARD_W / width);
  const who = p.kind === 'conflict' ? 'Your earlier edit' : p.kind === 'library' ? 'Kit update' : p.kind === 'repair' ? 'Repair' : p.by.type === 'human' ? 'You' : p.by.id;
  return <section className="dz-screen" aria-label={`Proposed: ${p.summary}`} style={{ '--card-w': `${Math.round(width * zoom)}px` } as React.CSSProperties}>
    <div className="dz-screen-head"><span className="dz-pill" data-tone="accent"><Icon name="sparkle" size={11} />Proposed</span><b style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.summary}</b></div>
    {preview && screens.length > 0 ? screens.map(s => <div key={s.id} className="dz-frame proposed"><div className="dz-frame-inner" style={{ zoom, width }}><DocumentRenderer document={preview} screenId={s.id} width={width} dark={dark} editing assetUrl={id => assets[id]} /></div></div>)
      : <div className="dz-frame proposed" style={{ padding: 16, fontSize: 12.5, color: 'var(--text-2)' }}>{preview ? <>Changes: {p.changes.slice(0, 6).join(' · ') || 'tokens, components or settings'}</> : stale ? 'This proposal was made on an older version. Keep re-applies it on the current one.' : 'This proposal cannot be previewed.'}</div>}
    <div className="dz-proposal-actions">
      <button type="button" className="btn sm primary" onClick={() => onDecide(p, 'apply')}>Keep</button>
      <button type="button" className="btn sm" onClick={() => onDecide(p, 'discard')}>Discard</button>
      <span>{who}{stale ? ' · from an older version' : ''}{p.changes.length ? ` · ${p.changes.length} change${p.changes.length === 1 ? '' : 's'}` : ''}</span>
    </div>
  </section>;
}

function PlayView({ doc, screen, width, dark, assets, onScreen }: { doc: DesignDocument; screen: string; width: number; dark: boolean; assets: Record<string, string>; onScreen: (id: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const el = wrap.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setFit(Math.min(1, Math.max(0.2, (el.clientWidth - 48) / width)));
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  const pages = doc.screens.filter(s => s.kind !== 'dialog' && s.kind !== 'drawer');
  return <div className="dz-canvas-scroll play" ref={wrap}>
    <div className="dz-play">
      <div className="dz-play-bar"><span>Playing</span><label className="sr-only" htmlFor="dz-play-screen">Screen</label>
        <select id="dz-play-screen" value={screen} onChange={e => onScreen(e.target.value)} style={{ height: 28, fontSize: 12 }}>{pages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <span>· {width} px · links and forms work; nothing is saved from here</span></div>
      <div className="dz-play-stage" style={{ width: Math.round(width * fit) }}><div style={{ zoom: fit, width }}>
        <DocumentRenderer document={doc} screenId={screen} width={width} dark={dark} assetUrl={id => assets[id]} onNavigate={onScreen} />
      </div></div>
    </div>
  </div>;
}
