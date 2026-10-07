// SPDX-License-Identifier: Apache-2.0
// One agent, in real time: live transcript, controls, approvals, diff, tests, handoff, history.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ControlState, Handoff, Run } from '@acc/core';
import { isActiveRun, sharedUsageView } from '@acc/core';
import { ApprovalCard, Badge, BillingBadge, Copy, ErrorLine, Light, UsageMeter, useAction, useTick } from '../components/common';
import { DiffView } from '../components/DiffView';
import { RawLog, Transcript } from '../components/Transcript';
import { post } from '../lib/api';
import { AGENT_TONE, RUN_TONE, ago } from '../lib/format';
import { useLiveText, useRunEvents } from '../lib/store';

export function AgentConsole({ state }: { state: ControlState }) {
  const { id = '' } = useParams();
  const agent = state.agents[id];
  const now = useTick(5000);
  const runs = useMemo(() => Object.values(state.runs).filter((r) => r.agentId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.runs, id]);
  const [picked, setPicked] = useState<string | null>(null);
  const [logRun, setLogRun] = useState<string | null>(null);
  const run = (picked && state.runs[picked]) || runs.find(isActiveRun) || runs[0] || null;
  const events = useRunEvents(run?.id ?? null);
  const liveText = useLiveText(run?.id ?? null);
  if (!agent) return <div className="page empty">Unknown agent “{id}”.</div>;
  const asg = run ? state.assignments[run.assignmentId] : null;
  const item = run ? state.workItems[run.workItemId] : null;
  const approvals = Object.values(state.approvals).filter((a) => a.agentId === id && !a.resolvedAt);
  const tone = AGENT_TONE[agent.status];
  return (
    <div className="page">
      <div className="row wrap" style={{ marginBottom: 14, gap: 10 }}>
        <Light tone={tone} pulse={agent.status === 'running'} />
        <h1 style={{ fontSize: 20 }}>{agent.config.name}</h1>
        <Badge tone={tone}>{agent.status}</Badge>
        <span className="faint small">
          {agent.config.subscription ?? agent.config.vendor ?? agent.config.adapter} · {agent.config.role}
          {agent.config.mode === 'coordinator-only' ? ' · coordinator-only' : ''}
        </span>
        <BillingBadge agent={agent} />
        <span className="spacer" />
        {(agent.pausedReason || agent.limitedUntil) && <ResumeAgent id={id} />}
      </div>
      <div className="console">
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="card-h" style={{ paddingBottom: 10, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            {run ? (
              <>
                <span className="mono small faint">{item?.key}</span>
                <b className="ellipsis" style={{ maxWidth: 360 }}>
                  {item?.title}
                </b>
                <Badge tone={RUN_TONE[run.state]}>{run.state}</Badge>
                {run.attempt > 1 && <Badge tone="info">attempt {run.attempt}</Badge>}
                <span className="faint small mono">{run.resolvedModel ?? run.model ?? ''}</span>
                <span className="spacer" />
                <span className="faint small">{run.startedAt ? `${ago(run.startedAt, now)}` : ''}</span>
              </>
            ) : (
              <span className="faint">No runs yet: dispatch work from the board.</span>
            )}
          </div>
          {run && <RunControls run={run} state={state} />}
          <Transcript events={events} live={liveText} runId={run?.id ?? null} active={run ? isActiveRun(run) : false} footer={<Composer agentId={id} run={run} state={state} />} />
        </section>
        <aside className="col" style={{ gap: 14 }}>
          {approvals.length > 0 && (
            <section className="card">
              <div className="card-h">
                <h2>Pending approvals</h2>
                <Badge tone="warn">{approvals.length}</Badge>
              </div>
              <div className="card-b col">
                {approvals.map((ap) => (
                  <ApprovalCard key={ap.id} ap={ap} agentName={agent.config.name} now={now} />
                ))}
              </div>
            </section>
          )}
          {run?.adapter === 'relay' && isActiveRun(run) && asg && <RelayBox runId={run.id} prompt={asg.prompt} />}
          {run?.handoff && <HandoffCard h={run.handoff} run={run} />}
          <section className="card">
            <div className="card-h">
              <h2>Queue</h2>
            </div>
            <div className="card-b col small">
              <div className="row">
                <span className="faint" style={{ width: 44 }}>Now</span>
                {agent.queue.now ? <span>{state.workItems[state.assignments[agent.queue.now]?.workItemId]?.key} {state.workItems[state.assignments[agent.queue.now]?.workItemId]?.title}</span> : <span className="faint">–</span>}
              </div>
              {agent.queue.next.map((n, i) => (
                <div key={n} className="row">
                  <span className="faint" style={{ width: 44 }}>{i === 0 ? 'Next' : ''}</span>
                  <span>
                    {state.workItems[state.assignments[n]?.workItemId]?.key} {state.workItems[state.assignments[n]?.workItemId]?.title}
                  </span>
                </div>
              ))}
              <Link to="/board#queues">Edit queues →</Link>
            </div>
          </section>
          {asg?.worktree && run && (
            <section className="card">
              <div className="card-h">
                <h2>Diff vs base</h2>
                <span className="spacer" />
                <span className="mono small faint" title={asg.worktree}>
                  {asg.branch}
                </span>
              </div>
              <div className="card-b">
                <DiffView assignmentId={asg.id} version={`${run.id}:${run.filesChanged.join(',')}:${run.state}`} outOfScope={run.outOfScope} />
              </div>
            </section>
          )}
          {run && (
            <section className="card">
              <div className="card-h">
                <h2>Tests</h2>
              </div>
              <div className="card-b small">
                {run.tests ? (
                  <div className="row">
                    <Badge tone={run.tests.failed ? 'crit' : 'ok'}>
                      {run.tests.passed} passed · {run.tests.failed} failed
                    </Badge>
                    <span className="faint">{run.tests.source === 'daemon' ? 'verified by the control center' : 'reported by the agent'}</span>
                  </div>
                ) : (
                  <span className="faint">No test run recorded.</span>
                )}
                {run.tests && <div className="mono faint" style={{ marginTop: 6 }}>{run.tests.command}</div>}
              </div>
            </section>
          )}
          <ModelCard state={state} agentId={id} />
          <section className="card">
            <div className="card-h">
              <h2>Usage</h2>
            </div>
            <div className="card-b">
              <UsageMeter usage={agent.usage} />
              <div className="small faint" style={{ marginTop: 6 }}>{sharedUsageView(state.agents, id).note}</div>
            </div>
          </section>
          <section className="card">
            <div className="card-h">
              <h2>Run history</h2>
            </div>
            <div className="card-b col small" style={{ gap: 4 }}>
              {runs.length === 0 && <span className="faint">none</span>}
              {runs.slice(0, 25).map((r) => (
                <button key={r.id} type="button" className={`row btn ghost sm${run?.id === r.id ? ' active' : ''}`} style={{ justifyContent: 'flex-start', width: '100%' }} onClick={() => setPicked(r.id)}>
                  <Light tone={RUN_TONE[r.state]} />
                  <span className="mono">{state.workItems[r.workItemId]?.key}</span>
                  <span className="faint">{r.exit?.kind ?? r.state}</span>
                  <span className="spacer" />
                  <span className="faint">{ago(r.createdAt, now)}</span>
                </button>
              ))}
              {run && (
                <div className="row faint" style={{ marginTop: 6 }}>
                  Durable logs:
                  <button className="btn sm ghost" onClick={() => setLogRun(run.id)}>View stdout / stderr</button>
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
      {logRun && <div className="modal-bg"><section className="card modal" style={{ width: 'min(900px, 95vw)', maxHeight: '90vh', overflow: 'auto' }} role="dialog" aria-label="Durable run logs"><div className="card-h"><h2>Durable run logs</h2><span className="spacer" /><button className="btn sm" onClick={() => setLogRun(null)}>Close</button></div><RawLog key={logRun} runId={logRun} active={Boolean(state.runs[logRun] && isActiveRun(state.runs[logRun]))} /></section></div>}
    </div>
  );
}

function RunControls({ run, state }: { run: Run; state: ControlState }) {
  const { busy, error, run: act } = useAction();
  const [to, setTo] = useState('');
  const active = isActiveRun(run);
  const others = Object.values(state.agents).filter((a) => a.id !== run.agentId);
  const asg = state.assignments[run.assignmentId];
  return (
    <div className="col" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', gap: 8 }}>
      <div className="row wrap">
        <button className="btn sm danger" disabled={busy || !active} onClick={() => void act(() => post(`/api/runs/${run.id}/stop`, { reason: 'stopped by owner' }))}>
          Stop
        </button>
        <button className="btn sm" disabled={busy || !active || !run.sessionId} onClick={() => void act(() => post(`/api/runs/${run.id}/pause`))} title="Interrupts and keeps the vendor session so it can resume">
          Pause
        </button>
        <button className="btn sm" disabled={busy || active || !run.sessionId} onClick={() => void act(() => post(`/api/runs/${run.id}/resume`))}>
          Resume
        </button>
        <button className="btn sm" disabled={busy || !run.sessionId} onClick={() => void act(() => post(`/api/runs/${run.id}/nudge`))}>
          Nudge
        </button>
        {run.handoff?.source === 'skeleton' && (
          <button className="btn sm" disabled={busy} onClick={() => void act(() => post(`/api/runs/${run.id}/accept-skeleton`))}>
            Accept generated handoff
          </button>
        )}
        <span className="spacer" />
        {asg && asg.position !== 'done' && !active && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (to) void act(() => post(`/api/assignments/${asg.id}/reassign`, { agentId: to }));
            }}
          >
            <select value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }}>
              <option value="">Reassign to…</option>
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.config.name} ({a.status})
                </option>
              ))}
            </select>
            <button className="btn sm" disabled={busy || !to}>
              Reassign
            </button>
          </form>
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * Bottom composer, like a chat app. With a live run: message the agent (live for Claude, next turn
 * for others). Otherwise: continue the last session, or give the agent a new task (creates the
 * tracker issue and dispatches it; queued as Next if the agent is busy).
 */
function Composer({ agentId, run, state }: { agentId: string; run: Run | null; state: ControlState }) {
  const { busy, error, run: act } = useAction();
  const active = run ? isActiveRun(run) : false;
  const canContinue = Boolean(run && !active && run.sessionId && run.adapter !== 'relay');
  const [mode, setMode] = useState<'message' | 'task'>(active || canContinue ? 'message' : 'task');
  const [text, setText] = useState('');
  const [paths, setPaths] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const agent = state.agents[agentId];
  const effective = mode === 'message' && !active && !canContinue ? 'task' : mode;
  const submit = () =>
    act(async () => {
      if (!text.trim()) return;
      if (effective === 'message' && run) {
        const r = await post<{ delivered: string }>(`/api/runs/${run.id}/send`, { message: text });
        setNote(r.delivered === 'live' ? 'Delivered live.' : r.delivered === 'queued' ? 'Queued: delivered as the next turn when this one finishes.' : 'Continuing the session…');
      } else {
        const [title, ...rest] = text.trim().split('\n');
        const r = await post<{ item: { key: string }; started: boolean }>('/api/quick-task', {
          agentId,
          title: title.slice(0, 200),
          description: rest.join('\n').trim(),
          allowedPaths: paths.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
        });
        setNote(`${r.item.key} ${r.started ? 'started' : 'queued as Next'}.`);
      }
      setText('');
    });
  return (
    <div className="composer">
      <div className="row small">
        <div className="chips">
          <button type="button" className={`chip${effective === 'message' ? ' on' : ''}`} disabled={!active && !canContinue} onClick={() => setMode('message')}>
            {active ? 'Message' : 'Continue session'}
          </button>
          <button type="button" className={`chip${effective === 'task' ? ' on' : ''}`} onClick={() => setMode('task')}>
            New task
          </button>
        </div>
        <span className="spacer" />
        <span className="faint">{effective === 'task' ? `creates an issue in the tracker${agent?.activeRunIds.length ? ' · queued as Next (agent busy)' : ''}` : active ? (run?.adapter === 'claude-headless' ? 'delivered live' : 'delivered as the next turn') : 'resumes the same vendor session'}</span>
      </div>
      <textarea
        rows={effective === 'task' ? 3 : 2}
        value={text}
        placeholder={effective === 'task' ? 'Task title on the first line\nDetails, acceptance criteria… (⌘↵ to start)' : `Message ${agent?.config.name ?? 'the agent'}… (⌘↵ to send)`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="row">
        {effective === 'task' && <input placeholder="Allowed paths, comma separated (empty = whole repo)" value={paths} onChange={(e) => setPaths(e.target.value)} />}
        <span className="spacer" />
        {note && <span className="small faint">{note}</span>}
        <button className="btn primary sm" disabled={busy || !text.trim()} onClick={() => void submit()}>
          {effective === 'task' ? 'Start task' : 'Send'}
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function HandoffCard({ h, run }: { h: Handoff; run: Run }) {
  return (
    <section className="card">
      <div className="card-h">
        <h2>Handoff</h2>
        <Badge tone={h.source === 'skeleton' ? 'warn' : 'accent'}>{h.source.replace('_', ' ')}</Badge>
      </div>
      <div className="card-b col small">
        <div style={{ fontSize: 13.5, fontWeight: 550 }}>{h.done}</div>
        {h.evidence.map((e, i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
            <Badge tone={e.verified ? 'ok' : 'warn'}>{e.verified ? 'verified' : 'claimed'}</Badge>
            <div className="grow">
              <code>{e.command}</code> → {e.result || '–'}
              {e.note && <div className="faint">{e.note}</div>}
            </div>
          </div>
        ))}
        <div className="kv">
          <span>Commit</span>
          <span className="mono">
            {h.commit ? `${h.commit.sha.slice(0, 10)}${h.commit.branch ? ` on ${h.commit.branch}` : ''}` : 'none'} {h.commit && <Badge tone={h.commit.verified ? 'ok' : 'warn'}>{h.commit.verified ? 'on branch' : 'unverified'}</Badge>}
          </span>
          <span>Blocked</span>
          <span>{h.blocked ? `${h.blocked.what}${h.blocked.on ? ` (on ${h.blocked.on})` : ''}` : 'no'}</span>
          <span>Next</span>
          <span>{h.next ?? '–'}</span>
          <span>Run</span>
          <span className="mono faint">{run.id}</span>
        </div>
      </div>
    </section>
  );
}

function RelayBox({ runId, prompt }: { runId: string; prompt: string }) {
  const { busy, error, run } = useAction();
  const [text, setText] = useState('');
  return (
    <section className="card">
      <div className="card-h">
        <h2>Relay</h2>
        <span className="spacer" />
        <Copy text={prompt} label="Copy prompt" />
      </div>
      <div className="card-b col">
        <div className="small muted">Paste the prompt into the agent's app. When it replies, paste the whole reply (with its handoff block) here.</div>
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'### Handoff\nDone: …'} />
        <button className="btn primary sm" style={{ alignSelf: 'flex-start' }} disabled={busy || !text.trim()} onClick={() => void run(() => post(`/api/runs/${runId}/relay`, { text }))}>
          Submit reply
        </button>
        <ErrorLine error={error} />
      </div>
    </section>
  );
}

function ModelCard({ state, agentId }: { state: ControlState; agentId: string }) {
  const a = state.agents[agentId];
  const { busy, error, run } = useAction();
  const visible = a.models.available.filter((m) => !m.hidden);
  return (
    <section className="card">
      <div className="card-h">
        <h2>Model</h2>
        <span className="spacer" />
        <button className="btn sm ghost" disabled={busy} onClick={() => void run(() => post(`/api/agents/${agentId}/probe`))}>
          Re-check
        </button>
      </div>
      <div className="card-b col small">
        <div className="kv">
          <span>Configured</span>
          <span className="mono">
            {a.config.model}
            {a.config.model_family ? ` (${a.config.model_family})` : ''}
            {a.config.effort ? ` @ ${a.config.effort}` : ''}
          </span>
          <span>Newest eligible</span>
          <span className="mono">{a.models.newest ?? 'unknown'}</span>
          <span>Last served</span>
          <span className="mono">{a.models.current ?? '–'}</span>
          <span>Checked</span>
          <span>{a.models.checkedAt ? `${ago(a.models.checkedAt)} ago` : 'never'}</span>
        </div>
        {visible.length > 0 && (
          <select
            disabled={busy}
            value=""
            onChange={(e) => {
              if (e.target.value) void run(() => post(`/api/agents/${agentId}/model`, { model: e.target.value }));
            }}
          >
            <option value="">Swap model…</option>
            <option value="newest">newest (follow the newest eligible)</option>
            {visible.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.id === a.models.newest ? ' ★ newest' : ''}
              </option>
            ))}
          </select>
        )}
        <ErrorLine error={error} />
      </div>
    </section>
  );
}

function ResumeAgent({ id }: { id: string }) {
  const { busy, error, run } = useAction();
  return (
    <div className="row">
      <button className="btn sm" disabled={busy} onClick={() => void run(() => post(`/api/agents/${id}/resume`))}>
        Clear pause / limit
      </button>
      <ErrorLine error={error} />
    </div>
  );
}
