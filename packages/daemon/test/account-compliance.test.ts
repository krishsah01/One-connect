// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Subscription agents run only on the owner's own, unshared, unmodified vendor login, confirmed
// against the vendor terms; the confirmation expires and breaks on account or terms changes.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_STATEMENT_IDS, agentActor } from '@acc/core';
import { checkSignature } from '../src/adapters/agents/signature.ts';
import { FAKE_BIN, makeConfig, makeRepo, startDaemon, tmpDir, waitFor, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const DAY = 86_400_000;

describe('own-account confirmation', () => {
  it('gates dispatch until the owner confirms at the Mac, survives restarts, and breaks when another account signs in', async () => {
    const cfg = makeConfig(makeRepo());
    const env: NodeJS.ProcessEnv = { ...process.env, FAKE_ACCOUNT_EMAIL: 'owner@example.com' };
    h = await startDaemon(cfg, { probe: false, confirmFixtureSubscriptions: false, baseEnv: env });
    const d = h.d;
    await d.probe('claude');
    expect(d.state.agents.claude.auth).toMatchObject({ state: 'logged_in', tier: 'max', accountLabel: 'ow…@example.com', account: expect.any(String) });
    expect(JSON.stringify(d.state.agents.claude.auth)).not.toContain('owner@example.com');
    d.subscriptionSafety.confirm('claude', true);
    const item = d.createIssue({ title: 'Fixture change', acceptance: ['tests pass'] });
    await waitFor(() => d.state.workItems[item.id].key);
    const asg = d.createAssignment({ workItemId: item.id, agentId: 'claude', allowedPaths: ['src/**'] });
    const account = () => d.preflight(asg.id, false).checks.find((c) => c.id === 'account');
    expect(account()).toMatchObject({ status: 'fail', message: expect.stringContaining('own, unshared login') });
    await expect(d.dispatch(asg.id)).rejects.toMatchObject({ status: 412 });

    // Only the authenticated owner; every statement; never an agent or Jev.
    const token = fs.readFileSync(d.paths.installToken, 'utf8').trim();
    const route = `${h.url}/api/agents/claude/account-terms`;
    const post = (body: unknown, auth = true) => fetch(route, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect((await post({ statements: ACCOUNT_STATEMENT_IDS }, false)).status).toBe(401);
    expect((await post({ statements: ACCOUNT_STATEMENT_IDS.slice(1) })).status).toBe(428);
    expect(() => d.accounts.acknowledge('claude', ACCOUNT_STATEMENT_IDS, agentActor('codex'))).toThrow(/Only the owner/);
    const ok = await post({ statements: ACCOUNT_STATEMENT_IDS });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ valid: true, state: 'valid', vendor: 'Anthropic', terms: expect.arrayContaining([expect.objectContaining({ url: 'https://code.claude.com/docs/en/legal-and-compliance' })]) });
    expect(account()).toMatchObject({ status: 'pass' });
    expect(d.store.list({ types: ['agent.terms_acknowledged'] })[0]).toMatchObject({ actor: { type: 'human', id: 'owner' }, agentId: 'claude', data: { adapter: 'claude-headless', statements: [...ACCOUNT_STATEMENT_IDS] } });
    // One vendor login, one confirmation: it covers other agents on the same CLI, not other vendors.
    expect(d.accounts.status('codex').valid).toBe(false);

    // Unlike the 12-hour payment confirmation, this one persists across restarts until it expires.
    const dataDir = h.dataDir;
    await h.close(); h = undefined;
    h = await startDaemon(cfg, { dataDir, probe: false, confirmFixtureSubscriptions: false, baseEnv: env });
    await h.d.probe('claude');
    expect(h.d.accounts.status('claude').valid).toBe(true);

    // Someone else signs in to the same CLI: the confirmation no longer applies.
    env.FAKE_ACCOUNT_EMAIL = 'someone-else@example.com';
    await h.d.probe('claude');
    expect(h.d.accounts.status('claude')).toMatchObject({ valid: false, state: 'account_changed' });

    // Withdrawing it is audited.
    h.d.accounts.acknowledge('claude', ACCOUNT_STATEMENT_IDS);
    expect(h.d.accounts.revoke('claude')).toMatchObject({ valid: false, state: 'missing' });
    expect(h.d.store.list({ types: ['agent.terms_revoked'] })).toHaveLength(1);
  });

  it('expires, warns before it does, and the login watch notices a sign-out', async () => {
    let now = Date.parse('2026-10-10T00:00:00Z');
    const env: NodeJS.ProcessEnv = { ...process.env };
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, confirmFixtureSubscriptions: false, clock: () => new Date(now), baseEnv: env });
    const d = h.d;
    await d.probe('claude');
    d.accounts.acknowledge('claude', ACCOUNT_STATEMENT_IDS);
    expect(d.accounts.status('claude').expiresAt).toBe('2027-01-08T00:00:00.000Z');

    now += 80 * DAY;
    await d.accounts.tick();
    expect(Object.values(d.state.alerts).find((a) => a.kind === 'account' && a.severity === 'info')?.message).toMatch(/expires on 2027-01-08/);
    now += 11 * DAY;
    await d.accounts.tick();
    expect(d.accounts.status('claude')).toMatchObject({ valid: false, state: 'expired' });
    expect(Object.values(d.state.alerts).some((a) => a.kind === 'account' && a.severity === 'warn' && /expired/.test(a.message))).toBe(true);

    env.FAKE_LOGGED_OUT = '1';
    await d.accounts.tick();
    expect(d.state.agents.claude.auth.state).toBe('expired');
    expect(Object.values(d.state.alerts).some((a) => a.kind === 'auth' && a.agentId === 'claude' && !a.resolvedAt)).toBe(true);
  });

  it('an API-keys-only workspace refuses subscription logins and points to the vendor API key', async () => {
    h = await startDaemon(makeConfig(makeRepo(), { policies: { accounts: { mode: 'api-keys-only' } } }), { probe: false, confirmFixtureSubscriptions: false });
    const d = h.d;
    await d.probe('claude');
    expect(d.accounts.status('claude')).toMatchObject({ valid: false, state: 'api_keys_only', apiKeyRoute: { provider: 'anthropic-api' } });
    expect(() => d.accounts.acknowledge('claude', ACCOUNT_STATEMENT_IDS)).toThrow(/API keys only/);
  });
});

describe('Cursor API key route', () => {
  it('probes the Cursor CLI with the stored key as metered, and reports a missing key', async () => {
    const cursor = { id: 'cursor-key', name: 'Cursor (API key)', role: 'engineer', adapter: 'cursor-agent-cli', provider: 'cursor-api', metered_opt_in: true, binary: path.join(FAKE_BIN, 'cursor-agent'), model: 'newest' };
    const base = makeConfig(makeRepo());
    const cfg = makeConfig(base.project.repo, { agents: [...base.agents, cursor] });
    h = await startDaemon(cfg, { probe: false, confirmFixtureSubscriptions: false, baseEnv: { ...process.env, ACC_SECRET_CURSOR_API: 'crsr_fixture_key_123456' } });
    await h.d.probe('cursor-key');
    expect(h.d.state.agents['cursor-key'].auth).toMatchObject({ state: 'logged_in', detail: 'Cursor API key accepted' });
    expect(h.d.state.agents['cursor-key'].billing.mode).toBe('metered');
    expect(h.d.accounts.status('cursor-key')).toMatchObject({ required: false, state: 'not_required' });
    await h.close(); h = undefined;

    h = await startDaemon(cfg, { probe: false, confirmFixtureSubscriptions: false, baseEnv: { ...process.env, ACC_SECRET_CURSOR_API: '' } });
    await h.d.probe('cursor-key');
    expect(h.d.state.agents['cursor-key'].auth).toMatchObject({ state: 'expired', detail: 'no Cursor API key stored' });
  });

  it('records key changes and reminds to rotate old keys, without storing the key', async () => {
    let now = Date.parse('2026-10-10T00:00:00Z');
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false, confirmFixtureSubscriptions: false, clock: () => new Date(now) });
    const d = h.d;
    d.accounts.keyStored('openai-api');
    expect(d.accounts.keyAge('openai-api')).toMatchObject({ ageDays: 0, rotationDue: false });
    now += 95 * DAY;
    await d.accounts.tick();
    expect(Object.values(d.state.alerts).find((a) => a.dedupeKey === 'key-rotation:openai-api')?.message).toMatch(/95 days ago/);
    d.accounts.keyStored('openai-api');
    expect(Object.values(d.state.alerts).find((a) => a.dedupeKey === 'key-rotation:openai-api')?.resolvedAt).toBeTruthy();
    expect(d.store.list({ types: ['connection.key_changed'] }).map((e) => e.data)).toEqual([{ connection: 'openai-api', action: 'stored' }, { connection: 'openai-api', action: 'stored' }]);
  });
});

describe('vendor binary signature', () => {
  const bin = path.join(tmpDir('sig'), 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const anthropic = { teamId: 'Q6L2SF6YDW', organization: 'Anthropic PBC' };
  const runner = (verify: { code: number; stderr?: string }, team?: string) => async (_c: string, args: readonly string[]) =>
    args[0] === '--verify' ? { code: verify.code, stdout: '', stderr: verify.stderr ?? '', timedOut: false } : { code: 0, stdout: '', stderr: team ? `Identifier=claude\nTeamIdentifier=${team}\n` : '', timedOut: false };

  it('accepts only the vendor Developer ID; a broken or foreign signature blocks, an unsigned launcher warns', async () => {
    fs.utimesSync(bin, new Date(), new Date(Date.now() - 1000));
    expect(await checkSignature(bin, anthropic, { platform: 'darwin', runner: runner({ code: 0 }, 'Q6L2SF6YDW') })).toMatchObject({ state: 'verified' });
    fs.utimesSync(bin, new Date(), new Date(Date.now() - 2000));
    expect(await checkSignature(bin, anthropic, { platform: 'darwin', runner: runner({ code: 0 }, 'EVILTEAM00') })).toMatchObject({ state: 'mismatch' });
    fs.utimesSync(bin, new Date(), new Date(Date.now() - 3000));
    expect(await checkSignature(bin, anthropic, { platform: 'darwin', runner: runner({ code: 1, stderr: 'code object is not signed at all' }) })).toMatchObject({ state: 'unsigned' });
    fs.utimesSync(bin, new Date(), new Date(Date.now() - 4000));
    expect(await checkSignature(bin, anthropic, { platform: 'darwin', runner: runner({ code: 1, stderr: 'a sealed resource is missing or invalid' }) })).toMatchObject({ state: 'invalid' });
    expect(await checkSignature(bin, null)).toMatchObject({ state: 'not_expected' });
    expect(await checkSignature(bin, anthropic, { platform: 'linux' })).toMatchObject({ state: 'unavailable' });
  });
});
