// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The Designer's start screen: one sentence starts a design. The agent proposes screens on the
// canvas; starters and recent designs are one click away. Nothing here asks for a brief form.
import { useEffect, useState } from 'react';
import { DESIGN_STARTERS, type ControlState, type DesignStarter } from '@acc/core';
import { ErrorLine, useAction } from '../../common';
import { api, post } from '../../../lib/api';
import { Icon } from '../workspace/DocumentRenderer';
import { designAgents, startAgentJob, titleFromPrompt } from './model';

interface Summary { id: string; name: string; version: number; updatedAt: string; artifactId: string | null; screens: number; firstScreen: string | null }
const STARTERS: Record<DesignStarter, { label: string; art: { columns: string; cells: boolean[] } }> = {
  dashboard: { label: 'Dashboard', art: { columns: '1fr 2fr', cells: [false, true, false, false] } },
  landing: { label: 'Landing page', art: { columns: '1fr', cells: [true, false] } },
  onboarding: { label: 'Onboarding', art: { columns: '1fr 1fr 1fr', cells: [false, true, false] } },
  commerce: { label: 'Commerce', art: { columns: '1fr 1fr', cells: [false, false, true, false] } },
  settings: { label: 'Settings', art: { columns: '1fr 3fr', cells: [true, false] } },
};

export function DesignerHome({ state, onOpen }: { state: ControlState; onOpen: (id: string) => void }) {
  const { busy, error, run } = useAction();
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'new' | 'revise'>('new');
  const [files, setFiles] = useState<string[]>([]);
  const [fileQuery, setFileQuery] = useState(''), [fileHits, setFileHits] = useState<string[]>([]);
  const agents = designAgents(state);
  const [agentId, setAgentId] = useState('');
  const agent = agents.find(a => a.id === agentId) ?? agents[0] ?? null;
  const [recent, setRecent] = useState<Summary[] | null>(null), [listError, setListError] = useState('');
  useEffect(() => { let alive = true; void api<{ documents: Summary[] }>('/api/designer/documents').then(r => alive && setRecent(r.documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))).catch(e => alive && setListError((e as Error).message)); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (mode !== 'revise') return;
    let alive = true;
    const t = setTimeout(() => { void api<{ files: string[] }>(`/api/designer/repository/files?q=${encodeURIComponent(fileQuery)}`).then(r => alive && setFileHits(r.files.filter(f => !files.includes(f)).slice(0, 12))).catch(() => alive && setFileHits([])); }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [mode, fileQuery, files]);

  const start = () => run(async () => {
    const text = prompt.trim();
    if (!text) throw new Error('Describe what you are designing.');
    const r = await post<{ document: { id: string } }>('/api/designer/documents', { name: titleFromPrompt(text), proposal: { prompt: text } });
    if (agent) await startAgentJob(r.document.id, { agentId: agent.id, request: text, kind: mode === 'revise' ? 'reconstruct' : 'generate', files });
    onOpen(r.document.id);
  });
  const fromStarter = (starter: DesignStarter) => run(async () => {
    const r = await post<{ document: { id: string } }>('/api/designer/documents', { name: STARTERS[starter].label, starter });
    onOpen(r.document.id);
  });
  const contract = state.design ? `v${state.design.version}` : null;

  return <div className="dz-home">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1>What are you designing?</h1>
      <form className="dz-composer" aria-label="New design" onSubmit={e => { e.preventDefault(); void start(); }}>
        <label htmlFor="dz-idea" className="sr-only">Describe the interface</label>
        <textarea id="dz-idea" rows={3} maxLength={6000} value={prompt} disabled={busy} onChange={e => setPrompt(e.target.value)} placeholder="A dashboard where engineers see which release checks failed, why, and re-run one without leaving the page."
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start(); } }} />
        {mode === 'revise' && <div className="dz-files">
          <label className="sr-only" htmlFor="dz-files">Repository files to study</label>
          <input id="dz-files" value={fileQuery} onChange={e => setFileQuery(e.target.value)} placeholder="Find files in the repository to recreate (read-only)" />
          {files.length > 0 && <div className="dz-chips">{files.map(f => <button key={f} type="button" className="dz-chip on" onClick={() => setFiles(files.filter(x => x !== f))}>{f}<Icon name="close" size={11} /></button>)}</div>}
          {fileHits.length > 0 && <div className="list" role="listbox" aria-label="Matching files">{fileHits.map(f => <button key={f} type="button" role="option" aria-selected={false} onClick={() => { setFiles([...files, f].slice(0, 50)); setFileQuery(''); }}>{f}</button>)}</div>}
        </div>}
        <div className="dz-composer-bar">
          <label className="dz-chip"><Icon name="sparkle" size={13} /><span className="sr-only">Design agent</span>
            {agents.length ? <select value={agent?.id ?? ''} onChange={e => setAgentId(e.target.value)}>{agents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select> : <span>No agent yet</span>}
          </label>
          <div className="dz-seg" role="group" aria-label="Mode">
            <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>New prototype</button>
            <button type="button" aria-pressed={mode === 'revise'} onClick={() => setMode('revise')}>Revise existing UI</button>
          </div>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="submit" className="dz-send" disabled={busy || !prompt.trim()}>{agent ? 'Start designing' : 'Start a blank design'}<Icon name="arrow-right" size={15} /></button>
        </div>
      </form>
      <ErrorLine error={error} />
      <p className="dz-home-hint">{contract ? <>Your project design system <b>{contract}</b> applies automatically. </> : 'No project design system yet: the first design proposes one. '}{agent ? `${agent.config.name} proposes screens on the canvas; you keep or discard each one.` : 'Add an agent in agent settings to have screens proposed for you.'}</p>
    </div>

    <section aria-labelledby="dz-starters" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 id="dz-starters" className="dz-eyebrow">Or start from</h2>
      <div className="dz-starters">{DESIGN_STARTERS.map(s => <button key={s} type="button" className="dz-starter" disabled={busy} onClick={() => void fromStarter(s)}>
        <span className="dz-starter-art" aria-hidden="true" style={{ gridTemplateColumns: STARTERS[s].art.columns }}>{STARTERS[s].art.cells.map((hi, i) => <i key={i} className={hi ? 'hi' : ''} />)}</span>
        {STARTERS[s].label}
      </button>)}</div>
    </section>

    <section aria-labelledby="dz-recent" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 id="dz-recent" className="dz-eyebrow">Recent</h2>
      {listError && <ErrorLine error={listError} />}
      {recent === null && !listError && <p className="dz-help" role="status">Loading your designs…</p>}
      {recent && recent.length === 0 && <p className="dz-help">Nothing yet. Describe an interface above or pick a starter.</p>}
      {recent && recent.length > 0 && <div className="dz-recent">{recent.slice(0, 12).map(d => {
        const art = d.artifactId ? state.mocks?.[d.artifactId] : null, rev = art?.revisions.at(-1);
        const approved = rev?.reviews.some(r => r.decision === 'approved') ?? false;
        return <button key={d.id} type="button" onClick={() => onOpen(d.id)}>
          <span className="thumb" aria-hidden="true" /><span className="name"><b>{d.name}</b><span>{d.screens} screen{d.screens === 1 ? '' : 's'} · v{d.version} · {ago(d.updatedAt)}</span></span>
          <span className="dz-pill" data-tone={approved ? 'ok' : rev ? 'accent' : undefined}>{approved ? 'Approved' : rev ? 'Released for review' : 'Draft'}</span>
        </button>;
      })}</div>}
    </section>
  </div>;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}
