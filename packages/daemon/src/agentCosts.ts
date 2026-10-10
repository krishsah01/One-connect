// SPDX-License-Identifier: Apache-2.0
// A paid configuration is a draft until its exact settings are approved by the owner.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HUMAN, PAID_PROVIDERS, type Actor, type AgentConfig, type NewEvent } from '@acc/core';
import { CommandError, type Daemon } from './daemon.ts';
import type { AnswerOptions } from './decisions.ts';

interface PendingCost {
  config: AgentConfig;
  expected: AgentConfig | null;
  hash: string;
  expiresAt: string;
}
const PREFIX = 'agent-cost:';
const TTL_MS = 15 * 60_000;
const hash = (config: AgentConfig, expected: AgentConfig | null) => createHash('sha256').update(JSON.stringify({ config, expected })).digest('hex');
export const needsCostApproval = (cfg: AgentConfig) => PAID_PROVIDERS.includes(cfg.provider) || cfg.billing === 'metered' || cfg.metered_opt_in || cfg.on_demand;

export class AgentCosts {
  readonly d: Daemon;
  constructor(d: Daemon) { this.d = d; }

  request(input: unknown, expected: unknown = null, actor: Actor = HUMAN) {
    if (actor.type !== 'human' || actor.id === 'jev') throw new CommandError('Only the owner can request a paid agent configuration', 403);
    const { cfg } = this.d.validateAgentSettings(input, expected);
    if (!needsCostApproval(cfg)) throw new CommandError('This agent uses an included subscription or a local model; save it normally.');
    if (!cfg.metered_opt_in) throw new CommandError('The reviewed draft must explicitly specify metered billing.');
    if (!Number.isFinite(cfg.budget_usd_per_day) || !cfg.budget_usd_per_day || cfg.budget_usd_per_day > 10_000) throw new CommandError('Choose a daily stop threshold between $0 and $10,000.');
    if (!cfg.pricing || !Number.isFinite(cfg.pricing.input_per_mtok) || !Number.isFinite(cfg.pricing.output_per_mtok)) throw new CommandError('Set the model’s input and output prices so usage can be estimated when the provider omits cost.');
    if (cfg.base_url) {
      let endpoint: URL;
      try { endpoint = new URL(cfg.base_url); } catch { throw new CommandError('Choose a valid HTTPS provider endpoint.'); }
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new CommandError('Paid endpoints must use HTTPS without credentials, query strings or fragments.');
    }
    const previous = this.d.state.agents[cfg.id]?.config ?? null;
    const digest = hash(cfg, previous);
    const expiresAt = new Date(this.d.now().getTime() + TTL_MS).toISOString();
    const old = Object.values(this.d.state.decisions).filter(x => x.kind === 'cost' && x.action?.kind === 'cost' && x.action.agentId === cfg.id && !x.answeredAt && !x.consumedAt);
    const same = old.find(x => x.action?.hash === digest && Date.parse(x.expiresAt ?? '') > this.d.now().getTime());
    if (same) return { decision: same, saved: false };
    const pending: PendingCost = { config: cfg, expected: previous, hash: digest, expiresAt };
    const decision = this.d.decisions.createBound({
      kind: 'cost', question: `Enable paid usage for ${cfg.name}?`, options: ['approve', 'deny'], recommendation: 'deny',
      risk: 'high', urgency: 'normal', irreversible: true, confirmOptions: ['approve'], expiresAt,
      action: { kind: 'cost', agentId: cfg.id, provider: cfg.provider, model: cfg.model, budgetUsdPerDay: cfg.budget_usd_per_day, hash: digest },
      evidence: [
        { label: 'Exact configuration', detail: JSON.stringify(cfg, null, 2) },
        { label: 'Cost', detail: `Pay per token · ${cfg.provider} · ${cfg.model}. Stop threshold $${cfg.budget_usd_per_day}/day (per agent).` },
        { label: 'Price estimate', detail: `$${cfg.pricing.input_per_mtok} input / $${cfg.pricing.output_per_mtok} output per million tokens. Provider-reported cost takes precedence.` },
        { label: 'Limit of this threshold', detail: 'Stops on recorded usage; in-flight requests and other agents can exceed it. Set a provider-side spending limit for a hard cap.' },
        { label: 'Paid fallback', detail: cfg.on_demand ? 'On-demand is explicitly requested in this exact configuration.' : 'OFF. No automatic provider or model fallback.' },
        { label: 'Activation', detail: cfg.enabled ? 'Runtime checks are enabled. No run starts until an issue is dispatched.' : 'Saved disabled. No provider request or run starts.' },
      ],
    }, actor, () => old.map(x => ({ type: 'decision.consumed', actor, data: { decisionId: x.id, outcome: 'superseded by a new paid configuration' } })), id => {
      for (const prior of old) { this.d.store.kvDelete(PREFIX + prior.id); this.d.store.kvDelete(`decision-confirm:${prior.id}`); }
      this.d.store.kvSet(PREFIX + id, JSON.stringify(pending));
    });
    return { decision, saved: false };
  }

  /** Called again inside saveAgent immediately before its synchronous transaction. */
  authorize(id: string, cfg: AgentConfig, expected: unknown, options: AnswerOptions) {
    const { decision, confirmed } = this.d.decisions.validateAnswer(id, 'approve', options, HUMAN);
    const raw = this.d.store.kvGet(PREFIX + id);
    if (!raw) throw new CommandError('The paid configuration binding is missing; request approval again.', 409);
    const pending = JSON.parse(raw) as PendingCost;
    if (Date.parse(pending.expiresAt) <= this.d.now().getTime()) throw new CommandError('This paid configuration approval expired; reopen the builder.', 410);
    if (decision.kind !== 'cost' || decision.action?.kind !== 'cost' || decision.action.hash !== pending.hash || hash(cfg, pending.expected) !== pending.hash || !isDeepStrictEqual(expected, pending.expected)) throw new CommandError('The configuration differs from the settings the owner reviewed.', 409);
    this.d.validateAgentSettings(cfg, expected);
    const events: NewEvent[] = [
      { type: 'decision.answered', actor: HUMAN, agentId: cfg.id, data: { decisionId: id, answer: 'approve', channel: options.channel ?? 'web', confirmed } },
      { type: 'decision.consumed', actor: HUMAN, agentId: cfg.id, data: { decisionId: id, outcome: 'exact paid configuration saved' } },
    ];
    return { events, transaction: () => { this.d.store.kvDelete(PREFIX + id); this.d.store.kvDelete(`decision-confirm:${id}`); } };
  }

  resolve(id: string, answer: string, options: AnswerOptions, actor: Actor = HUMAN) {
    this.d.decisions.validateAnswer(id, answer, options, actor);
    if (answer === 'deny') {
      this.d.decisions.answerAtomic(id, answer, options, actor, [{ type: 'decision.consumed', actor, data: { decisionId: id, outcome: 'paid configuration denied' } }], () => this.d.store.kvDelete(PREFIX + id));
      return { saved: false, agent: null };
    }
    const raw = this.d.store.kvGet(PREFIX + id);
    if (!raw) throw new CommandError('The paid configuration binding is missing.', 409);
    const pending = JSON.parse(raw) as PendingCost;
    return { saved: true, agent: this.d.saveAgent(pending.config, pending.expected, { costDecisionId: id, answerOptions: options }) };
  }
}
