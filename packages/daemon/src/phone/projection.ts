// SPDX-License-Identifier: Apache-2.0
// Phone status projections never grant management/configuration or credential access.
import { emptyState, remoteDecisionAccess, type ControlState, type Decision, type EventEnvelope, type RemoteScope, type ReportEvent } from '@acc/core';
import type { Daemon } from '../daemon.ts';

const keep = <T extends object>(value: T, keys: readonly string[]): T => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => keys.includes(key))) as T;
const scrub = <T>(d: Daemon, value: T): T => JSON.parse(d.redactText(JSON.stringify(value))) as T;
export function phoneDecisionVisible(d: Daemon, decision: Decision, scopes: readonly RemoteScope[]): boolean {
  const target = d.remote.isRemoteDecision(decision.id) ? { kind: 'remote' as const } : d.notifications.isEndpointDecision(decision.id) ? { kind: 'notification' as const } : decision;
  return remoteDecisionAccess(target, scopes, d.notifications.isDeliveryDecision(decision.id)).allow;
}
export function phoneState(d: Daemon, scopes: readonly RemoteScope[]): ControlState {
  const s = structuredClone(d.state), out = emptyState();
  out.seq = s.seq; out.startedAt = s.startedAt;
  out.project = s.project ? { ...keep(s.project, ['name', 'integration_branch', 'protected_branches']), repo: '', checks: {} } : null;
  out.tracker = s.tracker ? keep(s.tracker, ['type']) : null;
  out.agents = Object.fromEntries(Object.entries(s.agents).map(([id, a]) => [id, {
    ...keep(a, ['id', 'status', 'auth', 'billing', 'models', 'usage', 'limitedUntil', 'queue', 'activeRunIds', 'idleSince', 'idleMsTotal', 'idleWithWorkSince', 'pausedReason', 'probedAt']), config: keep(a.config, ['id', 'name', 'role', 'adapter', 'provider', 'model', 'model_family', 'effort', 'billing', 'metered_opt_in', 'on_demand', 'concurrency', 'budget_usd_per_day', 'enabled']), auth: keep(a.auth, ['state', 'tier']), billing: keep(a.billing, ['mode', 'source', 'overage', 'notes']), usage: { ...keep(a.usage, ['status', 'checkedAt', 'source']), windows: a.usage.windows.map(w => keep(w, ['name', 'usedPercent', 'resetsAt', 'windowMinutes'])) }, models: { ...keep(a.models, ['current', 'newest', 'checkedAt']), available: a.models.available.map(m => keep(m, ['id', 'label', 'pricing', 'tools', 'priority', 'efforts', 'hidden', 'upgrade'])) }, queue: keep(a.queue, ['now', 'next']), binary: null, binaryCandidates: [],
  }]));
  out.workItems = Object.fromEntries(Object.entries(s.workItems).map(([id, w]) => [id, {
    ...keep(w, ['id', 'key', 'title', 'labels', 'priority', 'parentKey', 'blockedBy', 'state', 'blockedOn', 'resumeTo', 'ownerAgentId', 'assignmentIds', 'runIds', 'branches', 'requiresProductionVerification', 'stage', 'sprint', 'workType', 'trackerStatus', 'createdAt', 'updatedAt']),
    trackerId: null, url: null, description: '', acceptance: [], sync: { status: w.sync.status, lastError: null, at: w.sync.at },
    evidence: w.evidence.map(e => ({ ...keep(e, ['id', 'kind', 'counts', 'sha', 'branch', 'runId', 'env', 'verified', 'at', 'exitCode']), summary: scopes.includes('transcript') ? e.summary : `${e.kind} recorded`, ...(scopes.includes('transcript') && e.command ? { command: e.command } : {}) })),
  }]));
  out.assignments = Object.fromEntries(Object.entries(s.assignments).map(([id, a]) => [id, {
    ...keep(a, ['id', 'workItemId', 'agentId', 'position', 'branch', 'baseRef', 'baseSha', 'model', 'effort', 'createdAt', 'dispatchedAt', 'stage', 'kind', 'workflowId', 'taskId', 'review']),
    scope: '', prompt: '', promptEdited: false, allowedPaths: [], requiredChecks: [], askHumanIf: [], handoffFormat: '', worktree: null, preflight: null,
  }]));
  out.runs = Object.fromEntries(Object.entries(s.runs).map(([id, r]) => [id, {
    ...keep(r, ['id', 'assignmentId', 'workItemId', 'agentId', 'adapter', 'model', 'resolvedModel', 'effort', 'attempt', 'retryOf', 'state', 'createdAt', 'startedAt', 'endedAt', 'lastEventAt', 'lastMeaningful', 'eventCount', 'usage', 'exit', 'handoff', 'filesChanged', 'outOfScope', 'tests', 'children']), pid: null, sessionId: null, logDir: null,
    ...(!scopes.includes('transcript') ? { lastMeaningful: null, handoff: null, filesChanged: [], outOfScope: [], tests: null, children: [], exit: r.exit ? { ...keep(r.exit, ['kind', 'exitCode', 'signal', 'resetsAt']), message: '' } : null } : {}),
  }]));
  out.approvals = scopes.includes('decisions') ? s.approvals : {};
  out.alerts = s.alerts;
  out.decisions = Object.fromEntries(Object.entries(s.decisions).filter(([, dec]) => phoneDecisionVisible(d, dec, scopes)).map(([id, dec]) => [id, phoneDecision(d, dec)]));
  out.killSwitch = s.killSwitch;
  out.merges = Object.fromEntries(Object.entries(s.merges).map(([id, m]) => [id, { ...keep(m, ['id', 'workItemId', 'decisionId', 'reviewId', 'sourceBranch', 'sourceSha', 'target', 'targetShaBefore', 'mergeSha', 'method', 'at']), postChecks: keep(m.postChecks, ['status', 'evidenceIds', 'at']) }]));
  // Context, connectors, releases' executable settings, workflow/skill configuration and all
  // future management fields remain at emptyState defaults. Reports provide recorded summaries.
  return scrub(d, out);
}

/** Decision audit and transcript batches only. General control updates use projected snapshots. */
export function phoneEvents(d: Daemon, events: readonly EventEnvelope[], scopes: readonly RemoteScope[]): EventEnvelope[] {
  return events.flatMap(e => {
    if (e.kind === 'transcript') return scopes.includes('transcript') ? [scrub(d, e)] : [];
    if (['notification.emitted', 'notification.delivered', 'notification.acked'].includes(e.type)) return scopes.includes('read') ? [scrub(d, e)] : [];
    const data = e.data as { decisionId?: string; decision?: Decision };
    const id = data.decision?.id ?? data.decisionId;
    const dec = id ? d.state.decisions[id] : undefined;
    if (!['decision.created', 'decision.recommended', 'decision.confirmation_requested', 'decision.answered', 'decision.consumed', 'decision.advisory', 'decision.advisory_invalidated'].includes(e.type) || !dec || !phoneDecisionVisible(d, dec, scopes)) return [];
    return [scrub(d, data.decision ? { ...e, data: { decision: phoneDecision(d, data.decision) } } as EventEnvelope : e)];
  });
}

/** Preserve transcript and browser-inbox events without replaying configuration into the phone. */
export function phoneMessages(d: Daemon, message: unknown, scopes: readonly RemoteScope[]): unknown[] {
  if (!message || typeof message !== 'object') return [];
  const m = message as { type: string; events?: EventEnvelope[]; [key: string]: unknown };
  const snapshot = () => ({ type: 'snapshot', seq: d.state.seq, state: phoneState(d, scopes) });
  if (m.type === 'snapshot' || m.type === 'patch') return [snapshot()];
  if (m.type === 'events') {
    const events = phoneEvents(d, m.events ?? [], scopes);
    // Restore the latest projected seq/state after older transcript events update the reducer.
    return [...(events.length ? [{ type: 'events', events }] : []), snapshot()];
  }
  if (m.type === 'run_events') return scopes.includes('transcript') ? [{ type: 'run_events', runId: m.runId, more: m.more === true, events: phoneHistory(d, m.events ?? [], scopes) }] : [];
  if (m.type === 'live') return scopes.includes('transcript') ? [scrub(d, keep(m, ['type', 'runId', 'agentId', 'role', 'text', 'at']))] : [];
  return m.type === 'denied' ? [scrub(d, m)] : [];
}

/** Explicit fields: future executor/configuration additions do not become phone state. */
export function phoneDecision(d: Daemon, dec: Decision): Decision {
  return scrub(d, keep(dec, ['id', 'question', 'options', 'recommendation', 'evidenceLinks', 'urgency', 'irreversible', 'answer', 'answeredAt', 'channel', 'createdAt', 'kind', 'workItemId', 'risk', 'action', 'evidence', 'confirmOptions', 'recommendedBy', 'rationale', 'answeredBy', 'confirmedAt', 'consumedAt', 'outcome', 'expiresAt', 'advisory']));
}

/** Keep a harmless cursor for hidden history rows so paging cannot stop early or repeat page 1. */
export function phoneHistory(d: Daemon, events: readonly EventEnvelope[], scopes: readonly RemoteScope[]): EventEnvelope[] {
  return events.map(e => phoneEvents(d, [e], scopes)[0] ?? ({ seq: e.seq, id: e.id, ts: e.ts, type: 'phone.cursor', kind: 'control', actor: { type: 'system', id: 'phone' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data: {} } as unknown as EventEnvelope));
}

/** Reports share the phone projection, never the Mac's unrestricted state or event log. */
export function phoneReportEvents(d: Daemon, events: readonly ReportEvent[], scopes: readonly RemoteScope[]): ReportEvent[] {
  const state = phoneState(d, scopes), transcript = scopes.includes('transcript');
  return events.flatMap(e => {
    const x = (e.data ?? {}) as Record<string, any>;
    if (e.type.startsWith('decision.')) return phoneEvents(d, [e as EventEnvelope], scopes);
    if (e.type.startsWith('approval.')) return scopes.includes('decisions') ? [scrub(d, e)] : [];
    if (['run.handoff', 'run.tests', 't.commit', 't.test_result', 't.error'].includes(e.type)) return transcript ? [scrub(d, e)] : [];
    let data: unknown;
    switch (e.type) {
      case 'work_item.created': data = { item: state.workItems[x.item?.id] }; break;
      case 'work_item.evidence_added': data = { evidence: state.workItems[e.workItemId ?? '']?.evidence.find(v => v.id === x.evidence?.id) }; break;
      case 'run.created': data = { run: state.runs[x.run?.id] }; break;
      case 'run.ended': data = { exit: transcript ? x.exit : x.exit ? { ...keep(x.exit, ['kind', 'exitCode', 'signal', 'resetsAt']), message: '' } : null }; break;
      case 'daemon.started': data = {}; break;
      case 'merge.completed': data = { merge: state.merges[x.merge?.id] }; break;
      case 'work_item.transitioned': case 'alert.raised': case 'alert.resolved': case 'kill_switch.set':
      case 'merge.post_checks': case 'merge.refused': case 'review.recorded': case 'agent.limited': case 'agent.unlimited':
      case 'agent.paused': case 'agent.resumed': case 'workflow.status': case 'notification.emitted': data = x; break;
      default:
        if (!/^(release|deploy|infra|ci|code_host)\./.test(e.type)) return [];
        // Report builders use only recorded statuses; no executable plan/configuration crosses here.
        data = x.plan ? { plan: { ...keep(x.plan, ['id', 'name', 'status', 'sha']), steps: (x.plan.steps ?? []).map((v: object) => keep(v, ['status'])) } }
          : x.health ? { health: Object.fromEntries(Object.entries(x.health).map(([k, v]) => [k, keep(v as object, ['state'])])) }
          : x.snapshot ? { snapshot: { sha: x.snapshot.sha, checks: (x.snapshot.checks ?? []).map((v: object) => keep(v, ['status', 'conclusion', 'state'])) } }
          : keep(x, ['status', 'state', 'result', 'ok', 'success', 'sha', 'commit']);
    }
    return [scrub(d, { ...e, data })];
  });
}
