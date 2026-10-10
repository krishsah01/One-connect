// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// In-memory Fastify injection and fake fetch: no listeners, vendors or live integrations.
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfigSchema, type Decision } from '@acc/core';
import { remoteGate } from '../src/phone/gate.ts';
import { registerPhoneHooks, registerPhoneRoutes } from '../src/phone/routes.ts';
import { ProjectDocker } from '../src/docker.ts';
import { FixtureAdapter, TailscaleAdapter } from '../src/phone/tunnel.ts';
import { git, makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

let harness: Harness | null = null, app: FastifyInstance | null = null;
const now = Date.parse('2026-10-07T12:00:00Z');
afterEach(async () => { await app?.close(); app = null; await harness?.close(); harness = null; });
async function setup(scopes = ['read', 'decisions']) {
  let time = now;
  const sent: { url: string; body: unknown; redirect: unknown; permit: unknown }[] = [];
  harness = await startDaemon(makeConfig(makeRepo()), { server: false, probe: false, clock: () => new Date(time), fetch: async (url, init) => {
    sent.push({ url, body: JSON.parse(String(init?.body)), redirect: init?.redirect, permit: (init as { notificationPermit?: string })?.notificationPermit });
    return new Response('fake receipt', { status: 202 });
  } });
  const d = harness.d;
  const fixture = new FixtureAdapter('phone.fixture.test');
  d.remote.useAdapter(fixture);
  await d.remote.configure({ enabled: true, adapter: 'fixture', scopes });
  const launch = d.remote.requestLaunch().decision, confirmation = d.decisions.prepare(launch.id, 'approve');
  await d.decisions.respond(launch.id, 'approve', { nonce: confirmation.nonce });
  const pairing = d.remote.issuePairing(), paired = d.remote.pair(pairing.token);
  app = Fastify();
  app.addHook('onRequest', async (req, reply) => remoteGate(d, req, reply));
  registerPhoneHooks(app, d);
  registerPhoneRoutes(app, d);
  // These three shared handlers delegate to the actual shared Decisions router.
  app.get('/api/state', async () => ({ seq: d.state.seq, state: d.state }));
  app.post<{ Params: { id: string }; Body: { answer: string } }>('/api/decisions/:id/prepare', async req => d.decisions.prepare(req.params.id, req.body.answer));
  app.post<{ Params: { id: string }; Body: { answer: string; nonce?: string; channel?: string } }>('/api/decisions/:id/answer', async req => d.decisions.respond(req.params.id, req.body.answer, { nonce: req.body.nonce, channel: req.body.channel }));
  app.get<{ Params: { id: string } }>('/api/decisions/:id/history', async req => ({ events: d.decisions.history(req.params.id) }));
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>('/api/runs/:id/events', async req => ({ events: d.store.list({ runId: req.params.id, afterSeq: Number(req.query.since ?? 0), limit: 1000 }) }));
  app.get<{ Params: { id: string } }>('/api/work-items/:id/events', async req => ({ events: d.store.list({ workItemId: req.params.id, kind: 'control', limit: 2000 }) }));
  app.get<{ Params: { id: string } }>('/api/runs/:id/log', async (req, reply) => reply.type('text/plain').send(fs.createReadStream(path.join(d.runs.supervisor.runDir(req.params.id), 'stdout.jsonl'))));
  app.get('/api/runs/:id/log/page', async () => ({ text: 'unprojected raw response', offset: 0, nextOffset: 0, totalBytes: 0 }));
  app.get('/api/team', async () => d.team.snapshot());
  app.get('/api/team/messages', async () => d.team.list(null));
  const headers = { host: 'phone.fixture.test', origin: 'http://phone.fixture.test', cookie: `${paired.cookieName}=${paired.cookie}`, 'x-acc-csrf': paired.csrf };
  const request = (url: string, payload?: unknown, extra: Record<string, string> = {}) => app!.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { ...headers, ...extra }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { d, request, sent, paired, fixture, advance: (ms: number) => { time += ms; } };
}

describe('phone target scopes and actual Decision dispatch', () => {
  it('allows project kinds with the project decision scope and retains destructive second confirmation', async () => {
    const { d, request } = await setup();
    for (const kind of ['question', 'merge', 'docker', 'environment', 'release', 'cost', 'settings', 'connector']) {
      const dec = d.decisions.create({ kind: kind as Decision['kind'], question: `Exact ${kind}?`, options: ['approve', 'deny'], irreversible: true, confirmOptions: ['approve'] });
      const prep = await request(`/api/decisions/${dec.id}/prepare`, { answer: 'approve' });
      expect(prep.statusCode, kind).toBe(200);
      expect(prep.json()).toMatchObject({ confirm: true, nonce: expect.any(String) });
      expect((await request(`/api/decisions/${dec.id}/answer`, { answer: 'approve' })).statusCode, kind).toBe(428);
    }
    const q = d.decisions.create({ question: 'Keep this?', options: ['yes', 'no'] });
    expect((await request(`/api/decisions/${q.id}/answer`, { answer: 'yes', channel: 'web' })).statusCode).toBe(200);
    expect(d.state.decisions[q.id].channel).toBe('phone');
    expect(d.state.decisions[q.id].answeredBy?.type).toBe('human');
  });

  it('delivers one exact confirmed notification through Decisions.respond and shared permit egress', async () => {
    const { d, request, sent } = await setup();
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: 'https://notifications.fixture.test/private-hook' } } });
    const review = d.notifications.requestEndpointActivation('chat');
    expect((await request(`/api/decisions/${review.id}/prepare`, { answer: 'approve' })).statusCode).toBe(403);
    expect((await request(`/api/decisions/${review.id}/history`)).statusCode).toBe(403);
    const n = await d.notifications.sendTest(), id = d.notifications.status().pendingDeliveries[0].decisionId;
    expect(sent).toEqual([]);
    expect((await request(`/api/decisions/${id}/answer`, { answer: 'approve' })).statusCode).toBe(428);
    const prep = (await request(`/api/decisions/${id}/prepare`, { answer: 'approve' })).json();
    const response = await request(`/api/decisions/${id}/answer`, { answer: 'approve', nonce: prep.nonce });
    expect(response.statusCode).toBe(200);
    expect(response.json().notification).toEqual({ recorded: true });
    expect(sent).toEqual([{ url: 'https://notifications.fixture.test/private-hook', body: { id: n.id, kind: 'finished_work', severity: 'info', title: 'Test notification from One Connect', at: new Date(now).toISOString(), source: 'one-connect' }, redirect: 'error', permit: undefined }]);
    expect(d.egress.allowed).not.toContain('notifications.fixture.test');
    expect(d.egress.log.at(-1)).toMatchObject({ allowed: true, purpose: 'notification delivery' });
    expect((await request(`/api/decisions/${id}/answer`, { answer: 'approve', nonce: prep.nonce })).statusCode).toBe(409);
    await d.notifications.sendTest();
    expect(sent).toHaveLength(1);
    expect((await request(`/api/decisions/${id}/history`)).json().events.some((e: { type: string }) => e.type === 'decision.consumed')).toBe(true);
  });

  it('requires explicit tunnel decision scope and never opens management or secret routes', async () => {
    const { d, request } = await setup();
    const remote = d.decisions.create({ kind: 'remote', question: 'Tunnel?', options: ['approve', 'deny'] });
    expect((await request(`/api/decisions/${remote.id}/prepare`, { answer: 'approve' })).statusCode).toBe(403);
    for (const url of ['/api/remote/config', '/api/remote/pairings', '/api/connections', '/api/docker', '/api/context', '/api/config', '/api/notifications/config']) expect((await request(url, {})).statusCode, url).toBe(403);
    await d.remote.configure({ scopes: ['read', 'decisions', 'remote_decisions'] });
    // Adding a grant does not silently enlarge an existing pairing.
    expect((await request(`/api/decisions/${remote.id}/prepare`, { answer: 'approve' })).statusCode).toBe(403);
  });

  it('enforces narrowing, Origin and CSRF on the same target routes', async () => {
    const { d, request } = await setup();
    const dec = d.decisions.create({ question: 'Question?', options: ['yes', 'no'] });
    expect((await request(`/api/decisions/${dec.id}/answer`, { answer: 'yes' }, { 'x-acc-csrf': 'wrong' })).statusCode).toBe(403);
    expect((await request(`/api/decisions/${dec.id}/answer`, { answer: 'yes' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    const closed: string[] = [];
    d.bus.on('remote.revoked', id => closed.push(id));
    await d.remote.configure({ scopes: ['read'] });
    expect(closed).toHaveLength(1);
    expect((await request(`/api/decisions/${dec.id}/prepare`, { answer: 'yes' })).statusCode).toBe(403);
    expect((await request('/api/state')).statusCode).toBe(200);
  });

  it('projects HTTP and socket state without executable config or inaccessible Decisions', async () => {
    const { d, request } = await setup(['read']);
    d.state.agents.claude.config.instructions = 'arbitrary-secret-value';
    d.state.agents.claude.config.binary = '/private/credential-binary';
    const dec = d.decisions.create({ kind: 'remote', question: 'Private tunnel?', options: ['approve', 'deny'] });
    const state = (await request('/api/state')).json().state;
    expect(state.project.repo).toBe('');
    expect(state.connectors).toEqual({});
    expect(state.decisions[dec.id]).toBeUndefined();
    expect(JSON.stringify(state)).not.toMatch(/arbitrary-secret-value|credential-binary/);
    expect(d.remote.projectState(['read'])).toEqual(state);
    const history = d.decisions.history(dec.id);
    expect(d.remote.projectEvents(history, ['read', 'decisions'])).toEqual([]);
    expect(d.remote.projectEvents(history, ['read', 'decisions', 'remote_decisions']).some(e => e.type === 'decision.created')).toBe(true);
  });
  it('projects socket batches while preserving permitted transcript and local notification events', async () => {
    const { d } = await setup();
    const n = await d.notifications.sendTest();
    d.commit([{ type: 't.message', runId: 'fixture_run', data: { role: 'assistant', text: 'approved transcript fixture' } }]);
    const events = d.store.list({ types: ['config.loaded', 'notification.emitted', 't.message'] });
    const messages = d.remote.projectMessages({ type: 'events', events }, ['read', 'transcript']) as { type: string; events?: { type: string }[]; state?: unknown }[];
    expect(messages.map(m => m.type)).toEqual(['events', 'snapshot']);
    expect(messages[0].events!.map(e => e.type)).toEqual(['notification.emitted', 't.message']);
    expect(JSON.stringify(messages[0])).toContain(n.id);
    const restricted = d.remote.projectMessages({ type: 'events', events }, ['read']) as { type: string; events?: { type: string }[] }[];
    expect(restricted[0].events!.map(e => e.type)).toEqual(['notification.emitted']);
    expect(d.remote.projectMessages({ type: 'live', text: 'fixture' }, ['read'])).toEqual([]);
  });

  it('keeps actual billing/metered/budget fields and unknown usage while stripping assignment execution and paths', async () => {
    const { d } = await setup();
    const a = d.state.agents.claude;
    Object.assign(a.config, { billing: 'metered', metered_opt_in: true, on_demand: true, concurrency: 3, budget_usd_per_day: 7, enabled: false });
    a.billing = { mode: 'metered', source: 'explicit test fixture', overage: 'unknown' };
    d.state.assignments.fixture = {
      id: 'fixture', workItemId: 'w', agentId: 'claude', position: 'now', branch: 'agent/work', baseRef: 'integration', baseSha: null,
      scope: '/private/sensitive/scope', allowedPaths: ['/private/sensitive/owned'], worktree: '/private/sensitive/worktree', requiredChecks: ['/private/sensitive/executable'], askHumanIf: [], handoffFormat: '', prompt: 'private assignment instructions', promptEdited: true, model: null, effort: null, preflight: null, createdAt: new Date(now).toISOString(), dispatchedAt: null,
    };
    Object.assign(d.state.assignments.fixture, { contextNotes: '/private/sensitive/notes' });
    const projected = d.remote.projectState(['read']);
    expect(projected.agents.claude.config).toMatchObject({ billing: 'metered', metered_opt_in: true, on_demand: true, concurrency: 3, budget_usd_per_day: 7, enabled: false });
    expect(projected.agents.claude.billing.overage).toBe('unknown');
    expect(projected.agents.claude.usage).toEqual(a.usage);
    expect(projected.assignments.fixture).toMatchObject({ id: 'fixture', agentId: 'claude', position: 'now', branch: 'agent/work', prompt: '', requiredChecks: [] });
    expect(JSON.stringify(projected.assignments)).not.toMatch(/private assignment|sensitive/);
  });

});

describe('resumed phone acceptance without network listeners', () => {
  it('approves exact cost and settings through the real gate/router once, with no executor config in responses', async () => {
    const { d, request, sent } = await setup();
    const cfg = AgentConfigSchema.parse({ id: 'phone-cost-fixture', name: 'Disabled paid fixture', role: 'engineer', adapter: 'opencode-server', provider: 'openai-api', model: 'fixture', enabled: false, metered_opt_in: true, budget_usd_per_day: 2, pricing: { input_per_mtok: 1, output_per_mtok: 1 } });
    const cost = d.agentCosts.request(cfg).decision;
    const current = d.settings.read();
    const settings = d.settings.request({ ...current.settings, project: { ...current.settings.project, name: 'Phone fixture project' } }, current.revision);
    for (const [dec, answer, result] of [[cost, 'approve', 'cost'], [settings, 'save', 'settings']] as const) {
      expect((await request(`/api/decisions/${dec.id}/answer`, { answer })).statusCode).toBe(428);
      const prep = (await request(`/api/decisions/${dec.id}/prepare`, { answer })).json();
      expect(prep.confirm).toBe(true);
      const response = await request(`/api/decisions/${dec.id}/answer`, { answer, nonce: prep.nonce });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()[result]).toEqual({ saved: true });
      expect(d.state.decisions[dec.id].channel).toBe('phone');
      expect(d.state.decisions[dec.id].confirmedAt).toBeTruthy();
      expect((await request(`/api/decisions/${dec.id}/answer`, { answer, nonce: prep.nonce })).statusCode).toBe(409);
    }
    expect(d.config.project.name).toBe('Phone fixture project');
    expect(d.state.agents[cfg.id].config).toEqual(cfg);
    expect(sent).toEqual([]);
    expect(d.egress.log).toEqual([]);
  });

  it('fails closed for legacy Docker/connector records missing confirmation, while allowing denial', async () => {
    const { d, request } = await setup();
    const commands: string[][] = [];
    Object.defineProperty(d, 'docker', { value: new ProjectDocker(d, async args => { commands.push(args); return { code: 0, stdout: args[0] === 'ps' ? JSON.stringify({ ID: 'abcdef123456', Names: 'fixture', State: 'running', Status: 'up', Image: 'fixture' }) : '', stderr: '', timedOut: false }; }) });
    const docker = (await d.docker.request('abcdef123456', 'restart')).decision;
    d.connectors.save({ id: 'phone-connector', name: 'Fixture draft', config: { kind: 'linear', team: 'FIXTURE' } }, null);
    const connector = d.connectors.requestActivation('phone-connector', 'import').decision!;
    for (const dec of [docker, connector]) {
      // Reconstruct a pre-integration saved request, retaining the actual factory's bound KV.
      d.commit([{ type: 'decision.created', data: { decision: { ...dec, confirmOptions: undefined } } }]);
      expect((await request(`/api/decisions/${dec.id}/prepare`, { answer: 'approve' })).statusCode).toBe(403);
      expect((await request(`/api/decisions/${dec.id}/answer`, { answer: 'approve' })).statusCode).toBe(403);
      expect((await request(`/api/decisions/${dec.id}/prepare`, { answer: 'deny' })).statusCode).toBe(200);
      expect(d.state.decisions[dec.id].answeredAt).toBeNull();
    }
    expect(commands.every(args => args[0] === 'ps')).toBe(true);
    expect(d.egress.log).toEqual([]);
  });

  it('projects run HTTP/WS history identically and keeps hidden-row cursors across a full page', async () => {
    const { d, request } = await setup(['read', 'transcript']);
    const q = d.decisions.create({ kind: 'remote', question: 'ungranted tunnel question', options: ['approve', 'deny'] });
    // A full page of hidden controls must still advance past its last raw seq.
    d.commit(Array.from({ length: 1000 }, () => ({ type: 'decision.recommended' as const, runId: 'paging-fixture', data: { decisionId: q.id, recommendation: 'approve', rationale: 'private control fixture' } })));
    d.commit([{ type: 't.message', runId: 'paging-fixture', data: { role: 'assistant', text: 'next page transcript' } }]);
    const raw = d.store.list({ runId: 'paging-fixture', limit: 1000 });
    const first = (await request('/api/runs/paging-fixture/events')).json().events;
    const ws = d.remote.projectMessages({ type: 'run_events', runId: 'paging-fixture', events: raw, more: true, config: 'private extra field' }, ['read', 'transcript']) as any[];
    expect(first).toHaveLength(1000);
    expect(first.at(-1).seq).toBe(raw.at(-1)!.seq);
    expect(first.every((e: any) => e.type === 'phone.cursor' && Object.keys(e.data).length === 0)).toBe(true);
    expect(ws[0].events).toEqual(first);
    expect(ws[0].more).toBe(true);
    expect(ws[0].config).toBeUndefined();
    const next = (await request(`/api/runs/paging-fixture/events?since=${first.at(-1).seq}`)).json().events;
    expect(next).toHaveLength(1);
    expect(next[0].data.text).toBe('next page transcript');
    expect(d.remote.projectMessages({ type: 'run_events', runId: 'paging-fixture', events: raw, more: true }, ['read'])).toEqual([]);
  });

  it('projects report and issue-event views by Decision/transcript grants and strips team paths', async () => {
    const { d, request } = await setup(['read']);
    const item = d.createIssue({ title: 'Visible status', description: 'private issue body' });
    const dec = d.decisions.create({ kind: 'remote', question: 'private tunnel decision text', options: ['approve', 'deny'], workItemId: item.id });
    d.commit([{ type: 'run.handoff', runId: 'r', workItemId: item.id, data: { handoff: { done: 'private transcript handoff', raw: 'private raw prose', source: 'mcp', evidence: [], commit: null, blocked: null, next: null } } }]);
    d.state.assignments.fixture = { id: 'fixture', workItemId: item.id, agentId: 'claude', position: 'next', branch: null, baseRef: 'integration', baseSha: null, scope: '', prompt: '', promptEdited: false, allowedPaths: ['/private/assignment-path'], worktree: null, requiredChecks: [], askHumanIf: [], handoffFormat: '', model: null, effort: null, preflight: null, createdAt: new Date(now).toISOString(), dispatchedAt: null };
    d.state.agents.claude.queue.next = ['fixture'];
    for (const url of ['/api/state', `/api/work-items/${item.id}/events`, '/api/reports/brief', '/api/reports/timeline', '/api/reports/morning', '/api/reports/standup', '/api/reports/standup?format=md', '/api/team']) {
      const response = await request(url);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body, url).not.toMatch(/private tunnel decision|private transcript handoff|private raw prose|private issue body|private\/assignment-path/);
    }
    expect((await request('/api/team/messages')).statusCode).toBe(403);
    await d.remote.configure({ scopes: ['read', 'decisions', 'transcript', 'remote_decisions'] });
    // New grants do not enlarge this pairing.
    expect((await request(`/api/decisions/${dec.id}/history`)).statusCode).toBe(403);
    const allowed = d.remote.projectEvents(d.decisions.history(dec.id), ['read', 'decisions', 'remote_decisions']);
    expect(JSON.stringify(allowed)).toContain('private tunnel decision text');
  });

  it('keeps status unknown values but drops future fields, raw exit text and nested management evidence', async () => {
    const { d } = await setup();
    Object.assign(d.state.agents.claude, { futurePrivate: 'private future agent config' });
    d.state.runs.fixture = { id: 'fixture', assignmentId: 'a', workItemId: 'w', agentId: 'claude', adapter: 'claude-headless', model: null, resolvedModel: null, effort: null, attempt: 1, retryOf: null, pid: 22, sessionId: 'private session', logDir: '/private/log', state: 'failed', createdAt: new Date(now).toISOString(), startedAt: null, endedAt: null, lastEventAt: null, lastMeaningful: { at: '', summary: 'private transcript summary' }, eventCount: 1, usage: { inputTokens: 0, outputTokens: 0 }, exit: { kind: 'crash', message: 'private exit transcript' }, handoff: null, filesChanged: [], outOfScope: [], tests: null };
    Object.assign(d.state.runs.fixture, { futurePrivate: 'private future run config' });
    const s = d.remote.projectState(['read']);
    expect(s.runs.fixture.exit).toEqual({ kind: 'crash', message: '' });
    expect(s.agents.claude.usage.status).toBe('unknown');
    expect(JSON.stringify(s)).not.toMatch(/private future|private exit|private session|private transcript|private\/log/);
    expect(d.remote.projectState(['read', 'transcript']).runs.fixture.lastMeaningful?.summary).toBe('private transcript summary');
  });

  it('permanently narrows the pairing and expires idle/absolute sessions even without another HTTP request', async () => {
    const { d, paired, advance } = await setup(['read', 'transcript']);
    const closed: string[] = [];
    d.bus.on('remote.revoked', id => closed.push(id));
    await d.remote.configure({ scopes: ['read'] });
    await d.remote.configure({ scopes: ['read', 'transcript'] });
    const auth = d.remote.authenticate(paired.cookie);
    expect(auth.ok && auth.principal.scopes).toEqual(['read']);
    advance(5 * 60_000);
    await d.remote.configure({ idleTimeoutMinutes: 5 });
    expect(d.remote.activeSessions()).toEqual([]);
    expect(closed).toEqual([paired.session.id, paired.session.id]);
    expect(d.remote.authenticate(paired.cookie).ok).toBe(false);
    const fresh = d.remote.pair(d.remote.issuePairing().token);
    advance(60 * 60_000);
    await d.remote.configure({ idleTimeoutMinutes: 1440, sessionTtlHours: 1 });
    await d.remote.tick();
    expect(d.remote.authenticate(fresh.cookie).ok).toBe(false);
    expect(closed).toContain(fresh.session.id);
  });

  it('closes sockets and clears ingress honestly on throwing probes and delayed launch cancellation', async () => {
    const { d, fixture, paired } = await setup();
    const closed: string[] = [];
    d.bus.on('remote.revoked', id => closed.push(id));
    fixture.probe = async () => { throw new Error('fixture probe unavailable'); };
    await d.remote.tick();
    expect(d.remote.status().tunnel.state).toBe('reconnecting');
    await d.remote.tick(); await d.remote.tick();
    expect(d.remote.hosts()).toEqual([]);
    expect(closed).toContain(paired.session.id);
    let release!: () => void;
    fixture.start = async () => { await new Promise<void>(r => { release = r; }); fixture.running = true; return { hostname: fixture.hostname }; };
    const decision = d.remote.requestLaunch().decision, confirm = d.decisions.prepare(decision.id, 'approve');
    const starting = d.decisions.respond(decision.id, 'approve', { nonce: confirm.nonce });
    await d.remote.configure({ enabled: false });
    release(); await starting;
    expect(fixture.running).toBe(false);
    expect(d.remote.hosts()).toEqual([]);
    expect(d.remote.status().tunnel.state).toBe('down');
  });
});

describe('phone raw logs and teardown', () => {
  it('redacts secrets before raw/paged responses, holds incomplete live lines and bounds phone log memory', async () => {
    const { d, request } = await setup(['read', 'transcript']);
    d.state.runs.log_fixture = { id: 'log_fixture', assignmentId: 'a', workItemId: 'w', agentId: 'claude', adapter: 'claude-headless', model: null, resolvedModel: null, effort: null, attempt: 1, retryOf: null, pid: null, sessionId: null, logDir: null, state: 'running', createdAt: new Date(now).toISOString(), startedAt: null, endedAt: null, lastEventAt: null, lastMeaningful: null, eventCount: 0, usage: { inputTokens: 0, outputTokens: 0 }, exit: null, handoff: null, filesChanged: [], outOfScope: [], tests: null };
    const dir = d.runs.supervisor.runDir('log_fixture'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'stdout.jsonl'), secret = 'phone-boundary-secret-value';
    d.addSecret(secret);
    fs.writeFileSync(file, 'a'.repeat(128 * 1024 - 7) + secret + '\n' + 'incomplete credential tail');
    const first = (await request('/api/runs/log_fixture/log/page')).json();
    const second = (await request(`/api/runs/log_fixture/log/page?offset=${first.nextOffset}`)).json();
    expect(first.text + second.text).not.toContain(secret);
    expect(first.text + second.text).not.toContain('phone-boundary');
    expect((first.text + second.text).includes('[REDACTED:denylist]')).toBe(true);
    expect(first.nextOffset).toBe(128 * 1024);
    expect(second.nextOffset).toBe(first.totalBytes);
    const raw = await request('/api/runs/log_fixture/log');
    expect(raw.body).toBe(first.text + second.text);
    expect(raw.body).not.toContain('incomplete credential tail');
    fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    expect((await request('/api/runs/log_fixture/log/page')).statusCode).toBe(413);
  });

  it('reports failed Tailscale teardown and retains the fixture plan for retry without ingress', async () => {
    const a = new TailscaleAdapter({ envPath: '', exec: async () => ({ code: 7, stdout: '', stderr: 'fixture failure', timedOut: false }) });
    await expect(a.stop(a.plan({ port: 7317, httpsPort: 8443 }))).rejects.toThrow(/teardown failed/);
    const { d, fixture } = await setup();
    fixture.stop = async () => { throw new Error('fixture teardown failure'); };
    await d.remote.stop();
    expect(d.remote.hosts()).toEqual([]);
    expect(d.remote.status().tunnel.state).toBe('error');
    expect(() => d.remote.requestLaunch()).toThrow(/teardown/);
    fixture.stop = async () => { fixture.running = false; };
    await d.remote.stop();
    expect(d.remote.status().tunnel.state).toBe('down');
    expect(d.remote.requestLaunch().decision.kind).toBe('remote');
  });
});

describe('exact phone release action fixture', () => {
  it('executes only the confirmed bound step/probe once through injected local checks', async () => {
    const { d, request, sent } = await setup();
    d.config.project.checks = { action: 'fixture-action', verify: 'fixture-probe' };
    const sha = git(d.config.project.repo, 'rev-parse', 'HEAD');
    const item = d.createIssue({ title: 'Fixture release', description: '' });
    d.commit([{ type: 'merge.completed', workItemId: item.id, data: { merge: { id: 'phone_merge_fixture', workItemId: item.id, decisionId: 'fixture_dec', reviewId: 'fixture_review', sourceBranch: 'feature', sourceSha: sha, target: 'integration', targetShaBefore: sha, mergeSha: sha, method: 'ref', at: d.nowIso(), postChecks: { status: 'passed', evidenceIds: [], at: d.nowIso() } } } }]);
    const plan = d.releasePlans.create({ name: 'Phone local fixture', workItemId: item.id });
    const step = plan.steps[0];
    d.releasePlans.update(plan.id, { steps: [{ id: step.id, kind: 'custom', title: 'Injected command', owner: step.owner, command: 'check:action', check: 'check:verify', rollback: 'check:action', target: 'local', environment: step.environment }] });
    const calls: string[] = [];
    d.releasePlans.projectCommand = async (command, currentSha, verification) => {
      calls.push(command);
      expect(d.state.releases[plan.id].steps[0].status).toBe('running');
      return { status: 'passed', exitCode: 0, detail: 'injected fixture check', sha: currentSha, runtimeKey: step.environment, proof: verification ? { ...verification, ok: true, source: 'probe', detail: 'fixture observation', observedAt: d.nowIso() } : undefined };
    };
    const dec = d.releasePlans.requestStep(plan.id, step.id).decision;
    expect((await request(`/api/decisions/${dec.id}/answer`, { answer: 'approve' })).statusCode).toBe(428);
    expect(calls).toEqual([]);
    const prep = (await request(`/api/decisions/${dec.id}/prepare`, { answer: 'approve' })).json();
    const response = await request(`/api/decisions/${dec.id}/answer`, { answer: 'approve', nonce: prep.nonce });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().release).toMatchObject({ executed: true });
    expect(calls).toEqual(['fixture-action', 'fixture-probe']);
    expect(d.state.decisions[dec.id]).toMatchObject({ channel: 'phone', answer: 'approve', answeredBy: { type: 'human' } });
    expect((await request(`/api/decisions/${dec.id}/answer`, { answer: 'approve', nonce: prep.nonce })).statusCode).toBe(409);
    expect(calls).toHaveLength(2);
    expect(sent).toEqual([]);
    expect(d.egress.log).toEqual([]);
  });
});
