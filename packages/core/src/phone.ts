// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Phone access and notification policy: pure schemas and decisions shared by the daemon (which
// enforces them) and the dashboard (which shows exactly what is allowed). Nothing here performs I/O.
import { z } from 'zod';
import { genericEventHealth, isReleaseLike } from './reports.ts';
import type { Decision } from './entities.ts';

// ---- remote access scope ----------------------------------------------------------------------

export const REMOTE_SCOPES = ['read', 'transcript', 'decisions', 'kill_switch', 'remote_decisions'] as const;
export type RemoteScope = (typeof REMOTE_SCOPES)[number];

export const REMOTE_SCOPE_INFO: Record<RemoteScope, { title: string; detail: string; mutates: boolean }> = {
  read: { title: 'Status and reports', detail: 'Agent status, usage, queues, alerts, granted Decisions, Brief, Timeline and the live project state. Never source diffs, connections, Docker or the vault.', mutates: false },
  transcript: { title: 'Run transcripts', detail: 'The redacted event transcript, bounded redacted run log and team messages of this project’s runs. Transcripts can quote project source: grant only if you accept that.', mutates: false },
  decisions: { title: 'Answer project Decisions', detail: 'Answer questions and exact merge, Docker, environment, release, cost, security settings, connector and single-message notification Decisions in this project. Destructive and outward options keep their second confirmation. Does not grant management routes or secret access.', mutates: true },
  kill_switch: { title: 'Engage the kill switch', detail: 'Stop every run in this project. Releasing the kill switch stays on the Mac.', mutates: true },
  remote_decisions: { title: 'Answer tunnel Decisions', detail: 'Additionally allow exact tunnel launch Decisions for this project. Requires project Decisions too. Does not grant pairing, session management or settings access.', mutates: true },
};

export const RemoteConfigSchema = z.object({
  /** Off until the owner enables it AND approves each tunnel launch. */
  enabled: z.boolean().default(false),
  /** `fixture` is a loopback test double and is refused for real access. */
  adapter: z.enum(['tailscale', 'fixture']).default('tailscale'),
  /** Tailscale Serve HTTPS port. 443 may already be in use, so the default is 8443. Each project daemon needs its own port. */
  httpsPort: z.union([z.literal(443), z.literal(8443), z.literal(10000)]).default(8443),
  scopes: z.array(z.enum(REMOTE_SCOPES)).min(1).max(REMOTE_SCOPES.length).default(['read', 'transcript', 'decisions', 'kill_switch']),
  pairingTtlSeconds: z.number().int().min(60).max(900).default(300),
  sessionTtlHours: z.number().min(1).max(168).default(12),
  idleTimeoutMinutes: z.number().int().min(5).max(1440).default(120),
  maxSessions: z.number().int().min(1).max(5).default(2),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;
export const defaultRemoteConfig = (): RemoteConfig => RemoteConfigSchema.parse({});

export type RemoteRouteDecision = { allow: true; scope: RemoteScope | null; mutation: boolean } | { allow: false; reason: string };

const seg = '[^/]+';
const RULES: { method: string; re: RegExp; scope: RemoteScope | null }[] = [
  { method: 'GET', re: /^\/api\/state$/, scope: 'read' },
  { method: 'GET', re: /^\/api\/team$/, scope: 'read' },
  { method: 'GET', re: /^\/api\/team\/messages$/, scope: 'transcript' },
  { method: 'GET', re: new RegExp(`^/api/work-items/${seg}/events$`), scope: 'read' },
  { method: 'GET', re: /^\/api\/reports\/(?:brief|timeline|morning|standup)$/, scope: 'read' },
  { method: 'GET', re: /^\/api\/notifications$/, scope: 'read' },
  { method: 'POST', re: new RegExp(`^/api/notifications/${seg}/ack$`), scope: 'read' },
  { method: 'GET', re: new RegExp(`^/api/runs/${seg}/(?:events|log|log/page)$`), scope: 'transcript' },
  { method: 'GET', re: new RegExp(`^/api/decisions/${seg}/history$`), scope: 'decisions' },
  { method: 'POST', re: new RegExp(`^/api/decisions/${seg}/(?:prepare|answer)$`), scope: 'decisions' },
  { method: 'POST', re: new RegExp(`^/api/approvals/${seg}/resolve$`), scope: 'decisions' },
  { method: 'POST', re: /^\/api\/kill-switch$/, scope: 'kill_switch' },
  { method: 'GET', re: /^\/api\/remote\/session$/, scope: null },
  { method: 'POST', re: /^\/api\/remote\/logout$/, scope: null },
  { method: 'GET', re: /^\/ws$/, scope: 'read' },
];

/**
 * Whether a phone session may call this route. Everything not listed is refused, including source
 * diffs, connections, Docker, the vault, project management and every remote-access admin call.
 */
export function remoteRouteDecision(method: string, rawPath: string, scopes: readonly RemoteScope[], body?: unknown): RemoteRouteDecision {
  const path = rawPath.split('?')[0].replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  const rule = RULES.find(r => r.method === (m === 'HEAD' ? 'GET' : m) && r.re.test(path));
  if (!rule) return { allow: false, reason: 'This action is not available from a paired phone. Use the Mac.' };
  if (rule.scope && !scopes.includes(rule.scope)) return { allow: false, reason: `This phone was not granted “${REMOTE_SCOPE_INFO[rule.scope].title}”.` };
  if (path === '/api/kill-switch' && (body as { engaged?: unknown } | undefined)?.engaged !== true) return { allow: false, reason: 'A phone can engage the kill switch but not release it.' };
  const mutation = m !== 'GET' && m !== 'HEAD';
  return { allow: true, scope: rule.scope, mutation };
}

/** Target-level policy shared by the gate and phone cards; a route grant alone is insufficient. */
export function remoteDecisionAccess(decision: Pick<Decision, 'kind'>, scopes: readonly string[], notificationDelivery = false): { allow: true } | { allow: false; reason: string } {
  if (!scopes.includes('decisions')) return { allow: false, reason: 'This phone was not granted project Decisions.' };
  const kind = decision.kind ?? 'question';
  if (kind === 'remote') return scopes.includes('remote_decisions') ? { allow: true } : { allow: false, reason: 'Tunnel Decisions require the separate tunnel Decision scope. Use the Mac.' };
  if (kind === 'notification' && !notificationDelivery) return { allow: false, reason: 'Endpoint settings reviews stay on the Mac. Individual message Decisions may be answered here.' };
  if (!['question', 'merge', 'docker', 'environment', 'release', 'cost', 'settings', 'connector', 'notification'].includes(kind)) return { allow: false, reason: 'Unknown Decision kind. Use the Mac.' };
  return { allow: true };
}

// ---- notifications ---------------------------------------------------------------------------

export const NOTIFICATION_KINDS = ['stalled_run', 'aged_approval', 'usage_limit', 'ci_infra_failure', 'finished_work'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  stalled_run: 'Stalled run',
  aged_approval: 'Approval waiting',
  usage_limit: 'Usage limit',
  ci_infra_failure: 'Check or infrastructure failure',
  finished_work: 'Finished work',
};

export const NOTIFICATION_CHANNELS = ['local', 'native', 'browser', 'webpush', 'chat'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
/** `webpush` is retained as a storage/API key for existing settings; it is a JSON gateway. */
export const NOTIFICATION_CHANNEL_LABEL: Record<NotificationChannel, string> = { local: 'Local inbox', native: 'macOS banner', browser: 'Browser notification', webpush: 'JSON push gateway', chat: 'Chat webhook' };

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
export const NotificationConfigSchema = z.object({
  /** `local` is the durable in-app inbox and cannot be turned off; every other channel is off by default. */
  channels: z.object({
    native: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    browser: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    webpush: z.object({ enabled: z.boolean().default(false), endpoint: z.string().max(500).nullable().default(null) }).default({ enabled: false, endpoint: null }),
    chat: z.object({ enabled: z.boolean().default(false), endpoint: z.string().max(500).nullable().default(null) }).default({ enabled: false, endpoint: null }),
  }).default({ native: { enabled: false }, browser: { enabled: false }, webpush: { enabled: false, endpoint: null }, chat: { enabled: false, endpoint: null } }),
  kinds: z.object({
    stalled_run: z.boolean().default(true),
    aged_approval: z.boolean().default(true),
    usage_limit: z.boolean().default(true),
    ci_infra_failure: z.boolean().default(true),
    finished_work: z.boolean().default(true),
  }).default({ stalled_run: true, aged_approval: true, usage_limit: true, ci_infra_failure: true, finished_work: true }),
  quietHours: z.object({
    enabled: z.boolean().default(false),
    start: hhmm.default('22:00'),
    end: hhmm.default('07:00'),
    /** IANA zone or `local` (this Mac's zone). */
    timezone: z.string().max(64).default('local'),
  }).default({ enabled: false, start: '22:00', end: '07:00', timezone: 'local' }),
  agedApprovalMinutes: z.number().int().min(5).max(1440).default(30),
  cooldownMinutes: z.number().int().min(5).max(1440).default(60),
});
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
export const defaultNotificationConfig = (): NotificationConfig => NotificationConfigSchema.parse({});

/** Minutes since midnight in `timezone` at `at`. Falls back to the local zone for an unknown zone. */
export function minutesOfDay(at: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timezone !== 'local' ? { timeZone: timezone } : {}) }).formatToParts(at);
    const h = Number(parts.find(p => p.type === 'hour')?.value ?? 0), m = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch {
    return at.getHours() * 60 + at.getMinutes();
  }
}

export function validTimezone(timezone: string): boolean {
  if (timezone === 'local') return true;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }); return true; } catch { return false; }
}

/** Quiet hours may wrap midnight (22:00 to 07:00). Equal start and end means no quiet window. */
export function inQuietHours(q: NotificationConfig['quietHours'], at: Date): boolean {
  if (!q.enabled) return false;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const start = toMin(q.start), end = toMin(q.end), now = minutesOfDay(at, q.timezone);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export interface NotificationRefs { runId?: string | null; agentId?: string | null; workItemId?: string | null; approvalId?: string | null; decisionId?: string | null; eventSeq?: number | null }
/** What the rules propose; the daemon dedupes, redacts, applies quiet hours and routes it. */
export interface NotificationCandidate {
  kind: NotificationKind;
  severity: 'info' | 'warn' | 'critical';
  dedupeKey: string;
  title: string;
  /** In-app text. Built from structured fields, never transcript text. */
  detail: string;
  /** What leaves the machine on push/chat: kind, a short title and key only. */
  external: string;
  refs: NotificationRefs;
}

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  severity: NotificationCandidate['severity'];
  title: string;
  detail: string;
  refs: NotificationRefs;
  dedupeKey: string;
  at: string;
  /** Channels this notification was routed to (after config and quiet hours), plus why others were held back. */
  routed: NotificationChannel[];
  held: { channel: NotificationChannel; reason: string }[];
  ackedAt: string | null;
}

interface EventLike { seq: number; type: string; agentId?: string | null; runId?: string | null; workItemId?: string | null; data: unknown }
interface StateLike {
  agents: Record<string, { id: string; config: { name: string }; limitedUntil: string | null }>;
  runs: Record<string, { id: string; agentId: string; workItemId: string; state: string; exit: { kind: string } | null }>;
  workItems: Record<string, { key: string | null; title: string }>;
  approvals: Record<string, { id: string; agentId: string; runId: string; workItemId: string | null; title: string; createdAt: string; resolvedAt: string | null }>;
  decisions: Record<string, { id: string; question: string; createdAt: string; answeredAt: string | null; consumedAt?: string | null; workItemId?: string | null; urgency: string }>;
  alerts: Record<string, { id: string; kind: string; severity: string; runId?: string; agentId?: string; workItemId?: string; resolvedAt: string | null }>;
}

const agentName = (s: StateLike, id: string | null | undefined) => (id && s.agents[id]?.config.name) || id || 'An agent';
const issue = (s: StateLike, id: string | null | undefined) => (id && s.workItems[id]?.key) || null;

/** Notification candidates for newly committed events. Pure; the daemon owns dedupe and delivery. */
export function candidatesFromEvents(s: StateLike, events: readonly EventLike[]): NotificationCandidate[] {
  const out: NotificationCandidate[] = [];
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, any>;
    const key = issue(s, e.workItemId);
    const who = agentName(s, e.agentId);
    const on = key ? ` on ${key}` : '';
    const refs = { runId: e.runId, agentId: e.agentId, workItemId: e.workItemId, eventSeq: e.seq };
    if (e.type === 'alert.raised') {
      const a = d.alert as { kind: string; severity: 'info' | 'warn' | 'critical'; message: string; dedupeKey: string; runId?: string };
      if (a.kind === 'stall') out.push({ kind: 'stalled_run', severity: 'critical', dedupeKey: `stall:${a.runId ?? e.runId}`, title: `${who} appears stalled${on}`, detail: a.message, external: `Run stalled${on}`, refs });
      else if (a.kind === 'usage_limit') out.push({ kind: 'usage_limit', severity: 'critical', dedupeKey: `limit:${e.agentId}`, title: `${who} hit its usage limit`, detail: a.message, external: `${who}: usage limit reached`, refs });
      else if (a.kind === 'approval_pending') out.push({ kind: 'aged_approval', severity: a.severity, dedupeKey: `alert:${a.dedupeKey}`, title: `A question for you is still waiting${on}`, detail: a.message, external: `Approval waiting${on}`, refs });
      else if (a.kind === 'tracker_out_of_sync' || a.kind === 'merge' || a.kind === 'orphaned_run') out.push({ kind: 'ci_infra_failure', severity: a.severity, dedupeKey: `alert:${a.dedupeKey}`, title: `${a.kind.replace(/_/g, ' ')} problem`, detail: a.message, external: `${a.kind.replace(/_/g, ' ')} problem${on}`, refs });
    } else if (e.type === 'merge.post_checks' && d.status === 'failed') {
      out.push({ kind: 'ci_infra_failure', severity: 'critical', dedupeKey: `post-checks:${d.mergeId}`, title: `Post-merge checks failed${on}`, detail: `The recorded post-merge checks for merge ${d.mergeId} failed.`, external: `Post-merge checks failed${on}`, refs });
    } else if (e.type === 'work_item.evidence_added') {
      const ev = d.evidence as { kind: string; verified: boolean; exitCode?: number | null; counts?: { failed: number }; command?: string; id: string };
      if (ev.verified && (ev.kind === 'test' || ev.kind === 'command') && ((ev.exitCode ?? 0) !== 0 || (ev.counts?.failed ?? 0) > 0)) out.push({ kind: 'ci_infra_failure', severity: 'warn', dedupeKey: `evidence:${ev.id}`, title: `A recorded check failed${on}`, detail: `${ev.command ?? 'check'} failed (exit ${ev.exitCode ?? '?'}).`, external: `A recorded check failed${on}`, refs });
    } else if (isReleaseLike(e.type)) {
      const g = genericEventHealth(e.type, d);
      if (!g.failed) continue;
      const dedupeKey = g.fingerprint ?? `${e.type}:${String(d.plan?.id ?? d.id ?? d.releaseId ?? d.name ?? 'event')}`;
      out.push({ kind: 'ci_infra_failure', severity: 'critical', dedupeKey, title: `${e.type.replace(/[._]/g, ' ')} reported a failure`, detail: g.summary.slice(0, 300), external: `${e.type.split('.')[0]} failure reported`, refs });
    } else if (e.type === 'run.ended' && d.exit?.kind === 'completed') {
      out.push({ kind: 'finished_work', severity: 'info', dedupeKey: `finished:${e.runId}`, title: `${who} finished${on}`, detail: `Run ended normally${on}. Review its handoff before relying on it.`, external: `${who} finished${on}`, refs });
    } else if (e.type === 'merge.completed') {
      const m = d.merge as { mergeSha: string; target: string };
      out.push({ kind: 'finished_work', severity: 'info', dedupeKey: `merged:${m.mergeSha}`, title: `Merged locally${on}`, detail: `Merged into ${m.target} as ${m.mergeSha.slice(0, 10)}. Nothing was pushed.`, external: `Merged locally${on}`, refs });
    }
  }
  return out;
}

/** Time-based candidates: aged approvals and decisions, stalled runs and limited agents that are still true now. */
export function candidatesFromTick(s: StateLike, now: number, agedMinutes: number): NotificationCandidate[] {
  const out: NotificationCandidate[] = [];
  for (const ap of Object.values(s.approvals)) {
    const age = now - Date.parse(ap.createdAt);
    if (ap.resolvedAt || age < agedMinutes * 60_000) continue;
    const key = issue(s, ap.workItemId);
    out.push({ kind: 'aged_approval', severity: 'critical', dedupeKey: `approval:${ap.id}`, title: `${agentName(s, ap.agentId)} has waited ${Math.round(age / 60_000)} min for you`, detail: ap.title, external: `Approval waiting${key ? ` on ${key}` : ''}`, refs: { approvalId: ap.id, runId: ap.runId, agentId: ap.agentId, workItemId: ap.workItemId } });
  }
  for (const dec of Object.values(s.decisions)) {
    const age = now - Date.parse(dec.createdAt);
    if (dec.answeredAt || dec.consumedAt || age < agedMinutes * 60_000) continue;
    const key = issue(s, dec.workItemId);
    out.push({ kind: 'aged_approval', severity: dec.urgency === 'critical' || dec.urgency === 'high' ? 'critical' : 'warn', dedupeKey: `decision:${dec.id}`, title: `A Decision has waited ${Math.round(age / 60_000)} min${key ? ` (${key})` : ''}`, detail: dec.question, external: `Decision waiting${key ? ` on ${key}` : ''}`, refs: { decisionId: dec.id, workItemId: dec.workItemId ?? null } });
  }
  for (const r of Object.values(s.runs)) {
    if (r.state !== 'stalled') continue;
    const key = issue(s, r.workItemId);
    out.push({ kind: 'stalled_run', severity: 'critical', dedupeKey: `stall:${r.id}`, title: `${agentName(s, r.agentId)} appears stalled${key ? ` on ${key}` : ''}`, detail: 'The run has produced no events within the stall window.', external: `Run stalled${key ? ` on ${key}` : ''}`, refs: { runId: r.id, agentId: r.agentId, workItemId: r.workItemId } });
  }
  for (const a of Object.values(s.agents)) {
    if (!a.limitedUntil) continue;
    out.push({ kind: 'usage_limit', severity: 'critical', dedupeKey: `limit:${a.id}`, title: `${a.config.name} hit its usage limit`, detail: a.limitedUntil === 'unknown' ? 'Reset time is not reported by the vendor.' : `Resets ${a.limitedUntil}.`, external: `${a.config.name}: usage limit reached`, refs: { agentId: a.id } });
  }
  return out;
}
