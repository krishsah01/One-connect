// SPDX-License-Identifier: Apache-2.0
// Brief, Timeline, morning report and standup. Pure functions over the event log and the reducer
// state: every claim carries the exact events (and SHAs/commands) that back it, nothing is
// summarized by a model, and absence of evidence is stated rather than rendered as success.
import type { ControlState } from './entities.ts';
import type { InfraHealthReport } from './release.ts';

export interface ReportEvent {
  seq: number;
  id: string;
  ts: string;
  type: string;
  actor: { type: string; id: string };
  agentId: string | null;
  runId: string | null;
  workItemId: string | null;
  assignmentId?: string | null;
  data: unknown;
}

export interface EvidenceRef { seq: number; eventId: string; type: string; ts: string; sha?: string; command?: string; result?: string }
export type ClaimBasis = 'recorded' | 'agent_reported' | 'derived';
export interface Claim {
  id: string;
  text: string;
  /** recorded = the control center itself recorded it; agent_reported = an agent said so (unverified); derived = counted from recorded events. */
  basis: ClaimBasis;
  verified: boolean | null;
  evidence: EvidenceRef[];
}

export interface ReportFilter { issue?: string | null; agent?: string | null; from?: string | null; to?: string | null; types?: string[] | null }

export interface TimelineEntry {
  seq: number;
  id: string;
  ts: string;
  type: string;
  label: string;
  summary: string;
  actor: string;
  agentId: string | null;
  runId: string | null;
  workItemId: string | null;
  issue: string | null;
  sha: string | null;
  tone: 'ok' | 'warn' | 'crit' | 'info' | 'idle';
}

const SHORT = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sha8 = (s: string | null | undefined) => (s ? s.slice(0, 10) : '');
const d = (e: ReportEvent) => (e.data ?? {}) as Record<string, any>;
export const isReleaseLike = (type: string) => /^(release|deploy|infra|ci|code_host)\./.test(type);

const RELEASE_FAILURE = /^(fail|failed|failure|error|errored|unhealthy|unavailable|degraded|drift|rolled_?back|refused)$/i;

/** True when a named infra component is a configured, evidenced failure — not unknown/unchecked/unconfigured. */
export function infraComponentFailed(component: string, part: { state: string; source?: string; service?: string | null }): boolean {
  const { state, source } = part;
  switch (component) {
    case 'docker': return state === 'unavailable' || state === 'degraded';
    case 'postgres': return state === 'paused' || state === 'unhealthy' || state === 'stopped' || state === 'missing';
    case 'vercel': return source !== 'unconfigured' && source !== 'refused' && (state === 'degraded' || state === 'error');
    case 'migrations': return state === 'drift' || state === 'error';
    default: return RELEASE_FAILURE.test(state);
  }
}

/** Positive evidence that a component was checked and is healthy — not absence of configuration. */
export function infraHasPositiveEvidence(health: InfraHealthReport): boolean {
  return health.docker.state === 'ready'
    || health.postgres.state === 'ready'
    || health.vercel.state === 'ready'
    || health.migrations.state === 'in_sync';
}

export function isInfraFailureFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith('infra:') && fingerprint !== 'infra:unknown' && fingerprint !== 'infra:healthy';
}

function infraFailureTokens(fingerprint: string): string[] {
  if (!isInfraFailureFingerprint(fingerprint)) return [];
  return fingerprint.slice('infra:'.length).split('|');
}

function infraComponentRecovered(health: InfraHealthReport, token: string): boolean {
  const [component, , service] = token.split(':');
  switch (component) {
    case 'docker': return health.docker.state === 'ready';
    case 'postgres': return health.postgres.state === 'ready' && (!service || health.postgres.service === service);
    case 'vercel': return health.vercel.state === 'ready';
    case 'migrations': return health.migrations.state === 'in_sync';
    default: return false;
  }
}

/** True when every failure named in a prior infra fingerprint now has positive recovery evidence. */
export function infraFailuresRecovered(health: InfraHealthReport, failureFingerprint: string): boolean {
  const tokens = infraFailureTokens(failureFingerprint);
  return tokens.length > 0 && tokens.every((token) => infraComponentRecovered(health, token));
}

function infraObservationFingerprint(health: InfraHealthReport, failures: string[]): string {
  if (failures.length) return `infra:${failures.sort().join('|')}`;
  return infraHasPositiveEvidence(health) ? 'infra:healthy' : 'infra:unknown';
}

/** Classify a full infra health report for alerts and timeline. Unknown stays unknown; only evidenced failures count. */
export function classifyInfraHealth(health: InfraHealthReport): { summary: string; failed: boolean; fingerprint: string; failures: string[] } {
  const parts: string[] = [];
  const failures: string[] = [];
  const add = (name: string, part: { state: string; source?: string; service?: string | null }) => {
    parts.push(`${name} ${part.state}`);
    if (infraComponentFailed(name, part)) failures.push(`${name}:${part.state}${part.service ? `:${part.service}` : ''}`);
  };
  add('docker', health.docker);
  add('postgres', health.postgres);
  add('vercel', health.vercel);
  add('migrations', health.migrations);
  const fingerprint = infraObservationFingerprint(health, failures);
  return { summary: `Infrastructure check: ${parts.join(', ')}.`, failed: failures.length > 0, fingerprint, failures };
}

function isInfraHealthReport(h: unknown): h is InfraHealthReport {
  const x = h as InfraHealthReport;
  return Boolean(x && typeof x === 'object' && x.docker && x.postgres && x.vercel && x.migrations);
}

/**
 * Reads release/infra/CI events by shape, not by importing another module's types: a plan with
 * recorded step statuses, a health report with component states, or a plain status/ok field.
 * Returns only what the event itself says; unknown shapes are reported as recorded, never as healthy.
 */
export function genericEventHealth(type: string, data: unknown): { summary: string; failed: boolean; sha: string | null; fingerprint?: string } {
  const x = (data ?? {}) as Record<string, any>;
  const plan = x.plan;
  if (plan && Array.isArray(plan.steps)) {
    const by: Record<string, number> = {};
    for (const st of plan.steps) by[String(st.status)] = (by[String(st.status)] ?? 0) + 1;
    const counts = Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ');
    const failed = (by.failed ?? 0) > 0;
    const id = String(plan.id ?? plan.name ?? 'plan');
    return { summary: `Release plan “${plan.name}” is ${plan.status}${plan.sha ? ` at ${String(plan.sha).slice(0, 10)}` : ''}; steps: ${counts || 'none'}. Step status is as recorded, not independently verified.`, failed, sha: plan.sha ?? null, fingerprint: failed ? `release:${id}:failed` : undefined };
  }
  const h = x.health;
  if (h && typeof h === 'object') {
    if (isInfraHealthReport(h)) {
      const c = classifyInfraHealth(h);
      return { summary: c.summary, failed: c.failed, sha: null, fingerprint: c.fingerprint };
    }
    const parts: string[] = []; const failures: string[] = [];
    for (const [k, v] of Object.entries(h as Record<string, any>)) {
      if (v && typeof v === 'object' && typeof v.state === 'string') {
        parts.push(`${k} ${v.state}`);
        if (infraComponentFailed(k, v as { state: string; source?: string; service?: string | null })) failures.push(`${k}:${v.state}${(v as { service?: string | null }).service ? `:${(v as { service?: string | null }).service}` : ''}`);
      }
    }
    const fingerprint = failures.length ? `infra:${failures.sort().join('|')}` : 'infra:unknown';
    return { summary: `Infrastructure check: ${parts.join(', ') || 'no component states reported'}.`, failed: failures.length > 0, sha: null, fingerprint };
  }
  const snap = x.snapshot;
  if (snap && typeof snap === 'object') {
    const checks = Array.isArray(snap.checks) ? snap.checks : [];
    const failed = checks.some((c: any) => /^(fail|failed|failure|error|errored|timed_out|action_required|cancelled)$/i.test(String(c.conclusion ?? c.status ?? c.state ?? '')));
    const sha = typeof snap.sha === 'string' ? snap.sha : null;
    return { summary: `Code host snapshot${sha ? ` at ${sha.slice(0, 10)}` : ''}: ${checks.length} check${checks.length === 1 ? '' : 's'} reported${failed ? ', some failing' : ''}.`, failed, sha, fingerprint: failed ? `code_host:${sha ?? 'unknown'}:failed` : undefined };
  }
  const status = String(x.status ?? x.state ?? x.result ?? '');
  const failed = x.ok === false || x.success === false || RELEASE_FAILURE.test(status) || status === 'error';
  const id = String(x.id ?? x.releaseId ?? x.name ?? type);
  return { summary: String(x.summary ?? x.message ?? x.title ?? x.name ?? (status || `${type} recorded`)), failed, sha: typeof x.sha === 'string' ? x.sha : typeof x.commit === 'string' ? x.commit : null, fingerprint: failed ? `${type}:${id}:${status || 'failed'}` : undefined };
}

export function evidenceRef(e: ReportEvent, extra: Partial<EvidenceRef> = {}): EvidenceRef {
  return { seq: e.seq, eventId: e.id, type: e.type, ts: e.ts, ...extra };
}

function issueKey(s: Pick<ControlState, 'workItems'>, id: string | null | undefined): string | null {
  if (!id) return null;
  const w = s.workItems[id];
  return w ? (w.key ?? w.title) : null;
}

export function matchesFilter(s: Pick<ControlState, 'workItems'>, e: ReportEvent, f: ReportFilter): boolean {
  if (f.from && Date.parse(e.ts) < Date.parse(f.from)) return false;
  if (f.to && Date.parse(e.ts) > Date.parse(f.to)) return false;
  if (f.agent && e.agentId !== f.agent) return false;
  if (f.issue) {
    const w = e.workItemId ? s.workItems[e.workItemId] : null;
    if (!e.workItemId || !(e.workItemId === f.issue || w?.key === f.issue)) return false;
  }
  if (f.types?.length && !f.types.some(t => e.type === t || e.type.startsWith(`${t}.`))) return false;
  return true;
}

const TIMELINE_TYPES = new Set([
  'daemon.started', 'work_item.created', 'work_item.transitioned', 'work_item.evidence_added', 'run.created', 'run.ended', 'run.handoff', 'run.tests',
  'approval.requested', 'approval.resolved', 'alert.raised', 'alert.resolved', 'decision.created', 'decision.answered', 'decision.consumed', 'kill_switch.set',
  'merge.completed', 'merge.post_checks', 'merge.refused', 'review.recorded', 'agent.limited', 'agent.unlimited', 'agent.paused', 'agent.resumed',
  'workflow.status', 'notification.emitted', 'remote.paired', 'remote.session_revoked', 'remote.tunnel_state', 'benchmark.completed',
  't.commit', 't.test_result', 't.error',
]);

export function describeEvent(s: ControlState, e: ReportEvent): Omit<TimelineEntry, 'seq' | 'id' | 'ts' | 'type' | 'actor' | 'agentId' | 'runId' | 'workItemId' | 'issue'> | null {
  const x = d(e);
  const who = e.agentId ? (s.agents[e.agentId]?.config.name ?? e.agentId) : 'One Connect';
  const mk = (label: string, summary: string, tone: TimelineEntry['tone'] = 'info', sha: string | null = null) => ({ label, summary: SHORT(summary, 220), tone, sha });
  switch (e.type) {
    case 'daemon.started': return mk('Daemon started', `Control center started (pid ${x.pid}).`, 'idle');
    case 'work_item.created': return mk('Issue created', `${x.item?.key ?? ''} ${x.item?.title ?? ''}`.trim());
    case 'work_item.transitioned': return mk('Status', `${x.from} → ${x.to}: ${x.reason}`, x.to === 'failed' || x.to === 'stalled' ? 'crit' : x.to === 'blocked' ? 'warn' : 'info');
    case 'work_item.evidence_added': {
      const ev = x.evidence ?? {};
      const bad = (ev.exitCode ?? 0) !== 0 || (ev.counts?.failed ?? 0) > 0;
      return mk(`Evidence (${ev.kind})`, `${ev.summary ?? ''}${ev.command ? ` · \`${ev.command}\`` : ''}${ev.exitCode != null ? ` · exit ${ev.exitCode}` : ''}${ev.verified ? ' · recorded by One Connect' : ' · claimed by an agent'}`, bad ? 'crit' : ev.verified ? 'ok' : 'warn', ev.sha ?? null);
    }
    case 'run.created': return mk('Run created', `${who} run created (attempt ${x.run?.attempt ?? 1}).`, 'info');
    case 'run.ended': return mk('Run ended', `${who}: ${x.exit?.kind}${x.exit?.message ? ` — ${x.exit.message}` : ''}`, x.exit?.kind === 'completed' ? 'ok' : x.exit?.kind === 'stopped' || x.exit?.kind === 'killed' ? 'idle' : 'crit');
    case 'run.handoff': return mk('Handoff', `${who}: ${x.handoff?.done ?? ''}`, x.handoff?.blocked ? 'warn' : 'info', x.handoff?.commit?.sha ?? null);
    case 'run.tests': return mk('Tests', `${x.counts?.passed ?? 0} passed, ${x.counts?.failed ?? 0} failed${x.counts?.skipped ? `, ${x.counts.skipped} skipped` : ''} · \`${x.command}\` · ${x.source === 'daemon' ? 'run by One Connect' : 'reported by the agent'}`, (x.counts?.failed ?? 0) > 0 ? 'crit' : x.source === 'daemon' ? 'ok' : 'warn');
    case 'approval.requested': return mk('Question asked', `${who}: ${x.approval?.title ?? ''}`, 'warn');
    case 'approval.resolved': return mk('Question answered', `${x.decision} (${x.by} via ${x.channel})`, 'ok');
    case 'alert.raised': return mk('Alert', `${x.alert?.kind}: ${x.alert?.message ?? ''}`, x.alert?.severity === 'critical' ? 'crit' : x.alert?.severity === 'warn' ? 'warn' : 'info');
    case 'alert.resolved': return mk('Alert resolved', `${x.resolution}`, 'idle');
    case 'decision.created': return mk('Decision requested', `${x.decision?.question ?? ''}`, 'warn');
    case 'decision.answered': return mk('Decision answered', `${x.answer}${x.confirmed ? ' (confirmed)' : ''} via ${x.channel}`, 'ok');
    case 'decision.consumed': return mk('Decision used', `${x.outcome}`, 'idle');
    case 'kill_switch.set': return mk('Kill switch', x.engaged ? 'Engaged: all runs stopped, dispatch blocked.' : 'Released.', x.engaged ? 'crit' : 'ok');
    case 'merge.completed': return mk('Merged locally', `${x.merge?.sourceBranch} → ${x.merge?.target} as ${sha8(x.merge?.mergeSha)}. Nothing was pushed.`, 'ok', x.merge?.mergeSha ?? null);
    case 'merge.post_checks': return mk('Post-merge checks', `${x.status}`, x.status === 'failed' ? 'crit' : x.status === 'passed' ? 'ok' : 'warn');
    case 'merge.refused': return mk('Merge refused', `${x.reason}`, 'warn');
    case 'review.recorded': return mk('Review', `${x.review?.verdict ?? 'recorded'} at ${sha8(x.review?.sha)}`, x.review?.verdict === 'approve' ? 'ok' : 'warn', x.review?.sha ?? null);
    case 'agent.limited': return mk('Usage limited', `${who}: ${x.message}`, 'warn');
    case 'agent.unlimited': return mk('Usage restored', `${who}: ${x.reason}`, 'ok');
    case 'agent.paused': return mk('Agent paused', `${who}: ${x.reason}`, 'warn');
    case 'agent.resumed': return mk('Agent resumed', who, 'ok');
    case 'workflow.status': return mk('Workflow', `${x.status}${x.reason ? `: ${x.reason}` : ''}`, x.status === 'failed' ? 'crit' : 'info');
    case 'notification.emitted': return mk('Notification', `${x.notification?.title ?? ''}`, 'idle');
    case 'remote.paired': return mk('Phone paired', `A phone session was paired (scopes: ${(x.scopes ?? []).join(', ')}).`, 'info');
    case 'remote.session_revoked': return mk('Phone session revoked', `${x.reason}`, 'warn');
    case 'remote.tunnel_state': return mk('Remote tunnel', `${x.state}${x.hostname ? ` (${x.hostname})` : ''}: ${x.detail}`, x.state === 'up' ? 'info' : x.state === 'error' ? 'crit' : 'idle');
    case 'benchmark.completed': return mk('Context benchmark', `Fixture corpus ${x.corpus}: ${(x.summary?.regressions as unknown[] | undefined)?.length ?? 0} regressions.`, 'info');
    case 't.commit': return mk('Commit', `${sha8(x.sha)} ${x.subject}`, 'info', x.sha ?? null);
    case 't.test_result': return mk('Tests (transcript)', `${x.counts?.passed} passed, ${x.counts?.failed} failed · \`${x.command}\``, (x.counts?.failed ?? 0) > 0 ? 'crit' : 'warn');
    case 't.error': return mk('Error', `${x.failure ? `[${x.failure}] ` : ''}${x.message}`, 'crit');
    default:
      if (isReleaseLike(e.type)) { const g = genericEventHealth(e.type, e.data); return mk(`Event ${e.type}`, g.summary, g.failed ? 'crit' : 'info', g.sha); }
      return null;
  }
}

export function buildTimeline(s: ControlState, events: readonly ReportEvent[], f: ReportFilter = {}, o: { limit?: number; beforeSeq?: number | null } = {}): { entries: TimelineEntry[]; total: number; hasMore: boolean } {
  const all: TimelineEntry[] = [];
  for (const e of events) {
    if (o.beforeSeq && e.seq >= o.beforeSeq) continue;
    if (!TIMELINE_TYPES.has(e.type) && !isReleaseLike(e.type)) continue;
    if (!matchesFilter(s, e, f)) continue;
    const ds = describeEvent(s, e);
    if (!ds) continue;
    all.push({ seq: e.seq, id: e.id, ts: e.ts, type: e.type, actor: e.actor.type === 'human' ? 'you' : e.actor.type === 'agent' ? (s.agents[e.actor.id]?.config.name ?? e.actor.id) : 'One Connect', agentId: e.agentId, runId: e.runId, workItemId: e.workItemId, issue: issueKey(s, e.workItemId), ...ds });
  }
  all.sort((a, b) => b.seq - a.seq);
  const limit = Math.max(1, Math.min(o.limit ?? 100, 500));
  return { entries: all.slice(0, limit), total: all.length, hasMore: all.length > limit };
}

// ---- Brief ------------------------------------------------------------------------------------

export interface HandoffCard {
  runId: string;
  seq: number;
  eventId: string;
  at: string;
  agent: string;
  agentId: string;
  issue: string | null;
  title: string | null;
  done: string;
  next: string | null;
  blocked: { what: string; on: string | null } | null;
  commit: { sha: string; branch: string | null; verified: boolean | null } | null;
  evidence: { command: string; result: string; verified: boolean | null }[];
  verdict: string | null;
  source: string;
  runState: string | null;
}

export interface CheckRow { evidence: EvidenceRef; kind: string; summary: string; command: string | null; exitCode: number | null; passed: number | null; failed: number | null; verified: boolean | null; issue: string | null; sha: string | null }
export interface MergeRow { evidence: EvidenceRef[]; mergeSha: string; sourceSha: string; sourceBranch: string; target: string; at: string; postChecks: string; issue: string | null }
export interface PendingItem { kind: 'decision' | 'approval' | 'alert'; id: string; title: string; urgency: 'critical' | 'high' | 'normal' | 'low'; ageMinutes: number; issue: string | null; detail: string | null }

export interface Brief {
  generatedAt: string;
  seq: number;
  project: string | null;
  filter: ReportFilter;
  now: { agentId: string; agent: string; status: string; issue: string | null; title: string | null; run: { id: string; state: string; lastMeaningful: string | null } | null }[];
  next: { agentId: string; agent: string; items: { issue: string | null; title: string }[] }[];
  pending: PendingItem[];
  handoffs: HandoffCard[];
  checks: CheckRow[];
  merges: MergeRow[];
  releases: TimelineEntry[];
  notes: string[];
}

export function handoffCards(s: ControlState, events: readonly ReportEvent[], f: ReportFilter = {}): HandoffCard[] {
  const latest = new Map<string, ReportEvent>();
  for (const e of events) if (e.type === 'run.handoff' && e.runId && matchesFilter(s, e, f)) latest.set(e.runId, e);
  return [...latest.values()].sort((a, b) => b.seq - a.seq).map(e => {
    const h = d(e).handoff;
    const run = e.runId ? s.runs[e.runId] : undefined;
    return {
      runId: e.runId!, seq: e.seq, eventId: e.id, at: e.ts, agent: e.agentId ? (s.agents[e.agentId]?.config.name ?? e.agentId) : 'agent', agentId: e.agentId ?? '', issue: issueKey(s, e.workItemId),
      title: e.workItemId ? (s.workItems[e.workItemId]?.title ?? null) : null,
      done: String(h?.done ?? ''), next: h?.next ?? null, blocked: h?.blocked ?? null,
      commit: h?.commit ? { sha: h.commit.sha, branch: h.commit.branch ?? null, verified: h.commit.verified ?? null } : null,
      evidence: ((h?.evidence ?? []) as { command: string; result: string; verified?: boolean }[]).map(i => ({ command: i.command, result: i.result, verified: i.verified ?? null })),
      verdict: h?.verdict ?? null, source: String(h?.source ?? 'unknown'), runState: run?.state ?? null,
    };
  });
}

export function checkRows(s: ControlState, events: readonly ReportEvent[], f: ReportFilter = {}): CheckRow[] {
  const out: CheckRow[] = [];
  for (const e of events) {
    if (!matchesFilter(s, e, f)) continue;
    const x = d(e);
    if (e.type === 'work_item.evidence_added' && ['test', 'command', 'merge'].includes(x.evidence?.kind)) {
      const ev = x.evidence;
      out.push({ evidence: evidenceRef(e, { sha: ev.sha, command: ev.command, result: ev.exitCode != null ? `exit ${ev.exitCode}` : ev.summary }), kind: ev.kind, summary: String(ev.summary ?? ''), command: ev.command ?? null, exitCode: ev.exitCode ?? null, passed: ev.counts?.passed ?? null, failed: ev.counts?.failed ?? null, verified: Boolean(ev.verified), issue: issueKey(s, e.workItemId), sha: ev.sha ?? null });
    } else if (e.type === 'run.tests') {
      out.push({ evidence: evidenceRef(e, { command: x.command, result: `${x.counts?.passed ?? 0} passed, ${x.counts?.failed ?? 0} failed` }), kind: 'test', summary: `${x.counts?.passed ?? 0} passed, ${x.counts?.failed ?? 0} failed`, command: x.command ?? null, exitCode: null, passed: x.counts?.passed ?? 0, failed: x.counts?.failed ?? 0, verified: x.source === 'daemon', issue: issueKey(s, e.workItemId), sha: null });
    }
  }
  return out.sort((a, b) => b.evidence.seq - a.evidence.seq);
}

export function mergeRows(s: ControlState, events: readonly ReportEvent[], f: ReportFilter = {}): MergeRow[] {
  const rows = new Map<string, MergeRow>();
  for (const e of events) {
    if (!matchesFilter(s, e, f)) continue;
    const x = d(e);
    if (e.type === 'merge.completed' && x.merge) {
      const m = x.merge;
      rows.set(m.id, { evidence: [evidenceRef(e, { sha: m.mergeSha })], mergeSha: m.mergeSha, sourceSha: m.sourceSha, sourceBranch: m.sourceBranch, target: m.target, at: e.ts, postChecks: m.postChecks?.status ?? 'none', issue: issueKey(s, e.workItemId) });
    } else if (e.type === 'merge.post_checks') {
      const row = rows.get(x.mergeId);
      if (row) { row.postChecks = x.status; row.evidence.push(evidenceRef(e)); }
    }
  }
  return [...rows.values()].sort((a, b) => b.evidence[0].seq - a.evidence[0].seq);
}

export function pendingItems(s: ControlState, now: number, f: ReportFilter = {}): PendingItem[] {
  const out: PendingItem[] = [];
  const mins = (iso: string) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  const keep = (workItemId: string | null | undefined, agentId?: string | null) => (!f.issue || workItemId === f.issue || (workItemId && s.workItems[workItemId]?.key === f.issue)) && (!f.agent || agentId === f.agent);
  for (const dec of Object.values(s.decisions)) if (!dec.answeredAt && !dec.consumedAt && keep(dec.workItemId, null) && !f.agent) out.push({ kind: 'decision', id: dec.id, title: dec.question, urgency: dec.urgency, ageMinutes: mins(dec.createdAt), issue: issueKey(s, dec.workItemId), detail: dec.kind ?? null });
  for (const ap of Object.values(s.approvals)) if (!ap.resolvedAt && keep(ap.workItemId, ap.agentId)) out.push({ kind: 'approval', id: ap.id, title: ap.title, urgency: 'high', ageMinutes: mins(ap.createdAt), issue: issueKey(s, ap.workItemId), detail: `${s.agents[ap.agentId]?.config.name ?? ap.agentId} · ${ap.kind}` });
  for (const al of Object.values(s.alerts)) if (!al.resolvedAt && al.severity !== 'info' && keep(al.workItemId, al.agentId)) out.push({ kind: 'alert', id: al.id, title: al.message, urgency: al.severity === 'critical' ? 'critical' : 'normal', ageMinutes: mins(al.createdAt), issue: issueKey(s, al.workItemId), detail: al.kind });
  const rank = { critical: 0, high: 1, normal: 2, low: 3 } as const;
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || b.ageMinutes - a.ageMinutes);
}

export function buildBrief(s: ControlState, events: readonly ReportEvent[], f: ReportFilter = {}, nowIso: string): Brief {
  const now = Date.parse(nowIso);
  const scoped = events.filter(e => matchesFilter(s, e, f));
  const agents = Object.values(s.agents).filter(a => !f.agent || a.id === f.agent);
  const asg = (id: string | null) => (id ? s.assignments[id] : undefined);
  const itemOf = (id: string | null) => { const a = asg(id); return a ? s.workItems[a.workItemId] : undefined; };
  const wantedItem = (id: string | undefined) => !f.issue || Boolean(id && (id === f.issue || s.workItems[id]?.key === f.issue));
  const releases = buildTimeline(s, scoped.filter(e => isReleaseLike(e.type)), {}, { limit: 20 }).entries;
  const checks = checkRows(s, events, f).slice(0, 40);
  const merges = mergeRows(s, events, f).slice(0, 20);
  const notes: string[] = [];
  if (!checks.length) notes.push('No check results have been recorded for this scope.');
  else if (!checks.some(c => c.verified)) notes.push('Every recorded check result here was reported by an agent; none was run by One Connect.');
  if (!releases.length) notes.push('No release, infrastructure or CI events have been recorded. Absence is not evidence of a healthy release.');
  if (!merges.length) notes.push('No local merges have been recorded for this scope.');
  return {
    generatedAt: nowIso, seq: s.seq, project: s.project?.name ?? null, filter: f,
    now: agents.flatMap(a => {
      const item = itemOf(a.queue.now);
      if (!wantedItem(item?.id)) return [];
      const run = a.activeRunIds.map(id => s.runs[id]).filter(Boolean).at(-1) ?? null;
      return [{ agentId: a.id, agent: a.config.name, status: a.status as string, issue: item ? (item.key ?? item.title) : null, title: item?.title ?? null, run: run ? { id: run.id, state: run.state as string, lastMeaningful: run.lastMeaningful?.summary ?? null } : null }];
    }),
    next: agents.map(a => ({ agentId: a.id, agent: a.config.name, items: a.queue.next.map(id => itemOf(id)).filter((i): i is NonNullable<typeof i> => Boolean(i) && wantedItem(i!.id)).map(i => ({ issue: i.key ?? null, title: i.title })) })).filter(n => n.items.length),
    pending: pendingItems(s, now, f),
    handoffs: handoffCards(s, events, f).slice(0, 30),
    checks, merges, releases, notes,
  };
}

// ---- Morning report and standup ---------------------------------------------------------------

export interface ReportSection { id: string; title: string; claims: Claim[]; empty: string }
export interface MorningReport {
  generatedAt: string;
  window: { from: string; to: string };
  project: string | null;
  filter: ReportFilter;
  sections: ReportSection[];
  caveats: string[];
  evidenceIndex: EvidenceRef[];
  eventCount: number;
}

export function buildMorningReport(s: ControlState, events: readonly ReportEvent[], o: { from: string; to: string; filter?: ReportFilter }, nowIso: string): MorningReport {
  const f: ReportFilter = { ...(o.filter ?? {}), from: o.from, to: o.to };
  const inWin = events.filter(e => matchesFilter(s, e, f));
  const key = (e: ReportEvent) => issueKey(s, e.workItemId);
  const who = (e: ReportEvent) => (e.agentId ? (s.agents[e.agentId]?.config.name ?? e.agentId) : 'One Connect');
  const sections: ReportSection[] = [];
  let n = 0;
  const claim = (text: string, basis: ClaimBasis, verified: boolean | null, evidence: EvidenceRef[]): Claim => ({ id: `c${++n}`, text, basis, verified, evidence });
  const section = (id: string, title: string, empty: string, claims: Claim[]) => sections.push({ id, title, empty, claims });

  const finished: Claim[] = [];
  const handoffByRun = new Map<string, ReportEvent>();
  for (const e of inWin) if (e.type === 'run.handoff' && e.runId) handoffByRun.set(e.runId, e);
  for (const e of inWin) {
    if (e.type !== 'run.ended') continue;
    const x = d(e);
    if (x.exit?.kind !== 'completed') continue;
    finished.push(claim(`${who(e)} finished${key(e) ? ` ${key(e)}` : ''} (run ended normally).`, 'recorded', true, [evidenceRef(e)]));
    const h = e.runId ? handoffByRun.get(e.runId) : null;
    if (h) {
      const hd = d(h).handoff ?? {};
      const refs = [evidenceRef(h, hd.commit?.sha ? { sha: hd.commit.sha } : {})];
      finished.push(claim(`Handoff from ${who(h)} (agent-reported): ${SHORT(String(hd.done ?? ''), 240)}${hd.commit?.sha ? ` Commit ${sha8(hd.commit.sha)}${hd.commit.verified ? ' (commit verified by One Connect)' : ' (commit not verified)'}.` : ''}`, 'agent_reported', hd.commit?.verified ?? null, refs));
    }
  }
  section('finished', 'Finished work', 'No run finished in this window.', finished);

  const merged: Claim[] = [];
  for (const m of mergeRows(s, inWin, {})) {
    merged.push(claim(`${m.issue ? `${m.issue}: ` : ''}${m.sourceBranch} merged into ${m.target} locally as ${sha8(m.mergeSha)} (source ${sha8(m.sourceSha)}). Nothing was pushed. Post-merge checks: ${m.postChecks}.`, 'recorded', true, m.evidence.map(r => ({ ...r, sha: r.sha ?? m.mergeSha }))));
  }
  section('merged', 'Merged to integration', 'No merge was recorded in this window.', merged);

  const checks = checkRows(s, inWin, {});
  const checkClaims: Claim[] = checks.map(c => claim(`${c.issue ? `${c.issue}: ` : ''}${c.kind} ${c.command ? `\`${c.command}\` ` : ''}${c.passed != null ? `${c.passed} passed, ${c.failed ?? 0} failed` : c.exitCode != null ? `exit ${c.exitCode}` : c.summary}${c.verified ? ' (run by One Connect)' : ' (reported by an agent, not verified)'}.`, c.verified ? 'recorded' : 'agent_reported', c.verified, [c.evidence]));
  if (checks.length) checkClaims.unshift(claim(`${checks.length} check result${checks.length === 1 ? '' : 's'} recorded: ${checks.filter(c => c.verified).length} by One Connect, ${checks.filter(c => !c.verified).length} agent-reported; ${checks.filter(c => (c.failed ?? 0) > 0 || (c.exitCode ?? 0) !== 0).length} with failures.`, 'derived', null, checks.slice(0, 20).map(c => c.evidence)));
  section('checks', 'Checks and evidence', 'No check results were recorded in this window. Nothing here implies that tests passed.', checkClaims);

  const trouble: Claim[] = [];
  for (const e of inWin) {
    const x = d(e);
    if (e.type === 'run.ended' && x.exit?.kind && !['completed', 'stopped', 'killed'].includes(x.exit.kind)) trouble.push(claim(`${who(e)}${key(e) ? ` on ${key(e)}` : ''}: run ended with ${x.exit.kind}${x.exit.message ? ` — ${SHORT(String(x.exit.message), 160)}` : ''}.`, 'recorded', true, [evidenceRef(e)]));
    else if (e.type === 'alert.raised' && x.alert?.severity !== 'info') {
      const open = !s.alerts[x.alert.id]?.resolvedAt;
      trouble.push(claim(`${x.alert.kind}: ${SHORT(String(x.alert.message), 200)} (${open ? 'still open' : 'resolved'}).`, 'recorded', true, [evidenceRef(e)]));
    } else if (e.type === 'merge.refused') trouble.push(claim(`Merge refused${key(e) ? ` for ${key(e)}` : ''}: ${SHORT(String(x.reason), 200)}.`, 'recorded', true, [evidenceRef(e)]));
    else if (e.type === 'kill_switch.set' && x.engaged) trouble.push(claim('Kill switch was engaged.', 'recorded', true, [evidenceRef(e)]));
  }
  section('trouble', 'Failures, blocks and alerts', 'No failures or alerts were recorded in this window.', trouble);

  const needs: Claim[] = pendingItems(s, Date.parse(nowIso), o.filter ?? {}).map(p => {
    const ev = inWin.concat(events).find(e => (p.kind === 'decision' && e.type === 'decision.created' && d(e).decision?.id === p.id) || (p.kind === 'approval' && e.type === 'approval.requested' && d(e).approval?.id === p.id) || (p.kind === 'alert' && e.type === 'alert.raised' && d(e).alert?.id === p.id));
    return claim(`${p.kind === 'decision' ? 'Decision' : p.kind === 'approval' ? 'Question' : 'Alert'} waiting ${p.ageMinutes} min${p.issue ? ` on ${p.issue}` : ''}: ${SHORT(p.title, 200)}`, 'recorded', true, ev ? [evidenceRef(ev)] : []);
  });
  section('needs', 'Waiting on you (current)', 'Nothing is waiting on you right now.', needs);

  const answered: Claim[] = [];
  for (const e of inWin) {
    if (e.type !== 'decision.answered') continue;
    const x = d(e);
    answered.push(claim(`You answered “${x.answer}”${x.confirmed ? ' with confirmation' : ''} on ${x.channel}: ${SHORT(s.decisions[x.decisionId]?.question ?? x.decisionId, 160)}`, 'recorded', true, [evidenceRef(e)]));
  }
  section('decisions', 'Decisions you made', 'No Decision was answered in this window.', answered);

  const rel: Claim[] = [];
  for (const e of inWin) if (isReleaseLike(e.type)) { const ds = describeEvent(s, e); if (ds) rel.push(claim(`${ds.label}: ${ds.summary}`, 'recorded', null, [evidenceRef(e, ds.sha ? { sha: ds.sha } : {})])); }
  section('release', 'Release and infrastructure events', 'No release, deploy or infrastructure event was recorded. This report makes no claim about release health.', rel);

  const index = new Map<number, EvidenceRef>();
  for (const sec of sections) for (const c of sec.claims) for (const r of c.evidence) index.set(r.seq, { ...index.get(r.seq), ...r });
  const caveats = ['Generated from the append-only event log with no model call. Claims marked agent-reported were not verified by One Connect.'];
  if (!checks.some(c => c.verified)) caveats.push('No check was run by One Connect in this window; do not read this report as “tests passed”.');
  if (!rel.length) caveats.push('No deploy or release evidence exists in this window.');
  return { generatedAt: nowIso, window: { from: o.from, to: o.to }, project: s.project?.name ?? null, filter: o.filter ?? {}, sections, caveats, evidenceIndex: [...index.values()].sort((a, b) => a.seq - b.seq), eventCount: inWin.length };
}

/** A shareable standup. Each line ends with the event numbers (and SHAs) that back it. */
export function renderStandupMarkdown(r: MorningReport, brief?: Brief): string {
  const ref = (c: Claim) => (c.evidence.length ? ` ${c.evidence.slice(0, 4).map(e => `[#${e.seq}${e.sha ? ` ${sha8(e.sha)}` : ''}]`).join('')}` : '');
  const tag = (c: Claim) => (c.basis === 'agent_reported' ? ' _(agent-reported, unverified)_' : c.basis === 'derived' ? ' _(counted from events)_' : '');
  const lines: string[] = [`# Standup — ${r.project ?? 'project'}`, '', `Window: ${r.window.from} to ${r.window.to}. Generated ${r.generatedAt} from ${r.eventCount} recorded events.`, ''];
  const pick = (id: string) => r.sections.find(sec => sec.id === id)!;
  const emit = (title: string, secs: ReportSection[]) => {
    lines.push(`## ${title}`);
    for (const sec of secs) {
      if (!sec.claims.length) { lines.push(`- _${sec.empty}_`); continue; }
      for (const c of sec.claims) lines.push(`- ${c.text}${tag(c)}${ref(c)}`);
    }
    lines.push('');
  };
  emit('Done', [pick('finished'), pick('merged')]);
  emit('Checks', [pick('checks')]);
  if (brief) {
    lines.push('## Now and next');
    const nowRows = brief.now.filter(n => n.issue);
    if (!nowRows.length) lines.push('- _No agent has work in Now._');
    for (const n of nowRows) lines.push(`- Now — ${n.agent}: ${n.issue} ${n.title ?? ''} (${n.status})`);
    for (const n of brief.next) for (const i of n.items) lines.push(`- Next — ${n.agent}: ${i.issue ?? ''} ${i.title}`);
    lines.push('');
  }
  emit('Blocked and waiting on you', [pick('trouble'), pick('needs')]);
  emit('Release and infrastructure', [pick('release')]);
  lines.push('## Caveats', ...r.caveats.map(c => `- ${c}`), '', '## Evidence index', ...r.evidenceIndex.map(e => `- #${e.seq} ${e.type} ${e.ts}${e.sha ? ` ${e.sha}` : ''}${e.command ? ` \`${e.command}\`` : ''}`), '');
  return lines.join('\n');
}
