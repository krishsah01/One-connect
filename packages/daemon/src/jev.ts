// SPDX-License-Identifier: Apache-2.0
// Jev = TypeSafe's System One model, used ONLY to recommend and prioritise a human decision.
//
//  - Disabled by default. Enabling needs the owner's explicit cost + network + data confirmation
//    for one named host, and a key in the Keychain ('jev'). Nothing is requested before that.
//  - Every request is previewed first: the exact bounded, redacted evidence, the host and its
//    hash. The request only goes out for that hash, with a fresh explicit confirmation.
//  - The result (answer, model version, usage, input hash) is persisted on the decision as an
//    advisory, separate from agent suggestions. If the decision's evidence changes afterwards the
//    advisory is invalidated. It never answers, confirms or authorizes anything: only a human
//    actor can answer, and Decisions.requireHuman rejects the `jev` actor outright.
//
// Protocol verified from https://docs.typesafe.ai/api on 2026-10-07. System One accepts
// {state, model, questions} and returns {model, answers, usage}. Fixtures validate that public
// contract; this build has made no live or paid TypeSafe request.
import { createHash } from 'node:crypto';
import type { Actor, Decision, DecisionAction, JevAdvisory } from '@acc/core';
import { HUMAN } from '@acc/core';
import { CommandError, type Daemon } from './daemon.ts';
import { getSecret, hasSecret } from './secrets.ts';

export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai';
export const JEV_PATH = '/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_ACTOR: Actor = { type: 'system', id: 'jev' };
const MAX_EVIDENCE_ITEMS = 20;
const MAX_PAYLOAD_CHARS = 6000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface JevConfig { enabled: boolean; endpoint: string; confirmedAt: string | null; confirmations: string[] }
export interface JevConfirm { cost?: boolean; network?: boolean; data?: boolean; host?: string }

export const JEV_DISCLOSURE = {
  cost: 'Each recommendation is a metered TypeSafe request billed to your Jev account.',
  network: 'The shown evidence is sent over the network to the TypeSafe host below. Nothing else is sent.',
  data: 'The question, options and the redacted, bounded evidence of one decision leave this machine. Secrets are redacted first; review the preview before confirming.',
  authority: 'A Jev result is advice. It is never recorded as your answer or approval, and it cannot confirm an irreversible action.',
} as const;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Bound transport consumption as well as JSON parsing; never buffer an arbitrary reply. */
async function boundedResponse(res: Response): Promise<string> {
  if (!res.body) throw new CommandError('Jev returned an empty response. Nothing was recorded.', 502);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CommandError('Jev response exceeded 64 KiB. Nothing was recorded.', 502);
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError('Jev returned an unreadable or interrupted response. Nothing was recorded.', 502);
  } finally { reader.releaseLock(); }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export function validateEndpoint(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CommandError('Enter the Jev endpoint as a full URL, e.g. https://api.typesafe.ai');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new CommandError('The Jev endpoint must use https (plain http is only accepted for a loopback test server)');
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new CommandError('Use only the origin (scheme and host) of the Jev endpoint, with no credentials or path');
  return u;
}

export interface JevEvidence { payload: Record<string, unknown>; hash: string; items: number; chars: number; truncated: boolean; evidenceIds: string[] }

/** The preview and paid request use the same documented System One envelope. */
export function systemOneRequest(payload: Record<string, unknown>) {
  const options = payload.options as string[];
  return {
    model: JEV_MODEL,
    state: payload,
    questions: {
      decision: {
        type: 'choice',
        instructions: { question: payload.question, authority: 'Recommend one option for a human to review; this is advice and never authorization.' },
        // Stable IDs avoid collisions caused by redaction or clipping option text.
        criteria: Object.fromEntries(options.map((option, i) => [`option_${i}`, option])),
      },
    },
  };
}

function actionEvidence(action: DecisionAction | null | undefined, r: (s: string, n: number) => string): Record<string, unknown> | null {
  if (!action) return null;
  const common = { kind: action.kind, hash: r(action.hash, 128) };
  switch (action.kind) {
    case 'merge':
      return { ...common, sourceBranch: r(action.sourceBranch, 120), sourceSha: r(action.sourceSha, 64), target: r(action.target, 120), targetSha: r(action.targetSha, 64), reviewId: r(action.reviewId, 120) };
    case 'settings':
      return { ...common, repo: r(action.repo, 240) };
    case 'cost':
      return { ...common, agentId: r(action.agentId, 120), provider: r(action.provider, 120), model: r(action.model, 120), budgetUsdPerDay: action.budgetUsdPerDay };
    case 'release':
    case 'release_rollback':
    case 'release_inspect':
      return { ...common, planId: r(action.planId, 120), stepId: r(action.stepId, 120), stepKind: action.stepKind, command: r(action.command, 500), target: r(action.target, 120), environment: r(action.environment, 120), sha: action.sha ? r(action.sha, 64) : null };
    default:
      throw new CommandError('Jev cannot evaluate an unsupported decision action', 409);
  }
}

export class Jev {
  readonly d: Daemon;
  private inFlight = new Set<string>();
  constructor(d: Daemon) {
    this.d = d;
    d.bus.on('events', (events: { type: string }[]) => {
      if (events.some((e) => e.type !== 'decision.advisory' && e.type !== 'decision.advisory_invalidated')) queueMicrotask(() => this.invalidateStale());
    });
  }

  config(): JevConfig {
    try {
      const raw = this.d.store.kvGet('jev:config');
      if (raw) {
        const c = JSON.parse(raw) as Partial<JevConfig>;
        return { enabled: c.enabled === true, endpoint: c.endpoint ?? JEV_DEFAULT_ENDPOINT, confirmedAt: c.confirmedAt ?? null, confirmations: c.confirmations ?? [] };
      }
    } catch {
      /* fall through to disabled */
    }
    return { enabled: false, endpoint: JEV_DEFAULT_ENDPOINT, confirmedAt: null, confirmations: [] };
  }

  /** Hosts the daemon may contact for Jev: only while the owner has it enabled. */
  hosts(): string[] {
    const c = this.config();
    if (!c.enabled) return [];
    try {
      return [new URL(c.endpoint).host];
    } catch {
      return [];
    }
  }

  async status() {
    const c = this.config();
    const keyStored = await hasSecret('jev', this.d.baseEnv());
    const host = new URL(c.endpoint).host;
    return {
      enabled: c.enabled,
      endpoint: c.endpoint,
      host,
      keyStored,
      ready: c.enabled && keyStored,
      confirmedAt: c.confirmedAt,
      disclosure: JEV_DISCLOSURE,
      protocol: 'POST /v1/systemone (state, model, named choice question and typed answer). Checked against the official API reference and loopback fixtures; live check pending.',
    };
  }

  private requireHuman(actor: Actor): void {
    if (actor.type !== 'human' || /^jev$/i.test(actor.id)) throw new CommandError('Only the owner can enable or request Jev', 403);
  }

  configure(input: { enabled: boolean; endpoint?: string; confirm?: JevConfirm }, actor: Actor = HUMAN): JevConfig {
    this.requireHuman(actor);
    const current = this.config();
    const endpoint = input.endpoint ? validateEndpoint(input.endpoint).origin : current.endpoint;
    const host = new URL(endpoint).host;
    let next: JevConfig;
    if (input.enabled) {
      const c = input.confirm ?? {};
      if (c.cost !== true || c.network !== true || c.data !== true) throw new CommandError('Enabling Jev needs your explicit cost, network and data confirmation', 428);
      if (c.host !== host) throw new CommandError(`Confirm the exact host that will receive decision evidence: ${host}`, 428);
      next = { enabled: true, endpoint, confirmedAt: this.d.nowIso(), confirmations: ['cost', 'network', 'data'] };
    } else next = { enabled: false, endpoint, confirmedAt: null, confirmations: [] };
    this.d.commit([{ type: 'jev.configured', actor, data: { enabled: next.enabled, host, confirmations: next.confirmations } }], [], () => this.d.store.kvSet('jev:config', JSON.stringify(next)));
    this.d.refreshEgress();
    return next;
  }

  private openDecision(id: string): Decision {
    const dec = this.d.state.decisions[id];
    if (!dec) throw new CommandError(`unknown decision ${id}`, 404);
    if (dec.answeredAt || dec.consumedAt) throw new CommandError('This decision is already closed; Jev only advises on open decisions', 409);
    return dec;
  }

  /** Bounded, redacted evidence for one decision and its hash. Pure over current state. */
  buildEvidence(dec: Decision): JevEvidence {
    const r = (s: string, n: number) => clip(this.d.redactText(String(s ?? '')), n);
    const item = dec.workItemId ? this.d.state.workItems[dec.workItemId] : null;
    const evidence = (dec.evidence ?? []).slice(0, MAX_EVIDENCE_ITEMS).map((e) => ({ label: r(e.label, 80), detail: r(e.detail, 400), ok: e.ok ?? null }));
    const build = (ev: typeof evidence) => ({
      question: r(dec.question, 600),
      options: dec.options.slice(0, 8).map((o) => r(o, 120)),
      evidence: ev,
      context: {
        kind: dec.kind ?? 'question',
        risk: dec.risk ?? 'low',
        urgency: dec.urgency,
        irreversible: dec.irreversible,
        workItem: item ? { key: item.key, title: r(item.title, 160), state: item.state, evidenceCount: item.evidence.length, lastEvidenceId: item.evidence.at(-1)?.id ?? null } : null,
        action: actionEvidence(dec.action, r),
      },
    });
    let ev = evidence;
    let payload = build(ev);
    let truncated = evidence.length < (dec.evidence ?? []).length;
    while (canonical(systemOneRequest({ ...payload, truncated })).length > MAX_PAYLOAD_CHARS && ev.length) {
      ev = ev.slice(0, -1);
      truncated = true;
      payload = build(ev);
    }
    const full = { ...payload, truncated };
    const wire = canonical(systemOneRequest(full));
    const chars = wire.length;
    if (chars > MAX_PAYLOAD_CHARS) throw new CommandError('Decision context is too large for a bounded Jev request', 409);
    const evidenceIds = [...ev.map((e, i) => `decision:${dec.id}:${i}:${e.label}`), ...(item ? item.evidence.slice(-20).map((e) => e.id) : [])];
    return { payload: full, hash: sha(wire), items: ev.length, chars, truncated, evidenceIds };
  }

  async preview(id: string) {
    const dec = this.openDecision(id);
    const status = await this.status();
    const ev = this.buildEvidence(dec);
    const blocked = !status.enabled ? 'Jev is disabled. Enable it in Agents & subscriptions first.' : !status.keyStored ? 'Add your Jev API key under Connections (macOS Keychain) first.' : null;
    const unsupportedOptions = dec.options.length < 2 || dec.options.length > 8 ? 'Jev advice supports decisions with 2 to 8 options.' : null;
    const existing = dec.advisory && !dec.advisory.stale && dec.advisory.inputHash === ev.hash ? 'A current advisory already exists for this exact evidence.' : null;
    return { decisionId: id, host: status.host, url: `${status.endpoint}${JEV_PATH}`, inputHash: ev.hash, payload: ev.payload, requestBody: systemOneRequest(ev.payload), items: ev.items, chars: ev.chars, truncated: ev.truncated, disclosure: JEV_DISCLOSURE, blocked: blocked ?? unsupportedOptions ?? existing, canRequest: !blocked && !unsupportedOptions && !existing };
  }

  /** The paid, networked step. Needs the matching preview hash and a fresh explicit confirmation. */
  async request(id: string, input: { inputHash?: string; confirm?: JevConfirm }, actor: Actor = HUMAN): Promise<Decision> {
    this.requireHuman(actor);
    if (this.inFlight.has(id)) throw new CommandError('A Jev request for this decision is already running; nothing else was sent', 409);
    this.inFlight.add(id);
    try { return await this.requestOnce(id, input, actor); } finally { this.inFlight.delete(id); }
  }

  assertWorkflowGate(linkId: string): void {
    const link = this.d.workflowLinks.get(linkId), policy = link.gate?.jev;
    const dec = link.decisionId ? this.openDecision(link.decisionId) : null;
    const config = this.config();
    if (link.status !== 'open' || link.gate?.kind !== 'jev' || !policy || !policy.confirmedAt || !policy.confirmedBy || !config.enabled || policy.host !== new URL(config.endpoint).host || !config.confirmations.includes('cost') || !config.confirmations.includes('network') || !config.confirmations.includes('data')) throw new CommandError('No current owner-confirmed Jev workflow policy', 409);
    if (!dec || dec.kind !== 'question' || dec.irreversible || dec.action || dec.risk !== 'low' || dec.confirmOptions?.length || this.d.store.kvGet(`workflow-link:decision:${dec.id}`) !== linkId || dec.question !== link.gate.question || JSON.stringify(dec.options) !== JSON.stringify(link.gate.options.map(o => o.label)) || this.d.workflows.get(link.from).status !== 'completed') throw new CommandError('Jev can route only the bound low-risk workflow question', 403);
    const bytes = Buffer.byteLength(JSON.stringify(systemOneRequest(this.buildEvidence(dec).payload)));
    if (bytes > policy.maxEvidenceBytes) throw new CommandError('Gate evidence exceeds the owner-confirmed byte limit', 409);
    for (const id of link.to) {
      const target = this.d.workflows.get(id);
      if (target.status !== 'draft' || target.version !== link.targetVersions[id]) throw new CommandError('Workflow gate target changed', 409);
    }
  }

  async requestWorkflowGate(linkId: string): Promise<Decision> {
    this.assertWorkflowGate(linkId);
    const link = this.d.workflowLinks.get(linkId), policy = link.gate!.jev!;
    const preview = await this.preview(link.decisionId!);
    if (!preview.canRequest) throw new CommandError(preview.blocked ?? 'Jev is not configured', 409);
    this.d.commit([{ type: 't.system', actor: JEV_ACTOR, data: { text: JSON.stringify({ kind: 'workflow-gate-jev-preview', linkId, host: preview.host, inputHash: preview.inputHash, requestBody: preview.requestBody, confirmedAt: policy.confirmedAt, confirmedBy: policy.confirmedBy, maxEvidenceBytes: policy.maxEvidenceBytes }) } }]);
    const id = link.decisionId!;
    if (this.inFlight.has(id)) throw new CommandError('Jev request already in flight', 409);
    this.inFlight.add(id);
    try { return await this.requestOnce(id, { inputHash: preview.inputHash, confirm: { host: policy.host, cost: true, network: true, data: true } }, JEV_ACTOR, linkId); }
    finally { this.inFlight.delete(id); }
  }

  private async requestOnce(id: string, input: { inputHash?: string; confirm?: JevConfirm }, actor: Actor = HUMAN, workflowLinkId?: string): Promise<Decision> {
    if (workflowLinkId) this.assertWorkflowGate(workflowLinkId); else this.requireHuman(actor);
    const dec = this.openDecision(id);
    const c = this.config();
    if (!c.enabled) throw new CommandError('Jev is disabled', 409);
    const key = await getSecret('jev', this.d.baseEnv());
    if (!key) throw new CommandError('No Jev API key in the Keychain', 409);
    this.d.addSecret(key);
    const host = new URL(c.endpoint).host;
    const cf = input.confirm ?? {};
    if (cf.cost !== true || cf.network !== true || cf.data !== true || cf.host !== host) throw new CommandError(`Confirm cost, network and data for ${host} to send this evidence`, 428);
    const ev = this.buildEvidence(dec);
    if (!input.inputHash || input.inputHash !== ev.hash) throw new CommandError('The evidence changed since you reviewed the preview; review the new preview first', 409);
    if (dec.advisory && !dec.advisory.stale && dec.advisory.inputHash === ev.hash) throw new CommandError('A current advisory already exists for this exact evidence; nothing was sent', 409);

    if (dec.options.length < 2 || dec.options.length > 8) throw new CommandError('Jev advice supports decisions with 2 to 8 options; nothing was sent', 409);
    const body = systemOneRequest(ev.payload);
    let res: Response;
    try {
      res = await this.d.egress.fetch(`${c.endpoint}${JEV_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error', purpose: 'jev-advisory' } as RequestInit);
    } catch (e) {
      throw new CommandError(`Jev could not be reached: ${this.d.redactText((e as Error).message)}. Nothing was recorded.`, 502);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new CommandError(`Jev answered ${res.status}. Nothing was recorded.`, 502);
    }
    const raw = await boundedResponse(res);
    let j: Record<string, unknown>;
    try {
      j = obj(JSON.parse(raw));
    } catch {
      throw new CommandError('Jev returned an unreadable response. Nothing was recorded.', 502);
    }
    const answer = obj(obj(j.answers).decision);
    const optionIds = Object.keys(body.questions.decision.criteria);
    const index = optionIds.indexOf(typeof answer.choice === 'string' ? answer.choice : '');
    if (answer.type !== 'choice' || index < 0) throw new CommandError('Jev did not return one of the decision options as a typed choice, so nothing was recorded.', 502);
    const recommendation = dec.options[index];
    const model = typeof j.model === 'string' ? this.d.redactText(j.model).slice(0, 120) : '';
    if (!model.trim()) throw new CommandError('Jev did not report a model version, so the result cannot be audited and was not recorded.', 502);
    const probabilities = obj(answer.probabilities);
    const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    if (!probability(answer.confidence) || Object.keys(probabilities).length !== optionIds.length || optionIds.some((id) => !probability(probabilities[id])) || Math.abs(optionIds.reduce((sum, id) => sum + Number(probabilities[id]), 0) - 1) > 0.001 || optionIds.some((id) => Number(probabilities[id]) > Number(probabilities[answer.choice as string]) + 0.000001)) {
      throw new CommandError('Jev returned an invalid choice probability distribution or confidence. Nothing was recorded.', 502);
    }
    const usageIn = obj(j.usage);
    const tokenCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!tokenCount(usageIn.input_tokens) || !tokenCount(usageIn.output_tokens)) throw new CommandError('Jev did not report valid token usage. Nothing was recorded.', 502);
    const usage = { input_tokens: usageIn.input_tokens, output_tokens: usageIn.output_tokens };
    // A late network response must never advise on a different action or a closed decision.
    if (workflowLinkId) this.assertWorkflowGate(workflowLinkId);
    const current = this.openDecision(id);
    if (!this.config().enabled || this.config().endpoint !== c.endpoint || this.buildEvidence(current).hash !== ev.hash) throw new CommandError('The decision evidence or Jev configuration changed while the request was running; no advisory was recorded.', 409);
    const advisory: JevAdvisory = {
      provider: 'jev',
      inputHash: ev.hash,
      model,
      usage,
      requestedAt: this.d.nowIso(),
      recommendation,
      rationale: '',
      evidenceItems: ev.items,
      evidenceChars: ev.chars,
      evidenceIds: ev.evidenceIds,
      confidence: answer.confidence as number,
      host,
      stale: false,
      staleReason: null,
      staleAt: null,
    };
    this.d.commit([{ type: 'decision.advisory', actor: JEV_ACTOR, workItemId: dec.workItemId ?? null, data: { decisionId: id, advisory } }]);
    return this.d.state.decisions[id];
  }

  /** Closing a preview without sending is recorded, so the audit shows nothing left this machine. */
  cancel(id: string, inputHash: string, actor: Actor = HUMAN): void {
    this.requireHuman(actor);
    const dec = this.openDecision(id);
    this.d.commit([{ type: 'jev.cancelled', actor, workItemId: dec.workItemId ?? null, data: { decisionId: id, inputHash } }]);
  }

  /** An advisory describes specific evidence; once that changes it must stop looking current. */
  invalidateStale(): void {
    for (const dec of Object.values(this.d.state.decisions)) {
      const a = dec.advisory;
      // A closed decision keeps its advisory as history; only a still-open decision can go stale.
      if (!a || a.stale || dec.answeredAt || dec.consumedAt) continue;
      let reason: string | null;
      try { reason = this.buildEvidence(dec).hash !== a.inputHash ? 'the decision evidence changed after Jev reviewed it' : null; }
      catch { reason = 'the decision action or evidence can no longer be verified'; }
      if (reason) this.d.commit([{ type: 'decision.advisory_invalidated', actor: JEV_ACTOR, workItemId: dec.workItemId ?? null, data: { decisionId: dec.id, reason } }]);
    }
  }
}
