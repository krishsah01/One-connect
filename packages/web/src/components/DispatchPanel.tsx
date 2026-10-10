// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Dispatch: pick an agent, generate the assignment from the template, edit it, see pre-flight,
// then dispatch Now (if the agent is free) or queue it as Next.
import { useState } from 'react';
import type { Assignment, ControlState, PreflightResult, WorkItem } from '@acc/core';
import { post, api } from '../lib/api';
import { Badge, ErrorLine, useAction } from './common';

const CHECK_TONE = { pass: 'ok', warn: 'warn', fail: 'crit' } as const;

export function DispatchPanel({ item, state }: { item: WorkItem; state: ControlState }) {
  const agents = Object.values(state.agents);
  const draft = item.assignmentIds.map((id) => state.assignments[id]).find((a) => a && a.position === 'draft') ?? null;
  const [agentId, setAgentId] = useState(draft?.agentId ?? agents.find((a) => a.config.mode !== 'coordinator-only' && a.config.role === 'engineer')?.id ?? agents[0]?.id ?? '');
  const [paths, setPaths] = useState(draft?.allowedPaths.join('\n') ?? '');
  const [scope, setScope] = useState(draft?.scope ?? '');
  const checks = Object.keys(state.project?.checks ?? {});
  const [required, setRequired] = useState<string[]>(draft?.requiredChecks ?? state.project?.required_checks ?? checks);
  const [asg, setAsg] = useState<Assignment | null>(draft);
  const [prompt, setPrompt] = useState(draft?.prompt ?? '');
  const [pf, setPf] = useState<PreflightResult | null>(draft?.preflight ?? null);
  const [result, setResult] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const live = asg ? state.assignments[asg.id] ?? asg : null;

  const generate = () =>
    run(async () => {
      const body = { workItemId: item.id, agentId, allowedPaths: paths.split('\n').map((s) => s.trim()).filter(Boolean), scope, requiredChecks: required };
      const r = asg && live?.position === 'draft'
        ? await api<{ assignment: Assignment; preflight: PreflightResult }>(`/api/assignments/${asg.id}`, { method: 'PATCH', body: { allowedPaths: body.allowedPaths, scope, requiredChecks: required } })
        : await post<{ assignment: Assignment; preflight: PreflightResult }>('/api/assignments', body);
      if (asg && r.assignment.agentId !== agentId) {
        await post(`/api/assignments/${asg.id}/cancel`);
        const fresh = await post<{ assignment: Assignment; preflight: PreflightResult }>('/api/assignments', body);
        setAsg(fresh.assignment);
        setPrompt(fresh.assignment.prompt);
        setPf(fresh.preflight);
        return;
      }
      setAsg(r.assignment);
      setPrompt(r.assignment.prompt);
      setPf(r.preflight);
    });

  const savePrompt = () =>
    run(async () => {
      if (!asg) return;
      const r = await api<{ assignment: Assignment; preflight: PreflightResult }>(`/api/assignments/${asg.id}`, { method: 'PATCH', body: { prompt } });
      setPf(r.preflight);
    });

  const useModel = (model: string) =>
    run(async () => {
      if (!asg) return;
      const r = await api<{ assignment: Assignment; preflight: PreflightResult }>(`/api/assignments/${asg.id}`, { method: 'PATCH', body: { model } });
      setPf(r.preflight);
    });

  const dispatch = (position: 'now' | 'next') =>
    run(async () => {
      if (!asg) return;
      if (prompt !== live?.prompt) await api(`/api/assignments/${asg.id}`, { method: 'PATCH', body: { prompt } });
      const r = await post<{ started: boolean; queued: boolean }>(`/api/assignments/${asg.id}/dispatch`, { position });
      setResult(r.started ? 'Started. Watch it in the agent console.' : 'Queued as Next: it starts automatically when the agent is free.');
    });

  if (live && live.position !== 'draft') {
    const a = state.agents[live.agentId];
    return (
      <div className="banner tone-info">
        Assigned to <b>{a?.config.name}</b> as <b>{live.position}</b>
        {live.branch ? (
          <>
            {' '}
            on <code>{live.branch}</code>
          </>
        ) : null}
        . {result}
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      {!item.key && <div className="banner tone-warn">Waiting for the tracker to confirm this issue{item.sync.status === 'dry_run' ? ' (tracker is in dry-run: set tracker.live: true)' : ''}. No issue, no dispatch.</div>}
      <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
        <label className="field grow">
          Agent
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.config.name} · {a.status}
                {a.queue.next.length ? ` · ${a.queue.next.length} queued` : ''}
                {a.config.mode === 'coordinator-only' ? ' · coordinator-only' : ''}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={busy} onClick={() => void generate()}>
          {asg ? 'Regenerate' : 'Generate assignment'}
        </button>
      </div>
      <label className="field">
        Allowed paths (one glob per line, empty = whole repo)
        <textarea rows={2} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={'src/auth/**\ntest/auth/**'} />
      </label>
      <label className="field">
        Scope note
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Only the login form; no refactors" />
      </label>
      {checks.length > 0 && (
        <div className="row wrap small">
          <span className="faint">Required checks</span>
          {checks.map((c) => (
            <label key={c} className="row" style={{ gap: 4 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={required.includes(c)} onChange={(e) => setRequired(e.target.checked ? [...required, c] : required.filter((x) => x !== c))} />
              {c}
            </label>
          ))}
        </div>
      )}
      {asg && (
        <>
          <label className="field">
            Exact prompt the agent receives (editable)
            <textarea rows={14} value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => prompt !== live?.prompt && void savePrompt()} />
          </label>
          {pf && (
            <div className="card" style={{ boxShadow: 'none' }}>
              <div className="card-h">
                <h2>Pre-flight</h2>
                <Badge tone={pf.ok ? 'ok' : 'crit'}>{pf.ok ? 'ready' : 'blocked'}</Badge>
                {pf.model && <span className="mono small faint">model {pf.model}</span>}
              </div>
              <div className="card-b">
                {pf.checks.map((c) => (
                  <div key={c.id} className="check">
                    <Badge tone={CHECK_TONE[c.status]}>{c.status}</Badge>
                    <div className="grow">
                      <b>{c.label}</b> <span className="muted">{c.message}</span>
                    </div>
                    {c.fix?.kind === 'use_model' && (
                      <button className="btn sm" disabled={busy} onClick={() => void useModel((c.fix as { model: string }).model)}>
                        Use {(c.fix as { model: string }).model}
                      </button>
                    )}
                    {c.fix?.kind === 'reprobe' && (
                      <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await post(`/api/agents/${agentId}/probe`); setPf((await post<{ preflight: PreflightResult }>(`/api/assignments/${asg.id}/preflight`)).preflight); })}>
                        Re-check agent
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="row wrap">
            <button className="btn primary" disabled={busy || !pf?.ok || !item.key} onClick={() => void dispatch('now')}>
              Dispatch now
            </button>
            <button className="btn" disabled={busy || !item.key} onClick={() => void dispatch('next')}>
              Queue as Next
            </button>
            <span className="small faint">Dispatch now starts immediately if the agent is free; otherwise it is queued.</span>
          </div>
        </>
      )}
      {result && <div className="banner tone-ok">{result}</div>}
      <ErrorLine error={error} />
    </div>
  );
}
