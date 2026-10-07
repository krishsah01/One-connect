// SPDX-License-Identifier: Apache-2.0
// Workflows: tasks tied to existing issues and agents, run independently or in dependency order.
// Progress is live from the event log; a task is done only when the daemon recorded evidence.
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ControlState, Workflow, WorkflowIssue, WorkflowMode, WorkflowTaskKind, WorkflowTaskStatus } from '@acc/core';
import { normalizeWorkflow, topoOrder, validateWorkflow, workflowProgress } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { ApiError, post } from '../lib/api';
import { ago, type Tone } from '../lib/format';

const STATUS_TONE: Record<Workflow['status'], Tone> = { draft: 'idle', running: 'ok', paused: 'warn', blocked: 'warn', failed: 'crit', completed: 'accent', canceled: 'idle' };
const TASK_TONE: Record<WorkflowTaskStatus, Tone> = { pending: 'idle', queued: 'info', running: 'ok', verifying: 'info', done: 'accent', changes_requested: 'warn', blocked: 'warn', failed: 'crit', canceled: 'idle' };
const KIND_LABEL: Record<WorkflowTaskKind, string> = { code: 'code', review: 'review', coordination: 'coordination' };

interface DraftTask {
  id: string;
  title: string;
  workItemId: string;
  agentId: string;
  kind: WorkflowTaskKind;
  dependsOn: string[];
  reviewOf: string;
  paths: string;
}
interface Draft {
  id: string | null;
  version: number | null;
  name: string;
  mode: WorkflowMode;
  tasks: DraftTask[];
}

const blankTask = (n: number): DraftTask => ({ id: `task-${n}`, title: '', workItemId: '', agentId: '', kind: 'code', dependsOn: [], reviewOf: '', paths: '' });
const toDefinition = (d: Draft) =>
  normalizeWorkflow({
    name: d.name,
    mode: d.mode,
    tasks: d.tasks.map((t) => ({ id: t.id.trim(), title: t.title, workItemId: t.workItemId, agentId: t.agentId, kind: t.kind, dependsOn: t.dependsOn, reviewOf: t.kind === 'review' ? t.reviewOf : null, allowedPaths: t.paths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean) })),
  });
const fromWorkflow = (w: Workflow): Draft => ({
  id: w.id,
  version: w.version,
  name: w.definition.name,
  mode: w.definition.mode,
  tasks: w.definition.tasks.map((t) => ({ id: t.id, title: t.title, workItemId: t.workItemId, agentId: t.agentId, kind: t.kind, dependsOn: t.dependsOn.filter((x) => x !== t.reviewOf), reviewOf: t.reviewOf ?? '', paths: t.allowedPaths.join(', ') })),
});

export function Workflows({ state }: { state: ControlState }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const list = Object.values(state.workflows ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="page col" style={{ gap: 16 }}>
      <div className="row wrap">
        <h1 style={{ fontSize: 20 }}>Workflows</h1>
        <span className="faint small">tasks on existing issues · each runs through pre-flight and the agent’s Now/Next queue</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setDraft({ id: null, version: null, name: '', mode: 'collaborative', tasks: [blankTask(1)] })}>New workflow</button>
      </div>
      {draft && <WorkflowEditor state={state} draft={draft} setDraft={setDraft} />}
      {list.length === 0 && !draft && <div className="empty card card-b">No workflows yet. A workflow ties tasks to issues and agents and starts each one only after its dependencies have recorded evidence.</div>}
      {list.map((w) => <WorkflowCard key={w.id} w={w} state={state} onEdit={() => setDraft(fromWorkflow(w))} />)}
    </div>
  );
}

function WorkflowCard({ w, state, onEdit }: { w: Workflow; state: ControlState; onEdit: () => void }) {
  const { busy, error, run } = useAction();
  const p = workflowProgress(w);
  const act = (a: string) => run(() => post(`/api/workflows/${w.id}/${a}`));
  const order = topoOrder(w.definition);
  return (
    <section className="card" aria-label={w.definition.name}>
      <div className="card-h">
        <h2 className="grow">{w.definition.name}</h2>
        <Badge>{w.definition.mode}</Badge>
        <Badge tone={STATUS_TONE[w.status]}>{w.status}</Badge>
      </div>
      <div className="card-b col" style={{ gap: 10 }}>
        <div className="row small wrap">
          <div className="meter grow" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label="Tasks done"><span style={{ width: `${p.total ? (100 * p.done) / p.total : 0}%` }} /></div>
          <span className="mono">{p.done}/{p.total} done</span>
          {w.startedAt && <span className="faint">started {ago(w.startedAt)} ago</span>}
        </div>
        {w.statusReason && <div className={`small${w.status === 'failed' ? ' crit-text' : ' muted'}`}>{w.statusReason}</div>}
        <div className="row wrap">
          {w.status === 'draft' && <><button className="btn primary" disabled={busy} onClick={() => void act('start')}>Start</button><button className="btn" disabled={busy} onClick={onEdit}>Edit</button></>}
          {(w.status === 'running' || w.status === 'blocked' || w.status === 'failed') && <button className="btn" disabled={busy} onClick={() => void act('pause')}>Pause</button>}
          {w.status === 'paused' && <button className="btn primary" disabled={busy} onClick={() => void act('resume')}>Resume</button>}
          {w.status !== 'canceled' && w.status !== 'completed' && w.status !== 'draft' && (
            <button className="btn danger" disabled={busy} onClick={() => { if (window.confirm(`Cancel "${w.definition.name}"? Running agents are stopped and unfinished tasks are canceled.`)) void act('cancel'); }}>Cancel</button>
          )}
        </div>
        <ErrorLine error={error} />
        <table className="table">
          <thead><tr><th>Task</th><th>Issue</th><th>Agent</th><th>Status</th><th /></tr></thead>
          <tbody>
            {order.map((id) => {
              const t = w.definition.tasks.find((x) => x.id === id)!;
              const st = w.tasks[id];
              const item = state.workItems[t.workItemId];
              const agent = state.agents[t.agentId];
              const retryable = st && ['failed', 'blocked', 'changes_requested'].includes(st.status) && w.status !== 'canceled' && w.status !== 'completed' && w.status !== 'draft';
              return (
                <tr key={id}>
                  <td>
                    <div><b>{t.title || t.id}</b> <span className="faint mono">{t.id}</span></div>
                    <div className="small faint">{KIND_LABEL[t.kind]}{t.reviewOf ? ` of ${t.reviewOf}` : ''}{t.dependsOn.length ? ` · after ${t.dependsOn.join(', ')}` : ''}</div>
                  </td>
                  <td>{item ? <Link to={`/board?item=${item.id}`} className="mono">{item.key ?? item.title}</Link> : <span className="crit-text">missing</span>}</td>
                  <td>{agent ? <Link to={`/agents/${agent.id}`}>{agent.config.name}</Link> : <span className="crit-text">missing</span>}</td>
                  <td>
                    <Badge tone={TASK_TONE[st?.status ?? 'pending']}>{(st?.status ?? 'pending').replace('_', ' ')}</Badge>
                    {st?.completedSha && <span className="mono faint small"> @ {st.completedSha.slice(0, 10)}</span>}
                    {st?.reason && <div className="small muted">{st.reason}</div>}
                  </td>
                  <td>{retryable && <button className="btn sm" disabled={busy} onClick={() => void run(() => post(`/api/workflows/${w.id}/tasks/${id}/retry`))}>Retry</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WorkflowEditor({ state, draft, setDraft }: { state: ControlState; draft: Draft; setDraft: (d: Draft | null) => void }) {
  const { busy, error, run, setError } = useAction();
  const [serverIssues, setServerIssues] = useState<WorkflowIssue[]>([]);
  const items = Object.values(state.workItems).filter((w) => w.state !== 'verified' && w.state !== 'canceled').sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''));
  const agents = Object.values(state.agents);
  const definition = useMemo(() => toDefinition(draft), [draft]);
  const issues = useMemo(() => validateWorkflow(definition, state, { workflowId: draft.id, projectChecks: state.project?.checks }), [definition, state, draft.id]);
  const shown = serverIssues.length ? serverIssues : issues;
  const patchTask = (i: number, patch: Partial<DraftTask>) => setDraft({ ...draft, tasks: draft.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const save = () =>
    run(async () => {
      setServerIssues([]);
      try {
        await post('/api/workflows', { id: draft.id, definition, expectedVersion: draft.version });
        setDraft(null);
      } catch (e) {
        if (e instanceof ApiError && Array.isArray((e.body as { issues?: unknown })?.issues)) setServerIssues((e.body as { issues: WorkflowIssue[] }).issues);
        throw e;
      }
    });
  return (
    <section className="card workflow-editor" aria-label="Workflow editor">
      <div className="card-h"><h2 className="grow">{draft.id ? 'Edit workflow' : 'New workflow'}</h2><button className="btn sm" onClick={() => setDraft(null)} aria-label="Close editor">✕</button></div>
      <div className="card-b col" style={{ gap: 12 }}>
        <div className="row wrap">
          <label className="col grow" style={{ gap: 4 }}><span className="small muted">Name</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. API then client" /></label>
          <label className="col" style={{ gap: 4 }}>
            <span className="small muted">Mode</span>
            <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as WorkflowMode })}>
              <option value="collaborative">Collaborative (dependency order)</option>
              <option value="independent">Independent (in parallel)</option>
            </select>
          </label>
        </div>
        {draft.tasks.map((t, i) => {
          const others = draft.tasks.filter((x, j) => j !== i && x.id);
          const mine = shown.filter((x) => x.taskId === t.id.trim());
          return (
            <fieldset key={i} className="workflow-task col" style={{ gap: 8 }}>
              <legend className="small">Task {i + 1}</legend>
              <div className="row wrap">
                <label className="col" style={{ gap: 4 }}><span className="small muted">Id</span><input value={t.id} onChange={(e) => patchTask(i, { id: e.target.value })} style={{ width: 130 }} /></label>
                <label className="col grow" style={{ gap: 4 }}><span className="small muted">Title</span><input value={t.title} onChange={(e) => patchTask(i, { title: e.target.value })} /></label>
                <label className="col" style={{ gap: 4 }}>
                  <span className="small muted">Kind</span>
                  <select value={t.kind} onChange={(e) => patchTask(i, { kind: e.target.value as WorkflowTaskKind })}>
                    <option value="code">Code</option>
                    <option value="review">Independent review</option>
                    <option value="coordination">Coordination</option>
                  </select>
                </label>
              </div>
              <div className="row wrap">
                {t.kind === 'review' ? (
                  <label className="col grow" style={{ gap: 4 }}>
                    <span className="small muted">Reviews</span>
                    <select value={t.reviewOf} onChange={(e) => patchTask(i, { reviewOf: e.target.value, workItemId: draft.tasks.find((x) => x.id === e.target.value)?.workItemId ?? t.workItemId })}>
                      <option value="">Choose a code task…</option>
                      {others.filter((x) => x.kind === 'code').map((x) => <option key={x.id} value={x.id}>{x.id}{x.title ? ` · ${x.title}` : ''}</option>)}
                    </select>
                  </label>
                ) : (
                  <label className="col grow" style={{ gap: 4 }}>
                    <span className="small muted">Issue</span>
                    <select value={t.workItemId} onChange={(e) => patchTask(i, { workItemId: e.target.value })}>
                      <option value="">Choose an issue…</option>
                      {items.map((w) => <option key={w.id} value={w.id}>{w.key ?? 'pending'} · {w.title}</option>)}
                    </select>
                  </label>
                )}
                <label className="col grow" style={{ gap: 4 }}>
                  <span className="small muted">Agent</span>
                  <select value={t.agentId} onChange={(e) => patchTask(i, { agentId: e.target.value })}>
                    <option value="">Choose an agent…</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.config.name}{a.config.mode === 'coordinator-only' ? ' (coordinator-only)' : ''}</option>)}
                  </select>
                </label>
              </div>
              {t.kind !== 'review' && (
                <label className="col" style={{ gap: 4 }}><span className="small muted">Allowed paths (comma separated; empty = whole repo)</span><input value={t.paths} onChange={(e) => patchTask(i, { paths: e.target.value })} placeholder="src/api/**, docs/api.md" /></label>
              )}
              {draft.mode === 'collaborative' && others.length > 0 && (
                <div className="row wrap small">
                  <span className="muted">Starts after:</span>
                  {others.map((x) => (
                    <label key={x.id} className="row" style={{ gap: 4 }}>
                      <input type="checkbox" checked={t.dependsOn.includes(x.id) || t.reviewOf === x.id} disabled={t.reviewOf === x.id} onChange={(e) => patchTask(i, { dependsOn: e.target.checked ? [...t.dependsOn, x.id] : t.dependsOn.filter((d) => d !== x.id) })} />
                      {x.id}
                    </label>
                  ))}
                </div>
              )}
              {mine.map((x, k) => <div key={k} className="small crit-text" role="alert">{x.message}</div>)}
              <div className="row"><span className="spacer" /><button className="btn sm danger" onClick={() => setDraft({ ...draft, tasks: draft.tasks.filter((_, j) => j !== i).map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== t.id), reviewOf: x.reviewOf === t.id ? '' : x.reviewOf })) })}>Remove task</button></div>
            </fieldset>
          );
        })}
        <div className="row"><button className="btn" onClick={() => setDraft({ ...draft, tasks: [...draft.tasks, blankTask(draft.tasks.length + 1)] })}>Add task</button></div>
        {shown.filter((x) => !x.taskId).map((x, k) => <div key={k} className="small crit-text" role="alert">{x.message}</div>)}
        <div className="row wrap">
          <span className="small muted grow">{shown.length ? `${shown.length} problem${shown.length > 1 ? 's' : ''} to fix before saving` : 'Valid. Saved workflows start only when you press Start.'}</span>
          <button className="btn" onClick={() => { setDraft(null); setError(null); }}>Discard</button>
          <button className="btn primary" disabled={busy || issues.length > 0} onClick={() => void save()}>Save draft</button>
        </div>
        <ErrorLine error={error} />
      </div>
    </section>
  );
}
