// SPDX-License-Identifier: Apache-2.0
// Owner decisions, built for a phone: quick answers, the evidence behind each question, risk and
// urgency, and a second confirmation step for anything irreversible. A button never grants
// permission by itself: the daemon only acts on a durable answer bound to one exact action.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Actor, ControlState, Decision, EventEnvelope } from '@acc/core';
import { Badge, ErrorLine, useAction, useTick } from '../components/common';
import { api, post } from '../lib/api';
import { ago, until, type Tone } from '../lib/format';
import { JevAdvice } from '../components/Jev';
import { useOnline } from '../lib/offline';
import { canMutate, identityRevision, useRemoteSession } from '../lib/remote';

const URGENCY_RANK: Record<Decision['urgency'], number> = { critical: 0, high: 1, normal: 2, low: 3 };
const RISK_TONE: Record<NonNullable<Decision['risk']>, Tone> = { low: 'ok', medium: 'warn', high: 'crit' };
const URGENCY_TONE: Record<Decision['urgency'], Tone> = { critical: 'crit', high: 'warn', normal: 'info', low: 'idle' };
const channel = () => (typeof window !== 'undefined' && window.innerWidth < 640 ? 'phone' : 'web');

export const isOpenDecision = (d: Decision) => !d.answeredAt && !d.consumedAt;
const awaitingMerge = (d: Decision) => d.kind === 'merge' && d.answer === 'merge' && Boolean(d.answeredAt) && !d.consumedAt;

function actorName(state: ControlState, a: Actor | null | undefined): string {
  if (!a) return 'unknown';
  if (a.type === 'human') return a.id === 'owner' ? 'you' : a.id;
  if (a.type === 'agent') return state.agents[a.id]?.config.name ?? a.id;
  return 'One Connect';
}

export function Decisions({ state }: { state: ControlState }) {
  const [search] = useSearchParams();
  const focused = search.get('focus');
  const focusReady = Boolean(focused && state.decisions[focused]);
  useEffect(() => { if (focused && focusReady) document.getElementById(`decision-${focused}`)?.focus(); }, [focused, focusReady]);
  const now = useTick(15_000);
  const all = Object.values(state.decisions);
  const open = all.filter(isOpenDecision).sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.createdAt.localeCompare(b.createdAt));
  const stuck = all.filter(awaitingMerge);
  const past = all.filter((d) => !isOpenDecision(d) && !awaitingMerge(d)).sort((a, b) => (b.answeredAt ?? b.consumedAt ?? b.createdAt).localeCompare(a.answeredAt ?? a.consumedAt ?? a.createdAt)).slice(0, 30);
  return (
    <div className="page col decisions-page" style={{ gap: 16 }}>
      <div className="row wrap">
        <h1 style={{ fontSize: 20 }}>Decisions</h1>
        <span className="faint small">{open.length ? `${open.length} waiting for you` : 'nothing waiting'}</span>
      </div>
      <p className="small muted">Only your recorded answer authorizes an action, and only the exact action shown. Recommendations from agents or Jev are advice, never approval. Irreversible answers ask you to confirm once more.</p>
      {open.length === 0 && stuck.length === 0 && <div className="empty card card-b">No open decisions.</div>}
      {stuck.map((d) => <DecisionCard key={d.id} d={d} state={state} now={now} />)}
      {open.map((d) => <DecisionCard key={d.id} d={d} state={state} now={now} />)}
      {past.length > 0 && (
        <section className="col" style={{ gap: 8 }}>
          <h2>Answered</h2>
          {past.map((d) => <DecisionCard key={d.id} d={d} state={state} now={now} />)}
        </section>
      )}
    </div>
  );
}

export function DecisionCard({ d, state, now }: { d: Decision; state: ControlState; now: number }) {
  const { busy: working, error, run, setError } = useAction();
  const online = useOnline();
  const { session, mode } = useRemoteSession();
  const authRev = identityRevision();
  const scopeKey = session?.scopes.join(',') ?? '';
  const actionKey = d.action?.hash ?? '';
  // Offline or lost authorization: answers are disabled and never queued.
  const busy = working || !online || !canMutate(session, 'decisions');
  const [confirm, setConfirm] = useState<{ answer: string; nonce: string; expiresAt: string | null; authorityRevision: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const prepareGen = useRef(0);
  const item = d.workItemId ? state.workItems[d.workItemId] : null;
  const openNow = isOpenDecision(d);

  // Invalidate before the new card can receive a click; a delayed initial passive effect
  // would cancel the user's first legitimate preparation request after it had started.
  useLayoutEffect(() => { prepareGen.current++; setConfirm(null); }, [online, mode, authRev, scopeKey, d.id, d.answeredAt, d.consumedAt, actionKey]);
  useEffect(() => {
    if (confirm?.expiresAt && Date.parse(confirm.expiresAt) <= now) setConfirm(null);
  }, [now, confirm?.expiresAt]);

  const answer = async (option: string, nonce: string | null) => {
    if (!canMutate(session, 'decisions') || (nonce && confirm?.authorityRevision !== identityRevision())) throw new Error('Project access changed. Reload this Decision before answering.');
    const r = await post<{ settings?: { saved: boolean }; cost?: { saved: boolean }; merge?: { merged: boolean; mergeSha?: string; reason?: string }; environment?: { executed: boolean }; docker?: { executed: boolean; exitCode?: number | null }; connection?: { state: string }; tool?: { request: { connectorId: string; tool: string; decisionId: string; status: string }; executed: boolean }; remote?: { tunnel: { state: string; detail: string } }; notification?: unknown; release?: { executed: boolean; status: string; evidence?: { summary: string } } }>(`/api/decisions/${d.id}/answer`, { answer: option, nonce, channel: channel() });
    setConfirm(null);
    if (r.settings) setResult(r.settings.saved ? 'Reviewed project settings saved. Remote connections still require their own approval.' : 'Settings unchanged.');
    else if (r.cost) setResult(r.cost.saved ? 'Approved settings saved. This agent may use paid tokens when you dispatch an issue.' : 'Paid configuration denied. Agent settings unchanged.');
    else if (r.merge) setResult(r.merge.merged ? `Merged locally as ${r.merge.mergeSha?.slice(0, 10)}. Nothing was pushed.` : `Not merged: ${r.merge.reason}`);
    else if (r.release) setResult(r.release.evidence?.summary?.includes('Human attestation') ? r.release.evidence.summary : r.release.executed ? 'Release command finished.' : `${r.release.status}. ${r.release.evidence?.summary ?? ''}`);
    else if (r.environment) setResult(r.environment.executed ? 'Command started. Follow its progress in Project Docker.' : 'Command denied.');
    else if (r.docker) setResult(r.docker.executed ? `Command exited with ${r.docker.exitCode ?? 'unknown status'}.` : 'Command denied.');
    else if (r.connection) setResult(`Connection is ${r.connection.state}.`);
    else if (r.tool) {
      const receipt = r.tool.request;
      if (d.action?.kind !== 'connector_tool' || !receipt || receipt.decisionId !== d.id || receipt.connectorId !== d.action.connectorId || receipt.tool !== d.action.tool) throw new Error('Plugin response does not match this Decision. Inspect its audit history.');
      const outcomes: Record<string, string> = {
        pending: 'Plugin action is awaiting approval. Nothing has started.',
        running: 'Plugin action is running. Follow its recorded result in Connectors.',
        succeeded: 'Plugin tool finished. View its recorded output in Connectors.',
        error: 'Plugin action reported an error. Inspect its result in Connectors.',
        uncertain: 'Plugin action may have run. Inspect its result before requesting anything again.',
        denied: 'Plugin action denied. Nothing was invoked.',
        expired: 'Plugin request expired. Nothing was invoked.',
        invalidated: 'Plugin request is no longer valid. Nothing was invoked.',
      };
      setResult(Object.hasOwn(outcomes, receipt.status) ? outcomes[receipt.status] : 'Plugin action returned an unknown status. Inspect its result in Connectors.');
    }
    else if (r.remote) setResult(`Tunnel is ${r.remote.tunnel.state}: ${r.remote.tunnel.detail}`);
    else if (r.notification) setResult('Notification Decision recorded. Its audit trail shows the delivery outcome.');
  };

  const choose = (option: string) =>
    run(async () => {
      const gen = ++prepareGen.current;
      const binding = identityRevision();
      const p = await post<{ confirm: boolean; nonce: string | null; expiresAt: string | null }>(`/api/decisions/${d.id}/prepare`, { answer: option });
      if (gen !== prepareGen.current || binding !== identityRevision() || !canMutate(session, 'decisions')) return;
      if (p.confirm && p.nonce) setConfirm({ answer: option, nonce: p.nonce, expiresAt: p.expiresAt, authorityRevision: binding });
      else await answer(option, null);
    });

  const retry = () =>
    run(async () => {
      const r = await post<{ merged: boolean; mergeSha?: string; reason?: string }>(`/api/merges/${d.id}/execute`);
      setResult(r.merged ? `Merged locally as ${r.mergeSha?.slice(0, 10)}. Nothing was pushed.` : `Not merged: ${r.reason}`);
    });

  const recommender = d.recommendedBy ? actorName(state, d.recommendedBy) : null;
  return (
    <article id={`decision-${d.id}`} tabIndex={-1} className={`card decision-card${openNow ? ' open' : ''}`} aria-label={d.question}>
      <div className="card-b col" style={{ gap: 10 }}>
        <div className="row wrap small" style={{ gap: 6 }}>
          <Badge tone={URGENCY_TONE[d.urgency]}>{d.urgency}</Badge>
          {d.risk && <Badge tone={RISK_TONE[d.risk]}>{d.risk} risk</Badge>}
          {d.irreversible && <Badge tone="crit">irreversible</Badge>}
          {d.kind && d.kind !== 'question' && <Badge>{d.kind}</Badge>}
          {item && <Link to={`/board?item=${item.id}`} className="mono">{item.key ?? item.title}</Link>}
          <span className="spacer" />
          <span className="faint">{ago(d.createdAt, now)} ago</span>
        </div>
        <div className="decision-q">{d.question}</div>
        <DecisionEvidence evidence={d.evidence} />
        {d.evidenceLinks.length > 0 && <div className="row wrap small">{d.evidenceLinks.map((l) => <a key={l} href={l} target="_blank" rel="noreferrer">{l}</a>)}</div>}
        {d.recommendation && (
          <div className="banner small tone-info">
            Suggested: <b>{d.recommendation}</b>{recommender ? ` by ${recommender}` : ''}. A recommendation, not an approval.{d.rationale ? ` ${d.rationale}` : ''}
          </div>
        )}
        <JevAdvice d={d} now={now} />
        {openNow && (!online || mode === 'offline' || mode === 'unauthorized' || mode === 'checking') && <div className="banner small tone-warn" role="status">{!online || mode === 'offline' ? 'Offline: answering is disabled and nothing is queued.' : mode === 'checking' ? 'Checking project access…' : 'This browser is not authorized to answer Decisions right now.'}</div>}
        {openNow && (
          <div className="decision-answers">
            {d.options.map((o) => (
              <button key={o} className={`btn${d.confirmOptions?.includes(o) ? ' primary' : /^(reject|deny|no)$/i.test(o) ? ' danger' : ''}`} disabled={busy} onClick={() => void choose(o)}>
                {o}
                {d.confirmOptions?.includes(o) ? '…' : ''}
              </button>
            ))}
          </div>
        )}
        {awaitingMerge(d) && (
          <div className="col" style={{ gap: 6 }}>
            <div className="banner small tone-warn">You approved this merge but it has not run: {d.outcome ?? 'waiting'}.</div>
            <div className="row wrap">
              <button className="btn primary" disabled={busy} onClick={() => void retry()}>Try the merge again</button>
            </div>
          </div>
        )}
        {!openNow && (
          <div className="small muted">
            {d.answeredAt ? <>Answered <b>{d.answer}</b> by {actorName(state, d.answeredBy)}{d.channel ? ` on ${d.channel}` : ''} {ago(d.answeredAt, now)} ago{d.confirmedAt ? ' · confirmed' : ''}.</> : 'Not answered.'}
            {d.outcome ? ` Outcome: ${d.outcome}` : ''}
          </div>
        )}
        {result && <div className="banner small" role="status">{result}</div>}
        <ErrorLine error={error} />
        <History d={d} state={state} />
      </div>
      {confirm && (
        <div className="modal-bg confirm-sheet-bg" onClick={() => setConfirm(null)}>
          <div className="card modal confirm-sheet" role="alertdialog" aria-modal="true" aria-label="Confirm" onClick={(e) => e.stopPropagation()}>
            <div className="card-b col" style={{ gap: 10 }}>
              <h2>Confirm: {confirm.answer}</h2>
              <div>{d.question}</div>
              {d.action?.kind === 'connector_tool' && <DecisionEvidence evidence={d.evidence} />}
              {d.action?.kind === 'merge' && (
                <div className="kv small">
                  <span>Source</span><span className="mono">{d.action.sourceBranch} @ {d.action.sourceSha.slice(0, 12)}</span>
                  <span>Into</span><span className="mono">{d.action.target} @ {d.action.targetSha.slice(0, 12)}</span>
                  <span>Scope</span><span>Local merge only. Nothing is pushed or deployed.</span>
                </div>
              )}
              <div className="small muted">This can’t be undone from here.{confirm.expiresAt ? ` The confirmation expires in ${until(confirm.expiresAt, now)}.` : ''} If anything above changes, the daemon refuses and nothing happens.</div>
              <div className="decision-answers">
                <button className="btn" disabled={busy} onClick={() => { setConfirm(null); setError(null); }}>Cancel</button>
                <button className="btn primary solid" disabled={busy} onClick={() => void run(() => answer(confirm.answer, confirm.nonce))}>Yes, {confirm.answer}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function DecisionEvidence({ evidence }: { evidence: Decision['evidence'] }) {
  if (!evidence?.length) return null;
  return <ul className="decision-evidence">
    {evidence.map((e, i) => <li key={i} className={e.ok === false ? 'bad' : e.ok ? 'good' : ''}>
      <span aria-hidden>{e.ok === false ? '✗' : e.ok ? '✓' : '•'}</span>
      <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><b>{e.label}</b> {e.detail}</span>
    </li>)}
  </ul>;
}

function History({ d, state }: { d: Decision; state: ControlState }) {
  const [events, setEvents] = useState<EventEnvelope[] | null>(null);
  const { busy, error, run } = useAction();
  const load = () => run(async () => setEvents((await api<{ events: EventEnvelope[] }>(`/api/decisions/${d.id}/history`)).events));
  if (!events) return <div><button className="btn sm" disabled={busy} onClick={() => void load()}>Audit history</button><ErrorLine error={error} /></div>;
  return (
    <ol className="decision-history small">
      {events.map((e) => (
        <li key={e.seq}>
          <span className="faint mono">{new Date(e.ts).toLocaleString()}</span> <b>{e.type.replace('.', ' ').replace(/_/g, ' ')}</b> by {actorName(state, e.actor)}
          {historyDetail(e)}
        </li>
      ))}
    </ol>
  );
}

function historyDetail(e: EventEnvelope): string {
  const data = e.data as { answer?: string; recommendation?: string; outcome?: string; reason?: string; status?: string; merge?: { mergeSha: string }; confirmed?: boolean; channel?: string };
  if (e.type === 'decision.answered') return `: ${data.answer}${data.confirmed ? ' (confirmed)' : ''}${data.channel ? ` via ${data.channel}` : ''}`;
  if (e.type === 'decision.recommended') return `: ${data.recommendation} (advice)`;
  if (e.type === 'decision.consumed') return `: ${data.outcome}`;
  if (e.type === 'merge.refused') return `: ${data.reason}`;
  if (e.type === 'merge.completed') return `: ${data.merge?.mergeSha.slice(0, 10)}`;
  if (e.type === 'merge.post_checks') return `: ${data.status}`;
  if (e.type === 'decision.confirmation_requested') return `: ${data.answer}`;
  return '';
}
