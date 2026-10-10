// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Phone access over a loopback fixture tunnel: disabled by default, per-launch Decision, single-use
// pairing, scoped sessions, CSRF/Origin, brute-force bound, revocation, isolation and audit.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { assertPrivatePlan, FixtureAdapter, TailscaleAdapter } from '../src/phone/tunnel.ts';
import { ProjectDocker } from '../src/docker.ts';
import { makeConfig, makeRepo, startDaemon, tmpDir, type Harness } from './helpers.ts';

const HOST = 'phone.fixture.test';
const ORIGIN = `http://${HOST}`;
let harnesses: Harness[] = [];
afterEach(async () => { for (const h of harnesses) await h.close(); harnesses = []; });

interface Resp { status: number; body: any; headers: http.IncomingHttpHeaders }
function raw(url: string, path: string, o: { method?: string; host?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Resp> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = http.request({ host: u.hostname, port: u.port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${u.port}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...o.headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => { let body: any = t; try { body = t ? JSON.parse(t) : {}; } catch { /* text */ } resolve({ status: res.statusCode!, body, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function setup(over: { start?: boolean } = {}) {
  const h = await startDaemon(makeConfig(makeRepo()), { probe: false, clock: () => new Date(clock.t) });
  harnesses.push(h);
  const fixture = new FixtureAdapter(HOST);
  h.d.remote.useAdapter(fixture);
  const token = fs.readFileSync(path.join(h.d.paths.secrets, 'install-token'), 'utf8').trim();
  const local = (p: string, method = 'GET', body?: unknown) => raw(h.url, p, { method, body, headers: { authorization: `Bearer ${token}` } });
  const remote = (p: string, o: { method?: string; cookie?: string; csrf?: string; origin?: string | null; body?: unknown; headers?: Record<string, string> } = {}) =>
    raw(h.url, p, { method: o.method, host: HOST, body: o.body, headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.csrf ? { 'x-acc-csrf': o.csrf } : {}), ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), ...(o.headers ?? {}) } });
  const launch = async () => {
    await local('/api/remote/config', 'POST', { enabled: true, adapter: 'fixture' });
    const { decision } = (await local('/api/remote/launch', 'POST')).body;
    const prep = (await local(`/api/decisions/${decision.id}/prepare`, 'POST', { answer: 'approve' })).body;
    expect(prep.confirm).toBe(true);
    const res = await local(`/api/decisions/${decision.id}/answer`, 'POST', { answer: 'approve', nonce: prep.nonce });
    return { decision, res };
  };
  const pair = async (scopes?: string[]) => {
    if (scopes) await local('/api/remote/config', 'POST', { scopes });
    const p = (await local('/api/remote/pairings', 'POST')).body;
    const token = new URL(p.url).hash.slice(3);
    // a pairing request without the tunnel's exact Origin is refused and does not burn the token
    expect((await remote('/api/remote/pair', { method: 'POST', origin: null, body: { token } })).status).toBe(403);
    expect((await remote('/api/remote/pair', { method: 'POST', origin: 'https://evil.example', body: { token } })).status).toBe(403);
    const r = await remote('/api/remote/pair', { method: 'POST', body: { token } });
    const m = /^([^=]+)=([^;]+)/.exec(String(r.headers['set-cookie']));
    return { pairing: p, token, res: r, cookie: m ? `${m[1]}=${m[2]}` : '', csrf: r.body.csrf as string };
  };
  return { h, d: h.d, fixture, local, remote, launch, pair };
}
const clock = { t: Date.parse('2026-01-01T12:00:00Z') };

describe('remote access', () => {
  it('is disabled by default, shows an exact dry run, and starts nothing without a confirmed Decision', async () => {
    clock.t = Date.parse('2026-01-01T12:00:00Z');
    const { local, remote, fixture, d } = await setup();
    const st = (await local('/api/remote/status')).body;
    expect(st.config.enabled).toBe(false);
    expect(st.tunnel.state).toBe('down');
    expect(st.reachability.state).toBe('not_running');
    expect((await remote('/api/state')).status).toBe(421); // unknown Host until a tunnel is live
    expect((await local('/api/remote/launch', 'POST')).status).toBe(409);
    const review = (await local('/api/remote/review')).body;
    expect(review.dryRun).toBe(true);
    expect(review.executed).toBe(false);
    expect(review.blockedBy.join(' ')).toMatch(/disabled/);
    expect(review.plan.publicInternet).toBe(false);
    await local('/api/remote/config', 'POST', { enabled: true, adapter: 'fixture' });
    const { decision } = (await local('/api/remote/launch', 'POST')).body;
    expect(decision.kind).toBe('remote');
    expect(decision.confirmOptions).toEqual(['approve']);
    expect(fixture.running).toBe(false);
    // The irreversible-style second confirmation is required.
    expect((await local(`/api/decisions/${decision.id}/answer`, 'POST', { answer: 'approve' })).status).toBe(428);
    expect(fixture.running).toBe(false);
    const prep = (await local(`/api/decisions/${decision.id}/prepare`, 'POST', { answer: 'approve' })).body;
    const ok = await local(`/api/decisions/${decision.id}/answer`, 'POST', { answer: 'approve', nonce: prep.nonce });
    expect(ok.status).toBe(200);
    expect(fixture.running).toBe(true);
    expect(d.remote.status().tunnel.state).toBe('up');
    expect((await local(`/api/decisions/${decision.id}/answer`, 'POST', { answer: 'approve', nonce: prep.nonce })).status).toBe(409);
    const s2 = (await local('/api/remote/status')).body;
    expect(s2.reachability.state).toBe('unverified'); // up is not the same as reachable
    expect(s2.localDaemon.ready).toBe(true);
  });

  it('pairs once, scopes the session, requires CSRF and Origin, and refuses the Mac credentials', async () => {
    const { local, remote, launch, pair, d } = await setup();
    await launch();
    const p = await pair();
    expect(p.res.status).toBe(200);
    expect(p.cookie).toContain('acc_remote_');
    expect(String(p.res.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect(p.pairing.url).toContain('/pair#t='); // fragment, never a query string
    expect(p.pairing.path).not.toContain('?');
    // single use
    expect((await remote('/api/remote/pair', { method: 'POST', body: { token: p.token } })).status).toBe(401);
    // reads work with the cookie, not without; the Mac's bearer token is not accepted over the tunnel
    expect((await remote('/api/state', { cookie: p.cookie })).status).toBe(200);
    expect((await remote('/api/state')).status).toBe(401);
    const bearer = fs.readFileSync(path.join(d.paths.secrets, 'install-token'), 'utf8').trim();
    expect((await remote('/api/state', { headers: { authorization: `Bearer ${bearer}` } })).status).toBe(401);
    expect((await remote('/api/state', { cookie: p.cookie, origin: 'https://evil.example' })).status).toBe(403);
    // mutations: CSRF + Origin + engaged:true only
    const kill = (o: object) => remote('/api/kill-switch', { method: 'POST', cookie: p.cookie, body: { engaged: true }, ...o });
    expect((await kill({ csrf: undefined })).status).toBe(403);
    expect((await kill({ csrf: 'wrong' })).status).toBe(403);
    expect((await kill({ csrf: p.csrf, origin: 'https://evil.example' })).status).toBe(403);
    expect((await kill({ csrf: p.csrf, origin: null })).status).toBe(403);
    expect((await remote('/api/kill-switch', { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { engaged: false } })).status).toBe(403);
    expect(d.state.killSwitch.engaged).toBe(false);
    const fin = await kill({ csrf: p.csrf });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(d.state.killSwitch.engaged).toBe(true);
    // routes outside the scope list are refused: source, connections, admin, benchmark, sign-in
    for (const [m, route] of [['GET', '/api/assignments/x/diff'], ['GET', '/api/connections'], ['GET', '/api/remote/status'], ['POST', '/api/remote/pairings'], ['GET', '/api/benchmark/context'], ['GET', '/api/context']] as const) {
      expect((await remote(route, { method: m, cookie: p.cookie, csrf: p.csrf })).status, route).toBe(403);
    }
    expect((await remote('/auth?code=x')).status).toBe(403);
    const session = (await remote('/api/remote/session', { cookie: p.cookie })).body;
    expect(session.scopes).toContain('read');
    expect(session.csrf).toBe(p.csrf);
    expect((await local('/api/state')).status).toBe(200); // local access is unaffected
  });

  it('narrowing scopes applies at once; tunnel Decisions need their separate scope', async () => {
    const { local, remote, launch, pair, d } = await setup();
    await launch();
    const p = await pair();
    const q = d.decisions.create({ question: 'Keep it?', options: ['yes', 'no'], kind: 'question' });
    const remoteDec = d.decisions.create({ question: 'Open the tunnel?', options: ['approve', 'deny'], kind: 'remote' });
    expect((await remote(`/api/decisions/${remoteDec.id}/prepare`, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { answer: 'approve' } })).status).toBe(403);
    const ans = await remote(`/api/decisions/${q.id}/answer`, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { answer: 'yes', channel: 'web' } });
    expect(ans.status).toBe(200);
    expect(d.state.decisions[q.id].channel).toBe('phone'); // channel is set by the server, not the client
    await local('/api/remote/config', 'POST', { scopes: ['read'] });
    const q2 = d.decisions.create({ question: 'Again?', options: ['yes', 'no'] });
    expect((await remote(`/api/decisions/${q2.id}/answer`, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { answer: 'yes' } })).status).toBe(403);
    expect((await remote('/api/runs/none/events', { cookie: p.cookie })).status).toBe(403);
    expect((await remote('/api/kill-switch', { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { engaged: true } })).status).toBe(403);
    expect((await remote('/api/state', { cookie: p.cookie })).status).toBe(200);
  });

  it('grants project action Decisions across kinds while preserving second confirmation and excluding management', async () => {
    const { remote, launch, pair, d } = await setup();
    await launch();
    const p = await pair(['read', 'decisions']);
    for (const kind of ['question', 'merge', 'docker', 'environment', 'release', 'cost', 'settings', 'connector']) {
      const dec = d.decisions.create({ kind: kind as never, question: `Exact ${kind}?`, options: ['approve', 'deny'], irreversible: true, confirmOptions: ['approve'] });
      const prep = await remote(`/api/decisions/${dec.id}/prepare`, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { answer: 'approve' } });
      expect(prep.status, kind).toBe(200);
      expect(prep.body).toMatchObject({ confirm: true, nonce: expect.any(String) });
      const unconfirmed = await remote(`/api/decisions/${dec.id}/answer`, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { answer: 'approve' } });
      expect(unconfirmed.status, kind).toBe(428);
    }
    for (const path of ['/api/config', '/api/remote/config', '/api/connectors', '/api/docker', '/api/environment', '/api/context']) {
      expect((await remote(path, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: {} })).status, path).toBe(403);
    }
    const endpoint = d.notifications.requestEndpointActivation.bind(d.notifications);
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: 'https://example.com/private-hook' } } });
    const review = endpoint('chat');
    expect((await remote(`/api/decisions/${review.id}/history`, { cookie: p.cookie })).status).toBe(403);
    expect((await remote(`/api/decisions/${review.id}/prepare`, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { answer: 'approve' } })).status).toBe(403);
    const sent: string[] = [];
    d.notifications.useAdapter({ id: 'chat', deliver: async payload => { sent.push(payload.id); return { ok: true, detail: 'test adapter accepted' }; } });
    const n = await d.notifications.sendTest();
    const id = d.notifications.status().pendingDeliveries.find(x => x.notificationId === n.id)!.decisionId;
    const prep = await remote(`/api/decisions/${id}/prepare`, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { answer: 'approve' } });
    expect(prep.status).toBe(200);
    expect(sent).toEqual([]);
    const response = await remote(`/api/decisions/${id}/answer`, { method: 'POST', cookie: p.cookie, csrf: p.csrf, body: { answer: 'approve', nonce: prep.body.nonce } });
    expect(response.status).toBe(200);
    expect(sent).toEqual([n.id]);
    expect(d.state.decisions[id].channel).toBe('phone');
    expect(response.body.notification.config).toBeUndefined();
  });

  it('projects status without executable config, credential-bearing URLs or ungranted Decisions', async () => {
    const { remote, launch, pair, d } = await setup();
    await launch();
    const p = await pair(['read']);
    const dec = d.decisions.create({ kind: 'remote', question: 'Private tunnel settings', options: ['approve', 'deny'] });
    d.state.agents.claude.config.instructions = 'arbitrary-credential-value';
    d.state.agents.claude.config.binary = '/private/secret-binary';
    const response = await remote('/api/state', { cookie: p.cookie });
    expect(response.status).toBe(200);
    expect(response.body.state.decisions[dec.id]).toBeUndefined();
    expect(response.body.state.project.repo).toBe('');
    expect(response.body.state.connectors).toEqual({});
    expect(JSON.stringify(response.body)).not.toMatch(/arbitrary-credential-value|secret-binary/);
  });

  it('bounds pairing attempts, expires links, enforces the session cap, and revokes sessions and sockets', async () => {
    clock.t = Date.parse('2026-01-01T12:00:00Z');
    const { local, remote, launch, h } = await setup();
    await launch();
    await local('/api/remote/config', 'POST', { maxSessions: 1 });
    const expired = (await local('/api/remote/pairings', 'POST')).body;
    clock.t += 301_000;
    expect((await remote('/api/remote/pair', { method: 'POST', body: { token: new URL(expired.url).hash.slice(3) } })).status).toBe(401);
    // the expired link above was failure 1 of 5
    for (let i = 0; i < 3; i++) expect((await remote('/api/remote/pair', { method: 'POST', body: { token: 'x'.repeat(48) } })).status).toBe(401);
    expect((await remote('/api/remote/pair', { method: 'POST', body: { token: 'x'.repeat(48) } })).status).toBe(429);
    expect((await remote('/api/remote/pair', { method: 'POST', body: { token: 'y'.repeat(48) } })).status).toBe(429);
    const fresh = (await local('/api/remote/pairings', 'POST')).body; // the owner issuing a link clears the lock
    const good = await remote('/api/remote/pair', { method: 'POST', body: { token: new URL(fresh.url).hash.slice(3) } });
    expect(good.status).toBe(200);
    const cookie = /^([^=]+=[^;]+)/.exec(String(good.headers['set-cookie']))![1];
    expect((await local('/api/remote/pairings', 'POST')).status).toBe(409); // only one phone allowed
    // a live socket is refused with a wrong Origin, accepted with the right one, closed on revoke
    const wsUrl = `ws://127.0.0.1:${new URL(h.url).port}/ws`;
    const bad = new WebSocket(wsUrl, { headers: { host: HOST, origin: 'https://evil.example', cookie } });
    await new Promise<void>((res) => { bad.on('unexpected-response', (_q, r) => { expect(r.statusCode).toBe(403); res(); }); bad.on('error', () => res()); });
    const ws = new WebSocket(wsUrl, { headers: { host: HOST, origin: ORIGIN, cookie } });
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
    const sess = (await local('/api/remote/status')).body.sessions.find((s: any) => !s.revokedAt);
    expect((await local(`/api/remote/sessions/${sess.id}`, 'DELETE')).status).toBe(200);
    expect(await closed).toBe(4001);
    expect((await remote('/api/state', { cookie })).status).toBe(401);
  });

  it('proves local native identity only after authentication and refuses it to a paired phone', async () => {
    const { local, remote, launch, pair, h } = await setup();
    expect((await raw(h.url, '/api/auth/identity')).status).toBe(401);
    const identity = await local('/api/auth/identity');
    expect(identity.status).toBe(200);
    expect(identity.body).toEqual({ mode: 'local', project: 'sample' });
    await launch();
    const p = await pair(['read']);
    expect((await remote('/api/auth/identity', { cookie: p.cookie })).status).toBe(403);
  });

  it('the legacy container route accepts an exact prepared nonce once without bypassing confirmation', async () => {
    const { d, local } = await setup();
    const calls: string[][] = [], id = 'abcdef123456';
    Object.defineProperty(d, 'docker', { value: new ProjectDocker(d, async args => {
      calls.push(args);
      return { code: 0, stderr: '', stdout: args[0] === 'ps' ? JSON.stringify({ ID: id, Names: 'fixture-db', State: 'running', Status: 'up', Image: 'fixture' }) : '', timedOut: false };
    }) });
    const request = await local(`/api/docker/${id}/request`, 'POST', { action: 'restart' });
    expect(request.status).toBe(200);
    const decisionId = request.body.decision.id;
    expect((await local(`/api/docker/decisions/${decisionId}/resolve`, 'POST', { answer: 'approve' })).status).toBe(428);
    expect(calls.some(x => x[0] === 'restart')).toBe(false);
    const prep = await local(`/api/decisions/${decisionId}/prepare`, 'POST', { answer: 'approve' });
    expect(prep.body.confirm).toBe(true);
    expect((await local(`/api/docker/decisions/${decisionId}/resolve`, 'POST', { answer: 'approve', nonce: prep.body.nonce })).status).toBe(200);
    expect(calls.filter(x => x[0] === 'restart')).toEqual([['restart', id]]);
    expect((await local(`/api/docker/decisions/${decisionId}/resolve`, 'POST', { answer: 'approve', nonce: prep.body.nonce })).status).toBe(409);
  });

  it.each(['live', 'command'])('checks socket expiry immediately before %s, without waiting for the periodic tick', async trigger => {
    clock.t = Date.parse('2026-01-01T12:00:00Z');
    const { d, h, local, launch, pair } = await setup();
    await launch();
    await local('/api/remote/config', 'POST', { idleTimeoutMinutes: 5 });
    const p = await pair(['read', 'transcript']);
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.url).port}/ws`, { headers: { host: HOST, origin: ORIGIN, cookie: p.cookie } });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const messages: any[] = [];
    ws.on('message', raw => messages.push(JSON.parse(String(raw))));
    const snapshot = new Promise<void>(resolve => ws.once('message', () => resolve()));
    ws.send(JSON.stringify({ type: 'hello', since: 0 }));
    await snapshot;
    const closed = new Promise<number>(resolve => ws.once('close', resolve));
    clock.t += 300_001;
    if (trigger === 'live') d.bus.emit('live', { runId: 'fixture', agentId: 'codex', role: 'assistant', text: 'expired-session-private-text', at: new Date(clock.t).toISOString() });
    else ws.send(JSON.stringify({ type: 'subscribe_run', runId: 'fixture', since: 0 }));
    expect(await closed).toBe(4001);
    expect(JSON.stringify(messages)).not.toContain('expired-session-private-text');
    expect(messages.some(m => m.type === 'run_events')).toBe(false);
  });

  it('keeps projects isolated, honours idle timeout, and reports tunnel loss honestly', async () => {
    clock.t = Date.parse('2026-01-01T12:00:00Z');
    const a = await setup();
    await a.launch();
    const p = await a.pair();
    const b = await setup();
    await b.launch();
    expect((await b.remote('/api/state', { cookie: p.cookie })).status).toBe(401); // another project's daemon does not know this phone
    const rec = (a.d.remote as any).sessions[Object.keys((a.d.remote as any).sessions)[0]];
    rec.project = 'f'.repeat(64);
    expect((await a.remote('/api/state', { cookie: p.cookie })).status).toBe(403);
    rec.project = (a.d.remote as any).project;
    expect((await a.remote('/api/state', { cookie: p.cookie })).status).toBe(200);
    clock.t += 3 * 3_600_000; // beyond the 2 h idle timeout
    expect((await a.remote('/api/state', { cookie: p.cookie })).status).toBe(401);
    // tunnel dies: reconnecting, then down; the Host is no longer accepted and nothing claims reachability
    a.fixture.running = false;
    await a.d.remote.tick();
    expect(a.d.remote.status().tunnel.state).toBe('reconnecting');
    await a.d.remote.tick(); await a.d.remote.tick();
    expect(a.d.remote.status().tunnel.state).toBe('down');
    expect((await a.remote('/api/state', { cookie: p.cookie })).status).toBe(421);
    expect(a.d.remote.status().reachability.state).toBe('not_running');
  });

  it('records an audit trail without secrets, and disabling revokes everything', async () => {
    clock.t = Date.parse('2026-01-01T12:00:00Z');
    const { local, remote, launch, pair, d, fixture } = await setup();
    await launch();
    const p = await pair();
    await remote('/api/connections', { cookie: p.cookie });
    const audit = (await local('/api/remote/audit')).body.events as { type: string }[];
    const types = new Set(audit.map((e) => e.type));
    for (const t of ['remote.config_changed', 'remote.tunnel_requested', 'remote.tunnel_state', 'remote.pairing_issued', 'remote.paired', 'remote.request_denied']) expect(types.has(t), t).toBe(true);
    const dump = JSON.stringify(audit) + JSON.stringify(d.store.list({ limit: 10_000 }));
    expect(dump).not.toContain(p.token);
    expect(dump).not.toContain(p.cookie.split('=')[1]);
    await local('/api/remote/config', 'POST', { enabled: false });
    expect(fixture.running).toBe(false);
    expect((await remote('/api/state', { cookie: p.cookie })).status).toBe(421);
    expect(d.remote.activeSessions()).toHaveLength(0);
  });
});

describe('tunnel adapters', () => {
  it('Tailscale: detects without running, plans privately, executes only on approval, and refuses public exposure', async () => {
    const bin = tmpDir('ts-bin');
    fs.writeFileSync(path.join(bin, 'tailscale'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const calls: string[][] = [];
    const exec = async (_c: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail1234.ts.net.' } }), stderr: '', timedOut: false };
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    const adapter = new TailscaleAdapter({ exec, envPath: bin });
    expect(adapter.detect().installed).toBe(true);
    const plan = adapter.plan({ port: 7317, httpsPort: 8443 });
    expect(calls).toEqual([]); // detect and plan never run the CLI
    expect(plan.start[0].args).toEqual(['serve', '--bg', '--https=8443', 'http://127.0.0.1:7317']);
    expect(plan.publicInternet).toBe(false);
    expect(JSON.stringify(plan)).not.toMatch(/funnel/i);
    expect(() => assertPrivatePlan({ port: 7317, start: [{ command: 'tailscale', args: ['funnel', '7317'] }], teardown: [] })).toThrow(/Public/);
    expect(() => assertPrivatePlan({ port: 7317, start: [{ command: 'tailscale', args: ['serve', 'http://10.0.0.5:7317'] }], teardown: [] })).toThrow(/loopback/);
    const { hostname } = await adapter.start(plan);
    expect(hostname).toBe('my-mac.tail1234.ts.net:8443');
    expect(calls.map((c) => c[0])).toEqual(['status', 'serve']);
    await adapter.stop(plan);
    expect(calls.at(-1)).toEqual(['serve', '--https=8443', 'off']);
  });

  it('a daemon never runs the adapter until the Decision is confirmed, and refuses the test double for real use', async () => {
    const h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    harnesses.push(h);
    const bin = tmpDir('ts-bin2');
    fs.writeFileSync(path.join(bin, 'tailscale'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const calls: string[][] = [];
    h.d.remote.useAdapter(new TailscaleAdapter({ envPath: bin, exec: async (_c, args) => { calls.push([...args]); return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.t.ts.net.' } }), stderr: '', timedOut: false }; } }));
    await expect(h.d.remote.configure({ adapter: 'fixture' })).rejects.toThrow(/test double/);
    await h.d.remote.configure({ enabled: true });
    const { decision } = h.d.remote.requestLaunch();
    expect(calls).toEqual([]);
    const prep = h.d.decisions.prepare(decision.id, 'approve');
    await h.d.decisions.respond(decision.id, 'approve', { nonce: prep.nonce });
    expect(calls.map((c) => c[0])).toEqual(['status', 'serve']);
    expect(h.d.remote.hosts()).toEqual(['mac.t.ts.net:8443']);
    expect(h.d.remote.origin()).toBe('https://mac.t.ts.net:8443');
    expect(h.d.remote.cookieName().startsWith('__Host-acc_remote_')).toBe(true);
  });
});
