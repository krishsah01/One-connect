// SPDX-License-Identifier: Apache-2.0
// The phone home: what needs you, what every agent is doing, usage, alerts and the kill switch.
// Built for one thumb: 44 px targets, one column, nothing hover-only. Every change is refused while
// offline, answers that cannot be undone ask twice, and the kill switch can be engaged here but is
// released only on the Mac when this page runs through the tunnel.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ControlState } from '@acc/core';
import { isActiveRun, remoteDecisionAccess } from '@acc/core';
import { ApprovalCard, Badge, BillingBadge, ErrorLine, Light, UsageMeter, useAction, useTick } from '../components/common';
import { NotificationInbox } from '../components/NotificationInbox';
import { post } from '../lib/api';
import { AGENT_TONE, RUN_TONE, ago } from '../lib/format';
import { useOnline } from '../lib/offline';
import { can, canMutate, useRemoteSession } from '../lib/remote';
import { useLive } from '../lib/store';
import { DecisionCard, isOpenDecision } from './Decisions';

export function Phone({ state }: { state: ControlState }) {
  const now = useTick(15_000);
  const { conn } = useLive();
  const online = useOnline();
  const { session, mode } = useRemoteSession();
  const open = Object.values(state.decisions).filter(isOpenDecision).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const approvals = Object.values(state.approvals).filter((a) => !a.resolvedAt);
  const runs = Object.values(state.runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  const waiting = open.length + approvals.length;
  return (
    <div className="page col phone-page" style={{ gap: 14 }}>
      <header className="row wrap" style={{ gap: 8 }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22 }}>{state.project?.name ?? 'Project'}</h1>
          <span className="small muted">{mode === 'paired' && session ? `Paired phone · ${session.label}` : mode === 'offline' && session ? `Offline · last paired as ${session.label}` : mode === 'local' ? 'Phone view' : mode === 'checking' ? 'Checking access…' : 'Phone view'}</span>
        </div>
        <Badge tone={!online || mode === 'offline' ? 'warn' : mode === 'unauthorized' ? 'crit' : conn === 'live' ? 'ok' : 'warn'}>{!online || mode === 'offline' ? 'offline' : mode === 'unauthorized' ? 'unauthorized' : conn === 'live' ? 'live' : 'reconnecting'}</Badge>
      </header>
      {mode === 'offline' && session && <div className="banner small tone-warn" role="status">Offline: showing the last paired identity for reference. Approvals and changes are disabled until you reconnect.</div>}
      {mode === 'unauthorized' && <div className="banner small tone-warn" role="status">This phone is not paired or its session expired. Pair again from the Mac under Phone &amp; alerts.</div>}
      <KillSwitch state={state} online={online && mode !== 'offline' && mode !== 'unauthorized' && mode !== 'checking'} remote={mode === 'paired'} allowed={canMutate(session, 'kill_switch')} />
      <section className="col" style={{ gap: 10 }} aria-label="Waiting for you">
        <div className="row"><h2>Waiting for you</h2><span className="faint small">{waiting ? `${waiting} open` : 'nothing waiting'}</span></div>
        {waiting === 0 && <div className="empty card card-b">Nothing is waiting for you.</div>}
        {approvals.map((ap) => <div key={ap.id} className="card"><div className="card-b">{can(session, 'decisions') ? <ApprovalCard ap={ap} agentName={state.agents[ap.agentId]?.config.name ?? ap.agentId} now={now} /> : <div>{ap.title}<p className="small muted">This phone was not granted project Decisions.</p></div>}</div></div>)}
        {open.map((d) => {
          const access = session ? remoteDecisionAccess(d, session.scopes, Boolean(d.evidence?.some(e => e.label === 'Delivery ID'))) : { allow: true as const };
          return access.allow ? <DecisionCard key={d.id} d={d} state={state} now={now} /> : <article key={d.id} className="card card-b" aria-label={d.question}><div>{d.question}</div><p className="small muted">{access.reason}</p></article>;
        })}
      </section>
      <section className="col" style={{ gap: 10 }} aria-label="Agents">
        <h2>Agents</h2>
        {Object.values(state.agents).map((a) => {
          const item = a.queue.now ? state.workItems[state.assignments[a.queue.now]?.workItemId ?? ''] : null;
          const run = a.activeRunIds.map((id) => state.runs[id]).filter(Boolean).at(-1);
          return (
            <article key={a.id} className="card"><div className="card-b col" style={{ gap: 6 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <Light tone={AGENT_TONE[a.status]} pulse={a.status === 'running'} />
                {session ? <span className="grow" style={{ fontWeight: 600 }}>{a.config.name}</span> : <Link to={`/agents/${a.id}`} className="grow" style={{ fontWeight: 600 }}>{a.config.name}</Link>}
                <Badge tone={AGENT_TONE[a.status]}>{a.status}</Badge>
              </div>
              <div className="small muted">{item ? `${item.key ?? ''} ${item.title}` : 'Nothing in Now.'}{a.queue.next.length ? ` · ${a.queue.next.length} next` : ''}</div>
              {run?.lastMeaningful && <div className="small faint ellipsis">{run.lastMeaningful.summary}</div>}
              <BillingBadge agent={a} />
              <UsageMeter usage={a.usage} />
              {a.limitedUntil && <div className="small">Usage limited{a.limitedUntil === 'unknown' ? '' : ` until ${new Date(a.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}.</div>}
              {run && can(session, 'transcript') && <Link className="btn" to={`/runs/${run.id}`}>Watch live transcript</Link>}
            </div></article>
          );
        })}
      </section>
      {can(session, 'transcript') && runs.length > 0 && (
        <section className="col" style={{ gap: 8 }} aria-label="Recent runs">
          <h2>Recent runs</h2>
          {runs.map((r) => (
            <Link key={r.id} className="card phone-run" to={`/runs/${r.id}`}>
              <span className="card-b row" style={{ gap: 8 }}>
                <Badge tone={RUN_TONE[r.state]}>{r.state}</Badge>
                <span className="grow ellipsis">{state.agents[r.agentId]?.config.name} · {state.workItems[r.workItemId]?.key ?? ''} {state.workItems[r.workItemId]?.title ?? ''}</span>
                <span className="faint small">{ago(r.lastEventAt ?? r.createdAt, now)}{isActiveRun(r) ? '' : ' ago'}</span>
              </span>
            </Link>
          ))}
        </section>
      )}
      <NotificationInbox />
    </div>
  );
}

/** Two steps: arm, then confirm. Releasing needs the Mac when this page is a paired phone. */
export function KillSwitch({ state, online, remote, allowed }: { state: ControlState; online: boolean; remote: boolean; allowed: boolean }) {
  const [armed, setArmed] = useState(false);
  const { busy, error, run } = useAction();
  const engaged = state.killSwitch.engaged;
  const name = state.project?.name ?? 'this project';
  useEffect(() => { if (!online || !allowed || engaged) setArmed(false); }, [online, allowed, engaged]);
  return (
    <section className={`card kill-card${engaged ? ' engaged' : ''}`} aria-label="Kill switch">
      <div className="card-b col" style={{ gap: 8 }}>
        <div className="row"><h2>Kill switch</h2><span className="spacer" />{engaged && <Badge tone="crit">engaged</Badge>}</div>
        {engaged ? (
          <>
            <div className="small">Every run in {name} was stopped and dispatch is blocked{state.killSwitch.by ? ` (by ${state.killSwitch.by})` : ''}.</div>
            {remote ? <div className="small muted">Release it on the Mac. A paired phone can stop work but cannot restart it.</div> : <button className="btn" disabled={busy || !online} onClick={() => void run(() => post('/api/kill-switch', { engaged: false }))}>Release the kill switch</button>}
          </>
        ) : !allowed ? (
          <div className="small muted">This phone was not granted the kill switch.</div>
        ) : !armed ? (
          <button className="btn danger" disabled={!online} onClick={() => setArmed(true)}>Stop all runs…</button>
        ) : (
          <div className="col" role="alertdialog" aria-label="Confirm kill switch" style={{ gap: 8 }}>
            <div>Stop <b>every</b> agent run in {name} now and block new dispatch?</div>
            <div className="small muted">Running work ends immediately. Only the Mac can release this.</div>
            <div className="decision-answers">
              <button className="btn" onClick={() => setArmed(false)}>Cancel</button>
              <button className="btn danger solid" disabled={busy || !online} onClick={() => void run(async () => { await post('/api/kill-switch', { engaged: true }); setArmed(false); })}>Yes, stop everything</button>
            </div>
          </div>
        )}
        {!online && <div className="small">Offline: the kill switch cannot be used until you reconnect. Nothing is queued.</div>}
        <ErrorLine error={error} />
      </div>
    </section>
  );
}
