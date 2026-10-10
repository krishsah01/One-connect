// SPDX-License-Identifier: Apache-2.0
// Authenticated remote (phone) access. Disabled by default. Nothing listens beyond loopback until
// the owner enables it, reviews the exact plan and answers a recorded Decision for that launch.
// A phone pairs once with an expiring single-use token, receives a scoped, HttpOnly session
// cookie bound to this one project, and can only call the routes its granted scopes allow.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Actor, RemoteConfig, RemoteScope } from '@acc/core';
import { defaultRemoteConfig, HUMAN, newId, REMOTE_SCOPE_INFO, REMOTE_SCOPES, RemoteConfigSchema, SYSTEM } from '@acc/core';
import type { Decision } from '@acc/core';
import { CommandError, type Daemon } from '../daemon.ts';
import { projectNamespace } from '../context/vault.ts';
import { assertPrivatePlan, FixtureAdapter, TailscaleAdapter, type TunnelAdapter, type TunnelPlan, type TunnelState } from './tunnel.ts';
import { phoneEvents, phoneMessages, phoneState } from './projection.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DECISION_TTL_MS = 10 * 60_000;
const PAIR_FAILS = { max: 5, windowMs: 10 * 60_000, lockMs: 15 * 60_000 };
const COOKIE_FAILS = { max: 40, windowMs: 5 * 60_000, lockMs: 5 * 60_000 };

export interface SessionRecord { id: string; hash: string; label: string; scopes: RemoteScope[]; project: string; pairingId: string; createdAt: string; expiresAt: string; lastSeenAt: string; revokedAt: string | null; revokedReason: string | null }
interface PairingRecord { id: string; scopes: RemoteScope[]; createdAt: string; expiresAt: string; consumedAt: string | null }
interface PendingLaunch { digest: string; expires: number; consumed: boolean; adapter: string; scopeHash: string; boot: string }

export interface TunnelView { state: TunnelState; adapter: string; hostname: string | null; detail: string; since: string | null; decisionId: string | null }
export type RemotePrincipal = { session: SessionRecord; scopes: RemoteScope[]; csrf: string };
export type RemoteAuth = { ok: true; principal: RemotePrincipal } | { ok: false; status: number; error: string };

export class RemoteAccess {
  readonly d: Daemon;
  private config: RemoteConfig;
  private readonly boot = randomBytes(24).toString('hex');
  private adapters = new Map<string, TunnelAdapter>();
  private allowTestAdapters = false;
  private sessions: Record<string, SessionRecord> = {};
  private pairings: Record<string, PairingRecord> = {};
  private tunnel: TunnelView = { state: 'down', adapter: 'tailscale', hostname: null, detail: 'Remote access is off.', since: null, decisionId: null };
  private activePlan: TunnelPlan | null = null;
  private pairFails: number[] = [];
  private cookieFails: number[] = [];
  private lockedUntil = { pair: 0, cookie: 0 };
  private denials = new Map<string, number>();
  private lastSeenWrite = new Map<string, number>();
  private lastRemoteRequestAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private probeFailures = 0;
  private launchGeneration = 0;
  private launchInFlight = false;
  private stopsInFlight = 0;
  readonly project: string;

  constructor(d: Daemon) {
    this.d = d;
    this.project = projectNamespace(d.config.project.repo);
    this.adapters.set('tailscale', new TailscaleAdapter());
    this.config = this.load<RemoteConfig>('remote:config', RemoteConfigSchema.parse.bind(RemoteConfigSchema)) ?? defaultRemoteConfig();
    this.sessions = this.load<Record<string, SessionRecord>>('remote:sessions', x => x as Record<string, SessionRecord>) ?? {};
    this.pairings = this.load<Record<string, PairingRecord>>('remote:pairings', x => x as Record<string, PairingRecord>) ?? {};
    const lock = this.load<{ pair: number; cookie: number }>('remote:lock', x => x as { pair: number; cookie: number });
    if (lock) this.lockedUntil = lock;
    // A tunnel never survives a daemon restart by design: relaunching needs a new Decision.
    const prev = this.load<{ state: TunnelState; plan: TunnelPlan | null }>('remote:tunnel', x => x as { state: TunnelState; plan: TunnelPlan | null });
    this.leftover = prev && prev.state !== 'down' ? prev.plan : null;
  }
  private leftover: TunnelPlan | null = null;

  private load<T>(key: string, parse: (x: unknown) => T): T | null {
    try { const raw = this.d.store.kvGet(key); return raw ? parse(JSON.parse(raw)) : null; } catch { return null; }
  }
  private save(key: string, v: unknown) { this.d.store.kvSet(key, JSON.stringify(v)); }
  private now() { return this.d.now().getTime(); }
  private iso(ms = this.now()) { return new Date(ms).toISOString(); }

  /** Replace or add an adapter. Registering a test-only adapter is how tests opt in to fixtures. */
  useAdapter(a: TunnelAdapter): void {
    this.adapters.set(a.id, a);
    if (a.testOnly) this.allowTestAdapters = true;
  }
  private adapter(): TunnelAdapter {
    const a = this.adapters.get(this.config.adapter);
    if (!a) throw new CommandError('No tunnel adapter is registered for this selection.', 409);
    if (a.testOnly && !this.allowTestAdapters) throw new CommandError('The loopback fixture is a test double and cannot provide real access.', 403);
    return a;
  }

  start(): void {
    if (this.leftover) {
      const plan = this.leftover;
      this.leftover = null;
      // Remove only what this app added in an earlier process; failure is recorded, never hidden.
      void this.adapters.get(plan.adapter)?.stop(plan).then(() => this.setTunnel('down', 'Daemon restarted: the previous tunnel entry was removed. Launch again to reconnect (needs a new Decision).', { hostname: null })).catch(() => this.setTunnel('down', 'Daemon restarted. The previous tunnel entry could not be confirmed removed; check your tunnel provider.', { hostname: null }));
    }
    this.timer ??= setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
  }
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.activePlan && this.tunnel.state !== 'down') await this.stop('daemon shutdown', SYSTEM).catch(() => undefined);
  }

  // ---- configuration -------------------------------------------------------------------------

  getConfig(): RemoteConfig { return structuredClone(this.config); }
  projectState(scopes: readonly RemoteScope[]) { return phoneState(this.d, scopes); }
  projectEvents(events: Parameters<typeof phoneEvents>[1], scopes: readonly RemoteScope[]) { return phoneEvents(this.d, events, scopes); }
  projectMessages(message: unknown, scopes: readonly RemoteScope[]) { return phoneMessages(this.d, message, scopes); }

  scopeReview() {
    return REMOTE_SCOPES.map(s => ({ scope: s, ...REMOTE_SCOPE_INFO[s], granted: this.config.scopes.includes(s) }));
  }
  private scopeHash(c = this.config) { return sha(JSON.stringify({ ...c, scopes: [...c.scopes].sort() })); }

  async configure(patch: unknown, actor: Actor = HUMAN): Promise<RemoteConfig> {
    if (actor.type !== 'human') throw new CommandError('Only the owner can change remote access', 403);
    const parsed = RemoteConfigSchema.safeParse({ ...this.config, ...(patch as object) });
    if (!parsed.success) throw new CommandError(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const next = parsed.data;
    if (next.adapter === 'fixture' && !this.allowTestAdapters) throw new CommandError('The loopback fixture is a test double and cannot provide real access.', 403);
    const before = this.config;
    const turnedOff = before.enabled && !next.enabled;
    const changedPlan = before.adapter !== next.adapter || before.httpsPort !== next.httpsPort;
    this.config = next;
    // Reductions are permanent for this pairing. Re-adding a config scope requires a new pairing.
    // Close stale sockets before publishing the config event/snapshot.
    for (const session of Object.values(this.sessions)) if (!session.revokedAt) {
      const scopes = session.scopes.filter(scope => next.scopes.includes(scope));
      if (scopes.length !== session.scopes.length) {
        session.scopes = scopes;
        this.d.bus.emit('remote.revoked', session.id);
      }
    }
    this.d.commit([{ type: 'remote.config_changed', actor, data: { config: next, scopeHash: this.scopeHash(next) } }], [], () => { this.save('remote:config', next); this.save('remote:sessions', this.sessions); });
    this.expireSessions();
    if (turnedOff || (changedPlan && this.tunnel.state !== 'down')) {
      await this.stop(turnedOff ? 'remote access disabled' : 'tunnel settings changed', actor).catch(() => undefined);
      if (turnedOff) this.revokeAll('remote access disabled', actor);
    }
    if (!next.enabled) this.pairings = {}, this.save('remote:pairings', this.pairings);
    // Narrowed scope/limits apply to live sessions immediately (effective scopes are an intersection).
    return this.config;
  }

  // ---- dry run, launch Decision ---------------------------------------------------------------

  localPort(): number {
    const u = this.d.url;
    return u ? Number(new URL(u).port) : this.d.config.server.port;
  }

  review() {
    const a = this.adapter();
    const plan = a.plan({ port: this.localPort(), httpsPort: this.config.httpsPort });
    const blockers: string[] = [];
    if (!this.config.enabled) blockers.push('Remote access is disabled. Enable it first; nothing starts without a Decision.');
    const det = a.detect();
    if (!det.installed) blockers.push(det.note);
    return {
      dryRun: true as const,
      executed: false as const,
      plan,
      adapter: { id: a.id, title: a.title, ...det, secureTransport: a.secureTransport, testOnly: a.testOnly },
      scopes: this.scopeReview(),
      limits: { pairingTtlSeconds: this.config.pairingTtlSeconds, sessionTtlHours: this.config.sessionTtlHours, idleTimeoutMinutes: this.config.idleTimeoutMinutes, maxSessions: this.config.maxSessions },
      controls: [
        'Every phone request needs a paired session cookie; the Mac’s sign-in cookie and install token are never accepted over the tunnel.',
        'Pairing links are single-use, expire quickly and carry their token in the URL fragment, which is removed from the address bar immediately.',
        'State-changing requests also need a CSRF header and a matching Origin.',
        `Pairing is locked for ${PAIR_FAILS.lockMs / 60000} minutes after ${PAIR_FAILS.max} failures.`,
        'You can revoke any phone, or all of them, from this page; disabling remote access revokes everything.',
      ],
      blockedBy: blockers,
      digest: plan.digest,
    };
  }

  /** Creates (or returns) the per-launch Decision. Nothing runs until a human approves it. */
  requestLaunch(actor: Actor = HUMAN): { decision: Decision; plan: TunnelPlan } {
    if (this.launchInFlight || this.stopsInFlight || (this.activePlan && this.tunnel.state === 'error')) throw new CommandError('The previous tunnel attempt or teardown is not settled. Stop it on the Mac before requesting another launch.', 409);
    if (actor.type !== 'human') throw new CommandError('Only the owner can request a tunnel launch', 403);
    if (!this.config.enabled) throw new CommandError('Enable remote access before requesting a launch.', 409);
    if (this.tunnel.state === 'up' || this.tunnel.state === 'starting') throw new CommandError('The tunnel is already running. Stop it first.', 409);
    const a = this.adapter();
    if (!a.detect().installed) throw new CommandError(a.detect().note, 412);
    const plan = a.plan({ port: this.localPort(), httpsPort: this.config.httpsPort });
    assertPrivatePlan(plan);
    for (const dec of Object.values(this.d.state.decisions)) {
      if (dec.kind !== 'remote' || dec.answeredAt || dec.consumedAt) continue;
      const rec = this.load<PendingLaunch>(`remote:decision:${dec.id}`, x => x as PendingLaunch);
      if (rec && !rec.consumed && rec.digest === plan.digest && rec.scopeHash === this.scopeHash() && rec.boot === this.boot && rec.expires > this.now()) return { decision: dec, plan };
      this.retire(dec.id, rec && (rec.digest !== plan.digest || rec.scopeHash !== this.scopeHash() || rec.boot !== this.boot) ? 'superseded' : 'expired');
    }
    const cmds = plan.start.length ? plan.start.map(c => `${c.command} ${c.args.join(' ')}`).join('; ') : '(none: test double)';
    const decision = this.d.decisions.createBound({
      question: `Start ${plan.title} so a paired phone can reach this project's dashboard? Exact plan ${plan.digest.slice(0, 12)}.`,
      options: ['approve', 'deny'], kind: 'remote', risk: 'high', urgency: 'normal', confirmOptions: ['approve'],
      evidence: [
        { label: 'Commands', detail: cmds },
        { label: 'Exposes', detail: plan.exposes },
        { label: 'Public internet', detail: 'Never. Public listeners are refused.', ok: true },
        { label: 'Touches your tailnet', detail: plan.touchesTailnet ? 'Changes this Mac’s Serve configuration only; no ACL, key or device changes.' : 'No.' },
        { label: 'Phone scopes', detail: this.config.scopes.map(s => REMOTE_SCOPE_INFO[s].title).join('; ') },
        { label: 'Limits', detail: `${this.config.maxSessions} phones max, sessions last ${this.config.sessionTtlHours} h or ${this.config.idleTimeoutMinutes} idle min` },
        { label: 'Reachability', detail: 'Not verified until a paired phone connects.' },
        { label: 'Teardown', detail: plan.teardown.length ? plan.teardown.map(c => `${c.command} ${c.args.join(' ')}`).join('; ') : 'none' },
      ],
    }, HUMAN, id => [{ type: 'remote.tunnel_requested', actor: HUMAN, data: { decisionId: id, adapter: plan.adapter, planDigest: plan.digest, hostname: plan.hostname } }], id => this.save(`remote:decision:${id}`, { digest: plan.digest, scopeHash: this.scopeHash(), boot: this.boot, expires: this.now() + DECISION_TTL_MS, consumed: false, adapter: plan.adapter } satisfies PendingLaunch));
    return { decision, plan };
  }

  private retire(decisionId: string, why: 'expired' | 'superseded') {
    const raw = this.load<PendingLaunch>(`remote:decision:${decisionId}`, x => x as PendingLaunch);
    const dec = this.d.state.decisions[decisionId];
    this.d.commit(dec && !dec.answeredAt ? [{ type: 'decision.answered' as const, actor: SYSTEM, data: { decisionId, answer: why, channel: 'system' } }] : [], [], raw ? () => this.save(`remote:decision:${decisionId}`, { ...raw, consumed: true }) : undefined);
  }

  isRemoteDecision(id: string): boolean { return Boolean(this.d.store.kvGet(`remote:decision:${id}`)); }

  /** Human-only, single-use, expiring, and void if the plan changed after the request. */
  async resolve(decisionId: string, answer: string, actor: Actor = HUMAN, o: { nonce?: string | null; channel?: string } = {}) {
    if (actor.type !== 'human') throw new CommandError('Only a human can approve a tunnel launch', 403);
    if (answer !== 'approve' && answer !== 'deny') throw new CommandError('Choose approve or deny');
    const rec = this.load<PendingLaunch>(`remote:decision:${decisionId}`, x => x as PendingLaunch);
    const dec = this.d.state.decisions[decisionId];
    if (!rec || !dec || dec.answeredAt || rec.consumed) throw new CommandError('Approval missing or already used', 409);
    if (rec.expires <= this.now()) { this.retire(decisionId, 'expired'); throw new CommandError('Approval expired. Request the launch again.', 409); }
    const a = this.adapter();
    const plan = a.plan({ port: this.localPort(), httpsPort: this.config.httpsPort });
    if (!this.config.enabled || plan.digest !== rec.digest || rec.scopeHash !== this.scopeHash() || rec.boot !== this.boot) { this.retire(decisionId, 'superseded'); throw new CommandError('Remote settings or the daemon changed after this request. Request a new launch for the current plan.', 409); }
    const consume = () => this.save(`remote:decision:${decisionId}`, { ...rec, consumed: true });
    if (answer === 'deny') {
      this.d.decisions.answerAtomic(decisionId, answer, { channel: 'dashboard', ...o }, actor, [], consume);
      return { launched: false, status: this.status() };
    }
    this.d.decisions.answerAtomic(decisionId, answer, { channel: 'dashboard', ...o }, actor, [], consume);
    await this.launch(plan, decisionId);
    return { launched: this.tunnel.state === 'up', status: this.status() };
  }

  private async launch(plan: TunnelPlan, decisionId: string): Promise<void> {
    const a = this.adapter(), generation = ++this.launchGeneration;
    this.launchInFlight = true;
    this.activePlan = plan;
    this.setTunnel('starting', 'Starting the private tunnel…', { decisionId, hostname: null });
    try {
      const { hostname } = await a.start(plan);
      if (generation !== this.launchGeneration || !this.config.enabled) {
        await a.stop(plan);
        this.d.decisions.consume(decisionId, 'tunnel launch cancelled');
        return;
      }
      if (!/^[a-z0-9.-]+(?::\d{2,5})?$/i.test(hostname)) throw new Error('The adapter reported an invalid host name.');
      this.probeFailures = 0;
      this.setTunnel('up', 'The tunnel process reports it is up. Reachability from a phone is not yet verified.', { decisionId, hostname: hostname.toLowerCase() });
      this.d.decisions.consume(decisionId, 'tunnel started');
    } catch (e) {
      if (generation !== this.launchGeneration) { this.activePlan = plan; this.setTunnel('error', 'Cancelled launch teardown could not be confirmed. Stop it on the Mac.', { hostname: null }); this.d.decisions.consume(decisionId, 'tunnel launch cancelled; teardown could not be confirmed'); return; }
      this.setTunnel('error', `Could not start: ${this.d.redactText((e as Error).message).slice(0, 200)}`, { decisionId, hostname: null });
      this.d.decisions.consume(decisionId, 'tunnel failed to start');
    } finally { this.launchInFlight = false; }
  }

  async stop(reason = 'stopped by owner', actor: Actor = HUMAN): Promise<void> {
    const plan = this.activePlan;
    this.launchGeneration++;
    this.stopsInFlight++;
    this.pairings = {};
    this.save('remote:pairings', this.pairings);
    // Invalidate ingress and sockets immediately, before awaiting provider teardown.
    if (this.tunnel.state !== 'down') this.setTunnel('down', `Tunnel stopping: ${reason}.`, { hostname: null });
    try {
      if (plan) await this.adapters.get(plan.adapter)?.stop(plan);
      this.activePlan = null;
      this.setTunnel('down', `Tunnel stopped: ${reason}.`, { hostname: null });
    } catch (e) {
      // Retain the plan so an owner can retry the exact teardown, never pretend it succeeded.
      this.setTunnel('error', `Stop could not be confirmed: ${this.d.redactText((e as Error).message).slice(0, 160)}`, { hostname: null });
    } finally { this.stopsInFlight--; }
    void actor;
  }

  private setTunnel(state: TunnelState, detail: string, o: { hostname?: string | null; decisionId?: string | null } = {}) {
    const prevState = this.tunnel.state;
    if (!['up', 'reconnecting'].includes(state)) {
      for (const session of Object.values(this.sessions)) if (!session.revokedAt) this.d.bus.emit('remote.revoked', session.id);
      this.lastRemoteRequestAt = null;
    }
    this.tunnel = { state, adapter: this.config.adapter, hostname: o.hostname === undefined ? this.tunnel.hostname : o.hostname, detail, since: prevState === state ? this.tunnel.since : this.iso(), decisionId: o.decisionId === undefined ? this.tunnel.decisionId : o.decisionId };
    this.save('remote:tunnel', { state, plan: this.activePlan });
    if (!this.d.closed) this.d.commit([{ type: 'remote.tunnel_state', actor: SYSTEM, data: { state, adapter: this.tunnel.adapter, hostname: this.tunnel.hostname, detail, decisionId: this.tunnel.decisionId } }]);
  }

  /** Periodic honest health check of the tunnel provider, never of internet reachability. */
  async tick(): Promise<void> {
    this.expireSessions();
    const generation = this.launchGeneration;
    const plan = this.activePlan;
    if (!plan || !(this.tunnel.state === 'up' || this.tunnel.state === 'reconnecting')) return;
    const p = await this.adapters.get(plan.adapter)?.probe(plan).catch(() => null);
    if (generation !== this.launchGeneration || plan !== this.activePlan) return;
    if (p?.state === 'running') {
      if (p && this.tunnel.state === 'reconnecting') { this.probeFailures = 0; this.setTunnel('up', 'The tunnel provider reports it is running again.'); }
      return;
    }
    this.probeFailures++;
    if (this.probeFailures >= 3) this.setTunnel('down', `The tunnel provider stopped reporting it as running: ${p?.detail ?? 'probe failed'}`);
    else this.setTunnel('reconnecting', `Waiting for the tunnel provider: ${p?.detail ?? 'probe failed'}`);
  }

  // ---- hosts and requests ----------------------------------------------------------------------

  /** Host names the daemon accepts as remote. Present only while the tunnel is reported up or reconnecting. */
  hosts(): string[] {
    return (this.tunnel.state === 'up' || this.tunnel.state === 'reconnecting') && this.tunnel.hostname ? [this.tunnel.hostname] : [];
  }
  isRemoteHost(host: string): boolean { return this.hosts().includes(host.toLowerCase()); }
  origin(): string | null {
    const h = this.hosts()[0];
    if (!h) return null;
    const a = this.adapters.get(this.activePlan?.adapter ?? this.config.adapter);
    return `${a?.secureTransport ? 'https' : 'http'}://${h}`;
  }
  cookieName(): string {
    const a = this.adapters.get(this.activePlan?.adapter ?? this.config.adapter);
    return `${a?.secureTransport ? '__Host-' : ''}acc_remote_${this.project.slice(0, 8)}`;
  }
  private secure(): boolean { return Boolean(this.adapters.get(this.activePlan?.adapter ?? this.config.adapter)?.secureTransport); }

  csrfFor(token: string): string { return createHmac('sha256', token).update('acc-csrf-v1').digest('base64url'); }

  private bucket(kind: 'pair' | 'cookie') { return kind === 'pair' ? PAIR_FAILS : COOKIE_FAILS; }
  private fail(kind: 'pair' | 'cookie', reason: string): boolean {
    const b = this.bucket(kind), list = kind === 'pair' ? this.pairFails : this.cookieFails, now = this.now();
    list.push(now);
    while (list.length && now - list[0] > b.windowMs) list.shift();
    if (list.length >= b.max && this.lockedUntil[kind] <= now) {
      this.lockedUntil[kind] = now + b.lockMs;
      this.save('remote:lock', this.lockedUntil);
      list.length = 0;
      this.d.commit([{ type: 'remote.pair_failed', actor: SYSTEM, data: { reason: `${kind} attempts exceeded the limit; locked for ${b.lockMs / 60000} min`, locked: true } }]);
      return true;
    }
    if (kind === 'pair') this.d.commit([{ type: 'remote.pair_failed', actor: SYSTEM, data: { reason, locked: false } }]);
    return false;
  }
  locked(kind: 'pair' | 'cookie'): boolean { return this.lockedUntil[kind] > this.now(); }

  /** Validates a phone cookie. Failures are counted toward the brute-force bound. */
  authenticate(cookieValue: string | null): RemoteAuth {
    if (!cookieValue) return { ok: false, status: 401, error: 'Not paired. Open a fresh pairing link from the Mac.' };
    if (this.locked('cookie')) return { ok: false, status: 429, error: 'Too many invalid attempts. Try again later.' };
    const h = sha(cookieValue);
    const s = Object.values(this.sessions).find(x => { const a = Buffer.from(x.hash), b = Buffer.from(h); return a.length === b.length && timingSafeEqual(a, b); });
    const now = this.now();
    const bad = (error: string, status = 401): RemoteAuth => { this.fail('cookie', error); return { ok: false, status, error }; };
    if (!s) return bad('This phone session is not recognised. Pair again.');
    if (s.revokedAt) return bad('This phone session was revoked.');
    const expired = this.sessionExpiry(s);
    if (expired) { this.revoke(s.id, expired, SYSTEM); return bad(`This phone session expired (${expired}). Pair again.`); }
    if (s.project !== this.project) return bad('This session belongs to a different project.', 403);
    if (!this.config.enabled) return bad('Remote access is disabled.', 403);
    const scopes = s.scopes.filter(x => this.config.scopes.includes(x));
    if (now - (this.lastSeenWrite.get(s.id) ?? 0) > 15_000) {
      s.lastSeenAt = this.iso(now);
      this.lastSeenWrite.set(s.id, now);
      this.save('remote:sessions', this.sessions);
    }
    this.lastRemoteRequestAt = this.iso(now);
    return { ok: true, principal: { session: s, scopes, csrf: this.csrfFor(cookieValue) } };
  }

  /** Records a refused remote request (bounded so a probing client cannot flood the audit log). */
  denied(sessionId: string | null, method: string, path: string, reason: string): void {
    const bucket = `${sessionId ?? 'anon'}:${Math.floor(this.now() / 3_600_000)}`;
    const n = (this.denials.get(bucket) ?? 0) + 1;
    this.denials.set(bucket, n);
    if (this.denials.size > 200) this.denials.clear();
    if (n <= 20 && !this.d.closed) this.d.commit([{ type: 'remote.request_denied', actor: SYSTEM, data: { sessionId, method, path: path.split('?')[0].slice(0, 120), reason: reason.slice(0, 160) } }]);
  }

  // ---- pairing ---------------------------------------------------------------------------------

  issuePairing(actor: Actor = HUMAN): { pairingId: string; url: string; path: string; token: string; expiresAt: string; scopes: RemoteScope[] } {
    if (actor.type !== 'human') throw new CommandError('Only the owner can create a pairing link', 403);
    if (!this.config.enabled) throw new CommandError('Remote access is disabled.', 409);
    if (this.tunnel.state !== 'up') throw new CommandError(`The tunnel is ${this.tunnel.state}. Pairing needs a running tunnel; local daemon readiness does not make the phone reachable.`, 409);
    if (this.activeSessions().length >= this.config.maxSessions) throw new CommandError(`${this.config.maxSessions} phones are already paired. Revoke one first.`, 409);
    const now = this.now();
    for (const [k, p] of Object.entries(this.pairings)) if (Date.parse(p.expiresAt) < now - 3_600_000 || p.consumedAt) delete this.pairings[k];
    const token = randomBytes(32).toString('base64url');
    const rec: PairingRecord = { id: newId('pair'), scopes: [...this.config.scopes], createdAt: this.iso(now), expiresAt: this.iso(now + this.config.pairingTtlSeconds * 1000), consumedAt: null };
    this.pairings[sha(token)] = rec;
    // Issuing a link is an owner action on the Mac and clears a pairing lock.
    this.lockedUntil.pair = 0;
    this.pairFails = [];
    this.d.commit([{ type: 'remote.pairing_issued', actor, data: { pairingId: rec.id, expiresAt: rec.expiresAt, scopes: rec.scopes } }], [], () => { this.save('remote:pairings', this.pairings); this.save('remote:lock', this.lockedUntil); });
    const origin = this.origin()!;
    return { pairingId: rec.id, token, path: `/pair#t=${token}`, url: `${origin}/pair#t=${token}`, expiresAt: rec.expiresAt, scopes: rec.scopes };
  }

  /** Consumes a pairing token exactly once and creates the scoped session. */
  pair(token: string): { cookie: string; cookieName: string; csrf: string; session: Omit<SessionRecord, 'hash'>; secure: boolean } {
    if (!this.config.enabled) throw new CommandError('Remote access is disabled.', 403);
    if (this.locked('pair')) throw new CommandError('Pairing is locked after repeated failures. Create a new link on the Mac.', 429);
    const generic = () => { const locked = this.fail('pair', 'invalid, expired or reused pairing token'); throw new CommandError(locked ? 'Pairing is locked after repeated failures. Create a new link on the Mac.' : 'This pairing link is invalid, expired or already used.', locked ? 429 : 401); };
    if (typeof token !== 'string' || token.length < 40 || token.length > 128) return generic();
    const key = sha(token);
    const rec = this.pairings[key];
    if (!rec || rec.consumedAt || Date.parse(rec.expiresAt) <= this.now()) return generic();
    if (this.activeSessions().length >= this.config.maxSessions) throw new CommandError('The limit of paired phones was reached. Revoke one on the Mac.', 409);
    rec.consumedAt = this.iso();
    const cookie = randomBytes(32).toString('base64url');
    const now = this.now();
    const session: SessionRecord = { id: newId('phone'), hash: sha(cookie), label: `Phone ${Object.keys(this.sessions).length + 1}`, scopes: rec.scopes.filter(s => this.config.scopes.includes(s)), project: this.project, pairingId: rec.id, createdAt: this.iso(now), expiresAt: this.iso(now + this.config.sessionTtlHours * 3_600_000), lastSeenAt: this.iso(now), revokedAt: null, revokedReason: null };
    this.sessions[session.id] = session;
    this.d.commit([{ type: 'remote.paired', actor: SYSTEM, data: { sessionId: session.id, pairingId: rec.id, scopes: session.scopes, expiresAt: session.expiresAt, label: session.label } }], [], () => { this.save('remote:pairings', this.pairings); this.save('remote:sessions', this.sessions); });
    const { hash: _h, ...view } = session;
    return { cookie, cookieName: this.cookieName(), csrf: this.csrfFor(cookie), session: view, secure: this.secure() };
  }

  private sessionExpiry(s: SessionRecord): string | null {
    const now = this.now(), expires = Math.min(Date.parse(s.expiresAt), Date.parse(s.createdAt) + this.config.sessionTtlHours * 3_600_000), seen = Date.parse(s.lastSeenAt);
    if (!Number.isFinite(expires) || !Number.isFinite(seen)) return 'invalid session time';
    if (expires <= now) return 'absolute timeout';
    return now - seen >= this.config.idleTimeoutMinutes * 60_000 ? 'idle timeout' : null;
  }
  /** Parent WS send/message guard: no expiry grace or stale captured scope authority. */
  socketAuthorized(sessionId: string, scopes: readonly RemoteScope[]): boolean {
    const s = this.sessions[sessionId];
    if (!s || s.revokedAt || !this.config.enabled || !this.hosts().length || s.project !== this.project) return false;
    const expired = this.sessionExpiry(s);
    if (expired) { this.revoke(sessionId, expired, SYSTEM); return false; }
    return scopes.every(scope => s.scopes.includes(scope) && this.config.scopes.includes(scope));
  }
  private expireSessions(): void {
    for (const s of Object.values(this.sessions)) if (!s.revokedAt) {
      const reason = this.sessionExpiry(s);
      if (reason) this.revoke(s.id, reason, SYSTEM);
    }
  }
  activeSessions(): SessionRecord[] {
    this.expireSessions();
    return Object.values(this.sessions).filter(s => !s.revokedAt);
  }

  revoke(sessionId: string, reason: string, actor: Actor = HUMAN): boolean {
    const s = this.sessions[sessionId];
    if (!s || s.revokedAt) return false;
    s.revokedAt = this.iso();
    s.revokedReason = reason;
    this.d.bus.emit('remote.revoked', sessionId);
    this.d.commit([{ type: 'remote.session_revoked', actor, data: { sessionId, reason, by: actor.id } }], [], () => this.save('remote:sessions', this.sessions));
    return true;
  }
  revokeAll(reason: string, actor: Actor = HUMAN): number {
    let n = 0;
    for (const s of this.activeSessions()) if (this.revoke(s.id, reason, actor)) n++;
    return n;
  }

  // ---- view --------------------------------------------------------------------------------------

  status() {
    const a = this.adapters.get(this.config.adapter);
    const det = a?.detect() ?? { installed: false, path: null, note: 'No adapter.' };
    const t = this.tunnel;
    const phoneRecent = this.lastRemoteRequestAt && this.now() - Date.parse(this.lastRemoteRequestAt) < 5 * 60_000;
    const reachability = t.state === 'up' || t.state === 'reconnecting'
      ? (phoneRecent ? { state: 'phone_connected' as const, note: `A paired phone made an authenticated request at ${this.lastRemoteRequestAt}.` } : { state: 'unverified' as const, note: 'The tunnel provider reports it is up, but nothing has proven that a phone can reach the dashboard. Open the pairing link on the phone to find out.' })
      : { state: 'not_running' as const, note: t.state === 'error' ? 'The tunnel failed; nothing is reachable.' : 'No tunnel is running; the dashboard is reachable only on this Mac.' };
    const pending = Object.values(this.d.state.decisions).find(x => x.kind === 'remote' && !x.answeredAt && !x.consumedAt) ?? null;
    return {
      config: this.config,
      scopes: this.scopeReview(),
      adapter: { id: this.config.adapter, title: a?.title ?? this.config.adapter, ...det, secureTransport: a?.secureTransport ?? false, testOnly: a?.testOnly ?? false },
      tunnel: t,
      localDaemon: { ready: true, url: this.d.url, note: 'Local daemon readiness says nothing about whether the internet can reach it.' },
      reachability,
      sessions: Object.values(this.sessions).map(({ hash: _h, ...s }) => s).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 20),
      pendingPairings: Object.values(this.pairings).filter(p => !p.consumedAt && Date.parse(p.expiresAt) > this.now()).map(p => ({ id: p.id, expiresAt: p.expiresAt, scopes: p.scopes })),
      locks: { pairing: this.locked('pair') ? this.iso(this.lockedUntil.pair) : null, sessionProbe: this.locked('cookie') ? this.iso(this.lockedUntil.cookie) : null },
      pendingDecision: pending,
      validation: 'Real Tailscale and phone validation are pending. Loopback fixtures cover pairing, scope, CSRF, revocation and isolation only.',
    };
  }
}

export { FixtureAdapter };
