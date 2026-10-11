// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Own-account rules for subscription agents. Vendors allow a person to sign in to their own,
// unmodified CLI with their own plan; they do not allow a product to pool, resell or route other
// people's work through one login, or to collect the CLI's credentials. Pure: the daemon gathers
// the facts (login fingerprint, stored acknowledgement, binary signature), this decides.
import type { AccountPolicy } from './config.ts';
import type { AgentState } from './entities.ts';

/** What the owner confirms, per vendor login. Changing any text requires a new acknowledgement. */
export const ACCOUNT_STATEMENTS = [
  { id: 'own-account', text: 'This is my own account, and I signed in myself through the vendor\'s own sign-in flow.' },
  { id: 'not-shared', text: 'Only I use this login through One Connect. I will not share it, its included usage or its agents with other people. Any paired phone is my own device.' },
  { id: 'unmodified', text: 'I run the vendor\'s CLI as published. One Connect never reads, copies or stores its login tokens, and neither will I.' },
  { id: 'terms', text: 'I read the vendor terms linked here, and my use fits them, including their limits for ordinary, individual use.' },
] as const;
export type AccountStatementId = (typeof ACCOUNT_STATEMENTS)[number]['id'];
export const ACCOUNT_STATEMENT_IDS: readonly string[] = ACCOUNT_STATEMENTS.map((s) => s.id);

export interface AccountAck {
  adapter: string;
  termsRevision: string;
  /** Login fingerprint at acknowledgement time; null when the CLI reports no identity. */
  account: string | null;
  statements: string[];
  at: string;
  expiresAt: string;
}

export type AccountTermsState = 'not_required' | 'api_keys_only' | 'missing' | 'expired' | 'terms_changed' | 'account_changed' | 'valid';

export interface AccountTermsStatus {
  required: boolean;
  valid: boolean;
  state: AccountTermsState;
  message: string;
  acknowledgedAt: string | null;
  expiresAt: string | null;
  /** Valid, but expiring within the reminder window. */
  dueSoon: boolean;
}

export const TERMS_REMINDER_DAYS = 14;
const DAY = 86_400_000;

/** Subscription agents run on the user's own vendor login; everything else bills its own key or runs locally. */
export const usesVendorLogin = (agent: Pick<AgentState, 'config'>): boolean => agent.config.provider === 'subscription' && agent.config.adapter !== 'relay';

export function ackExpiry(at: string, policy: AccountPolicy): string {
  return new Date(Date.parse(at) + policy.terms_max_age_days * DAY).toISOString();
}

export function evaluateAccountTerms(i: { agent: Pick<AgentState, 'config' | 'auth'>; policy: AccountPolicy; ack: AccountAck | null; termsRevision: string; now: string }): AccountTermsStatus {
  const none = { acknowledgedAt: null, expiresAt: null, dueSoon: false };
  if (!usesVendorLogin(i.agent)) return { required: false, valid: true, state: 'not_required', message: 'Not a subscription login: this agent uses an API key, a local model or a manual relay.', ...none };
  if (i.policy.mode === 'api-keys-only') {
    return { required: true, valid: false, state: 'api_keys_only', message: 'This workspace is set to API keys only (shared, hosted or team use). Switch the agent to its vendor\'s API key, or set Accounts to personal in Settings if only you use this Mac.', ...none };
  }
  const ack = i.ack;
  if (!ack) return { required: true, valid: false, state: 'missing', message: 'Confirm this is your own, unshared login and review the vendor terms before the first dispatch.', ...none };
  const seen = { acknowledgedAt: ack.at, expiresAt: ack.expiresAt };
  const now = Date.parse(i.now);
  if (ack.termsRevision !== i.termsRevision || ACCOUNT_STATEMENT_IDS.some((id) => !ack.statements.includes(id))) {
    return { required: true, valid: false, state: 'terms_changed', message: 'The vendor terms or these confirmations changed since you last confirmed. Review them again.', ...seen, dueSoon: false };
  }
  if (ack.account && i.agent.auth.account && ack.account !== i.agent.auth.account) {
    return { required: true, valid: false, state: 'account_changed', message: 'A different account is signed in to this CLI now. Confirm the new login is yours.', ...seen, dueSoon: false };
  }
  if (Date.parse(ack.expiresAt) <= now) {
    return { required: true, valid: false, state: 'expired', message: `Your confirmation expired on ${ack.expiresAt.slice(0, 10)}. Review the vendor terms and confirm again.`, ...seen, dueSoon: false };
  }
  const dueSoon = Date.parse(ack.expiresAt) - now <= TERMS_REMINDER_DAYS * DAY;
  return { required: true, valid: true, state: 'valid', message: `Own-account use confirmed${dueSoon ? `; review again by ${ack.expiresAt.slice(0, 10)}` : ''}.`, ...seen, dueSoon };
}

/** Stored-key age: rotation is a reminder, never a block. */
export function keyRotationDue(storedAt: string | null, policy: AccountPolicy, now: string): { ageDays: number | null; due: boolean } {
  if (!storedAt) return { ageDays: null, due: false };
  const ageDays = Math.floor((Date.parse(now) - Date.parse(storedAt)) / DAY);
  return { ageDays, due: ageDays >= policy.api_key_rotation_days };
}

/** macOS code-signature check of the vendor binary a subscription agent runs. */
export type SignatureState = 'verified' | 'unsigned' | 'mismatch' | 'invalid' | 'unavailable' | 'not_expected';
export interface BinarySignature {
  state: SignatureState;
  detail: string;
  teamId?: string | null;
}
