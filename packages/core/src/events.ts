// SPDX-License-Identifier: Apache-2.0
// Typed, timestamped events. The append-only log of these is the source of truth for
// runs, handoffs and decisions, and doubles as the audit log (every event has an actor).
import type { AgentConfig, Policy, ProjectConfig, RuleName, TrackerConfig } from './config.ts';
import type {
  Actor,
  Alert,
  Approval,
  Assignment,
  AssignmentPosition,
  AuthStatus,
  BillingInfo,
  BinaryInfo,
  Evidence,
  ExitReason,
  FailureKind,
  Handoff,
  ModelInfo,
  Review,
  Decision,
  JevAdvisory,
  Run,
  RunState,
  TestCounts,
  UsageInfo,
  VaultStatus,
  GraphStatus,
  WorkItem,
  TeamMessage,
  DocsStatus,
  DictionaryStatus,
} from './entities.ts';
import type { BlockedOn, LifecycleState } from './lifecycle.ts';
import type { DesignRevision } from './design.ts';
import type { Workflow, WorkflowStatus, WorkflowTaskState } from './workflows.ts';
import type { IntegrationMerge, MergeGate, ReviewRecord } from './reviews.ts';
import type { SkillVersion } from './skills.ts';
import type { Connector, ConnectorAction, ConnectorAvailability } from './connectors.ts';
import type { MockArtifact, MockEvidence, MockException, MockReview, MockRevision } from './mocks.ts';
import type { DesignStudioEvent } from './designStudio.ts';
import type { NotificationChannel, NotificationConfig, NotificationRecord, RemoteConfig, RemoteScope } from './phone.ts';
import type { CodeHostSnapshot, InfraHealthReport, ReleasePlan } from './release.ts';

export interface ControlEventData {
  'design.system_saved':{revision:DesignRevision};
  'skill.draft_saved': { id: string; name: string; description: string; hash: string };
  'skill.version_published': { version: SkillVersion };
  'skill.disabled': { id: string; disabled: boolean };
  'skill.exported': { assignmentId: string; worktree: string; written: string[]; skipped: { path: string; reason: string }[] };
  'connector.saved': { connector: Omit<Connector, 'approvals' | 'pending' | 'availability'> };
  'connector.disabled': { connectorId: string; disabled: boolean };
  'connector.activation_requested': { connectorId: string; action: ConnectorAction; decisionId: string; configHash: string };
  'connector.activated': { connectorId: string; action: ConnectorAction; decisionId: string; configHash: string };
  'connector.activation_denied': { connectorId: string; action: ConnectorAction; decisionId: string };
  'connector.checked': { connectorId: string; availability: ConnectorAvailability };
  'connector.used': { connectorId: string; action: ConnectorAction; detail: string; ok: boolean };
  'connector.tool_requested': { requestId: string; connectorId: string; tool: string; decisionId: string; configHash: string; argumentsHash: string };
  'connector.tool_denied': { requestId: string; connectorId: string; tool: string; decisionId: string };
  'connector.tool_execution_started': { requestId: string; connectorId: string; tool: string; decisionId: string };
  'connector.tool_executed': { requestId: string; connectorId: string; tool: string; decisionId: string; ok: boolean };
  'tracker.operation_skipped': { operation: string; reason: string };
  'design.mock_captured': { artifact: Omit<MockArtifact, 'revisions'>; revision: MockRevision };
  'design.mock_exception': { artifactId: string; rev: number; exception: MockException };
  'design.mock_reviewed': { artifactId: string; rev: number; review: MockReview };
  'design.mock_evidence': { artifactId: string; rev: number; evidence: MockEvidence };
  /** Designer studio jobs and capture attempts (one discriminated event type owned by designStudio.ts). */
  'design.studio': DesignStudioEvent;
  'team.message_sent': { message: TeamMessage };
  'team.message_acknowledged': { messageId: string; recipientId: string };
  'team.message_notified': { messageId: string; targetRunId: string };
  'decision.created': { decision: Decision };
  /** `confirmed`: the second confirmation for an irreversible option was given. */
  'decision.answered': { decisionId: string; answer: string; channel: string; confirmed?: boolean };
  /** Advisory recommendation (e.g. Jev). Never an answer. */
  'decision.recommended': { decisionId: string; recommendation: string; rationale: string };
  /** Jev advisory persisted after an explicitly confirmed request. Advisory only: never an answer. */
  'decision.advisory': { decisionId: string; advisory: JevAdvisory };
  /** The evidence the advisory was based on changed; it no longer describes this decision. */
  'decision.advisory_invalidated': { decisionId: string; reason: string };
  /** Owner enabled/disabled the metered Jev connection (audit only; the key stays in the Keychain). */
  /** The owner closed a Jev preview without sending anything (audit only). */
  'jev.cancelled': { decisionId: string; inputHash: string };
  'jev.configured': { enabled: boolean; host: string; confirmations: string[] };
  'decision.confirmation_requested': { decisionId: string; answer: string; expiresAt: string };
  /** The approved action ran (or can no longer run); the decision cannot authorize anything again. */
  'decision.consumed': { decisionId: string; outcome: string };
  'workflow.saved': { workflow: Workflow };
  'workflow.status': { workflowId: string; status: WorkflowStatus; reason: string | null };
  'workflow.task_updated': { workflowId: string; taskId: string; patch: Partial<WorkflowTaskState> };
  'review.recorded': { review: ReviewRecord };
  'review.invalidated': { reviewId: string; reason: string };
  'review.finding_linked': { reviewId: string; findingId: string; workItemId: string };
  'merge.completed': { merge: IntegrationMerge };
  'merge.post_checks': { mergeId: string; status: IntegrationMerge['postChecks']['status']; evidenceIds: string[] };
  'merge.refused': { workItemId: string; decisionId: string | null; reason: string; gates: MergeGate[] };
  'release.saved': { plan: ReleasePlan };
  'code_host.checked': { snapshot: CodeHostSnapshot };
  'infra.checked': { health: InfraHealthReport };
  'docker.action': { decisionId: string; command: string[]; exitCode: number | null; output: string };
  'daemon.started': { version: string; pid: number };
  'config.loaded': { project: ProjectConfig; tracker: TrackerConfig; policies: Policy };
  'tracker.live_enabled': { type: string; target: string };
  'agent.registered': { config: AgentConfig };
  'agent.removed': Record<string, never>;
  'agent.probed': {
    auth: AuthStatus;
    billing: BillingInfo;
    binary: BinaryInfo | null;
    binaryCandidates: BinaryInfo[];
    models: ModelInfo[];
    newest: string | null;
    usage?: UsageInfo;
  };
  'agent.usage': { usage: UsageInfo };
  'agent.limited': { until: string | null; message: string };
  'agent.unlimited': { reason: string };
  'agent.subscription_confirmed': { binding: string; expiresAt: string; scope: 'daemon-session'; note: string };
  'agent.paused': { reason: string };
  'agent.resumed': Record<string, never>;
  'agent.model_changed': { model: string };
  'agent.queue_set': { now: string | null; next: string[] };
  'work_item.created': { item: WorkItem };
  'work_item.updated': {
    patch: Partial<Pick<WorkItem, 'title' | 'description' | 'acceptance' | 'labels' | 'priority' | 'parentKey' | 'blockedBy' | 'trackerStatus' | 'ownerAgentId' | 'branches' | 'requiresProductionVerification' | 'stage' | 'sprint' | 'workType' | 'origin'>>;
  };
  'work_item.transitioned': { from: LifecycleState; to: LifecycleState; reason: string; blockedOn?: BlockedOn | null };
  'work_item.evidence_added': { evidence: Evidence };
  'work_item.reviewed': { review: Review };
  'work_item.synced': { status: WorkItem['sync']['status']; error?: string | null; key?: string; trackerId?: string; url?: string | null };
  'assignment.created': { assignment: Assignment };
  'assignment.updated': { patch: Partial<Omit<Assignment, 'id' | 'workItemId' | 'createdAt'>> };
  'assignment.positioned': { position: AssignmentPosition };
  'assignment.worktree_ready': { worktree: string; branch: string; baseSha: string };
  'run.created': { run: Run };
  'run.started': { pid: number | null };
  'run.session': { sessionId: string | null; model: string | null };
  'run.state': { state: RunState; reason?: string };
  /** A child session of the harness (e.g. an OpenCode subagent): shown as a child run in the console. */
  'run.child': { sessionId: string; parentSessionId: string | null; title: string; state: 'running' | 'completed' | 'failed' | 'aborted'; error?: string | null };
  /** `state` overrides the default (finished / failed / orphaned), e.g. paused. */
  'run.ended': { exit: ExitReason; state?: RunState };
  'run.handoff': { handoff: Handoff };
  'run.usage': { inputTokens: number; outputTokens: number; costUsd?: number };
  'run.files_changed': { files: string[]; outOfScope: string[] };
  'run.tests': { counts: TestCounts; command: string; source: 'agent' | 'daemon' };
  'approval.requested': { approval: Approval };
  'approval.resolved': { approvalId: string; decision: string; by: string; channel: string };
  'alert.raised': { alert: Alert };
  'alert.resolved': { alertId: string; resolution: string };
  'rule.toggled': { rule: RuleName; enabled: boolean };
  'kill_switch.set': { engaged: boolean };
  'context.vault': { status: VaultStatus | null };
  'context.graph': { status: GraphStatus | null };
  'context.docs': { status: DocsStatus | null };
  'context.answer': { status: DictionaryStatus };
  'context.connected': { vault: string; folders: string[]; semantic: boolean };
  // ---- phone access, notifications and context benchmark (audit only; state lives in daemon storage) ----
  'remote.config_changed': { config: RemoteConfig; scopeHash: string };
  'remote.tunnel_requested': { decisionId: string; adapter: string; planDigest: string; hostname: string | null };
  'remote.tunnel_state': { state: 'down' | 'starting' | 'up' | 'reconnecting' | 'error'; adapter: string; hostname: string | null; detail: string; decisionId?: string | null };
  'remote.pairing_issued': { pairingId: string; expiresAt: string; scopes: RemoteScope[] };
  'remote.paired': { sessionId: string; pairingId: string; scopes: RemoteScope[]; expiresAt: string; label: string };
  'remote.pair_failed': { reason: string; locked: boolean };
  'remote.session_revoked': { sessionId: string; reason: string; by: string };
  'remote.request_denied': { sessionId: string | null; method: string; path: string; reason: string };
  'notification.emitted': { notification: NotificationRecord };
  'notification.acked': { id: string };
  'notification.config_changed': { config: NotificationConfig };
  'notification.delivered': { id: string; channel: NotificationChannel; ok: boolean; detail: string };
  'notification.endpoint_activated': { channel: 'webpush' | 'chat'; host: string; decisionId: string; expiresAt: string };
  'notification.endpoint_denied': { channel: 'webpush' | 'chat'; host: string; decisionId: string };
  'benchmark.completed': { runId: string; corpus: string; summary: Record<string, unknown> };
}

export interface TranscriptEventData {
  't.message': { role: 'assistant' | 'user' | 'system'; text: string };
  't.reasoning': { text: string };
  't.tool_call': { callId?: string; name: string; summary: string };
  't.tool_result': { callId?: string; ok: boolean; summary: string };
  't.command': { callId?: string; command: string; status: 'started' | 'completed' | 'failed'; exitCode?: number | null; output?: string };
  't.file_edit': { path: string; change: 'add' | 'modify' | 'delete' };
  't.test_result': { counts: TestCounts; command: string };
  't.error': { message: string; failure?: FailureKind };
  't.usage': { inputTokens: number; outputTokens: number };
  't.raw': { stream: 'stdout' | 'stderr'; line: string };
  't.commit': { sha: string; subject: string };
  't.system': { text: string };
}

export type EventDataMap = ControlEventData & TranscriptEventData;
export type ControlEventType = keyof ControlEventData;
export type TranscriptEventType = keyof TranscriptEventData;
export type EventType = keyof EventDataMap;

export interface EventRefs {
  agentId?: string | null;
  runId?: string | null;
  workItemId?: string | null;
  assignmentId?: string | null;
}

export type NewEvent<T extends EventType = EventType> = {
  [K in T]: { type: K; data: EventDataMap[K]; actor?: Actor; ts?: string } & EventRefs;
}[T];

export type EventEnvelope<T extends EventType = EventType> = {
  [K in T]: {
    seq: number;
    id: string;
    ts: string;
    type: K;
    kind: 'control' | 'transcript';
    actor: Actor;
    agentId: string | null;
    runId: string | null;
    workItemId: string | null;
    assignmentId: string | null;
    data: EventDataMap[K];
  };
}[T];

export function isTranscriptType(type: string): type is TranscriptEventType {
  return type.startsWith('t.');
}

export const SYSTEM: Actor = { type: 'system', id: 'control-center' };
export const HUMAN: Actor = { type: 'human', id: 'owner' };
export const agentActor = (id: string): Actor => ({ type: 'agent', id });

/** Summary line used for "last meaningful event"; null for noise (usage, raw, reasoning). */
export function meaningfulSummary(e: { type: string; data: unknown }): string | null {
  const d = e.data as Record<string, unknown>;
  const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  switch (e.type) {
    case 't.message':
      return d.role === 'assistant' ? clip(String(d.text).replace(/\s+/g, ' ').trim()) : null;
    case 't.command':
      return d.status === 'started' ? `$ ${clip(String(d.command), 120)}` : `$ ${clip(String(d.command), 100)} → exit ${d.exitCode ?? '?'}`;
    case 't.file_edit':
      return `${d.change === 'add' ? 'created' : d.change === 'delete' ? 'deleted' : 'edited'} ${d.path}`;
    case 't.test_result': {
      const c = d.counts as TestCounts;
      return `tests: ${c.passed} passed, ${c.failed} failed`;
    }
    case 't.error':
      return `error: ${clip(String(d.message))}`;
    case 't.commit':
      return `commit ${String(d.sha).slice(0, 8)} ${clip(String(d.subject), 80)}`;
    case 't.tool_call':
      return `${d.name}: ${clip(String(d.summary), 110)}`;
    default:
      return null;
  }
}
