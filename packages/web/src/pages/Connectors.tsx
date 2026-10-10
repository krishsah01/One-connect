// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { RELEASE_CONNECTOR_DEFAULTS, isReleaseConnector } from '@acc/core';
import { type Connector, type ConnectorAction, type ConnectorConfig, type ConnectorDescriptor, type ConnectorKind, type ControlState, type Decision, type WorkItem } from '@acc/core';
import { Badge, ErrorLine, useAction, useTick } from '../components/common';
import { api, post } from '../lib/api';
import type { Tone } from '../lib/format';
import { DecisionCard } from './Decisions';

export type View = Connector & { state: 'draft' | 'pending' | 'active' | 'disabled'; bindingCurrent?: boolean; readCurrent?: boolean; descriptor: ConnectorDescriptor; actions: (ConnectorDescriptor['actions'][number] & { allowed: boolean; pending: boolean })[] };
export interface Listing { defaults?: Partial<Record<ConnectorKind, ConnectorConfig>>; descriptors: ConnectorDescriptor[]; connections: View[]; decisions: Decision[] }
interface PreviewIssue { id: string; key?: string | null; title: string; description: string; url?: string | null; labels: string[]; acceptance: string[]; contentHash: string; imported: boolean; untrusted: true }
interface Preview { token: string; issues: PreviewIssue[]; page?: number; pageSize?: number; total?: number; hasMore?: boolean; outOfRange?: boolean; expiresAt?: string; snapshotHash?: string }
interface ToolRequest { id: string; connectorId: string; configHash: string; tool: string; status: 'pending' | 'running' | 'succeeded' | 'error' | 'uncertain' | 'denied'; decisionId: string | null; result: { text: string; isError: boolean; truncated: boolean } | null; error: string | null }
const TOOL_STATUS_TONE: Record<ToolRequest['status'], Tone> = { pending: 'warn', running: 'warn', succeeded: 'ok', error: 'crit', uncertain: 'warn', denied: 'idle' };

const STATE_TONE: Record<View['state'], Tone> = { draft: 'idle', pending: 'warn', active: 'ok', disabled: 'idle' };
const AVAIL: Record<Connector['availability']['status'], [Tone, string]> = { not_checked: ['idle', 'not checked'], available: ['ok', 'available'], missing_credential: ['warn', 'no key'], offline: ['crit', 'offline'], error: ['crit', 'error'] };
const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);
const blank = (kind: ConnectorKind): ConnectorConfig => {
  switch (kind) {
    case 'github': case 'gitlab': case 'vercel': case 'supabase': return structuredClone(RELEASE_CONNECTOR_DEFAULTS[kind]);
    case 'github-issues': return { kind, repo: '', labels: [] };
    case 'linear': return { kind, team: '' };
    case 'obsidian': return { kind, vault: '', folders: [] };
    case 'docker': return { kind };
    case 'mcp': return { kind, command: '', args: [], tools: [], read_roots: [] };
  }
};

export function Connectors({ state }: { state: ControlState }) {
  const now = useTick();
  const { busy, error, run } = useAction();
  const [list, setList] = useState<Listing | null>(null), [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; config: ConnectorConfig; expected: string | null; isNew: boolean } | null>(null);
  const mounted = useRef(true), loadGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; loadGeneration.current += 1; };
  }, []);
  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const value = await api<Listing>('/api/connectors');
      if (!mounted.current || generation !== loadGeneration.current) return;
      setList(value); setLoadError('');
    } catch (e) {
      if (mounted.current && generation === loadGeneration.current) setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => { void reload(); }, [state.seq, reload]);
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); if (mounted.current) await reload(); });

  return <div className="page connected-page connectors-page">
    <div className="page-heading"><div><div className="eyebrow">Per-project connections</div><h1>Connectors</h1><p>Connect release checks, issues, notes, containers and tools to {state.project?.name ?? 'this project'} only. Saving a connection contacts nothing. <Link to="/settings">Settings & policies</Link> sets project targets; read permissions need a separate Decision.</p></div></div>
    {loadError && <ErrorLine error={`Could not load connectors: ${loadError}`} />}
    <ErrorLine error={error} />
    {list?.decisions.length ? <section className="col" aria-label="Approval requests"><h2>Waiting for your decision</h2>{list.decisions.map(d => <DecisionCard key={d.id} d={d} state={state} now={now} />)}</section> : null}
    {!list && !loadError ? <div className="empty" role="status">Loading connectors…</div> : list && <>
      <section className="col" aria-label="Connections">
        {list.connections.length === 0 && <p className="empty">No connections in this project yet. Set repository, infrastructure projects, hosts and scopes in <Link to="/settings">Settings & policies</Link>, then add a connection below and approve its read in <Link to="/decisions">Decisions</Link>.</p>}
        {list.connections.map(c => <ConnectionCard key={`${c.id}:${c.configHash}:${c.disabled}:${c.approvals.execute?.decisionId ?? ''}`} c={c} busy={busy} act={act} run={run} onEdit={() => setEditing({ id: c.id, name: c.name, config: c.config, expected: c.configHash, isNew: false })} />)}
      </section>
      {editing ? <ConnectionForm key={editing.id || editing.config.kind} initial={editing} busy={busy} onCancel={() => setEditing(null)} onSave={(body) => act(async () => { await post(`/api/connectors/${body.id}`, { connection: { id: body.id, name: body.name, config: body.config }, expected: body.expected }); setEditing(null); })} /> :
        <section className="col" aria-label="Add a connection"><h2>Add a connection</h2><div className="connector-grid">{list.descriptors.map(d => <article key={d.kind} className="card card-b col connector-tile">
          <h3>{d.title}</h3><p className="small muted">{d.summary}</p>
          <dl className="small connector-facts"><dt>Needs</dt><dd>{d.credential.type === 'secret' ? `A stored ${d.credential.name} token` : d.credential.type === 'cli-login' ? `Your ${d.credential.tool} CLI login` : 'Nothing'}</dd><dt>Cost</dt><dd><Badge tone={d.cost.kind === 'unknown' ? 'warn' : 'ok'}>{d.cost.kind}</Badge> {d.cost.note}</dd><dt>Network</dt><dd>{d.egress}</dd><dt>Permissions</dt><dd>{d.actions.map(a => `${a.label}${a.writes ? ' (writes)' : ''}`).join('; ')}</dd></dl>
          <div className="row wrap">{d.links?.map(link => link.href.startsWith('/') ? <Link key={link.href} to={link.href} className="small">{link.label}</Link> : <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="small">{link.label}</a>)}</div>
          <button className="btn" onClick={() => setEditing({ id: '', name: '', config: list.defaults?.[d.kind] ?? blank(d.kind), expected: null, isNew: true })}>Add {d.title}</button>
        </article>)}</div></section>}
    </>}
    <p className="small faint">Keys live in the existing key store under <Link to="/setup">Agents & connections</Link>; they are never shown or saved in a connection. Imported issue text and tool output are treated as untrusted data and never run as instructions.</p>
  </div>;
}

function ConnectionCard({ c, busy, act, run, onEdit }: { c: View; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<unknown>; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; onEdit: () => void }) {
  const [tone, label] = AVAIL[c.availability.status];
  const [preview, setPreview] = useState<Preview | null>(null), [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({}), [imported, setImported] = useState('');
  const [containers, setContainers] = useState<{ available: boolean; containers: { ID: string; Names: string; State: string; Status: string; Image: string }[]; error?: string } | null>(null);
  const [tool, setTool] = useState(c.config.kind === 'mcp' ? c.config.tools[0] ?? '' : ''), [toolArgs, setToolArgs] = useState('{}');
  const [toolReq, setToolReq] = useState<ToolRequest | null>(null), [toolReqError, setToolReqError] = useState('');
  const [toolBoundArgs, setToolBoundArgs] = useState<string | null>(null);
  const [toolGeneration, setToolGeneration] = useState(0);
  const [argsChangedSinceRequest, setArgsChangedSinceRequest] = useState(false);
  const toolGenRef = useRef(0);
  const activeRequestRef = useRef<string | null>(null);
  const pollInFlight = useRef<{ requestId: string; generation: number } | null>(null);
  const bumpToolGeneration = useCallback(() => {
    const next = ++toolGenRef.current;
    setToolGeneration(next);
    activeRequestRef.current = null;
    pollInFlight.current = null;
    setToolReq(null);
    setToolBoundArgs(null);
    setToolReqError('');
    setArgsChangedSinceRequest(false);
  }, []);
  useEffect(() => () => { toolGenRef.current += 1; activeRequestRef.current = null; }, []);
  const refreshToolReq = useCallback(async (requestId: string, generation: number) => {
    if (generation !== toolGenRef.current) return;
    if (activeRequestRef.current !== requestId) return;
    if (pollInFlight.current?.requestId === requestId && pollInFlight.current.generation === generation) return;
    const ownedPoll = { requestId, generation };
    pollInFlight.current = ownedPoll;
    try {
      const r = await api<{ request: ToolRequest }>(`/api/connectors/tool-requests/${encodeURIComponent(requestId)}`);
      if (generation !== toolGenRef.current || activeRequestRef.current !== requestId) return;
      if (r.request.id !== requestId || r.request.configHash !== c.configHash || r.request.connectorId !== c.id || r.request.tool !== tool) {
        setToolReqError('Poll response does not match the current selection.');
        return;
      }
      setToolReq(r.request);
      setToolReqError('');
    } catch (e) {
      if (generation === toolGenRef.current && activeRequestRef.current === requestId) setToolReqError((e as Error).message);
    } finally {
      if (pollInFlight.current === ownedPoll) pollInFlight.current = null;
    }
  }, [c.id, c.configHash, tool]);
  useEffect(() => {
    if (!toolReq || ['succeeded', 'error', 'denied', 'uncertain'].includes(toolReq.status)) return;
    const requestId = toolReq.id;
    const generation = toolGeneration;
    const t = window.setInterval(() => { void refreshToolReq(requestId, generation); }, 1500);
    return () => window.clearInterval(t);
  }, [toolReq?.id, toolReq?.status, toolGeneration, refreshToolReq]);
  const showToolResult = Boolean(toolReq && toolBoundArgs !== null && toolBoundArgs === toolArgs);
  const allowed = (a: ConnectorAction) => c.actions.find(x => x.id === a)?.allowed;
  return <article className="card card-b col connection-card" aria-label={c.name}>
    <div className="row wrap"><h2>{c.name}</h2><span className="small faint">{c.descriptor.title} · {c.id}</span><span className="spacer" /><Badge tone={STATE_TONE[c.state]}>{c.state}</Badge><Badge tone={tone} title={c.availability.detail}>{label}</Badge><Badge tone={c.descriptor.cost.kind === 'unknown' ? 'warn' : 'ok'} title={c.descriptor.cost.note}>cost: {c.descriptor.cost.kind}</Badge></div>
    <p className="small muted">{c.availability.detail}{c.availability.checkedAt ? ` · checked ${new Date(c.availability.checkedAt).toLocaleString()}` : ''}</p>
    {isReleaseConnector(c.config) && <div className="col small">
      <p>Target: {c.config.kind === 'github' ? c.config.repo : c.config.kind === 'supabase' ? c.config.project_ref : c.config.project} · HTTPS host: {c.config.host}</p>
      <p>Reviewed scopes: {c.config.scopes.join(', ')} · Capabilities: {c.config.capabilities.join(', ')}</p>
      <p>Bound to {c.config.binding?.projectName ?? 'this project'} · production branch {c.config.binding?.productionBranch ?? 'unknown'}. Token grants and reachability remain unknown until a read.</p>
      {c.bindingCurrent === false && <p className="text-warn" role="status">Project settings changed. Edit and save matching settings, then request a new Decision.</p>}
      <div className="row wrap"><Link to="/settings">Settings & policies</Link><Link to="/decisions">Review Decisions</Link><Link to="/release">Release cockpit</Link>
        <button className="btn sm" disabled={busy || !allowed('read')} onClick={() => void act(() => post(`/api/connectors/${c.id}/read`, {}))}>Read now</button>
      </div>
    </div>}
    <ul className="small connector-actions">{c.actions.map(a => <li key={a.id} className="row wrap"><span className="grow">{a.label}{a.outbound ? <span className="faint"> · contacts {a.outbound}</span> : <span className="faint"> · local only</span>}</span>{a.allowed ? <Badge tone="ok">approved</Badge> : a.pending ? <Badge tone="warn">waiting for decision</Badge> : <button className="btn sm" disabled={busy || c.disabled || c.bindingCurrent === false} onClick={() => void act(() => post(`/api/connectors/${c.id}/activate`, { action: a.id }))}>Request approval</button>}</li>)}</ul>
    <div className="row wrap"><button className="btn sm" disabled={busy || c.disabled} onClick={() => void act(() => post(`/api/connectors/${c.id}/check`))}>Check locally</button><button className="btn sm" disabled={busy} onClick={onEdit}>Edit</button><button className="btn sm" disabled={busy} onClick={() => void act(() => post(`/api/connectors/${c.id}/disable`, { disabled: !c.disabled }))}>{c.disabled ? 'Enable as draft' : 'Disable'}</button><span className="small faint">Editing settings voids earlier approvals.</span></div>
    {(c.kind === 'linear' || c.kind === 'github-issues') && allowed('import') && <div className="col connector-import">
      <form className="row" onSubmit={e => { e.preventDefault(); void run(async () => { setImported(''); const p = await post<Preview>(`/api/connectors/${c.id}/preview`, { query, page: 1, pageSize: 1 }); setPreview(p); setPicked({}); }); }}><input aria-label="Filter issues" value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter by key, title or label" /><button className="btn sm" disabled={busy}>Preview issues</button></form>
      {preview && (preview.issues.length === 0 && !preview.outOfRange ? <p className="small muted">No open issues matched.</p> : <form className="col" onSubmit={e => { e.preventDefault(); void run(async () => { const r = await post<{ items: WorkItem[]; skipped: number; mirror?: boolean; unsupported?: string[] }>('/api/connectors/import', { token: preview.token, selections: Object.entries(picked).map(([id, text]) => ({ id, acceptance: lines(text) })) }); const extra = [r.mirror ? 'Local mirrors only; the authoritative tracker was not written.' : '', ...(r.unsupported ?? [])].filter(Boolean).join(' '); setImported(`Imported ${r.items.length} issue${r.items.length === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} already imported` : ''}.${extra ? ` ${extra}` : ''}`); setPreview(null); setPicked({}); }); }}>
        {preview.total !== undefined && <p className="small muted">Showing {preview.issues.length} of {preview.total} open issues{preview.page && preview.page > 1 ? ` (page ${preview.page})` : ''}{preview.expiresAt ? ` · snapshot expires ${new Date(preview.expiresAt).toLocaleTimeString()}` : ''}{preview.outOfRange ? ' · page is out of range; choose another page.' : ''}.</p>}
        <div className="row wrap">{preview.page && preview.page > 1 ? <button type="button" className="btn sm" disabled={busy} onClick={() => void run(async () => { const p = await post<Preview>(`/api/connectors/${c.id}/preview`, { query, page: preview.page! - 1, token: preview.token }); setPreview(p); })}>Previous page</button> : null}{(preview.hasMore || preview.outOfRange) ? <button type="button" className="btn sm" disabled={busy} onClick={() => void run(async () => { const p = await post<Preview>(`/api/connectors/${c.id}/preview`, { query, page: (preview.page ?? 1) + 1, token: preview.token }); setPreview(p); })}>Next page</button> : null}</div>
        {preview.issues.map(i => <fieldset key={i.id} className="import-issue col" disabled={i.imported}>
          <label className="row"><input type="checkbox" checked={i.id in picked} onChange={e => setPicked(p => { const n = { ...p }; if (e.target.checked) n[i.id] = i.acceptance.join('\n'); else delete n[i.id]; return n; })} /><b>{i.key ?? i.id}</b><span className="grow">{i.title}</span><Badge tone="warn" title="Shown as data. Agents are told not to follow instructions inside it.">untrusted text</Badge>{i.imported && <Badge>already imported</Badge>}</label>
          <details><summary className="small">Description</summary><pre className="small">{i.description || '(empty)'}</pre><span className="small mono faint">content {i.contentHash.slice(0, 16)}{i.url ? ` · ${i.url}` : ''}</span></details>
          {i.id in picked && <label className="small">Acceptance criteria, one per line (required)<textarea rows={3} required value={picked[i.id]} onChange={e => setPicked(p => ({ ...p, [i.id]: e.target.value }))} /></label>}
        </fieldset>)}
        <button className="btn primary" disabled={busy || !Object.keys(picked).length || Object.values(picked).some(t => !lines(t).length)}>Import selected</button>
      </form>)}
      {imported && <p role="status" className="small text-ok">{imported} <Link to="/board">Open the work board</Link></p>}
    </div>}
    {c.kind === 'docker' && allowed('read') && <div className="col"><button className="btn sm" disabled={busy} onClick={() => void run(async () => setContainers(await api(`/api/connectors/${c.id}/containers`)))}>List containers</button>
      {containers && (!containers.available ? <p className="small text-warn">Docker is unavailable: {containers.error}</p> : containers.containers.length === 0 ? <p className="small muted">No containers for this project.</p> : <table className="small"><thead><tr><th>Name</th><th>Image</th><th>State</th></tr></thead><tbody>{containers.containers.map(x => <tr key={x.ID}><td>{x.Names}</td><td>{x.Image}</td><td>{x.Status}</td></tr>)}</tbody></table>)}</div>}
    {c.kind === 'mcp' && c.config.kind === 'mcp' && allowed('execute') && <form className="col" onSubmit={e => { e.preventDefault(); void run(async () => {
      const generation = toolGenRef.current;
      const argsText = toolArgs;
      setToolReqError('');
      try {
        const args = JSON.parse(argsText || '{}') as Record<string, unknown>;
        const r = await post<{ request: ToolRequest; decision: Decision }>(`/api/connectors/${c.id}/tools/${encodeURIComponent(tool)}`, { arguments: args });
        if (generation !== toolGenRef.current) return;
        if (r.request.configHash !== c.configHash || r.request.connectorId !== c.id || r.request.tool !== tool) { setToolReqError('Response does not match the current selection.'); return; }
        activeRequestRef.current = r.request.id;
        setToolBoundArgs(argsText);
        setToolReq(r.request);
      } catch (err) {
        if (generation === toolGenRef.current) setToolReqError((err as Error).message);
      }
    }); }}>
      <div className="row wrap"><select aria-label="Tool" value={tool} onChange={e => { setTool(e.target.value); bumpToolGeneration(); }}>{c.config.tools.map(t => <option key={t}>{t}</option>)}</select><input aria-label="Arguments (JSON)" className="mono grow" value={toolArgs} onChange={e => { setToolArgs(e.target.value); bumpToolGeneration(); setArgsChangedSinceRequest(Boolean(toolReq)); }} /><button className="btn sm" disabled={busy || !tool || (toolReq?.status === 'pending' || toolReq?.status === 'running')}>Request action</button></div>
      {toolReqError && <p className="small text-warn" role="alert">{toolReqError}</p>}
      {toolReq && showToolResult && <div className="col small" aria-live="polite">
        <div className="row wrap"><Badge tone={TOOL_STATUS_TONE[toolReq.status]}>{toolReq.status}</Badge><span className="faint mono">request {toolReq.id.slice(0, 12)}</span>{toolReq.decisionId && <Link to="/decisions">Review in Decisions</Link>}</div>
        {toolReq.status === 'pending' && <p className="muted">Nothing runs until you approve the exact arguments in <Link to="/decisions">Decisions</Link>.</p>}
        {toolReq.status === 'running' && <p className="muted">Running the approved command once with a minimal environment…</p>}
        {toolReq.status === 'uncertain' && <p className="text-warn">Outcome is uncertain (timeout or interruption). Inspect manually; reopening this result does not resubmit.</p>}
        {toolReq.error && <p className="text-warn">{toolReq.error}</p>}
        {toolReq.result && <pre className="small" aria-label="Tool output">{`${toolReq.result.isError ? '[tool reported an error]\n' : ''}${toolReq.result.text}${toolReq.result.truncated ? '\n…truncated' : ''}`}</pre>}
      </div>}
      {argsChangedSinceRequest && <p className="small muted" role="status">Arguments changed since this request. Request again to review the new values.</p>}
      <span className="small faint">Inventory approval makes tools eligible only. Each call creates a Decision for the exact arguments; the command starts once after you approve.</span>
    </form>}
  </article>;
}

function ConnectionForm({ initial, busy, onCancel, onSave }: { initial: { id: string; name: string; config: ConnectorConfig; expected: string | null; isNew: boolean }; busy: boolean; onCancel: () => void; onSave: (b: { id: string; name: string; config: ConnectorConfig; expected: string | null }) => void }) {
  const [id, setId] = useState(initial.id), [name, setName] = useState(initial.name), [config, setConfig] = useState<ConnectorConfig>(initial.config);
  const [text, setText] = useState(() => { const c = initial.config; return c.kind === 'obsidian' ? { a: c.folders.join('\n'), b: '', t: '' } : c.kind === 'mcp' ? { a: c.args.join('\n'), b: c.read_roots.join('\n'), t: c.tools.join(', ') } : c.kind === 'github-issues' ? { a: '', b: '', t: c.labels.join(', ') } : { a: '', b: '', t: '' }; });
  const [scopes, setScopes] = useState(isReleaseConnector(initial.config) ? initial.config.scopes.join(', ') : '');
  const patch = (p: Partial<ConnectorConfig>) => setConfig(c => ({ ...c, ...p }) as ConnectorConfig);
  const final = (): ConnectorConfig => isReleaseConnector(config) ? { ...config, scopes: scopes.split(',').map(s => s.trim()).filter(Boolean) } : config.kind === 'obsidian' ? { ...config, folders: lines(text.a) } : config.kind === 'mcp' ? { ...config, args: lines(text.a), read_roots: lines(text.b), tools: text.t.split(',').map(x => x.trim()).filter(Boolean) } : config.kind === 'github-issues' ? { ...config, labels: text.t.split(',').map(x => x.trim()).filter(Boolean) } : config;
  return <form className="card" aria-label="Connection settings" onSubmit={e => { e.preventDefault(); onSave({ id: id.trim(), name: name.trim(), config: final(), expected: initial.expected }); }}>
    <fieldset className="card-b col" disabled={busy} style={{ border: 0, gap: 14 }}>
      <h2>{initial.isNew ? 'New' : 'Edit'} {config.kind} connection</h2>
      <div className="builder-fields"><label>Connection ID<input required pattern="[a-z0-9][a-z0-9-]{1,47}" disabled={!initial.isNew} value={id} onChange={e => setId(e.target.value)} placeholder="team-issues" /></label><label>Name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label></div>
      {isReleaseConnector(config) && <>
        <p className="small muted">Uses this project’s current settings. Saving binds this draft to them; changes to the host, scopes, capabilities or project require a new human Decision. <Link to="/settings">Edit project settings</Link></p>
        <div className="builder-fields">
          <label>API host<input required value={config.host} onChange={e => patch({ host: e.target.value })} placeholder="api.github.com" /></label>
          <label>Reviewed token scopes<input required value={scopes} onChange={e => setScopes(e.target.value)} placeholder="Comma-separated" /></label>
          {config.kind === 'github' && <label>Repository<input required value={config.repo} onChange={e => patch({ repo: e.target.value })} placeholder="owner/name" /></label>}
          {(config.kind === 'gitlab' || config.kind === 'vercel') && <label>Provider project<input required value={config.project} onChange={e => patch({ project: e.target.value })} placeholder={config.kind === 'gitlab' ? 'group/project or numeric ID' : 'Vercel project ID'} /></label>}
          {config.kind === 'supabase' && <><label>Project reference<input required value={config.project_ref} onChange={e => patch({ project_ref: e.target.value })} /></label><label>Migrations folder<input required value={config.migrations_dir} onChange={e => patch({ migrations_dir: e.target.value })} /></label></>}
        </div>
        <fieldset className="col"><legend>Read capabilities</legend>{RELEASE_CONNECTOR_DEFAULTS[config.kind].capabilities.map(capability => <label key={capability} className="row small"><input type="checkbox" checked={config.capabilities.includes(capability)} onChange={e => patch({ capabilities: e.target.checked ? [...config.capabilities, capability] : config.capabilities.filter(c => c !== capability) })} />{capability}</label>)}</fieldset>
        <p className="small faint">Scopes are reviewed permissions, not verification of the stored token. Activation does not probe the provider. Only Read now makes a live read.</p>
      </>}
      {config.kind === 'github-issues' && <div className="builder-fields"><label>Repository<input required pattern="[\w.\-]+/[\w.\-]+" value={config.repo} onChange={e => patch({ repo: e.target.value })} placeholder="owner/name" /></label><label>Only with labels<input value={text.t} onChange={e => setText({ ...text, t: e.target.value })} placeholder="Optional, comma-separated" /></label></div>}
      {config.kind === 'linear' && <div className="builder-fields"><label>Team key<input required maxLength={60} value={config.team} onChange={e => patch({ team: e.target.value })} placeholder="ENG" /></label><label>Project<input maxLength={120} value={config.project ?? ''} onChange={e => patch({ project: e.target.value || undefined })} placeholder="Optional" /></label></div>}
      {config.kind === 'obsidian' && <div className="builder-fields"><label>Vault folder<input required value={config.vault} onChange={e => patch({ vault: e.target.value })} placeholder="/Users/you/Notes" /></label><label>Folders agents may read, one per line<textarea rows={3} required value={text.a} onChange={e => setText({ ...text, a: e.target.value })} placeholder="Projects/this-project" /></label></div>}
      {config.kind === 'docker' && <p className="small muted">Uses this project’s Compose containers on the local engine. Start, stop and restart still need a separate decision each time.</p>}
      {config.kind === 'mcp' && <><div className="banner tone-warn small">This program runs on your machine with your user permissions after approval. One Connect passes a minimal environment and the read roots below, but it cannot sandbox what the program does.</div>
        <div className="builder-fields"><label>Command (absolute path)<input required value={config.command} onChange={e => patch({ command: e.target.value })} placeholder="/usr/local/bin/my-mcp-server" /></label><label>Tools agents may call<input required value={text.t} onChange={e => setText({ ...text, t: e.target.value })} placeholder="search, read_page" /></label><label>Arguments, one per line<textarea rows={3} value={text.a} onChange={e => setText({ ...text, a: e.target.value })} /></label><label>Read roots, one per line<textarea rows={3} value={text.b} onChange={e => setText({ ...text, b: e.target.value })} placeholder="/Users/you/project/docs" /></label></div></>}
      <div className="row"><button className="btn primary">Save as draft</button><button type="button" className="btn" onClick={onCancel}>Cancel</button><span className="small faint">Nothing is contacted or started when you save.</span></div>
    </fieldset>
  </form>;
}
