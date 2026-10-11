// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The Review sheet: what still needs attention, the evidence a release carries, your own review, and
// the handoff to engineering. Static findings never approve anything; a person does, on a frozen
// release bound to the current project design system.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { mockGate, REVIEW_CHECKLIST, type ControlState, type DesignDocument, type DesignDocumentFinding } from '@acc/core';
import { ErrorLine } from '../../common';
import { api, post } from '../../../lib/api';
import { Icon } from '../workspace/DocumentRenderer';
import type { RecordView } from '../workspace/useDesignDocument';
import { designAgents } from './model';

export function ReviewSheet({ doc, record, state, agentId, findings, onClose, onSelect, onAsk, mutate, onNotice }: {
  doc: DesignDocument; record: RecordView; state: ControlState; agentId: string; findings: DesignDocumentFinding[]; onClose: () => void;
  onSelect: (nodeId: string | undefined, screenId: string | undefined) => void; onAsk: (request: string, kind: 'repair' | 'edit') => void;
  mutate: <T>(fn: () => Promise<T>) => Promise<T | undefined>; onNotice: (text: string) => void;
}) {
  const errors = findings.filter(f => f.severity === 'error'), warnings = findings.filter(f => f.severity === 'warning');
  const artifact = record.artifactId ? state.mocks?.[record.artifactId] : null, rev = artifact?.revisions.at(-1);
  const gate = rev ? mockGate(rev, state.design?.hash ?? null) : null;
  const current = Boolean(rev?.document && rev.document.version === doc.version);
  const approved = Boolean(current && gate?.state === 'approved');
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [reviewer, setReviewer] = useState(''), [builder, setBuilder] = useState(agentId);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let alive = true; setBlockers(null); void api<{ blockers: string[] }>(`/api/designer/documents/${doc.id}/release-readiness`).then(r => alive && setBlockers(r.blockers)).catch(() => alive && setBlockers([])); return () => { alive = false; }; }, [doc.id, doc.version, state.design?.hash]);
  useEffect(() => { setChecked([]); }, [rev?.hash]);
  const act = async (fn: () => Promise<unknown>, done?: string) => { setBusy(true); setError(''); try { await mutate(fn); if (done) onNotice(done); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const agents = designAgents(state);
  const others = Object.values(state.agents).filter(a => a.config.enabled !== false && a.config.adapter !== 'relay');
  const where = (f: DesignDocumentFinding) => [f.screenId && doc.screens.find(s => s.id === f.screenId)?.name, f.nodeId && doc.nodes[f.nodeId]?.name, f.componentId && doc.components[f.componentId]?.name, f.tokenId].filter(Boolean).join(' › ');
  const matchesSystem = Boolean(state.design && doc.systemHash === state.design.hash);
  const allChecked = REVIEW_CHECKLIST.every(c => checked.includes(c.id));
  const reviewedByYou = Boolean(current && rev?.reviews.some(r => r.decision === 'approved'));
  const gateNote = gate?.state === 'needs_independent_review' ? 'Approved by you. An independent review by another agent is needed before engineering can use it: choose a reviewer above and request it.'
    : gate?.state === 'changes_requested' ? 'Changes were requested on this revision. Make them, then release again.'
    : gate?.state === 'needs_review' ? 'Open findings need a decision under Mocks before approval holds.' : gate?.approval && !gate.approval.valid ? gate.approval.reason ?? 'The approval no longer holds.' : null;

  return <aside className="dz-side wide" aria-label="Review">
    <div className="dz-side-head"><h2>Review</h2><span className="sub">version {doc.version} · {doc.screens.length} screen{doc.screens.length === 1 ? '' : 's'}</span><span className="spacer" />
      <button type="button" className="dz-icon-btn" aria-label="Close review" onClick={onClose}><Icon name="close" size={14} /></button></div>
    <div className="dz-side-body">
      <ErrorLine error={error} />
      {errors.length > 0 && <section className="dz-group" aria-labelledby="dz-rv-attention">
        <h3 id="dz-rv-attention" data-tone="warn">Needs attention · {errors.length}</h3>
        {errors.slice(0, 12).map(f => <button key={f.id} type="button" className="dz-finding" onClick={() => onSelect(f.nodeId, f.screenId)}><span>{f.message}</span><span>{where(f) || f.rule}</span></button>)}
        {errors.length > 12 && <p className="dz-help">And {errors.length - 12} more.</p>}
        {agentId && <button type="button" className="dz-link" onClick={() => onAsk(`Fix these findings:\n${errors.slice(0, 20).map(f => `- ${f.message}${where(f) ? ` (${where(f)})` : ''}`).join('\n')}`, 'repair')}><Icon name="sparkle" size={13} /> Ask the agent to fix {errors.length === 1 ? 'this' : 'these'}</button>}
      </section>}
      {warnings.length > 0 && <section className="dz-group" aria-labelledby="dz-rv-check">
        <h3 id="dz-rv-check">Worth a look · {warnings.length}</h3>
        {warnings.slice(0, 8).map(f => <button key={f.id} type="button" className="dz-finding" onClick={() => onSelect(f.nodeId, f.screenId)}><span>{f.message}</span><span>{where(f) || f.rule}</span></button>)}
        {warnings.length > 8 && <p className="dz-help">And {warnings.length - 8} more.</p>}
      </section>}
      {findings.length === 0 && <p className="dz-help" style={{ color: 'var(--ok-text)' }}>No document findings. Static checks are not approval: the evidence below is.</p>}

      <section className="dz-group" aria-labelledby="dz-rv-evidence">
        <h3 id="dz-rv-evidence">Evidence</h3>
        <ul className="dz-list">
          <li><Mark state={state.design ? (matchesSystem ? 'pass' : 'warn') : 'warn'} /><span>Project design system</span><span className="spacer" /><span className="meta">{!state.design ? 'none published' : matchesSystem ? `v${state.design.version}` : `draft differs from v${state.design.version}`}</span></li>
          <li><Mark state={rev ? (current ? 'pass' : 'warn') : 'idle'} /><span>Frozen release</span><span className="spacer" /><span className="meta">{rev ? (current ? `revision ${rev.rev}` : `revision ${rev.rev} is older than this draft`) : 'not yet'}</span></li>
          {rev?.evidence.map(e => <li key={e.id}><Mark state={e.status === 'passed' ? 'pass' : e.status === 'failed' ? 'warn' : 'idle'} /><span>{e.summary}</span><span className="spacer" /><span className="meta">{e.kind}{e.executed ? '' : ' · not run'}</span></li>)}
          {rev && <li><Mark state={gate?.state === 'approved' ? 'pass' : gate?.state === 'needs_independent_review' ? 'warn' : 'idle'} /><span>Independent review</span><span className="spacer" />
            {gate?.state === 'approved' ? <span className="meta">approved</span> : <>
              <select aria-label="Independent reviewer" value={reviewer} onChange={e => setReviewer(e.target.value)} style={{ height: 28, fontSize: 12 }}><option value="">Reviewer…</option>{others.filter(a => a.id !== agentId).map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select>
              <button type="button" className="btn sm" disabled={busy || !reviewer || !artifact} onClick={() => void act(() => post(`/api/mocks/${artifact!.id}/revisions/${rev.rev}/review-request`, { agentId: reviewer }), 'Independent review prepared. It appears under Mocks.')}>Request</button></>}</li>}
        </ul>
        {artifact && <p className="dz-help"><Link to={`/mocks/${artifact.id}`}>History, screenshots and independent reviews</Link></p>}
      </section>

      {rev && current && !approved && !reviewedByYou && <section className="dz-group" aria-labelledby="dz-rv-yours">
        <h3 id="dz-rv-yours">Your review of revision {rev.rev}</h3>
        {REVIEW_CHECKLIST.map(c => <label key={c.id} className="dw-check" title={c.help}><input type="checkbox" checked={checked.includes(c.id)} onChange={e => setChecked(v => e.target.checked ? [...v, c.id] : v.filter(x => x !== c.id))} />{c.label}</label>)}
      </section>}

      {approved && <section className="dz-group" aria-labelledby="dz-rv-handoff">
        <h3 id="dz-rv-handoff">Hand off to engineering</h3>
        <div className="dz-pair">
          <label className="dw-field"><span className="dw-field-label">Build agent</span><select value={builder} onChange={e => setBuilder(e.target.value)}>{agents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label>
          <label className="dw-field"><span className="dw-field-label">Review agent</span><select value={reviewer} onChange={e => setReviewer(e.target.value)}><option value="">Choose…</option>{others.filter(a => a.id !== builder).map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label>
        </div>
        <p className="dz-help">Creates a build-and-review workflow bound to revision {rev!.rev}. Nothing starts until you dispatch it under Workflows.</p>
      </section>}
    </div>
    <div className="dz-side-foot">
      {!rev || !current ? <>
        <button type="button" className="btn primary dz-primary-wide" disabled={busy || blockers === null || blockers.length > 0 || !agentId} onClick={() => void act(() => post(`/api/designer/documents/${doc.id}/releases`, { expected: doc.version, agentId }), `Release created for version ${doc.version}. Review it below.`)}>{rev ? 'Release this version for review' : 'Create a release for review'}</button>
        <p className="dz-help">{blockers === null ? 'Checking readiness…' : blockers.length ? blockers.join(' ') : 'A release freezes this version, its tokens and its React source so the review is exact.'}</p>
      </> : !approved && reviewedByYou ? <>
        <button type="button" className="btn dz-primary-wide" disabled>Waiting for independent review</button>
        <p className="dz-help">{gateNote ?? 'Approval is recorded; the gate is not yet clear.'}</p>
      </> : !approved ? <>
        <button type="button" className="btn primary dz-primary-wide" disabled={busy || !allChecked} onClick={() => void act(() => post(`/api/mocks/${artifact!.id}/revisions/${rev.rev}/decision`, { decision: 'approved', note: 'Reviewed in the Designer.', checklist: REVIEW_CHECKLIST.map(c => ({ id: c.id, result: 'pass', basis: 'human', evidenceIds: [] })) }), `Approved revision ${rev.rev}.`)}>Approve revision {rev.rev}</button>
        <p className="dz-help">{allChecked ? 'Approving records your checklist and lets engineering use this exact release.' : 'Tick every check above after looking at the prototype in Play.'}</p>
      </> : <>
        <button type="button" className="btn primary dz-primary-wide" disabled={busy || !builder || !reviewer || builder === reviewer} onClick={() => void act(async () => { const w = await post<{ id: string }>(`/api/designer/releases/${artifact!.id}/${rev.rev}/handoff`, { agentId: builder, reviewAgentId: reviewer }); onNotice(`Workflow ${w.id} prepared under Workflows. Nothing has started.`); })}>Prepare the build workflow</button>
        <p className="dz-help"><Link to="/workflows">Open workflows</Link></p>
      </>}
    </div>
  </aside>;
}

function Mark({ state }: { state: 'pass' | 'warn' | 'idle' }) {
  return <span data-state={state} aria-label={state === 'pass' ? 'Passed' : state === 'warn' ? 'Needs attention' : 'Pending'} style={{ display: 'inline-flex' }}>
    <Icon name={state === 'pass' ? 'check' : state === 'warn' ? 'warning' : 'more'} size={15} /></span>;
}
