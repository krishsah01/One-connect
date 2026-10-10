// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The supervisor daemon. Every state change goes through commit(): validate → typed events →
// one SQLite transaction (events + tracker outbox + tail offsets) → shared reducer → broadcast.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  Actor,
  Alert,
  Assignment,
  ControlCenterConfig,
  ControlState,
  EventEnvelope,
  LifecycleState,
  NewEvent,
  RuleName,
  WorkItem,
} from '@acc/core';
import {
  applyEvent,
  AgentConfigSchema,
  containsSecret,
  parseConfig,
  sharedCapacity,
  subscriptionPeers,
  canTransition,
  DEFAULT_ASK_HUMAN_IF,
  DEFAULT_TRACKER_CATEGORY,
  generateAssignmentText,
  HANDOFF_TEMPLATE,
  KnowledgeConfigSchema,
  HUMAN,
  newId,
  redactDeep,
  redact,
  resolveModel,
  ruleEnabled,
  runPreflight,
  SYSTEM,
  transitionPath,
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
import { AgentCosts, needsCostApproval } from './agentCosts.ts';
import type { AnswerOptions } from './decisions.ts';
import { Settings, settingsConfig, type SettingsDraft } from './settings.ts';
import { Jev } from './jev.ts';
import { CodeHosts } from './adapters/hosts/index.ts';
import { InfraHealth } from './infra/health.ts';
import { ReleasePlans } from './release/plans.ts';
import { ReleaseFindings } from './release/findings.ts';
import { SubscriptionSafety } from './subscriptionSafety.ts';
import { ReviewMerge } from './reviewMerge.ts';
import { WorkflowEngine } from './workflows.ts';
import { WorkflowLinks } from './workflowLinks.ts';
import { workflowPrompt } from './workflowOptions.ts';
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
import { probeAgent } from './probe.ts';
import { Rules } from './rules.ts';
import { RunManager } from './runManager.ts';
import { EventStore, type OutboxOp } from './store/eventStore.ts';

export const VERSION = '0.1.0';

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
  outboxTickMs?: number;
  supervisorPollMs?: number;
  /** Override where agent CLIs' env comes from (tests). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Underlying fetch behind the egress guard (tests inject a fake network). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

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

export class CommandError extends Error {
  status: number;
  /** Structured validation problems (e.g. workflow issues), returned to the client as-is. */
  issues?: unknown[];
  constructor(message: string, status = 400, issues?: unknown[]) {
    super(message);
    this.status = status;
    if (issues) this.issues = issues;
  }
}

export class Daemon {
  readonly opts: DaemonOptions;
  readonly paths: DataPaths;
  readonly store: EventStore;
  readonly bus = new EventEmitter();
  config: ControlCenterConfig;
  tracker: TrackerAdapter;
  state: ControlState;
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
    this.outbox.start(this.opts.outboxTickMs ?? 1500);
    if (this.tracker.live) this.poller.start();
    this.context.start();
    this.designer.studio.start();
    this.remote.start();
    this.notifications.start();
    if (this.opts.probe !== false) void this.probeAll();
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

  /** Validate a builder draft without saving, probing a provider or dispatching work. */
  validateAgentSettings(input:unknown,expected:unknown=null) {
    const parsed=AgentConfigSchema.safeParse(input);
    if(!parsed.success) throw new CommandError(parsed.error.message);
    const cfg=parsed.data,previous=this.state.agents[cfg.id];
    if(cfg.skills.some(id=>!this.skillLib.assignable(id))) throw new CommandError('Choose skills from the installed catalog or a published, enabled project skill.');
    if(previous) {
      const old=AgentConfigSchema.safeParse(expected);
      if(!old.success || !isDeepStrictEqual(old.data,previous.config)) throw new CommandError('Agent settings changed. Reopen the builder to use the latest settings.',409);
      if(previous.activeRunIds.length || previous.queue.now || previous.queue.next.length) throw new CommandError('Finish or cancel this agent’s Now and Next assignments before editing it.',409);
    } else if(expected!==null) throw new CommandError('This agent no longer exists. Reopen the builder.',409);
    if(containsSecret(JSON.stringify(cfg),{denylist:this.denylist()}).length) throw new CommandError('Remove credentials from agent settings. Use vendor login or the dedicated connection store.');
    const next=parseConfig({...this.config,agents:previous?this.config.agents.map(a=>a.id===cfg.id?cfg:a):[...this.config.agents,cfg]});
    return {cfg,next};
  }

  /** The exact cost answer, settings and override commit together; no boolean paid-mode bypass. */
  saveAgent(input:unknown,expected:unknown=null,o:{costDecisionId?:string;answerOptions?:AnswerOptions}={}) {
    const {cfg,next}=this.validateAgentSettings(input,expected);
    let approval:{events:NewEvent[];transaction:()=>void}|undefined;
    if(needsCostApproval(cfg)) {
      if(!o.costDecisionId) throw new CommandError('Paid agents require a reviewed per-agent cost Decision.');
      approval=this.agentCosts.authorize(o.costDecisionId,cfg,expected,o.answerOptions??{});
    }
    const overrides=JSON.parse(this.store.kvGet('agents:overrides')??'{}') as Record<string,unknown>;
    const oldConfig=this.config;
    this.config=next;
    try {
      this.commit([...(approval?.events??[]),{type:'agent.registered',actor:HUMAN,agentId:cfg.id,data:{config:cfg}}],[],()=>{approval?.transaction();this.store.kvSet('agents:overrides',JSON.stringify({...overrides,[cfg.id]:cfg}));});
    } catch(e) {this.config=oldConfig;throw e;}
    this.refreshEgress();
    return this.state.agents[cfg.id];
  }

  /** Configured hosts plus hosts of connections a human activated. */
  refreshEgress(): void {
    this.egress.allowed.splice(0,this.egress.allowed.length,...new Set([...allowedHosts(this.config),...this.connectors.hosts(),...this.jev.hosts(),...(this.notifications?.hosts() ?? [])]));
  }

  async probeAll(): Promise<void> {
    await Promise.all(Object.values(this.state.agents).filter(a=>a.config.enabled!==false).map((a) => this.probe(a.id).catch(() => undefined)));
  }

  async probe(agentId: string): Promise<void> {
    const agent = this.state.agents[agentId];
    if (!agent) throw new CommandError(`unknown agent ${agentId}`, 404);
    if(agent.config.enabled===false) throw new CommandError('Enable this saved agent before checking its runtime.',409);
    const r = await probeAgent(agent, this.baseEnv(), this.runs.sessionIdsFor(agentId), this.egress.fetch);
    if(this.closed || JSON.stringify(this.state.agents[agentId]?.config)!==JSON.stringify(agent.config)) return;
    this.commit([{ type: 'agent.probed', agentId, data: r }]);
    const a = this.state.agents[agentId];
    const open = (k: string) => `${agentId}:${k}`;
    if (a.config.adapter !== 'relay' && (a.auth.state === 'expired' || a.auth.state === 'not_installed')) {
      this.alert({ kind: 'auth', severity: 'critical', agentId, message: `${a.config.name}: ${a.auth.state.replace('_', ' ')}${a.auth.fix ? `: ${a.auth.fix}` : ''}`, dedupeKey: open('auth') });
    } else this.resolveAlerts((x) => x.dedupeKey === open('auth'), 'signed in');
    if (a.billing.mode === 'metered' && !a.config.metered_opt_in) {
      this.alert({ kind: 'billing', severity: 'critical', agentId, message: `${a.config.name} would bill per token (${a.billing.source}). Dispatch is blocked; fix the login or opt in explicitly.`, dedupeKey: open('billing') });
    } else this.resolveAlerts((x) => x.dedupeKey === open('billing'), 'subscription billing');
    if (r.newerBinary) {
      this.alert({ kind: 'binary_changed', severity: 'info', agentId, message: `${a.config.name}: a newer CLI exists at ${r.newerBinary.path} (${r.newerBinary.version}${r.newerBinary.prerelease ? ', prerelease' : ''}) than the pinned ${a.binary?.path} (${a.binary?.version}). Pin it with \`binary:\` if you want it.`, dedupeKey: open(`newer-binary:${r.newerBinary.path}:${r.newerBinary.version}`) });
    }
    const resolved = this.resolveModelFor(agentId);
    if (resolved.newest && a.config.model !== 'newest' && resolved.newest !== a.config.model && this.config.policies.newest_model_rule) {
      this.alert({ kind: 'model', severity: 'warn', agentId, message: `${a.config.name} is configured for ${a.config.model}; ${resolved.newest} is newer`, dedupeKey: open(`model:${resolved.newest}`) });
    }
  }

  /** Metered spend recorded today (local day) for one agent. */
  redactText(text: string): string { return redact(text, { denylist: this.denylist() }).text; }

  spentToday(agentId: string): number {
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    let sum = 0;
    for (const r of Object.values(this.state.runs)) if (r.agentId === agentId && Date.parse(r.createdAt) >= start.getTime()) sum += r.usage.costUsd ?? 0;
    return sum;
  }

  resolveModelFor(agentId: string): { model: string | null; newest: string | null } {
    const a = this.state.agents[agentId];
    return a ? resolveModel(a, this.config.policies) : { model: null, newest: null };
  }

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

  /** Events + outbox for a lifecycle transition; throws CommandError if it isn't allowed. */
  transition(itemId: string, to: LifecycleState, reason: string, actor: Actor = SYSTEM, blockedOn?: WorkItem['blockedOn']): { events: NewEvent[]; outbox: OutboxOp[] } {
    const item = this.state.workItems[itemId];
    if (!item) throw new CommandError(`unknown work item ${itemId}`, 404);
    if (item.state === to) return { events: [], outbox: [] };
    const ctx = { evidence: item.evidence, requiresProductionVerification: item.requiresProductionVerification };
    const direct = canTransition(item.state, to, ctx);
    // Not a direct hop (e.g. backlog → running): walk the shortest valid path so every
    // intermediate state is recorded too.
    const path = direct.ok ? [to] : to === 'verified' ? null : transitionPath(item.state, to);
    if (!path) throw new CommandError(`${item.key ?? item.id}: ${direct.ok ? 'unreachable' : direct.reason}`, 409);
    if (!direct.ok) {
      const final = canTransition(path.length > 1 ? path[path.length - 2] : item.state, to, ctx);
      if (!final.ok) throw new CommandError(`${item.key ?? item.id}: ${final.reason}`, 409);
    }
    const events: NewEvent[] = [];
    let from = item.state;
    for (const step of path) {
      events.push({ type: 'work_item.transitioned', actor, workItemId: itemId, data: { from, to: step, reason, blockedOn: step === 'blocked' ? (blockedOn ?? null) : null } });
      from = step;
    }
    const outbox: OutboxOp[] = [];
    const trackerWritable = !(item.origin?.localMirror === true && !item.trackerId);
    if (trackerWritable && DEFAULT_TRACKER_CATEGORY[item.state] !== DEFAULT_TRACKER_CATEGORY[to]) {
      outbox.push({ workItemId: itemId, op: 'set_status', payload: { category: DEFAULT_TRACKER_CATEGORY[to], lifecycle: to } });
    }
    return { events, outbox };
  }

  /** Transition if allowed; returns false instead of throwing. */
  tryTransition(itemId: string, to: LifecycleState, reason: string, extra: NewEvent[] = [], extraOutbox: OutboxOp[] = [], actor: Actor = SYSTEM, blockedOn?: WorkItem['blockedOn']): boolean {
    try {
      const t = this.transition(itemId, to, reason, actor, blockedOn);
      this.commit([...extra, ...t.events], [...extraOutbox, ...t.outbox]);
      return true;
    } catch {
      this.commit(extra, extraOutbox);
      return false;
    }
  }

  ruleOn(rule: RuleName): boolean {
    return this.state.rules[rule] ?? ruleEnabled(this.config.policies, rule);
  }

  // ---- commands: issues & assignments ------------------------------------------------------

  createIssue(input: IssueInput, actor: Actor = HUMAN): WorkItem {
    const { item, events, outbox } = this.buildIssue(input, actor);
    this.commit(events, outbox);
    this.outbox.kick();
    return this.state.workItems[item.id];
  }

  /** Events + outbox for a new issue, so callers can create it atomically with other changes. */
  buildIssue(input: IssueInput, actor: Actor = HUMAN, o?: { mirror?: boolean; bind?: { trackerId: string; key: string; url: string | null; trackerStatus: WorkItem['trackerStatus'] } }): { item: WorkItem; events: NewEvent[]; outbox: OutboxOp[] } {
    const title = input.title?.trim();
    if (!title) throw new CommandError('title is required');
    const now = this.nowIso();
    const item: WorkItem = {
      id: newId('wi'),
      key: o?.bind?.key ?? null,
      trackerId: o?.bind?.trackerId ?? null,
      url: o?.bind?.url ?? null,
      title,
      description: input.description?.trim() ?? '',
      acceptance: (input.acceptance ?? []).map((a) => a.trim()).filter(Boolean),
      labels: input.labels ?? [],
      priority: input.priority ?? 3,
      parentKey: input.parentKey ?? null,
      blockedBy: [],
      state: 'backlog',
      blockedOn: null,
      resumeTo: null,
      ownerAgentId: null,
      assignmentIds: [],
      runIds: [],
      branches: [],
      evidence: [],
      requiresProductionVerification: input.requiresProductionVerification ?? false,
      trackerStatus: o?.bind?.trackerStatus ?? null,
      sync: o?.bind
        ? { status: 'synced', lastError: null, at: now }
        : o?.mirror
          ? { status: 'dry_run', lastError: 'Local mirror only; the authoritative tracker was not written.', at: now }
          : { status: 'pending', lastError: null, at: null },
      createdAt: now,
      updatedAt: now,
    };
    return {
      item,
      events: [{ type: 'work_item.created', actor, workItemId: item.id, data: { item } }],
      outbox: o?.bind || o?.mirror ? [] : [{ workItemId: item.id, op: 'create_issue', payload: { title: item.title, description: item.description, acceptance: item.acceptance, labels: item.labels, priority: item.priority, ...(item.parentKey ? { parentKey: item.parentKey } : {}) } }],
    };
  }

  createAssignment(input: AssignmentInput, actor: Actor = HUMAN): Assignment {
    const item = this.state.workItems[input.workItemId];
    if (!item) throw new CommandError(`unknown work item ${input.workItemId}`, 404);
    const agent = this.state.agents[input.agentId];
    if (!agent) throw new CommandError(`unknown agent ${input.agentId}`, 404);
    const relay = agent.config.adapter === 'relay';
    const requiredChecks = input.requiredChecks ?? this.config.project.required_checks ?? Object.keys(this.config.project.checks);
    const a: Assignment = {
      id: newId('as'),
      workItemId: item.id,
      agentId: agent.id,
      position: 'draft',
      scope: input.scope ?? '',
      allowedPaths: input.allowedPaths ?? [],
      worktree: null,
      branch: null,
      baseRef: input.baseRef ?? this.config.project.integration_branch,
      baseSha: null,
      requiredChecks,
      askHumanIf: input.askHumanIf ?? DEFAULT_ASK_HUMAN_IF,
      handoffFormat: HANDOFF_TEMPLATE,
      designRevision:this.state.design?.hash??null,
      skills: this.skillLib.freeze(agent.id, item.id),
      prompt: '',
      promptEdited: false,
      model: input.model ?? null,
      effort: agent.config.effort ?? null,
      preflight: null,
      createdAt: this.nowIso(),
      dispatchedAt: null,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.review ? { review: input.review } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId, taskId: input.taskId ?? null } : {}),
    };
    a.prompt = this.assignmentText(a, relay);
    this.commit([{ type: 'assignment.created', actor, agentId: a.agentId, workItemId: a.workItemId, assignmentId: a.id, data: { assignment: a } }]);
    return this.state.assignments[a.id];
  }

  assignmentText(a: Assignment, relay = this.state.agents[a.agentId]?.config.adapter === 'relay'): string {
    const item = this.state.workItems[a.workItemId];
    const agent = this.state.agents[a.agentId];
    if (a.kind === 'review' && a.review) return this.reviewMerge.reviewText(a, relay) + this.designer.prompt(a) + workflowPrompt(a);
    return generateAssignmentText({
      project: this.config.project,
      agent: agent.config,
      item,
      assignmentId: a.id,
      scope: a.scope,
      allowedPaths: a.allowedPaths,
      worktree: a.worktree,
      branch: a.branch,
      baseRef: a.baseRef,
      requiredChecks: a.requiredChecks,
      askHumanIf: a.askHumanIf,
      relay,
      context: this.context?.templateContext(),
    })+this.connectors.promptNote(item)+this.designer.prompt(a)+workflowPrompt(a);
  }

  updateAssignment(id: string, patch: Partial<Pick<Assignment, 'prompt' | 'scope' | 'allowedPaths' | 'requiredChecks' | 'askHumanIf' | 'model' | 'effort'>>, actor: Actor = HUMAN): Assignment {
    const a = this.state.assignments[id];
    if (!a) throw new CommandError(`unknown assignment ${id}`, 404);
    if (a.position === 'done' || a.position === 'canceled') throw new CommandError(`assignment is ${a.position}`, 409);
    const next = { ...a, ...patch };
    const promptEdited = patch.prompt !== undefined ? patch.prompt !== this.assignmentText({ ...next, prompt: '' }) : a.promptEdited;
    const prompt = patch.prompt ?? (a.promptEdited ? a.prompt : this.assignmentText(next));
    this.commit([{ type: 'assignment.updated', actor, assignmentId: id, agentId: a.agentId, workItemId: a.workItemId, data: { patch: { ...patch, prompt, promptEdited } } }]);
    return this.state.assignments[id];
  }

  preflight(assignmentId: string, record = true): PreflightResult {
    const a = this.state.assignments[assignmentId];
    if (!a) throw new CommandError(`unknown assignment ${assignmentId}`, 404);
    const agent = this.state.agents[a.agentId];
    const active = Object.values(this.state.assignments).filter((x) => x.id !== a.id && x.position === 'now');
    const result = runPreflight({
      now: this.nowIso(),
      item: this.state.workItems[a.workItemId],
      assignment: a,
      agent:agent?{...agent,...sharedCapacity(this.state.agents,agent.id)}:agent,
      project: this.config.project,
      policies: this.config.policies,
      killSwitch: this.state.killSwitch.engaged,
      activeAssignments: active,
      binaryCheck: agent ? this.runs.binaryCheck(agent) : undefined,
      denylist: this.denylist(),
      spentTodayUsd: agent ? this.spentToday(agent.id) : 0,
      subscriptionConfirmation: agent ? this.subscriptionSafety.status(agent.id) : undefined,
    });
    if (record) this.commit([{ type: 'assignment.updated', assignmentId, agentId: a.agentId, workItemId: a.workItemId, data: { patch: { preflight: result } } }]);
    return result;
  }

  /**
   * Dispatch: Now if the agent is free (starts immediately), otherwise appended to its Next queue.
   * Pre-flight must pass to start; queued items are checked again when they're promoted.
   */
  async dispatch(assignmentId: string, o: { position?: 'now' | 'next'; actor?: Actor } = {}): Promise<{ started: boolean; queued: boolean; preflight: PreflightResult; runId?: string }> {
    const actor = o.actor ?? HUMAN;
    const a = this.state.assignments[assignmentId];
    if (!a) throw new CommandError(`unknown assignment ${assignmentId}`, 404);
    if (a.position === 'done' || a.position === 'canceled') throw new CommandError(`assignment is ${a.position}`, 409);
    if(this.state.agents[a.agentId]?.config.enabled===false) throw new CommandError('Enable this saved agent before dispatch.',412);
    // Never dispatch on guesses: probe login, billing and models first if we haven't yet.
    if (!this.state.agents[a.agentId].probedAt) await this.probe(a.agentId).catch(() => undefined);
    const agent = this.state.agents[a.agentId];
    const pf = this.preflight(assignmentId);
    const free = this.agentFree(agent.id) && agent.queue.now === null;
    if (o.position !== 'next' && free) {
      if (!pf.ok) throw new CommandError(`pre-flight failed: ${pf.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.message}`).join('; ')}`, 412);
      const runId = await this.runs.startAssignment(assignmentId, actor);
      return { started: true, queued: false, preflight: pf, runId };
    }
    // Queue as Next. "No issue, no dispatch" still applies when it's queued.
    if (!this.state.workItems[a.workItemId]?.key) throw new CommandError('issue is not in the tracker yet: no issue, no dispatch', 412);
    const next = agent.queue.next.filter((x) => x !== a.id).concat(a.id);
    // A queued reviewer leaves the issue where the author's work is (handoff received).
    const { events, outbox } = a.kind === 'review' ? { events: [], outbox: [] } : this.safeTransition(a.workItemId, 'assigned_next', `queued next for ${agent.config.name}`, actor);
    this.commit(
      [
        { type: 'assignment.positioned', actor, assignmentId: a.id, agentId: a.agentId, workItemId: a.workItemId, data: { position: 'next' } },
        { type: 'agent.queue_set', actor, agentId: agent.id, data: { now: agent.queue.now, next } },
        ...events,
      ],
      outbox,
    );
    void this.rules.refill(agent.id);
    return { started: false, queued: true, preflight: pf };
  }

  /**
   * Quick task from an agent's console: issue → tracker key → assignment → dispatch (Now if the
   * agent is free, else Next). Still "no issue, no dispatch": it waits for the tracker to confirm.
   */
  async quickTask(input: { agentId: string; title: string; description?: string; allowedPaths?: string[]; labels?: string[] }, actor: Actor = HUMAN) {
    if (!this.state.agents[input.agentId]) throw new CommandError(`unknown agent ${input.agentId}`, 404);
    const item = this.createIssue({ title: input.title, description: input.description, labels: input.labels ?? ['quick-task'] }, actor);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const w = this.state.workItems[item.id];
      if (w.key) break;
      if (w.sync.status === 'dry_run') throw new CommandError(`${this.tracker.target} is not live, so the issue can't be created there. Set tracker.live: true (or use the local tracker).`, 412);
      if (Date.now() > deadline) throw new CommandError(`the tracker hasn't confirmed the issue yet${w.sync.lastError ? `: ${w.sync.lastError}` : ''}`, 504);
      this.outbox.kick();
      await new Promise((r) => setTimeout(r, 100));
    }
    const a = this.createAssignment({ workItemId: item.id, agentId: input.agentId, allowedPaths: input.allowedPaths ?? [] }, actor);
    const r = await this.dispatch(a.id, { actor });
    return { item: this.state.workItems[item.id], assignment: this.state.assignments[a.id], ...r };
  }

  safeTransition(itemId: string, to: LifecycleState, reason: string, actor: Actor = SYSTEM, blockedOn?: WorkItem['blockedOn']): { events: NewEvent[]; outbox: OutboxOp[] } {
    try {
      return this.transition(itemId, to, reason, actor, blockedOn);
    } catch {
      return { events: [], outbox: [] };
    }
  }

  agentFree(agentId: string): boolean {
    const a = this.state.agents[agentId];
    if (!a) return false;
    const capacity=sharedCapacity(this.state.agents,a.id);
    return a.config.enabled!==false && a.activeRunIds.length < a.config.concurrency && !a.pausedReason && !capacity.limitedUntil && capacity.usage?.status!=='limited' && !capacity.usage?.windows.some(w=>w.usedPercent!==null&&w.usedPercent>=100);
  }

  /** Reorder an agent's Next queue, or move an assignment to another agent's queue. */
  setQueue(agentId: string, next: string[], actor: Actor = HUMAN): void {
    const agent = this.state.agents[agentId];
    if (!agent) throw new CommandError(`unknown agent ${agentId}`, 404);
    const events: NewEvent[] = [];
    const outbox: OutboxOp[] = [];
    for (const id of next) {
      const a = this.state.assignments[id];
      if (!a) throw new CommandError(`unknown assignment ${id}`, 404);
      if (a.position === 'now' || a.position === 'done' || a.position === 'canceled') throw new CommandError(`assignment ${id} is ${a.position}`, 409);
      if (a.agentId !== agentId) {
        if (a.kind === 'review' && a.review?.authorAgentId === agentId) throw new CommandError('the author cannot review their own work', 409);
        const from = this.state.agents[a.agentId];
        events.push({ type: 'agent.queue_set', actor, agentId: from.id, data: { now: from.queue.now, next: from.queue.next.filter((x) => x !== id) } });
        const patch = { agentId, prompt: '', promptEdited: false, skills: this.skillLib.freeze(agentId, a.workItemId) };
        const moved = { ...a, ...patch };
        patch.prompt = this.assignmentText(moved, agent.config.adapter === 'relay');
        events.push({ type: 'assignment.updated', actor, assignmentId: id, agentId, workItemId: a.workItemId, data: { patch: { ...patch, preflight: null, model: null } } });
      }
      if (a.position !== 'next') {
        events.push({ type: 'assignment.positioned', actor, assignmentId: id, agentId, workItemId: a.workItemId, data: { position: 'next' } });
        if (a.kind !== 'review') {
          const t = this.safeTransition(a.workItemId, 'assigned_next', `queued next for ${agent.config.name}`, actor);
          events.push(...t.events);
          outbox.push(...t.outbox);
        }
      }
    }
    events.push({ type: 'agent.queue_set', actor, agentId, data: { now: agent.queue.now, next } });
    this.commit(events, outbox);
    void this.rules.refill(agentId);
  }

  reassign(assignmentId: string, toAgentId: string, actor: Actor = HUMAN): void {
    const a = this.state.assignments[assignmentId];
    if (!a) throw new CommandError(`unknown assignment ${assignmentId}`, 404);
    if (a.position === 'now') {
      const run = this.runs.activeRunFor(assignmentId);
      if (run) throw new CommandError('stop the active run before reassigning', 409);
      const from = this.state.agents[a.agentId];
      this.commit([
        { type: 'agent.queue_set', actor, agentId: from.id, data: { now: null, next: from.queue.next } },
        { type: 'assignment.positioned', actor, assignmentId, agentId: a.agentId, workItemId: a.workItemId, data: { position: 'draft' } },
      ]);
      if (a.kind !== 'review') {
        const t = this.safeTransition(a.workItemId, 'selected', 'reassigned', actor);
        this.commit(t.events, t.outbox);
      }
    }
    const to = this.state.agents[toAgentId];
    if (!to) throw new CommandError(`unknown agent ${toAgentId}`, 404);
    if (a.kind === 'review' && a.review?.authorAgentId === toAgentId) throw new CommandError('the author cannot review their own work', 409);
    this.setQueue(toAgentId, [...to.queue.next.filter((x) => x !== assignmentId), assignmentId], actor);
    void this.rules.refill(a.agentId);
  }

  cancelAssignment(assignmentId: string, actor: Actor = HUMAN): void {
    const a = this.state.assignments[assignmentId];
    if (!a) throw new CommandError(`unknown assignment ${assignmentId}`, 404);
    if (this.runs.activeRunFor(assignmentId)) throw new CommandError('stop the active run first', 409);
    const agent = this.state.agents[a.agentId];
    this.commit([
      { type: 'assignment.positioned', actor, assignmentId, agentId: a.agentId, workItemId: a.workItemId, data: { position: 'canceled' } },
      { type: 'agent.queue_set', actor, agentId: agent.id, data: { now: agent.queue.now === assignmentId ? null : agent.queue.now, next: agent.queue.next.filter((x) => x !== assignmentId) } },
    ]);
  }

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

  swapModel(agentId: string, model: string, actor: Actor = HUMAN): void {
    const agent = this.state.agents[agentId];
    if (!agent) throw new CommandError(`unknown agent ${agentId}`, 404);
    this.commit([{ type: 'agent.model_changed', actor, agentId, data: { model } }]);
  }

  resumeAgent(agentId: string, actor: Actor = HUMAN): void {
    const agent = this.state.agents[agentId];
    if (!agent) throw new CommandError(`unknown agent ${agentId}`, 404);
    const events: NewEvent[] = [];
    if (agent.pausedReason) events.push({ type: 'agent.resumed', actor, agentId, data: {} });
    for(const peer of subscriptionPeers(this.state.agents,agentId)) if(peer.limitedUntil) events.push({ type: 'agent.unlimited', actor, agentId:peer.id, data: { reason: 'shared subscription limit cleared by owner' } });
    this.commit(events);
    void this.rules.refill(agentId);
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
