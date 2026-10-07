// SPDX-License-Identifier: Apache-2.0
// Vendor protocol fixtures expose a subscription but cannot expose account payment settings.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { agentActor } from '@acc/core';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
describe('subscription payment confirmation', () => {
  it('blocks unknown overage until an authenticated owner confirms it; records proof without changing vendor facts', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, confirmFixtureSubscriptions: false });
    const d = h.d;
    await d.probe('cursor');
    const item = d.createIssue({ title: 'Fixture change', acceptance: ['tests pass'] });
    await waitFor(() => d.state.workItems[item.id].key);
    const assignment = d.createAssignment({ workItemId: item.id, agentId: 'cursor', allowedPaths: ['src/**'] });
    expect(d.preflight(assignment.id, false).checks.find(c => c.id === 'billing')?.status).toBe('fail');
    await expect(d.dispatch(assignment.id)).rejects.toMatchObject({ status: 412 });
    expect(() => d.subscriptionSafety.confirm('cursor', true, agentActor('codex'))).toThrow(/Only the owner/);
    expect(() => d.subscriptionSafety.confirm('cursor', false)).toThrow(/all paid fallbacks/);
    const token = fs.readFileSync(d.paths.installToken, 'utf8').trim();
    const route = h.url + '/api/agents/cursor/subscription-safety';
    const body = JSON.stringify({ paidModesOff: true });
    expect((await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
    expect((await fetch(route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body })).status).toBe(200);
    expect(d.subscriptionSafety.status('cursor').valid).toBe(true);
    expect(d.state.agents.cursor.billing.overage).toBe('unknown');
    expect(d.preflight(assignment.id, false).checks.find(c => c.id === 'billing')?.status).toBe('pass');
    expect(d.store.list({ types: ['agent.subscription_confirmed'] })[0]).toMatchObject({ actor: { type: 'human', id: 'owner' }, agentId: 'cursor', data: { scope: 'daemon-session' } });
    expect(d.subscriptionSafety.status('codex').valid).toBe(false); // Never shared silently across agents.
  });

  it('invalidates confirmation on a fresh probe, changed auth/billing/config and a daemon restart', async () => {
    const cfg = makeConfig(makeRepo());
    h = await startDaemon(cfg, { probe: false, confirmFixtureSubscriptions: false });
    const d = h.d;
    await d.probe('cursor');
    d.subscriptionSafety.confirm('cursor', true);
    d.saveAgent({ ...d.state.agents.cursor.config, subscription: 'Another plan' }, d.state.agents.cursor.config);
    expect(d.subscriptionSafety.status('cursor').valid).toBe(false);
    await d.probe('cursor');
    d.subscriptionSafety.confirm('cursor', true);
    expect(d.subscriptionSafety.status('cursor').valid).toBe(true);
    await d.probe('cursor');
    expect(d.subscriptionSafety.status('cursor').valid).toBe(false);
    d.subscriptionSafety.confirm('cursor', true);
    const current = d.state.agents.cursor;
    d.commit([{ type: 'agent.probed', agentId: 'cursor', data: { auth: { state: 'expired' }, billing: current.billing, binary: current.binary, binaryCandidates: current.binaryCandidates, models: current.models.available, newest: current.models.newest } }]);
    expect(d.subscriptionSafety.status('cursor').valid).toBe(false);
    expect(() => d.subscriptionSafety.confirm('cursor', true)).toThrow(/signed-in/);
    await d.probe('cursor');
    d.subscriptionSafety.confirm('cursor', true);
    const dataDir = h.dataDir;
    await h.close(); h = undefined;
    h = await startDaemon(cfg, { dataDir, probe: false, confirmFixtureSubscriptions: false });
    expect(h.d.store.list({ types: ['agent.subscription_confirmed'] })).toHaveLength(4);
    expect(h.d.subscriptionSafety.status('cursor').valid).toBe(false); // Old proof stays auditable, never authorizes a new session.
  });

  it('expires owner attestation and never overrides vendor-detected paid overage', async () => {
    let now = new Date();
    h = await startDaemon(makeConfig(makeRepo()), { clock: () => now, probe: false, confirmFixtureSubscriptions: false });
    await h.d.probe('cursor');
    h.d.subscriptionSafety.confirm('cursor', true);
    now = new Date(now.getTime() + 12 * 60 * 60_000);
    expect(h.d.subscriptionSafety.status('cursor').valid).toBe(false);
    const a = h.d.state.agents.cursor;
    h.d.commit([{ type: 'agent.probed', agentId: a.id, data: { auth: a.auth, billing: { ...a.billing, overage: 'on' }, binary: a.binary, binaryCandidates: a.binaryCandidates, models: a.models.available, newest: a.models.newest } }]);
    expect(() => h!.d.subscriptionSafety.confirm('cursor', true)).toThrow(/Re-check/);
    expect(h.d.state.agents.cursor.billing.overage).toBe('on');
  });
});
