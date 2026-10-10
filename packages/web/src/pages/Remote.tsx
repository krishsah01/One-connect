// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Phone and alerts: install status, authenticated remote access (off by default), and notification
// routing. Remote access shows the exact plan before anything runs, needs a recorded Decision for
// each launch, and never claims reachability that nothing has proven. Managed from the Mac only.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ControlState, Decision, NotificationConfig, NotificationRecord, RemoteConfig, RemoteScope } from '@acc/core';
import { NOTIFICATION_KINDS, NOTIFICATION_KIND_LABEL, REMOTE_SCOPES, REMOTE_SCOPE_INFO } from '@acc/core';
import { Badge, Copy, ErrorLine, Toggle, useAction, useTick } from '../components/common';
import { NotificationInbox } from '../components/NotificationInbox';
import { api, post } from '../lib/api';
import { ago, until } from '../lib/format';
import { canPromptInstall, captureInstallPrompt, installState, notificationPermission, promptInstall, requestNotificationPermission, type NotificationPermissionState } from '../lib/pwa';
import { can, useRemoteSession } from '../lib/remote';

interface Plan { adapter: string; title: string; port: number; start: { command: string; args: string[] }[]; teardown: { command: string; args: string[] }[]; exposes: string; touchesTailnet: boolean; warnings: string[]; digest: string; publicInternet: false }
interface Review { plan: Plan; adapter: { title: string; installed: boolean; note: string }; scopes: { scope: RemoteScope; title: string; detail: string; granted: boolean }[]; limits: Record<string, number>; controls: string[]; blockedBy: string[]; executed: false }
interface Status {
  config: RemoteConfig; scopes: Review['scopes']; adapter: { id: string; title: string; installed: boolean; note: string; testOnly: boolean };
  tunnel: { state: string; hostname: string | null; detail: string; since: string | null };
  localDaemon: { ready: boolean; note: string }; reachability: { state: string; note: string };
  sessions: { id: string; label: string; scopes: string[]; createdAt: string; expiresAt: string; lastSeenAt: string; revokedAt: string | null; revokedReason: string | null }[];
  pendingPairings: { id: string; expiresAt: string }[]; locks: { pairing: string | null }; pendingDecision: Decision | null; validation: string;
}
interface NotifStatus {
  config: NotificationConfig; quietNow: boolean;
  pendingDeliveries?: { decisionId: string; notificationId: string; channel: 'webpush' | 'chat'; host: string; title: string; expiresAt: string }[];
  channels: { native: { enabled: boolean; note: string; last: { ok: boolean; detail: string } | null }; browser: { enabled: boolean; note: string };
    webpush: EndpointView; chat: EndpointView };
}
interface EndpointView { enabled: boolean; endpoint: string | null; authorized: boolean; problem: string | null; expiresAt: string | null; note: string; last: { ok: boolean; detail: string } | null }

const TUNNEL_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'idle'> = { up: 'ok', starting: 'warn', reconnecting: 'warn', error: 'crit', down: 'idle' };

export function Remote({ state }: { state: ControlState }) {
  const { session, mode } = useRemoteSession();
  if (mode === 'paired' && session) return <div className="page col" style={{ gap: 14 }}><h1>Phone & alerts</h1><div className="banner tone-info">Remote access and notification settings are managed on the Mac. This paired phone can read status and answer what its scopes allow.</div>{can(session, 'read') && <NotificationInbox limit={20} />}</div>;
  if (mode === 'offline' && session) return <div className="page col" style={{ gap: 14 }}><h1>Phone & alerts</h1><div className="banner tone-warn">Offline: remote settings are managed on the Mac. The last paired identity is shown for reference only.</div>{can(session, 'read') && <NotificationInbox limit={20} />}</div>;
  if (mode === 'checking') return <div className="page col" style={{ gap: 14 }}><h1>Phone & alerts</h1><div className="banner tone-info" role="status">Checking this browser&apos;s project access…</div></div>;
  if (mode === 'unauthorized') return <div className="page col" style={{ gap: 14 }}><h1>Phone & alerts</h1><div className="banner tone-warn" role="status">This browser is not authorized to manage phone settings. Pair from a Mac that has remote access enabled, or open the dashboard on this Mac.</div></div>;
  if (mode === 'offline') return <div className="page col" style={{ gap: 14 }}><h1>Phone & alerts</h1><div className="banner tone-warn" role="status">Offline: phone and alert settings cannot be loaded. Reconnect to manage them on the Mac.</div></div>;
  if (mode !== 'local') return <div className="page col" style={{ gap: 14 }}><h1>Phone & alerts</h1><div className="banner tone-warn" role="status">Phone settings are unavailable in this mode.</div></div>;
  return (
    <div className="page col remote-page" style={{ gap: 18 }}>
      <div className="page-heading"><div><h1>Phone & alerts</h1><p>Use One Connect from your phone through an installable app and a private, authenticated tunnel, and choose which alerts reach you. Everything outward-facing is off until you turn it on.</p></div></div>
      <InstallCard />
      <RemoteCard state={state} />
      <NotificationSettings />
      <NotificationInbox limit={20} />
    </div>
  );
}

function InstallCard() {
  const [, tick] = useState(0);
  useEffect(() => { captureInstallPrompt(); const t = setTimeout(() => tick((n) => n + 1), 800); return () => clearTimeout(t); }, []);
  const { busy, error, run } = useAction();
  const st = installState();
  return (
    <section className="card"><div className="card-b col" style={{ gap: 8 }}>
      <div className="row wrap"><h2>Install as an app</h2><Badge tone={st === 'standalone' ? 'ok' : 'idle'}>{st === 'standalone' ? 'running as an installed app' : 'running in a browser tab'}</Badge></div>
      <p className="small muted" style={{ margin: 0 }}>One Connect has a web app manifest, icons and an offline page, so browsers can install it. Only your browser decides whether it is installed; this page cannot confirm that from here. On iPhone use Share, then Add to Home Screen. In Chrome or Edge use the install icon in the address bar.</p>
      <p className="small muted" style={{ margin: 0 }}>Offline, the app shows an offline page. Status, transcripts, questions and approvals are never stored on the device, and nothing you do offline is queued.</p>
      {canPromptInstall() && <button className="btn" disabled={busy} onClick={() => void run(async () => { await promptInstall(); })}>Install One Connect</button>}
      <ErrorLine error={error} />
    </div></section>
  );
}

function RemoteCard({ state }: { state: ControlState }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pairing, setPairing] = useState<{ url: string; expiresAt: string } | null>(null);
  const { busy, error, run } = useAction();
  const now = useTick(5000);
  const load = useCallback(() => api<Status>('/api/remote/status').then(setStatus).catch(() => undefined), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);
  // The decision shows up live through state; refresh when it changes.
  const dec = Object.values(state.decisions).find((d) => d.kind === 'remote' && !d.answeredAt && !d.consumedAt) ?? null;
  useEffect(() => { void load(); }, [dec?.id, load]);
  if (!status) return <section className="card card-b">Loading remote access…</section>;
  const c = status.config;
  const patch = (p: Partial<RemoteConfig>) => run(async () => { await post('/api/remote/config', p); setReview(null); await load(); });
  const toggleScope = (s: RemoteScope) => patch({ scopes: c.scopes.includes(s) ? c.scopes.filter((x) => x !== s) : [...c.scopes, s] });
  const t = status.tunnel;
  return (
    <section className="card"><div className="card-b col" style={{ gap: 12 }}>
      <div className="row wrap"><h2>Remote access</h2><Badge tone={c.enabled ? 'warn' : 'idle'}>{c.enabled ? 'enabled' : 'disabled'}</Badge><span className="spacer" /><Toggle on={c.enabled} onChange={(v) => void patch({ enabled: v })} label="Enable remote access" /></div>
      {!c.enabled && <p className="small muted" style={{ margin: 0 }}>Disabled. The dashboard is reachable only on this Mac. Enabling it does not open anything: a tunnel starts only after you review the exact plan and approve a Decision.</p>}
      <div className="remote-grid">
        <div className="col" style={{ gap: 6 }}>
          <b className="small">What a paired phone may do</b>
          {REMOTE_SCOPES.map((s) => { const info = status.scopes.find((x) => x.scope === s) ?? REMOTE_SCOPE_INFO[s]; return <label key={s} className="row scope-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={c.scopes.includes(s)} disabled={busy || (c.scopes.length === 1 && c.scopes.includes(s))} onChange={() => void toggleScope(s)} /><span><b>{info.title}</b><br /><span className="small muted">{info.detail}</span></span></label>; })}
          <span className="small faint">Scopes apply only to this project. Narrowing takes effect immediately; adding a scope requires a new pairing. Project Decisions allow exact Docker, environment, release, cost, security settings, connector and message actions. Source diffs, connection management, Docker management, the vault, project management and these settings remain on the Mac.</span>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <b className="small">Limits</b>
          <label className="small">Phones at once<input type="number" min={1} max={5} value={c.maxSessions} onChange={(e) => void patch({ maxSessions: Number(e.target.value) })} /></label>
          <label className="small">Session length (hours)<input type="number" min={1} max={168} value={c.sessionTtlHours} onChange={(e) => void patch({ sessionTtlHours: Number(e.target.value) })} /></label>
          <label className="small">Idle timeout (minutes)<input type="number" min={5} max={1440} value={c.idleTimeoutMinutes} onChange={(e) => void patch({ idleTimeoutMinutes: Number(e.target.value) })} /></label>
          <label className="small">Pairing link lifetime (seconds)<input type="number" min={60} max={900} value={c.pairingTtlSeconds} onChange={(e) => void patch({ pairingTtlSeconds: Number(e.target.value) })} /></label>
          <label className="small">Tailscale HTTPS port<select value={c.httpsPort} onChange={(e) => void patch({ httpsPort: Number(e.target.value) as RemoteConfig['httpsPort'] })}><option value={8443}>8443 (default)</option><option value={443}>443</option><option value={10000}>10000</option></select></label>
        </div>
      </div>
      <div className="kv small">
        <span>Adapter</span><span>{status.adapter.title}{status.adapter.installed ? '' : ' · CLI not found'}</span>
        <span>Local daemon</span><span>{status.localDaemon.ready ? 'ready' : 'not ready'} <span className="faint">({status.localDaemon.note})</span></span>
        <span>Tunnel</span><span><Badge tone={TUNNEL_TONE[t.state] ?? 'idle'}>{t.state}</Badge> {t.hostname ?? ''} <span className="faint">{t.detail}</span></span>
        <span>Reachability</span><span><Badge tone={status.reachability.state === 'phone_connected' ? 'ok' : 'idle'}>{status.reachability.state.replace('_', ' ')}</Badge> <span className="faint">{status.reachability.note}</span></span>
      </div>
      <div className="row wrap">
        <button className="btn" disabled={busy} onClick={() => void run(async () => setReview(await api<Review>('/api/remote/review')))}>Review exact plan (dry run)</button>
        <button className="btn primary" disabled={busy || !c.enabled || t.state === 'up' || t.state === 'starting' || Boolean(dec)} onClick={() => void run(async () => { await post('/api/remote/launch'); await load(); })}>Request tunnel launch</button>
        {(t.state === 'up' || t.state === 'reconnecting' || t.state === 'starting') && <button className="btn danger" disabled={busy} onClick={() => void run(async () => { await post('/api/remote/stop'); await load(); })}>Stop tunnel</button>}
      </div>
      {review && <PlanReview review={review} />}
      {dec && <div className="banner tone-warn small" role="status">A launch is waiting for your Decision: <b>{dec.question}</b> <Link to="/decisions">Open Decisions</Link>. Approving asks for a second confirmation. Nothing has started.</div>}
      {t.state === 'up' && (
        <div className="col pairing-box" style={{ gap: 8 }}>
          <b className="small">Pair a phone</b>
          <button className="btn primary" disabled={busy} onClick={() => void run(async () => { const r = await post<{ url: string; expiresAt: string }>('/api/remote/pairings'); setPairing({ url: r.url, expiresAt: r.expiresAt }); await load(); })}>Create single-use pairing link</button>
          {pairing && (
            <div className="col" style={{ gap: 6 }}>
              <div className="small">Open this on your phone within {until(pairing.expiresAt, now)}. It works once. The token sits after the # so it is never sent to a server or logged, and the page removes it from the address bar immediately.</div>
              <input readOnly value={pairing.url} aria-label="Pairing link" onFocus={(e) => e.currentTarget.select()} />
              <div className="row"><Copy text={pairing.url} label="Copy link" /><button className="btn sm" onClick={() => setPairing(null)}>Hide</button></div>
            </div>
          )}
        </div>
      )}
      {status.locks.pairing && <div className="banner tone-crit small">Pairing is locked until {new Date(status.locks.pairing).toLocaleTimeString()} after repeated failed attempts. Creating a new link here clears the lock.</div>}
      <div className="col" style={{ gap: 6 }}>
        <div className="row"><b className="small">Paired phones</b><span className="spacer" />{status.sessions.some((s) => !s.revokedAt) && <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => { await post('/api/remote/revoke-all'); await load(); })}>Revoke all</button>}</div>
        {status.sessions.length === 0 && <span className="small muted">No phone has paired.</span>}
        {status.sessions.map((s) => (
          <div key={s.id} className="row wrap small session-row">
            <b>{s.label}</b><span className="faint">paired {ago(s.createdAt, now)} ago · last seen {ago(s.lastSeenAt, now)} ago · {s.scopes.join(', ')}</span><span className="spacer" />
            {s.revokedAt ? <Badge tone="idle">revoked: {s.revokedReason}</Badge> : <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => { await api(`/api/remote/sessions/${s.id}`, { method: 'DELETE' }); await load(); })}>Revoke</button>}
          </div>
        ))}
      </div>
      <p className="small faint" style={{ margin: 0 }}>{status.validation}</p>
      <ErrorLine error={error} />
    </div></section>
  );
}

function PlanReview({ review }: { review: Review }) {
  return (
    <div className="plan-review col" style={{ gap: 6 }} role="region" aria-label="Exact tunnel plan">
      <b className="small">Dry run: nothing has been executed</b>
      {review.blockedBy.map((b) => <div key={b} className="banner tone-warn small">{b}</div>)}
      <div className="kv small">
        <span>Plan digest</span><span className="mono">{review.plan.digest.slice(0, 16)}</span>
        <span>Exposes</span><span>{review.plan.exposes}</span>
        <span>Public internet</span><span>Never. Public listeners are refused.</span>
        <span>Commands</span><span>{review.plan.start.length ? review.plan.start.map((c, i) => <code key={i} className="block">{c.command} {c.args.join(' ')}</code>) : 'none (test double)'}</span>
        <span>Teardown</span><span>{review.plan.teardown.length ? review.plan.teardown.map((c, i) => <code key={i} className="block">{c.command} {c.args.join(' ')}</code>) : 'none'}</span>
      </div>
      <ul className="small">{review.plan.warnings.map((w) => <li key={w}>{w}</li>)}{review.controls.map((w) => <li key={w}>{w}</li>)}</ul>
    </div>
  );
}

function NotificationSettings() {
  const [st, setSt] = useState<NotifStatus | null>(null);
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [perm, setPerm] = useState<NotificationPermissionState>(notificationPermission());
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api<{ notifications: NotificationRecord[]; status?: NotifStatus }>('/api/notifications').then((r) => { setItems(r.notifications); if (r.status) setSt(r.status); }).catch(() => undefined), []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15_000); return () => clearInterval(timer); }, [load]);
  if (!st) return null;
  const c = st.config;
  const save = (p: Record<string, unknown>) => run(async () => { await post('/api/notifications/config', p); await load(); });
  const ep = (ch: 'webpush' | 'chat', label: string) => {
    const v = st.channels[ch];
    return (
      <div className="col endpoint-box" style={{ gap: 6 }}>
        <div className="row"><b className="small">{label}</b><Badge tone="idle">{v.endpoint ? 'each message needs approval' : 'no endpoint'}</Badge><span className="spacer" /><Toggle on={v.enabled} onChange={(on) => void save({ channels: { [ch]: { enabled: on } } })} label={`Propose deliveries to ${label}`} /></div>
        <input aria-label={`${label} endpoint`} placeholder="https://…" defaultValue={c.channels[ch].endpoint ?? ''} onBlur={(e) => { if (e.target.value !== (c.channels[ch].endpoint ?? '')) void save({ channels: { [ch]: { endpoint: e.target.value || null } } }); }} />
        <div className="small muted">{v.note}</div>
        <div className="small muted">Setting or reviewing an endpoint sends nothing. Open Decisions to confirm each exact payload once. Settings changes, expiry, restart and quiet hours invalidate pending approvals.</div>
        {v.last && <span className="small faint">Last attempt: {v.last.ok ? 'endpoint accepted; receipt unverified' : 'failed'} · {v.last.detail}</span>}
      </div>
    );
  };
  return (
    <section className="card"><div className="card-b col" style={{ gap: 12 }}>
      <div className="row"><h2>Notifications</h2><span className="spacer" />{st.quietNow && <Badge tone="idle">quiet hours now</Badge>}</div>
      <p className="small muted" style={{ margin: 0 }}>Alerts always land in the inbox below. Everything else is off until you turn it on. Alerts carry no transcripts, prompts or secrets, and there is no email.</p>
      <div className="col" style={{ gap: 6 }}>
        <div className="row wrap"><b className="small">macOS banner</b><Badge tone="idle">permission unknown</Badge><span className="spacer" /><Toggle on={c.channels.native.enabled} onChange={(on) => void save({ channels: { native: { enabled: on } } })} label="macOS banner" /></div>
        <div className="small muted">{st.channels.native.note}{st.channels.native.last ? ` Last attempt: ${st.channels.native.last.detail}` : ''}</div>
        <div className="row wrap"><b className="small">Browser notifications</b><Badge tone={perm === 'granted' ? 'ok' : perm === 'denied' ? 'crit' : 'idle'}>{perm === 'default' ? 'permission not asked' : perm === 'unsupported' ? 'not supported here' : perm}</Badge><span className="spacer" /><Toggle on={c.channels.browser.enabled} onChange={(on) => void save({ channels: { browser: { enabled: on } } })} label="Browser notifications" /></div>
        <div className="small muted">{perm === 'denied' ? 'This browser blocked notifications. Change it in the browser’s site settings.' : st.channels.browser.note} Shown only while a dashboard tab or installed app is open, with the alert title only.</div>
        {perm === 'default' && <button className="btn sm" onClick={() => void requestNotificationPermission().then(setPerm)}>Ask this browser for permission</button>}
      </div>
      {ep('webpush', 'JSON push gateway')}
      {ep('chat', 'Chat webhook')}
      {(st.pendingDeliveries?.length ?? 0) > 0 && <div className="banner small" role="status">{st.pendingDeliveries!.length} individual message Decisions waiting. <Link to="/decisions">Review exact messages</Link>. Nothing sends before your second confirmation.</div>}
      {items.filter(n => n.held.some(h => h.channel === 'webpush' || h.channel === 'chat')).slice(0, 5).map(n => <div key={n.id} className="col small" style={{ gap: 6 }}>
        <b>{n.title}</b>
        <div className="row wrap">{(['webpush', 'chat'] as const).filter(ch => n.held.some(h => h.channel === ch)).map(ch => {
          const pending = st.pendingDeliveries?.find(p => p.notificationId === n.id && p.channel === ch);
          return pending ? <Link key={ch} className="btn sm" to="/decisions">Review pending {ch === 'chat' ? 'chat' : 'gateway'} message</Link> : <button key={ch} className="btn sm" disabled={busy || st.quietNow || !c.channels[ch].enabled || !c.channels[ch].endpoint || !c.kinds[n.kind]} onClick={() => void run(async () => { await post(`/api/notifications/${n.id}/deliveries/${ch}/request`); setMsg('Fresh single-message Decision created. Review its payload and confirm in Decisions.'); await load(); })}>Request fresh {ch === 'chat' ? 'chat' : 'gateway'} message Decision</button>;
        })}</div>
      </div>)}
      <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
        <legend className="small"><b>Alert types</b></legend>
        {NOTIFICATION_KINDS.map((k) => <label key={k} className="row small"><input type="checkbox" checked={c.kinds[k]} onChange={(e) => void save({ kinds: { [k]: e.target.checked } })} /> {NOTIFICATION_KIND_LABEL[k]}</label>)}
        <label className="small">Approval counts as aged after (minutes)<input type="number" min={5} max={1440} defaultValue={c.agedApprovalMinutes} onBlur={(e) => void save({ agedApprovalMinutes: Number(e.target.value) })} /></label>
        <label className="small">Repeat the same alert after (minutes)<input type="number" min={5} max={1440} defaultValue={c.cooldownMinutes} onBlur={(e) => void save({ cooldownMinutes: Number(e.target.value) })} /></label>
      </fieldset>
      <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
        <legend className="small"><b>Quiet hours</b></legend>
        <label className="row small"><input type="checkbox" checked={c.quietHours.enabled} onChange={(e) => void save({ quietHours: { enabled: e.target.checked } })} /> Hold banners, browser, push and chat alerts (the inbox still records them)</label>
        <div className="row wrap"><label className="small">From<input type="time" defaultValue={c.quietHours.start} onBlur={(e) => void save({ quietHours: { start: e.target.value } })} /></label><label className="small">To<input type="time" defaultValue={c.quietHours.end} onBlur={(e) => void save({ quietHours: { end: e.target.value } })} /></label></div>
      </fieldset>
      <div className="row wrap"><button className="btn" disabled={busy} onClick={() => void run(async () => { await post('/api/notifications/test'); setMsg('Test alert recorded. Local channels follow their toggles. Outbound messages are pending Decisions; approve each exact message there.'); await load(); })}>Record a test alert</button></div>
      {msg && <div className="banner small" role="status">{msg}</div>}
      <ErrorLine error={error} />
    </div></section>
  );
}
