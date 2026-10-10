// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AgentState, Alert, ControlState } from '@acc/core';
import { LIFECYCLE_LABELS, PIPELINE, ciSummary, sharedUsageView } from '@acc/core';
import { Avatar, Badge, BillingBadge, ErrorLine, Light, UsageMeter, useAction, useTick, ApprovalCard } from '../components/common';
import type { Tone } from '../lib/format';
import { post } from '../lib/api';
import { AGENT_TONE, ago, until } from '../lib/format';
import { useLiveText } from '../lib/store';
import { DictionaryStatusCard } from '../components/Dictionary';

export function MissionControl({ state }: { state: ControlState }) {
  const now = useTick(5000);
  const agents = Object.values(state.agents);
  const pending = Object.values(state.approvals).filter((a) => !a.resolvedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const alerts = Object.values(state.alerts).filter((a) => !a.resolvedAt);
  return (
    <div className="page">
      <Pipeline state={state} />
      <div className="mc">
        <div className="col" style={{ gap: 12 }}>
          <div className="row">
            <h2>Agents</h2>
            <span className="faint small">{agents.filter((a) => a.status === 'running' || a.status === 'waiting').length} working · {agents.filter((a) => a.idleWithWorkSince).length} idle with work queued</span>
          </div>
          <div className="agents">
            {agents.map((a) => (
              <AgentCard key={a.id} agent={a} state={state} now={now} />
            ))}
          </div>
        </div>
        <aside className="mc-rail">
          <section className="card">
            <div className="card-h">
              <h2>Waiting on you</h2>
              {pending.length > 0 && <Badge tone="warn">{pending.length}</Badge>}
            </div>
            <div className="card-b col">
              {pending.length === 0 && <div className="empty">No open questions or approvals.</div>}
              {pending.map((ap) => (
                <ApprovalCard key={ap.id} ap={ap} agentName={state.agents[ap.agentId]?.config.name ?? ap.agentId} now={now} />
              ))}
            </div>
          </section>
          <AlertsPanel alerts={alerts} state={state} now={now} />
          <ContextPanel state={state} />
          <ReleaseInfra state={state} />
        </aside>
      </div>
    </div>
  );
}

function GateRow({ label, tone, detail }: { label: string; tone: Tone; detail: string }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
      <Badge tone={tone}>{label}</Badge>
      <span className="small">{detail}</span>
    </div>
  );
}

function ReleaseInfra({ state }: { state: ControlState }) {
  const host = state.codeHost;
  const infra = state.infra;
  const plans = Object.values(state.releases ?? {}).filter((p) => p.status !== 'canceled');
  const plan = plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const ci = ciSummary(host?.checks ?? []);
  const checked = Boolean(host || infra);
  return (
    <section className="card">
      <div className="card-h">
        <h2>Release gates · Infra</h2>
        <Link to="/release">Cockpit</Link>
      </div>
      <div className="card-b col" style={{ gap: 8 }}>
        {plan && <div className="small">{plan.name}: {plan.steps.filter((s) => s.status === 'approved').length}/{plan.steps.length} steps approved. Later steps stay closed until the earlier one is approved.</div>}
        <GateRow label={host?.protected === true ? 'protected' : host?.protected === false ? 'unprotected' : 'unchecked'} tone={host?.protected === true ? 'ok' : host?.protected === false ? 'crit' : 'idle'} detail={host?.protectionDetail ?? 'Branch protection has not been checked.'} />
        <GateRow label={ci.state === 'green' ? 'CI green' : ci.state === 'failing' ? 'CI failing' : ci.state === 'pending' ? 'CI pending' : 'CI unchecked'} tone={ci.state === 'green' ? 'ok' : ci.state === 'failing' ? 'crit' : ci.state === 'pending' ? 'warn' : 'idle'} detail={host ? ci.detail : 'CI has not been checked.'} />
        <GateRow label={infra?.postgres.state === 'ready' ? 'database ready' : infra?.postgres.state === 'paused' ? 'database paused' : infra ? `database ${infra.postgres.state}` : 'database unchecked'} tone={infra?.postgres.state === 'ready' ? 'ok' : infra?.postgres.state === 'paused' || infra?.postgres.state === 'unhealthy' ? 'crit' : 'idle'} detail={infra?.postgres.detail ?? 'Docker and local Postgres have not been checked.'} />
        <GateRow label={infra?.vercel.state === 'ready' ? 'hosting ready' : infra?.vercel.state === 'error' ? 'hosting error' : infra?.vercel.state === 'degraded' ? 'hosting degraded' : 'hosting unchecked'} tone={infra?.vercel.state === 'ready' ? 'ok' : infra?.vercel.state === 'error' ? 'crit' : infra?.vercel.state === 'degraded' ? 'warn' : 'idle'} detail={infra?.vercel.detail ?? 'Vercel has not been checked. Real-provider validation is pending.'} />
        <GateRow label={infra?.migrations.state === 'in_sync' ? 'migrations match' : infra?.migrations.state === 'drift' ? 'migration drift' : 'migrations unchecked'} tone={infra?.migrations.state === 'in_sync' ? 'ok' : infra?.migrations.state === 'drift' ? 'warn' : 'idle'} detail={infra?.migrations.detail ?? 'Migration history has not been read.'} />
        {!checked && <div className="small faint">Nothing here is reported as healthy until an adapter actually checks it.</div>}
      </div>
    </section>
  );
}

function Pipeline({ state }: { state: ControlState }) {
  const nav = useNavigate();
  const items = Object.values(state.workItems).filter((w) => w.state !== 'canceled');
  return (
    <div className="pipeline">
      {PIPELINE.map((p) => {
        const n = items.filter((w) => p.states.includes(w.state)).length;
        return (
          <button key={p.id} className={`stage${p.id === 'attention' && n > 0 ? ' attn' : ''}`} onClick={() => nav(`/board?stage=${p.id}`)} title={p.states.map((s) => LIFECYCLE_LABELS[s]).join(', ')}>
            <b>{n}</b>
            <span>{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function AgentCard({ agent: a, state, now }: { agent: AgentState; state: ControlState; now: number }) {
  const nowAsg = a.queue.now ? state.assignments[a.queue.now] : null;
  const item = nowAsg ? state.workItems[nowAsg.workItemId] : null;
  const run = a.activeRunIds.map((id) => state.runs[id]).find(Boolean) ?? (item ? item.runIds.map((id) => state.runs[id]).filter((r) => r?.assignmentId === nowAsg?.id).at(-1) : undefined);
  const tone = AGENT_TONE[a.status];
  const next = a.queue.next.map((id) => state.assignments[id]).filter(Boolean);
  const liveText = useLiveText(run && run.endedAt === null ? run.id : null);
  return (
    <article className="card agent-card">
      <div className="card-h">
        <Light tone={tone} pulse={a.status === 'running'} />
        <Link to={`/agents/${a.id}`} style={{ fontWeight: 650, color: 'var(--text)' }}>
          {a.config.name}
        </Link>
        <span className="faint small">{a.config.role}{a.config.mode === 'coordinator-only' ? ' · coordinator' : ''}</span>
        <span className="spacer" />
        <Badge tone={tone}>{a.status}</Badge>
      </div>
      <div className="card-b col">
        <div className="row small wrap">
          <span className="mono muted">{run?.resolvedModel ?? a.models.current ?? (a.config.model === 'newest' ? a.models.newest ?? 'newest' : a.config.model)}</span>
          {a.config.effort && <span className="faint">@ {a.config.effort}</span>}
          {a.models.newest && a.config.model !== 'newest' && a.config.model !== a.models.newest && <Badge tone="warn" title={`newest eligible: ${a.models.newest}`}>newer model</Badge>}
          <span className="spacer" />
          <BillingBadge agent={a} />
        </div>
        <div className="now">
          {item ? (
            <div className="col" style={{ gap: 3 }}>
              <div className="row">
                <span className="mono small faint">{item.key}</span>
                <span className="ellipsis grow" style={{ fontWeight: 550 }}>
                  {item.title}
                </span>
                {run?.startedAt && <span className="faint small">{ago(run.startedAt, now)}</span>}
              </div>
              {liveText?.assistant ? (
                <div className="typing" title={liveText.assistant}>
                  {liveText.assistant.slice(-220)}
                  <span className="caret" />
                </div>
              ) : (
                <div className="last" title={run?.lastMeaningful?.summary}>
                  {run?.lastMeaningful ? `${ago(run.lastMeaningful.at, now)} · ${run.lastMeaningful.summary}` : run ? run.state : 'not started'}
                </div>
              )}
            </div>
          ) : (
            <div className="faint small">{a.limitedUntil ? `Usage limit · resets in ${until(a.limitedUntil, now)}` : a.pausedReason ? `Paused: ${a.pausedReason}` : a.idleSince ? `Idle ${ago(a.idleSince, now)}${a.idleWithWorkSince ? ' with work queued' : ''}` : 'Idle'}</div>
          )}
        </div>
        <UsageMeter usage={a.usage} />
        <div className="small faint">{sharedUsageView(state.agents, a.id).note}</div>
        <div className="row small wrap" style={{ gap: 5 }}>
          <span className="faint">Next</span>
          {next.length === 0 && <span className="faint">empty</span>}
          {next.slice(0, 5).map((n) => (
            <span key={n.id} className="queue-chip">
              {state.workItems[n.workItemId]?.key ?? '…'}
            </span>
          ))}
          {next.length > 5 && <span className="faint">+{next.length - 5}</span>}
          <span className="spacer" />
          <span className="faint">idle total {Math.round((a.idleMsTotal + (a.idleSince ? now - Date.parse(a.idleSince) : 0)) / 60_000)}m</span>
        </div>
      </div>
    </article>
  );
}

const SEV_TONE = { critical: 'crit', warn: 'warn', info: 'info' } as const;

function AlertsPanel({ alerts, state, now }: { alerts: Alert[]; state: ControlState; now: number }) {
  const { error, run } = useAction();
  const sorted = [...alerts].sort((a, b) => (a.severity === b.severity ? b.createdAt.localeCompare(a.createdAt) : a.severity === 'critical' ? -1 : b.severity === 'critical' ? 1 : a.severity === 'warn' ? -1 : 1));
  return (
    <section className="card">
      <div className="card-h">
        <h2>Alerts</h2>
        {alerts.length > 0 && <Badge tone={alerts.some((a) => a.severity === 'critical') ? 'crit' : 'warn'}>{alerts.length}</Badge>}
      </div>
      <div className="card-b">
        {sorted.length === 0 && <div className="empty">No stalled runs, idle agents or sync problems.</div>}
        {sorted.slice(0, 12).map((a) => (
          <div key={a.id} className="alert-item">
            <Light tone={SEV_TONE[a.severity]} />
            <div className="grow col" style={{ gap: 3 }}>
              <div className="small">{a.message}</div>
              {a.suggestion?.kind === 'reassign' && (
                <div className="small faint">
                  Reassign to: {a.suggestion.agentIds.length ? a.suggestion.agentIds.map((id) => state.agents[id]?.config.name ?? id).join(', ') : a.suggestion.note}
                </div>
              )}
              {a.suggestion?.kind === 'text' && <div className="small faint">{a.suggestion.text}</div>}
              <div className="row small faint">
                <span>{ago(a.createdAt, now)} ago</span>
                {a.agentId && <Link to={`/agents/${a.agentId}`}>console</Link>}
                <span className="spacer" />
                <button className="btn sm ghost" onClick={() => void run(() => post(`/api/alerts/${a.id}/resolve`, { resolution: 'dismissed' }))}>
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ))}
        <ErrorLine error={error} />
      </div>
    </section>
  );
}

function ContextPanel({ state }: { state: ControlState }) {
  const v = state.context?.vault;
  const g = state.context?.graph;
  const { busy, error, run } = useAction();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ notes: { backend: string; hits: { path: string; snippet: string }[] } | null; graph: string | null } | null>(null);
  if (!v && !g) {
    return (
      <section className="card">
        <div className="card-h">
          <h2>Shared context</h2>
        </div>
        <div className="card-b small faint">
          Add <code>knowledge:</code> (Obsidian vault) and <code>graphify:</code> to control-center.yaml to give every agent the same contract, brief and code graph.
        </div>
      </section>
    );
  }
  return (
    <section className="card">
      <div className="card-h">
        <h2>Dictionary</h2>
      </div>
      <div className="card-b col">
        {state.context.answer&&<><DictionaryStatusCard status={state.context.answer} compact/><Link className="small" to="/docs">Ask your project</Link></>}
        {v && (
          <div className="col" style={{ gap: 4 }}>
            <div className="row small">
              <b>Obsidian vault</b>
              <Badge tone={v.error ? 'crit' : 'ok'}>{v.backend === 'obsidian-cli' ? 'Obsidian CLI' : 'files'}</Badge>
              <span className="spacer" />
              {v.openUrl && <a href={v.openUrl}>Open brief</a>}
            </div>
            <div className="small faint ellipsis" title={`${v.root}/${v.folder}`}>
              {v.folder} · {v.notes} notes · written {v.lastWriteAt ? `${ago(v.lastWriteAt)} ago` : 'not yet'}
            </div>
            <div className="small faint">{v.cli.note}</div>
            {v.error && <div className="small" style={{ color: 'var(--crit)' }}>{v.error}</div>}
          </div>
        )}
        {g && (
          <div className="col" style={{ gap: 4 }}>
            <div className="row small">
              <b>Code graph</b>
              <Badge tone={g.state === 'ready' ? 'ok' : g.state === 'building' ? 'info' : g.state === 'missing' ? 'idle' : 'crit'}>{g.state}</Badge>
              <span className="spacer" />
              <button className="btn sm" disabled={busy || g.state === 'building' || g.state === 'unavailable'} onClick={() => void run(() => post('/api/context/graph/rebuild'))}>
                Rebuild
              </button>
            </div>
            <div className="small faint">
              graphify · {g.nodes} nodes · {g.edges} edges{g.sha ? ` · ${g.sha.slice(0, 8)}` : ''}
              {g.builtAt ? ` · ${ago(g.builtAt)} ago` : ''} · {g.semantic ? 'semantic (paid)' : 'AST only, no LLM'}
            </div>
            {g.error && <div className="small" style={{ color: 'var(--crit)' }}>{g.error}</div>}
          </div>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) void run(async () => setRes(await post('/api/context/query', { query: q })));
          }}
        >
          <input placeholder="Ask the shared context…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn sm" disabled={busy || !q.trim()}>
            Search
          </button>
        </form>
        {res && (
          <div className="col small" style={{ gap: 6 }}>
            {res.notes?.hits.map((h) => (
              <div key={h.path}>
                <div className="mono">{h.path}</div>
                <div className="faint">{h.snippet}</div>
              </div>
            ))}
            {res.notes && res.notes.hits.length === 0 && <div className="faint">No matching notes.</div>}
            {res.graph && <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', margin: 0, background: 'var(--surface-2)', padding: 8, borderRadius: 6 }}>{res.graph}</pre>}
          </div>
        )}
        <ErrorLine error={error} />
      </div>
    </section>
  );
}

export { Avatar };
