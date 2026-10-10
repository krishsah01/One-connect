// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Independent review and local integration merge controls for one work item.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ControlState, MergeGate, ReviewRecord, WorkItem } from '@acc/core';
import { reviewsForItem } from '@acc/core';
import { Badge, ErrorLine, useAction } from './common';
import { api, post } from '../lib/api';
import { type Tone } from '../lib/format';

const GATE_TONE = (g: MergeGate): Tone => (g.ok ? 'ok' : 'crit');

export function ReviewMergePanel({ item, state }: { item: WorkItem; state: ControlState }) {
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const [gates, setGates] = useState<MergeGate[] | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const reviews = reviewsForItem(state, item.id);
  const merge = Object.values(state.merges ?? {}).filter((m) => m.workItemId === item.id).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const reviewers = Object.values(state.agents).filter((a) => a.id !== item.ownerAgentId && a.config.enabled !== false && a.config.mode !== 'coordinator-only');

  useEffect(() => {
    void run(async () => {
      const r = await api<{ gates: MergeGate[] }>(`/api/work-items/${item.id}/merge-gates`);
      setGates(r.gates);
    });
  }, [item.id, item.state, item.evidence.length, reviews.length, merge?.postChecks.status]);

  const requestReview = () =>
    run(async () => {
      if (!reviewer) throw new Error('choose a reviewer');
      await post(`/api/work-items/${item.id}/review-request`, { reviewerAgentId: reviewer });
      setReviewer('');
    });

  const requestMerge = () =>
    run(async () => {
      const r = await post<{ decision: { id: string } }>(`/api/work-items/${item.id}/merge-request`);
      navigate(`/decisions?focus=${encodeURIComponent(r.decision.id)}`);
    });

  const recordAcceptance = () =>
    run(async () => {
      if (!acceptance.trim()) throw new Error('describe what you verified');
      await post(`/api/work-items/${item.id}/acceptance`, { summary: acceptance.trim(), env: 'local' });
      setAcceptance('');
    });

  return (
    <div className="col" style={{ gap: 10 }}>
      <h2>Review & merge</h2>
      <p className="small muted">Reviews bind to an exact commit SHA. A merge needs an independent approval, green required checks and your decision on the Decisions page. Nothing is pushed from here.</p>
      <section className="col" style={{ gap: 6 }}>
        <div className="row wrap">
          <b className="small">Reviews</b>
          <span className="spacer" />
          <select value={reviewer} onChange={(e) => setReviewer(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="">Reviewer…</option>
            {reviewers.map((a) => <option key={a.id} value={a.id}>{a.config.name}</option>)}
          </select>
          <button className="btn sm" disabled={busy || !reviewer} onClick={() => void requestReview()}>Request review</button>
        </div>
        {reviews.length === 0 && <div className="small faint">No recorded reviews yet.</div>}
        {reviews.map((r) => <ReviewRow key={r.id} r={r} state={state} />)}
      </section>
      {gates && (
        <section className="col" style={{ gap: 6 }}>
          <div className="row wrap">
            <b className="small">Merge gates</b>
            <span className="spacer" />
            {['handoff_received', 'in_review', 'approved', 'changes_requested'].includes(item.state) && (
              <button className="btn sm primary" disabled={busy || gates.some((g) => !g.ok)} onClick={() => void requestMerge()}>Request merge decision</button>
            )}
          </div>
          <ul className="decision-evidence">
            {gates.map((g) => (
              <li key={g.id} className={g.ok ? 'good' : 'bad'}>
                <span aria-hidden>{g.ok ? '✓' : '✗'}</span>
                <span><b>{g.label}</b> {g.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {merge && (
        <section className="col" style={{ gap: 6 }}>
          <b className="small">Last merge</b>
          <div className="small">
            <span className="mono">{merge.target}</span> @ <span className="mono">{merge.mergeSha.slice(0, 12)}</span>
            · post-merge checks <Badge tone={merge.postChecks.status === 'passed' ? 'ok' : merge.postChecks.status === 'failed' ? 'crit' : 'warn'}>{merge.postChecks.status}</Badge>
          </div>
        </section>
      )}
      {['merged', 'release_candidate', 'deployed'].includes(item.state) && merge?.postChecks.status === 'passed' && (
        <form className="col" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void recordAcceptance(); }}>
          <b className="small">Acceptance (marks Done)</b>
          <textarea rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="What did you verify before marking this done?" />
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !acceptance.trim()}>Record acceptance</button>
            <Link to="/decisions" className="btn sm">Open decisions</Link>
          </div>
        </form>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function ReviewRow({ r, state }: { r: ReviewRecord; state: ControlState }) {
  const who = r.reviewer.type === 'agent' ? (state.agents[r.reviewer.id]?.config.name ?? r.reviewer.id) : 'owner';
  return (
    <div className="row small wrap" style={{ alignItems: 'flex-start' }}>
      <Badge tone={r.staleAt ? 'warn' : r.verdict === 'approve' ? 'ok' : 'crit'}>{r.staleAt ? 'stale' : r.verdict}</Badge>
      <div className="grow col" style={{ gap: 2 }}>
        <div><b>{who}</b> at <span className="mono">{r.targetSha.slice(0, 12)}</span>{r.sourceBranch ? ` on ${r.sourceBranch}` : ''}</div>
        {r.summary && <div className="muted">{r.summary}</div>}
        {r.findings.length > 0 && <ul className="small">{r.findings.map((f) => <li key={f.id}>{f.severity}: {f.title}{f.followUpWorkItemId ? ` → ${state.workItems[f.followUpWorkItemId]?.key ?? 'follow-up'}` : ''}</li>)}</ul>}
        {r.staleAt && <div className="crit-text">{r.staleReason}</div>}
      </div>
      <Badge tone={GATE_TONE({ id: 'review', label: '', ok: !r.staleAt, detail: '' })}>{r.source}</Badge>
    </div>
  );
}
