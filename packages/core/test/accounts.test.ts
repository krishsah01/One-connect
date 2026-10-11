// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATEMENT_IDS, AccountPolicySchema, ackExpiry, evaluateAccountTerms, keyRotationDue, PolicySchema, type AccountAck, type AgentState } from '../src/index.ts';

const policy = AccountPolicySchema.parse({});
const agent = (over: Partial<AgentState['config']> = {}, account?: string) => ({ config: { provider: 'subscription', adapter: 'claude-headless', ...over } as AgentState['config'], auth: { state: 'logged_in' as const, ...(account ? { account } : {}) } });
const ack = (over: Partial<AccountAck> = {}): AccountAck => ({ adapter: 'claude-headless', termsRevision: 'r1', account: 'acct-a', statements: [...ACCOUNT_STATEMENT_IDS], at: '2026-10-01T00:00:00.000Z', expiresAt: ackExpiry('2026-10-01T00:00:00.000Z', policy), ...over });
const at = (now: string, a: ReturnType<typeof agent>, k: AccountAck | null, p = policy) => evaluateAccountTerms({ agent: a, policy: p, ack: k, termsRevision: 'r1', now });

describe('own-account rules for subscription logins', () => {
  it('defaults to personal use, a 90-day review and a 90-day key rotation reminder', () => {
    expect(PolicySchema.parse({}).accounts).toEqual({ mode: 'personal', terms_max_age_days: 90, api_key_rotation_days: 90 });
  });

  it('applies only to vendor logins, never to API keys, local models or relays', () => {
    expect(at('2026-10-02T00:00:00Z', agent({ provider: 'anthropic-api' }), null)).toMatchObject({ required: false, valid: true, state: 'not_required' });
    expect(at('2026-10-02T00:00:00Z', agent({ adapter: 'relay' }), null).required).toBe(false);
  });

  it('requires a confirmation, which then holds for the same login and terms until it expires', () => {
    expect(at('2026-10-02T00:00:00Z', agent({}, 'acct-a'), null)).toMatchObject({ required: true, valid: false, state: 'missing' });
    expect(at('2026-10-02T00:00:00Z', agent({}, 'acct-a'), ack())).toMatchObject({ valid: true, state: 'valid', dueSoon: false });
    expect(at('2026-12-20T00:00:00Z', agent({}, 'acct-a'), ack())).toMatchObject({ valid: true, dueSoon: true });
    expect(at('2026-12-31T00:00:00Z', agent({}, 'acct-a'), ack())).toMatchObject({ valid: false, state: 'expired' });
  });

  it('breaks when the vendor terms revision, the statements or the signed-in account change', () => {
    expect(at('2026-10-02T00:00:00Z', agent({}, 'acct-a'), ack({ termsRevision: 'r0' })).state).toBe('terms_changed');
    expect(at('2026-10-02T00:00:00Z', agent({}, 'acct-a'), ack({ statements: ACCOUNT_STATEMENT_IDS.slice(1) })).state).toBe('terms_changed');
    expect(at('2026-10-02T00:00:00Z', agent({}, 'acct-b'), ack())).toMatchObject({ valid: false, state: 'account_changed' });
    // A CLI that reports no identity cannot detect a switch; the confirmation still expires.
    expect(at('2026-10-02T00:00:00Z', agent({}), ack({ account: null })).valid).toBe(true);
  });

  it('refuses every subscription login in an API-keys-only workspace', () => {
    const p = AccountPolicySchema.parse({ mode: 'api-keys-only' });
    expect(at('2026-10-02T00:00:00Z', agent({}, 'acct-a'), ack(), p)).toMatchObject({ required: true, valid: false, state: 'api_keys_only' });
    expect(at('2026-10-02T00:00:00Z', agent({ provider: 'anthropic-api' }), null, p).valid).toBe(true);
  });

  it('reminds about old API keys without blocking', () => {
    expect(keyRotationDue(null, policy, '2026-10-02T00:00:00Z')).toEqual({ ageDays: null, due: false });
    expect(keyRotationDue('2026-07-01T00:00:00Z', policy, '2026-10-02T00:00:00Z')).toEqual({ ageDays: 93, due: true });
  });
});
