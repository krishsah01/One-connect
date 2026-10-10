// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Human decisions bound to one exact action. Irreversible or outward options need a second,
// single-use confirmation; only a human actor can answer; recommendations (e.g. Jev) are advisory.
import { randomBytes } from 'node:crypto';
import type { Actor, Decision, EventEnvelope, NewEvent } from '@acc/core';
import { HUMAN, newId } from '@acc/core';
import { CommandError, type Daemon } from './daemon.ts';
import { sha256 } from './util/hash.ts';

const CONFIRM_TTL_MS = 2 * 60_000;
export interface AnswerOptions { nonce?: string | null; channel?: string }

export type NewDecision = Pick<Decision, 'question' | 'options'> &
  Partial<Pick<Decision, 'recommendation' | 'evidenceLinks' | 'urgency' | 'irreversible' | 'kind' | 'workItemId' | 'risk' | 'action' | 'evidence' | 'confirmOptions' | 'expiresAt'>>;

export class Decisions {
  readonly d: Daemon;

  constructor(d: Daemon) {
    this.d = d;
  }

  create(input: NewDecision, actor: Actor = HUMAN): Decision {
    const options = input.options.map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) throw new CommandError('a decision needs at least two options');
    const decision: Decision = {
      id: newId('decision'),
      question: input.question,
      options,
      recommendation: input.recommendation ?? null,
      evidenceLinks: input.evidenceLinks ?? [],
      urgency: input.urgency ?? 'normal',
      irreversible: input.irreversible ?? false,
      answer: null,
      answeredAt: null,
      channel: null,
      createdAt: this.d.nowIso(),
      kind: input.kind ?? 'question',
      workItemId: input.workItemId ?? null,
      risk: input.risk ?? 'low',
      action: input.action ?? null,
      evidence: input.evidence ?? [],
      confirmOptions: (input.confirmOptions ?? (input.irreversible ? [options[0]] : [])).filter((o) => options.includes(o)),
      recommendedBy: null,
      rationale: null,
      answeredBy: null,
      confirmedAt: null,
      consumedAt: null,
      outcome: null,
      expiresAt: input.expiresAt ?? null,
    };
    this.d.commit([{ type: 'decision.created', actor, workItemId: decision.workItemId ?? null, data: { decision } }]);
    return this.d.state.decisions[decision.id];
  }

  /** Like create(), but also commits `extra` events and binds the exact action in the same transaction. */
  createBound(input: NewDecision, actor: Actor, extra: (id: string) => NewEvent[], bind: (id: string) => void): Decision {
    const options = input.options.map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) throw new CommandError('a decision needs at least two options');
    const id = newId('decision');
    const decision: Decision = {
      id, question: input.question, options, recommendation: input.recommendation ?? null, evidenceLinks: input.evidenceLinks ?? [], urgency: input.urgency ?? 'normal', irreversible: input.irreversible ?? false,
      answer: null, answeredAt: null, channel: null, createdAt: this.d.nowIso(), kind: input.kind ?? 'question', workItemId: input.workItemId ?? null, risk: input.risk ?? 'low', action: input.action ?? null,
      evidence: input.evidence ?? [], confirmOptions: (input.confirmOptions ?? []).filter((o) => options.includes(o)), recommendedBy: null, rationale: null, answeredBy: null, confirmedAt: null, consumedAt: null, outcome: null, expiresAt: input.expiresAt ?? null,
    };
    this.d.commit([{ type: 'decision.created', actor, workItemId: decision.workItemId ?? null, data: { decision } }, ...extra(id)], [], () => bind(id));
    return this.d.state.decisions[id];
  }

  private open(id: string): Decision {
    const dec = this.d.state.decisions[id];
    if (!dec) throw new CommandError(`unknown decision ${id}`, 404);
    if (dec.answeredAt) throw new CommandError('this decision was already answered', 409);
    if (dec.consumedAt) throw new CommandError(`this decision is closed: ${dec.outcome ?? 'consumed'}`, 409);
    return dec;
  }

  private requireHuman(actor: Actor): void {
    // Agents, the system and advisory models (Jev) may recommend; only the owner answers.
    if (actor.type !== 'human' || /^jev$/i.test(actor.id)) throw new CommandError('only the human owner can answer a decision', 403);
  }

  needsConfirmation(dec: Decision, answer: string): boolean {
    return (dec.confirmOptions ?? (dec.irreversible ? [dec.options[0]] : [])).includes(answer);
  }

  /** First step for an irreversible option: returns a single-use nonce for the confirmation. */
  prepare(id: string, answer: string, actor: Actor = HUMAN): { confirm: boolean; nonce: string | null; expiresAt: string | null } {
    this.requireHuman(actor);
    const dec = this.open(id);
    if (!dec.options.includes(answer)) throw new CommandError(`choose one of: ${dec.options.join(', ')}`);
    if (!this.needsConfirmation(dec, answer)) return { confirm: false, nonce: null, expiresAt: null };
    const nonce = randomBytes(18).toString('hex');
    const expiresAt = new Date(this.d.now().getTime() + CONFIRM_TTL_MS).toISOString();
    this.d.commit([{ type: 'decision.confirmation_requested', actor, workItemId: dec.workItemId ?? null, data: { decisionId: id, answer, expiresAt } }], [], () =>
      this.d.store.kvSet(`decision-confirm:${id}`, JSON.stringify({ nonce: sha256(nonce), answer, expiresAt })),
    );
    return { confirm: true, nonce, expiresAt };
  }

  /** Validate immediately before the action's transaction, without consuming its answer. */
  validateAnswer(id: string, answer: string, o: AnswerOptions = {}, actor: Actor = HUMAN): { decision: Decision; confirmed: boolean } {
    this.requireHuman(actor);
    const dec = this.open(id);
    if (!dec.options.includes(answer)) throw new CommandError(`choose one of: ${dec.options.join(', ')}`);
    const confirm = this.needsConfirmation(dec, answer);
    if (confirm) {
      const raw = this.d.store.kvGet(`decision-confirm:${id}`);
      const pending = raw ? (JSON.parse(raw) as { nonce: string; answer: string; expiresAt: string }) : null;
      if (!pending || !o.nonce || pending.nonce !== sha256(o.nonce) || pending.answer !== answer) throw new CommandError('confirm this irreversible action on the confirmation step first', 428);
      if (Date.parse(pending.expiresAt) < this.d.now().getTime()) throw new CommandError('the confirmation expired; start again', 410);
    }
    return { decision: dec, confirmed: confirm };
  }

  /**
   * The exact action's authorization and its human answer commit in the same transaction.
   * `outbox` is the tracker's ordered comment queue (release steps record the outcome there).
   */
  answerAtomic(id: string, answer: string, o: AnswerOptions = {}, actor: Actor = HUMAN, events: Parameters<Daemon['commit']>[0] = [], transaction?: () => void, outbox: Parameters<Daemon['commit']>[1] = []): Decision {
    const { decision: dec, confirmed: confirm } = this.validateAnswer(id, answer, o, actor);
    this.d.commit([{ type: 'decision.answered', actor, workItemId: dec.workItemId ?? null, data: { decisionId: id, answer, channel: o.channel ?? 'web', confirmed: confirm } }, ...events], outbox, () => {
      if (confirm) this.d.store.kvDelete(`decision-confirm:${id}`);
      transaction?.();
    });
    return this.d.state.decisions[id];
  }

  /** Plain answers cannot consume an approval owned by a specialized action executor. */
  answer(id: string, answer: string, o: AnswerOptions = {}, actor: Actor = HUMAN): Decision {
    if (['workflow-link:decision:', 'settings:decision:', 'agent-cost:', 'connector:decision:', 'connector-tool:', 'env-action:', 'docker:', 'remote:decision:', 'notify:decision:', 'release:', 'release-rollback:', 'release-inspect:'].some(prefix => this.d.store.kvGet(`${prefix}${id}`))) {
      throw new CommandError('Answer this bound action through its action executor', 409);
    }
    return this.answerAtomic(id, answer, o, actor);
  }

  /** All dashboard surfaces use the same action router, including the phone inbox. */
  async respond(id: string, answer: string, o: AnswerOptions = {}, actor: Actor = HUMAN) {
    this.validateAnswer(id, answer, o, actor);
    const workflowLinkId = this.d.store.kvGet(`workflow-link:decision:${id}`);
    if (workflowLinkId) {
      const link = await this.d.workflowLinks.decide(workflowLinkId, answer, actor, o);
      return { decision: this.d.state.decisions[id], link };
    }
    if (this.d.store.kvGet(`settings:decision:${id}`)) {
      const settings = await this.d.settings.resolve(id, answer, o);
      return { decision: this.d.state.decisions[id], settings };
    }
    if (this.d.store.kvGet(`agent-cost:${id}`)) {
      const cost = this.d.agentCosts.resolve(id, answer, o, actor);
      return { decision: this.d.state.decisions[id], cost };
    }
    if (this.d.store.kvGet(`connector:decision:${id}`)) {
      const connection = await this.d.connectors.resolve(id, answer, actor, o);
      return { decision: this.d.state.decisions[id], connection };
    }
    if (this.d.store.kvGet(`connector-tool:${id}`)) {
      const tool = await this.d.connectors.resolveToolCall(id, answer, actor, o);
      return { decision: this.d.state.decisions[id], tool };
    }
    const environment = this.d.store.kvGet(`env-action:${id}`);
    if (environment) {
      const pending = JSON.parse(environment) as { digest: string };
      const action = await this.d.environment.resolve(id, answer, pending.digest, o);
      return { decision: this.d.state.decisions[id], environment: action };
    }
    if (this.d.store.kvGet(`docker:${id}`)) {
      const docker = await this.d.docker.resolve(id, answer, o);
      return { decision: this.d.state.decisions[id], docker };
    }
    if (this.d.remote.isRemoteDecision(id)) {
      const r = await this.d.remote.resolve(id, answer, actor, o);
      return { decision: this.d.state.decisions[id], remote: r.status };
    }
    if (this.d.notifications.isEndpointDecision(id)) {
      const notification = await this.d.notifications.resolveEndpoint(id, answer, actor, o);
      return { decision: this.d.state.decisions[id], notification };
    }
    if (this.d.store.kvGet(`release:${id}`) || this.d.store.kvGet(`release-rollback:${id}`) || this.d.store.kvGet(`release-inspect:${id}`)) {
      const release = await this.d.releasePlans.resolve(id, answer, o);
      return { decision: this.d.state.decisions[id], release };
    }
    if (['settings', 'cost', 'connector', 'environment', 'docker', 'remote', 'notification', 'release'].includes(this.d.state.decisions[id]?.kind ?? '')) {
      throw new CommandError('The action binding is missing; request a fresh approval', 409);
    }
    return this.d.reviewMerge.answer(id, answer, o, actor);
  }

  /** Advisory only. Never changes the answer or what the decision authorizes. */
  recommend(id: string, recommendation: string, rationale: string, actor: Actor): Decision {
    const dec = this.open(id);
    if (!dec.options.includes(recommendation)) throw new CommandError(`recommend one of: ${dec.options.join(', ')}`);
    this.d.commit([{ type: 'decision.recommended', actor, workItemId: dec.workItemId ?? null, data: { decisionId: id, recommendation, rationale: rationale.slice(0, 2000) } }]);
    return this.d.state.decisions[id];
  }

  consume(id: string, outcome: string, actor: Actor = HUMAN): void {
    const dec = this.d.state.decisions[id];
    if (!dec || dec.consumedAt) return;
    this.d.commit([{ type: 'decision.consumed', actor, workItemId: dec.workItemId ?? null, data: { decisionId: id, outcome } }]);
  }

  /**
   * Whether this decision authorizes `hash` right now: answered by a human with `approve`, confirmed
   * when required, not consumed, and bound to exactly this action.
   */
  authorizes(id: string, approve: string, hash: string): { ok: true; decision: Decision } | { ok: false; reason: string } {
    const dec = this.d.state.decisions[id];
    if (!dec) return { ok: false, reason: 'no recorded decision' };
    if (dec.consumedAt) return { ok: false, reason: `decision already used (${dec.outcome ?? 'consumed'})` };
    if (!dec.answeredAt || dec.answer !== approve) return { ok: false, reason: dec.answeredAt ? `the owner answered "${dec.answer}"` : 'the owner has not approved this yet' };
    if (dec.answeredBy?.type !== 'human') return { ok: false, reason: 'the approval was not recorded by a human' };
    if (this.needsConfirmation(dec, approve) && !dec.confirmedAt) return { ok: false, reason: 'the irreversible action was not confirmed' };
    if (!dec.action || dec.action.hash !== hash) return { ok: false, reason: 'the decision is bound to a different action' };
    return { ok: true, decision: dec };
  }

  /** Audit trail for one decision, oldest first. */
  history(id: string): EventEnvelope[] {
    if (!this.d.state.decisions[id]) throw new CommandError(`unknown decision ${id}`, 404);
    return this.d.store
      .list({ kind: 'control', types: ['decision.created', 'decision.recommended', 'decision.confirmation_requested', 'decision.answered', 'decision.consumed', 'decision.advisory', 'decision.advisory_invalidated', 'jev.cancelled', 'connector.activated', 'connector.activation_denied', 'docker.action', 'merge.completed', 'merge.refused', 'merge.post_checks', 'release.saved'], limit: 100_000 })
      .filter((e) => {
        const data = e.data as { decisionId?: string; decision?: { id: string }; merge?: { decisionId: string }; mergeId?: string; plan?: { steps?: { decisionId?: string | null }[] } };
        if (data.decisionId === id || data.decision?.id === id || data.merge?.decisionId === id) return true;
        if (data.plan?.steps?.some((s) => s.decisionId === id)) return true;
        return Boolean(data.mergeId && this.d.state.merges[data.mergeId]?.decisionId === id);
      });
  }
}
