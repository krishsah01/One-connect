// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUMAN, SYSTEM } from '@acc/core';
import { JEV_ACTOR } from '../src/jev.ts';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';
let h: Harness | null = null;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); h = null; });
const config = () => makeConfig(makeRepo());
async function setup(fetcher?: (url: string, init?: RequestInit) => Promise<Response>) {
  const cfg = config();
  h = await startDaemon(cfg, { server: false, fetch: fetcher, baseEnv: { ...process.env, ACC_SECRET_JEV: 'tsk_offline_workflow_fixture_0000000000' } });
  const d = h.d;
  const workflows = [];
  for (let i = 0; i < 3; i++) {
    const item = d.createIssue({ title: `Workflow ${i}`, acceptance: ['Fixture gate'] });
    await waitFor(() => d.state.workItems[item.id].key, 5000);
    workflows.push(d.workflows.save({ definition: { name: `Workflow ${i}`, tasks: [{ id: 'work', workItemId: item.id, agentId: 'ag', kind: 'coordination' }] } }));
  }
  return { d, cfg, from: workflows[0].id, a: workflows[1].id, b: workflows[2].id };
}
function complete(d: Harness['d'], id: string) {
  // Recorded lifecycle fixture isolates the links; workflow evidence is exercised by workflows.test.ts.
  d.commit([{ type: 'workflow.task_updated', actor: SYSTEM, data: { workflowId: id, taskId: 'work', patch: { status: 'done' } } }, { type: 'workflow.status', actor: SYSTEM, data: { workflowId: id, status: 'completed', reason: 'recorded fixture completion' } }]);
}
const gate = (a: string, b: string) => ({ kind: 'human', question: 'Which workflow starts next?', options: [{ label: 'Frontend', to: a }, { label: 'Backend', to: b }] });
function jevResponse(choice = 'option_1') { return new Response(JSON.stringify({ model: 'jev-fixture-v1', answers: { decision: { type: 'choice', choice, confidence: 0.9, probabilities: { option_0: 0.1, option_1: 0.9 } } }, usage: { input_tokens: 20, output_tokens: 2 } }), { status: 200 }); }
function enable(d: Harness['d']) { d.jev.configure({ enabled: true, confirm: { cost: true, network: true, data: true, host: 'api.typesafe.ai' } }); }
function policy(autoDecide = true, bytes = 24000) { return { autoDecide, host: 'api.typesafe.ai', maxEvidenceBytes: bytes, confirmedAt: new Date().toISOString(), confirmedBy: 'owner' }; }

describe('durable workflow links', () => {
  it('starts each chain target once and survives restart', async () => {
    const { d, cfg, from, a, b } = await setup();
    const link = d.workflowLinks.save({ from, to: [a, b], gate: null });
    complete(d, from); await d.workflowLinks.idle();
    expect(d.workflowLinks.get(link.id)).toMatchObject({ status: 'started', started: [a, b] });
    const count = Object.keys(d.state.assignments).length;
    const dataDir = h!.dataDir; await h!.close(); h = null;
    h = await startDaemon(cfg, { dataDir, server: false }); await h.d.workflowLinks.idle();
    expect(h.d.workflowLinks.get(link.id).status).toBe('started');
    expect(Object.keys(h.d.state.assignments)).toHaveLength(count);
  });
  it('keeps a human decision across restart and routes phone/inbox answers through Decisions', async () => {
    const { d, cfg, from, a, b } = await setup();
    const link = d.workflowLinks.save({ from, to: [a, b], gate: gate(a, b) });
    complete(d, from); await d.workflowLinks.idle();
    const decisionId = d.workflowLinks.get(link.id).decisionId!;
    expect(d.state.workflows[a].status).toBe('draft');
    const dataDir = h!.dataDir; await h!.close(); h = null;
    h = await startDaemon(cfg, { dataDir, server: false }); await h.d.workflowLinks.idle();
    expect(h.d.workflowLinks.get(link.id).decisionId).toBe(decisionId);
    expect(() => h!.d.decisions.answer(decisionId, 'Backend')).toThrow('bound action');
    await h.d.decisions.respond(decisionId, 'Backend', { channel: 'phone' });
    expect(h.d.workflowLinks.get(link.id)).toMatchObject({ status: 'started', decision: { option: 'Backend', by: 'human' } });
    expect(h.d.state.workflows[a].status).toBe('draft');
    expect(h.d.state.workflows[b].startedAt).toBeTruthy();
    expect(h.d.state.workflows[b].status).not.toBe('draft');
  });
  it('refuses bad targets, cycles and reconfigured targets; source cancel cancels links and decisions', async () => {
    const { d, from, a, b } = await setup();
    const link = d.workflowLinks.save({ from, to: [a, b], gate: gate(a, b) });
    expect(() => d.workflowLinks.save({ from: a, to: [from], gate: null })).toThrow('cycle');
    expect(() => d.workflowLinks.save({ from, to: [from], gate: null })).toThrow('source');
    d.workflows.save({ id: b, definition: { ...d.workflows.get(b).definition, name: 'Changed after preview' } });
    complete(d, from); await d.workflowLinks.idle();
    await d.workflowLinks.decide(link.id, 'Backend');
    expect(d.workflowLinks.get(link.id).reason).toContain('Target changed');
    expect(d.workflows.get(b).status).toBe('draft');
    const { d: d2, from: f2, a: a2, b: b2 } = await (async () => { await h!.close(); h = null; return setup(); })();
    const canceled = d2.workflowLinks.save({ from: f2, to: [a2, b2], gate: gate(a2,b2) });
    complete(d2, f2); await d2.workflowLinks.idle();
    const decisionId = d2.workflowLinks.get(canceled.id).decisionId!;
    d2.commit([{ type: 'workflow.status', data: { workflowId: f2, status: 'canceled', reason: 'owner canceled' } }]); await d2.workflowLinks.idle();
    expect(d2.workflowLinks.get(canceled.id).status).toBe('canceled');
    expect(d2.state.decisions[decisionId].consumedAt).toBeTruthy();
    await expect(d2.workflowLinks.decide(canceled.id, 'Frontend')).rejects.toThrow('not open');
  });
});

describe('Jev gates are confined to workflow routing', () => {
  it('auto-picks an exact predefined target under recorded owner policy, without answering generic Decisions', async () => {
    const seen: string[] = [];
    const { d, from, a, b } = await setup(async url => { seen.push(url); return jevResponse(); });
    enable(d);
    const link = d.workflowLinks.save({ from, to: [a,b], gate: { ...gate(a,b), kind: 'jev', jev: policy() } });
    complete(d, from); await d.workflowLinks.idle();
    expect(seen).toEqual(['https://api.typesafe.ai/v1/systemone']);
    expect(d.workflowLinks.get(link.id)).toMatchObject({ status: 'started', decision: { by: 'jev', option: 'Backend' } });
    const dec = d.state.decisions[d.workflowLinks.get(link.id).decisionId!];
    expect(dec.answeredAt).toBeNull(); expect(dec.consumedAt).toBeTruthy();
    const irreversible = d.decisions.create({ question: 'Release?', options: ['Publish', 'Cancel'], irreversible: true });
    expect(() => d.decisions.answer(irreversible.id, 'Publish', {}, JEV_ACTOR)).toThrow('human');
    expect(d.state.workflows[a].status).toBe('draft');
  });
  it.each(['disabled', 'invalid-choice', 'error', 'too-much-evidence', 'advisory-only'])('falls back to a human for %s', async mode => {
    const fetcher = vi.fn(async () => { if (mode === 'error') throw new Error('offline'); return jevResponse(mode === 'invalid-choice' ? 'another-option' : 'option_1'); });
    const { d, from, a, b } = await setup(fetcher);
    if (mode !== 'disabled') enable(d);
    const link = d.workflowLinks.save({ from, to: [a,b], gate: { ...gate(a,b), kind: 'jev', jev: mode === 'disabled' ? null : policy(mode !== 'advisory-only', mode === 'too-much-evidence' ? 1 : 24000) } });
    complete(d, from); await d.workflowLinks.idle();
    expect(d.workflowLinks.get(link.id).status).toBe('open');
    expect(d.state.workflows[a].status).toBe('draft'); expect(d.state.workflows[b].status).toBe('draft');
    if (mode === 'disabled' || mode === 'too-much-evidence') expect(fetcher).not.toHaveBeenCalled();
    await d.workflowLinks.decide(link.id, 'Frontend', HUMAN);
    expect(d.state.workflows[a].status).toBe('running');
  });
});
