// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Agent commands: builder validation and saves (paid modes need a bound cost Decision), runtime
// probes that raise or resolve login/billing/model alerts, model swaps and resuming paused agents.
// Daemon exposes these through its facade methods.
import { isDeepStrictEqual } from 'node:util';
import type { Actor, AgentConfig, AgentState, ControlCenterConfig, NewEvent } from '@acc/core';
import { AgentConfigSchema, containsSecret, HUMAN, isManualRelay, parseConfig, resolveModel, subscriptionPeers } from '@acc/core';
import { needsCostApproval, type AgentCosts } from './agentCosts.ts';
import type { AnswerOptions } from './decisions.ts';
import { CommandError } from './errors.ts';
import type { AgentCommands, ConfigurableKernel } from './kernel.ts';
import { probeAgent } from './probe.ts';
import type { Rules } from './rules.ts';
import type { RunManager } from './runManager.ts';
import type { SkillLibrary } from './skills.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type AgentServiceDeps = ConfigurableKernel & Pick<AgentCommands, 'probe'> & {
  readonly skillLib: SkillLibrary;
  readonly agentCosts: AgentCosts;
  readonly runs: RunManager;
  readonly rules: Rules;
};

export class AgentService implements AgentCommands {
  readonly d: AgentServiceDeps;

  constructor(d: AgentServiceDeps) {
    this.d = d;
  }

  /** Validate a builder draft without saving, probing a provider or dispatching work. */
  validateAgentSettings(input:unknown,expected:unknown=null) {
    const parsed=AgentConfigSchema.safeParse(input);
    if(!parsed.success) throw new CommandError(parsed.error.message);
    const cfg=parsed.data,previous=this.d.state.agents[cfg.id];
    if(cfg.skills.some(id=>!this.d.skillLib.assignable(id))) throw new CommandError('Choose skills from the installed catalog or a published, enabled project skill.');
    if(previous) {
      const old=AgentConfigSchema.safeParse(expected);
      if(!old.success || !isDeepStrictEqual(old.data,previous.config)) throw new CommandError('Agent settings changed. Reopen the builder to use the latest settings.',409);
      if(previous.activeRunIds.length || previous.queue.now || previous.queue.next.length) throw new CommandError('Finish or cancel this agent’s Now and Next assignments before editing it.',409);
    } else if(expected!==null) throw new CommandError('This agent no longer exists. Reopen the builder.',409);
    if(containsSecret(JSON.stringify(cfg),{denylist:this.d.denylist()}).length) throw new CommandError('Remove credentials from agent settings. Use vendor login or the dedicated connection store.');
    const next=parseConfig({...this.d.config,agents:previous?this.d.config.agents.map(a=>a.id===cfg.id?cfg:a):[...this.d.config.agents,cfg]});
    return {cfg,next};
  }

  /** The exact cost answer, settings and override commit together; no boolean paid-mode bypass. */
  saveAgent(input:unknown,expected:unknown=null,o:{costDecisionId?:string;answerOptions?:AnswerOptions}={}) {
    const {cfg,next}=this.validateAgentSettings(input,expected);
    let approval:{events:NewEvent[];transaction:()=>void}|undefined;
    if(needsCostApproval(cfg)) {
      if(!o.costDecisionId) throw new CommandError('Paid agents require a reviewed per-agent cost Decision.');
      approval=this.d.agentCosts.authorize(o.costDecisionId,cfg,expected,o.answerOptions??{});
    }
    const overrides=JSON.parse(this.d.store.kvGet('agents:overrides')??'{}') as Record<string,unknown>;
    const oldConfig=this.d.config;
    this.d.config=next;
    try {
      this.d.commit([...(approval?.events??[]),{type:'agent.registered',actor:HUMAN,agentId:cfg.id,data:{config:cfg}}],[],()=>{approval?.transaction();this.d.store.kvSet('agents:overrides',JSON.stringify({...overrides,[cfg.id]:cfg}));});
    } catch(e) {this.d.config=oldConfig;throw e;}
    this.d.refreshEgress();
    return this.d.state.agents[cfg.id];
  }

  async probeAll(): Promise<void> {
    await Promise.all(Object.values(this.d.state.agents).filter(a=>a.config.enabled!==false).map((a) => this.d.probe(a.id).catch(() => undefined)));
  }

  async probe(agentId: string): Promise<void> {
    const agent = this.d.state.agents[agentId];
    if (!agent) throw new CommandError(`unknown agent ${agentId}`, 404);
    if(agent.config.enabled===false) throw new CommandError('Enable this saved agent before checking its runtime.',409);
    const r = await probeAgent(agent, this.d.baseEnv(), this.d.runs.sessionIdsFor(agentId), this.d.egress.fetch);
    if(this.d.closed || JSON.stringify(this.d.state.agents[agentId]?.config)!==JSON.stringify(agent.config)) return;
    this.d.commit([{ type: 'agent.probed', agentId, data: r }]);
    const a = this.d.state.agents[agentId];
    const open = (k: string) => `${agentId}:${k}`;
    if (!isManualRelay(a.config) && (a.auth.state === 'expired' || a.auth.state === 'not_installed')) {
      this.d.alert({ kind: 'auth', severity: 'critical', agentId, message: `${a.config.name}: ${a.auth.state.replace('_', ' ')}${a.auth.fix ? `: ${a.auth.fix}` : ''}`, dedupeKey: open('auth') });
    } else this.d.resolveAlerts((x) => x.dedupeKey === open('auth'), 'signed in');
    if (a.billing.mode === 'metered' && !a.config.metered_opt_in) {
      this.d.alert({ kind: 'billing', severity: 'critical', agentId, message: `${a.config.name} would bill per token (${a.billing.source}). Dispatch is blocked; fix the login or opt in explicitly.`, dedupeKey: open('billing') });
    } else this.d.resolveAlerts((x) => x.dedupeKey === open('billing'), 'subscription billing');
    if (r.newerBinary) {
      this.d.alert({ kind: 'binary_changed', severity: 'info', agentId, message: `${a.config.name}: a newer CLI exists at ${r.newerBinary.path} (${r.newerBinary.version}${r.newerBinary.prerelease ? ', prerelease' : ''}) than the pinned ${a.binary?.path} (${a.binary?.version}). Pin it with \`binary:\` if you want it.`, dedupeKey: open(`newer-binary:${r.newerBinary.path}:${r.newerBinary.version}`) });
    }
    const resolved = this.resolveModelFor(agentId);
    if (resolved.newest && a.config.model !== 'newest' && resolved.newest !== a.config.model && this.d.config.policies.newest_model_rule) {
      this.d.alert({ kind: 'model', severity: 'warn', agentId, message: `${a.config.name} is configured for ${a.config.model}; ${resolved.newest} is newer`, dedupeKey: open(`model:${resolved.newest}`) });
    }
  }

  spentToday(agentId: string): number {
    const start = new Date(this.d.now());
    start.setHours(0, 0, 0, 0);
    let sum = 0;
    for (const r of Object.values(this.d.state.runs)) if (r.agentId === agentId && Date.parse(r.createdAt) >= start.getTime()) sum += r.usage.costUsd ?? 0;
    return sum;
  }

  resolveModelFor(agentId: string): { model: string | null; newest: string | null } {
    const a = this.d.state.agents[agentId];
    return a ? resolveModel(a, this.d.config.policies) : { model: null, newest: null };
  }

  swapModel(agentId: string, model: string, actor: Actor = HUMAN): void {
    const agent = this.d.state.agents[agentId];
    if (!agent) throw new CommandError(`unknown agent ${agentId}`, 404);
    this.d.commit([{ type: 'agent.model_changed', actor, agentId, data: { model } }]);
  }

  resumeAgent(agentId: string, actor: Actor = HUMAN): void {
    const agent = this.d.state.agents[agentId];
    if (!agent) throw new CommandError(`unknown agent ${agentId}`, 404);
    const events: NewEvent[] = [];
    if (agent.pausedReason) events.push({ type: 'agent.resumed', actor, agentId, data: {} });
    for(const peer of subscriptionPeers(this.d.state.agents,agentId)) if(peer.limitedUntil) events.push({ type: 'agent.unlimited', actor, agentId:peer.id, data: { reason: 'shared subscription limit cleared by owner' } });
    this.d.commit(events);
    void this.d.rules.refill(agentId);
  }
}
