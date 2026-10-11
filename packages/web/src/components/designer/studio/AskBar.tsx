// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The ask bar: the one place you talk to the design agent. A request becomes a focused job that the
// agent answers with proposals on the canvas; its progress, questions and transcript unfold above the
// box. Nothing is applied without a Keep.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AgentState, ControlState, DesignDocument } from '@acc/core';
import { ApprovalCard, useTick } from '../../common';
import { Transcript } from '../../Transcript';
import { api, post } from '../../../lib/api';
import { useLiveText, useRunEvents } from '../../../lib/store';
import { Icon } from '../workspace/DocumentRenderer';
import type { ProposalView, RecordView } from '../workspace/useDesignDocument';
import { jobThread, startAgentJob, type JobThreadItem } from './model';

export type AskKind = 'edit' | 'generate' | 'reconstruct' | 'repair';
export interface AskDraft { text: string; kind: AskKind }

export function AskBar({ doc, record, state, agents, agentId, onAgent, selected, onClearSelection, draft, onDraft, mutate, onNotice, onProposal }: {
  doc: DesignDocument; record: RecordView; state: ControlState; agents: AgentState[]; agentId: string; onAgent: (id: string) => void;
  selected: string[]; onClearSelection: () => void; draft: AskDraft; onDraft: (d: AskDraft) => void;
  mutate: <T>(fn: () => Promise<T>) => Promise<T | undefined>; onNotice: (text: string) => void; onProposal: (p: ProposalView, decision: 'apply' | 'discard') => void;
}) {
  const thread = jobThread(record, state);
  const live = thread.filter(t => ['prepared', 'queued', 'running', 'needs-you', 'proposed'].includes(t.phase));
  const [open, setOpen] = useState(live.length > 0), [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [files, setFiles] = useState<string[]>([]), [fileQuery, setFileQuery] = useState<string | null>(null), [fileHits, setFileHits] = useState<string[]>([]);
  const box = useRef<HTMLTextAreaElement>(null);
  const now = useTick(10_000);
  useEffect(() => { if (live.length) setOpen(true); }, [live.length]);
  useEffect(() => {
    if (fileQuery === null) return;
    let alive = true;
    const t = setTimeout(() => { void api<{ files: string[] }>(`/api/designer/repository/files?q=${encodeURIComponent(fileQuery)}`).then(r => alive && setFileHits(r.files.filter(f => !files.includes(f)).slice(0, 10))).catch(() => alive && setFileHits([])); }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [fileQuery, files]);
  const shown = all ? thread : thread.slice(-3);
  const selectedNames = selected.map(k => doc.nodes[k]?.name).filter(Boolean);
  const agent = agents.find(a => a.id === agentId) ?? agents[0];

  const send = async () => {
    const text = draft.text.trim();
    if (!text || !agent) return;
    setBusy(true); setError('');
    try {
      const r = await mutate(() => startAgentJob(doc.id, { agentId: agent.id, request: text, selection: selected, files, kind: draft.kind }));
      if (r) { onNotice(r.started ? `${agent.config.name} is working on it.` : r.message); onDraft({ text: '', kind: 'edit' }); setFiles([]); setFileQuery(null); setOpen(true); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await mutate(fn); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };

  return <div className="dz-ask-wrap">
    <section className="dz-ask" aria-label="Design agent">
      {open && thread.length > 0 && <div className="dz-thread" aria-live="polite">
        <div className="dz-thread-head"><span>{live.length ? `${live.length} request${live.length === 1 ? '' : 's'} in progress` : 'Earlier requests'}</span><span className="spacer" />
          {thread.length > 3 && <button type="button" onClick={() => setAll(v => !v)}>{all ? 'Show recent' : `Show all ${thread.length}`}</button>}
          <button type="button" aria-label="Hide requests" onClick={() => setOpen(false)}>Hide</button></div>
        {shown.map(t => <ThreadItem key={t.job.assignmentId} item={t} state={state} now={now} busy={busy} onProposal={onProposal} act={act} />)}
      </div>}
      <form onSubmit={e => { e.preventDefault(); void send(); }}>
        <label htmlFor="dz-ask" className="sr-only">Ask the design agent</label>
        <textarea id="dz-ask" ref={box} rows={1} maxLength={6000} value={draft.text} disabled={busy} placeholder={selectedNames.length ? `Ask about ${selectedNames[0]}…` : 'Ask for a change, a new screen, or a review…'}
          onChange={e => onDraft({ ...draft, text: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        {fileQuery !== null && <div className="dz-files">
          <label className="sr-only" htmlFor="dz-ask-files">Repository files to study</label>
          <input id="dz-ask-files" autoFocus value={fileQuery} onChange={e => setFileQuery(e.target.value)} placeholder="Find repository files for the agent to read (read-only)" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setFileQuery(null); } }} />
          {fileHits.length > 0 && <div className="list" role="listbox" aria-label="Matching files">{fileHits.map(f => <button key={f} type="button" role="option" aria-selected={false} onClick={() => { setFiles([...files, f].slice(0, 50)); setFileQuery(''); }}>{f}</button>)}</div>}
        </div>}
        {files.length > 0 && <div className="dz-chips" style={{ padding: '0 12px 6px' }}>{files.map(f => <button key={f} type="button" className="dz-chip on" aria-label={`Remove ${f}`} onClick={() => setFiles(files.filter(x => x !== f))}>{f}<Icon name="close" size={11} /></button>)}</div>}
        <div className="dz-ask-bar">
          {selectedNames.length ? <button type="button" className="dz-chip on" aria-label={`Scope: ${selectedNames.join(', ')}. Clear selection`} onClick={onClearSelection}><Icon name="check" size={11} />{selectedNames.length === 1 ? selectedNames[0] : `${selectedNames.length} layers`}<Icon name="close" size={11} /></button>
            : <span className="dz-chip" aria-label="Scope: whole design">Whole design</span>}
          <label className="dz-chip"><span className="sr-only">Design agent</span>{agents.length ? <select value={agent?.id ?? ''} onChange={e => onAgent(e.target.value)}>{agents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select> : <span>No agent available</span>}</label>
          <button type="button" className="dz-icon-btn" aria-label="Add repository files for the agent to read" aria-pressed={fileQuery !== null} onClick={() => setFileQuery(q => q === null ? '' : null)}><Icon name="link" size={15} /></button>
          {!open && thread.length > 0 && <button type="button" className="dz-chip" onClick={() => setOpen(true)}>{live.length ? `${live.length} in progress` : `${thread.length} earlier`}</button>}
          <span className="spacer" />
          {error && <span role="alert" className="meta" style={{ color: 'var(--crit-text)' }}>{error}</span>}
          <button type="submit" className="dz-send icon" aria-label="Send" disabled={busy || !draft.text.trim() || !agent}><Icon name="arrow-right" size={15} /></button>
        </div>
      </form>
    </section>
  </div>;
}

function ThreadItem({ item: t, state, now, busy, onProposal, act }: { item: JobThreadItem; state: ControlState; now: number; busy: boolean; onProposal: (p: ProposalView, decision: 'apply' | 'discard') => void; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const a = state.assignments[t.job.assignmentId];
  const item = a ? state.workItems[a.workItemId] : undefined;
  const active = t.phase === 'running' || t.phase === 'queued' || t.phase === 'needs-you';
  // A request is prepared before the tracker confirms its issue, so the first dispatch is refused on
  // that check alone. Once the key arrives, re-check and start it without asking again.
  const autoStarted = useRef(false);
  const onlyIssuePending = Boolean(a && t.phase === 'prepared' && item?.key && item.sync.status === 'synced' && a.preflight && a.preflight.checks.some(c => c.status === 'fail') && a.preflight.checks.every(c => c.status !== 'fail' || c.id === 'issue'));
  useEffect(() => {
    if (!onlyIssuePending || autoStarted.current || !a) return;
    autoStarted.current = true;
    void act(async () => { await post(`/api/assignments/${a.id}/preflight`); await post(`/api/assignments/${a.id}/dispatch`, { position: 'now' }); });
  }, [onlyIssuePending, a?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="dz-msg">
    <div className="you">{t.job.request}</div>
    <div className="status" data-phase={t.phase}>
      {active && t.phase !== 'needs-you' && <span className="spin" aria-hidden="true" />}
      <b>{t.label}</b><span>{t.detail}</span>
      {t.phase === 'prepared' && a && <button type="button" className="btn sm primary" disabled={busy} onClick={() => void act(() => post(`/api/assignments/${a.id}/dispatch`, { position: 'now' }))}>Start</button>}
      {t.phase === 'failed' && a && <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => post(`/api/assignments/${a.id}/dispatch`, { position: 'now' }))}>Try again</button>}
      {active && t.run && <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => post(`/api/runs/${t.run!.id}/stop`, { reason: 'Stopped from the Designer' }))}>Stop</button>}
    </div>
    {t.approvals.map(ap => <div className="dz-question" key={ap.id}><ApprovalCard ap={ap} agentName={t.agentName} now={now} /></div>)}
    {t.proposals.filter(p => p.status === 'pending').map(p => <div className="dz-proposal-row" key={p.id}><Icon name="sparkle" size={13} /><span style={{ flex: 1 }}>{p.summary}</span>
      <button type="button" className="btn sm primary" disabled={busy} onClick={() => onProposal(p, 'apply')}>Keep</button><button type="button" className="btn sm" disabled={busy} onClick={() => onProposal(p, 'discard')}>Discard</button></div>)}
    {t.run && <details><summary>{t.agentName} · run {t.run.id.slice(-6)}{item?.key ? ` · ${item.key}` : ''}{t.job.skills.length ? ` · skills: ${t.job.skills.map(s => s.id).join(', ')}` : ''}</summary>
      <RunPeek runId={t.run.id} active={active} /><p className="dz-help"><Link to={`/runs/${t.run.id}`}>Open the full run</Link>{item && <> · <Link to={`/board?item=${item.id}`}>Work item</Link></>}</p></details>}
  </div>;
}

function RunPeek({ runId, active }: { runId: string; active: boolean }) {
  const events = useRunEvents(runId);
  const live = useLiveText(runId);
  return <div className="job-transcript"><Transcript events={events} live={live} runId={runId} active={active} /></div>;
}
