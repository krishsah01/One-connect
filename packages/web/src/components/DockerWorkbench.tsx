// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Project Docker workbench: only this project's Compose binding, honest readiness from real
// healthchecks, and every change gated by a single-use approval for the exact command shown.
import { useEffect, useState } from 'react';
import { shellJoin, type Decision } from '@acc/core';
import { Badge, ErrorLine, useAction } from './common';
import { api, post } from '../lib/api';
import type { Tone } from '../lib/format';

type Action = 'up' | 'stop' | 'restart' | 'build' | 'pull' | 'down';
interface Port { host: number | null; container: number | null; hostIp: string | null; conflict: string | null }
interface Service {
  name: string; source: 'project' | 'database'; image: string | null; build: boolean; declaredHealthcheck: boolean;
  container: { id: string; name: string; state: string; health: string | null; healthLog: string | null; startedAt: string | null; image: string } | null;
  readiness: 'ready' | 'running-unchecked' | 'starting' | 'unhealthy' | 'stopped' | 'not-created'; readinessDetail: string;
  imagePresent: boolean | null; ports: Port[]; volumes: string[];
}
export type Connection =
  | { kind: 'postgres'; service: string; host: string; port: number; database: string; user: string; password: 'hidden'; passwordFile: string; url: string; volume: string; shell: string[] }
  | { kind: 'sqlite'; name: string; url: string; file: string; exists: boolean };
interface Job { id: string; action: Action; services: string[]; argv: string[]; state: 'running' | 'succeeded' | 'failed' | 'interrupted'; exitCode: number | null; output: string; startedAt: string; endedAt: string | null }
export interface EnvironmentStatus {
  availability: { installed: boolean; engine: boolean; compose: boolean; local: boolean; version: string | null; composeVersion: string | null; endpoint: string | null; error: string | null };
  project: string; repo: string; files: string[]; warnings: string[]; databases: Connection[]; jobs: Job[]; approvalSeconds: number;
  services: Service[]; foreign: { id: string; name: string; workingDir: string | null }[];
}
interface Requested { decision: Decision | null; argv: string[]; digest?: string; network?: boolean; expiresAt?: string; blockers: string[] }
interface DatabasePlan {
  spec: Record<string, unknown> & { kind: 'postgres' | 'sqlite' };
  files: { path: string; mode: string; contents: string | null; note: string }[];
  steps: { id: string; title: string; network: boolean; argv: string[]; needed: boolean; action: Action }[];
  connection: Partial<Connection>; volume?: string; warnings: string[];
}

const READY_TONE: Record<Service['readiness'], Tone> = { ready: 'ok', 'running-unchecked': 'info', starting: 'warn', unhealthy: 'crit', stopped: 'idle', 'not-created': 'idle' };
const READY_LABEL: Record<Service['readiness'], string> = { ready: 'ready', 'running-unchecked': 'running · no healthcheck', starting: 'starting', unhealthy: 'unhealthy', stopped: 'stopped', 'not-created': 'not created' };
/** POSIX shell rendering of an argv, used for previews and terminal pre-fill. */

export function DockerWorkbench({ onTerminal }: { onTerminal?: (command: string) => void }) {
  const [status, setStatus] = useState<EnvironmentStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState<Requested | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ service: string; text: string; truncated: boolean; limit: string } | null>(null);
  const [logService, setLogService] = useState('');
  const { busy, error, run } = useAction();
  const refresh = (force = false) => api<EnvironmentStatus>(`/api/environment${force ? '?refresh=1' : ''}`).then(s => { setStatus(s); setLoadError(''); }).catch(e => setLoadError((e as Error).message));
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 5000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!logService) return;
    const load = () => api<{ service: string; text: string; truncated: boolean; limit: string }>(`/api/environment/services/${encodeURIComponent(logService)}/logs`).then(setLogs).catch(e => setLogs({ service: logService, text: (e as Error).message, truncated: false, limit: '' }));
    void load(); const t = setInterval(load, 3000); return () => clearInterval(t);
  }, [logService]);
  const request = (action: Action, services: string[] = []) => run(async () => { setConfirmation(null); setPending(await post<Requested>('/api/environment/actions', { action, services })); });
  const resolve = (answer: 'approve' | 'deny') => run(async () => {
    if (!pending?.decision) return;
    if (answer === 'approve' && !confirmation) {
      const prepared = await post<{ confirm: boolean; nonce: string | null }>(`/api/decisions/${pending.decision.id}/prepare`, { answer });
      if (prepared.confirm && prepared.nonce) { setConfirmation(prepared.nonce); return; }
    }
    await post(`/api/environment/actions/${pending.decision.id}/resolve`, { answer, digest: pending.digest, nonce: confirmation, channel: window.innerWidth < 640 ? 'phone' : 'web' });
    setPending(null);
    setConfirmation(null);
    await refresh(true);
  });
  const a = status?.availability;
  const usable = Boolean(a?.engine && a.compose && a.local);
  const tone: Tone = !a ? 'idle' : usable ? 'ok' : a.engine ? 'crit' : 'warn';
  return <section className="card" aria-label="Project Docker"><div className="card-h"><h2>Project Docker</h2><Badge tone={tone}>{!a ? 'checking…' : usable ? `Docker ${a.version ?? ''} · local` : a.installed ? (a.engine ? 'not local' : 'engine stopped') : 'not installed'}</Badge><span className="spacer" /><button className="btn sm" disabled={busy} onClick={() => void run(() => refresh(true))}>Refresh</button></div><div className="card-b col">
    {loadError && <p className="small muted">{loadError}</p>}
    {a?.error && <div className="banner tone-warn" role="status">{a.error}</div>}
    {status && <p className="small muted">Compose project <code>{status.project}</code> in <code>{status.repo}</code>{status.files.length ? <> · files {status.files.map(f => <code key={f} style={{ marginRight: 4 }}>{f}</code>)}</> : ' · no Compose file yet'}. Only containers with this project label <em>and</em> this working directory are controlled. Each action runs once, after you approve its exact command, within {status.approvalSeconds / 60} minutes.</p>}
    {status?.warnings.map(w => <p key={w} className="small banner tone-warn">{w}</p>)}
    {status && !status.services.length && <p className="faint">No services declared. Add a <code>compose.yaml</code> to the repository or create a local database below.</p>}
    {status?.services.map(s => <div key={`${s.source}:${s.name}`} className="col" style={{ gap: 4, borderTop: '1px solid var(--line, #2a3240)', paddingTop: 8 }}>
      <div className="row wrap"><b>{s.name}</b>{s.source === 'database' && <Badge tone="accent">One Connect database</Badge>}<Badge tone={READY_TONE[s.readiness]} title={s.readinessDetail}>{READY_LABEL[s.readiness]}</Badge>
        <span className="small faint">{s.build ? 'built from Dockerfile' : s.image}{s.imagePresent === false && ' · image not present locally'}</span><span className="spacer" />
        <button className="btn sm" onClick={() => setLogService(logService === s.name ? '' : s.name)}>{logService === s.name ? 'Hide logs' : 'Logs'}</button>
        <button className="btn sm" disabled={busy || !usable} onClick={() => void request('up', [s.name])}>Start</button>
        <button className="btn sm" disabled={busy || !usable || !s.container} onClick={() => void request('stop', [s.name])}>Stop</button>
        <button className="btn sm" disabled={busy || !usable || !s.container} onClick={() => void request('restart', [s.name])}>Restart</button>
        {s.build && <button className="btn sm" disabled={busy || !usable} onClick={() => void request('build', [s.name])}>Build</button>}
        {s.imagePresent === false && <button className="btn sm" disabled={busy || !usable} onClick={() => void request('pull', [s.name])}>Pull image</button>}
      </div>
      <span className="small muted">{s.readinessDetail}{!s.declaredHealthcheck && s.readiness !== 'not-created' && ' Add a healthcheck to report real readiness.'}</span>
      {s.container?.healthLog && s.readiness !== 'ready' && <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.container.healthLog}</pre>}
      {s.ports.length > 0 && <span className="small">Ports: {s.ports.map((p, i) => <span key={i} style={{ marginRight: 8 }}>{p.hostIp ? `${p.hostIp}:` : ''}{p.host ?? '?'} → {p.container ?? '?'}{p.conflict && <Badge tone="crit" title={p.conflict}>conflict</Badge>}</span>)}</span>}
      {s.ports.filter(p => p.conflict).map(p => <span key={p.conflict!} className="small" role="alert">{p.conflict}</span>)}
      {s.volumes.length > 0 && <span className="small faint">Volumes: {s.volumes.join(', ')}</span>}
    </div>)}
    {status && status.services.length > 0 && <div className="row wrap"><button className="btn sm" disabled={busy || !usable} onClick={() => void request('up')}>Start all</button><button className="btn sm" disabled={busy || !usable} onClick={() => void request('stop')}>Stop all</button><button className="btn sm danger" disabled={busy || !usable} title="Removes this project's containers and network. Named volumes, including database data, are kept." onClick={() => void request('down')}>Down (keep volumes)</button></div>}
    {pending && <PendingAction pending={pending} confirming={Boolean(confirmation)} busy={busy} onResolve={resolve} onCancel={() => { setPending(null); setConfirmation(null); }} onTerminal={onTerminal} />}
    {status?.foreign.length ? <div className="col small"><b>Not controlled here</b><span className="muted">These containers use the Compose name <code>{status.project}</code> but belong to another directory, so One Connect leaves them alone.</span>{status.foreign.map(f => <span key={f.id}><code>{f.name}</code> · {f.workingDir ?? 'unknown directory'}</span>)}</div> : null}
    {logService && logs && <div className="col"><div className="row"><b>{logs.service} logs</b><span className="small faint">{logs.limit} · refreshes every 3 seconds{logs.truncated ? ' · truncated' : ''}</span></div><pre style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{logs.text || '(empty)'}</pre></div>}
    {status?.jobs.length ? <div className="col small"><b>Recent actions</b>{status.jobs.map(j => <details key={j.id}><summary><Badge tone={j.state === 'succeeded' ? 'ok' : j.state === 'running' ? 'info' : 'crit'}>{j.state}</Badge> <code>{j.action}{j.services.length ? ` ${j.services.join(' ')}` : ''}</code>{j.exitCode !== null && ` · exit ${j.exitCode}`}</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{shellJoin(j.argv)}{'\n\n'}{j.output || '(no output)'}</pre></details>)}</div> : null}
    <ErrorLine error={error} />
    {status && <DatabaseWizard status={status} usable={usable} busy={busy} onRequest={request} onTerminal={onTerminal} onCreated={() => void refresh(true)} />}
  </div></section>;
}

function PendingAction({ pending, confirming, busy, onResolve, onCancel, onTerminal }: { pending: Requested; confirming: boolean; busy: boolean; onResolve: (a: 'approve' | 'deny') => void; onCancel: () => void; onTerminal?: (command: string) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = pending.expiresAt ? Math.max(0, Math.round((Date.parse(pending.expiresAt) - now) / 1000)) : 0;
  const command = shellJoin(pending.argv);
  return <div className="banner col" role="dialog" aria-label="Approve Docker action">
    <b>{pending.decision ? 'Approve this exact command?' : 'This action cannot run yet'}</b>
    <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{command}</pre>
    {pending.blockers.map(b => <span key={b} className="small" role="alert">{b}</span>)}
    {pending.network && <span className="small"><Badge tone="warn">network</Badge> This contacts an image registry and may download images.</span>}
    {pending.decision?.irreversible && <span className="small">Removes this project's containers and network. Named volumes are kept.</span>}
    {pending.decision && <span className="small faint">{left > 0 ? `Single use · expires in ${left}s` : 'Expired. Request the action again.'}</span>}
    <div className="row wrap">
      {confirming && <span role="alert" className="small">Confirm the exact command above once more to authorize it.</span>}
      {pending.decision && <><button className="btn primary" disabled={busy || left === 0} onClick={() => onResolve('approve')}>{confirming ? 'Yes, run this command' : 'Approve and run'}</button><button className="btn" disabled={busy} onClick={() => onResolve('deny')}>Deny</button></>}
      {onTerminal && <button className="btn sm" onClick={() => onTerminal(command)}>Open in terminal</button>}
      {!pending.decision && <button className="btn sm" onClick={onCancel}>Dismiss</button>}
    </div>
  </div>;
}

function DatabaseWizard({ status, usable, busy, onRequest, onTerminal, onCreated }: { status: EnvironmentStatus; usable: boolean; busy: boolean; onRequest: (a: Action, s: string[]) => void; onTerminal?: (command: string) => void; onCreated: () => void }) {
  const [kind, setKind] = useState<'postgres' | 'sqlite'>('postgres');
  const [form, setForm] = useState({ service: 'db', database: 'app', user: 'app', version: '16-alpine', port: '5432', name: 'app' });
  const [plan, setPlan] = useState<DatabasePlan | null>(null);
  const [created, setCreated] = useState(false);
  const w = useAction();
  const spec = () => kind === 'sqlite' ? { kind, name: form.name } : { kind, service: form.service, database: form.database, user: form.user, version: form.version, port: Number(form.port) };
  const field = (k: keyof typeof form, label: string) => <label className="col small" style={{ gap: 2 }}>{label}<input aria-label={label} value={form[k]} onChange={e => { setForm({ ...form, [k]: e.target.value }); setPlan(null); setCreated(false); }} /></label>;
  return <div className="col" style={{ gap: 10, borderTop: '1px solid var(--line, #2a3240)', paddingTop: 10 }}>
    <h3 style={{ fontSize: 15, margin: 0 }}>Local databases</h3>
    {status.databases.map(c => <ConnectionCard key={c.kind === 'postgres' ? c.service : c.name} c={c} usable={usable} busy={busy} onRequest={onRequest} onTerminal={onTerminal} />)}
    <p className="small muted">Creates a development database owned by this project. Files go in the project's private data folder with owner-only permissions; the password is generated, never shown and never sent to agents. Nothing is pulled or started until you approve each step.</p>
    <div className="row wrap">
      <label className="col small" style={{ gap: 2 }}>Engine<select aria-label="Database engine" value={kind} onChange={e => { setKind(e.target.value as 'postgres' | 'sqlite'); setPlan(null); setCreated(false); }}><option value="postgres">Postgres (Docker)</option><option value="sqlite">SQLite (file)</option></select></label>
      {kind === 'postgres' ? <>{field('service', 'Service name')}{field('database', 'Database')}{field('user', 'User')}{field('version', 'Image tag')}{field('port', 'Host port')}</> : field('name', 'File name')}
    </div>
    <div className="row"><button className="btn" disabled={w.busy} onClick={() => void w.run(async () => { setCreated(false); setPlan(await post<DatabasePlan>('/api/environment/database/plan', spec())); })}>Preview plan</button></div>
    {plan && <div className="col" style={{ gap: 6 }} aria-label="Database plan">
      {plan.warnings.map(x => <span key={x} className="small banner tone-warn">{x}</span>)}
      <b className="small">Files</b>
      {plan.files.map(f => <details key={f.path} open={Boolean(f.contents)}><summary className="small"><code>{f.path}</code> · {f.mode} · {f.note}</summary>{f.contents && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{f.contents}</pre>}</details>)}
      {plan.steps.length > 0 && <><b className="small">Steps after the files exist (each needs its own approval)</b>{plan.steps.map(s => <div key={s.id} className="col small"><span>{s.title}{s.network && <> <Badge tone="warn">network</Badge></>}{!s.needed && <> <Badge tone="ok">not needed</Badge></>}</span><code style={{ whiteSpace: 'pre-wrap' }}>{shellJoin(s.argv)}</code></div>)}</>}
      {plan.volume && <span className="small faint">Data lives in Docker volume <code>{plan.volume}</code>, kept across restarts and <code>down</code>.</span>}
      <div className="row"><button className="btn primary" disabled={w.busy || created} onClick={() => void w.run(async () => { await post('/api/environment/database/create', spec()); setCreated(true); onCreated(); })}>{created ? 'Files created' : 'Create these files'}</button></div>
      {created && plan.spec.kind === 'postgres' && <div className="row wrap">{plan.steps.filter(s => s.needed).map(s => <button key={s.id} className="btn sm" disabled={busy || !usable} onClick={() => onRequest(s.action, [String(plan.spec.service)])}>{s.action === 'pull' ? 'Request image pull' : 'Request start'}</button>)}</div>}
    </div>}
    <ErrorLine error={w.error} />
  </div>;
}

function ConnectionCard({ c, usable, busy, onRequest, onTerminal }: { c: Connection; usable: boolean; busy: boolean; onRequest: (a: Action, s: string[]) => void; onTerminal?: (command: string) => void }) {
  if (c.kind === 'sqlite') return <div className="col small"><b>SQLite · {c.name}</b><span>File <code>{c.file}</code>{!c.exists && ' (missing)'}</span><span>URL <code>{c.url}</code></span></div>;
  return <div className="col small" aria-label={`Postgres ${c.service}`}><b>Postgres · {c.service}</b>
    <span>Host <code>{c.host}</code> · port <code>{c.port}</code> · database <code>{c.database}</code> · user <code>{c.user}</code></span>
    <span>Password: hidden · stored in <code>{c.passwordFile}</code> (owner-only)</span>
    <span>URL <code>{c.url}</code></span>
    <span className="faint">Volume <code>{c.volume}</code></span>
    <div className="row wrap"><button className="btn sm" disabled={busy || !usable} onClick={() => onRequest('up', [c.service])}>Start</button>{onTerminal && <button className="btn sm" onClick={() => onTerminal(shellJoin(c.shell))}>Open psql in terminal</button>}</div>
  </div>;
}
