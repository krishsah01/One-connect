// SPDX-License-Identifier: Apache-2.0
// Node24 native type stripping; no transpiler, socket, provider, Keychain or live transport.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import child from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';

assert.match(process.version, /^v24\./, 'Use the already installed Node24 runtime');
const guard = `
import child from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { throw new Error('External IO forbidden in phone import fixture'); };
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[k] = forbidden;
net.Server.prototype.listen = net.Socket.prototype.connect = forbidden;
http.request = http.get = https.request = https.get = forbidden;
globalThis.fetch = forbidden;
syncBuiltinESMExports();
await import(process.argv[1]);
console.log('native phone import ok');
`;
for (const file of ['gate', 'remote', 'projection', 'routes', 'notifications', 'tunnel', 'logs']) test(`isolated native import: phone/${file}.ts`, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', guard, new URL(`../src/phone/${file}.ts`, import.meta.url).href], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'native phone import ok');
});
test('isolated native import: core phone policy', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', guard, new URL('../../core/src/phone.ts', import.meta.url).href], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('native Node24 phone gate, projections, exact notification and revocation with injected HTTP/fetch', async () => {
  // All implementation imports in this test are .ts imports resolved by Node itself.
  const { default: Fastify } = await import('fastify');
  const { parseConfig } = await import('../../core/src/config.ts');
  const { Daemon, CommandError } = await import('../src/daemon.ts');
  const { remoteGate } = await import('../src/phone/gate.ts');
  const { registerPhoneHooks, registerPhoneRoutes } = await import('../src/phone/routes.ts');
  const { FixtureAdapter } = await import('../src/phone/tunnel.ts');
  const saved = { fetch: globalThis.fetch, listen: net.Server.prototype.listen, connect: net.Socket.prototype.connect, request: http.request, get: http.get, tlsRequest: https.request, tlsGet: https.get };
  const savedChild = Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(k => [k, child[k]]));
  const forbidden = () => { throw new Error('Live IO forbidden in native phone fixture'); };
  net.Server.prototype.listen = net.Socket.prototype.connect = forbidden;
  http.request = http.get = https.request = https.get = globalThis.fetch = forbidden;
  for (const k of Object.keys(savedChild)) child[k] = forbidden;
  syncBuiltinESMExports();
  const root = fs.mkdtempSync(path.join(process.cwd(), '.phone-native-fixture-'));
  let daemon, app;
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    let at = Date.parse('2026-10-07T12:00:00Z');
    const sent = [];
    const config = parseConfig({ project: { name: 'native phone fixture', repo }, tracker: { type: 'local' }, graphify: { enabled: false }, agents: [{ id: 'fixture', name: 'Fixture', role: 'engineer', adapter: 'relay' }] });
    daemon = new Daemon({ config, dataDir: path.join(root, 'data'), allowTempDataDir: true, probe: false, baseEnv: {}, clock: () => new Date(at), fetch: async (url, init) => { sent.push({ url, body: init.body, redirect: init.redirect }); return new Response('', { status: 202 }); } });
    const d = daemon;
    d.syncConfig(); // No daemon start, timers, runtime probes or git repository needed.
    d.remote.useAdapter(new FixtureAdapter('native-phone.fixture.test'));
    await d.remote.configure({ enabled: true, adapter: 'fixture', scopes: ['read', 'transcript', 'decisions'] });
    const launch = d.remote.requestLaunch().decision, confirmation = d.decisions.prepare(launch.id, 'approve');
    await d.decisions.respond(launch.id, 'approve', { nonce: confirmation.nonce });
    const link = d.remote.issuePairing(), paired = d.remote.pair(link.token);
    assert.throws(() => d.remote.pair(link.token), /already used/);
    app = Fastify();
    app.setErrorHandler((e, req, reply) => reply.code(e instanceof CommandError ? e.status : 500).send({ error: e.message }));
    app.addHook('onRequest', (req, reply) => remoteGate(d, req, reply));
    registerPhoneHooks(app, d); registerPhoneRoutes(app, d);
    app.get('/api/state', async () => ({ state: d.state }));
    app.post('/api/decisions/:id/prepare', async req => d.decisions.prepare(req.params.id, req.body.answer));
    app.post('/api/decisions/:id/answer', async req => d.decisions.respond(req.params.id, req.body.answer, { nonce: req.body.nonce, channel: req.body.channel }));
    app.get('/api/runs/:id/events', async req => ({ events: d.store.list({ runId: req.params.id, limit: 1000 }) }));
    const headers = { host: 'native-phone.fixture.test', origin: 'http://native-phone.fixture.test', cookie: `${paired.cookieName}=${paired.cookie}`, 'x-acc-csrf': paired.csrf };
    const request = (url, payload, overrides = {}) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { ...headers, ...overrides }, ...(payload === undefined ? {} : { payload }) });
    const q = d.decisions.create({ question: 'Native phone question?', options: ['yes', 'no'] });
    assert.equal((await request(`/api/decisions/${q.id}/answer`, { answer: 'yes' }, { 'x-acc-csrf': 'wrong' })).statusCode, 403);
    assert.equal((await request('/api/state', undefined, { cookie: '' })).statusCode, 401);
    assert.equal((await request('/api/config', {})).statusCode, 403);
    const answer = await request(`/api/decisions/${q.id}/answer`, { answer: 'yes', channel: 'web' });
    assert.equal(answer.statusCode, 200, answer.body);
    assert.equal(d.state.decisions[q.id].channel, 'phone');
    const privateDecision = d.decisions.create({ kind: 'remote', question: 'private tunnel fixture', options: ['approve', 'deny'] });
    const state = (await request('/api/state')).json().state;
    assert.equal(state.decisions[privateDecision.id], undefined);
    assert.equal(state.project.repo, '');
    d.commit([{ type: 't.message', runId: 'r', data: { role: 'assistant', text: 'native transcript fixture' } }, { type: 'decision.recommended', runId: 'r', data: { decisionId: privateDecision.id, recommendation: 'deny', rationale: 'hidden control fixture' } }]);
    const history = (await request('/api/runs/r/events')).json().events;
    assert.deepEqual(history.map(e => e.type), ['t.message', 'phone.cursor']);
    const projected = d.remote.projectMessages({ type: 'run_events', runId: 'r', events: d.store.list({ runId: 'r' }), more: false }, ['read', 'transcript']);
    assert.deepEqual(projected[0].events, history);
    assert.deepEqual(d.remote.projectMessages({ type: 'live', text: 'ungranted' }, ['read']), []);
    assert.equal(d.remote.projectMessages({ type: 'live', runId: 'r', role: 'assistant', text: 'live native fixture', config: 'private' }, ['read', 'transcript'])[0].config, undefined);
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: 'https://native-notify.fixture.test/private-hook' } } });
    const n = await d.notifications.sendTest(), id = d.notifications.status().pendingDeliveries.find(v => v.notificationId === n.id).decisionId;
    assert.equal(sent.length, 0);
    assert.equal((await request(`/api/decisions/${id}/answer`, { answer: 'approve' })).statusCode, 428);
    const prepared = (await request(`/api/decisions/${id}/prepare`, { answer: 'approve' })).json();
    const delivered = await request(`/api/decisions/${id}/answer`, { answer: 'approve', nonce: prepared.nonce });
    assert.equal(delivered.statusCode, 200, delivered.body);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].redirect, 'error');
    assert.equal(JSON.parse(sent[0].body).id, n.id);
    assert.ok(!d.egress.allowed.includes('native-notify.fixture.test'));
    assert.equal((await request(`/api/decisions/${id}/answer`, { answer: 'approve', nonce: prepared.nonce })).statusCode, 409);
    assert.deepEqual(delivered.json().notification, { recorded: true });
    assert.ok(d.remote.socketAuthorized(paired.session.id, paired.session.scopes));
    const closed = []; d.bus.on('remote.revoked', id => closed.push(id));
    at += 2 * 3_600_000;
    assert.equal(d.remote.socketAuthorized(paired.session.id, paired.session.scopes), false);
    assert.deepEqual(closed, [paired.session.id]);
    assert.equal((await request('/api/state')).statusCode, 401);
  } finally {
    await app?.close();
    await daemon?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
    globalThis.fetch = saved.fetch;
    net.Server.prototype.listen = saved.listen; net.Socket.prototype.connect = saved.connect;
    http.request = saved.request; http.get = saved.get; https.request = saved.tlsRequest; https.get = saved.tlsGet;
    Object.assign(child, savedChild); syncBuiltinESMExports();
  }
});
