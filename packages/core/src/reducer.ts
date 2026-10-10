// SPDX-License-Identifier: Apache-2.0
// The one reducer. The daemon builds its projections with it and the UI stays live with it,
// so the two can never disagree. Pure: time comes from event timestamps, never Date.now().
import type { AgentState, AgentStatus, ControlState, Run, RunState } from './entities.ts';
import { emptyState } from './entities.ts';
import type { EventEnvelope } from './events.ts';
import { meaningfulSummary } from './events.ts';
import { applyLibraryEvent } from './libraryReducer.ts';
import { applyDesignStudioEvent } from './designStudio.ts';

const ACTIVE_RUN: ReadonlySet<RunState> = new Set(['queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input', 'stalled']);
export const isActiveRun = (r: Pick<Run, 'state'>): boolean => ACTIVE_RUN.has(r.state);

function put<T>(rec: Record<string, T>, id: string, value: T): Record<string, T> {
  return { ...rec, [id]: value };
}

function patchIn<T>(rec: Record<string, T>, id: string | null | undefined, fn: (v: T) => T): Record<string, T> {
  if (!id) return rec;
  const cur = rec[id];
  if (cur === undefined) return rec;
  return { ...rec, [id]: fn(cur) };
}

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : 0);

export function newAgentState(config: AgentState['config']): AgentState {
  return {
    id: config.id,
    config,
    status: 'idle',
    auth: { state: 'unknown' },
    billing: { mode: 'unknown', source: 'not probed yet', overage: 'unknown' },
    binary: null,
    binaryCandidates: [],
    models: { available: [], current: null, newest: null, checkedAt: null },
    usage: { windows: [], status: 'unknown', checkedAt: '', source: 'not probed yet' },
    limitedUntil: null,
    queue: { now: null, next: [] },
    activeRunIds: [],
    idleSince: null,
    idleMsTotal: 0,
    idleWithWorkSince: null,
    pausedReason: null,
    probedAt: null,
  };
}

export function deriveAgentStatus(s: ControlState, a: AgentState): AgentStatus {
  const runs = a.activeRunIds.map((id) => s.runs[id]).filter(Boolean);
  if (runs.some((r) => r.state === 'waiting-for-approval' || r.state === 'waiting-for-input')) return 'waiting';
  if (runs.some((r) => r.state === 'stalled')) return 'stalled';
  if (runs.some((r) => r.state === 'running')) return 'running';
  if (runs.some((r) => r.state === 'starting' || r.state === 'queued')) return 'starting';
  if (a.config.enabled === false) return 'offline';
  if (a.limitedUntil) return 'limited';
  if (a.pausedReason) return 'paused';
  if (a.config.adapter !== 'relay' && (a.auth.state === 'expired' || a.auth.state === 'not_installed')) return 'offline';
  const nowAssignment = a.queue.now ? s.assignments[a.queue.now] : null;
  if (nowAssignment) {
    const lastRun = s.workItems[nowAssignment.workItemId]?.runIds.map((id) => s.runs[id]).filter((r) => r && r.assignmentId === nowAssignment.id).at(-1);
    if (lastRun && (lastRun.state === 'failed' || lastRun.state === 'orphaned')) return 'failed';
  }
  return 'idle';
}

/** Re-derive status and idle accounting for one agent after any change that could affect it. */
function refreshAgent(s: ControlState, agentId: string | null | undefined, ts: string): ControlState {
  if (!agentId || !s.agents[agentId]) return s;
  const a = s.agents[agentId];
  const activeRunIds = Object.values(s.runs)
    .filter((r) => r.agentId === agentId && isActiveRun(r))
    .map((r) => r.id);
  const withRuns = { ...a, activeRunIds };
  const status = deriveAgentStatus(s, withRuns);
  const idle = status === 'idle' || status === 'failed' || status === 'paused' || status === 'limited';
  let { idleSince, idleMsTotal, idleWithWorkSince } = a;
  if (idle && !idleSince) idleSince = ts;
  if (!idle && idleSince) {
    idleMsTotal += Math.max(0, ms(ts) - ms(idleSince));
    idleSince = null;
  }
  const hasWork = a.queue.next.length > 0 || (a.queue.now !== null && activeRunIds.length === 0);
  if (idle && hasWork && !idleWithWorkSince) idleWithWorkSince = ts;
  if (!(idle && hasWork)) idleWithWorkSince = null;
  return { ...s, agents: put(s.agents, agentId, { ...withRuns, status, idleSince, idleMsTotal, idleWithWorkSince }) };
}

export function applyEvent(state: ControlState, e: EventEnvelope): ControlState {
  let s: ControlState = { ...state, teamMessages: state.teamMessages ?? {}, workflows: state.workflows ?? {}, reviews: state.reviews ?? {}, merges: state.merges ?? {}, releases: state.releases ?? {}, codeHost: state.codeHost ?? null, infra: state.infra ?? null, seq: Math.max(state.seq, e.seq) };
  const ts = e.ts;

  switch (e.type) {
    case 'team.message_sent':
      s.teamMessages = put(s.teamMessages, e.data.message.id, { ...e.data.message, seq: e.seq });
      break;
    case 'team.message_acknowledged':
      s.teamMessages = patchIn(s.teamMessages, e.data.messageId, m => ({ ...m, acknowledgedBy: { ...m.acknowledgedBy, [e.data.recipientId]: ts } }));
      break;
    case 'team.message_notified':
      s.teamMessages = patchIn(s.teamMessages, e.data.messageId, m => ({ ...m, notifiedRuns: { ...m.notifiedRuns, [e.data.targetRunId]: ts } }));
      break;
    case 'daemon.started':
      s.startedAt = ts;
      break;
    case 'config.loaded':
      s.project = e.data.project;
      s.tracker = e.data.tracker;
      s.policies = e.data.policies;
      break;
    case 'tracker.live_enabled':
      break;
    case 'agent.registered': {
      const cur = s.agents[e.data.config.id];
      const fresh=newAgentState(e.data.config);
      s.agents = put(s.agents, e.data.config.id, cur ? { ...cur, config:e.data.config,auth:fresh.auth,billing:fresh.billing,binary:null,binaryCandidates:[],models:fresh.models,probedAt:null } : { ...fresh, idleSince: ts });
      s = refreshAgent(s, e.data.config.id, ts);
      break;
    }
    case 'design.system_saved':
      s.design=e.data.revision;
      break;
    case 'design.studio':
      s.designStudio = applyDesignStudioEvent(s.designStudio, e.data);
      break;
    case 'skill.draft_saved': case 'skill.version_published': case 'skill.disabled': case 'skill.exported':
    case 'connector.saved': case 'connector.disabled': case 'connector.activation_requested': case 'connector.activated':
    case 'connector.activation_denied': case 'connector.checked': case 'connector.used':
    case 'connector.tool_requested': case 'connector.tool_denied': case 'connector.tool_execution_started': case 'connector.tool_executed':
    case 'design.mock_captured': case 'design.mock_exception': case 'design.mock_reviewed': case 'design.mock_evidence':
      s = applyLibraryEvent(s, e);
      break;
    case 'agent.removed': {
      const { [e.agentId ?? '']: _gone, ...rest } = s.agents;
      s.agents = rest;
      break;
    }
    case 'agent.probed':
      s.agents = patchIn(s.agents, e.agentId, (a) => ({
        ...a,
        auth: e.data.auth,
        billing: e.data.billing,
        binary: e.data.binary,
        binaryCandidates: e.data.binaryCandidates,
        models: { available: e.data.models, newest: e.data.newest, current: a.models.current, checkedAt: ts },
        usage: e.data.usage ?? a.usage,
        probedAt: ts,
      }));
      s = refreshAgent(s, e.agentId, ts);
      break;
    case 'agent.usage':
      s.agents = patchIn(s.agents, e.agentId, (a) => ({ ...a, usage: e.data.usage }));
      break;
    case 'agent.limited':
      s.agents = patchIn(s.agents, e.agentId, (a) => ({ ...a, limitedUntil: e.data.until ?? 'unknown' }));
      s = refreshAgent(s, e.agentId, ts);
      break;
    case 'agent.unlimited':
      s.agents = patchIn(s.agents, e.agentId, (a) => ({ ...a, limitedUntil: null }));
      s = refreshAgent(s, e.agentId, ts);
      break;
    case 'agent.paused':
      s.agents = patchIn(s.agents, e.agentId, (a) => ({ ...a, pausedReason: e.data.reason }));
      s = refreshAgent(s, e.agentId, ts);
      break;
    case 'agent.resumed':
      s.agents = patchIn(s.agents, e.agentId, (a) => ({ ...a, pausedReason: null }));
      s = refreshAgent(s, e.agentId, ts);
      break;
    case 'agent.model_changed':
      s.agents = patchIn(s.agents, e.agentId, (a) => ({ ...a, config: { ...a.config, model: e.data.model }, models: { ...a.models, current: e.data.model } }));
      break;
    case 'agent.queue_set':
      s.agents = patchIn(s.agents, e.agentId, (a) => ({ ...a, queue: { now: e.data.now, next: [...e.data.next] } }));
      s = refreshAgent(s, e.agentId, ts);
      break;

    case 'work_item.created':
      s.workItems = put(s.workItems, e.data.item.id, e.data.item);
      break;
    case 'work_item.updated':
      s.workItems = patchIn(s.workItems, e.workItemId, (w) => ({ ...w, ...e.data.patch, updatedAt: ts }));
      break;
    case 'work_item.transitioned':
      s.workItems = patchIn(s.workItems, e.workItemId, (w) => ({
        ...w,
        state: e.data.to,
        blockedOn: e.data.to === 'blocked' ? (e.data.blockedOn ?? { kind: 'human', reason: e.data.reason }) : null,
        resumeTo: e.data.to === 'blocked' ? e.data.from : null,
        updatedAt: ts,
      }));
      break;
    case 'work_item.evidence_added':
      s.workItems = patchIn(s.workItems, e.workItemId, (w) => ({ ...w, evidence: [...w.evidence, e.data.evidence], updatedAt: ts }));
      break;
    case 'work_item.reviewed':
      s.workItems = patchIn(s.workItems, e.workItemId, (w) => ({ ...w, reviews: [...(w.reviews ?? []), e.data.review], updatedAt: ts }));
      break;
    case 'work_item.synced':
      s.workItems = patchIn(s.workItems, e.workItemId, (w) => ({
        ...w,
        key: e.data.key ?? w.key,
        trackerId: e.data.trackerId ?? w.trackerId,
        url: e.data.url === undefined ? w.url : e.data.url,
        sync: { status: e.data.status, lastError: e.data.error ?? null, at: ts },
      }));
      break;

    case 'assignment.created': {
      const a = e.data.assignment;
      s.assignments = put(s.assignments, a.id, a);
      // A reviewer works on the issue but never becomes its owner.
      s.workItems = patchIn(s.workItems, a.workItemId, (w) => ({ ...w, assignmentIds: [...w.assignmentIds, a.id], ownerAgentId: a.kind === 'review' ? w.ownerAgentId : a.agentId, updatedAt: ts }));
      break;
    }
    case 'assignment.updated':
      s.assignments = patchIn(s.assignments, e.assignmentId, (a) => ({ ...a, ...e.data.patch }));
      if (e.data.patch.agentId) {
        const a = s.assignments[e.assignmentId ?? ''];
        if (a && a.kind !== 'review') s.workItems = patchIn(s.workItems, a.workItemId, (w) => ({ ...w, ownerAgentId: e.data.patch.agentId ?? w.ownerAgentId }));
      }
      break;
    case 'assignment.positioned':
      s.assignments = patchIn(s.assignments, e.assignmentId, (a) => ({
        ...a,
        position: e.data.position,
        dispatchedAt: e.data.position === 'now' && !a.dispatchedAt ? ts : a.dispatchedAt,
      }));
      break;
    case 'assignment.worktree_ready':
      s.assignments = patchIn(s.assignments, e.assignmentId, (a) => ({ ...a, worktree: e.data.worktree, branch: e.data.branch, baseSha: e.data.baseSha }));
      s.workItems = patchIn(s.workItems, e.workItemId, (w) => ({ ...w, branches: w.branches.includes(e.data.branch) ? w.branches : [...w.branches, e.data.branch] }));
      break;

    case 'run.created': {
      const r = e.data.run;
      s.runs = put(s.runs, r.id, r);
      s.workItems = patchIn(s.workItems, r.workItemId, (w) => ({ ...w, runIds: [...w.runIds, r.id] }));
      s = refreshAgent(s, r.agentId, ts);
      break;
    }
    case 'run.started':
      s.runs = patchIn(s.runs, e.runId, (r) => ({ ...r, pid: e.data.pid, startedAt: r.startedAt ?? ts, state: r.state === 'queued' ? 'starting' : r.state, lastEventAt: ts }));
      s = refreshAgent(s, e.agentId, ts);
      break;
    case 'run.session':
      s.runs = patchIn(s.runs, e.runId, (r) => ({ ...r, sessionId: e.data.sessionId ?? r.sessionId, resolvedModel: e.data.model ?? r.resolvedModel }));
      if (e.data.model) s.agents = patchIn(s.agents, e.agentId, (a) => ({ ...a, models: { ...a.models, current: e.data.model } }));
      break;
    case 'run.child':
      s.runs = patchIn(s.runs, e.runId, (r) => {
        const kids = r.children ?? [];
        const i = kids.findIndex((k) => k.sessionId === e.data.sessionId);
        const done = e.data.state !== 'running';
        const next = { sessionId: e.data.sessionId, parentSessionId: e.data.parentSessionId, title: e.data.title || kids[i]?.title || 'child session', state: e.data.state, startedAt: kids[i]?.startedAt ?? ts, endedAt: done ? ts : null, error: e.data.error ?? null };
        return { ...r, children: i < 0 ? [...kids, next].slice(-50) : kids.map((k, j) => (j === i ? next : k)) };
      });
      break;
    case 'run.state':
      s.runs = patchIn(s.runs, e.runId, (r) => ({ ...r, state: e.data.state }));
      s = refreshAgent(s, e.agentId, ts);
      break;
    case 'run.ended': {
      const failed = e.data.exit.kind !== 'completed';
      s.runs = patchIn(s.runs, e.runId, (r) => ({
        ...r,
        state: e.data.state ?? (e.data.exit.kind === 'orphaned' ? 'orphaned' : failed ? 'failed' : 'finished'),
        exit: e.data.exit,
        endedAt: ts,
      }));
      // Any approvals left open on a dead run can never be answered by the agent.
      for (const ap of Object.values(s.approvals)) {
        if (ap.runId === e.runId && !ap.resolvedAt) {
          s.approvals = put(s.approvals, ap.id, { ...ap, resolvedAt: ts, decision: 'expired', by: 'system', channel: 'run-ended' });
        }
      }
      s = refreshAgent(s, e.agentId, ts);
      break;
    }
    case 'run.handoff':
      s.runs = patchIn(s.runs, e.runId, (r) => ({ ...r, handoff: e.data.handoff }));
      break;
    case 'run.usage':
      s.runs = patchIn(s.runs, e.runId, (r) => ({
        ...r,
        usage: {
          inputTokens: r.usage.inputTokens + e.data.inputTokens,
          outputTokens: r.usage.outputTokens + e.data.outputTokens,
          ...(e.data.costUsd !== undefined || r.usage.costUsd !== undefined ? { costUsd: (r.usage.costUsd ?? 0) + (e.data.costUsd ?? 0) } : {}),
        },
      }));
      break;
    case 'run.files_changed':
      s.runs = patchIn(s.runs, e.runId, (r) => ({ ...r, filesChanged: e.data.files, outOfScope: e.data.outOfScope }));
      break;
    case 'run.tests':
      s.runs = patchIn(s.runs, e.runId, (r) => ({ ...r, tests: { ...e.data.counts, command: e.data.command, at: ts, source: e.data.source } }));
      break;

    case 'approval.requested': {
      const ap = e.data.approval;
      s.approvals = put(s.approvals, ap.id, ap);
      s.runs = patchIn(s.runs, ap.runId, (r) => (isActiveRun(r) ? { ...r, state: 'waiting-for-approval' } : r));
      s = refreshAgent(s, ap.agentId, ts);
      break;
    }
    case 'approval.resolved': {
      const ap = s.approvals[e.data.approvalId];
      if (ap) {
        s.approvals = put(s.approvals, ap.id, { ...ap, resolvedAt: ts, decision: e.data.decision, by: e.data.by, channel: e.data.channel });
        const stillPending = Object.values(s.approvals).some((x) => x.runId === ap.runId && !x.resolvedAt);
        if (!stillPending) s.runs = patchIn(s.runs, ap.runId, (r) => (r.state === 'waiting-for-approval' ? { ...r, state: 'running' } : r));
        s = refreshAgent(s, ap.agentId, ts);
      }
      break;
    }

    case 'alert.raised':
      s.alerts = put(s.alerts, e.data.alert.id, e.data.alert);
      break;
    case 'alert.resolved': {
      s.alerts = patchIn(s.alerts, e.data.alertId, (a) => ({ ...a, resolvedAt: ts, resolution: e.data.resolution }));
      break;
    }
    case 'rule.toggled':
      s.rules = { ...s.rules, [e.data.rule]: e.data.enabled };
      break;
    case 'decision.created':
      s.decisions = { ...s.decisions, [e.data.decision.id]: e.data.decision };
      break;
    case 'decision.answered':
      s.decisions = patchIn(s.decisions, e.data.decisionId, d => ({ ...d, answer: e.data.answer, answeredAt: ts, channel: e.data.channel, answeredBy: e.actor, confirmedAt: e.data.confirmed ? ts : (d.confirmedAt ?? null) }));
      break;
    case 'decision.recommended':
      s.decisions = patchIn(s.decisions, e.data.decisionId, d => ({ ...d, recommendation: e.data.recommendation, rationale: e.data.rationale, recommendedBy: e.actor }));
      break;
    case 'decision.advisory':
      s.decisions = patchIn(s.decisions, e.data.decisionId, d => ({ ...d, advisory: e.data.advisory }));
      break;
    case 'decision.advisory_invalidated':
      s.decisions = patchIn(s.decisions, e.data.decisionId, d => (d.advisory ? { ...d, advisory: { ...d.advisory, stale: true, staleReason: e.data.reason, staleAt: ts } } : d));
      break;
    case 'decision.confirmation_requested':
      s.decisions = patchIn(s.decisions, e.data.decisionId, d => ({ ...d, expiresAt: e.data.expiresAt }));
      break;
    case 'decision.consumed':
      s.decisions = patchIn(s.decisions, e.data.decisionId, d => ({ ...d, consumedAt: ts, outcome: e.data.outcome }));
      break;
    case 'workflow_link.saved':
      s.workflowLinks = put(s.workflowLinks ?? {}, e.data.link.id, e.data.link);
      break;
    case 'workflow.saved':
      s.workflows = put(s.workflows ?? {}, e.data.workflow.id, e.data.workflow);
      break;
    case 'workflow.status':
      s.workflows = patchIn(s.workflows ?? {}, e.data.workflowId, (w) => ({
        ...w,
        status: e.data.status,
        statusReason: e.data.reason,
        updatedAt: ts,
        startedAt: w.startedAt ?? (e.data.status === 'running' ? ts : null),
        endedAt: ['completed', 'failed', 'canceled'].includes(e.data.status) ? ts : null,
      }));
      break;
    case 'workflow.task_updated':
      s.workflows = patchIn(s.workflows ?? {}, e.data.workflowId, (w) => {
        const cur = w.tasks[e.data.taskId];
        if (!cur) return w;
        return { ...w, updatedAt: ts, tasks: { ...w.tasks, [e.data.taskId]: { ...cur, ...e.data.patch, updatedAt: ts } } };
      });
      break;
    case 'review.recorded':
      s.reviews = put(s.reviews ?? {}, e.data.review.id, e.data.review);
      break;
    case 'review.invalidated':
      s.reviews = patchIn(s.reviews ?? {}, e.data.reviewId, (r) => (r.staleAt ? r : { ...r, staleAt: ts, staleReason: e.data.reason }));
      break;
    case 'review.finding_linked':
      s.reviews = patchIn(s.reviews ?? {}, e.data.reviewId, (r) => ({ ...r, findings: r.findings.map((f) => (f.id === e.data.findingId ? { ...f, followUpWorkItemId: e.data.workItemId } : f)) }));
      break;
    case 'merge.completed':
      s.merges = put(s.merges ?? {}, e.data.merge.id, e.data.merge);
      break;
    case 'merge.post_checks':
      s.merges = patchIn(s.merges ?? {}, e.data.mergeId, (m) => ({ ...m, postChecks: { status: e.data.status, evidenceIds: e.data.evidenceIds, at: ts } }));
      break;
    case 'merge.refused':
      if (e.data.decisionId) s.decisions = patchIn(s.decisions, e.data.decisionId, (d) => ({ ...d, outcome: `refused: ${e.data.reason}` }));
      break;
    case 'release.saved':
      s.releases = put(s.releases ?? {}, e.data.plan.id, e.data.plan);
      break;
    case 'code_host.checked':
      s.codeHost = e.data.snapshot;
      break;
    case 'infra.checked':
      s.infra = e.data.health;
      break;
    case 'docker.action':
      break;
    case 'kill_switch.set':
      s.killSwitch = { engaged: e.data.engaged, at: ts, by: e.actor.id };
      break;
    case 'context.vault':
      s.context = { ...(s.context ?? { vault: null, graph: null }), vault: e.data.status };
      break;
    case 'context.graph':
      s.context = { ...(s.context ?? { vault: null, graph: null }), graph: e.data.status };
      break;
    case 'context.docs':
      s.context = { ...(s.context ?? { vault: null, graph: null }), docs: e.data.status };
      break;
    case 'context.answer':
      s.context = { ...s.context, answer:e.data.status };
      break;

    default: {
      // Transcript events: keep run liveness and the "last meaningful event" current.
      if (e.kind === 'transcript' && e.runId && s.runs[e.runId]) {
        const summary = meaningfulSummary(e);
        s.runs = patchIn(s.runs, e.runId, (r) => {
          const next: Run = { ...r, lastEventAt: ts, eventCount: r.eventCount + 1 };
          if (r.state === 'starting' || r.state === 'stalled' || r.state === 'queued') next.state = 'running';
          if (summary) next.lastMeaningful = { at: ts, summary };
          if (e.type === 't.test_result') next.tests = { ...e.data.counts, command: e.data.command, at: ts, source: 'agent' };
          if (e.type === 't.file_edit' && !r.filesChanged.includes(e.data.path)) next.filesChanged = [...r.filesChanged, e.data.path];
          return next;
        });
        const prev = state.runs[e.runId];
        if (prev && prev.state !== s.runs[e.runId].state) s = refreshAgent(s, e.agentId ?? prev.agentId, ts);
      }
    }
  }
  return s;
}

export function replay(events: Iterable<EventEnvelope>, from: ControlState = emptyState()): ControlState {
  let s = from;
  for (const e of events) s = applyEvent(s, e);
  return s;
}
