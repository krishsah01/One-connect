// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { ErrorLine, useAction } from './common';
interface Source { id: string; name: string; type: string; enabled: boolean; fixture?: boolean }
interface Preview { token: string; issues: { id: string; key: string; title: string; description: string; labels: string[]; imported: boolean }[]; limited: number }
export function ImportIssues({ close }: { close(): void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [done, setDone] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => { void run(async () => { const r = await api<{ sources: Source[] }>('/api/imports/sources'); setSources(r.sources); setSource(r.sources.find(s => s.enabled)?.id ?? ''); }); }, []);
  return <div className="modal-bg"><section className="modal card" role="dialog" aria-modal="true" aria-label="Import issues">
    <div className="card-h"><h2>Import issues</h2><span className="spacer" /><button className="btn sm" onClick={close}>Close</button></div>
    <div className="card-b col">
      <p className="small muted">Preview GitHub or Linear issues, then choose what to bring onto the board. Imports retain a source link. Updates here stay local.</p>
      {!sources.length && <div className="banner">Add GitHub or Linear under <code>import_sources</code> in your project configuration. Connections start disabled.</div>}
      <label>Source<select value={source} onChange={e => { setSource(e.target.value); setPreview(null); setSelected([]); setDone(''); }}><option value="">Choose a source</option>{sources.map(s => <option key={s.id} value={s.id} disabled={!s.enabled}>{s.name} · {s.type}{s.fixture ? ' · offline demo' : ''}{!s.enabled ? ' · disabled' : ''}</option>)}</select></label>
      <label>Search<input value={query} placeholder="Issue title, key or label" onChange={e => setQuery(e.target.value)} /></label>
      <button className="btn" disabled={!source || busy} onClick={() => void run(async () => { setPreview(null); setSelected([]); setDone(''); setPreview(await post<Preview>('/api/imports/preview', { sourceId: source, query })); })}>Preview issues</button>
      {preview && <><div className="row small"><b>{preview.issues.length} matching issues</b><span className="faint">Latest {preview.limited} open issues searched</span><span className="spacer" /><button className="btn sm" onClick={() => setSelected(preview.issues.filter(i => !i.imported).map(i => i.id))}>Select all</button></div>
        <div style={{ maxHeight: 320, overflow: 'auto' }}>{preview.issues.map(i => <label key={i.id} className="row" style={{ padding: 10, borderBottom: '1px solid var(--border)' }}><input type="checkbox" style={{ width: 'auto' }} checked={selected.includes(i.id)} disabled={i.imported} onChange={e => setSelected(e.target.checked ? [...selected, i.id] : selected.filter(x => x !== i.id))} /><div className="col"><span><b>{i.key}</b> {i.title}</span><span className="faint small">{i.imported ? 'Already imported' : i.labels.join(', ')}</span></div></label>)}</div>
        <button className="btn primary" disabled={busy || !selected.length} onClick={() => void run(async () => { const r = await post<{ items: unknown[]; skipped: number }>('/api/imports/commit', { token: preview.token, ids: selected }); setDone(`Imported ${r.items.length}; ${r.skipped} already on the board.`); setSelected([]); setPreview(null); })}>Import {selected.length || ''} selected</button>
      </>}
      {done && <div className="banner tone-ok" role="status">{done}</div>}<ErrorLine error={error} />
    </div></section></div>;
}
