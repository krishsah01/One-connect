// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Keeps subscription agents inside the vendors' own-account rules, and keeps them current:
// - the owner confirms, per vendor login, that it is their own, unshared, unmodified login and that
//   they read the linked terms; the confirmation expires, and breaks when the terms revision or the
//   signed-in account changes;
// - a workspace set to `api-keys-only` (shared, hosted, team use) refuses subscription logins;
// - the vendor binary's code signature is checked after each probe;
// - a background watch notices expired logins, confirmations that are due, and old API keys.
// Facts only come from the vendor CLI's own status commands; credentials are never read.
import {
  ACCOUNT_STATEMENT_IDS,
  ACCOUNT_STATEMENTS,
  ackExpiry,
  evaluateAccountTerms,
  HUMAN,
  keyRotationDue,
  usesVendorLogin,
  type AccountAck,
  type AccountTermsStatus,
  type Actor,
  type AgentState,
  type BinarySignature,
} from '@acc/core';
import { sanitizeEnv } from './adapters/agents/env.ts';
import { adapterFor } from './adapters/agents/index.ts';
import { checkSignature } from './adapters/agents/signature.ts';
import { CommandError, type Daemon } from './daemon.ts';
import { harnessEntry, termsRevisionFor } from './harnessCatalog.ts';
import { SECRET_NAMES, type SecretName } from './secrets.ts';

const ACK = (adapter: string) => `account-terms:${adapter}`;
const KEY_META = (name: string) => `secret-meta:${name}`;

export interface AccountComplianceView extends AccountTermsStatus {
  adapter: string;
  vendor: string | null;
  termsRevision: string;
  terms: { label: string; url: string }[];
  notes: string[];
  statements: { id: string; text: string }[];
  accountLabel: string | null;
  signature: BinarySignature;
  mode: 'personal' | 'api-keys-only';
  apiKeyRoute: { provider: string; keyUrl: string; note: string } | null;
}

export class AccountCompliance {
  private readonly d: Daemon;
  private readonly signatures = new Map<string, BinarySignature>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  constructor(d: Daemon) { this.d = d; }

  private ack(adapter: string): AccountAck | null {
    const raw = this.d.store.kvGet(ACK(adapter));
    if (!raw) return null;
    try { return JSON.parse(raw) as AccountAck; } catch { return null; }
  }

  private evaluate(a: AgentState): AccountTermsStatus {
    return evaluateAccountTerms({ agent: a, policy: this.d.config.policies.accounts, ack: this.ack(a.config.adapter), termsRevision: termsRevisionFor(a.config.adapter), now: this.d.nowIso() });
  }

  signature(agentId: string): BinarySignature {
    const a = this.d.state.agents[agentId];
    if (!a || !usesVendorLogin(a)) return { state: 'not_expected', detail: 'Not a subscription login.' };
    const expected = harnessEntry(a.config.adapter)?.signer ?? null;
    if (!expected) return { state: 'not_expected', detail: 'The vendor ships this CLI without a macOS signature; integrity is not checked.' };
    return this.signatures.get(agentId) ?? { state: 'unavailable', detail: 'The binary signature has not been checked yet. Re-check the agent.' };
  }

  /** After each probe: verify the pinned binary is the vendor's, as published. */
  async refreshSignature(agentId: string): Promise<BinarySignature> {
    const a = this.d.state.agents[agentId];
    if (!a?.binary || !usesVendorLogin(a)) { this.signatures.delete(agentId); return this.signature(agentId); }
    const sig = await checkSignature(a.binary.path, harnessEntry(a.config.adapter)?.signer ?? null);
    this.signatures.set(agentId, sig);
    const key = `${agentId}:signature`;
    if (sig.state === 'mismatch' || sig.state === 'invalid') this.d.alert({ kind: 'account', severity: 'critical', agentId, message: `${a.config.name}: ${sig.detail} Dispatch is blocked until the vendor's own CLI is installed.`, dedupeKey: key });
    else this.d.resolveAlerts((x) => x.dedupeKey === key, sig.detail);
    return sig;
  }

  /** Preflight input: the account rules for this agent. */
  check(agentId: string): { required: boolean; valid: boolean; message: string } | undefined {
    const a = this.d.state.agents[agentId];
    return a ? this.evaluate(a) : undefined;
  }

  status(agentId: string): AccountComplianceView {
    const a = this.d.state.agents[agentId];
    if (!a) throw new CommandError('Unknown agent', 404);
    const h = harnessEntry(a.config.adapter);
    return {
      ...this.evaluate(a),
      adapter: a.config.adapter,
      vendor: h?.vendor ?? null,
      termsRevision: termsRevisionFor(a.config.adapter),
      terms: h?.terms ?? [],
      notes: h?.subscription?.notes ?? ['Read your vendor\'s terms for using its CLI with your own plan before confirming.'],
      statements: ACCOUNT_STATEMENTS.map((s) => ({ ...s })),
      accountLabel: a.auth.accountLabel ?? null,
      signature: this.signature(agentId),
      mode: this.d.config.policies.accounts.mode,
      apiKeyRoute: h?.apiKey ?? null,
    };
  }

  acknowledge(agentId: string, statements: unknown, actor: Actor = HUMAN): AccountComplianceView {
    if (actor.type !== 'human' || actor.id === 'jev') throw new CommandError('Only the owner can confirm their own account and the vendor terms', 403);
    const a = this.d.state.agents[agentId];
    if (!a) throw new CommandError('Unknown agent', 404);
    if (!usesVendorLogin(a)) throw new CommandError('Only subscription logins need this confirmation', 409);
    if (this.d.config.policies.accounts.mode === 'api-keys-only') throw new CommandError('This workspace is set to API keys only. Subscription logins cannot be confirmed here.', 409);
    if (a.auth.state !== 'logged_in' || !a.binary) throw new CommandError('Sign in with the vendor CLI and re-check the agent before confirming', 409);
    const sig = this.signature(agentId);
    if (sig.state === 'mismatch' || sig.state === 'invalid') throw new CommandError(sig.detail, 409);
    const given = Array.isArray(statements) ? statements.filter((s): s is string => typeof s === 'string') : [];
    const missing = ACCOUNT_STATEMENT_IDS.filter((id) => !given.includes(id));
    if (missing.length) throw new CommandError(`Confirm every statement before continuing (missing: ${missing.join(', ')})`, 428);
    const at = this.d.nowIso();
    const ack: AccountAck = { adapter: a.config.adapter, termsRevision: termsRevisionFor(a.config.adapter), account: a.auth.account ?? null, statements: [...ACCOUNT_STATEMENT_IDS], at, expiresAt: ackExpiry(at, this.d.config.policies.accounts) };
    this.d.commit(
      [{ type: 'agent.terms_acknowledged', actor, agentId, data: { adapter: ack.adapter, termsRevision: ack.termsRevision, account: ack.account, statements: ack.statements, expiresAt: ack.expiresAt } }],
      [],
      () => this.d.store.kvSet(ACK(ack.adapter), JSON.stringify(ack)),
    );
    this.d.resolveAlerts((x) => x.dedupeKey?.startsWith(`terms:${ack.adapter}:`) ?? false, 'owner confirmed own-account use', actor);
    return this.status(agentId);
  }

  /** Withdraw a vendor confirmation (e.g. before handing the Mac to someone else). */
  revoke(agentId: string, actor: Actor = HUMAN): AccountComplianceView {
    if (actor.type !== 'human' || actor.id === 'jev') throw new CommandError('Only the owner can withdraw this confirmation', 403);
    const a = this.d.state.agents[agentId];
    if (!a) throw new CommandError('Unknown agent', 404);
    if (this.ack(a.config.adapter)) {
      this.d.commit([{ type: 'agent.terms_revoked', actor, agentId, data: { adapter: a.config.adapter, reason: 'withdrawn by the owner' } }], [], () => this.d.store.kvDelete(ACK(a.config.adapter)));
    }
    return this.status(agentId);
  }

  // ---- API key metadata (never the key) ------------------------------------------------------
  keyStored(name: SecretName, actor: Actor = HUMAN): void {
    this.d.commit([{ type: 'connection.key_changed', actor, data: { connection: name, action: 'stored' } }], [], () => this.d.store.kvSet(KEY_META(name), JSON.stringify({ storedAt: this.d.nowIso() })));
    this.d.resolveAlerts((x) => x.dedupeKey === `key-rotation:${name}`, 'key replaced', actor);
  }

  keyRemoved(name: SecretName, actor: Actor = HUMAN): void {
    this.d.commit([{ type: 'connection.key_changed', actor, data: { connection: name, action: 'removed' } }], [], () => this.d.store.kvDelete(KEY_META(name)));
    this.d.resolveAlerts((x) => x.dedupeKey === `key-rotation:${name}`, 'key removed', actor);
  }

  keyAge(name: SecretName): { storedAt: string | null; ageDays: number | null; rotationDue: boolean } {
    let storedAt: string | null = null;
    try { storedAt = (JSON.parse(this.d.store.kvGet(KEY_META(name)) ?? 'null') as { storedAt?: string } | null)?.storedAt ?? null; } catch { storedAt = null; }
    const r = keyRotationDue(storedAt, this.d.config.policies.accounts, this.d.nowIso());
    return { storedAt, ageDays: r.ageDays, rotationDue: r.due };
  }

  // ---- background watch --------------------------------------------------------------------
  start(ms = 15 * 60_000): void {
    if (!this.timer) { this.timer = setInterval(() => void this.tick(), ms); this.timer.unref?.(); }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.watchLogins();
      this.watchConfirmations();
      this.watchKeys();
    } finally { this.ticking = false; }
  }

  /** A cheap status call per idle subscription agent; a changed login triggers a full re-check. */
  private async watchLogins(): Promise<void> {
    for (const a of Object.values(this.d.state.agents)) {
      if (a.config.enabled === false || !usesVendorLogin(a) || !a.binary || a.activeRunIds.length) continue;
      const adapter = adapterFor(a.config.adapter);
      const now = await adapter.authStatus({ binary: a.binary.path, agent: a.config, env: sanitizeEnv(a.config, this.d.baseEnv()).env }).catch(() => null);
      if (!now || this.d.closed) continue;
      if (now.state !== a.auth.state || (now.account ?? null) !== (a.auth.account ?? null)) await this.d.probe(a.id).catch(() => undefined);
    }
  }

  private watchConfirmations(): void {
    const seen = new Set<string>();
    for (const a of Object.values(this.d.state.agents)) {
      if (a.config.enabled === false || !usesVendorLogin(a) || seen.has(a.config.adapter)) continue;
      seen.add(a.config.adapter);
      const s = this.evaluate(a);
      const name = harnessEntry(a.config.adapter)?.displayName ?? a.config.adapter;
      if (s.valid && s.dueSoon) this.d.alert({ kind: 'account', severity: 'info', agentId: a.id, message: `${name}: your own-account confirmation expires on ${s.expiresAt?.slice(0, 10)}. Review the vendor terms in Agents & sign-in.`, dedupeKey: `terms:${a.config.adapter}:due:${s.expiresAt}` });
      else if (!s.valid && s.acknowledgedAt) this.d.alert({ kind: 'account', severity: 'warn', agentId: a.id, message: `${name}: ${s.message}`, dedupeKey: `terms:${a.config.adapter}:${s.state}:${s.acknowledgedAt}` });
    }
  }

  private watchKeys(): void {
    for (const name of SECRET_NAMES) {
      const age = this.keyAge(name);
      if (age.rotationDue) this.d.alert({ kind: 'account', severity: 'warn', message: `The ${name} API key was stored ${age.ageDays} days ago. Create a new key with the provider, replace it under Agents → API keys, then revoke the old one.`, dedupeKey: `key-rotation:${name}` });
    }
  }
}
