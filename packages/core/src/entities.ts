// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Runtime entities. Config lives in config.ts; these are what the event log builds up.
import type { AdapterType, AgentConfig, Effort, ProjectConfig, Policy, Role, RuleName, TrackerConfig } from './config.ts';
import type { BlockedOn, LifecycleState, TrackerCategory } from './lifecycle.ts';
import type { DesignRevision } from './design.ts';
import type { Workflow } from './workflows.ts';
import type { WorkflowLink } from './workflowLinks.ts';
import type { IntegrationMerge, ReviewRecord } from './reviews.ts';
import type { ProjectSkill, SkillRef } from './skills.ts';
import type { Connector } from './connectors.ts';
import type { MockArtifact } from './mocks.ts';
import type { DesignStudioState } from './designStudio.ts';
import type { CodeHostSnapshot, InfraHealthReport, ReleaseAction, ReleasePlan } from './release.ts';

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
  origin?: { sourceId: string; type: 'github' | 'linear'; issueId: string; key: string; url: string | null; importedAt: string; readOnly: boolean; localMirror?: boolean; connectorId?: string; contentHash?: string; importedBy?: string; untrusted?: boolean; sourceScope?: { type: 'github' | 'linear'; repo?: string; team?: string; project?: string | null }; sourceRevision?: string; warnings?: string[] };
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
  connectors?: string[];
  consults?: string[];
  workflowContext?: string | null;
  pickup?: string | null;
  mockBinding?: { artifactId: string; rev: number; hash: string };
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
  /** Child sessions the harness spawned (OpenCode subagents). Projection only: they never hold the agent's Now slot. */
  children?: ChildSession[];
}

export interface ChildSession {
  sessionId: string;
  parentSessionId: string | null;
  title: string;
  state: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: string;
  endedAt: string | null;
  error?: string | null;
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
  | 'merge'
  | 'branch_protection'
  | 'infra'
  | 'release';

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
  kind?: 'merge' | 'docker' | 'environment' | 'connector' | 'remote' | 'notification' | 'cost' | 'release' | 'settings' | 'question';
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
  /** Jev (TypeSafe System One) advisory. Separate from `recommendation`; never an answer or approval. */
  advisory?: JevAdvisory | null;
}

/** A persisted, advisory-only Jev result bound to the exact evidence it was computed from. */
export interface JevAdvisory {
  provider: 'jev';
  /** sha256 of the bounded, redacted evidence that was sent. */
  inputHash: string;
  model: string;
  usage: Record<string, number | string | null>;
  requestedAt: string;
  /** One of the decision's options (validated). */
  recommendation: string;
  rationale: string;
  /** Items and characters of redacted evidence that left this machine. */
  evidenceItems: number;
  evidenceChars: number;
  /** Source evidence the request was built from (decision evidence labels and work-item evidence ids). */
  evidenceIds: string[];
  /** Typed confidence from Jev when it reports one; otherwise null (unknown stays unknown). */
  confidence: number | null;
  host: string;
  /** Set when the decision's evidence changed after the request; a stale advisory is not shown as current. */
  stale: boolean;
  staleReason: string | null;
  staleAt: string | null;
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
/** Approval to save one exact pay-per-token agent configuration with a daily budget. */
export interface CostAction {
  kind: 'cost';
  agentId: string;
  provider: string;
  model: string;
  budgetUsdPerDay: number;
  /** Stable hash of the exact agent configuration being approved. */
  hash: string;
}
export interface SettingsAction {
  kind: 'settings';
  /** Project repository and the exact settings revision being approved. */
  repo: string;
  hash: string;
}
/** One exact MCP tool invocation bound to connector inventory, tool name and argument hash. */
export interface ConnectorToolAction {
  kind: 'connector_tool';
  connectorId: string;
  tool: string;
  hash: string;
}
export type DecisionAction = MergeAction | CostAction | ReleaseAction | SettingsAction | ConnectorToolAction;

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

export type { ReleasePlan, ReleaseStep } from './release.ts';

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
  /** Dictionary identity includes revision, redaction policy and project/vault scope. */
  generation?: string | null;
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
export interface DocCitation { id: string; path: string; title: string; line: number; endLine: number; excerpt: string; url: string; projectSource?:{path:string;revision:string;hash:string;line:number;endLine:number}; via?:'keyword'|'semantic'|'graph'; }
export interface DictionaryStatus {
  state:'missing'|'extracting'|'indexing'|'ready'|'partial'|'error'|'interrupted'|'cancelled';
  revision:string|null;ref:string;updatedAt:string|null;files:number;totalFiles:number;excludedFiles:number;truncated:boolean;
  languages:Record<string,number>;packages:{path:string;name:string|null;dependencies:string[];scripts:Record<string,string>}[];
  notesRevision:string|null;embeddingsRevision:string|null;graphRevision:string|null;error:string|null;
  /** Durable intake job (optional for older persisted statuses). */
  job?:DictionaryJob|null;
  /** Each pipeline stage with the exact source revision it was built from. */
  stages?:Record<DictionaryStageName,DictionaryStage>;
  /** What the last intake changed relative to the previous indexed revision. */
  changes?:DictionaryChanges|null;
  /** Immutable identity: source revision + redaction policy + vault scope + pipeline version. */
  generation?:string|null;
  /** Declarative import/manifest structure graph (not Graphify). */
  structure?:{files:number;symbols:number;edges:number;entryPoints:string[]}|null;
}
export type DictionaryStageName='extract'|'notes'|'structure'|'keywords'|'vectors'|'graph';
export interface DictionaryStage {
  state:'pending'|'running'|'ready'|'off'|'unavailable'|'error'|'stale';
  revision:string|null;detail:string|null;
}
export interface DictionaryJob {
  id:string;state:'queued'|'running'|'succeeded'|'partial'|'failed'|'cancelled'|'interrupted';
  reason:'startup'|'poll'|'manual'|'config'|'resume';
  revision:string|null;startedAt:string;finishedAt:string|null;
  done:number;total:number;stage:DictionaryStageName|null;error:string|null;
  /** Requests that arrived while this job ran and were folded into one follow-up run. */
  coalesced:number;
}
export interface DictionaryChanges {
  from:string|null;to:string;mode:'full'|'incremental';
  added:string[];modified:string[];deleted:string[];renamed:{from:string;to:string}[];
  reused:number;reread:number;reason:string;
}
/** Answer sufficiency, computed from the cited excerpts only (never from model confidence). */
export interface DocEvidence {
  support:'supported'|'insufficient';coverage:number;terms:string[];missing:string[];
}
export interface DocSearchResult {
  backend: 'keywords' | 'hybrid'; citations: DocCitation[]; warning: string | null;
  contextChars: number; candidateChars: number; budgetChars: number; indexedAt: string | null;
  /** Retrieval details (optional): graph expansion and de-duplication applied by Dictionary. */
  retrieval?:{expanded:number;deduplicated:number;generation:string|null;revision:string|null};
}
export interface DocAnswer extends DocSearchResult { mode: 'excerpts' | 'answer'; claims: {text:string;sources:string[]}[]; answerError?:string; evidence?:DocEvidence; }

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
  context: { vault: VaultStatus | null; graph: GraphStatus | null; docs?: DocsStatus | null;answer?:DictionaryStatus|null };
  design:DesignRevision|null;
  workflows: Record<string, Workflow>;
  workflowLinks?: Record<string, WorkflowLink>;
  reviews: Record<string, ReviewRecord>;
  merges: Record<string, IntegrationMerge>;
  /** Durable ordered release plans. Steps cannot be skipped. */
  releases: Record<string, ReleasePlan>;
  /** Last read-only code-host probe. Null until a check runs. */
  codeHost: CodeHostSnapshot | null;
  /** Last read-only infra probe. Null until a check runs. */
  infra: InfraHealthReport | null;
  skills?: Record<string, ProjectSkill>;
  connectors?: Record<string, Connector>;
  mocks?: Record<string, MockArtifact>;
  /** Designer studio jobs and capture attempts. Absent until the first studio event. */
  designStudio?: DesignStudioState;
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
    workflowLinks: {},
    reviews: {},
    merges: {},
    releases: {},
    codeHost: null,
    infra: null,
    skills: {},
    connectors: {},
    mocks: {},
  };
}

export function roleLabel(r: Role): string {
  return r === 'qa' ? 'QA' : r[0].toUpperCase() + r.slice(1);
}
