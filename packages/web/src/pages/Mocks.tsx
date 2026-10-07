// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { mockPreviewShell, VIEWPORTS, type ControlState, type MockArtifact, type MockEvidence, type MockFinding, type MockRevision } from '@acc/core';
import { Badge, Copy, ErrorLine, useAction } from '../components/common';
import { api, post } from '../lib/api';
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from '../lib/desktop';
import type { Tone } from '../lib/format';

type Gate = { state: 'clear' | 'needs_review' | 'excepted' | 'approved' | 'changes_requested'; open: MockFinding[]; drift: MockFinding | null };
type MockView = Omit<MockArtifact, 'revisions'> & { issue: { id: string; key: string | null; title: string } | null; revisions: (MockRevision & { gate: Gate })[] };
interface Preview { html: string; shell: string; execution: string; pages: string[]; hash: string; rev: number; page: string }
interface Source { path: string; sha256: string; encoding: 'utf8' | 'base64'; content: string; kind: string }
interface Exported { manifest: Record<string, unknown>; files: { path: string; content: string; encoding: string }[]; designMarkdown: string | null; tokensCss: string | null }

const GATE: Record<Gate['state'], [Tone, string]> = { clear: ['ok', 'no open findings'], needs_review: ['warn', 'needs review'], excepted: ['info', 'excepted'], approved: ['ok', 'approved'], changes_requested: ['crit', 'changes requested'] };
const SEV: Record<MockFinding['severity'], Tone> = { error: 'crit', warn: 'warn', info: 'idle' };
const EVIDENCE: Record<MockEvidence['status'], Tone> = { passed: 'ok', failed: 'crit', not_run: 'idle' };
const shortSha = (s: string) => s.slice(0, 12);

export function Mocks({ state }: { state: ControlState }) {
  const { id } = useParams();
  return id ? <MockDetail key={id} id={id} state={state} /> : <MockList state={state} />;
}

function MockList({ state }: { state: ControlState }) {
  const [search] = useSearchParams(), workItemId = search.get('workItemId') ?? undefined;
  const { busy, error, run } = useAction();
  const [mocks, setMocks] = useState<MockView[] | null>(null), [loadError, setLoadError] = useState('');
  const [assignment, setAssignment] = useState(''), [dir, setDir] = useState('design/');
  const reload = useCallback(async () => { try { setMocks((await api<{ mocks: MockView[] }>(`/api/mocks${workItemId ? `?workItemId=${encodeURIComponent(workItemId)}` : ''}`)).mocks); setLoadError(''); } catch (e) { setLoadError((e as Error).message); } }, [workItemId]);
  useEffect(() => { void reload(); }, [reload, Object.keys(state.mocks ?? {}).length]);
  const withWorktree = Object.values(state.assignments).filter(a => a.worktree && a.allowedPaths.some(p => p.startsWith('design/')));
  return <div className="page connected-page mocks-page">
    <div className="page-heading"><div><div className="eyebrow">Designer</div><h1>Design mocks</h1><p>Self-contained mocks your design agents wrote under <code>design/</code>, captured as immutable revisions bound to their issue and design contract.</p></div><Link className="btn" to="/designer">Design system</Link></div>
    {loadError && <ErrorLine error={`Could not load mocks: ${loadError}`} />}<ErrorLine error={error} />
    {!mocks && !loadError ? <div className="empty" role="status">Loading mocks…</div> : mocks && (mocks.length === 0 ? <p className="empty">No mocks captured{workItemId ? ' for this issue' : ''} yet. Create a design task from the Designer; the agent registers its mock when done, or capture a folder below.</p> :
      <div className="mock-list">{mocks.map(m => { const r = m.revisions.at(-1)!, [tone, label] = GATE[r.gate.state]; return <Link key={m.id} to={`/mocks/${m.id}`} className="card card-b col mock-card">
        <div className="row"><b className="grow">{m.title}</b><Badge tone={tone}>{label}</Badge></div>
        <span className="small muted">{m.issue?.key ?? 'issue'} · {state.agents[m.agentId]?.config.name ?? m.agentId} · <code>{m.dir}</code></span>
        <span className="small faint">rev {r.rev} · {shortSha(r.hash)} · contract {r.designRevision ? `v${r.designRevision.version}` : 'none'} · {r.evidence.length} evidence</span>
      </Link>; })}</div>)}
    <form className="card card-b col" onSubmit={e => { e.preventDefault(); void run(async () => { await post(`/api/assignments/${assignment}/mocks/capture`, { dir: dir.replace(/\/+$/, '') }); await reload(); }); }}>
      <h2>Capture a mock folder</h2>
      <p className="small muted">Reads <code>design/&lt;slug&gt;/</code> from the assignment worktree. Symlinks, other file types, files over 512 KiB and paths outside the assignment scope are rejected.</p>
      <div className="row wrap"><select aria-label="Assignment" required value={assignment} onChange={e => setAssignment(e.target.value)}><option value="">Choose an assignment with a worktree</option>{withWorktree.map(a => <option key={a.id} value={a.id}>{state.workItems[a.workItemId]?.key ?? a.workItemId} · {state.agents[a.agentId]?.config.name ?? a.agentId}</option>)}</select><input aria-label="Mock folder" required pattern="design/[a-z0-9][a-z0-9\-]{0,63}/?" value={dir} onChange={e => setDir(e.target.value)} /><button className="btn" disabled={busy || !assignment}>Capture</button></div>
    </form>
  </div>;
}

function MockDetail({ id, state }: { id: string; state: ControlState }) {
  const { busy, error, run } = useAction();
  const [mock, setMock] = useState<MockView | null>(null), [loadError, setLoadError] = useState('');
  const [rev, setRev] = useState<number | null>(null), [page, setPage] = useState('index.html'), [viewport, setViewport] = useState<string>('phone');
  const [preview, setPreview] = useState<Preview | null>(null), [previewError, setPreviewError] = useState('');
  const [tab, setTab] = useState<'review' | 'evidence' | 'source' | 'export'>('review');
  const reload = useCallback(async () => { try { const m = (await api<{ mock: MockView }>(`/api/mocks/${id}`)).mock; setMock(m); setLoadError(''); return m; } catch (e) { setLoadError((e as Error).message); return null; } }, [id]);
  useEffect(() => { void reload().then(m => m && setRev(r => r ?? m.revisions.at(-1)!.rev)); }, [reload]);
  useEffect(() => {
    if (rev === null) return;
    let active = true; setPreview(null); setPreviewError('');
    api<Preview>(`/api/mocks/${id}/revisions/${rev}/preview?page=${encodeURIComponent(page)}`).then(p => active && setPreview(p), e => active && setPreviewError((e as Error).message));
    return () => { active = false; };
  }, [id, rev, page]);
  if (loadError) return <div className="page"><ErrorLine error={`Could not load this mock: ${loadError}`} /><Link to="/mocks">All mocks</Link></div>;
  if (!mock || rev === null) return <div className="page empty" role="status">Loading mock…</div>;
  const r = mock.revisions.find(x => x.rev === rev) ?? mock.revisions.at(-1)!;
  const [tone, label] = GATE[r.gate.state], vp = VIEWPORTS.find(v => v.name === viewport)!;
  const latest = rev === mock.revisions.at(-1)!.rev;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  return <div className="page connected-page mocks-page">
    <div className="page-heading"><div><div className="eyebrow"><Link to="/mocks">Design mocks</Link></div><h1>{mock.title}</h1><p className="small muted">{mock.issue ? <Link to={`/board?item=${mock.issue.id}`}>{mock.issue.key ?? 'issue'} · {mock.issue.title}</Link> : 'issue removed'} · {state.agents[mock.agentId]?.config.name ?? mock.agentId} · <code>{mock.dir}</code></p></div><Badge tone={tone}>{label}</Badge></div>
    <ErrorLine error={error} />
    <div className="row wrap mock-toolbar">
      <label className="row small">Revision<select value={rev} onChange={e => { setRev(Number(e.target.value)); setPage('index.html'); }}>{[...mock.revisions].reverse().map(x => <option key={x.rev} value={x.rev}>rev {x.rev} · {shortSha(x.hash)} · {new Date(x.capturedAt).toLocaleString()}</option>)}</select></label>
      {preview && preview.pages.length > 1 && <label className="row small">Page<select value={page} onChange={e => setPage(e.target.value)}>{preview.pages.map(p => <option key={p}>{p}</option>)}</select></label>}
      <div className="row" role="group" aria-label="Viewport">{VIEWPORTS.map(v => <button key={v.name} type="button" className={`btn sm${viewport === v.name ? ' primary' : ''}`} aria-pressed={viewport === v.name} onClick={() => setViewport(v.name)}>{v.name} {v.width}×{v.height}</button>)}</div>
    </div>
    <p className="small faint">rev {r.rev} · content SHA-256 <span className="mono">{r.hash}</span>{r.gitSha ? <> · git <span className="mono">{shortSha(r.gitSha)}</span></> : null} · contract {r.designRevision ? `v${r.designRevision.version} (${shortSha(r.designRevision.hash)})` : 'none'} · captured by {r.by.type === 'human' ? 'you' : r.by.id}</p>
    <div className="mock-stage">
      {previewError ? <ErrorLine error={`Preview unavailable: ${previewError}`} /> : !preview ? <div className="empty" role="status">Rendering preview…</div> :
        <div className="col card card-b" style={{ width: Math.min(vp.width, 1280), minHeight: 120 }}>
          <p className="small muted">{isDesktop ? 'Open this revision in the isolated interactive preview window.' : 'Interactive previews require the desktop isolation host. Source editing and export are available here.'}</p>
          {isDesktop && <button className="btn primary" disabled={busy} onClick={() => void run(async () => {
            const pages = Object.fromEntries(await Promise.all(preview.pages.map(async name => {
              const p = name === page ? preview : await api<Preview>(`/api/mocks/${id}/revisions/${rev}/preview?page=${encodeURIComponent(name)}`);
              return [name, p.html];
            })));
            await invoke('open_mock_preview', { shell: mockPreviewShell(preview.html, pages), width: vp.width, height: vp.height });
          })}>Open interactive preview · {vp.name}</button>}
        </div>}
    </div>
    <p className="small faint">The desktop preview runs scripts in an opaque sandbox inside a separate native window. The host denies network requests, navigation, WebRTC and native commands. Static checks do not prove visual compliance.</p>
    <div className="mock-tabs-bar" role="tablist" aria-label="Mock details">{(['review', 'evidence', 'source', 'export'] as const).map(t => <button key={t} id={`mock-detail-${t}`} role="tab" aria-selected={tab === t} aria-controls="mock-detail-panel" tabIndex={tab === t ? 0 : -1} className={`btn sm${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)} onKeyDown={e => { const all = ['review', 'evidence', 'source', 'export'] as const; const i = all.indexOf(t); if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]; setTab(n); document.getElementById(`mock-detail-${n}`)?.focus(); } }}>{t}</button>)}</div>
    <div id="mock-detail-panel" role="tabpanel" aria-labelledby={`mock-detail-${tab}`}>
      {tab === 'review' && <ReviewPanel r={r} mock={mock} busy={busy} act={act} />}
      {tab === 'evidence' && <EvidencePanel r={r} mock={mock} busy={busy} act={act} />}
      {tab === 'source' && <SourcePanel r={r} mock={mock} latest={latest} busy={busy} run={run} onSaved={async () => { const m = await reload(); if (m) setRev(m.revisions.at(-1)!.rev); }} />}
      {tab === 'export' && <ExportPanel r={r} mock={mock} run={run} />}
    </div>
  </div>;
}

type Act = (fn: () => Promise<unknown>) => Promise<unknown>;

function ReviewPanel({ r, mock, busy, act }: { r: MockView['revisions'][number]; mock: MockView; busy: boolean; act: Act }) {
  const [chosen, setChosen] = useState<string[]>([]), [rationale, setRationale] = useState(''), [note, setNote] = useState('');
  const findings = [...(r.gate.drift ? [r.gate.drift] : []), ...r.findings];
  const covered = new Set(r.exceptions.flatMap(e => e.findingIds)), open = new Set(r.gate.open.map(f => f.id));
  const base = `/api/mocks/${mock.id}/revisions/${r.rev}`;
  return <section className="col" style={{ gap: 14 }}>
    <h2>Findings</h2>
    <ul className="mock-findings">{findings.map(f => <li key={f.id} className="row wrap">
      {f.severity !== 'error' && f.severity !== 'info' && open.has(f.id) ? <input type="checkbox" aria-label={`Except ${f.rule}`} checked={chosen.includes(f.id)} onChange={e => setChosen(c => e.target.checked ? [...c, f.id] : c.filter(x => x !== f.id))} /> : <span className="finding-spacer" />}
      <Badge tone={SEV[f.severity]}>{f.severity}</Badge><span className="grow small"><b>{f.rule}</b> {f.message}{f.file ? <span className="faint"> · {f.file}{f.line ? `:${f.line}` : ''}</span> : null}</span>
      {covered.has(f.id) && <Badge tone="info">excepted</Badge>}
      {f.severity !== 'info' && <button className="btn sm" disabled={busy} onClick={() => void act(() => post(`${base}/findings/${encodeURIComponent(f.id)}/issue`))}>Create issue</button>}
    </li>)}</ul>
    {chosen.length > 0 && <form className="col card card-b" onSubmit={e => { e.preventDefault(); void act(async () => { await post(`${base}/exceptions`, { findingIds: chosen, rationale }); setChosen([]); setRationale(''); }); }}>
      <label>Why is this exception acceptable?<textarea rows={2} required minLength={10} maxLength={2000} value={rationale} onChange={e => setRationale(e.target.value)} /></label>
      <button className="btn" disabled={busy || rationale.trim().length < 10}>Record exception for {chosen.length} finding{chosen.length === 1 ? '' : 's'}</button>
      <span className="small faint">Errors such as remote resources or navigation must be fixed; they cannot be excepted.</span>
    </form>}
    {r.exceptions.length > 0 && <div className="col small"><h3>Exceptions</h3>{r.exceptions.map(e => <p key={e.id}>{e.by.id} · {new Date(e.at).toLocaleString()}: {e.rationale}</p>)}</div>}
    <h2>Review</h2>
    {r.reviews.map((v, i) => <p key={i} className="small"><Badge tone={v.decision === 'approved' ? 'ok' : 'crit'}>{v.decision.replace('_', ' ')}</Badge> {v.by.id} · {new Date(v.at).toLocaleString()} {v.note}</p>)}
    <form className="col" onSubmit={e => e.preventDefault()}>
      <label>Review note<textarea rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label>
      <div className="row wrap"><button type="button" className="btn primary" disabled={busy || r.gate.open.length > 0} onClick={() => void act(async () => { await post(`${base}/review`, { decision: 'approved', note }); setNote(''); })}>Approve revision {r.rev}</button><button type="button" className="btn danger" disabled={busy} onClick={() => void act(async () => { await post(`${base}/review`, { decision: 'changes_requested', note }); setNote(''); })}>Request changes</button>{r.gate.open.length > 0 && <span className="small text-warn">{r.gate.open.length} open finding{r.gate.open.length === 1 ? '' : 's'} must be fixed or excepted first.</span>}</div>
    </form>
  </section>;
}

function EvidencePanel({ r, mock, busy, act }: { r: MockRevision; mock: MockView; busy: boolean; act: Act }) {
  const [kind, setKind] = useState<'viewport' | 'command' | 'screenshot'>('viewport'), [summary, setSummary] = useState(''), [executed, setExecuted] = useState(false), [status, setStatus] = useState<'passed' | 'failed'>('passed');
  const [vpName, setVpName] = useState('phone'), [command, setCommand] = useState(''), [exitCode, setExitCode] = useState(''), [shot, setShot] = useState('');
  const images = r.files.filter(f => f.kind === 'image');
  return <section className="col" style={{ gap: 14 }}>
    <h2>Evidence</h2>
    {r.evidence.length === 0 ? <p className="small muted">No evidence attached. Nothing is reported as passing until someone runs it.</p> : <ul className="mock-findings">{r.evidence.map(e => <li key={e.id} className="row wrap">
      <Badge tone={EVIDENCE[e.status]}>{e.status === 'not_run' ? 'not run' : e.status}</Badge><Badge tone={e.verified ? 'ok' : 'idle'} title={e.verified ? 'One Connect saw this command and exit code in the run transcript.' : 'Reported, not observed by One Connect.'}>{e.verified ? 'observed in run' : `reported by ${e.source}`}</Badge>
      <span className="grow small"><b>{e.kind}</b> {e.summary}{e.command ? <> · <code>{e.command}</code>{e.exitCode !== undefined && e.exitCode !== null ? ` → exit ${e.exitCode}` : ''}</> : null}{e.viewport ? ` · ${e.viewport.name} ${e.viewport.width}×${e.viewport.height}` : ''}{e.screenshot ? ` · ${e.screenshot.path} (${shortSha(e.screenshot.sha256)})` : ''}</span>
    </li>)}</ul>}
    <form className="card card-b col" onSubmit={e => { e.preventDefault(); const v = VIEWPORTS.find(x => x.name === vpName)!; void act(async () => { await post(`/api/mocks/${mock.id}/revisions/${r.rev}/evidence`, { kind, summary, executed, status: executed ? status : 'not_run', ...(kind === 'command' ? { command, exitCode: exitCode === '' ? null : Number(exitCode) } : {}), ...(kind !== 'command' ? { viewport: v } : {}), ...(kind === 'screenshot' ? { screenshot: shot } : {}) }); setSummary(''); }); }}>
      <h3>Add your evidence</h3>
      <div className="row wrap"><select aria-label="Evidence kind" value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="viewport">Viewport check</option><option value="screenshot">Screenshot</option><option value="command">Command</option></select>
        {kind !== 'command' && <select aria-label="Viewport" value={vpName} onChange={e => setVpName(e.target.value)}>{VIEWPORTS.map(v => <option key={v.name} value={v.name}>{v.name} {v.width}×{v.height}</option>)}</select>}
        {kind === 'screenshot' && <select aria-label="Screenshot file" required value={shot} onChange={e => setShot(e.target.value)}><option value="">{images.length ? 'Choose a captured image' : 'No images in this revision'}</option>{images.map(f => <option key={f.path}>{f.path}</option>)}</select>}
        {kind === 'command' && <><input aria-label="Command" required className="mono" value={command} onChange={e => setCommand(e.target.value)} placeholder="pnpm test" /><input aria-label="Exit code" type="number" value={exitCode} onChange={e => setExitCode(e.target.value)} placeholder="exit code" style={{ width: 110 }} /></>}
      </div>
      <label>What did you check?<input required maxLength={500} value={summary} onChange={e => setSummary(e.target.value)} /></label>
      <div className="row wrap"><label className="row"><input type="checkbox" checked={executed} onChange={e => setExecuted(e.target.checked)} />I actually ran this check</label>{executed && <select aria-label="Result" value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="passed">passed</option><option value="failed">failed</option></select>}<button className="btn" disabled={busy || !summary.trim() || (kind === 'screenshot' && !shot)}>Attach</button></div>
      <span className="small faint">Unchecked boxes are recorded as “not run”. Your evidence is marked as reported by you; only commands seen in an agent run are marked observed.</span>
    </form>
  </section>;
}

function SourcePanel({ r, mock, latest, busy, run, onSaved }: { r: MockRevision; mock: MockView; latest: boolean; busy: boolean; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; onSaved: () => Promise<void> }) {
  const [file, setFile] = useState(r.entry), [src, setSrc] = useState<Source | null>(null), [draft, setDraft] = useState<string | null>(null), [notice, setNotice] = useState('');
  useEffect(() => { let active = true; setSrc(null); setDraft(null); void api<Source>(`/api/mocks/${mock.id}/revisions/${r.rev}/source?path=${encodeURIComponent(file)}`).then(s => active && setSrc(s)).catch(() => undefined); return () => { active = false; }; }, [mock.id, r.rev, file]);
  return <section className="col" style={{ gap: 12 }}>
    <div className="row wrap small">{r.files.map(f => <button key={f.path} type="button" className={`btn sm${f.path === file ? ' primary' : ''}`} onClick={() => setFile(f.path)}>{f.path} <span className="faint">{(f.bytes / 1024).toFixed(1)} KiB</span></button>)}</div>
    {!src ? <div className="empty" role="status">Loading source…</div> : src.encoding === 'base64' ? <img className="mock-image" alt={src.path} src={`data:image/${src.path.split('.').pop() === 'jpg' ? 'jpeg' : src.path.split('.').pop()};base64,${src.content}`} /> : draft === null ?
      <><pre className="design-export mock-source">{src.content}</pre><div className="row"><button className="btn sm" disabled={!latest} onClick={() => setDraft(src.content)}>Edit</button><span className="small faint">{latest ? 'Saving writes this file in the assignment worktree and captures a new revision. Earlier revisions stay unchanged.' : 'Older revisions are read-only. Switch to the latest revision to edit.'}</span></div></> :
      <form className="col" onSubmit={e => { e.preventDefault(); void run(async () => { await post(`/api/mocks/${mock.id}/source`, { path: src.path, content: draft, expectedSha: src.sha256 }); setDraft(null); setNotice(`Saved ${src.path} as a new revision.`); await onSaved(); }); }}>
        <textarea aria-label={`Edit ${src.path}`} className="mono mock-source" rows={18} value={draft} onChange={e => setDraft(e.target.value)} />
        <div className="row"><button className="btn primary" disabled={busy || draft === src.content}>Save as new revision</button><button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button></div>
      </form>}
    {notice && <p role="status" className="small text-ok">{notice}</p>}
  </section>;
}

function ExportPanel({ r, mock, run }: { r: MockRevision; mock: MockView; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [ex, setEx] = useState<Exported | null>(null), [url, setUrl] = useState('');
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return <section className="col" style={{ gap: 12 }}>
    <p className="small muted">Export bundles the exact files of revision {r.rev}, a manifest with its hashes, gate and evidence, and the DESIGN.md and tokens.css of the contract it was built against. Nothing is published.</p>
    <div className="row wrap"><button className="btn" onClick={() => void run(async () => { const e = await api<Exported>(`/api/mocks/${mock.id}/revisions/${r.rev}/export`); setEx(e); setUrl(URL.createObjectURL(new Blob([JSON.stringify(e, null, 2)], { type: 'application/json' }))); })}>Prepare export</button>
      {ex && <><a className="btn" href={url} download={`${mock.dir.replace('design/', '')}-rev${r.rev}.json`}>Download bundle</a>{ex.designMarkdown && <Copy text={ex.designMarkdown} label="Copy DESIGN.md" />}{ex.tokensCss && <Copy text={ex.tokensCss} label="Copy tokens.css" />}</>}</div>
    {ex && <pre className="design-export small">{JSON.stringify(ex.manifest, null, 2)}</pre>}
  </section>;
}
