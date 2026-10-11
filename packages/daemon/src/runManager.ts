// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Run pipeline: worktree + hooks → launch through the detached runner → parse output into events
// → on exit, classify, collect commits and the handoff, verify evidence, move the lifecycle,
// run the required checks ourselves, then let the rules refill the agent's Now from Next.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor, AgentState, Assignment, Evidence, ExitReason, Handoff, NewEvent, Run, RunState, TestCounts } from '@acc/core';
import { agentActor, branchName, formatHandoff, HUMAN, isActiveRun, isManualRelay, newId, outOfScope, parseHandoff, redact, shellQuote, slugify, SYSTEM } from '@acc/core';
import { CURSOR_MCP_FILE } from './adapters/agents/cursor.ts';
import { sanitizeEnv } from './adapters/agents/env.ts';
import { classifyFailure, type Failure } from './adapters/agents/failures.ts';
import { estimateCost } from './adapters/agents/providers.ts';
import { getSecret, providerSecretFor } from './secrets.ts';
import { checkVersion } from './adapters/agents/opencode/protocol.ts';
import { adapterFor } from './adapters/agents/index.ts';
import type { LaunchContext, Parsed, StreamParser } from './adapters/agents/types.ts';
import { changedFiles, commitOnBranch, commitsSince, createWorktree, ensureBranch, ensureExcluded, gitCommonDir, headSha, installWorktreeHooks, isTracked } from './adapters/vcs/git.ts';
import { runChecks } from './checks.ts';
import { CommandError } from './errors.ts';
import type { DaemonOptions } from './daemon.ts';
import { Supervisor, type ExitInfo, type TailOffsets } from './runner/supervisor.ts';
import { MAX_LIST, type OutboxOp } from './store/eventStore.ts';
import { writePrivate } from './paths.ts';
import type { AgentCommands, Kernel, WorkCommands } from './kernel.ts';
import type { OutboxWorker } from './outbox.ts';
import type { ReviewMerge } from './reviewMerge.ts';
import type { Rules } from './rules.ts';
import type { SkillLibrary } from './skills.ts';
import type { Team } from './team.ts';
import type { WorktreeWatcher } from './adapters/vcs/watcher.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type RunManagerDeps = Kernel & Pick<WorkCommands, 'agentFree' | 'assignmentText' | 'preflight' | 'safeTransition' | 'transition'> & Pick<AgentCommands, 'resolveModelFor' | 'spentToday'> & { readonly outbox: OutboxWorker; readonly reviewMerge: ReviewMerge; readonly rules: Rules; readonly skillLib: SkillLibrary; readonly team: Team; readonly watcher: WorktreeWatcher } & { readonly opts: Pick<DaemonOptions, 'supervisorPollMs'> };

export const MCP_SERVER_PATH = fileURLToPath(new URL('./mcp/server.ts', import.meta.url));
const IGNORED_PATHS = [CURSOR_MCP_FILE];
/**
 * Shell commands an agent may run without a prompt (as `Bash(<prefix>:*)`). A prefix approves every
 * argument, so nothing here may delete files or rewrite shared git state: `find` (-delete, -exec)
 * and `git branch` (-D on refs the worktree shares with the repository) are deliberately absent;
 * agents have Glob/Grep and `git rev-parse --abbrev-ref HEAD` instead.
 */
export const SAFE_BASH: readonly string[] = ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git restore', 'git rev-parse', 'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'grep', 'rg', 'echo'];

interface RunCtx {
  parser: StreamParser;
  finalText: string | null;
  failure: Failure | null;
  result: { ok: boolean } | null;
  stopRequested: { reason: string; kind: 'stopped' | 'killed'; pause: boolean } | null;
  mcpHandoff: Handoff | null;
  seenCommits: Set<string>;
  billingViolation: string | null;
  followUps: string[];
  finalizing: boolean;
}

const FAILURE_WEIGHT: Record<string, number> = { billing_violation: 6, auth_expired: 5, usage_limit: 5, model_unsupported: 4, network: 3, sandbox_denied: 2, crash: 1 };

export class RunManager {
  readonly d: RunManagerDeps;
  readonly supervisor: Supervisor;
  private ctx = new Map<string, RunCtx>();
  private tokens = new Map<string, string>();
  /** finalize / checks in flight; shutdown waits for them so nothing writes to a closed store. */
  readonly inflight = new Set<Promise<unknown>>();

  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  constructor(d: RunManagerDeps) {
    this.d = d;
    this.supervisor = new Supervisor(
      d.paths.runs,
      {
        onLines: (runId, lines, offsets) => this.onLines(runId, lines, offsets),
        onExit: (runId, exit) => void this.track(this.finalize(runId, exit)).catch(() => undefined),
        onLive: (runId, lines) => this.onLive(runId, lines),
        getOffsets: (runId) => d.store.getTail(runId),
      },
      d.opts.supervisorPollMs ?? 200,
    );
  }

  private getCtx(run: Run): RunCtx {
    let c = this.ctx.get(run.id);
    if (!c) {
      const agent = this.d.state.agents[run.agentId];
      const asg = this.d.state.assignments[run.assignmentId];
      c = {
        parser: adapterFor(run.adapter).createParser({ agent: agent.config, runId: run.id, cwd: asg?.worktree ?? this.d.config.project.repo }),
        finalText: null,
        failure: null,
        result: null,
        stopRequested: null,
        mcpHandoff: null,
        seenCommits: new Set(),
        billingViolation: null,
        followUps: [],
        finalizing: false,
      };
      this.ctx.set(run.id, c);
    }
    return c;
  }

  activeRunFor(assignmentId: string): Run | null {
    return Object.values(this.d.state.runs).find((r) => r.assignmentId === assignmentId && isActiveRun(r)) ?? null;
  }

  sessionIdsFor(agentId: string): string[] {
    return Object.values(this.d.state.runs)
      .filter((r) => r.agentId === agentId && r.sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => r.sessionId!) ;
  }

  runForToken(token: string): Run | null {
    const id = this.tokens.get(token);
    const run = id ? this.d.state.runs[id] : null;
    return run && isActiveRun(run) ? run : null;
  }

  binaryCheck(agent: AgentState): { status: 'pass' | 'warn' | 'fail'; message: string } | undefined {
    if (isManualRelay(agent.config)) return undefined;
    if (!agent.binary) return { status: 'fail', message: 'no vendor binary found; install the official CLI and re-probe' };
    if (!fs.existsSync(agent.binary.path)) return { status: 'fail', message: `pinned binary ${agent.binary.path} no longer exists; re-probe` };
    if (agent.config.adapter === 'opencode-server') {
      // Unknown OpenCode releases fail visibly before any model call; the protocol is pinned.
      const v = checkVersion(agent.binary.version, this.d.baseEnv());
      if (!v.ok) return { status: 'fail', message: v.message };
    }
    return { status: 'pass', message: `${agent.binary.path}${agent.binary.version ? ` (${agent.binary.version})` : ''}` };
  }

  private worktreeDir(agentId: string, key: string): string {
    return path.join(this.d.paths.worktrees, slugify(this.d.config.project.name), `${agentId}-${key}`);
  }

  // ---- start -------------------------------------------------------------------------------

  async startAssignment(assignmentId: string, actor: Actor = HUMAN, o: { resume?: { sessionId: string; message: string } | null; retryOf?: string | null; attempt?: number; followUp?: boolean } = {}): Promise<string> {
    const d = this.d;
    let asg = d.state.assignments[assignmentId];
    const item = d.state.workItems[asg.workItemId];
    const agent = d.state.agents[asg.agentId];
    if (!item?.key) throw new CommandError('issue is not in the tracker yet: no issue, no dispatch', 412);
    if (d.state.killSwitch.engaged) throw new CommandError('kill switch is engaged', 409);
    const pf=d.preflight(assignmentId);
    if(!pf.ok) throw new CommandError(`pre-flight failed: ${pf.checks.filter(c=>c.status==='fail').map(c=>`${c.label}: ${c.message}`).join('; ')}`,412);
    if(!d.agentFree(agent.id)) throw new CommandError('Agent is disabled, busy, paused or out of included usage.',409);
    const adapter = adapterFor(agent.config.adapter);
    const project = d.config.project;

    // Worktree + branch (reused for retries and follow-ups).
    if (!asg.worktree || !fs.existsSync(asg.worktree)) {
      await ensureBranch(project.repo, project.integration_branch, project.production_branch ?? project.protected_branches[0] ?? 'HEAD');
      // A review gets a fresh worktree pinned to the exact target SHA, never a reused one.
      const reviewSha = asg.kind === 'review' ? asg.review?.targetSha.slice(0, 10) : null;
      const branch = reviewSha ? `review/${agent.id}/${item.key}-${reviewSha}` : branchName(agent.id, item.key, item.title);
      const dir = reviewSha ? `${this.worktreeDir(agent.id, item.key)}-review-${reviewSha}` : this.worktreeDir(agent.id, item.key);
      const wt = await createWorktree({ repo: project.repo, dir, branch, baseRef: asg.baseRef });
      await installWorktreeHooks({ repo: project.repo, worktree: wt.path, hooksDir: path.join(d.paths.hooks, asg.id), scope: { allowedPaths: asg.allowedPaths, ignore: IGNORED_PATHS, protectedBranches: project.protected_branches } });
      if (agent.config.adapter === 'cursor-agent-cli' && !(await isTracked(project.repo, CURSOR_MCP_FILE))) await ensureExcluded(project.repo, CURSOR_MCP_FILE);
      d.commit([{ type: 'assignment.worktree_ready', actor: SYSTEM, assignmentId: asg.id, agentId: asg.agentId, workItemId: asg.workItemId, data: { worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha } }]);
      asg = d.state.assignments[assignmentId];
      if (!asg.promptEdited) {
        d.commit([{ type: 'assignment.updated', actor: SYSTEM, assignmentId: asg.id, agentId: asg.agentId, workItemId: asg.workItemId, data: { patch: { prompt: d.assignmentText(asg) } } }]);
        asg = d.state.assignments[assignmentId];
      }
    }
    await d.skillLib.exportForRun(asg.id);

    const model = asg.model ?? asg.preflight?.model ?? d.resolveModelFor(agent.id).model;
    const runId = newId('run');
    const prior = Object.values(d.state.runs).filter((r) => r.assignmentId === asg.id);
    const run: Run = {
      id: runId,
      assignmentId: asg.id,
      workItemId: asg.workItemId,
      agentId: agent.id,
      adapter: agent.config.adapter,
      model,
      resolvedModel: null,
      effort: asg.effort,
      attempt: o.attempt ?? (o.retryOf ? (d.state.runs[o.retryOf]?.attempt ?? 1) + 1 : 1),
      retryOf: o.retryOf ?? null,
      pid: null,
      sessionId: o.resume?.sessionId ?? null,
      state: 'queued',
      createdAt: d.nowIso(),
      startedAt: null,
      endedAt: null,
      lastEventAt: null,
      lastMeaningful: null,
      eventCount: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      exit: null,
      handoff: null,
      filesChanged: [],
      outOfScope: [],
      tests: null,
      logDir: this.supervisor.runDir(runId),
    };
    const refs = { agentId: agent.id, workItemId: asg.workItemId, assignmentId: asg.id, runId };
    const t = asg.kind === 'review'
      ? d.safeTransition(asg.workItemId, 'in_review', `${agent.config.name} started reviewing ${asg.review?.targetSha.slice(0, 10) ?? ''}`.trim(), actor)
      : d.safeTransition(asg.workItemId, 'running', `${agent.config.name} started${prior.length ? ` (run ${prior.length + 1})` : ''}`, actor);
    d.commit(
      [
        { type: 'run.created', actor, ...refs, data: { run } },
        ...(asg.position !== 'now' ? [{ type: 'assignment.positioned' as const, actor, ...refs, data: { position: 'now' as const } }] : []),
        { type: 'agent.queue_set', actor, agentId: agent.id, data: { now: asg.id, next: agent.queue.next.filter((x) => x !== asg.id) } },
        ...t.events,
      ],
      t.outbox,
    );

    if (isManualRelay(agent.config)) {
      d.commit([{ type: 'run.state', ...refs, data: { state: 'waiting-for-input', reason: 'paste the prompt into the app, then paste its reply back' } }]);
      return runId;
    }

    const runDir = this.supervisor.runDir(runId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    let mcp: LaunchContext['mcp'] = null;
    if (adapter.capabilities.mcp && d.url) {
      const token = randomBytes(24).toString('hex');
      writePrivate(path.join(runDir, 'mcp.json'), JSON.stringify({ url: d.url, token }));
      this.tokens.set(token, runId);
      mcp = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', MCP_SERVER_PATH, runDir] };
    }
    const checkConfigPath = path.join(runDir, 'project-checks.json');
    writePrivate(checkConfigPath, JSON.stringify({ project, policies: { redact_env: d.config.policies.redact_env }, agents: [{ id: 'checks', name: 'Project checks', role: 'qa', adapter: 'relay' }] }));
    const checkCommand = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('./cli.ts', import.meta.url)))} check --config ${shellQuote(checkConfigPath)} --worktree ${shellQuote(asg.worktree!)}`;
    const runtimeInstruction = project.check_runtime?.mode === 'host-fixture'
      ? 'HOST FIXTURE (unsandboxed; disposable tests/demo only).'
      : `Project apps, tests and development tools must run in Docker. Commit source, then run configured checks with: ${checkCommand}. Add --only test (or another configured name) to select a check. This exports committed HEAD; uncommitted edits are excluded. Missing Docker/image/config is a blocker. Repository hooks are never approved by a merge decision.`;
    const allowedTools = ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', ...[...SAFE_BASH, checkCommand, ...(project.check_runtime?.mode === 'host-fixture' ? Object.values(project.checks) : []), ...agent.config.auto_approve_commands].map((c) => `Bash(${c}:*)`)];
    // Bring-your-own-model connections: a private home (never the user's own CLI config/login) and
    // the opted-in API key from the Keychain, given to this run only.
    const providerEnv: Record<string, string> = {};
    let providerHome: string | null = null;
    if (agent.config.provider !== 'subscription') {
      providerHome = path.join(d.paths.root, 'providers', agent.id, 'home');
      fs.mkdirSync(providerHome, { recursive: true, mode: 0o700 });
      const spec = providerSecretFor(agent.config);
      if (spec) {
        const key = await getSecret(spec.secret, d.baseEnv());
        if (!key) {
          this.endImmediately(runId, { kind: 'auth_expired', message: `no ${agent.config.provider} API key: add it under Agents → Connections` });
          return runId;
        }
        d.addSecret(key);
        for (const v of spec.envVars) providerEnv[v] = key;
      }
    }
    const ctxLaunch: LaunchContext = {
      agent: agent.config,
      binary: agent.binary?.path ?? agent.config.binary ?? agent.config.command ?? adapter.binaryNames[0],
      runId,
      attempt: run.attempt,
      model,
      effort: asg.effort,
      prompt: `${asg.prompt}\n\n${runtimeInstruction}\n\n## Current team context (One Connect)\n${d.team.dispatchContext(agent.id)}`,
      cwd: asg.worktree!,
      gitCommonDir: await gitCommonDir(asg.worktree!).catch(() => null),
      runDir,
      mcp,
      resume: o.resume ? { ...o.resume, message: `${o.resume.message}\n\n${runtimeInstruction}` } : null,
      policies: d.config.policies,
      allowedTools,
      providerHome,
    };
    let spec;
    try {
      spec = adapter.buildLaunch(ctxLaunch);
    } catch (e) {
      this.endImmediately(runId, { kind: 'crash', message: `could not build launch: ${(e as Error).message}` });
      return runId;
    }
    const { env } = sanitizeEnv(agent.config, d.baseEnv(), { ACC_RUN_DIR: runDir, ...providerEnv });
    this.getCtx(d.state.runs[runId]);
    try {
      const info = await this.supervisor.launch(runId, spec, { env, denylist: d.denylist() });
      d.commit([{ type: 'run.started', ...refs, data: { pid: info.childPid ?? info.runnerPid } }]);
    } catch (e) {
      this.endImmediately(runId, { kind: 'crash', message: (e as Error).message });
      return runId;
    }
    d.watcher.watch(asg.id, asg.worktree!);
    return runId;
  }

  private endImmediately(runId: string, exit: ExitReason): void {
    const run = this.d.state.runs[runId];
    const refs = { agentId: run.agentId, workItemId: run.workItemId, assignmentId: run.assignmentId, runId };
    const t = this.d.safeTransition(run.workItemId, 'failed', exit.message);
    this.d.commit([{ type: 't.error', ...refs, data: { message: exit.message, failure: 'crash' } }, { type: 'run.ended', ...refs, data: { exit } }, ...t.events], t.outbox);
    this.d.rules.onRunEnded(runId);
  }

  // ---- output ------------------------------------------------------------------------------

  private toEvents(run: Run, parsed: Parsed[], ctx: RunCtx): NewEvent[] {
    const refs = { agentId: run.agentId, workItemId: run.workItemId, assignmentId: run.assignmentId, runId: run.id, actor: agentActor(run.agentId) };
    const out: NewEvent[] = [];
    for (const p of parsed) {
      switch (p.kind) {
        case 'event':
          out.push({ ...refs, type: p.type, data: p.data } as NewEvent);
          break;
        case 'session': {
          out.push({ ...refs, actor: SYSTEM, type: 'run.session', data: { sessionId: p.sessionId ?? run.sessionId, model: p.model } });
          if (p.modelMismatch) {
            const name = this.d.state.agents[run.agentId]?.config.name ?? run.agentId;
            queueMicrotask(() => this.d.alert({ kind: 'model', severity: 'warn', agentId: run.agentId, runId: run.id, workItemId: run.workItemId, message: `${name}: requested ${p.modelMismatch!.requested} but the vendor served ${p.modelMismatch!.served}. Check plan limits and fallback settings; the control center never switches models itself.`, dedupeKey: `mismatch:${run.id}:${p.modelMismatch!.served}` }));
          }
          const src = (p.apiKeySource ?? '').toLowerCase();
          const agent = this.d.state.agents[run.agentId];
          if (src && !/^(none|login|oauth|claude\.ai|subscription)$/.test(src) && !agent.config.metered_opt_in) {
            ctx.billingViolation = `session reports apiKeySource=${p.apiKeySource}: this run would bill per token`;
          }
          break;
        }
        case 'usage': {
          const agent = this.d.state.agents[run.agentId];
          const costUsd = estimateCost(agent.config, run.resolvedModel ?? run.model, p, agent.models.available, p.costUsd);
          out.push({ ...refs, actor: SYSTEM, type: 'run.usage', data: { inputTokens: p.inputTokens, outputTokens: p.outputTokens, ...(costUsd !== undefined ? { costUsd } : {}) } });
          break;
        }
        case 'plan_usage': {
          out.push({ ...refs, actor: SYSTEM, type: 'agent.usage', data: { usage: p.usage } });
          const agent = this.d.state.agents[run.agentId];
          if (p.overage.inUse && !agent.config.metered_opt_in) {
            ctx.billingViolation = 'the vendor reports this run is drawing on paid overage / extra usage (included plan usage is exhausted)';
          } else if (p.overage.enabled && !agent.config.metered_opt_in) {
            this.d.alert({ kind: 'billing', severity: 'warn', agentId: run.agentId, message: `${agent.config.name}: paid overage (extra usage) is enabled on this account. It is not used while included usage remains, but turn it off to make zero-extra-spend airtight.`, dedupeKey: `overage-enabled:${run.agentId}` });
          }
          break;
        }
        case 'child':
          out.push({ ...refs, actor: SYSTEM, type: 'run.child', data: { sessionId: p.sessionId, parentSessionId: p.parentSessionId, title: p.title, state: p.state, ...(p.error ? { error: p.error } : {}) } });
          break;
        case 'final':
          ctx.finalText = p.text;
          break;
        case 'live':
          this.publishLive(run, p.role, p.text);
          break;
        case 'failure':
          if (!ctx.failure || (FAILURE_WEIGHT[p.failure.kind] ?? 0) >= (FAILURE_WEIGHT[ctx.failure.kind] ?? 0)) ctx.failure = p.failure;
          break;
        case 'result':
          ctx.result = { ok: p.ok };
          break;
      }
    }
    return out;
  }

  onLines(runId: string, lines: { stream: 'stdout' | 'stderr'; line: string }[], offsets: TailOffsets): void {
    const run = this.d.state.runs[runId];
    if (!run) return;
    const ctx = this.getCtx(run);
    const parsed = lines.flatMap((l) => ctx.parser.line(l.stream, l.line));
    const events = this.toEvents(run, parsed, ctx);
    this.d.commit(events, [], () => this.d.store.setTail(runId, offsets.stdout, offsets.stderr));
    this.enforceBudget(run);
    if (ctx.billingViolation && !ctx.stopRequested) {
      this.d.alert({ kind: 'billing', severity: 'critical', agentId: run.agentId, runId, message: `${this.d.state.agents[run.agentId].config.name}: ${ctx.billingViolation}. The run was stopped.`, dedupeKey: `billing-run:${runId}` });
      void this.stop(runId, ctx.billingViolation, SYSTEM, 'killed');
    }
  }

  private liveState = new Map<string, { role: 'assistant' | 'reasoning'; text: string; timer: NodeJS.Timeout | null; sent: string }>();

  /** Token deltas from the live stream (not persisted). */
  onLive(runId: string, lines: string[]): void {
    const run = this.d.state.runs[runId];
    if (!run) return;
    const ctx = this.getCtx(run);
    for (const l of lines) for (const p of ctx.parser.line('live', l)) if (p.kind === 'live') this.publishLive(run, p.role, p.text);
  }

  /**
   * Broadcast the in-progress message, redacted as a whole (secrets can straddle deltas),
   * at most ~10 times a second. An empty text clears the live bubble immediately.
   */
  publishLive(run: Run, role: 'assistant' | 'reasoning', text: string): void {
    const key = `${run.id}:${role}`;
    const st = this.liveState.get(key) ?? { role, text: '', timer: null, sent: '' };
    st.text = text;
    this.liveState.set(key, st);
    const send = () => {
      st.timer = null;
      const clean = redact(st.text, { denylist: this.d.denylist() }).text;
      if (clean === st.sent) return;
      st.sent = clean;
      this.d.bus.emit('live', { runId: run.id, agentId: run.agentId, role, text: clean, at: this.d.nowIso() });
      if (!clean) this.liveState.delete(key);
    };
    if (!text) {
      if (st.timer) clearTimeout(st.timer);
      send();
      return;
    }
    if (!st.timer) st.timer = setTimeout(send, 100);
  }

  /** Daily cap for metered connections: stop the run and pause the agent once it's reached. */
  private enforceBudget(run: Run): void {
    const agent = this.d.state.agents[run.agentId];
    const cap = agent?.config.budget_usd_per_day;
    if (!cap || agent.config.billing !== 'metered' || !isActiveRun(this.d.state.runs[run.id])) return;
    const spent = this.d.spentToday(agent.id);
    if (spent < cap) return;
    const ctx = this.getCtx(run);
    // A finished turn just completes; the cap blocks the next dispatch (pre-flight) instead.
    if (ctx.stopRequested || ctx.result) return;
    // No pause: pre-flight blocks new work until the day rolls over, then queued work resumes.
    this.d.alert({ kind: 'billing', severity: 'critical', agentId: agent.id, runId: run.id, message: `${agent.config.name} reached its daily budget ($${spent.toFixed(2)} of $${cap.toFixed(2)}). The run was stopped; new work waits until tomorrow (or raise budget_usd_per_day).`, dedupeKey: `budget:${agent.id}:${new Date(this.d.now()).toDateString()}` });
    void this.stop(run.id, 'daily budget reached', SYSTEM, 'killed');
  }

  private lastAssistantText(runId: string): string | null {
    for (const m of this.d.store.list({ runId, types: ['t.message'], limit: MAX_LIST, order: 'desc' })) {
      if (m.type === 't.message' && m.data.role === 'assistant') return m.data.text;
    }
    return null;
  }

  private recordedCommands(runId: string): { command: string; exitCode: number | null | undefined }[] {
    return this.d.store
      .list({ runId, types: ['t.command'], limit: MAX_LIST, order: 'desc' })
      .reverse()
      .flatMap((e) => (e.type === 't.command' && e.data.status !== 'started' ? [{ command: e.data.command, exitCode: e.data.exitCode }] : []));
  }

  // ---- exit --------------------------------------------------------------------------------

  async finalize(runId: string, exit: ExitInfo): Promise<void> {
    const d = this.d;
    const run = d.state.runs[runId];
    if (!run || run.endedAt) return;
    const ctx = this.getCtx(run);
    if (ctx.finalizing) return;
    ctx.finalizing = true;
    const tail = this.toEvents(run, ctx.parser.end({ code: exit.code, signal: exit.signal }), ctx);
    d.commit(tail);
    const asg = d.state.assignments[run.assignmentId];
    const agent = d.state.agents[run.agentId];
    const refs = { agentId: run.agentId, workItemId: run.workItemId, assignmentId: run.assignmentId, runId };
    const events: NewEvent[] = [];
    // A reviewer's run never moves the issue; its typed review record does (see ReviewMerge).
    const reviewRun = asg.kind === 'review';
    const transition: RunManagerDeps['safeTransition'] = (...args) => (reviewRun ? { events: [], outbox: [] } : d.safeTransition(...args));

    // Commits made in this worktree since the base, recorded as verified evidence.
    let commits: { sha: string; subject: string; body: string }[] = [];
    if (asg.worktree && asg.baseSha && fs.existsSync(asg.worktree)) commits = await commitsSince(asg.worktree, asg.baseSha).catch(() => []);
    const known = new Set(Object.values(d.state.workItems[run.workItemId].evidence).filter((e) => e.kind === 'commit').map((e) => e.sha));
    for (const c of [...commits].reverse()) {
      if (known.has(c.sha) || ctx.seenCommits.has(c.sha)) continue;
      ctx.seenCommits.add(c.sha);
      events.push({ type: 't.commit', ...refs, actor: agentActor(run.agentId), data: { sha: c.sha, subject: c.subject } });
      events.push({ type: 'work_item.evidence_added', ...refs, data: { evidence: this.evidence({ kind: 'commit', summary: `${c.sha.slice(0, 8)} ${c.subject}`, sha: c.sha, branch: asg.branch ?? undefined, runId, verified: true }) } });
    }

    // Outcome.
    let reason: ExitReason;
    let finalState: RunState | undefined;
    if (exit.orphaned) reason = { kind: 'orphaned', message: exit.error ?? 'runner disappeared', exitCode: null, signal: null };
    else if (ctx.billingViolation) reason = { kind: 'billing_violation', message: ctx.billingViolation, exitCode: exit.code, signal: exit.signal };
    else if (ctx.stopRequested) {
      reason = { kind: ctx.stopRequested.kind, message: ctx.stopRequested.reason, exitCode: exit.code, signal: exit.signal };
      if (ctx.stopRequested.pause) finalState = 'paused';
    } else {
      const ok = (ctx.result?.ok ?? true) && exit.code === 0 && !exit.signal;
      if (ok) reason = { kind: 'completed', message: 'finished', exitCode: 0, signal: null };
      else {
        const stderrTail = this.stderrTail(runId);
        const f = ctx.failure ?? classifyFailure(stderrTail) ?? { kind: 'crash' as const, message: exit.error ?? (exit.signal ? `killed by ${exit.signal}` : `exited with code ${exit.code}`) };
        reason = { kind: f.kind, message: f.message, exitCode: exit.code, signal: exit.signal, resetsAt: f.resetsAt ?? null };
      }
    }

    // Handoff: MCP-posted, else the final message, else a commit body.
    let handoff: Handoff | null = null;
    if (reason.kind === 'completed') {
      handoff = ctx.mcpHandoff ?? parseHandoff(ctx.finalText ?? this.lastAssistantText(runId) ?? '', 'final_message');
      if (!handoff) for (const c of commits) if ((handoff = parseHandoff(c.body, 'commit_body'))) break;
    }
    if (handoff) handoff = await this.verifyHandoff(handoff, runId, asg);

    events.push({ type: 'run.ended', ...refs, data: { exit: reason, state: finalState } });
    let outbox: OutboxOp[] = [];
    const freeAgent = () => events.push({ type: 'agent.queue_set', agentId: agent.id, data: { now: null, next: d.state.agents[agent.id].queue.next } }, { type: 'assignment.positioned', ...refs, data: { position: 'done' } });

    if (reason.kind === 'completed' && handoff) {
      events.push({ type: 'run.handoff', ...refs, data: { handoff } });
      events.push({ type: 'work_item.evidence_added', ...refs, data: { evidence: this.evidence({ kind: 'handoff', summary: handoff.done, runId, sha: handoff.commit?.sha, branch: handoff.commit?.branch ?? undefined, verified: false }) } });
      freeAgent();
      const t = handoff.blocked
        ? transition(run.workItemId, 'blocked', `blocked: ${handoff.blocked.what}`, agentActor(agent.id), { kind: /^(human|owner)$/i.test(handoff.blocked.on ?? '') ? 'human' : /^[A-Z]+-\d+$/.test(handoff.blocked.on ?? '') ? 'issue' : 'agent', ref: handoff.blocked.on ?? undefined, reason: handoff.blocked.what })
        : transition(run.workItemId, 'handoff_received', `handoff from ${agent.config.name}`, agentActor(agent.id));
      events.push(...t.events);
      outbox = [...outbox, ...t.outbox];
    } else if (reason.kind === 'completed') {
      // Handoff enforcement: flag it, generate a skeleton from what actually happened, free the agent.
      const skeleton = this.skeleton(runId, commits);
      events.push({ type: 'run.handoff', ...refs, data: { handoff: skeleton } });
      freeAgent();
      const t = transition(run.workItemId, 'blocked', 'run ended without a handoff block', SYSTEM, { kind: 'human', reason: 'missing handoff: accept the generated skeleton or nudge the agent' });
      events.push(...t.events);
      outbox = [...outbox, ...t.outbox];
    } else if (reason.kind === 'stopped' && !ctx.stopRequested?.pause) {
      events.push({ type: 'agent.queue_set', agentId: agent.id, data: { now: null, next: d.state.agents[agent.id].queue.next } }, { type: 'assignment.positioned', ...refs, data: { position: 'draft' } });
      const t = transition(run.workItemId, 'selected', `stopped: ${reason.message}`, HUMAN);
      events.push(...t.events);
      outbox = [...outbox, ...t.outbox];
    } else if (reason.kind === 'stopped' || reason.kind === 'killed') {
      const t = transition(run.workItemId, 'blocked', reason.message, HUMAN, { kind: 'human', reason: ctx.stopRequested?.pause ? 'paused by owner' : reason.message });
      events.push(...t.events);
      outbox = [...outbox, ...t.outbox];
    } else {
      events.push({ type: 't.error', ...refs, data: { message: reason.message, failure: reason.kind } });
      const t = transition(run.workItemId, 'failed', `${reason.kind}: ${reason.message}`);
      events.push(...t.events);
      outbox = [...outbox, ...t.outbox];
    }
    d.commit(events, outbox);
    if (reason.kind === 'completed' && !handoff) {
      d.alert({ kind: 'handoff_missing', severity: 'warn', agentId: agent.id, runId, workItemId: run.workItemId, message: `${agent.config.name} finished ${d.state.workItems[run.workItemId].key} without a handoff block. A skeleton was generated from the run's events; accept it or nudge the agent.`, dedupeKey: `handoff:${runId}` });
    }
    // Rules react in the same tick as run.ended (pause, retry, refill), before any await.
    this.publishLive(run, 'assistant', '');
    this.publishLive(run, 'reasoning', '');
    this.ctx.delete(runId);
    d.rules.onRunEnded(runId);
    await this.refreshDiff(asg.id);
    d.watcher.unwatch(asg.id);
    if (reviewRun) await d.reviewMerge.onReviewRunEnded(runId).catch((e) => d.alert({ kind: 'review', severity: 'warn', runId, workItemId: run.workItemId, message: `review result could not be recorded: ${(e as Error).message}`, dedupeKey: `review-run:${runId}` }));
    else if (reason.kind === 'completed') await this.postRunChecks(runId);
    const followUps = ctx.followUps.splice(0).concat(this.supervisor.undelivered(runId));
    if (followUps.length && reason.kind === 'completed') await this.followUp(runId, followUps.join('\n\n'), HUMAN).catch(() => undefined);
  }

  private stderrTail(runId: string): string {
    try {
      const f = path.join(this.supervisor.runDir(runId), 'stderr.log');
      const s = fs.readFileSync(f, 'utf8');
      return s.slice(-4000);
    } catch {
      return '';
    }
  }

  private evidence(e: Omit<Evidence, 'id' | 'at'>): Evidence {
    return { ...e, id: newId('evd'), at: this.d.nowIso() };
  }

  /** Mark each claimed evidence item verified only if the control center recorded it. */
  private async verifyHandoff(h: Handoff, runId: string, asg: Assignment, daemonChecks: { command: string; exitCode: number | null }[] = []): Promise<Handoff> {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const recorded = [...this.recordedCommands(runId), ...daemonChecks];
    const evidence = h.evidence.map((e) => {
      const c = norm(e.command);
      const hit = recorded.find((r) => norm(r.command).includes(c) || (c.length > 3 && c.includes(norm(r.command))));
      return { ...e, verified: Boolean(hit && hit.exitCode === 0), note: hit ? (hit.exitCode === 0 ? 'matches a recorded command' : `recorded exit ${hit.exitCode}`) : 'not seen in the run' };
    });
    let commit = h.commit;
    if (commit && asg.branch) commit = { ...commit, verified: await commitOnBranch(this.d.config.project.repo, commit.sha, asg.branch).catch(() => false) };
    return { ...h, evidence, commit };
  }

  private skeleton(runId: string, commits: { sha: string; subject: string }[]): Handoff {
    const cmds = this.recordedCommands(runId).slice(-8);
    const last = commits[0];
    const h: Handoff = {
      done: '(generated: the agent did not write a handoff) ' + (this.lastAssistantText(runId)?.split('\n')[0]?.slice(0, 160) ?? 'see transcript'),
      evidence: cmds.map((c) => ({ command: c.command, result: `exit ${c.exitCode ?? '?'}`, verified: c.exitCode === 0, note: 'recorded by the control center' })),
      commit: last ? { sha: last.sha, branch: this.d.state.assignments[this.d.state.runs[runId].assignmentId].branch, verified: true } : null,
      blocked: null,
      next: null,
      source: 'skeleton',
      raw: '',
    };
    h.raw = formatHandoff(h);
    return h;
  }

  /** The daemon runs required checks itself and records the results as verified evidence. */
  async postRunChecks(runId: string): Promise<void> {
    const d = this.d;
    const run = d.state.runs[runId];
    const asg = d.state.assignments[run.assignmentId];
    if (!asg.worktree || !fs.existsSync(asg.worktree)) return;
    const checks = asg.requiredChecks.map((name) => ({ name, command: d.config.project.checks[name] })).map(c => ({ ...c, command: c.command ?? '' }));
    const refs = { agentId: run.agentId, workItemId: run.workItemId, assignmentId: run.assignmentId, runId };
    const sha = await headSha(asg.worktree);
    const results = checks.length ? await runChecks({ cwd: asg.worktree, repo: d.config.project.repo, sha, runtime: d.config.project.check_runtime, checks, logDir: path.join(this.supervisor.runDir(runId), 'checks'), env: sanitizeEnv(d.state.agents[run.agentId].config, d.baseEnv()).env, denylist: d.denylist() }) : [];
    const events: NewEvent[] = [];
    let total = null as TestCounts | null;
    for (const r of results) {
      const passed = r.status === 'passed';
      events.push({ type: 'work_item.evidence_added', ...refs, data: { evidence: this.evidence({ kind: r.counts ? 'test' : 'command', summary: `[${r.runtime}] ${r.status}: ${r.name}: \`${r.command}\` → ${r.counts ? `${r.counts.passed} passed, ${r.counts.failed} failed` : passed ? 'ok' : 'failed'} (exit ${r.exitCode ?? 'none'}${r.timedOut ? ', timed out' : ''})${r.status === 'unavailable' ? `: ${r.detail}` : ''}`, command: r.command, exitCode: r.exitCode, counts: r.counts ?? undefined, sha: r.sha ?? undefined, branch: asg.branch ?? undefined, runId, logPath: r.logPath, checkRuntime: r.runtimeKey, checkImage: r.imageId, env: 'local', verified: true }) } });
      if (r.counts) total = { passed: (total?.passed ?? 0) + r.counts.passed, failed: (total?.failed ?? 0) + r.counts.failed, skipped: (total?.skipped ?? 0) + r.counts.skipped, framework: r.counts.framework };
    }
    if (total) events.push({ type: 'run.tests', ...refs, data: { counts: total, command: results.filter((r) => r.counts).map((r) => r.command).join(' && '), source: 'daemon' } });
    const handoff = d.state.runs[runId].handoff;
    let outbox: { workItemId: string; op: 'comment'; payload: Record<string, unknown> }[] = [];
    if (handoff && handoff.source !== 'skeleton') {
      const verified = await this.verifyHandoff(handoff, runId, asg, results.map((r) => ({ command: r.command, exitCode: r.exitCode })));
      events.push({ type: 'run.handoff', ...refs, data: { handoff: verified } });
      const lines = [formatHandoff(verified), '', `**Verified by Agent Control Center**${sha ? ` at \`${sha.slice(0, 10)}\`` : ''}${asg.branch ? ` on \`${asg.branch}\`` : ''}:`];
      if (results.length === 0) lines.push('- no required checks configured');
      for (const r of results) lines.push(`- ${r.status === 'passed' ? '✅' : '❌'} [${r.runtime}] ${r.status}: ${r.name}: \`${r.command}\` → ${r.counts ? `${r.counts.passed} passed, ${r.counts.failed} failed` : `exit ${r.exitCode ?? 'none'}`}`);
      outbox = [{ workItemId: run.workItemId, op: 'comment', payload: { body: lines.join('\n') } }];
    }
    d.commit(events, outbox);
    d.outbox.kick();
    const failed = results.filter((r) => r.status !== 'passed');
    if (failed.length) {
      d.alert({ kind: 'run_failed', severity: 'warn', agentId: run.agentId, runId, workItemId: run.workItemId, message: `${d.state.workItems[run.workItemId].key}: required check${failed.length > 1 ? 's' : ''} ${failed.map((f) => f.name).join(', ')} failed after the handoff`, dedupeKey: `checks:${runId}` });
    }
  }

  // ---- control -----------------------------------------------------------------------------

  private readonly beforeStop: ((runId: string) => Promise<void> | void)[] = [];

  /** Run `hook` before any stop, pause or kill of a run (e.g. to close that run's tool transports). */
  onBeforeStop(hook: (runId: string) => Promise<void> | void): void {
    this.beforeStop.push(hook);
  }

  async stop(runId: string, reason: string, actor: Actor = HUMAN, kind: 'stopped' | 'killed' = 'stopped', pause = false): Promise<void> {
    for (const hook of this.beforeStop) await hook(runId);
    const run = this.d.state.runs[runId];
    if (!run) throw new CommandError(`unknown run ${runId}`, 404);
    if (!isActiveRun(run)) return;
    const ctx = this.getCtx(run);
    ctx.stopRequested = { reason, kind, pause };
    this.d.commit([{ type: 't.system', actor, agentId: run.agentId, runId, workItemId: run.workItemId, assignmentId: run.assignmentId, data: { text: `${pause ? 'pause' : kind === 'killed' ? 'kill' : 'stop'} requested by ${actor.id}: ${reason}` } }]);
    if (isManualRelay(run) || !this.supervisor.info(runId)) {
      await this.finalize(runId, { code: null, signal: null });
      return;
    }
    // A plain stop/pause first asks a streaming harness to abort its turn cleanly (the vendor records
    // the abort and nothing is left half-written); the process group is signalled only if it lingers.
    const adapter = adapterFor(run.adapter);
    if (kind === 'stopped' && adapter.encodeAbort && this.supervisor.isAlive(runId)) {
      this.supervisor.send(runId, adapter.encodeAbort());
      const until = Date.now() + 5000;
      while (this.supervisor.isAlive(runId) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    }
    await this.supervisor.stop(runId);
  }

  async pause(runId: string, actor: Actor = HUMAN): Promise<void> {
    const run = this.d.state.runs[runId];
    if (!run) throw new CommandError(`unknown run ${runId}`, 404);
    if (!adapterFor(run.adapter).capabilities.resume || !run.sessionId) throw new CommandError('this agent cannot resume a session, so pausing would lose its work; stop it instead', 409);
    await this.stop(runId, 'paused by owner', actor, 'stopped', true);
  }

  async resume(runId: string, actor: Actor = HUMAN, message = 'Resume the assignment where you left off. Re-read it with get_assignment if needed, and finish with the handoff block.'): Promise<string> {
    const run = this.d.state.runs[runId];
    if (!run) throw new CommandError(`unknown run ${runId}`, 404);
    if (isActiveRun(run)) throw new CommandError('run is still active', 409);
    if (!run.sessionId) throw new CommandError('no vendor session to resume', 409);
    return this.startAssignment(run.assignmentId, actor, { resume: { sessionId: run.sessionId, message }, retryOf: runId, attempt: run.attempt });
  }

  /** Notify only a currently running interactive harness. Never queues a new inference turn. */
  notifyInbox(runId: string, messageId: string): boolean {
    const r = this.d.state.runs[runId];
    if (!r || r.state !== 'running') return false;
    const adapter = adapterFor(r.adapter);
    if (!adapter.capabilities.streamingInput || !adapter.encodeMessage) return false;
    try {
      this.supervisor.send(runId, adapter.encodeMessage(`One Connect inbox update: ${messageId}. At your next safe tool boundary, call read_messages and acknowledge after reading. Follow your assignment and approval policies.`));
      return true;
    } catch { return false; }
  }

  /** Deliver a message: live on stdin when the vendor supports it, else as a follow-up turn. */
  async send(runId: string, text: string, actor: Actor = HUMAN): Promise<{ delivered: 'live' | 'queued' | 'follow-up' }> {
    const run = this.d.state.runs[runId];
    if (!run) throw new CommandError(`unknown run ${runId}`, 404);
    const msg = text.trim();
    if (!msg) throw new CommandError('empty message');
    const adapter = adapterFor(run.adapter);
    const refs = { agentId: run.agentId, runId, workItemId: run.workItemId, assignmentId: run.assignmentId };
    if (isActiveRun(run)) {
      this.d.commit([{ type: 't.message', actor, ...refs, data: { role: 'user', text: msg } }]);
      if (adapter.capabilities.streamingInput && adapter.encodeMessage) {
        this.supervisor.send(runId, adapter.encodeMessage(msg));
        return { delivered: 'live' };
      }
      this.getCtx(run).followUps.push(msg);
      return { delivered: 'queued' };
    }
    await this.followUp(runId, msg, actor);
    return { delivered: 'follow-up' };
  }

  async followUp(runId: string, text: string, actor: Actor): Promise<string> {
    const run = this.d.state.runs[runId];
    if (!run.sessionId || !adapterFor(run.adapter).capabilities.resume) throw new CommandError('this agent cannot continue a finished session', 409);
    const agent = this.d.state.agents[run.agentId];
    if (agent.activeRunIds.length >= agent.config.concurrency) throw new CommandError(`${agent.config.name} is busy; queue it instead`, 409);
    this.d.commit([{ type: 't.message', actor, agentId: run.agentId, runId, workItemId: run.workItemId, assignmentId: run.assignmentId, data: { role: 'user', text } }]);
    return this.startAssignment(run.assignmentId, actor, { resume: { sessionId: run.sessionId, message: text }, retryOf: runId, attempt: run.attempt, followUp: true });
  }

  async nudge(runId: string, actor: Actor = HUMAN): Promise<unknown> {
    return this.send(runId, 'Status check from the control center: continue the assignment. If you are blocked, say exactly what you need (use ask_human). Finish with the handoff block.', actor);
  }

  /** Relay agents: the human pastes the app's reply; it must contain a handoff block. */
  async relayResult(runId: string, text: string, actor: Actor = HUMAN): Promise<Handoff> {
    const run = this.d.state.runs[runId];
    if (!run || !isManualRelay(run)) throw new CommandError('not a relay run', 400);
    if (!isActiveRun(run)) throw new CommandError('run already ended', 409);
    const handoff = parseHandoff(text, 'relay_paste');
    if (!handoff) throw new CommandError('no handoff block found in the pasted reply (it needs at least a "Done:" line under "### Handoff")', 422);
    const ctx = this.getCtx(run);
    ctx.mcpHandoff = handoff;
    ctx.result = { ok: true };
    this.d.commit([{ type: 't.message', actor, agentId: run.agentId, runId, workItemId: run.workItemId, assignmentId: run.assignmentId, data: { role: 'assistant', text } }]);
    await this.finalize(runId, { code: 0, signal: null });
    return handoff;
  }

  /** Accept a generated skeleton handoff (after a missing-handoff flag). */
  acceptSkeleton(runId: string, actor: Actor = HUMAN): void {
    const run = this.d.state.runs[runId];
    if (!run?.handoff || run.handoff.source !== 'skeleton') throw new CommandError('no skeleton handoff to accept', 409);
    const t = this.d.transition(run.workItemId, 'handoff_received', 'owner accepted the generated handoff', actor);
    this.d.commit(t.events, t.outbox);
    this.d.resolveAlerts((a) => a.dedupeKey === `handoff:${runId}`, 'skeleton accepted', actor);
  }

  setMcpHandoff(runId: string, h: Handoff): void {
    const run = this.d.state.runs[runId];
    if (run) this.getCtx(run).mcpHandoff = h;
  }

  /** A parsed MCP handoff may arrive before exit; pickup capture must retain it before stop clears context. */
  stagedHandoff(runId: string): Handoff | null {
    return this.ctx.get(runId)?.mcpHandoff ?? null;
  }

  // ---- diff / scope ------------------------------------------------------------------------

  async refreshDiff(assignmentId: string): Promise<void> {
    const asg = this.d.state.assignments[assignmentId];
    if (!asg?.worktree || !asg.baseSha || !fs.existsSync(asg.worktree)) return;
    const run = Object.values(this.d.state.runs).filter((r) => r.assignmentId === assignmentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (!run) return;
    const files = (await changedFiles(asg.worktree, asg.baseSha).catch(() => [])).map((f) => f.path).filter((p) => !IGNORED_PATHS.includes(p));
    const bad = outOfScope(files, asg.allowedPaths, IGNORED_PATHS);
    if (JSON.stringify(files) === JSON.stringify(run.filesChanged) && JSON.stringify(bad) === JSON.stringify(run.outOfScope)) return;
    const refs = { agentId: run.agentId, runId: run.id, workItemId: run.workItemId, assignmentId };
    this.d.commit([{ type: 'run.files_changed', ...refs, data: { files, outOfScope: bad } }]);
    if (bad.length) {
      this.d.alert({ kind: 'scope_violation', severity: 'warn', agentId: run.agentId, runId: run.id, workItemId: run.workItemId, message: `${this.d.state.agents[run.agentId].config.name} changed files outside the allowed paths: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` (+${bad.length - 5})` : ''}`, dedupeKey: `scope:${run.id}:${bad.join(',')}` });
    }
  }

  // ---- restart -----------------------------------------------------------------------------

  recoverAll(): void {
    for (const run of Object.values(this.d.state.runs)) {
      if (!isActiveRun(run)) continue;
      if (isManualRelay(run)) continue; // waiting for a paste; nothing to reattach
      const mcpFile = path.join(this.supervisor.runDir(run.id), 'mcp.json');
      try {
        const { token } = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as { token: string };
        this.tokens.set(token, run.id);
        // The daemon URL may have changed (new port); refresh it for the MCP bridge.
        if (this.d.url) writePrivate(mcpFile, JSON.stringify({ url: this.d.url, token }));
      } catch {
        /* no MCP for this run */
      }
      this.getCtx(run);
      const r = this.supervisor.recover(run.id);
      const refs = { agentId: run.agentId, runId: run.id, workItemId: run.workItemId, assignmentId: run.assignmentId };
      if (r === 'missing') void this.finalize(run.id, { code: null, signal: null, orphaned: true, error: 'run directory is missing' });
      else this.d.commit([{ type: 't.system', ...refs, data: { text: r === 'reattached' ? 'daemon restarted: reattached to the live run' : r === 'exited' ? 'daemon restarted: run had exited; collecting its output' : 'daemon restarted: run was orphaned' } }]);
      const asg = this.d.state.assignments[run.assignmentId];
      if (r === 'reattached' && asg?.worktree) this.d.watcher.watch(asg.id, asg.worktree);
      if (r === 'orphaned') {
        this.d.alert({ kind: 'orphaned_run', severity: 'critical', agentId: run.agentId, runId: run.id, workItemId: run.workItemId, message: `${this.d.state.agents[run.agentId]?.config.name ?? run.agentId}'s run on ${this.d.state.workItems[run.workItemId]?.key} died while the daemon was down. Logs are kept; resume or reassign.`, dedupeKey: `orphan:${run.id}` });
      }
    }
  }
}
