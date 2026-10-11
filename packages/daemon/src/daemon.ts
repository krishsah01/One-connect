// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The supervisor daemon. Every state change goes through commit(): validate → typed events →
// one SQLite transaction (events + tracker outbox + tail offsets) → shared reducer → broadcast.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Actor,
  AgentConfig,
  AgentState,
  Alert,
  Assignment,
  ControlCenterConfig,
  ControlState,
  EventEnvelope,
  NewEvent,
  RuleName,
  WorkItem,
} from '@acc/core';
import {
  applyEvent,
  AgentConfigSchema,
  parseConfig,
  KnowledgeConfigSchema,
  HUMAN,
  newId,
  redactDeep,
  redact,
  ruleEnabled,
  SYSTEM,
  type PreflightResult,
} from '@acc/core';
import { createTracker, type TrackerAdapter } from './adapters/trackers/index.ts';
import { ProjectDocker } from './docker.ts';
import { ProjectEnvironment } from './environment/workbench.ts';
import { IssueImports } from './imports.ts';
import { Team } from './team.ts';
import { Designer } from './designer.ts';
import { Decisions } from './decisions.ts';
import { decisionExecutors } from './decisionExecutors.ts';
import { AgentCosts } from './agentCosts.ts';
import { Settings, settingsConfig, type SettingsDraft } from './settings.ts';
import { Jev } from './jev.ts';
import { CodeHosts } from './adapters/hosts/index.ts';
import { InfraHealth } from './infra/health.ts';
import { ReleasePlans } from './release/plans.ts';
import { ReleaseFindings } from './release/findings.ts';
import { SubscriptionSafety } from './subscriptionSafety.ts';
import { AccountCompliance } from './accountCompliance.ts';
import { ReviewMerge } from './reviewMerge.ts';
import { WorkflowEngine } from './workflows.ts';
import { WorkflowLinks } from './workflowLinks.ts';
import { SkillLibrary } from './skills.ts';
import { Connectors } from './connectors.ts';
import { DesignMocks } from './mocks.ts';
import { RemoteAccess } from './phone/remote.ts';
import { Notifications } from './phone/notifications.ts';
import { Reports } from './phone/reports.ts';
import { ContextBenchmarks } from './benchmark/contextBenchmark.ts';
import { ContextSync } from './context/sync.ts';
import { allowedHosts, createEgress, type Egress } from './egress.ts';
import { WorktreeWatcher } from './adapters/vcs/watcher.ts';
import { McpBridge } from './mcpBridge.ts';
import { OutboxWorker, TrackerPoller } from './outbox.ts';
import { expandHome, resolveDataPaths, type DataPaths } from './paths.ts';
import { Rules } from './rules.ts';
import { RunManager } from './runManager.ts';
import { WorkService } from './workService.ts';
import { AgentService } from './agentService.ts';
import { EventStore, type OutboxOp } from './store/eventStore.ts';
import { CommandError } from './errors.ts';
import { VERSION } from './version.ts';
import type { AgentCommands, AssignmentInput, ChangeSet, ConfigCommands, IssueInput, Kernel, WorkCommands } from './kernel.ts';

export { VERSION } from './version.ts';

// Kept here so existing `from './daemon.ts'` imports keep working; new code imports the source.
export { CommandError } from './errors.ts';
export type { AssignmentInput, IssueInput } from './kernel.ts';

export interface DaemonOptions {
  config: ControlCenterConfig;
  dataDir?: string;
  allowTempDataDir?: boolean;
  /** Injected for tests (fake clock). */
  clock?: () => Date;
  tracker?: TrackerAdapter;
  /** Probe agents (auth, billing, models) on start. Default true. */
  probe?: boolean;
  rulesTickMs?: number;
  /** Login / confirmation / key-age watch interval; 0 disables it (tests). */
  accountWatchMs?: number;
  outboxTickMs?: number;
  supervisorPollMs?: number;
  /** Override where agent CLIs' env comes from (tests). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Underlying fetch behind the egress guard (tests inject a fake network). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export class Daemon implements Kernel, WorkCommands, AgentCommands, ConfigCommands {
  readonly opts: DaemonOptions;
  readonly paths: DataPaths;
  readonly store: EventStore;
  readonly bus = new EventEmitter();
  config: ControlCenterConfig;
  tracker: TrackerAdapter;
  state: ControlState;
  readonly workService: WorkService;
  readonly agentService: AgentService;
  readonly runs: RunManager;
  readonly rules: Rules;
  readonly outbox: OutboxWorker;
  readonly poller: TrackerPoller;
  readonly mcp: McpBridge;
  readonly watcher: WorktreeWatcher;
  context: ContextSync;
  readonly imports: IssueImports;
  readonly docker: ProjectDocker;
  readonly environment: ProjectEnvironment;
  readonly team: Team;
  readonly designer:Designer;
  readonly decisions: Decisions;
  readonly agentCosts: AgentCosts;
  readonly settings: Settings;
  readonly jev: Jev;
  readonly subscriptionSafety: SubscriptionSafety;
  readonly accounts: AccountCompliance;
  readonly reviewMerge: ReviewMerge;
  readonly workflows: WorkflowEngine;
  readonly workflowLinks: WorkflowLinks;
  readonly skillLib: SkillLibrary;
  readonly connectors: Connectors;
  readonly mocks: DesignMocks;
  /** Phone access, notification routing, Brief & Reports and the context benchmark (packages/daemon/src/phone, benchmark). */
  readonly remote: RemoteAccess;
  readonly notifications: Notifications;
  readonly reports: Reports;
  readonly benchmarks: ContextBenchmarks;
  /** Read-only GitHub/GitLab protection and CI. */
  readonly hosts: CodeHosts;
  /** Read-only Docker, Postgres, Vercel and migration drift. */
  readonly infra: InfraHealth;
  /** Ordered release plans. Step approval reuses Decisions.answerAtomic. */
  readonly releasePlans: ReleasePlans;
  /** Failing CI, unprotected branches and migration drift, linked through the tracker outbox. */
  readonly findings: ReleaseFindings;
  /** All outbound HTTP from the daemon: only configured connections are reachable. */
  readonly egress: Egress;
  /** Base URL of the HTTP server, used by the per-run MCP bridge. */
  url: string | null = null;
  private secretValues = new Set<string>();
  private sinceSnapshot = 0;
  private started = false;
  private publishingEvents=false;
  private eventBatches:EventEnvelope[][]=[];
  closed = false;
  /** The startup probe of every enabled agent (login, billing, models, binary signature). */
  initialProbe: Promise<void> = Promise.resolve();

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.paths = resolveDataPaths(opts.dataDir, { allowTemp: opts.allowTempDataDir });
    this.store = new EventStore(this.paths.db);
    const savedSettings = this.store.kvGet('project:settings');
    if (savedSettings) {
      const settings = JSON.parse(savedSettings) as SettingsDraft;
      if (settings.project.repo !== this.config.project.repo) throw new CommandError('Saved settings belong to another repository.');
      this.config = settingsConfig(this.config, settings);
    }
    const savedAgents=this.store.kvGet('agents:overrides');
    if(savedAgents) {
      const overrides=Object.values(JSON.parse(savedAgents)).map(a=>AgentConfigSchema.parse(a));
      const merged=new Map(this.config.agents.map(a=>[a.id,a]));
      for(const a of overrides) merged.set(a.id,a);
      this.config=parseConfig({...this.config,agents:[...merged.values()]});
    }
    const savedKnowledge = this.store.kvGet('knowledge:config');
    if (savedKnowledge) this.config = { ...this.config, knowledge: KnowledgeConfigSchema.parse(JSON.parse(savedKnowledge)) };
    this.state = this.store.loadState(applyEvent);
    this.bus.setMaxListeners(200);
    this.egress = createEgress(this.config, opts.fetch);
    this.tracker = opts.tracker ?? createTracker(this.config.tracker, { dataDir: this.paths.root, onSecret: (v) => this.addSecret(v), fetch: this.egress.fetch });
    this.workService = new WorkService(this);
    this.agentService = new AgentService(this);
    this.watcher = new WorktreeWatcher((assignmentId) => void this.runs.refreshDiff(assignmentId));
    this.runs = new RunManager(this);
    this.rules = new Rules(this);
    this.outbox = new OutboxWorker(this);
    this.poller = new TrackerPoller(this);
    this.mcp = new McpBridge(this);
    this.context = new ContextSync(this);
    this.imports = new IssueImports(this);
    this.docker = new ProjectDocker(this);
    this.environment = new ProjectEnvironment(this);
    this.team = new Team(this);
    this.designer=new Designer(this);
    this.decisions = new Decisions(this);
    this.agentCosts = new AgentCosts(this);
    this.settings = new Settings(this);
    this.jev = new Jev(this);
    this.subscriptionSafety = new SubscriptionSafety(this);
    this.accounts = new AccountCompliance(this);
    this.reviewMerge = new ReviewMerge(this);
    this.workflows = new WorkflowEngine(this);
    this.workflowLinks = new WorkflowLinks(this);
    this.skillLib = new SkillLibrary(this);
    this.connectors = new Connectors(this);
    // MCP transports belong to individual calls, not to the detached agent runner. Stop them
    // before runner shutdown can wait on a vendor; keep this hook scoped to this project engine.
    this.runs.onBeforeStop((runId) => this.connectors.toolActions.stopRun(runId));
    this.mocks = new DesignMocks(this);
    this.remote = new RemoteAccess(this);
    this.notifications = new Notifications(this);
    this.egress.authorizeNotification = (token, url, init) => this.notifications.takeEgressPermit(token, url, init);
    this.reports = new Reports(this);
    this.benchmarks = new ContextBenchmarks(this);
    this.hosts = new CodeHosts(this);
    this.infra = new InfraHealth(this);
    this.releasePlans = new ReleasePlans(this);
    this.findings = new ReleaseFindings(this);
    this.decisions.register(...decisionExecutors(this));
    this.refreshEgress();
  }

  now(): Date {
    return this.opts.clock ? this.opts.clock() : new Date();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const name of this.config.policies.redact_env) {
      const v = this.baseEnv()[name];
      if (v) this.addSecret(v);
    }
    this.commit([{ type: 'daemon.started', data: { version: VERSION, pid: process.pid } }]);
    this.syncConfig();
    try {
      await this.tracker.init();
    } catch (e) {
      this.alert({ kind: 'tracker_out_of_sync', severity: 'critical', message: `tracker ${this.tracker.target} failed to initialize: ${(e as Error).message}`, dedupeKey: 'tracker-init' });
    }
    if (this.tracker.type !== 'local') {
      if (this.tracker.live && this.store.kvGet(`tracker-live:${this.tracker.target}`) !== '1') {
        // Enabling a live tracker in config is the owner's standing approval for issue, status and
        // comment writes to that tracker. Recorded once, as an auditable event.
        this.commit([{ type: 'tracker.live_enabled', actor: HUMAN, data: { type: this.tracker.type, target: this.tracker.target } }]);
        this.store.kvSet(`tracker-live:${this.tracker.target}`, '1');
      }
      if (!this.tracker.live) this.alert({ kind: 'tracker_not_live', severity: 'warn', message: `${this.tracker.target} is in dry-run: nothing is sent until you set tracker.live: true`, dedupeKey: 'tracker-not-live' });
    }
    this.runs.recoverAll();
    this.reviewMerge.start();
    this.workflows.start();
    this.workflowLinks.start();
    this.team.start();
    this.runs.supervisor.start();
    this.rules.start(this.opts.rulesTickMs ?? 15_000);
    if (this.opts.accountWatchMs !== 0) this.accounts.start(this.opts.accountWatchMs ?? 15 * 60_000);
    this.outbox.start(this.opts.outboxTickMs ?? 1500);
    if (this.tracker.live) this.poller.start();
    this.context.start();
    this.designer.studio.start();
    this.remote.start();
    this.notifications.start();
    if (this.opts.probe !== false) this.initialProbe = this.probeAll();
  }

  async shutdown(): Promise<void> {
    // Every step is isolated: one failing service must never leave the event store open or
    // unsnapshotted. Failures are reported together once everything that can stop has stopped.
    const failures: string[] = [];
    const step = async (name: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`);
      }
    };
    await step('connector tools', () => this.connectors.toolActions.close());
    await step('workflow links', () => this.workflowLinks.stop());
    await step('workflows', () => this.workflows.stop());
    await step('designer studio', () => this.designer.studio.close());
    await step('review/merge', () => this.reviewMerge.stop());
    await step('rules', () => this.rules.stop());
    await step('accounts', () => this.accounts.stop());
    await step('outbox', () => this.outbox.stop());
    await step('tracker poller', () => this.poller.stop());
    await step('run supervisor', () => this.runs.supervisor.stopPolling());
    await step('worktree watcher', () => this.watcher.closeAll());
    await step('context sync', () => this.context.stop());
    await step('team', () => this.team.stop());
    await step('notifications', () => this.notifications.stop());
    await step('remote access', () => this.remote.shutdown());
    await step('environment', () => this.environment.close());
    await step('context flush', () => this.context.flush());
    await step('context answers', () => this.context.answer.close());
    await step('context docs', () => this.context.docs?.close());
    // Let in-flight finalizers/checks land (bounded), then refuse further writes.
    let finalizerTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.runs.inflight]), new Promise((r) => { finalizerTimeout = setTimeout(r, 20_000); })]);
    } finally {
      if (finalizerTimeout) clearTimeout(finalizerTimeout);
    }
    this.closed = true;
    // Agent runs keep going: they are detached and reattached on the next start.
    await step('snapshot', () => this.store.saveSnapshot(this.state));
    await step('event store', () => this.store.close());
    await step('tracker', () => (this.tracker as { close?: () => void }).close?.());
    this.started = false;
    if (failures.length) throw new Error(`shutdown finished with errors: ${failures.join('; ')}`);
  }

  /** Bring agents/project/policies in the event log in line with control-center.yaml. */
  async connectKnowledge(input: unknown): Promise<void> {
    const parsed = KnowledgeConfigSchema.safeParse(input);
    if (!parsed.success) throw new CommandError(parsed.error.message);
    const cfg = parsed.data;
    cfg.vault = path.resolve(expandHome(cfg.vault));
    if (!fs.existsSync(cfg.vault) || !fs.statSync(cfg.vault).isDirectory()) throw new CommandError('Choose an existing markdown vault folder');
    const busy = this.context.docs?.status();
    if (busy?.indexing || busy?.searching || this.context.answer.busy) throw new CommandError('Wait for the current project indexing or document query to finish', 409);
    this.context.stop();
    await this.context.answer.close();
    await this.context.docs?.close();
    this.config = { ...this.config, knowledge: cfg };
    this.store.kvSet('knowledge:config', JSON.stringify(cfg));
    this.context = new ContextSync(this);
    this.commit([
      {type:'context.connected',actor:HUMAN,data:{vault:cfg.vault,folders:this.context.vault!.readableFolders(),semantic:cfg.search.semantic}},
      {type:'context.docs',actor:HUMAN,data:{status:this.context.docs!.status()}},
      {type:'context.vault',actor:HUMAN,data:{status:this.context.vault!.status()}},
    ]);
    this.context.start();
  }

  /** Recreate revision-bound retrieval after an approved integration-branch or graph change. */
  async reloadContext(): Promise<void> {
    const previous = this.context;
    previous.stop();
    await previous.answer.close();
    await previous.docs?.close();
    this.context = new ContextSync(this);
    this.commit([
      { type: 'context.answer', actor: HUMAN, data: { status: this.context.answer.status } },
      { type: 'context.graph', actor: HUMAN, data: { status: this.context.graph?.status ?? { state: 'unavailable', sha: null, builtAt: null, nodes: 0, edges: 0, durationMs: null, graphPath: null, semantic: false, error: 'Graphify is disabled in this project.' } } },
    ]);
    this.context.start();
  }

  syncConfig(): void {
    const c = this.config;
    const events: NewEvent[] = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(this.state.project, c.project) || !same(this.state.tracker, c.tracker) || !same(this.state.policies, c.policies)) {
      events.push({ type: 'config.loaded', data: { project: c.project, tracker: c.tracker, policies: c.policies } });
    }
    for (const a of c.agents) if (!same(this.state.agents[a.id]?.config, a)) events.push({ type: 'agent.registered', agentId: a.id, data: { config: a } });
    for (const id of Object.keys(this.state.agents)) if (!c.agents.some((a) => a.id === id)) events.push({ type: 'agent.removed', agentId: id, data: {} });
    this.commit(events);
  }

  /** Configured hosts plus hosts of connections a human activated. */
  refreshEgress(): void {
    this.egress.allowed.splice(0,this.egress.allowed.length,...new Set([...allowedHosts(this.config),...this.connectors.hosts(),...this.jev.hosts(),...(this.notifications?.hosts() ?? [])]));
  }

  /** Text with every known secret value replaced. */
  redactText(text: string): string { return redact(text, { denylist: this.denylist() }).text; }

  // ---- event plumbing ----------------------------------------------------------------------

  addSecret(v: string): void {
    if (v && v.length >= 6) this.secretValues.add(v);
  }

  denylist(): string[] {
    return [...this.secretValues];
  }

  commit(events: NewEvent[], outbox: OutboxOp[] = [], inTx?: () => void): EventEnvelope[] {
    if (this.closed) return [];
    if (events.length === 0 && outbox.length === 0 && !inTx) return [];
    const deny = { denylist: this.denylist() };
    const clean = events.map((e) => ({ ...e, ts: e.ts ?? this.nowIso(), data: redactDeep(e.data, deny) }) as NewEvent);
    const stored = this.store.append(clean, outbox.map((o) => ({ ...o, payload: redactDeep(o.payload, deny) })), { now: () => this.nowIso(), inTx });
    for (const e of stored) this.state = applyEvent(this.state, e);
    this.sinceSnapshot += stored.length;
    if (this.sinceSnapshot >= 500) {
      this.store.saveSnapshot(this.state);
      this.sinceSnapshot = 0;
    }
    // A listener may commit synchronously. Persist/apply it immediately, but finish delivering
    // the earlier batch to every listener before publishing the nested batch.
    if(stored.length)this.eventBatches.push(stored);
    if(!this.publishingEvents){
      this.publishingEvents=true;
      try{
        let batch:EventEnvelope[]|undefined;
        while((batch=this.eventBatches.shift())){
          this.bus.emit('events',batch);
          for(const e of batch)this.rules.onEvent(e);
        }
      }finally{this.publishingEvents=false;}
    }
    return stored;
  }

  alert(a: Omit<Alert, 'id' | 'createdAt' | 'resolvedAt' | 'resolution'>): Alert | null {
    const open = Object.values(this.state.alerts).find((x) => x.dedupeKey === a.dedupeKey && !x.resolvedAt);
    if (open) return null;
    const alert: Alert = { ...a, id: newId('al'), createdAt: this.nowIso(), resolvedAt: null, resolution: null };
    this.commit([{ type: 'alert.raised', agentId: a.agentId ?? null, runId: a.runId ?? null, workItemId: a.workItemId ?? null, data: { alert } }]);
    return alert;
  }

  resolveAlerts(pred: (a: Alert) => boolean, resolution: string, actor: Actor = SYSTEM): void {
    const events: NewEvent[] = Object.values(this.state.alerts)
      .filter((a) => !a.resolvedAt && pred(a))
      .map((a) => ({ type: 'alert.resolved', actor, agentId: a.agentId ?? null, runId: a.runId ?? null, workItemId: a.workItemId ?? null, data: { alertId: a.id, resolution } }));
    this.commit(events);
  }

  ruleOn(rule: RuleName): boolean {
    return this.state.rules[rule] ?? ruleEnabled(this.config.policies, rule);
  }

  // ---- commands: issues & assignments (WorkService) and agents (AgentService) -------------------
  // The daemon is the facade the HTTP layer, the CLI and tests use; the commands live in the services.

  createIssue(input: IssueInput, actor?: Actor): WorkItem { return this.workService.createIssue(input, actor); }
  buildIssue(...args: Parameters<WorkCommands['buildIssue']>): ReturnType<WorkCommands['buildIssue']> { return this.workService.buildIssue(...args); }
  createAssignment(input: AssignmentInput, actor?: Actor): Assignment { return this.workService.createAssignment(input, actor); }
  updateAssignment(...args: Parameters<WorkCommands['updateAssignment']>): Assignment { return this.workService.updateAssignment(...args); }
  cancelAssignment(assignmentId: string, actor?: Actor): void { this.workService.cancelAssignment(assignmentId, actor); }
  assignmentText(a: Assignment, relay?: boolean): string { return this.workService.assignmentText(a, relay); }
  preflight(assignmentId: string, record?: boolean): PreflightResult { return this.workService.preflight(assignmentId, record); }
  dispatch(...args: Parameters<WorkCommands['dispatch']>): ReturnType<WorkCommands['dispatch']> { return this.workService.dispatch(...args); }
  quickTask(...args: Parameters<WorkService['quickTask']>): ReturnType<WorkService['quickTask']> { return this.workService.quickTask(...args); }
  agentFree(agentId: string): boolean { return this.workService.agentFree(agentId); }
  setQueue(agentId: string, next: string[], actor?: Actor): void { this.workService.setQueue(agentId, next, actor); }
  reassign(assignmentId: string, toAgentId: string, actor?: Actor): void { this.workService.reassign(assignmentId, toAgentId, actor); }
  transition(...args: Parameters<WorkCommands['transition']>): ChangeSet { return this.workService.transition(...args); }
  safeTransition(...args: Parameters<WorkCommands['safeTransition']>): ChangeSet { return this.workService.safeTransition(...args); }
  tryTransition(...args: Parameters<WorkCommands['tryTransition']>): boolean { return this.workService.tryTransition(...args); }

  validateAgentSettings(input: unknown, expected?: unknown): { cfg: AgentConfig; next: ControlCenterConfig } { return this.agentService.validateAgentSettings(input, expected); }
  saveAgent(...args: Parameters<AgentCommands['saveAgent']>): AgentState { return this.agentService.saveAgent(...args); }
  probeAll(): Promise<void> { return this.agentService.probeAll(); }
  probe(agentId: string): Promise<void> { return this.agentService.probe(agentId); }
  spentToday(agentId: string): number { return this.agentService.spentToday(agentId); }
  resolveModelFor(agentId: string): { model: string | null; newest: string | null } { return this.agentService.resolveModelFor(agentId); }
  swapModel(agentId: string, model: string, actor?: Actor): void { this.agentService.swapModel(agentId, model, actor); }
  resumeAgent(agentId: string, actor?: Actor): void { this.agentService.resumeAgent(agentId, actor); }

  // ---- commands: control -------------------------------------------------------------------

  setRule(rule: RuleName, enabled: boolean, actor: Actor = HUMAN): void {
    this.commit([{ type: 'rule.toggled', actor, data: { rule, enabled } }]);
  }

  async setKillSwitch(engaged: boolean, actor: Actor = HUMAN): Promise<number> {
    this.commit([{ type: 'kill_switch.set', actor, data: { engaged } }]);
    if (!engaged) {
      for (const id of Object.keys(this.state.agents)) void this.rules.refill(id);
      return 0;
    }
    await this.connectors.toolActions.stopAll();
    const active = Object.values(this.state.runs).filter((r) => ['queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input', 'stalled'].includes(r.state));
    await Promise.all(active.map((r) => this.runs.stop(r.id, 'kill switch', actor, 'killed')));
    return active.length;
  }

  resolveAlert(alertId: string, resolution = 'dismissed', actor: Actor = HUMAN): void {
    if (!this.state.alerts[alertId]) throw new CommandError(`unknown alert ${alertId}`, 404);
    this.resolveAlerts((a) => a.id === alertId, resolution, actor);
  }

  resolveApproval(approvalId: string, decision: string, channel: string, actor: Actor = HUMAN): void {
    const ap = this.state.approvals[approvalId];
    if (!ap) throw new CommandError(`unknown approval ${approvalId}`, 404);
    if (ap.resolvedAt) throw new CommandError('already answered', 409);
    this.commit([{ type: 'approval.resolved', actor, agentId: ap.agentId, runId: ap.runId, workItemId: ap.workItemId, data: { approvalId, decision, by: actor.id, channel } }]);
    this.resolveAlerts((a) => a.dedupeKey === `approval:${approvalId}`, `answered: ${decision}`, actor);
  }
}
