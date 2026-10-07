// SPDX-License-Identifier: Apache-2.0
// Runtime entities. Config lives in config.ts; these are what the event log builds up.
import type { AdapterType, AgentConfig, Effort, ProjectConfig, Policy, Role, RuleName, TrackerConfig } from './config.ts';
import type { BlockedOn, LifecycleState, TrackerCategory } from './lifecycle.ts';
import type { DesignRevision } from './design.ts';
import type { Workflow } from './workflows.ts';
import type { IntegrationMerge, ReviewRecord } from './reviews.ts';
import type { ProjectSkill, SkillRef } from './skills.ts';
import type { Connector } from './connectors.ts';
import type { MockArtifact } from './mocks.ts';

export type Actor = { type: 'human' | 'agent' | 'system'; id: string };

export type AuthState = 'logged_in' | 'expired' | 'not_installed' | 'unknown';
export interface AuthStatus {
  state: AuthState;
  detail?: string;
  /** The vendor's own login command or instruction, e.g. "Run `codex login` in a terminal". */
  fix?: string;
  tier?: string;
}

export type BillingMode = 'subscription' | 'metered' | 'local' | 'unknown';
export interface BillingInfo {
  mode: BillingMode;
  /** Where the answer came from, e.g. "codex login status" or "declared in config". */
  source: string;
  /** Overage / on-demand / auto-recharge state when the vendor exposes it. */
  overage: 'off' | 'on' | 'unknown';
  notes?: string[];
}

export interface BinaryInfo {
  path: string;
  version: string | null;
  prerelease: boolean;
  source: 'path' | 'app-bundle' | 'config' | 'known-location';
}

export interface ModelInfo {
  id: string;
  label?: string;
  /** USD per million tokens, when the provider publishes it (OpenRouter). 0 = free. */
  pricing?: { input: number; output: number };
  /** False when the provider says the model can't call tools (useless as a coding agent). */
  tools?: boolean;
  /** Vendor-provided preference: lower is better (Codex catalog priority). */
  priority?: number;
  efforts?: Effort[];
  hidden?: boolean;
  /** Vendor says this model has a newer replacement. */
  upgrade?: string;
}

export interface UsageWindow {
  name: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes?: number;
}

export interface UsageInfo {
  windows: UsageWindow[];
  /** "unknown" when the vendor exposes nothing; never guessed. */
  status: 'ok' | 'near_limit' | 'limited' | 'unknown';
  checkedAt: string;
  source: string;
}

export type AgentStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'stalled' | 'failed' | 'limited' | 'paused' | 'offline';

export interface AgentState {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  auth: AuthStatus;
  billing: BillingInfo;
  binary: BinaryInfo | null;
  binaryCandidates: BinaryInfo[];
  models: { available: ModelInfo[]; current: string | null; newest: string | null; checkedAt: string | null };
  usage: UsageInfo;
  limitedUntil: string | null;
  /** Assignment ids. `now` is what it is doing; `next` refills it automatically. */
  queue: { now: string | null; next: string[] };
  activeRunIds: string[];
  idleSince: string | null;
  idleMsTotal: number;
  idleWithWorkSince: string | null;
  pausedReason: string | null;
  probedAt: string | null;
}

export type EvidenceKind = 'command' | 'test' | 'commit' | 'merge' | 'acceptance' | 'handoff' | 'review';
export interface Evidence {
  id: string;
  kind: EvidenceKind;
  summary: string;
  command?: string;
  exitCode?: number | null;
  counts?: TestCounts;
  sha?: string;
  branch?: string;
  runId?: string;
  logPath?: string;
  /** Runtime configuration used by daemon-owned committed-source checks. */
  checkRuntime?: string;
  checkImage?: string;
  env?: 'local' | 'ci' | 'production' | 'device';
  /** Recorded by the control center itself (true) vs. claimed by an agent (false). */
  verified: boolean;
  at: string;
}

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  framework?: string;
}

export interface WorkItem {
  id: string;
  /** Tracker key, e.g. ENG-12, GH-34, LOC-3. Null until the tracker confirms creation. */
  key: string | null;
  trackerId: string | null;
  url: string | null;
  title: string;
  description: string;
  acceptance: string[];
  labels: string[];
  priority: number;
  parentKey: string | null;
  blockedBy: string[];
  state: LifecycleState;
  blockedOn: BlockedOn | null;
  resumeTo: LifecycleState | null;
  ownerAgentId: string | null;
  assignmentIds: string[];
  runIds: string[];
  branches: string[];
  evidence: Evidence[];
  requiresProductionVerification: boolean;
  /** Workflow position: current stage/phase id, sprint, kind of work, reviews. */
  stage?: string | null;
  sprint?: string | null;
  workType?: string | null;
  reviews?: Review[];
  origin?: { sourceId: string; type: 'github' | 'linear'; issueId: string; key: string; url: string | null; importedAt: string; readOnly: boolean; connectorId?: string; contentHash?: string; importedBy?: string; untrusted?: boolean };
  trackerStatus: { category: TrackerCategory; native: string } | null;
  sync: { status: 'synced' | 'pending' | 'failed' | 'dry_run'; lastError: string | null; at: string | null };
  createdAt: string;
  updatedAt: string;
}

export type AssignmentPosition = 'draft' | 'next' | 'now' | 'done' | 'canceled';

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: { kind: 'use_model'; model: string } | { kind: 'reprobe' } | { kind: 'text'; text: string };
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  model: string | null;
  at: string;
}

export interface Assignment {
  id: string;
  workItemId: string;
  agentId: string;
  position: AssignmentPosition;
  scope: string;
  allowedPaths: string[];
  worktree: string | null;
  branch: string | null;
  baseRef: string;
  baseSha: string | null;
  requiredChecks: string[];
  askHumanIf: string[];
  handoffFormat: string;
  prompt: string;
  promptEdited: boolean;
  model: string | null;
  effort: Effort | null;
  designRevision?: string | null;
  /** Skill versions frozen at creation; later library edits never change a running task. */
  skills?: SkillRef[];
  preflight: PreflightResult | null;
  createdAt: string;
  dispatchedAt: string | null;
  /** Workflow stage this assignment belongs to, and whether it is a code review. */
  stage?: string | null;
  kind?: 'work' | 'review';
  workflowId?: string | null;
  taskId?: string | null;
  /** Review assignments: the exact commit under review. The reviewer never owns the issue. */
  review?: ReviewTarget | null;
}

export interface ReviewTarget {
  targetSha: string;
  sourceBranch: string | null;
  baseSha: string | null;
  authorAgentId: string | null;
  authorAssignmentId: string | null;
}

export const RUN_STATES = ['queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input', 'stalled', 'paused', 'failed', 'finished', 'orphaned'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const FAILURE_KINDS = ['auth_expired', 'model_unsupported', 'network', 'usage_limit', 'sandbox_denied', 'billing_violation', 'crash', 'stopped', 'killed', 'orphaned', 'no_handoff'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface ExitReason {
  kind: 'completed' | FailureKind;
  message: string;
  exitCode?: number | null;
  signal?: string | null;
  resetsAt?: string | null;
}

export interface HandoffEvidenceItem {
  command: string;
  result: string;
  verified?: boolean;
  note?: string;
}

export interface Handoff {
  done: string;
  evidence: HandoffEvidenceItem[];
  commit: { sha: string; branch: string | null; verified?: boolean } | null;
  blocked: { what: string; on: string | null } | null;
  next: string | null;
  source: 'final_message' | 'commit_body' | 'tracker_comment' | 'mcp' | 'relay_paste' | 'skeleton';
  raw: string;
  /** Code reviews: the verdict and findings. */
  verdict?: 'approve' | 'request_changes' | null;
  findings?: string[];
}

export interface Run {
  id: string;
  assignmentId: string;
  workItemId: string;
  agentId: string;
  adapter: AdapterType;
  model: string | null;
  resolvedModel: string | null;
  effort: Effort | null;
  attempt: number;
  retryOf: string | null;
  pid: number | null;
  sessionId: string | null;
  state: RunState;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  lastMeaningful: { at: string; summary: string } | null;
  eventCount: number;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  exit: ExitReason | null;
  handoff: Handoff | null;
  filesChanged: string[];
  outOfScope: string[];
  tests: (TestCounts & { command: string; at: string; source: 'agent' | 'daemon' }) | null;
  logDir: string | null;
}

export interface Approval {
  id: string;
  runId: string;
  agentId: string;
  workItemId: string | null;
  /** gate = a workflow phase waiting for the owner's go-ahead. */
  kind: 'tool_permission' | 'ask_human' | 'gate';
  title: string;
  detail: string;
  options: string[];
  createdAt: string;
  resolvedAt: string | null;
  decision: string | null;
  by: string | null;
  channel: string | null;
}

export type AlertKind =
  | 'stall'
  | 'approval_pending'
  | 'idle_with_work'
  | 'run_failed'
  | 'retry_exhausted'
  | 'usage_limit'
  | 'tracker_out_of_sync'
  | 'tracker_not_live'
  | 'tracker_mismatch'
  | 'handoff_missing'
  | 'scope_violation'
  | 'path_overlap'
  | 'binary_changed'
  | 'auth'
  | 'billing'
  | 'model'
  | 'preflight_failed'
  | 'orphaned_run'
  | 'workflow'
  | 'review'
  | 'merge';

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  agentId?: string;
  runId?: string;
  workItemId?: string;
  suggestion?: { kind: 'reassign'; agentIds: string[]; note?: string } | { kind: 'text'; text: string };
  dedupeKey: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

/** Typed for P2 flows (Decisions inbox); approvals from agents are recorded as Approvals. */
export interface Decision {
  id: string;
  question: string;
  options: string[];
  recommendation: string | null;
  evidenceLinks: string[];
  urgency: 'low' | 'normal' | 'high' | 'critical';
  irreversible: boolean;
  answer: string | null;
  answeredAt: string | null;
  channel: string | null;
  createdAt: string;
  kind?: 'merge' | 'docker' | 'environment' | 'connector' | 'question';
  workItemId?: string | null;
  risk?: 'low' | 'medium' | 'high';
  /** The exact action an approval authorizes. An answer never authorizes anything else. */
  action?: DecisionAction | null;
  /** Facts shown next to the question; `ok: false` marks a failing gate. */
  evidence?: { label: string; detail: string; ok?: boolean | null }[];
  /** Options that perform the irreversible action and need a second confirmation. */
  confirmOptions?: string[];
  /** Advisory only (e.g. Jev). Never counts as the human answer. */
  recommendedBy?: Actor | null;
  rationale?: string | null;
  answeredBy?: Actor | null;
  confirmedAt?: string | null;
  consumedAt?: string | null;
  outcome?: string | null;
  expiresAt?: string | null;
}

export interface MergeAction {
  kind: 'merge';
  workItemId: string;
  sourceBranch: string;
  sourceSha: string;
  target: string;
  targetSha: string;
  reviewId: string;
  /** Stable hash of the fields above; changes if anything about the action changes. */
  hash: string;
}
export type DecisionAction = MergeAction;

export interface Review {
  id: string;
  workItemId: string;
  reviewer: Actor;
  authorAgentId: string;
  sha: string;
  findings: string[];
  verdict: 'approve' | 'request_changes' | null;
  at: string;
}

export interface MergeRecord {
  id: string;
  workItemId: string;
  source: string;
  target: string;
  sha: string | null;
  result: 'merged' | 'conflict' | 'failed';
  postMergeChecks: Evidence[];
  at: string;
}

export interface ReleaseStep {
  id: string;
  title: string;
  owner: string;
  command: string;
  check: string;
  rollback: string;
  approval: 'not_required' | 'pending' | 'approved' | 'denied';
  status: 'todo' | 'running' | 'passed' | 'failed' | 'skipped';
}

export interface VaultStatus {
  root: string;
  folder: string;
  backend: 'fs' | 'obsidian-cli';
  cli: { available: boolean; path: string | null; note: string };
  notes: number;
  lastWriteAt: string | null;
  openUrl: string | null;
  error: string | null;
}

export interface GraphStatus {
  state: 'missing' | 'building' | 'ready' | 'error' | 'unavailable';
  sha: string | null;
  builtAt: string | null;
  nodes: number;
  edges: number;
  durationMs: number | null;
  graphPath: string | null;
  semantic: boolean;
  error: string | null;
}

/** Internal project messages. Recipients are frozen at send time. */
export interface TeamMessage {
  id: string;
  seq: number;
  sender: Actor;
  recipients: string[];
  kind: 'note' | 'question' | 'reply' | 'blocker' | 'handoff';
  subject: string;
  body: string;
  workItemId: string | null;
  runId: string | null;
  replyTo: string | null;
  createdAt: string;
  acknowledgedBy: Record<string, string>;
  /** Reminder queued for a live harness; acknowledgement alone proves it read the message. */
  notifiedRuns: Record<string, string>;
}

export interface DocsStatus {
  chunks: number; notes: number; vectors: number; indexing: boolean; searching: boolean;
  semantic: boolean; embeddingModel: string; answerModel: string | null; endpoint: string;
  indexedAt: string | null; error: string | null; truncated: boolean; backend: string; scope: string[];
  queries: number; contextChars: number; candidateChars: number;
}
export interface DocCitation { id: string; path: string; title: string; line: number; endLine: number; excerpt: string; url: string; projectSource?:{path:string;revision:string;hash:string;line:number;endLine:number}; }
export interface OneAnswerStatus {
  state:'missing'|'extracting'|'indexing'|'ready'|'partial'|'error'|'interrupted';
  revision:string|null;ref:string;updatedAt:string|null;files:number;totalFiles:number;excludedFiles:number;truncated:boolean;
  languages:Record<string,number>;packages:{path:string;name:string|null;dependencies:string[];scripts:Record<string,string>}[];
  notesRevision:string|null;embeddingsRevision:string|null;graphRevision:string|null;error:string|null;
}
export interface DocSearchResult {
  backend: 'keywords' | 'hybrid'; citations: DocCitation[]; warning: string | null;
  contextChars: number; candidateChars: number; budgetChars: number; indexedAt: string | null;
}
export interface DocAnswer extends DocSearchResult { mode: 'excerpts' | 'answer'; claims: {text:string;sources:string[]}[]; answerError?:string; }

export interface ControlState {
  seq: number;
  startedAt: string | null;
  project: ProjectConfig | null;
  tracker: TrackerConfig | null;
  policies: Policy | null;
  agents: Record<string, AgentState>;
  workItems: Record<string, WorkItem>;
  assignments: Record<string, Assignment>;
  runs: Record<string, Run>;
  approvals: Record<string, Approval>;
  alerts: Record<string, Alert>;
  decisions: Record<string, Decision>;
  teamMessages: Record<string, TeamMessage>;
  rules: Partial<Record<RuleName, boolean>>;
  killSwitch: { engaged: boolean; at: string | null; by: string | null };
  context: { vault: VaultStatus | null; graph: GraphStatus | null; docs?: DocsStatus | null;answer?:OneAnswerStatus|null };
  design:DesignRevision|null;
  workflows: Record<string, Workflow>;
  reviews: Record<string, ReviewRecord>;
  merges: Record<string, IntegrationMerge>;
  skills?: Record<string, ProjectSkill>;
  connectors?: Record<string, Connector>;
  mocks?: Record<string, MockArtifact>;
}

export function emptyState(): ControlState {
  return {
    seq: 0,
    startedAt: null,
    project: null,
    tracker: null,
    policies: null,
    agents: {},
    workItems: {},
    assignments: {},
    runs: {},
    approvals: {},
    alerts: {},
    decisions: {},
    teamMessages: {},
    rules: {},
    killSwitch: { engaged: false, at: null, by: null },
    context: { vault: null, graph: null },
    design:null,
    workflows: {},
    reviews: {},
    merges: {},
    skills: {},
    connectors: {},
    mocks: {},
  };
}

export function roleLabel(r: Role): string {
  return r === 'qa' ? 'QA' : r[0].toUpperCase() + r.slice(1);
}
