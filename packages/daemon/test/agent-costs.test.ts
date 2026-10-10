// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfigSchema, agentActor } from '@acc/core';
import { makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const draft = (id = 'api-builder') => AgentConfigSchema.parse({ id, name: 'API engineer', role: 'engineer', adapter: 'opencode-server', provider: 'openai-api', model: 'reviewed-model', enabled: false, metered_opt_in: true, budget_usd_per_day: 1, pricing: { input_per_mtok: 2, output_per_mtok: 8 } });

describe('exact per-agent paid configuration approval', () => {
  it('never saves or contacts a provider until the owner confirms, then persists answer and settings atomically once', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
    const { d } = h;
    const cfg = draft();
    expect(() => d.saveAgent(cfg, null)).toThrow(/cost Decision/);
    expect(() => d.saveAgent(cfg, null, { costApproved: true } as never)).toThrow(/cost Decision/);
    const { decision } = d.agentCosts.request(cfg);
    expect(d.agentCosts.request(cfg).decision.id).toBe(decision.id);
    expect(d.state.agents[cfg.id]).toBeUndefined();
    expect(() => d.decisions.answer(decision.id, 'approve')).toThrow(/action executor/);
    await expect(d.decisions.respond(decision.id, 'approve')).rejects.toMatchObject({ status: 428 });
    await expect(d.decisions.respond(decision.id, 'deny', {}, agentActor('codex'))).rejects.toMatchObject({ status: 403 });
    const p = d.decisions.prepare(decision.id, 'approve');
    const result = await d.decisions.respond(decision.id, 'approve', { nonce: p.nonce, channel: 'phone' });
    expect(result).toMatchObject({ cost: { saved: true } });
    expect(d.state.agents[cfg.id].config).toEqual(cfg);
    expect(d.state.decisions[decision.id]).toMatchObject({ answer: 'approve', channel: 'phone', answeredBy: { type: 'human' }, outcome: 'exact paid configuration saved' });
    expect(d.state.decisions[decision.id].confirmedAt).toBeTruthy();
    expect(d.store.kvGet(`agent-cost:${decision.id}`)).toBeNull();
    expect(d.store.kvGet(`decision-confirm:${decision.id}`)).toBeNull();
    await expect(d.decisions.respond(decision.id, 'approve', { nonce: p.nonce })).rejects.toMatchObject({ status: 409 });
    expect(d.egress.log).toEqual([]);
    expect(JSON.parse(d.store.kvGet('agents:overrides')!)[cfg.id]).toEqual(cfg);
  });

  it('denial leaves the existing agent untouched and replacement drafts invalidate stale approvals', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
    const { d } = h;
    const first = d.agentCosts.request(draft());
    const replacement = d.agentCosts.request({ ...draft(), model: 'changed-model' });
    expect(first.decision.id).not.toBe(replacement.decision.id);
    expect(d.state.decisions[first.decision.id].consumedAt).toBeTruthy();
    await expect(d.decisions.respond(first.decision.id, 'approve')).rejects.toMatchObject({ status: 409 });
    await d.decisions.respond(replacement.decision.id, 'deny');
    expect(d.state.agents['api-builder']).toBeUndefined();
    expect(d.store.kvGet(`agent-cost:${replacement.decision.id}`)).toBeNull();
    expect(d.egress.log).toEqual([]);
  });

  it('changed agent settings and expired configuration reviews cannot enable paid usage', async () => {
    let now = new Date('2026-10-07T12:00:00Z');
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false, clock: () => now });
    const { d } = h;
    const original = d.state.agents.codex.config;
    const paid = { ...draft('codex'), name: original.name };
    const requested = d.agentCosts.request(paid, original);
    d.saveAgent({ ...original, name: 'Changed by another window' }, original);
    const confirmation = d.decisions.prepare(requested.decision.id, 'approve');
    await expect(d.decisions.respond(requested.decision.id, 'approve', { nonce: confirmation.nonce })).rejects.toMatchObject({ status: 409 });
    expect(d.state.agents.codex.config.metered_opt_in).toBe(false);
    const expires = d.agentCosts.request(draft());
    now = new Date(now.getTime() + 16 * 60_000);
    const confirmExpired = d.decisions.prepare(expires.decision.id, 'approve');
    await expect(d.decisions.respond(expires.decision.id, 'approve', { nonce: confirmExpired.nonce })).rejects.toMatchObject({ status: 410 });
    await d.decisions.respond(expires.decision.id, 'deny');
    expect(d.state.agents['api-builder']).toBeUndefined();
  });

  it('requires a bounded threshold, explicit pricing and credential-free reviewed endpoints', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
    const { d } = h;
    expect(() => d.agentCosts.request({ ...draft(), budget_usd_per_day: undefined })).toThrow(/threshold/);
    expect(() => d.agentCosts.request({ ...draft(), pricing: undefined })).toThrow(/prices/);
    expect(() => d.agentCosts.request({ ...draft(), base_url: 'https://api.example.com/v1?token=secret' })).toThrow(/credentials|HTTPS/);
    expect(d.egress.log).toEqual([]);
  });
});
