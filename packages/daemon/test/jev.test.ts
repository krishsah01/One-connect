// SPDX-License-Identifier: Apache-2.0
// Jev (TypeSafe System One) advisory recommendations on the human Decisions inbox, against a
// loopback protocol fixture only. No real TypeSafe endpoint or key is involved.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentActor, HUMAN, type Actor, type DecisionAction } from '@acc/core';
import { JEV_ACTOR } from '../src/jev.ts';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

const JEV_KEY = 'tsk_fixture_jev_key_0000000000000000';
const choiceResponse = (choice = 'option_0') => ({ model: 'jev-1.13.0', answers: { decision: { type: 'choice', choice, probabilities: { option_0: choice === 'option_0' ? 0.88 : 0.12, option_1: choice === 'option_1' ? 0.88 : 0.12 }, confidence: 0.81 } }, usage: { input_tokens: 318, output_tokens: 34 } });
interface Seen { auth: string | undefined; body: Record<string, unknown> }

/** A loopback "TypeSafe": POST /v1/systemone with a bearer key. */
async function jevServer(answer: (b: Record<string, unknown>) => Record<string, unknown> | { status: number } | Promise<Record<string, unknown>> = () => choiceResponse()) {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', async () => {
      if (req.method !== 'POST' || req.url !== '/v1/systemone') return res.writeHead(404).end();
      const body = JSON.parse(s) as Record<string, unknown>;
      seen.push({ auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${JEV_KEY}`) return res.writeHead(401).end();
      const out = await answer(body);
      if (body.model !== 'jev-latest' || !body.state || !body.questions || 'choices' in body || 'question' in body) return res.writeHead(422).end();
      if ('status' in out) return res.writeHead(out.status as number).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return { seen, endpoint: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

let h: Harness | null = null;
let srvs: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  await Promise.all(srvs.map((s) => s.close()));
  srvs = [];
});

async function boot(env: Record<string, string> = {}) {
  const repo = makeRepo();
  h = await startDaemon(makeConfig(repo), { probe: false, baseEnv: { ...process.env, ...env } });
  const { d } = h;
  const item = d.createIssue({ title: 'Ship the thing' });
  await waitFor(() => d.state.workItems[item.id].key, 5000);
  const decide = (over: Record<string, unknown> = {}) => d.decisions.create({ question: 'Merge LOC-1 into integration?', options: ['merge', 'hold'], evidence: [{ label: 'Tests', detail: '2 passed', ok: true }], workItemId: item.id, kind: 'question', ...over } as never);
  return { d, item, decide };
}
const enable = (d: ReturnType<typeof Object>, endpoint: string, host: string) => (d as never as { jev: { configure: (i: unknown, a?: Actor) => unknown } }).jev.configure({ enabled: true, endpoint, confirm: { cost: true, network: true, data: true, host } });

describe('Jev advisory', () => {
  it('is disabled by default and reaches nothing: no egress host, no request, no state', async () => {
    const jev = await jevServer();
    srvs.push(jev);
    const { d, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    const dec = decide();
    expect(await d.jev.status()).toMatchObject({ enabled: false, ready: false, keyStored: true, host: 'api.typesafe.ai' });
    expect(d.jev.hosts()).toEqual([]);
    expect(d.egress.allowed).not.toContain('api.typesafe.ai');
    const p = await d.jev.preview(dec.id);
    expect(p).toMatchObject({ canRequest: false, blocked: expect.stringContaining('disabled') });
    await expect(d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: 'api.typesafe.ai' } })).rejects.toMatchObject({ status: 409 });
    expect(jev.seen).toHaveLength(0);
    expect(d.egress.log).toEqual([]);
    expect(d.state.decisions[dec.id].advisory ?? null).toBeNull();
  });

  it('enabling needs explicit cost + network + data confirmation for the named host, by the owner only', async () => {
    const jev = await jevServer();
    srvs.push(jev);
    const { d } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    const cfgInput = { enabled: true, endpoint: jev.endpoint };
    expect(() => d.jev.configure(cfgInput, HUMAN)).toThrow(/explicit cost, network and data/);
    expect(() => d.jev.configure({ ...cfgInput, confirm: { cost: true, network: true, data: true } }, HUMAN)).toThrow(/exact host/);
    expect(() => d.jev.configure({ ...cfgInput, confirm: { cost: true, network: false, data: true, host: jev.host } }, HUMAN)).toThrow(/explicit/);
    for (const actor of [JEV_ACTOR, agentActor('codex'), { type: 'system', id: 'control-center' } as Actor]) {
      expect(() => d.jev.configure({ ...cfgInput, confirm: { cost: true, network: true, data: true, host: jev.host } }, actor)).toThrow(/Only the owner/);
    }
    expect(() => d.jev.configure({ enabled: true, endpoint: 'http://example.com', confirm: { cost: true, network: true, data: true, host: 'example.com' } }, HUMAN)).toThrow(/https/);
    expect(() => d.jev.configure({ enabled: true, endpoint: 'https://user:pw@api.typesafe.ai', confirm: {} }, HUMAN)).toThrow(/no credentials/);
    expect(d.jev.hosts()).toEqual([]);
    enable(d, jev.endpoint, jev.host);
    expect(d.jev.hosts()).toEqual([jev.host]);
    expect(d.egress.allowed).toContain(jev.host);
    expect(d.store.list({ types: ['jev.configured'] })[0]).toMatchObject({ actor: HUMAN, data: { enabled: true, host: jev.host, confirmations: ['cost', 'network', 'data'] } });
    d.jev.configure({ enabled: false }, HUMAN);
    expect(d.egress.allowed).not.toContain(jev.host);
  });

  it('needs the Keychain key as well: enabled without a key still sends nothing', async () => {
    const jev = await jevServer();
    srvs.push(jev);
    const { d, decide } = await boot(); // no ACC_SECRET_JEV and nothing stored under that Keychain name
    enable(d, jev.endpoint, jev.host);
    const dec = decide();
    const p = await d.jev.preview(dec.id);
    expect(await d.jev.status()).toMatchObject({ enabled: true, keyStored: false, ready: false });
    expect(p).toMatchObject({ canRequest: false, blocked: expect.stringContaining('Keychain') });
    await expect(d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } })).rejects.toMatchObject({ status: 409 });
    expect(jev.seen).toHaveLength(0);
  });

  it('previews bounded, redacted evidence; a confirmed request persists hash, model and usage as an advisory that is never an answer', async () => {
    const jev = await jevServer();
    srvs.push(jev);
    const { d, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    enable(d, jev.endpoint, jev.host);
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `Gate ${i}`, detail: i === 0 ? 'deploy token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 leaked in log' : 'x'.repeat(900), ok: true }));
    const dec = decide({ evidence: many, risk: 'high' });
    const p = await d.jev.preview(dec.id);
    expect(p).toMatchObject({ host: jev.host, canRequest: true, truncated: true });
    expect(p.items).toBeLessThanOrEqual(20);
    expect(p.chars).toBeLessThan(6500);
    expect(JSON.stringify(p.payload)).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(p.payload)).toContain('REDACTED');
    // Request guards: confirmation, hash match.
    await expect(d.jev.request(dec.id, { inputHash: p.inputHash })).rejects.toMatchObject({ status: 428 });
    await expect(d.jev.request(dec.id, { inputHash: 'deadbeef', confirm: { cost: true, network: true, data: true, host: jev.host } })).rejects.toMatchObject({ status: 409 });
    await expect(d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } }, agentActor('codex'))).rejects.toMatchObject({ status: 403 });
    expect(jev.seen).toHaveLength(0);

    const after = await d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } });
    expect(jev.seen).toHaveLength(1);
    expect(jev.seen[0].auth).toBe(`Bearer ${JEV_KEY}`);
    expect(jev.seen[0].body).toEqual(p.requestBody);
    expect(jev.seen[0].body).toMatchObject({ model: 'jev-latest', state: p.payload, questions: { decision: { type: 'choice', criteria: { option_0: 'merge', option_1: 'hold' } } } });
    expect(JSON.stringify(jev.seen[0].body)).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(after.advisory).toMatchObject({ provider: 'jev', recommendation: 'merge', model: 'jev-1.13.0', inputHash: p.inputHash, usage: { input_tokens: 318, output_tokens: 34 }, host: jev.host, stale: false, rationale: '', confidence: 0.81 });
    expect(after.advisory!.evidenceIds.length).toBeGreaterThan(0);
    expect(after.advisory!.evidenceIds[0]).toContain(dec.id);
    // Advisory only: the decision is still open and unanswered; Jev's output is not the agent suggestion either.
    expect(after).toMatchObject({ answer: null, answeredAt: null, answeredBy: null, recommendation: null, recommendedBy: null });
    expect(d.store.list({ types: ['decision.advisory'] })[0].actor).toEqual(JEV_ACTOR);
    // The key never lands in events.
    expect(JSON.stringify(d.store.list({ limit: 10_000 }))).not.toContain(JEV_KEY);
    // The same evidence is not paid for twice.
    await expect(d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } })).rejects.toMatchObject({ status: 409 });
    expect(jev.seen).toHaveLength(1);
    // It can never answer, confirm or authorize, whatever it recommended.
    await expect(d.decisions.respond(dec.id, 'merge', {}, JEV_ACTOR)).rejects.toMatchObject({ status: 403 });
    await expect(d.decisions.respond(dec.id, 'merge', {}, { type: 'agent', id: 'jev' })).rejects.toMatchObject({ status: 403 });
    expect(d.decisions.authorizes(dec.id, 'merge', 'any').ok).toBe(false);
    expect(d.state.decisions[dec.id].answeredAt).toBeNull();
  });

  it('discriminates merge, cost, settings and every release action without assuming branch fields', async () => {
    const { d, decide } = await boot();
    const dec = decide();
    const actions: DecisionAction[] = [
      { kind: 'merge', workItemId: 'wi', sourceBranch: 'feature', sourceSha: 'a'.repeat(40), target: 'integration', targetSha: 'b'.repeat(40), reviewId: 'rev', hash: 'merge-hash' },
      { kind: 'cost', agentId: 'api', provider: 'openrouter', model: 'model', budgetUsdPerDay: 5, hash: 'cost-hash' },
      { kind: 'settings', repo: '/fixture/repo', hash: 'settings-hash' },
      ...(['release', 'release_rollback', 'release_inspect'] as const).map((kind) => ({ kind, planId: 'plan', stepId: 'step', stepKind: 'deploy' as const, command: 'deploy fixture', target: 'preview', environment: 'staging', sha: 'c'.repeat(40), hash: kind })),
    ];
    for (const action of actions) {
      const ev = d.jev.buildEvidence({ ...dec, action });
      const details = (ev.payload.context as { action: Record<string, unknown> }).action;
      expect(details).toMatchObject({ kind: action.kind, hash: action.hash });
      if (action.kind === 'merge') expect(details.sourceSha).toBe(action.sourceSha);
      else { expect(details.sourceBranch).toBeUndefined(); expect(details.sourceSha).toBeUndefined(); }
      expect(d.jev.buildEvidence({ ...dec, action: { ...action, hash: 'changed' } }).hash).not.toBe(ev.hash);
    }
    const merge = actions[0] as Extract<DecisionAction, { kind: 'merge' }>;
    expect(d.jev.buildEvidence({ ...dec, action: merge }).hash).not.toBe(d.jev.buildEvidence({ ...dec, action: { ...merge, sourceSha: merge.sourceSha.slice(0, 39) + 'b' } }).hash);
    const secret = 'fixture-private-key'; d.addSecret(secret);
    expect(JSON.stringify(d.jev.buildEvidence({ ...dec, action: { kind: 'settings', repo: `/repo/${secret}`, hash: 'settings' } }).payload)).not.toContain(secret);
    expect(() => d.jev.buildEvidence({ ...dec, action: { kind: 'future', hash: 'unknown' } as unknown as DecisionAction })).toThrow(/unsupported decision action/);
  });

  it('rejects legacy responses, missing usage and malformed typed probabilities', async () => {
    const variants: Record<string, unknown>[] = [
      { answer: 'merge', model_version: 'legacy', usage: {} },
      { ...choiceResponse(), usage: undefined },
      { ...choiceResponse(), usage: { input_tokens: -1, output_tokens: 2 } },
      { ...choiceResponse(), answers: { decision: { type: 'noul', noul: 0.9 } } },
      { ...choiceResponse(), answers: { decision: { ...choiceResponse().answers.decision, probabilities: { option_0: 0.3, option_1: 0.3 } } } },
      { ...choiceResponse(), answers: { decision: { ...choiceResponse().answers.decision, confidence: 2 } } },
    ];
    let response = variants[0];
    const jev = await jevServer(() => response); srvs.push(jev);
    const { d, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY }); enable(d, jev.endpoint, jev.host);
    const dec = decide(); const preview = await d.jev.preview(dec.id);
    for (const variant of variants) {
      response = variant;
      await expect(d.jev.request(dec.id, { inputHash: preview.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } })).rejects.toMatchObject({ status: 502 });
    }
    expect(d.store.list({ types: ['decision.advisory'] })).toHaveLength(0);
    expect(d.state.decisions[dec.id].answeredAt).toBeNull();
  });

  it('cancels an oversized streamed response before consuming or recording it', async () => {
    const { d, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    enable(d, 'https://api.typesafe.ai', 'api.typesafe.ai');
    const dec = decide(); const preview = await d.jev.preview(dec.id);
    let chunks = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(8192).fill(120)); if (chunks === 100) controller.close(); },
      cancel() { cancelled = true; },
    });
    const fetch = vi.spyOn(d.egress, 'fetch').mockResolvedValue(new Response(stream));
    try {
      await expect(d.jev.request(dec.id, { inputHash: preview.inputHash, confirm: { cost: true, network: true, data: true, host: 'api.typesafe.ai' } })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('64 KiB') });
      expect(cancelled).toBe(true);
      expect(chunks).toBeLessThan(100);
      expect(d.state.decisions[dec.id].advisory ?? null).toBeNull();
      expect(fetch).toHaveBeenCalledOnce();
    } finally { fetch.mockRestore(); }
  });

  it('prevents duplicate in-flight requests and refuses a late response after evidence changes', async () => {
    let resolveResponse: (value: Record<string, unknown>) => void = () => undefined;
    const delayed = new Promise<Record<string, unknown>>((resolve) => { resolveResponse = resolve; });
    const jev = await jevServer(() => delayed); srvs.push(jev);
    const { d, item, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY }); enable(d, jev.endpoint, jev.host);
    const dec = decide(); const preview = await d.jev.preview(dec.id);
    const input = { inputHash: preview.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } };
    const first = d.jev.request(dec.id, input);
    await waitFor(() => jev.seen.length === 1, 5000);
    await expect(d.jev.request(dec.id, input)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already running') });
    d.commit([{ type: 'work_item.evidence_added', workItemId: item.id, data: { evidence: { id: 'evd_late', at: d.nowIso(), kind: 'command', summary: 'evidence changed during request', verified: true } as never } }]);
    resolveResponse(choiceResponse());
    await expect(first).rejects.toMatchObject({ status: 409, message: expect.stringContaining('changed while') });
    expect(jev.seen).toHaveLength(1);
    expect(d.state.decisions[dec.id].advisory ?? null).toBeNull();
  });

  it('changed evidence invalidates the advisory; a new preview allows a fresh request', async () => {
    const jev = await jevServer();
    srvs.push(jev);
    const { d, item, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    enable(d, jev.endpoint, jev.host);
    const dec = decide();
    const p = await d.jev.preview(dec.id);
    await d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } });
    expect(d.state.decisions[dec.id].advisory!.stale).toBe(false);
    // New evidence lands on the work item the decision is about.
    d.commit([{ type: 'work_item.evidence_added', workItemId: item.id, data: { evidence: { id: 'evd_new', at: d.nowIso(), kind: 'command', summary: 'lint failed', verified: true } as never } }]);
    await waitFor(() => d.state.decisions[dec.id].advisory?.stale, 5000, 'advisory invalidated');
    expect(d.state.decisions[dec.id].advisory).toMatchObject({ stale: true, staleReason: expect.stringContaining('evidence changed') });
    const again = await d.jev.preview(dec.id);
    expect(again.inputHash).not.toBe(p.inputHash);
    expect(again.canRequest).toBe(true);
    await d.jev.request(dec.id, { inputHash: again.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } });
    expect(d.state.decisions[dec.id].advisory).toMatchObject({ stale: false, inputHash: again.inputHash });
    expect(jev.seen).toHaveLength(2);
  });

  it('rejects results it cannot audit or that are not one of the options; nothing is recorded', async () => {
    let mode: 'bad-choice' | 'no-model' | 'down' | 'ok' = 'bad-choice';
    const jev = await jevServer(() => mode === 'down' ? { status: 503 } : mode === 'bad-choice' ? choiceResponse('abandon-ship') : mode === 'no-model' ? { ...choiceResponse(), model: undefined } : choiceResponse('option_1'));
    srvs.push(jev);
    const { d, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    enable(d, jev.endpoint, jev.host);
    const dec = decide();
    const p = await d.jev.preview(dec.id);
    const go = () => d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } });
    await expect(go()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('one of the decision options') });
    mode = 'no-model';
    await expect(go()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('model version') });
    mode = 'down';
    await expect(go()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('503') });
    expect(d.state.decisions[dec.id].advisory ?? null).toBeNull();
    expect(d.store.list({ types: ['decision.advisory'] })).toHaveLength(0);
    mode = 'ok';
    expect((await go()).advisory).toMatchObject({ recommendation: 'hold' });
  });

  it('closing a preview is audited and sends nothing; valid confidence is recorded', async () => {
    const jev = await jevServer();
    srvs.push(jev);
    const { d, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    enable(d, jev.endpoint, jev.host);
    const dec = decide();
    const p = await d.jev.preview(dec.id);
    d.jev.cancel(dec.id, p.inputHash, HUMAN);
    expect(d.store.list({ types: ['jev.cancelled'] })[0]).toMatchObject({ actor: HUMAN, data: { decisionId: dec.id, inputHash: p.inputHash } });
    expect(() => d.jev.cancel(dec.id, p.inputHash, JEV_ACTOR)).toThrow(/Only the owner/);
    expect(jev.seen).toHaveLength(0);
    const after = await d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } });
    expect(after.advisory).toMatchObject({ confidence: 0.81, usage: { input_tokens: 318, output_tokens: 34 } });
    expect(d.decisions.history(dec.id).map((e) => e.type)).toEqual(expect.arrayContaining(['jev.cancelled', 'decision.advisory']));
  });

  it('an answered decision no longer takes advice; the recorded advisory stays as history', async () => {
    const jev = await jevServer();
    srvs.push(jev);
    const { d, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    enable(d, jev.endpoint, jev.host);
    const dec = decide();
    const p = await d.jev.preview(dec.id);
    await d.jev.request(dec.id, { inputHash: p.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } });
    d.decisions.answer(dec.id, 'hold', {}, HUMAN);
    expect(d.state.decisions[dec.id]).toMatchObject({ answer: 'hold', answeredBy: HUMAN });
    expect(d.state.decisions[dec.id].advisory).toMatchObject({ recommendation: 'merge', stale: false });
    await expect(d.jev.preview(dec.id)).rejects.toMatchObject({ status: 409 });
  });

  it('is reachable only through the authenticated daemon API, with the same guards', async () => {
    const jev = await jevServer();
    srvs.push(jev);
    const { d, decide } = await boot({ ACC_SECRET_JEV: JEV_KEY });
    const dec = decide();
    const token = (await import('node:fs')).readFileSync(d.paths.installToken, 'utf8').trim();
    const call = (method: string, path: string, body?: unknown, auth = true) => fetch(h!.url + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await call('GET', '/api/jev', undefined, false)).status).toBe(401);
    expect(await (await call('GET', '/api/jev')).json()).toMatchObject({ enabled: false, disclosure: { cost: expect.any(String), network: expect.any(String), data: expect.any(String), authority: expect.stringContaining('never recorded as your answer') } });
    expect((await call('POST', '/api/jev/configure', { enabled: true, endpoint: jev.endpoint })).status).toBe(428);
    expect((await call('POST', '/api/jev/configure', { enabled: true, endpoint: jev.endpoint, confirm: { cost: true, network: true, data: true, host: jev.host } })).status).toBe(200);
    const prev = (await (await call('GET', `/api/decisions/${dec.id}/advisory/preview`)).json()) as { inputHash: string };
    expect((await call('POST', `/api/decisions/${dec.id}/advisory`, { inputHash: prev.inputHash })).status).toBe(428);
    const done = await call('POST', `/api/decisions/${dec.id}/advisory`, { inputHash: prev.inputHash, confirm: { cost: true, network: true, data: true, host: jev.host } });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { decision: { advisory: { recommendation: string }; answer: null } }).decision).toMatchObject({ advisory: { recommendation: 'merge' }, answer: null });
  });
});
