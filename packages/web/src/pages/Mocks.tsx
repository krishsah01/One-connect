// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Mock artifacts: a gallery of captured revisions and in-progress jobs, and one artifact's exact
// revision, page and viewport with review, evidence, comparison, source, refinement and handoff.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { jobStatus, VIEWPORTS, type ControlState } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { ComparePanel, EvidencePanel, HandoffPanel, RefinePanel, ReviewPanel, SourcePanel } from '../components/designer/MockPanels';
import { loadPreview, MockStage } from '../components/designer/MockStage';
import { StructuredStage } from '../components/designer/workspace/StructuredStage';
import { GATE_LABEL, shortSha, Tabs, tabPanel, type JobView, type MockView } from '../components/designer/shared';
import '../components/designer/designer.css';
import { api, post } from '../lib/api';
import { isDesktop } from '../lib/desktop';

const ATTENTION = new Set(['draft', 'queued', 'running', 'waiting', 'capture_failed', 'no_capture', 'interrupted', 'failed']);
const versionOf = (state: ControlState, id?: string) => (id ? state.mocks?.[id]?.updatedAt ?? '' : Object.values(state.mocks ?? {}).map(m => m.updatedAt).sort().at(-1) ?? '');

export function Mocks({ state }: { state: ControlState }) {
  const { id } = useParams();
  return id ? <MockDetail key={id} id={id} state={state} /> : <MockList state={state} />;
}

function Thumb({ id, rev }: { id: string; rev: number }) {
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => { let alive = true; void loadPreview(id, rev, 'index.html').then(p => alive && setDoc(p.static)).catch(() => undefined); return () => { alive = false; }; }, [id, rev]);
  return <div className="thumb" aria-hidden>{doc && <iframe title="" tabIndex={-1} sandbox="" referrerPolicy="no-referrer" srcDoc={doc} />}<span className="thumb-note"><Badge>static</Badge></span></div>;
}

function MockList({ state }: { state: ControlState }) {
  const [search] = useSearchParams(), workItemId = search.get('workItemId') ?? undefined;
  const { busy, error, run } = useAction();
  const [mocks, setMocks] = useState<MockView[] | null>(null), [loadError, setLoadError] = useState('');
  const [assignment, setAssignment] = useState(''), [dir, setDir] = useState('design/');
  const [filter, setFilter] = useState<'all' | 'review' | 'approved' | 'old'>('all');
  const reload = useCallback(async () => { try { setMocks((await api<{ mocks: MockView[] }>(`/api/mocks${workItemId ? `?workItemId=${encodeURIComponent(workItemId)}` : ''}`)).mocks); setLoadError(''); } catch (e) { setLoadError((e as Error).message); } }, [workItemId]);
  useEffect(() => { void reload(); }, [reload, versionOf(state), state.design?.hash]);
  const withWorktree = Object.values(state.assignments).filter(a => a.worktree && a.allowedPaths.some(p => p.startsWith('design/')));
  const attention = Object.values(state.designStudio?.jobs ?? {}).filter(j => (j.kind === 'generate' || j.kind === 'refine') && !j.canceledAt).map(j => ({ job: j, st: jobStatus(j, state) })).filter(x => ATTENTION.has(x.st.phase)).sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt));
  const shown = (mocks ?? []).filter(m => filter === 'all' ? true : filter === 'approved' ? m.status.approvedRev !== null : filter === 'old' ? m.status.oldContract : !m.status.approvedIsLatest);
  return <div className="page connected-page mocks-page mocks-studio studio-page">
    <div className="page-heading"><div><div className="eyebrow">Designer</div><h1>Design mocks</h1><p>Self-contained mocks your design agents wrote under <code>design/</code>, captured as immutable revisions bound to their issue, assignment, git SHA and design contract.</p></div><div className="row wrap"><Link className="btn primary" to="/designer">New design</Link></div></div>
    {loadError && <ErrorLine error={`Could not load mocks: ${loadError}`} />}<ErrorLine error={error} />
    {attention.length > 0 && <section className="card card-b col" aria-labelledby="attention-h" style={{ marginBottom: 18 }}>
      <h2 className="section" id="attention-h">In progress and needing attention</h2>
      <ul className="check-list">{attention.map(({ job, st }) => <li key={job.id}><Badge tone={st.tone}>{st.label}</Badge><span className="grow"><b>{job.title}</b> <span className="muted">· {job.dir}/ · {st.detail}</span></span><Link className="btn sm" to="/designer">Open Designer</Link></li>)}</ul>
    </section>}
    {mocks && mocks.length > 0 && <div className="row wrap" style={{ marginBottom: 12 }}><div className="segmented" role="radiogroup" aria-label="Filter mocks">{([['all', 'All'], ['review', 'Latest not approved'], ['approved', 'Has an approved revision'], ['old', 'Older contract']] as const).map(([v, l]) => <label key={v}><input type="radio" name="mock-filter" checked={filter === v} onChange={() => setFilter(v)} />{l}</label>)}</div><span className="small faint">{shown.length} of {mocks.length}</span></div>}
    {!mocks && !loadError ? <div className="empty" role="status">Loading mocks…</div> : mocks && (mocks.length === 0 ? <div className="card card-b col empty" style={{ marginBottom: 18 }}><b>No mocks captured{workItemId ? ' for this issue' : ''} yet.</b><span className="small muted">Write a brief in the Designer studio. The agent registers its mock when done; if a run finishes without one, the studio shows the failure and lets you capture the folder. You can also capture a folder below.</span></div> :
      <div className="gallery" style={{ marginBottom: 18 }}>{shown.map((m, i) => { const r = m.revisions.at(-1)!, [tone, label] = GATE_LABEL[r.gate.state]; return <Link key={m.id} to={`/mocks/${m.id}`} className="card gallery-card">
        {!isDesktop && i < 12 && <Thumb id={m.id} rev={r.rev} />}
        <div className="row"><b className="grow">{m.title}</b><Badge tone={tone}>{label}</Badge></div>
        <span className="meta"><span>{m.issue?.key ?? 'issue'}</span><span>{state.agents[m.agentId]?.config.name ?? m.agentId}</span><code>{m.dir}</code></span>
        <span className="meta"><span>rev {r.rev} · {shortSha(r.hash)}</span><span>contract {r.designRevision ? `v${r.designRevision.version}` : 'none'}</span><span>{r.evidence.length} evidence</span></span>
        <span className="row wrap">{m.status.approvedRev !== null && <Badge tone="ok">rev {m.status.approvedRev} approved</Badge>}{m.status.approvedRev !== null && !m.status.approvedIsLatest && <Badge tone="warn">latest not approved</Badge>}{m.status.staleApproval && <Badge tone="warn">stale approval</Badge>}{m.status.oldContract && <Badge tone="warn">older contract</Badge>}</span>
      </Link>; })}</div>)}
    <form className="card card-b col" onSubmit={e => { e.preventDefault(); void run(async () => { await post(`/api/assignments/${assignment}/mocks/capture`, { dir: dir.replace(/\/+$/, '') }); await reload(); }); }}>
      <h2>Capture a mock folder</h2>
      <p className="small muted">Reads <code>design/&lt;slug&gt;/</code> from the assignment worktree. Symlinks, other file types, files over 512 KiB, secrets and paths outside the assignment scope are rejected, and the rejection is recorded.</p>
      <div className="row wrap"><select aria-label="Assignment" required value={assignment} onChange={e => setAssignment(e.target.value)} style={{ width: 'auto' }}><option value="">Choose an assignment with a worktree</option>{withWorktree.map(a => <option key={a.id} value={a.id}>{state.workItems[a.workItemId]?.key ?? a.workItemId} · {state.agents[a.agentId]?.config.name ?? a.agentId}</option>)}</select><input aria-label="Mock folder" required pattern="design/[a-z0-9][a-z0-9\-]{0,63}/?" value={dir} onChange={e => setDir(e.target.value)} style={{ width: 'auto', flex: '1 1 200px' }} /><button className="btn" disabled={busy || !assignment}>Capture</button></div>
    </form>
  </div>;
}

type DetailTab = 'review' | 'evidence' | 'compare' | 'source' | 'refine' | 'handoff';
const DETAIL_TABS: { id: DetailTab; label: string }[] = [{ id: 'review', label: 'Review' }, { id: 'evidence', label: 'Evidence' }, { id: 'compare', label: 'Compare' }, { id: 'source', label: 'Source' }, { id: 'refine', label: 'Refine' }, { id: 'handoff', label: 'Handoff' }];

function MockDetail({ id, state }: { id: string; state: ControlState }) {
  const { busy, error, run } = useAction();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [mock, setMock] = useState<MockView | null>(null), [loadError, setLoadError] = useState('');
  const [lineage, setLineage] = useState<JobView[]>([]);
  const reload = useCallback(async () => { try { const m = (await api<{ mock: MockView }>(`/api/mocks/${id}`)).mock; setMock(m); setLoadError(''); void api<{ jobs: JobView[] }>(`/api/mocks/${id}/lineage`).then(l => setLineage(l.jobs)).catch(() => undefined); return m; } catch (e) { setLoadError((e as Error).message); return null; } }, [id]);
  useEffect(() => { void reload(); }, [reload, versionOf(state, id), state.design?.hash]);
  const setQ = (p: Record<string, string | null>) => setParams(cur => { const n = new URLSearchParams(cur); for (const [k, v] of Object.entries(p)) v === null ? n.delete(k) : n.set(k, v); return n; }, { replace: true });
  if (loadError) return <div className="page"><ErrorLine error={`Could not load this mock: ${loadError}`} /><Link to="/mocks">All mocks</Link></div>;
  if (!mock) return <div className="page empty" role="status">Loading mock…</div>;
  const latest = mock.revisions.at(-1)!;
  const asked = Number(params.get('rev'));
  const r = mock.revisions.find(x => x.rev === asked) ?? latest;
  const pages = r.files.filter(f => f.kind === 'html').map(f => f.path);
  const page = pages.includes(params.get('page') ?? '') ? params.get('page')! : pages.includes('index.html') ? 'index.html' : pages[0];
  const vp = VIEWPORTS.find(v => v.name === params.get('vp')) ?? VIEWPORTS[2];
  const tab = (DETAIL_TABS.some(t => t.id === params.get('tab')) ? params.get('tab') : 'review') as DetailTab;
  const [tone, label] = GATE_LABEL[r.gate.state];
  const isLatest = r.rev === latest.rev;
  const author = r.authoredBy ?? r.by;
  const who = (a: { type: string; id: string }) => (a.type === 'human' ? 'you' : a.type === 'agent' ? state.agents[a.id]?.config.name ?? a.id : 'One Connect');
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const asg = state.assignments[r.assignmentId ?? mock.assignmentId];
  return <div className="page connected-page mocks-page mocks-studio studio-page">
    <div className="page-heading"><div><div className="eyebrow"><Link to="/mocks">Design mocks</Link></div><h1>{mock.title}</h1>
      <div className="identity" aria-label="Revision identity">
        {mock.issue ? <Link to={`/board?item=${mock.issue.id}`}>{mock.issue.key ?? 'issue'} · {mock.issue.title}</Link> : <span>issue removed</span>}
        <span>rev {r.rev} of {latest.rev}</span><span>content <code title={r.hash}>{shortSha(r.hash)}</code></span>{r.gitSha && <span>git <code title={r.gitSha}>{shortSha(r.gitSha)}</code></span>}
        <span>contract {r.designRevision ? `v${r.designRevision.version} (${shortSha(r.designRevision.hash)})` : 'none'}{state.design && r.designRevision && state.design.hash !== r.designRevision.hash ? ` · project is on v${state.design.version}` : ''}</span>
        <span>authored by {who(author)} · captured by {who(r.by)}{r.origin ? ` (${r.origin})` : ''}</span>
        {asg?.branch && <span>branch <code>{asg.branch}</code></span>}{r.runId && <Link to={`/runs/${r.runId}`}>run {r.runId.slice(-8)}</Link>}
      </div></div>
      <div className="row wrap"><Badge tone={tone}>{label}</Badge>{!isLatest && <Badge tone="info">older revision</Badge>}</div></div>
    <ErrorLine error={error} />
    {!isLatest && <div className="banner tone-info small" role="note">You are viewing revision {r.rev}. The latest is {latest.rev}. <button type="button" className="btn sm" onClick={() => setQ({ rev: String(latest.rev) })}>Show latest</button></div>}
    {mock.status.approvedRev !== null && !mock.status.approvedIsLatest && <div className="banner tone-warn small" role="note">Revision {mock.status.approvedRev} is approved; the latest revision {latest.rev} is not. Approvals never carry to a changed artifact.</div>}
    {mock.status.staleApproval && <div className="banner tone-warn small" role="note">Revision {mock.status.staleApproval.rev}'s approval no longer holds: {mock.status.staleApproval.reason}</div>}
    <div className="detail-grid">
      <div className="studio-stack">
        <div className="stage-toolbar" role="group" aria-label="Preview controls">
          {pages.length > 1 && <label className="row small">Page<select value={page} onChange={e => setQ({ page: e.target.value })}>{pages.map(p => <option key={p}>{p}</option>)}</select></label>}
          <div className="segmented" role="radiogroup" aria-label="Viewport">{VIEWPORTS.map(v => <label key={v.name}><input type="radio" name="viewport" checked={vp.name === v.name} onChange={() => setQ({ vp: v.name })} />{v.name} {v.width}×{v.height}</label>)}</div>
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={r.rev === mock.revisions[0].rev} onClick={() => setQ({ rev: String(mock.revisions[mock.revisions.indexOf(r) - 1].rev) })} aria-label="Previous revision">← rev</button>
          <button type="button" className="btn sm" disabled={isLatest} onClick={() => setQ({ rev: String(mock.revisions[mock.revisions.indexOf(r) + 1].rev) })} aria-label="Next revision">rev →</button>
          {r.document ? <Link className="btn sm" to={`/designer?document=${encodeURIComponent(r.document.id)}`}>Open in Designer</Link>
            : <button type="button" className="btn sm" disabled={busy} title="Recreate this mock's pages as an editable design in the Designer. The mock itself is not changed." onClick={() => void run(async () => { const d = await post<{ document: { id: string } }>(`/api/designer/mocks/${mock.id}/${r.rev}/rebuild`); navigate(`/designer?document=${encodeURIComponent(d.document.id)}`); })}>Open as editable design</button>}
        </div>
        {r.document ? <StructuredStage artifactId={mock.id} rev={r.rev} width={vp.width} /> : <MockStage id={mock.id} rev={r.rev} page={page} viewport={vp} title={mock.title} />}
        {r.handoff && <details className="card card-b"><summary className="small"><b>Agent handoff</b> (claims, not proof)</summary><div className="col small" style={{ gap: 6, marginTop: 8 }}>{r.handoff.summary && <p style={{ margin: 0 }}>{r.handoff.summary}</p>}{r.handoff.pages.length > 0 && <span>Pages: {r.handoff.pages.map(p => `${p.path}${p.title ? ` (${p.title})` : ''}`).join(', ')}</span>}{r.handoff.states.length > 0 && <span>States: {r.handoff.states.join(', ')}</span>}{r.handoff.interactions.length > 0 && <span>Interactions: {r.handoff.interactions.join('; ')}</span>}{r.handoff.checks.length > 0 && <span>Checks claimed: {r.handoff.checks.map(c => `${c.name} ${c.status.replace('_', ' ')}`).join('; ')}</span>}{r.handoff.limitations.length > 0 && <span className="text-warn">Limitations: {r.handoff.limitations.join('; ')}</span>}{r.handoff.questions.length > 0 && <span>Open questions: {r.handoff.questions.join('; ')}</span>}</div></details>}
        <Tabs idBase="mock" label="Mock review sections" tabs={DETAIL_TABS} value={tab} onChange={t => setQ({ tab: t })} />
        <div {...tabPanel('mock', tab)}>
          {tab === 'review' && <ReviewPanel mock={mock} r={r} state={state} act={act} busy={busy} latest={isLatest} />}
          {tab === 'evidence' && <EvidencePanel mock={mock} r={r} state={state} act={act} busy={busy} page={page} viewport={vp} />}
          {tab === 'compare' && <ComparePanel mock={mock} r={r} viewport={vp} page={page} />}
          {tab === 'source' && <SourcePanel mock={mock} r={r} busy={busy} run={run} onSaved={rev => { void reload().then(() => setQ({ rev: String(rev) })); }} />}
          {tab === 'refine' && <RefinePanel mock={mock} r={r} state={state} busy={busy} run={run} />}
          {tab === 'handoff' && <HandoffPanel mock={mock} r={r} state={state} busy={busy} run={run} />}
        </div>
      </div>
      <aside className="studio-stack" aria-label="Revision history">
        <section className="card card-b col"><h2 className="section">Revisions</h2>
          <ol className="timeline">{[...mock.revisions].reverse().map(x => { const [t, l] = GATE_LABEL[x.gate.state]; return <li key={x.rev}><button type="button" aria-current={x.rev === r.rev} onClick={() => setQ({ rev: String(x.rev) })}>
            <b>rev {x.rev}</b><span className="mono faint">{shortSha(x.hash)}</span><Badge tone={t}>{l}</Badge>
            <span className="sub">{x.origin === 'edit' ? 'your edit' : x.origin === 'auto' ? 'auto-captured' : x.origin === 'agent' ? 'registered by agent' : 'captured'} · contract {x.designRevision ? `v${x.designRevision.version}` : 'none'} · {new Date(x.capturedAt).toLocaleString()}</span>
          </button></li>; })}</ol>
        </section>
        <section className="card card-b col"><h2 className="section">Lineage</h2>
          {lineage.length === 0 ? <p className="small muted">Captured outside the studio, or from a folder you chose.</p> : <ul className="check-list">{lineage.map(v => <li key={v.job.id}><Badge tone={v.status.tone}>{v.status.label}</Badge><span className="grow small"><b>{v.job.kind}</b> {v.job.fromRev ? `from rev ${v.job.fromRev}` : ''} {v.job.request ? `· ${v.job.request.slice(0, 80)}` : ''}</span></li>)}</ul>}
          <Link className="btn sm" to="/designer">Open Designer</Link>
        </section>
        {!isDesktop && r.files.some(f => f.kind === 'html') && <section className="card card-b col"><h2 className="section">All pages · {vp.name}</h2>{pages.slice(0, 6).map(p => <button type="button" key={p} className="btn sm" aria-pressed={p === page} onClick={() => setQ({ page: p })}>{p}</button>)}</section>}
      </aside>
    </div>
  </div>;
}

