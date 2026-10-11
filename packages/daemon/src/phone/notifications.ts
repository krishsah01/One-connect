// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Durable local alerts. JSON gateway/chat deliveries each need a human Decision for the exact
// payload, URL and configuration. Endpoint reviews never authorize messages or add egress hosts.
import { randomBytes } from 'node:crypto';
import type { InfraHealthReport, Actor, Decision, EventEnvelope, NotificationCandidate, NotificationChannel, NotificationConfig, NotificationRecord } from '@acc/core';
import { candidatesFromEvents, candidatesFromTick, defaultNotificationConfig, HUMAN, infraFailuresRecovered, inQuietHours, isInfraFailureFingerprint, newId, NOTIFICATION_CHANNEL_LABEL, NotificationConfigSchema, SYSTEM, validTimezone } from '@acc/core';
import { CommandError } from '../errors.ts';
import { projectNamespace } from '../context/vault.ts';
import { run } from '../exec.ts';
import { MAX_LIST } from '../store/eventStore.ts';
import { sha256 } from '../util/hash.ts';
import type { Kernel } from '../kernel.ts';
import type { Decisions } from '../decisions.ts';
import type { Egress } from '../egress.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type NotificationsDeps = Kernel & { readonly decisions: Decisions };

const DECISION_TTL_MS = 10 * 60_000;
const MAX_SUPPRESSION_KEYS = 2000;
const SUPPRESSION_RETENTION_MS = 7 * 24 * 3_600_000;
type OutboundChannel = 'webpush' | 'chat';
export interface ExternalPayload { id: string; kind: string; severity: string; title: string; at: string; source: 'one-connect' }
export interface DeliveryResult { ok: boolean; detail: string }
export interface DeliveryContext { decisionId: string; endpoint: string; body: string }
export interface NotificationAdapter {
  readonly id: 'native' | OutboundChannel;
  deliver(payload: ExternalPayload, context?: DeliveryContext): Promise<DeliveryResult>;
}

export class NativeAdapter implements NotificationAdapter {
  readonly id = 'native' as const;
  private exec: typeof run;
  private platform: string;
  constructor(o: { exec?: typeof run; platform?: string } = {}) { this.exec = o.exec ?? run; this.platform = o.platform ?? process.platform; }
  async deliver(p: ExternalPayload): Promise<DeliveryResult> {
    if (this.platform !== 'darwin') return { ok: false, detail: 'Native notifications are only implemented for macOS.' };
    const r = await this.exec('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', 'One Connect', p.title], { timeoutMs: 8000 });
    return r.code === 0 ? { ok: true, detail: 'osascript ran. macOS does not report whether notifications are allowed, so confirm you saw the banner.' } : { ok: false, detail: `osascript failed (${r.error ?? r.code ?? 'no exit code'}).` };
  }
}

/** A JSON POST, not native encrypted Web Push. No endpoint is read again after approval. */
export class JsonEndpointAdapter implements NotificationAdapter {
  readonly id: OutboundChannel;
  private readonly deps: { readonly egress: Egress; readonly permits: Pick<Notifications, 'issueEgressPermit'> };
  constructor(deps: JsonEndpointAdapter['deps'], id: OutboundChannel) { this.deps = deps; this.id = id; }
  async deliver(p: ExternalPayload, context?: DeliveryContext): Promise<DeliveryResult> {
    if (!context || context.body !== JSON.stringify(p)) return { ok: false, detail: 'An exact single-message approval is required.' };
    try {
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: context.body, redirect: 'error' as const, signal: AbortSignal.timeout(8000) };
      const notificationPermit = this.deps.permits.issueEgressPermit(context.decisionId, this.id, context.endpoint, init);
      // Shared egress can redeem this exact one-use permit instead of granting an entire host.
      // Until that wiring is present, unconfigured hosts remain denied by the existing guard.
      const r = await this.deps.egress.fetch(context.endpoint, { ...init, notificationPermit } as RequestInit);
      await r.body?.cancel().catch(() => undefined);
      return r.ok ? { ok: true, detail: `Endpoint accepted the payload (HTTP ${r.status}); receipt by a person is unverified.` } : { ok: false, detail: `Endpoint rejected the payload (HTTP ${r.status}).` };
    } catch {
      // Fetch errors can include credential-bearing webhook paths. Do not put them in the audit.
      return { ok: false, detail: 'Delivery failed or egress refused it. No retry is scheduled; request a fresh message Decision.' };
    }
  }
}

interface PendingNotification {
  version: 2;
  type: 'delivery' | 'endpoint';
  channel: OutboundChannel;
  endpoint: string;
  urlHash: string;
  host: string;
  configHash: string;
  revision: number;
  boot: string;
  notificationId: string | null;
  payload: ExternalPayload | null;
  payloadHash: string;
  actionHash: string;
  expires: number;
  consumed: boolean;
  state: 'pending' | 'claimed' | 'reviewed' | 'delivered' | 'failed' | 'denied' | 'invalid';
  transportUsed: boolean;
}

function endpointHost(url: string): { host: string; loopback: boolean } {
  let u: URL;
  try { u = new URL(url); } catch { throw new CommandError('The endpoint must be a valid URL.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new CommandError('Endpoints must use https (plain http is allowed only for loopback fixtures).');
  if (u.username || u.password || u.hash) throw new CommandError('Remove credentials and fragments from the endpoint URL.');
  return { host: u.host, loopback };
}

export class Notifications {
  readonly d: NotificationsDeps;
  private config: NotificationConfig;
  private revision: number;
  private readonly boot = randomBytes(24).toString('hex');
  private seen: Record<string, number> = {};
  private acked: Record<string, string> = {};
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private adapters: Record<'native' | OutboundChannel, NotificationAdapter>;
  private permits = new Map<string, { decisionId: string; channel: OutboundChannel; endpoint: string; body: string }>();
  private last: Partial<Record<NotificationChannel, { at: string; ok: boolean; detail: string }>> = {};
  private onEvents = (events: EventEnvelope[]) => this.fromEvents(events);

  constructor(d: NotificationsDeps) {
    this.d = d;
    this.config = this.read('notify:config', x => NotificationConfigSchema.parse(x)) ?? defaultNotificationConfig();
    this.revision = this.read('notify:revision', x => typeof x === 'number' && Number.isSafeInteger(x) ? x : 0) ?? 0;
    this.seen = this.read<Record<string, number>>('notify:seen', x => x as Record<string, number>) ?? {};
    this.acked = this.read<Record<string, string>>('notify:acked', x => x as Record<string, string>) ?? {};
    // Before repository scoping, this project's private store used kind:dedupeKey.
    // Migrate those cooldowns once, so a restart cannot resend all existing alerts.
    const scope = this.projectScope();
    if (scope) for (const [key, at] of Object.entries(this.seen)) if (Object.keys(this.config.kinds).some(kind => key.startsWith(`${kind}:`))) {
      this.seen[`${scope}:${key}`] ??= at;
      delete this.seen[key];
    }
    this.pruneSuppression();
    this.d.store.kvSet('notify:seen', JSON.stringify(this.seen));
    this.d.store.kvSet('notify:acked', JSON.stringify(this.acked));
    this.adapters = { native: new NativeAdapter(), webpush: new JsonEndpointAdapter({ egress: d.egress, permits: this }, 'webpush'), chat: new JsonEndpointAdapter({ egress: d.egress, permits: this }, 'chat') };
  }
  private projectScope(): string {
    const repo = this.d.state.project?.repo ?? this.d.config.project.repo ?? '';
    return repo ? projectNamespace(repo) : '';
  }
  private legacyProjectScope(): string { return this.d.state.project?.name ?? this.d.config.project.name ?? ''; }
  private storageKey(c: Pick<NotificationCandidate, 'kind' | 'dedupeKey'>): string {
    const scope = this.projectScope();
    return scope ? `${scope}:${c.kind}:${c.dedupeKey}` : `${c.kind}:${c.dedupeKey}`;
  }
  private legacyStorageKey(c: Pick<NotificationCandidate, 'kind' | 'dedupeKey'>): string {
    const scope = this.legacyProjectScope();
    return scope ? `${scope}:${c.kind}:${c.dedupeKey}` : '';
  }
  /** Stable repo identity is the write key; legacy display-name keys are read-only for restart migration. */
  private lookupKeys(c: Pick<NotificationCandidate, 'kind' | 'dedupeKey'>): string[] {
    const keys = [this.storageKey(c)];
    const legacy = this.legacyStorageKey(c);
    if (legacy && !keys.includes(legacy)) keys.push(legacy);
    return keys;
  }
  private infraSuppressionKeys(dedupeKey: string): string[] {
    const spec = { kind: 'ci_infra_failure' as const, dedupeKey };
    const keys = [this.storageKey(spec)];
    const legacy = this.legacyStorageKey(spec);
    if (legacy) keys.push(legacy);
    return keys;
  }
  private pruneSuppression(keepKey?: string): void {
    const cutoff = this.d.now().getTime() - SUPPRESSION_RETENTION_MS;
    const recent = Object.entries(this.seen).filter(([k, t]) => k.length <= 1024 && Number.isFinite(t) && t >= cutoff)
      .sort((a, b) => a[0] === keepKey ? -1 : b[0] === keepKey ? 1 : b[1] - a[1]).slice(0, MAX_SUPPRESSION_KEYS);
    this.seen = Object.fromEntries(recent);
    this.acked = Object.fromEntries(Object.entries(this.acked).filter(([k, v]) => this.seen[k] !== undefined && typeof v === 'string' && isInfraFailureFingerprint(v)).slice(0, MAX_SUPPRESSION_KEYS));
  }
  private clearInfraSuppression(dedupeKey: string): void {
    let changed = false;
    for (const key of this.infraSuppressionKeys(dedupeKey)) {
      if (this.acked[key] !== undefined) { delete this.acked[key]; changed = true; }
      if (this.seen[key] !== undefined) { delete this.seen[key]; changed = true; }
    }
    if (changed) {
      this.d.store.kvSet('notify:acked', JSON.stringify(this.acked));
      this.d.store.kvSet('notify:seen', JSON.stringify(this.seen));
    }
  }
  private noteInfraRecovery(events: EventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== 'infra.checked') continue;
      const health = (e.data as { health?: InfraHealthReport })?.health;
      if (!health?.docker || !health.postgres || !health.vercel || !health.migrations) continue;
      const prefixes = this.infraSuppressionKeys('');
      const fingerprints = new Set<string>();
      for (const key of Object.keys(this.seen)) {
        const prefix = prefixes.find(p => key.startsWith(p));
        if (prefix) fingerprints.add(key.slice(prefix.length));
      }
      // A changed or unknown observation cannot erase an older unresolved failure.
      // Clear every recovered fingerprint, including failures whose state changed before recovery.
      for (const fingerprint of fingerprints) if (isInfraFailureFingerprint(fingerprint) && infraFailuresRecovered(health, fingerprint)) this.clearInfraSuppression(fingerprint);
    }
  }
  private read<T>(key: string, parse: (x: unknown) => T): T | null { try { const raw = this.d.store.kvGet(key); return raw ? parse(JSON.parse(raw)) : null; } catch { return null; } }
  private pending(id: string): PendingNotification | null {
    return this.read(`notify:decision:${id}`, x => {
      const p = x as PendingNotification;
      if (p.version !== 2 || !['delivery', 'endpoint'].includes(p.type) || !['webpush', 'chat'].includes(p.channel) || !Number.isFinite(p.expires)) throw new Error('Invalid or legacy binding');
      return p;
    });
  }
  private save(id: string, p: PendingNotification) { this.d.store.kvSet(`notify:decision:${id}`, JSON.stringify(p)); }
  private configHash() { return sha256(JSON.stringify(this.config)); }
  private actionHash(p: Omit<PendingNotification, 'actionHash' | 'consumed' | 'state' | 'transportUsed'>) {
    return sha256(JSON.stringify([p.version, p.type, p.channel, p.urlHash, p.configHash, p.revision, p.boot, p.notificationId, p.payloadHash, p.expires]));
  }
  useAdapter(a: NotificationAdapter): void { this.adapters[a.id] = a; }
  getConfig(): NotificationConfig { return structuredClone(this.config); }
  start(tickMs = 30_000): void {
    this.stopped = false;
    this.sweep(); // Pending records survive, but no approval can survive its process instance.
    this.d.bus.off('events', this.onEvents);
    this.d.bus.on('events', this.onEvents);
    this.timer ??= setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }
  stop(): void {
    this.stopped = true;
    this.permits.clear();
    this.d.bus.off('events', this.onEvents);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private fromEvents(events: EventEnvelope[]): void {
    if (this.d.closed || this.stopped) return;
    const relevant = events.filter(e => !e.type.startsWith('notification.') && !e.type.startsWith('remote.'));
    for (const e of relevant) {
      this.noteInfraRecovery([e]);
      for (const c of candidatesFromEvents(this.d.state, [e])) void this.consider(c);
    }
  }
  tick(): void {
    if (this.d.closed || this.stopped) return;
    this.sweep();
    // Do not generate notifications about notification approvals (and recursive outbound drafts).
    const decisions = Object.fromEntries(Object.entries(this.d.state.decisions).filter(([, d]) => d.kind !== 'notification'));
    for (const c of candidatesFromTick({ ...this.d.state, decisions }, this.d.now().getTime(), this.config.agedApprovalMinutes)) void this.consider(c);
  }
  async consider(c: NotificationCandidate): Promise<NotificationRecord | null> {
    if (this.d.closed || this.stopped || !this.config.kinds[c.kind]) return null;
    this.pruneSuppression();
    const now = this.d.now().getTime(), key = this.storageKey(c), lookup = this.lookupKeys(c);
    if (c.kind === 'ci_infra_failure' && isInfraFailureFingerprint(c.dedupeKey) && lookup.some((k) => this.acked[k] === c.dedupeKey)) return null;
    const prev = lookup.map((k) => this.seen[k]).find((t) => t !== undefined);
    if (prev !== undefined && now - prev < this.config.cooldownMinutes * 60_000) return null;
    this.seen[key] = now;
    this.pruneSuppression(key);
    return this.emit(c, c.dedupeKey);
  }
  private async emit(c: NotificationCandidate, dedupeKey: string): Promise<NotificationRecord> {
    if (this.d.closed || this.stopped) throw new CommandError('Notifications are stopped', 409);
    const at = this.d.nowIso(), quiet = inQuietHours(this.config.quietHours, this.d.now());
    const routed: NotificationChannel[] = ['local'], held: NotificationRecord['held'] = [];
    for (const ch of ['native', 'browser'] as const) if (this.config.channels[ch].enabled) {
      if (quiet) held.push({ channel: ch, reason: 'quiet hours' }); else routed.push(ch);
    }
    for (const ch of ['webpush', 'chat'] as const) if (this.config.channels[ch].enabled) held.push({ channel: ch, reason: quiet ? 'quiet hours' : this.config.channels[ch].endpoint ? 'per-message Decision required' : 'no endpoint set' });
    const rec: NotificationRecord = { id: newId('notif'), kind: c.kind, severity: c.severity, title: this.d.redactText(c.title).slice(0, 160), detail: this.d.redactText(c.detail).slice(0, 400), refs: c.refs, dedupeKey, at, routed, held, ackedAt: null };
    const payload: ExternalPayload = { id: rec.id, kind: c.kind, severity: c.severity, title: this.d.redactText(c.external).slice(0, 120), at, source: 'one-connect' };
    this.d.commit([{ type: 'notification.emitted', actor: SYSTEM, workItemId: c.refs.workItemId ?? null, agentId: c.refs.agentId ?? null, runId: c.refs.runId ?? null, data: { notification: rec } }], [], () => {
      this.d.store.kvSet('notify:seen', JSON.stringify(this.seen));
      this.d.store.kvSet('notify:acked', JSON.stringify(this.acked));
      this.d.store.kvSet(`notify:payload:${rec.id}`, JSON.stringify(payload));
    });
    if (!quiet && this.config.kinds[c.kind]) for (const ch of ['webpush', 'chat'] as const) if (this.config.channels[ch].enabled && this.config.channels[ch].endpoint) this.requestDelivery(rec.id, ch, SYSTEM);
    if (routed.includes('native')) await this.deliver(rec.id, 'native', payload);
    return rec;
  }
  private async deliver(id: string, ch: 'native' | OutboundChannel, payload: ExternalPayload, context?: DeliveryContext): Promise<DeliveryResult> {
    let res: DeliveryResult;
    try { res = await this.adapters[ch].deliver(structuredClone(payload), context); } catch { res = { ok: false, detail: 'Delivery failed. No retry is scheduled.' }; }
    res = { ok: res.ok === true, detail: this.d.redactText(res.detail).slice(0, 300) };
    this.last[ch] = { at: this.d.nowIso(), ...res };
    if (!this.d.closed) this.d.commit([{ type: 'notification.delivered', actor: SYSTEM, data: { id, channel: ch, ...res } }]);
    return res;
  }
  async sendTest(): Promise<NotificationRecord> {
    return this.emit({ kind: 'finished_work', severity: 'info', dedupeKey: `test:${newId('t')}`, title: 'Test notification', detail: 'You asked One Connect to record a test notification. Outbound delivery needs a separate message Decision.', external: 'Test notification from One Connect', refs: {} }, `test:${newId('t')}`);
  }

  /** Endpoint review is local setup only. It never creates standing egress or send authority. */
  requestEndpointActivation(channel: OutboundChannel, actor: Actor = HUMAN): Decision { return this.request(channel, null, null, actor); }
  requestDelivery(notificationId: string, channel: OutboundChannel, actor: Actor = HUMAN): Decision {
    const payload = this.read<ExternalPayload>(`notify:payload:${notificationId}`, x => x as ExternalPayload);
    if (!payload || payload.id !== notificationId || !this.list(10_000).some(n => n.id === notificationId)) throw new CommandError('The exact notification payload is unavailable. Record a new alert.', 409);
    return this.request(channel, notificationId, payload, actor);
  }
  private request(channel: OutboundChannel, notificationId: string | null, payload: ExternalPayload | null, actor: Actor): Decision {
    if (actor.type !== 'human' && actor.type !== 'system') throw new CommandError('Only the owner or local alert rules may propose delivery', 403);
    const cfg = this.config.channels[channel], endpoint = cfg.endpoint;
    if (!endpoint || (payload && !cfg.enabled)) throw new CommandError('Enable the channel and set an endpoint first.', 409);
    if (payload && !this.config.kinds[payload.kind as NotificationCandidate['kind']]) throw new CommandError('This alert kind is disabled.', 409);
    if (payload && inQuietHours(this.config.quietHours, this.d.now())) throw new CommandError('Quiet hours hold outbound messages. Nothing is queued for automatic delivery.', 409);
    const { host } = endpointHost(endpoint);
    for (const dec of Object.values(this.d.state.decisions)) {
      const p = this.pending(dec.id);
      if (p && !dec.answeredAt && !dec.consumedAt && p.state === 'pending' && p.channel === channel && p.notificationId === notificationId && !this.problem(dec.id, p)) return dec;
    }
    const base = { version: 2 as const, type: payload ? 'delivery' as const : 'endpoint' as const, channel, endpoint, urlHash: sha256(endpoint), host, configHash: this.configHash(), revision: this.revision, boot: this.boot, notificationId, payload, payloadHash: sha256(JSON.stringify(payload)), expires: this.d.now().getTime() + DECISION_TTL_MS };
    const pending: PendingNotification = { ...base, actionHash: this.actionHash(base), consumed: false, state: 'pending', transportUsed: false };
    return this.d.decisions.createBound({
      question: payload ? `Send this one ${payload.kind} message to ${host} (${NOTIFICATION_CHANNEL_LABEL[channel]})?` : `Review ${host} as the configured ${NOTIFICATION_CHANNEL_LABEL[channel]} endpoint? This sends nothing; each message needs its own Decision.`,
      options: ['approve', 'deny'], kind: 'notification', risk: payload ? 'high' : 'medium', urgency: 'normal', confirmOptions: ['approve'], expiresAt: new Date(pending.expires).toISOString(),
      evidence: [
        { label: 'Endpoint host', detail: host },
        { label: 'Destination URL SHA-256', detail: pending.urlHash },
        { label: 'Payload', detail: payload ? JSON.stringify(payload) : 'None. Endpoint review sends nothing.' },
        ...(notificationId ? [{ label: 'Delivery ID', detail: notificationId }] : []),
        { label: 'Action SHA-256', detail: pending.actionHash },
        { label: 'Expires', detail: new Date(pending.expires).toISOString() },
        { label: 'Scope', detail: payload ? 'One attempt of this exact JSON POST only. Any settings change, quiet hours, expiry or restart invalidates it. No retry, redirect or later automatic send.' : 'Local endpoint review only. No host allowlist or standing message permission.' },
      ],
    }, actor, () => [], id => this.save(id, pending));
  }
  /** Existing Decisions.respond calls this dispatcher; legacy 24-hour requests are refused. */
  isEndpointDecision(id: string): boolean { return Boolean(this.d.store.kvGet(`notify:decision:${id}`)); }
  isDeliveryDecision(id: string): boolean { return this.pending(id)?.type === 'delivery'; }
  private problem(id: string, p: PendingNotification): string | null {
    if (this.d.closed || this.stopped) return 'notifications stopped';
    if (p.boot !== this.boot) return 'daemon restarted; request a fresh Decision';
    if (p.expires <= this.d.now().getTime()) return 'message approval expired';
    if (p.revision !== this.revision || p.configHash !== this.configHash() || this.config.channels[p.channel].endpoint !== p.endpoint) return 'notification settings changed';
    if (sha256(p.endpoint) !== p.urlHash || sha256(JSON.stringify(p.payload)) !== p.payloadHash || this.actionHash(p) !== p.actionHash || !this.d.state.decisions[id]?.evidence?.some(e => e.label === 'Action SHA-256' && e.detail === p.actionHash)) return 'exact payload or URL binding changed';
    if (p.type === 'delivery' && (!p.payload || p.payload.id !== p.notificationId || !this.config.channels[p.channel].enabled || !this.config.kinds[p.payload.kind as NotificationCandidate['kind']])) return 'channel or alert kind disabled';
    if (p.type === 'delivery' && inQuietHours(this.config.quietHours, this.d.now())) return 'quiet hours';
    return null;
  }
  private retire(id: string, reason: string): void {
    const p = this.pending(id), dec = this.d.state.decisions[id];
    if (!dec || dec.consumedAt) return;
    this.d.commit([{ type: 'decision.consumed', actor: SYSTEM, data: { decisionId: id, outcome: `notification approval invalid: ${reason}; no automatic retry` } }], [], () => {
      if (p) this.save(id, { ...p, consumed: true, state: 'invalid' });
      this.d.store.kvDelete(`decision-confirm:${id}`);
    });
  }
  private sweep(): void {
    for (const dec of Object.values(this.d.state.decisions)) if (dec.kind === 'notification' && !dec.consumedAt && this.isEndpointDecision(dec.id)) {
      const p = this.pending(dec.id);
      if (!p) this.retire(dec.id, 'legacy standing approval removed');
      else if (p.state === 'claimed' && p.boot !== this.boot) this.retire(dec.id, 'interrupted during delivery; receipt unknown');
      else if (p.state === 'pending') { const problem = this.problem(dec.id, p); if (problem) this.retire(dec.id, problem); }
    }
  }
  async resolveEndpoint(id: string, answer: string, actor: Actor = HUMAN, o: { nonce?: string | null; channel?: string } = {}) {
    const p = this.pending(id), dec = this.d.state.decisions[id];
    if (!p) { this.retire(id, 'missing or legacy binding'); throw new CommandError('Request a fresh per-message Decision; standing approvals are no longer valid.', 409); }
    if (!dec || dec.answeredAt || dec.consumedAt || p.consumed || p.state !== 'pending') throw new CommandError('Approval missing or already used', 409);
    if (answer !== 'approve' && answer !== 'deny') throw new CommandError('Choose approve or deny');
    if (answer === 'deny') {
      this.d.decisions.answerAtomic(id, answer, { channel: 'dashboard', ...o }, actor, [{ type: 'decision.consumed', actor, data: { decisionId: id, outcome: 'notification denied; nothing sent' } }], () => this.save(id, { ...p, consumed: true, state: 'denied' }));
      return this.status();
    }
    const problem = this.problem(id, p);
    if (problem) { this.retire(id, problem); throw new CommandError(`Cannot deliver: ${problem}. Request a fresh Decision.`, 409); }
    this.d.decisions.answerAtomic(id, answer, { channel: 'dashboard', ...o }, actor, p.type === 'endpoint' ? [{ type: 'decision.consumed', actor, data: { decisionId: id, outcome: 'endpoint reviewed locally; no message or egress authority granted' } }] : [], () => this.save(id, { ...p, consumed: true, state: p.type === 'delivery' ? 'claimed' : 'reviewed' }));
    if (p.type === 'delivery') await this.finishDelivery(id, p);
    return this.status();
  }
  private async finishDelivery(id: string, p: PendingNotification): Promise<void> {
    const context: DeliveryContext = { decisionId: id, endpoint: p.endpoint, body: JSON.stringify(p.payload) };
    let result: DeliveryResult;
    const problem = this.problem(id, p);
    if (problem) result = { ok: false, detail: `Delivery refused: ${problem}.` };
    else result = await this.deliver(p.notificationId!, p.channel, p.payload!, context);
    if (this.d.closed) return; // Claimed record remains durable and is invalidated on restart.
    this.d.commit([{ type: 'decision.consumed', actor: SYSTEM, data: { decisionId: id, outcome: `${result.ok ? 'notification endpoint accepted' : 'notification delivery failed'}; ${p.host}; action ${p.actionHash}; ${result.detail}` } }], [], () => this.save(id, { ...p, consumed: true, transportUsed: true, state: result.ok ? 'delivered' : 'failed' }));
    for (const [token, permit] of this.permits) if (permit.decisionId === id) this.permits.delete(token);
  }

  /** Called by the JSON adapter, synchronously, immediately before its sole outbound attempt. */
  issueEgressPermit(id: string, channel: OutboundChannel, endpoint: string, init: RequestInit): string {
    const p = this.pending(id), dec = this.d.state.decisions[id];
    if (!p || p.type !== 'delivery' || p.state !== 'claimed' || p.transportUsed || !dec?.answeredAt || dec.answer !== 'approve' || dec.answeredBy?.type !== 'human' || !dec.confirmedAt || dec.consumedAt || this.problem(id, p) || p.channel !== channel || p.endpoint !== endpoint || init.method !== 'POST' || init.body !== JSON.stringify(p.payload) || init.redirect !== 'error') throw new CommandError('Exact single-delivery authorization missing or used', 403);
    const token = randomBytes(24).toString('hex');
    this.d.store.kvSet(`notify:decision:${id}`, JSON.stringify({ ...p, transportUsed: true }));
    this.permits.set(token, { decisionId: id, channel, endpoint, body: String(init.body) });
    return token;
  }
  /** Shared egress hook: consumes the opaque permit even on mismatch; never grants a host. */
  takeEgressPermit(token: string, url: string, init?: RequestInit): boolean {
    const permit = this.permits.get(token);
    this.permits.delete(token);
    if (!permit) return false;
    const p = this.pending(permit.decisionId), dec = this.d.state.decisions[permit.decisionId];
    try {
      const headers = new Headers(init?.headers);
      return Boolean(p && p.state === 'claimed' && p.transportUsed && !this.problem(permit.decisionId, p) && dec?.answeredAt && dec.answer === 'approve' && dec.answeredBy?.type === 'human' && dec.confirmedAt && !dec.consumedAt && p.channel === permit.channel && p.endpoint === permit.endpoint && JSON.stringify(p.payload) === permit.body && permit.endpoint === url && init?.method === 'POST' && init.body === permit.body && init.redirect === 'error' && [...headers].length === 1 && headers.get('content-type') === 'application/json' && !init.credentials && !init.referrer);
    } catch { return false; } // Malformed headers burn the permit and fail closed.

  }
  hosts(): string[] { return []; } // Including legacy endpoint approvals: no broad egress grants.

  configure(patch: Record<string, any>, actor: Actor = HUMAN): NotificationConfig {
    if (actor.type !== 'human') throw new CommandError('Only the owner can change notification settings', 403);
    const merged = { ...this.config, ...patch, channels: { ...this.config.channels, ...(patch.channels ?? {}) }, kinds: { ...this.config.kinds, ...(patch.kinds ?? {}) }, quietHours: { ...this.config.quietHours, ...(patch.quietHours ?? {}) } };
    for (const ch of ['native', 'browser', 'webpush', 'chat'] as const) merged.channels[ch] = { ...this.config.channels[ch], ...((patch.channels ?? {})[ch] ?? {}) };
    const parsed = NotificationConfigSchema.safeParse(merged);
    if (!parsed.success) throw new CommandError(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (!validTimezone(parsed.data.quietHours.timezone)) throw new CommandError('Unknown time zone. Use local or an IANA name such as Europe/London.');
    for (const ch of ['webpush', 'chat'] as const) if (parsed.data.channels[ch].endpoint) endpointHost(parsed.data.channels[ch].endpoint!);
    if (JSON.stringify(parsed.data) === JSON.stringify(this.config)) return this.getConfig();
    const revision = this.revision + 1;
    const auditConfig = structuredClone(parsed.data);
    for (const ch of ['webpush', 'chat'] as const) if (auditConfig.channels[ch].endpoint) auditConfig.channels[ch].endpoint = new URL(auditConfig.channels[ch].endpoint!).origin;
    this.d.commit([{ type: 'notification.config_changed', actor, data: { config: auditConfig } }], [], () => { this.d.store.kvSet('notify:config', JSON.stringify(parsed.data)); this.d.store.kvSet('notify:revision', JSON.stringify(revision)); });
    this.config = parsed.data; this.revision = revision;
    this.permits.clear(); this.sweep(); this.d.refreshEgress();
    return this.getConfig();
  }
  list(limit = 100): NotificationRecord[] {
    // Newest events, replayed oldest-first: acks and deliveries always follow their notification.
    const evs = this.d.store.list({ types: ['notification.emitted', 'notification.acked', 'notification.delivered'], limit: MAX_LIST, order: 'desc' }).reverse();
    const byId = new Map<string, NotificationRecord>();
    for (const e of evs) {
      if (e.type === 'notification.emitted') byId.set(e.data.notification.id, structuredClone(e.data.notification));
      else if (e.type === 'notification.acked') { const n = byId.get(e.data.id); if (n) n.ackedAt = e.ts; }
      else if (e.type === 'notification.delivered' && e.data.ok) { const n = byId.get(e.data.id); if (n && !n.routed.includes(e.data.channel)) { n.routed.push(e.data.channel); n.held = n.held.filter(x => x.channel !== e.data.channel); } }
    }
    return [...byId.values()].reverse().sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
  ack(id: string, actor: Actor = HUMAN): void {
    const n = this.list(10_000).find(x => x.id === id);
    if (!n) throw new CommandError('Unknown notification', 404);
    if (!n.ackedAt) {
      this.d.commit([{ type: 'notification.acked', actor, data: { id } }], [], () => {
        if (n.kind === 'ci_infra_failure' && isInfraFailureFingerprint(n.dedupeKey)) {
          this.acked[this.storageKey(n)] = n.dedupeKey;
          this.pruneSuppression();
          this.d.store.kvSet('notify:acked', JSON.stringify(this.acked));
        }
      });
    }
  }
  status() {
    const c = this.getConfig();
    const ep = (ch: OutboundChannel) => ({ enabled: c.channels[ch].enabled, endpoint: c.channels[ch].endpoint ? endpointHost(c.channels[ch].endpoint!).host : null, authorized: false, problem: c.channels[ch].endpoint ? 'Each message requires an exact human Decision.' : null, expiresAt: null, last: this.last[ch] ?? null });
    const pendingDeliveries = Object.values(this.d.state.decisions).flatMap(dec => { const p = this.pending(dec.id); return p?.type === 'delivery' && p.state === 'pending' && !dec.answeredAt && !dec.consumedAt && !this.problem(dec.id, p) ? [{ decisionId: dec.id, notificationId: p.notificationId, channel: p.channel, host: p.host, title: p.payload?.title, expiresAt: new Date(p.expires).toISOString() }] : []; });
    return { config: c, quietNow: inQuietHours(c.quietHours, this.d.now()), pendingDeliveries, channels: {
      local: { enabled: true, note: 'Durable inbox in this project’s event log. Always on.' },
      native: { enabled: c.channels.native.enabled, platform: process.platform, permission: 'unknown' as const, note: 'macOS does not tell One Connect whether banners are allowed. Send a test and confirm you saw it.', last: this.last.native ?? null },
      browser: { enabled: c.channels.browser.enabled, note: 'Each browser or phone grants permission itself; the dashboard shows its current state (unknown, denied or granted).', last: null },
      webpush: { ...ep('webpush'), note: 'JSON push gateway. Native Web Push encryption, subscriptions and VAPID are not implemented. Enabling creates message Decisions; it never sends automatically.' },
      chat: { ...ep('chat'), note: 'JSON chat webhook. Enabling creates message Decisions; every single delivery requires confirmation.' },
    }, unacked: this.list(10_000).filter(n => !n.ackedAt).length, email: 'Email is not offered.' };
  }
}
