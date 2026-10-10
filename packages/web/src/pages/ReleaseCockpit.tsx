// SPDX-License-Identifier: Apache-2.0
// Release cockpit: edit an ordered plan and approve one step at a time.
// The daemon rechecks the bound action. This page never marks an unchecked adapter healthy.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ControlState, ReleaseCapability, ReleasePlan, ReleaseStep, ReleaseStepKind } from '@acc/core';
import { CONNECTOR_DESCRIPTORS, RELEASE_CONNECTOR_KINDS, IRREVERSIBLE_RELEASE_STEPS, RELEASE_STEP_KINDS, ciSummary } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { api, post } from '../lib/api';
import type { Listing } from './Connectors';
import type { Tone } from '../lib/format';

const channel = () => (typeof window !== 'undefined' && window.innerWidth < 640 ? 'phone' : 'web');

export function ReleaseCockpit({ state }: { state: ControlState }) {
  const plans = Object.values(state.releases ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [selected, setSelected] = useState<string | null>(null);
  const [workItemId, setWorkItemId] = useState('');
  const candidates = Object.values(state.workItems).filter(item => ['merged', 'release_candidate', 'deployed'].includes(item.state) && Object.values(state.merges).some(m => m.workItemId === item.id && m.postChecks.status === 'passed'));
  const plan = plans.find((p) => p.id === selected) ?? plans.find((p) => p.status === 'active') ?? plans[0] ?? null;
  const { busy, error, run } = useAction();
  return (
    <div className="page col" style={{ gap: 16 }}>
      <div className="row wrap">
        <h1 style={{ fontSize: 20 }}>Release cockpit</h1>
        <label className="small col">Recorded merge
          <select aria-label="Release work item" value={workItemId} onChange={e => setWorkItemId(e.target.value)}>
            <option value="">Choose a merged work item</option>
            {candidates.map(item => <option key={item.id} value={item.id}>{item.key ?? item.title} · {item.title}</option>)}
          </select>
        </label>
        <button className="btn" disabled={busy || !candidates.some(item => item.id === workItemId)} onClick={() => void run(async () => { const r = await post<{ plan: ReleasePlan }>('/api/release/plans', { name: 'Release', workItemId }); setSelected(r.plan.id); })}>New release plan</button>
        <button className="btn" disabled={busy} onClick={() => void run(() => post('/api/release/refresh', {}))}>Refresh checks</button>
        <Link to="/decisions" className="small">Decisions</Link>
      </div>
      <p className="small muted">Steps stay in order and bind to the recorded merge SHA. Each action needs fresh verification. Human attestation cannot pass device QA. An interrupted action needs inspection and is never replayed automatically.</p>
      {error && <ErrorLine error={error} />}
      <ReleaseDependencies state={state} />
      {plans.length === 0 && <div className="empty card card-b">No release plan yet.</div>}
      {plans.length > 0 && (
        <label className="row small" style={{ gap: 8 }}>
          Plan
          <select aria-label="Release plan" value={plan?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.status}</option>)}
          </select>
        </label>
      )}
      {plan && <PlanEditor key={plan.updatedAt + plan.id} plan={plan} busy={busy} run={run} />}
    </div>
  );
}

function ReleaseDependencies({ state }: { state: ControlState }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState('');
  const { busy, error, run } = useAction();
  const reload = async () => { try { setListing(await api<Listing>('/api/connectors')); setLoadError(''); } catch (e) { setLoadError((e as Error).message); } };
  useEffect(() => {
    let current = true;
    void api<Listing>('/api/connectors').then(value => { if (current) { setListing(value); setLoadError(''); } }, e => { if (current) setLoadError((e as Error).message); });
    return () => { current = false; };
  }, [state.seq]);
  return <><section className="card" aria-label="Release connections">
    <div className="card-h"><h2>Release connections</h2></div>
    <div className="card-b col" style={{ gap: 10 }}>
      <p className="small">Set repository, projects, hosts and scopes in <Link to="/settings">Settings & policies</Link>, then approve each read independently in <Link to="/decisions">Decisions</Link>. Approval alone sends no request.</p>
      <ErrorLine error={loadError || error} />
      {!listing && !loadError && <p className="small" role="status">Loading connection permissions…</p>}
      {listing && RELEASE_CONNECTOR_KINDS.map(kind => {
        const connections = listing.connections.filter(c => c.kind === kind);
        return <div className="col" key={kind}>
          <b className="small">{CONNECTOR_DESCRIPTORS[kind].title}</b>
          {connections.length === 0 ? <p className="small muted">Read unavailable: no connection. <Link to="/connectors">Add connection</Link> · <Link to="/settings">Configure target</Link></p> : connections.map(c => {
            const read = c.actions.find(a => a.id === 'read');
            return <div key={c.id} className="row wrap small">
              <span>{c.name}</span><Badge tone={read?.allowed ? 'ok' : read?.pending ? 'warn' : 'idle'}>{read?.allowed ? 'read approved' : c.bindingCurrent === false ? 'settings changed' : c.state}</Badge>
              <span className="muted">Provider probe: {c.availability.status === 'available' ? c.availability.detail : 'unknown until explicitly read'}</span>
              {read?.allowed ? <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await post(`/api/connectors/${c.id}/read`, {}); await reload(); })}>Read {kind} now</button> : read?.pending ? <Link to="/decisions">Review read Decision</Link> : <button className="btn sm" disabled={busy || c.disabled || c.bindingCurrent === false} onClick={() => void run(async () => { await post(`/api/connectors/${c.id}/activate`, { action: 'read' }); await reload(); })}>Request {kind} read Decision</button>}
              <Link to="/connectors">Manage connection</Link>
            </div>;
          })}
        </div>;
      })}
    </div>
  </section><HostStrip state={state} listing={listing} /></>;
}

function HostStrip({ state, listing }: { state: ControlState; listing: Listing | null }) {
  const current = (kind: string, capability: ReleaseCapability) => listing?.connections.some(c => c.kind === kind && c.readCurrent && 'capabilities' in c.config && c.config.capabilities.includes(capability) && c.actions.some(a => a.id === 'read' && a.allowed)) ?? false;
  const savedHost = state.codeHost;
  const host = savedHost?.source === 'live' ? { ...savedHost,
    protected: current(savedHost.provider, 'branch-protection:read') ? savedHost.protected : null,
    protectionDetail: current(savedHost.provider, 'branch-protection:read') ? savedHost.protectionDetail : 'Live code-host evidence needs a fresh approved read for the current project settings.',
    checks: current(savedHost.provider, 'checks:read') ? savedHost.checks : [],
  } : savedHost;
  const savedInfra = state.infra;
  const infra = savedInfra ? { ...savedInfra,
    vercel: savedInfra.vercel.source === 'live' && !current('vercel', 'deployments:read') ? { ...savedInfra.vercel, state: 'unchecked' as const, detail: 'Vercel evidence needs a fresh approved read for the current project settings.' } : savedInfra.vercel,
    migrations: savedInfra.migrations.source === 'live' && !current('supabase', 'migrations:read') ? { ...savedInfra.migrations, state: 'unchecked' as const, detail: 'Migration evidence needs a fresh approved read for the current project settings.' } : savedInfra.migrations,
  } : null;
  const ci = ciSummary(host?.checks ?? []);
  const { busy, error, run } = useAction();
  const delivery = host?.delivery;
  return (
    <section className="card">
      <div className="card-h"><h2>Checks</h2></div>
      <div className="card-b col" style={{ gap: 6 }}>
        <p className="small muted">Connection health and CI here are read-only context. Release steps pass only after their own exact verification.</p>
        {error && <ErrorLine error={error} />}
        <Line tone={host?.protected === true ? 'ok' : host?.protected === false ? 'crit' : 'idle'} text={host?.protectionDetail ?? 'Branch protection has not been checked.'} />
        <Line tone={ci.state === 'green' ? 'ok' : ci.state === 'failing' ? 'crit' : 'idle'} text={host ? `CI: ${ci.detail}` : 'CI has not been checked.'} />
        <Line tone={infra?.docker.state === 'ready' ? 'ok' : infra?.docker.state === 'unavailable' || infra?.docker.state === 'degraded' ? 'warn' : 'idle'} text={infra?.docker.detail ?? 'Docker has not been checked.'} />
        <Line tone={infra?.postgres.state === 'ready' ? 'ok' : infra?.postgres.state === 'paused' || infra?.postgres.state === 'unhealthy' ? 'crit' : 'idle'} text={infra?.postgres.detail ?? 'Local Postgres has not been checked.'} />
        <Line tone={infra?.vercel.state === 'ready' ? 'ok' : infra?.vercel.state === 'error' ? 'crit' : 'idle'} text={infra?.vercel.detail ?? 'Vercel has not been checked.'} />
        <Line tone={infra?.migrations.state === 'in_sync' ? 'ok' : infra?.migrations.state === 'drift' ? 'warn' : 'idle'} text={infra?.migrations.detail ?? 'Migration history has not been read.'} />
        <p className="small faint">{delivery?.webhook === 'configured' ? 'Webhook authentication is configured.' : 'Webhook authentication is not configured.'} It is not registered with the host. Configured poll interval: {delivery?.pollSeconds ?? 60}s. Live reads run only when you choose Read now on an approved connection.</p>
        <FindingButton state={state} kind="unprotected_branch" show={host?.protected === false} label="Create issue for unprotected branch" busy={busy} run={run} />
        <FindingButton state={state} kind="ci" show={ci.state === 'failing'} label="Create issue for failing CI" busy={busy} run={run} />
        <FindingButton state={state} kind="migration_drift" show={infra?.migrations.state === 'drift'} label="Create issue for migration drift" busy={busy} run={run} />
      </div>
    </section>
  );
}

function FindingButton({ state, kind, show, label, busy, run }: { state: ControlState; kind: string; show: boolean; label: string; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<unknown> }) {
  if (!show) return null;
  const item = Object.values(state.workItems).find((w) => w.labels.includes('release-finding') && w.labels.includes(kind));
  if (item) {
    const unsynced = item.sync.status !== 'synced';
    return <p className="small">{item.title} · {unsynced ? `unsynced (${item.sync.status})` : 'synced'}{item.sync.lastError ? ` · ${item.sync.lastError}` : ''}</p>;
  }
  return <button className="btn" disabled={busy} onClick={() => void run(() => post('/api/release/findings', { kind }))}>{label}</button>;
}

function Line({ tone, text }: { tone: Tone; text: string }) {
  return <div className="row" style={{ gap: 8 }}><Badge tone={tone}>{tone === 'ok' ? 'checked' : tone === 'crit' ? 'attention' : 'not green'}</Badge><span className="small">{text}</span></div>;
}

function PlanEditor({ plan, busy, run }: { plan: ReleasePlan; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<unknown> }) {
  const [steps, setSteps] = useState(plan.steps);
  const [name, setName] = useState(plan.name);
  const frozen = plan.status !== 'active' || plan.steps.some(s => s.status === 'running' || s.status === 'uncertain');
  const editable = (rows: ReleaseStep[]) => rows.map(({ id, kind, title, owner, command, check, rollback, rollbackCheck, target, environment }) => ({ id, kind, title, owner, command, check, rollback, rollbackCheck, target, environment }));
  const dirty = name !== plan.name || JSON.stringify(editable(steps)) !== JSON.stringify(editable(plan.steps));
  const current = plan.steps.find((s) => s.status !== 'approved')?.id ?? null;
  const save = () => run(() => post(`/api/release/plans/${plan.id}`, { name, steps: editable(steps) }));
  const move = (index: number, dir: -1 | 1) => {
    const next = steps.slice();
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    if (next[index].status === 'approved' || next[j].status === 'approved') return;
    [next[index], next[j]] = [next[j], next[index]];
    setSteps(next.map((s, order) => ({ ...s, order })));
  };
  return (
    <section className="col" style={{ gap: 10 }}>
      <div className="row wrap">
        <label className="col small" style={{ gap: 4 }}>
          Name
          <input aria-label="Release name" value={name} disabled={frozen} onChange={(e) => setName(e.target.value)} />
        </label>
        <span className="small faint">{plan.sha ? `merge ${plan.sha.slice(0, 10)}` : 'no merge SHA bound'}</span>
        {plan.status === 'active' && <button className="btn" disabled={busy || frozen} onClick={() => void save()}>Save plan</button>}
        {plan.status === 'active' && <button className="btn" disabled={busy || frozen} onClick={() => void run(() => post(`/api/release/plans/${plan.id}/cancel`, {}))}>Cancel plan</button>}
      </div>
      {dirty && <p className="small" role="status">Save these edits before requesting approval.</p>}
      {steps.map((step, index) => (
        <StepCard key={step.id} planId={plan.id} step={step} index={index} current={plan.status === 'active' && step.id === current} locked={frozen || step.status === 'approved'} busy={busy} dirty={dirty} onChange={(patch) => setSteps(previous => previous.map((s) => s.id === step.id ? { ...s, ...patch } : s))} onMove={(dir) => move(index, dir)} run={run} />
      ))}
      {plan.status === 'active' && (
        <button className="btn" disabled={busy || frozen} onClick={() => setSteps([...steps, blank(steps.length)])}>Add step</button>
      )}
    </section>
  );
}

function blank(order: number): ReleaseStep {
  return { id: `new-${order}-${Date.now()}`, order, kind: 'custom', title: 'Custom step', owner: 'owner', target: 'local', environment: 'unconfigured', command: 'Describe the command', check: 'Describe the check', rollback: 'Describe the rollback', decisionId: null, approval: 'pending', status: 'pending', evidence: null, checkedAt: null };
}

function StepCard({ planId, step, index, current, locked, busy, dirty, onChange, onMove, run }: { planId: string; step: ReleaseStep; index: number; current: boolean; locked: boolean; busy: boolean; dirty: boolean; onChange: (patch: Partial<ReleaseStep>) => void; onMove: (dir: -1 | 1) => void; run: (fn: () => Promise<unknown>) => Promise<unknown> }) {
  const human = step.evidence?.attestation === 'human';
  const tone: Tone = step.status === 'uncertain' ? 'warn' : step.status === 'failed' ? 'crit' : step.status === 'approved' && step.evidence?.ok === true ? 'ok' : 'idle';
  const label = step.status === 'uncertain' ? 'uncertain' : step.status === 'failed' ? 'failed' : step.status === 'approved' ? 'verified' : step.status === 'running' ? 'running' : current ? 'next' : 'waiting';
  return (
    <article className="card">
      <div className="card-h">
        <b>{index + 1}. {step.title}</b>
        <Badge tone={tone}>{label}</Badge>
        {human && <Badge tone="warn">human attestation</Badge>}
        {(IRREVERSIBLE_RELEASE_STEPS.includes(step.kind) || step.command.startsWith('check:')) && <Badge tone="crit">second confirmation</Badge>}
        <span className="spacer" />
        <button className="btn sm ghost" disabled={locked || busy} onClick={() => onMove(-1)}>Move up</button>
        <button className="btn sm ghost" disabled={locked || busy} onClick={() => onMove(1)}>Move down</button>
      </div>
      <div className="card-b col" style={{ gap: 8 }}>
        <div className="row wrap">
          <label className="small col" style={{ gap: 4 }}>Kind
            <select aria-label={`${step.title} kind`} disabled={locked} value={step.kind} onChange={(e) => onChange({ kind: e.target.value as ReleaseStepKind })}>
              {RELEASE_STEP_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="small col grow" style={{ gap: 4 }}>Owner
            <input aria-label={`${step.title} owner`} disabled={locked} value={step.owner} onChange={(e) => onChange({ owner: e.target.value })} />
          </label>
        </div>
        <Field label={`${step.title} target`} value={step.target} disabled={locked} onChange={(target) => onChange({ target })} />
        <Field label={`${step.title} environment`} value={step.environment} disabled={locked} onChange={(environment) => onChange({ environment })} />
        <Field label={`${step.title} command`} value={step.command} disabled={locked} onChange={(command) => onChange({ command })} />
        <Field label={`${step.title} check`} value={step.check} disabled={locked} onChange={(check) => onChange({ check })} />
        <Field label={`${step.title} rollback`} value={step.rollback} disabled={locked} onChange={(rollback) => onChange({ rollback })} />
        <Field label={`${step.title} rollback check`} value={step.rollbackCheck ?? ''} disabled={locked} onChange={(rollbackCheck) => onChange({ rollbackCheck: rollbackCheck || undefined })} />
        {step.evidence && <p className="small">{step.evidence.summary}</p>}
        {step.evidence?.proof && <p className="small faint">Verification: {step.evidence.proof.source} · {step.evidence.proof.acceptanceEnvironment ?? 'scope unverified'} · SHA {step.evidence.proof.sha} · {step.evidence.proof.phase}</p>}
        {step.status === 'failed' && <p className="small">Rollback: {step.rollback}</p>}
        {current && step.status === 'failed' && <><button className="btn" disabled={busy || dirty} onClick={() => void run(() => post(`/api/release/plans/${planId}/steps/${step.id}/rollback`, {}))}>Request rollback approval</button><Link to="/decisions" className="small">Review rollback in Decisions</Link></>}
        {current && step.status === 'uncertain' && <><button className="btn" disabled={busy || dirty} onClick={() => void run(() => post(`/api/release/plans/${planId}/steps/${step.id}/inspect`, {}))}>Inspect interrupted write</button><Link to="/decisions" className="small">Review inspection in Decisions</Link></>}
        {current && step.status !== 'uncertain' && step.status !== 'running' && <StepDecision planId={planId} step={step} busy={busy || dirty} />}
        {!current && step.status !== 'approved' && <p className="small faint">Waiting on the earlier step. This one cannot be skipped.</p>}
      </div>
    </article>
  );
}

function Field({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <label className="small col" style={{ gap: 4 }}>{label}
      <input aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function StepDecision({ planId, step, busy }: { planId: string; step: ReleaseStep; busy: boolean }) {
  const [decisionId, setDecisionId] = useState<string | null>(step.decisionId);
  const [confirm, setConfirm] = useState<{ answer: string; nonce: string } | null>(null);
  const { busy: answering, error, run: localRun } = useAction();
  const choose = (option: string) => localRun(async () => {
    const created = await post<{ decision: { id: string } }>(`/api/release/plans/${planId}/steps/${step.id}/decision`, {});
    const id = created.decision.id;
    setDecisionId(id);
    const prepared = await post<{ confirm: boolean; nonce: string | null }>(`/api/decisions/${id}/prepare`, { answer: option });
    if (prepared.confirm && prepared.nonce) setConfirm({ answer: option, nonce: prepared.nonce });
    else await post(`/api/decisions/${id}/answer`, { answer: option, nonce: null, channel: channel() });
  });
  return (
    <div className="col" style={{ gap: 6 }}>
      {error && <ErrorLine error={error} />}
      {!confirm && (
        <div className="row">
          <button className="btn" disabled={busy || answering} onClick={() => void choose('approve')}>Approve this step</button>
          <button className="btn" disabled={busy || answering} onClick={() => void choose('reject')}>Reject this step</button>
        </div>
      )}
      {confirm && (
        <div className="col" style={{ gap: 6 }}>
          <p className="small">Confirm “{confirm.answer}” for this saved step only. {step.command === 'attest:device' ? 'Human attestation alone leaves acceptance unverified.' : 'This runs the approved command and fresh verification.'}</p>
          <button className="btn" disabled={busy || answering} onClick={() => void localRun(async () => { await post(`/api/decisions/${decisionId}/answer`, { answer: confirm.answer, nonce: confirm.nonce, channel: channel() }); setConfirm(null); setDecisionId(null); })}>Confirm {confirm.answer}</button>
        </div>
      )}
    </div>
  );
}
