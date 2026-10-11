// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The abstractions daemon services depend on, instead of the concrete Daemon. Each service
// declares its dependencies as `Kernel & Pick<WorkCommands, ...> & { collaborator }`, so it
// can be built with a fake in tests, and the composition root (daemon.ts) can change or split
// how these are provided without touching the services. Daemon implements every interface here.
import type { EventEmitter } from 'node:events';
import type { Actor, AgentConfig, AgentState, Alert, Assignment, ControlCenterConfig, ControlState, EventEnvelope, LifecycleState, NewEvent, PreflightResult, RuleName, WorkItem } from '@acc/core';
import type { AnswerOptions } from './decisions.ts';
import type { Egress } from './egress.ts';
import type { DataPaths } from './paths.ts';
import type { EventStore, OutboxOp } from './store/eventStore.ts';

export interface IssueInput { title: string; description?: string; acceptance?: string[]; labels?: string[]; priority?: number; requiresProductionVerification?: boolean; parentKey?: string | null }

export interface AssignmentInput {
  workItemId: string;
  agentId: string;
  allowedPaths?: string[];
  scope?: string;
  requiredChecks?: string[];
  askHumanIf?: string[];
  model?: string | null;
  /** Commit or branch the worktree starts from (default: the integration branch). */
  baseRef?: string;
  kind?: Assignment['kind'];
  review?: Assignment['review'];
  workflowId?: string | null;
  taskId?: string | null;
}

/** Events and tracker outbox rows for a change, committed by the caller together with its own. */
export interface ChangeSet {
  events: NewEvent[];
  outbox: OutboxOp[];
}

/**
 * The event-sourced core every service uses: append events (validated, redacted, applied by
 * the shared reducer, then broadcast), read the projected state, time, configuration, secrets
 * redaction and alerts.
 */
export interface Kernel {
  readonly paths: DataPaths;
  readonly store: EventStore;
  readonly bus: EventEmitter;
  /** All outbound HTTP; only configured connections are reachable. */
  readonly egress: Egress;
  readonly config: ControlCenterConfig;
  readonly state: ControlState;
  /** True once shutdown has started; commits are refused. */
  readonly closed: boolean;
  /** Base URL of the HTTP server, once listening (used by the per-run MCP bridge). */
  readonly url: string | null;
  now(): Date;
  nowIso(): string;
  baseEnv(): NodeJS.ProcessEnv;
  commit(events: NewEvent[], outbox?: OutboxOp[], inTx?: () => void): EventEnvelope[];
  alert(a: Omit<Alert, 'id' | 'createdAt' | 'resolvedAt' | 'resolution'>): Alert | null;
  resolveAlerts(pred: (a: Alert) => boolean, resolution: string, actor?: Actor): void;
  addSecret(value: string): void;
  denylist(): string[];
  redactText(text: string): string;
  /** Recompute the egress allowlist after a connection was activated or removed. */
  refreshEgress(): void;
  /** Whether an automation rule is on (owner toggle, else the configured policy). */
  ruleOn(rule: RuleName): boolean;
}

/** Issue, assignment and lifecycle commands. */
export interface WorkCommands {
  createIssue(input: IssueInput, actor?: Actor): WorkItem;
  /** Events + outbox for a new issue, so callers can create it atomically with other changes. */
  buildIssue(input: IssueInput, actor?: Actor, o?: { mirror?: boolean; bind?: { trackerId: string; key: string; url: string | null; trackerStatus: WorkItem['trackerStatus'] } }): ChangeSet & { item: WorkItem };
  createAssignment(input: AssignmentInput, actor?: Actor): Assignment;
  updateAssignment(id: string, patch: Partial<Pick<Assignment, 'prompt' | 'scope' | 'allowedPaths' | 'requiredChecks' | 'askHumanIf' | 'model' | 'effort'>>, actor?: Actor): Assignment;
  cancelAssignment(assignmentId: string, actor?: Actor): void;
  assignmentText(a: Assignment, relay?: boolean): string;
  preflight(assignmentId: string, record?: boolean): PreflightResult;
  dispatch(assignmentId: string, o?: { position?: 'now' | 'next'; actor?: Actor }): Promise<{ started: boolean; queued: boolean; preflight: PreflightResult; runId?: string }>;
  agentFree(agentId: string): boolean;
  /** A lifecycle transition as a change set; throws CommandError if it isn't allowed. */
  transition(itemId: string, to: LifecycleState, reason: string, actor?: Actor, blockedOn?: WorkItem['blockedOn']): ChangeSet;
  /** Like transition(), but an empty change set instead of an error. */
  safeTransition(itemId: string, to: LifecycleState, reason: string, actor?: Actor, blockedOn?: WorkItem['blockedOn']): ChangeSet;
  /** Commit the transition with `extra` if allowed; otherwise commit only `extra` and return false. */
  tryTransition(itemId: string, to: LifecycleState, reason: string, extra?: NewEvent[], extraOutbox?: OutboxOp[], actor?: Actor, blockedOn?: WorkItem['blockedOn']): boolean;
}

/** Agent runtime commands and policy reads. */
export interface AgentCommands {
  probe(agentId: string): Promise<void>;
  resolveModelFor(agentId: string): { model: string | null; newest: string | null };
  /** Metered spend recorded today (local day) for one agent. */
  spentToday(agentId: string): number;
  validateAgentSettings(input: unknown, expected?: unknown): { cfg: AgentConfig; next: ControlCenterConfig };
  saveAgent(input: unknown, expected?: unknown, o?: { costDecisionId?: string; answerOptions?: AnswerOptions }): AgentState;
}

/** Owner-approved configuration changes that rebuild dependent services. */
export interface ConfigCommands {
  /** Writable: replaced when the owner saves settings or an agent. */
  config: ControlCenterConfig;
  connectKnowledge(input: unknown): Promise<void>;
  /** Recreate revision-bound retrieval after an approved integration-branch or graph change. */
  reloadContext(): Promise<void>;
}

/** A kernel whose configuration the service may replace (settings and agent saves). */
export type ConfigurableKernel = Omit<Kernel, 'config'> & Pick<ConfigCommands, 'config'>;
