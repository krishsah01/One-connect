// SPDX-License-Identifier: Apache-2.0
// One design job, derived live from the same state and durable run stream as engineering work.
// Generated means a captured revision exists, never that a run exited.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { isActiveRun, jobStatus, type ControlState, type DesignJob } from '@acc/core';
import { ApprovalCard, Badge, ErrorLine, useAction, useTick } from '../common';
import { Transcript } from '../Transcript';
import { post } from '../../lib/api';
import { useLiveText, useRunEvents } from '../../lib/store';
import { shortSha } from './shared';

const KIND: Record<DesignJob['kind'], string> = { generate: 'Mock generation', refine: 'Refinement', review: 'Independent review', engineering: 'Engineering handoff' };
const CHECK_TONE = { pass: 'ok', warn: 'warn', fail: 'crit' } as const;

function RunStream({ runId, active }: { runId: string; active: boolean }) {
  const events = useRunEvents(runId);
  const live = useLiveText(runId);
  return <div className="job-transcript"><Transcript events={events} live={live} runId={runId} active={active} /></div>;
}

export function JobCard({ job, state, open = false }: { job: DesignJob; state: ControlState; open?: boolean }) {
  const { busy, error, run } = useAction();
  const now = useTick(10_000);
  const st = jobStatus(job, state);
  const a = state.assignments[job.assignmentId], item = state.workItems[job.workItemId], agent = a ? state.agents[a.agentId] : undefined;
  const [showPrompt, setShowPrompt] = useState(st.phase === 'draft' && open);
  const [showRun, setShowRun] = useState(open || st.phase === 'running' || st.phase === 'waiting');
  const [message, setMessage] = useState(''), [notice, setNotice] = useState('');
  const pf = a?.preflight ?? null;
  const failing = pf?.checks.filter(c => c.status === 'fail') ?? [];
  const runActive = Boolean(st.run && isActiveRun(st.run));
  // The tracker confirms a new issue moments after creation: re-check pre-flight once it has a key.
  const rechecked = useRef(false);
  const staleIssueCheck = Boolean(item?.key && item.trackerId && failing.some(c => c.id === 'issue'));
  useEffect(() => {
    if (!staleIssueCheck || rechecked.current || !a || (st.phase !== 'draft' && st.phase !== 'prepared')) return;
    rechecked.current = true;
    void post(`/api/assignments/${a.id}/preflight`).catch(() => undefined);
  }, [staleIssueCheck, a?.id, st.phase]);
  const mockLink = st.artifactId ? `/mocks/${st.artifactId}${st.revision ? `?rev=${st.revision.rev}` : ''}` : null;
  return <article className="card card-b job-card" aria-label={`${KIND[job.kind]}: ${job.title}`}>
    <header>
      <div className="title"><span className="small faint">{KIND[job.kind]}{job.kind === 'refine' ? ` · ${job.mode === 'follow-up' ? 'same session' : 'new assignment'} · from rev ${job.fromRev}` : ''}</span><b>{job.title}</b></div>
      <Badge tone={st.tone}>{st.label}</Badge>
    </header>
    <div className="job-meta">
      {item && <Link to={`/board?item=${item.id}`}>{item.key ?? 'issue pending'} · {item.state.replace(/_/g, ' ')}</Link>}
      <span>{agent?.config.name ?? a?.agentId ?? 'agent'}</span>
      <span><code>{job.dir}/</code></span>
      <span>contract {job.designRevision ? `v${job.designRevision.version} (${shortSha(job.designRevision.hash)})` : 'none'}</span>
      {a?.branch && <span>branch <code>{a.branch}</code></span>}
      {job.identity && <span>target content <code>{shortSha(job.identity.contentHash)}</code></span>}
    </div>
    <p className="job-detail" role="status">{st.detail}</p>
    <ErrorLine error={error} />{notice && <p className="small text-ok" role="status">{notice}</p>}
    {st.approvals.map(ap => <ApprovalCard key={ap.id} ap={ap} agentName={state.agents[ap.agentId]?.config.name ?? ap.agentId} now={now} />)}
    {(st.phase === 'draft' || st.phase === 'prepared') && a && <div className="col" style={{ gap: 10 }}>
      {pf ? <ul className="check-list" aria-label="Pre-flight checks">{pf.checks.map(c => <li key={c.id}><Badge tone={CHECK_TONE[c.status]}>{c.status}</Badge><span className="grow"><b>{c.label}</b> <span className="muted">{c.message}</span></span></li>)}</ul> : <p className="small muted">Pre-flight has not run yet.</p>}
      <div className="row wrap">
        <button type="button" className="btn primary" disabled={busy || failing.length > 0 || !item?.key} onClick={() => void run(async () => { const r = await post<{ started: boolean; queued: boolean }>(`/api/assignments/${a.id}/dispatch`, { position: 'now' }); setNotice(r.started ? 'Started. The transcript streams below.' : 'Queued as Next; it starts when the agent is free.'); setShowRun(true); })}>Dispatch to {agent?.config.name ?? 'agent'}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(() => post(`/api/assignments/${a.id}/preflight`))}>Re-run pre-flight</button>
        <button type="button" className="btn" aria-expanded={showPrompt} onClick={() => setShowPrompt(v => !v)}>{showPrompt ? 'Hide' : 'Review'} exact prompt</button>
        <Link className="btn" to={`/board?item=${job.workItemId}`}>Edit on work board</Link>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(() => post(`/api/designer/jobs/${job.id}/cancel`))}>Cancel job</button>
      </div>
      {!item?.key && <span className="small text-warn">Waiting for the tracker to confirm the issue. No issue, no dispatch.</span>}
      {failing.length > 0 && <span className="small text-warn">Pre-flight blocks dispatch: {failing.map(c => c.label).join(', ')}.</span>}
      <span className="small faint">Runs on {agent?.config.name ?? 'the agent'}'s own CLI with your existing plan. Pre-flight refuses paid usage unless this agent is explicitly configured for it.</span>
    </div>}
    {showPrompt && a && <div className="col"><span className="small muted">Exact assignment the agent receives{a.promptEdited ? ' (edited on the work board)' : ''}</span><pre className="prompt-view" tabIndex={0}>{a.prompt}</pre></div>}
    {st.run && <div className="col" style={{ gap: 8 }}>
      <div className="row wrap">
        <button type="button" className="btn sm" aria-expanded={showRun} onClick={() => setShowRun(v => !v)}>{showRun ? 'Hide' : 'Show'} run transcript</button>
        <Link className="btn sm" to={`/agents/${st.run ? state.runs[st.run.id]?.agentId ?? '' : ''}`}>Agent console</Link>
        {runActive && <button type="button" className="btn sm danger" disabled={busy} onClick={() => void run(() => post(`/api/runs/${st.run!.id}/stop`, { reason: 'stopped from the Designer studio' }))}>Stop run</button>}
        <span className="small faint">run {st.run.id.slice(-8)} · {st.run.state}{st.runs.length > 1 ? ` · ${st.runs.length} runs` : ''}</span>
      </div>
      {showRun && <RunStream runId={st.run.id} active={runActive} />}
      {showRun && <form className="row" onSubmit={e => { e.preventDefault(); const m = message.trim(); if (!m) return; void run(async () => { const r = await post<{ delivered: string }>(`/api/runs/${st.run!.id}/send`, { message: m }); setMessage(''); setNotice(r.delivered === 'live' ? 'Delivered to the running agent.' : r.delivered === 'queued' ? 'Queued; the agent receives it at its next turn.' : 'Sent as a follow-up turn in the same session.'); }); }}>
        <input aria-label="Message the design agent" placeholder={runActive ? 'Message the running agent…' : 'Continue the session with a follow-up…'} value={message} onChange={e => setMessage(e.target.value)} maxLength={4000} />
        <button className="btn sm" disabled={busy || !message.trim()}>Send</button>
      </form>}
    </div>}
    {(st.phase === 'capture_failed' || st.phase === 'no_capture' || st.phase === 'interrupted') && (job.kind === 'generate' || job.kind === 'refine') && <div className="row wrap">
      <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const r = await post<{ revision: number; unchanged: boolean }>(`/api/designer/jobs/${job.id}/capture`); setNotice(r.unchanged ? `No change since revision ${r.revision}.` : `Captured revision ${r.revision}.`); })}>Capture {job.dir}/ now</button>
      <span className="small faint">Reads the folder from the assignment worktree with the same validation as agent registration. Failures are recorded here.</span>
    </div>}
    {st.capture && !st.capture.ok && <p className="small text-warn">Last capture ({st.capture.trigger}, {new Date(st.capture.at).toLocaleTimeString()}): {st.capture.error}</p>}
    {mockLink && <div className="row wrap"><Link className="btn primary" to={mockLink}>Open {st.revision ? `revision ${st.revision.rev}` : 'mock'}</Link>{st.revision && <span className="small faint">content <code>{shortSha(st.revision.hash)}</code></span>}</div>}
  </article>;
}
