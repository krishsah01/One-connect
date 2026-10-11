// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Built-in automations (each toggleable): auto-refill Now from Next, stall detection,
// failure retry with a connectivity check, usage-limit handling, idle-with-work alerts.
// They never downgrade a model and never enable paid usage.
import { lookup } from 'node:dns/promises';
import type { EventEnvelope, Run } from '@acc/core';
import { isActiveRun, subscriptionPeers, SYSTEM, isManualRelay } from '@acc/core';
import { adapterFor } from './adapters/agents/index.ts';
import { clampPollSeconds } from './adapters/hosts/webhook.ts';
import type { AgentCommands, Kernel, WorkCommands } from './kernel.ts';
import type { ReleaseFindings } from './release/findings.ts';
import type { CodeHosts } from './adapters/hosts/index.ts';
import type { InfraHealth } from './infra/health.ts';
import type { RunManager } from './runManager.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type RulesDeps = Kernel & Pick<WorkCommands, 'agentFree' | 'preflight' | 'tryTransition'> & Pick<AgentCommands, 'probe' | 'ruleOn'> & { readonly findings: ReleaseFindings; readonly hosts: CodeHosts; readonly infra: InfraHealth; readonly runs: RunManager };

const minutes = (n: number) => n * 60_000;

export class Rules {
  readonly d: RulesDeps;
  private timer: NodeJS.Timeout | null = null;
  private refilling = new Set<string>();
  /** Injected in tests; real check is a DNS lookup of the vendor's API host. */
  connectivity: (host: string) => Promise<boolean> = async (host) => {
    try {
      await Promise.race([lookup(host), new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 5000))]);
      return true;
    } catch {
      return false;
    }
  };
  retryDelayMs = 3000;

  constructor(d: RulesDeps) {
    this.d = d;
  }

  start(tickMs: number): void {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called for every committed event. */
  onEvent(e: EventEnvelope): void {
    // A stalled run that produces output again is no longer stalled.
    if (e.kind === 'transcript' && e.runId) {
      const open = Object.values(this.d.state.alerts).some((a) => a.dedupeKey === `stall:${e.runId}` && !a.resolvedAt);
      if (open) {
        queueMicrotask(() => {
          this.d.resolveAlerts((a) => a.dedupeKey === `stall:${e.runId}`, 'activity resumed');
          const run = this.d.state.runs[e.runId!];
          if (run && this.d.state.workItems[run.workItemId]?.state === 'stalled') this.d.tryTransition(run.workItemId, 'running', 'activity resumed');
        });
      }
    }
  }

  // ---- auto-refill -------------------------------------------------------------------------

  /** Now finished → promote Next and dispatch it if pre-flight passes and policy allows. */
  async refill(agentId: string): Promise<void> {
    const d = this.d;
    if (this.refilling.has(agentId) || !d.ruleOn('auto_refill') || !d.config.policies.auto_dispatch_next) return;
    const agent = d.state.agents[agentId];
    if (!agent || d.state.killSwitch.engaged || agent.queue.now || agent.queue.next.length === 0 || !d.agentFree(agentId)) return;
    this.refilling.add(agentId);
    try {
      const nextId = agent.queue.next[0];
      if (!agent.probedAt) await d.probe(agentId).catch(() => undefined);
      const pf = d.preflight(nextId);
      if (!pf.ok) {
        d.alert({
          kind: 'preflight_failed',
          severity: 'warn',
          agentId,
          workItemId: d.state.assignments[nextId]?.workItemId,
          message: `${agent.config.name} is idle with work queued: Next can't start (${pf.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.message}`).join('; ')})`,
          dedupeKey: `refill:${nextId}:${pf.checks.filter((c) => c.status === 'fail').map((c) => c.id).join(',')}`,
        });
        return;
      }
      d.resolveAlerts((a) => a.kind === 'preflight_failed' && a.agentId === agentId, 'next started');
      await d.runs.startAssignment(nextId, SYSTEM);
    } catch (e) {
      d.alert({ kind: 'run_failed', severity: 'warn', agentId, message: `auto-refill for ${agent.config.name} failed: ${(e as Error).message}`, dedupeKey: `refill-error:${agentId}:${(e as Error).message.slice(0, 60)}` });
    } finally {
      this.refilling.delete(agentId);
    }
  }

  // ---- run ended ---------------------------------------------------------------------------

  onRunEnded(runId: string): void {
    const d = this.d;
    const run = d.state.runs[runId];
    if (!run?.exit) return;
    const agent = d.state.agents[run.agentId];
    const kind = run.exit.kind;
    d.resolveAlerts((a) => a.runId === runId && (a.kind === 'stall' || a.kind === 'approval_pending'), 'run ended');

    if (kind === 'completed') {
      void this.refill(run.agentId);
      return;
    }
    if (kind === 'stopped' || kind === 'killed') return;
    const key = d.state.workItems[run.workItemId]?.key ?? run.workItemId;

    if (kind === 'network' && d.ruleOn('failure_retry')) {
      void this.retryAfterNetwork(run);
      return;
    }
    if (kind === 'usage_limit' && d.ruleOn('usage_limit')) {
      d.commit(subscriptionPeers(d.state.agents,run.agentId).map(a=>({ type: 'agent.limited' as const, agentId:a.id, data: { until: run.exit!.resetsAt ?? null, message: run.exit!.message } })));
      d.alert({ kind: 'usage_limit', severity: 'critical', agentId: run.agentId, runId, workItemId: run.workItemId, message: `${agent.config.name} hit its usage limit on ${key}${run.exit.resetsAt ? `; resets ${run.exit.resetsAt}` : ''}. No paid fallback was used.`, suggestion: this.reassignSuggestion(run), dedupeKey: `limit:${run.agentId}` });
      return;
    }
    if (kind === 'auth_expired') {
      d.commit([{ type: 'agent.paused', agentId: run.agentId, data: { reason: 'sign-in expired' } }]);
      d.alert({ kind: 'auth', severity: 'critical', agentId: run.agentId, runId, message: `${agent.config.name}'s sign-in expired. ${adapterFor(agent.config.adapter).loginHint}, then resume.`, dedupeKey: `${run.agentId}:auth` });
      return;
    }
    if (kind === 'model_unsupported') {
      d.commit([{ type: 'agent.paused', agentId: run.agentId, data: { reason: 'model not available for this account' } }]);
      d.alert({ kind: 'model', severity: 'critical', agentId: run.agentId, runId, message: `${agent.config.name}: model ${run.model ?? '?'} isn't available for this account (${run.exit.message}). The model was NOT downgraded automatically; pick one explicitly.`, dedupeKey: `model-unsupported:${run.agentId}:${run.model}` });
      return;
    }
    if (kind === 'billing_violation') {
      d.commit([{ type: 'agent.paused', agentId: run.agentId, data: { reason: 'billing violation' } }]);
      return;
    }
    d.alert({
      kind: kind === 'orphaned' ? 'orphaned_run' : 'run_failed',
      severity: 'critical',
      agentId: run.agentId,
      runId,
      workItemId: run.workItemId,
      message: `${agent.config.name}'s run on ${key} failed (${kind}): ${run.exit.message}`,
      suggestion: kind === 'sandbox_denied' ? { kind: 'text', text: 'The agent sandbox blocked a write. Worktree runs get --add-dir <git common dir>; check allowed paths and the vendor sandbox mode.' } : this.reassignSuggestion(run),
      dedupeKey: `fail:${runId}`,
    });
  }

  private reassignSuggestion(run: Run) {
    const d = this.d;
    const ids = Object.values(d.state.agents)
      .filter((a) => a.id !== run.agentId && a.config.mode !== 'coordinator-only' && d.agentFree(a.id) && (isManualRelay(a.config) || (a.auth.state === 'logged_in' && a.billing.mode === 'subscription')))
      .sort((a, b) => a.queue.next.length - b.queue.next.length)
      .map((a) => a.id);
    return { kind: 'reassign' as const, agentIds: ids, note: ids.length ? 'agents with capacity on included usage' : 'no other agent has capacity right now' };
  }

  /** Network failure: check connectivity, retry once (resuming the session), then pause + suggest. */
  private async retryAfterNetwork(run: Run): Promise<void> {
    const d = this.d;
    const agent = d.state.agents[run.agentId];
    const key = d.state.workItems[run.workItemId]?.key ?? run.workItemId;
    const refs = { agentId: run.agentId, runId: run.id, workItemId: run.workItemId, assignmentId: run.assignmentId };
    if (run.attempt >= 2) {
      d.commit([{ type: 'agent.paused', agentId: run.agentId, data: { reason: `network failures on ${key}` } }]);
      d.alert({ kind: 'retry_exhausted', severity: 'critical', agentId: run.agentId, runId: run.id, workItemId: run.workItemId, message: `${agent.config.name} failed twice on ${key} with network errors (${run.exit?.message}). Paused; reassign or resume.`, suggestion: this.reassignSuggestion(run), dedupeKey: `retry:${run.assignmentId}` });
      return;
    }
    const host = adapterFor(agent.config.adapter).vendorHost;
    let online = await this.connectivity(host);
    d.commit([{ type: 't.system', ...refs, data: { text: `network failure: ${host} is ${online ? 'reachable' : 'unreachable'}; ${online ? 'retrying once' : 'waiting for connectivity, then retrying once'}` } }]);
    for (let i = 0; !online && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 30_000));
      online = await this.connectivity(host);
    }
    await new Promise((r) => setTimeout(r, this.retryDelayMs));
    const fresh = d.state.agents[run.agentId];
    if (d.state.killSwitch.engaged || fresh.pausedReason || this.d.runs.activeRunFor(run.assignmentId)) return;
    try {
      const resume = run.sessionId && adapterFor(agent.config.adapter).capabilities.resume ? { sessionId: run.sessionId, message: 'The previous attempt was interrupted by a network error. Continue the assignment from where you left off, then finish with the handoff block.' } : null;
      await d.runs.startAssignment(run.assignmentId, SYSTEM, { resume, retryOf: run.id, attempt: run.attempt + 1 });
    } catch (e) {
      d.alert({ kind: 'retry_exhausted', severity: 'critical', agentId: run.agentId, runId: run.id, workItemId: run.workItemId, message: `retry for ${key} could not start: ${(e as Error).message}`, suggestion: this.reassignSuggestion(run), dedupeKey: `retry:${run.assignmentId}` });
    }
  }

  // ---- periodic ----------------------------------------------------------------------------

  async tick(): Promise<void> {
    const d = this.d;
    const now = d.now().getTime();
    const p = d.config.policies;

    if (d.ruleOn('stall_detection')) {
      for (const run of Object.values(d.state.runs)) {
        if (!isActiveRun(run)) continue;
        const name = d.state.agents[run.agentId]?.config.name ?? run.agentId;
        const key = d.state.workItems[run.workItemId]?.key ?? run.workItemId;
        const last = Date.parse(run.lastEventAt ?? run.startedAt ?? run.createdAt);
        if ((run.state === 'running' || run.state === 'starting') && now - last > minutes(p.stall.no_event_minutes)) {
          d.commit([{ type: 'run.state', agentId: run.agentId, runId: run.id, workItemId: run.workItemId, data: { state: 'stalled', reason: `no events for ${Math.round((now - last) / 60_000)} min` } }]);
          d.tryTransition(run.workItemId, 'stalled', 'no agent activity');
          d.alert({ kind: 'stall', severity: 'critical', agentId: run.agentId, runId: run.id, workItemId: run.workItemId, message: `${name} has produced no events on ${key} for ${Math.round((now - last) / 60_000)} min`, suggestion: { kind: 'text', text: 'Nudge it, check its console, or stop and reassign.' }, dedupeKey: `stall:${run.id}` });
        }
        if (run.state === 'waiting-for-input' && now - Date.parse(run.createdAt) > minutes(p.stall.approval_pending_minutes)) {
          d.alert({ kind: 'approval_pending', severity: 'warn', agentId: run.agentId, runId: run.id, workItemId: run.workItemId, message: `${name}'s relay prompt for ${key} has waited ${Math.round((now - Date.parse(run.createdAt)) / 60_000)} min for a reply to be pasted back`, dedupeKey: `relay-wait:${run.id}` });
        }
      }
      for (const ap of Object.values(d.state.approvals)) {
        if (ap.resolvedAt) continue;
        const age = now - Date.parse(ap.createdAt);
        if (age > minutes(p.stall.approval_pending_minutes)) {
          const name = d.state.agents[ap.agentId]?.config.name ?? ap.agentId;
          d.alert({ kind: 'approval_pending', severity: 'critical', agentId: ap.agentId, runId: ap.runId, workItemId: ap.workItemId ?? undefined, message: `${name} has been waiting ${Math.round(age / 60_000)} min for your answer: ${ap.title}`, dedupeKey: `approval:${ap.id}` });
        }
      }
    }

    for (const a of Object.values(d.state.agents)) {
      // Usage limit lifted?
      if (a.limitedUntil && a.limitedUntil !== 'unknown' && Date.parse(a.limitedUntil) <= now) {
        d.commit([{ type: 'agent.unlimited', agentId: a.id, data: { reason: 'limit window reset' } }]);
        d.resolveAlerts((x) => x.dedupeKey === `limit:${a.id}`, 'limit reset');
        const nowAsg = d.state.agents[a.id].queue.now;
        const lastRun = nowAsg ? Object.values(d.state.runs).filter((r) => r.assignmentId === nowAsg).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).at(-1) : null;
        if (lastRun?.exit?.kind === 'usage_limit' && lastRun.sessionId) {
          void d.runs.resume(lastRun.id, SYSTEM, 'Your usage limit has reset. Continue the assignment where you left off and finish with the handoff block.').catch(() => undefined);
        } else void this.refill(a.id);
      }
      // Idle while work is waiting (the "agent sat idle" failure mode).
      if (a.idleWithWorkSince && now - Date.parse(a.idleWithWorkSince) > minutes(p.idle_alert_minutes)) {
        d.alert({ kind: 'idle_with_work', severity: 'warn', agentId: a.id, message: `${a.config.name} has been idle ${Math.round((now - Date.parse(a.idleWithWorkSince)) / 60_000)} min with work queued${a.pausedReason ? ` (paused: ${a.pausedReason})` : a.limitedUntil ? ' (usage limited)' : ''}`, dedupeKey: `idle:${a.id}:${a.idleWithWorkSince}` });
      } else if (!a.idleWithWorkSince) {
        d.resolveAlerts((x) => x.kind === 'idle_with_work' && x.agentId === a.id, 'working again');
      }
      if (!a.queue.now && a.queue.next.length) void this.refill(a.id);
    }
    void this.watchInfra();
  }

  private watching = false;

  /** Paused databases, failing CI and an unprotected production branch. Read-only. */
  async watchInfra(): Promise<void> {
    if (this.watching || !this.d.ruleOn('infra_watch')) return;
    const last = this.d.store.kvGet('infra:watch-at');
    const waitMs = clampPollSeconds(this.d.config.code_host?.poll_seconds) * 1000;
    if (last && this.d.now().getTime() - Date.parse(last) < waitMs) return;
    this.watching = true;
    this.d.store.kvSet('infra:watch-at', this.d.nowIso());
    try {
      await this.d.infra.refresh();
      await this.d.hosts.refresh();
      this.d.findings.maybeAuto();
      this.d.resolveAlerts((a) => a.dedupeKey === 'infra-watch-error', 'infra watch finished');
    } catch (e) {
      this.d.alert({ kind: 'infra', severity: 'warn', message: `Infra watch could not finish: ${(e as Error).message}`, dedupeKey: 'infra-watch-error' });
    } finally {
      this.watching = false;
    }
  }
}
