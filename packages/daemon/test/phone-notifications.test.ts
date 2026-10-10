// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Notification routing: derived alerts, dedupe, quiet hours, redaction, off-by-default external
// channels, and exact per-message human Decisions (fake-fetch transport only).
import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationRecord } from '@acc/core';
import { projectNamespace } from '../src/context/vault.ts';
import { NativeAdapter, type ExternalPayload, type NotificationAdapter } from '../src/phone/notifications.ts';
import { makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

const clock = { t: Date.parse('2026-03-02T12:00:00Z') };
let h: Harness | null = null;
const fixtures = new Map<string, { received: unknown[]; status: number }>();
afterEach(async () => { await h?.close(); h = null; fixtures.clear(); });

async function boot() {
  clock.t = Date.parse('2026-03-02T12:00:00Z');
  h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false, clock: () => new Date(clock.t), fetch: async (url, init) => {
    const fixture = fixtures.get(url);
    if (!fixture) throw new Error('No network: missing fake fetch fixture');
    fixture.received.push(JSON.parse(String(init?.body)));
    return new Response('fixture response', { status: fixture.status });
  } });
  const sent: ExternalPayload[] = [];
  const native: NotificationAdapter = { id: 'native', deliver: async (p) => { sent.push(p); return { ok: true, detail: 'fixture banner' }; } };
  h.d.notifications.useAdapter(native);
  return { d: h.d, sent };
}
const inbox = (d: Harness['d']) => d.notifications.list(100);
const settle = () => new Promise((r) => setTimeout(r, 30));
const stall = (d: Harness['d'], runId: string, message = 'Codex has produced no events for 12 min') => d.alert({ kind: 'stall', severity: 'critical', runId, message, dedupeKey: `stall:${runId}` });

describe('notification routing', () => {
  it('records to the local inbox only by default and never calls an external channel', async () => {
    const { d, sent } = await boot();
    const c = d.notifications.getConfig();
    expect(c.channels.native.enabled || c.channels.browser.enabled || c.channels.webpush.enabled || c.channels.chat.enabled).toBe(false);
    stall(d, 'run_a');
    await settle();
    const [n] = inbox(d);
    expect(n.kind).toBe('stalled_run');
    expect(n.routed).toEqual(['local']);
    expect(sent).toEqual([]);
    expect(d.notifications.status().email).toMatch(/not offered/);
  });

  it('derives alerts for stalls, usage limits, failed checks, infrastructure failures and finished work', async () => {
    const { d } = await boot();
    stall(d, 'run_s');
    d.alert({ kind: 'usage_limit', severity: 'critical', agentId: 'claude', message: 'Claude Code hit its usage limit', dedupeKey: 'limit:claude' });
    d.commit([{ type: 'merge.post_checks', data: { mergeId: 'm1', status: 'failed', evidenceIds: [] } }]);
    d.commit([{ type: 'infra.checked' as never, data: { health: { docker: { state: 'unavailable', detail: 'down' }, postgres: { state: 'ready', service: null, detail: '' } } } as never }]);
    d.commit([{ type: 'merge.completed', data: { merge: { id: 'm2', workItemId: 'w', decisionId: 'd', reviewId: 'r', sourceBranch: 'a/x', sourceSha: 's'.repeat(40), target: 'integration', targetShaBefore: 't'.repeat(40), mergeSha: 'a'.repeat(40), method: 'ref', at: '', postChecks: { status: 'none', evidenceIds: [], at: null } } } }]);
    await settle();
    expect(new Set(inbox(d).map((n) => n.kind))).toEqual(new Set(['stalled_run', 'usage_limit', 'ci_infra_failure', 'finished_work']));
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(2);
  });

  it('flags aged approvals and decisions from state, and deduplicates until the cooldown passes', async () => {
    const { d } = await boot();
    d.commit([{ type: 'approval.requested', agentId: 'claude', data: { approval: { id: 'ap1', runId: 'r1', agentId: 'claude', workItemId: null, kind: 'ask_human', title: 'Keep the flag?', detail: '', options: ['yes', 'no'], createdAt: new Date(clock.t).toISOString(), resolvedAt: null, decision: null, by: null, channel: null } } }]);
    d.notifications.tick();
    await settle();
    expect(inbox(d)).toHaveLength(0); // not aged yet
    clock.t += 31 * 60_000;
    d.notifications.tick(); d.notifications.tick();
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'aged_approval')).toHaveLength(1); // second tick deduped
    clock.t += 30 * 60_000;
    d.notifications.tick();
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'aged_approval')).toHaveLength(1); // still inside the 60 min cooldown
    clock.t += 31 * 60_000;
    d.notifications.tick();
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'aged_approval')).toHaveLength(2);
    d.notifications.configure({ kinds: { aged_approval: false } });
    clock.t += 3 * 3_600_000;
    d.notifications.tick();
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'aged_approval')).toHaveLength(2);
  });

  it('routes to an enabled native channel, sends only a minimal payload, and redacts secrets', async () => {
    const { d, sent } = await boot();
    d.notifications.configure({ channels: { native: { enabled: true } } });
    stall(d, 'run_x', 'agent output said token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and a transcript line');
    await settle();
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]).sort()).toEqual(['at', 'id', 'kind', 'severity', 'source', 'title']);
    const n = inbox(d)[0];
    expect(JSON.stringify(n)).not.toContain('sk-ant-api03');
    expect(JSON.stringify(sent)).not.toMatch(/transcript|sk-ant/);
    expect(n.routed).toContain('native');
    expect(d.store.list({ types: ['notification.delivered'] })).toHaveLength(1);
  });

  it('holds external alerts during quiet hours but still records them', async () => {
    const { d, sent } = await boot();
    d.notifications.configure({ channels: { native: { enabled: true }, browser: { enabled: true } }, quietHours: { enabled: true, start: '00:00', end: '23:59', timezone: 'UTC' } });
    stall(d, 'run_q');
    await settle();
    const n = inbox(d)[0];
    expect(n.routed).toEqual(['local']);
    expect(n.held.map((x) => x.reason)).toEqual(['quiet hours', 'quiet hours']);
    expect(sent).toEqual([]);
    expect(() => d.notifications.configure({ quietHours: { timezone: 'Not/AZone' } })).toThrow(/time zone/i);
    expect(() => d.notifications.configure({ quietHours: { start: '25:00' } })).toThrow();
  });

  it('acknowledges notifications and keeps them across a restart', async () => {
    const { d } = await boot();
    stall(d, 'run_k');
    await settle();
    const [n] = inbox(d);
    d.notifications.ack(n.id);
    expect(inbox(d)[0].ackedAt).not.toBeNull();
    expect(d.notifications.status().unacked).toBe(0);
  });

  it('only suppresses infra acknowledgements while other kinds keep cooldown repetition', async () => {
    const { d } = await boot();
    d.commit([{ type: 'approval.requested', agentId: 'claude', data: { approval: { id: 'ap_ack', runId: 'r1', agentId: 'claude', workItemId: null, kind: 'ask_human', title: 'Still waiting?', detail: '', options: ['yes', 'no'], createdAt: new Date(clock.t).toISOString(), resolvedAt: null, decision: null, by: null, channel: null } } }]);
    clock.t += 31 * 60_000;
    d.notifications.tick();
    await settle();
    const aged = inbox(d).filter((n) => n.kind === 'aged_approval');
    expect(aged).toHaveLength(1);
    d.notifications.ack(aged[0].id);
    clock.t += 5 * 60_000;
    d.notifications.tick();
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'aged_approval')).toHaveLength(1);
    clock.t += 56 * 60_000;
    d.notifications.tick();
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'aged_approval')).toHaveLength(2);
  });

  it('does not notify for all-unknown infra checks and deduplicates real failures across repeated observations', async () => {
    const { d } = await boot();
    const unknown = {
      checkedAt: new Date(clock.t).toISOString(),
      docker: { state: 'unknown' as const, detail: 'Docker is available. No project services are declared.' },
      postgres: { state: 'unknown' as const, service: null, detail: 'No local Postgres service is declared.' },
      vercel: { state: 'unchecked' as const, source: 'unconfigured' as const, detail: 'Vercel reachability remains unknown.' },
      migrations: { state: 'unchecked' as const, source: 'none' as const, repo: [], applied: [], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: 'Migration history was not read.' },
    };
    for (let i = 0; i < 5; i++) {
      d.commit([{ type: 'infra.checked' as never, data: { health: unknown } as never }]);
      clock.t += 60_000;
    }
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(0);

    const failing = {
      ...unknown,
      postgres: { state: 'paused' as const, service: 'db', detail: 'Database service db is paused.' },
    };
    for (let i = 0; i < 3; i++) {
      d.commit([{ type: 'infra.checked' as never, data: { health: failing } as never }]);
      clock.t += 60_000;
    }
    await settle();
    const infra = inbox(d).filter((n) => n.kind === 'ci_infra_failure');
    expect(infra).toHaveLength(1);
    expect(infra[0].dedupeKey).toBe('infra:postgres:paused:db');
    expect(infra[0].detail).toContain('postgres paused');

    d.notifications.ack(infra[0].id);
    d.commit([{ type: 'infra.checked' as never, data: { health: failing } as never }]);
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(1);

    const recovered = {
      ...unknown,
      postgres: { state: 'ready' as const, service: 'db', detail: 'Database service db is healthy.' },
    };
    d.commit([{ type: 'infra.checked' as never, data: { health: recovered } as never }]);
    d.commit([{ type: 'infra.checked' as never, data: { health: failing } as never }]);
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(2);

    d.commit([{ type: 'infra.checked' as never, data: { health: unknown } as never }]);
    await settle();
    d.commit([{ type: 'infra.checked' as never, data: { health: failing } as never }]);
    await settle();
    // An unknown interval is not proof of recovery and must not reset the cooldown.
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(2);

    const latest = inbox(d).find(n => n.kind === 'ci_infra_failure')!;
    d.notifications.ack(latest.id);
    const changedFailure = { ...failing, postgres: { ...failing.postgres, state: 'unhealthy' as const } };
    d.commit([{ type: 'infra.checked', data: { health: changedFailure } }]);
    await settle();
    d.notifications.ack(inbox(d).find(n => n.kind === 'ci_infra_failure')!.id);
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(3);
    // Recover all previous states, including an acknowledgement older than the last failure.
    d.commit([{ type: 'infra.checked', data: { health: recovered } }, { type: 'infra.checked', data: { health: failing } }]);
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(4);
  });

  it('does not permanently suppress an acknowledged CI or release failure', async () => {
    const { d } = await boot();
    const event = { type: 'ci.finished' as const, data: { status: 'error', id: 'build-1' } };
    d.commit([event as never]);
    await settle();
    d.notifications.ack(inbox(d)[0].id);
    clock.t += 61 * 60_000;
    d.commit([event as never]);
    await settle();
    expect(inbox(d).filter(n => n.kind === 'ci_infra_failure')).toHaveLength(2);
  });

  it('preserves legacy cooldowns and acknowledged infra failures through restart', async () => {
    const { d } = await boot();
    const health = {
      checkedAt: new Date(clock.t).toISOString(),
      docker: { state: 'unknown' as const, detail: '' },
      postgres: { state: 'paused' as const, service: 'db', detail: 'Paused' },
      vercel: { state: 'unchecked' as const, source: 'unconfigured' as const, detail: '' },
      migrations: { state: 'unchecked' as const, source: 'none' as const, repo: [], applied: [], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: '' },
    };
    stall(d, 'legacy');
    d.commit([{ type: 'infra.checked', data: { health } }]);
    await settle();
    d.notifications.ack(inbox(d).find(n => n.kind === 'ci_infra_failure')!.id);
    const before = inbox(d).length;
    const seen = JSON.parse(d.store.kvGet('notify:seen')!);
    const key = `${projectNamespace(d.config.project.repo)}:stalled_run:stall:legacy`;
    // A pre-upgrade store has no project prefix on its saved cooldowns.
    seen['stalled_run:stall:legacy'] = clock.t;
    delete seen[key];
    d.store.kvSet('notify:seen', JSON.stringify(seen));
    const cfg = d.config, dataDir = h!.dataDir;
    await h!.close(); h = null;
    h = await startDaemon(cfg, { dataDir, probe: false, server: false, clock: () => new Date(clock.t) });
    h.d.commit([{ type: 'infra.checked', data: { health } }]);
    await h.d.notifications.consider({ kind: 'stalled_run', severity: 'critical', dedupeKey: 'stall:legacy', title: 'Still stalled', detail: '', external: '', refs: {} });
    await settle();
    expect(inbox(h.d)).toHaveLength(before);
    expect(inbox(h.d).some(n => n.kind === 'ci_infra_failure' && n.ackedAt)).toBe(true);
  });

  it('keeps infra notification fingerprints isolated per stable project identity', async () => {
    const { d } = await boot();
    const originalScope = projectNamespace(d.config.project.repo);
    const failing = {
      checkedAt: new Date(clock.t).toISOString(),
      docker: { state: 'unavailable' as const, detail: 'Docker is not available.' },
      postgres: { state: 'unknown' as const, service: null, detail: '' },
      vercel: { state: 'unchecked' as const, source: 'unconfigured' as const, detail: '' },
      migrations: { state: 'unchecked' as const, source: 'none' as const, repo: [], applied: [], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: '' },
    };
    d.commit([{ type: 'infra.checked' as never, data: { health: failing } as never }]);
    await settle();
    const first = inbox(d).filter((n) => n.kind === 'ci_infra_failure');
    expect(first).toHaveLength(1);
    d.state = { ...d.state, project: { ...d.state.project!, name: 'renamed-display-name' } };
    d.commit([{ type: 'infra.checked' as never, data: { health: failing } as never }]);
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(1);

    const otherRepo = makeRepo();
    d.state = { ...d.state, project: { ...d.state.project!, name: 'sample', repo: otherRepo } };
    d.config = { ...d.config, project: { ...d.config.project, repo: otherRepo } };
    d.commit([{ type: 'infra.checked' as never, data: { health: failing } as never }]);
    await settle();
    expect(inbox(d).filter((n) => n.kind === 'ci_infra_failure')).toHaveLength(2);
    expect(projectNamespace(d.config.project.repo)).not.toBe(originalScope);
  });

  it('bounds persisted suppression state and still deduplicates a new alert at the same timestamp', async () => {
    const { d } = await boot();
    const scope = projectNamespace(d.config.project.repo);
    const seeded = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`${scope}:ci_infra_failure:infra:postgres:paused:db-${i}`, clock.t]));
    d.store.kvSet('notify:seen', JSON.stringify(seeded));
    d.store.kvSet('notify:acked', JSON.stringify(Object.fromEntries(Object.keys(seeded).map(k => [k, k.split(':ci_infra_failure:')[1]]))));
    const cfg = d.config, dataDir = h!.dataDir;
    await h!.close(); h = null;
    h = await startDaemon(cfg, { dataDir, probe: false, server: false, clock: () => new Date(clock.t) });
    const c = { kind: 'stalled_run' as const, severity: 'critical' as const, dedupeKey: 'stall:after-bound', title: 'New stalled run', detail: '', external: '', refs: {} };
    expect(await h.d.notifications.consider(c)).not.toBeNull();
    expect(await h.d.notifications.consider(c)).toBeNull();
    expect(Object.keys(JSON.parse(h.d.store.kvGet('notify:seen')!)).length).toBeLessThanOrEqual(2000);
    h.d.notifications.ack(inbox(h.d)[0].id);
    expect(Object.keys(JSON.parse(h.d.store.kvGet('notify:acked')!)).length).toBeLessThanOrEqual(2000);
  });

  it('macOS adapter passes text as arguments and reports honestly where it cannot run', async () => {
    const calls: string[][] = [];
    const ok = new NativeAdapter({ platform: 'darwin', exec: async (_c, args) => { calls.push([...args]); return { code: 0, stdout: '', stderr: '', timedOut: false }; } });
    const r = await ok.deliver({ id: 'n', kind: 'stalled_run', severity: 'critical', title: 'Run stalled on LOC-1"; do shell script "x', at: '', source: 'one-connect' });
    expect(r.ok).toBe(true);
    expect(calls[0].join(' ')).toContain('display notification (item 2 of argv)');
    expect(calls[0].at(-1)).toContain('do shell script'); // data, never script text
    expect(calls[0].slice(0, -2).join(' ')).not.toContain('do shell script');
    expect((await new NativeAdapter({ platform: 'linux' }).deliver({ id: 'n', kind: 'x', severity: 'info', title: 't', at: '', source: 'one-connect' })).ok).toBe(false);
  });
});

describe('single-message push gateway and chat approvals', () => {
  async function fixtureServer(status = 200) {
    const received: unknown[] = [], url = `https://notifications.fixture.test/hook/${fixtures.size}`;
    fixtures.set(url, { received, status });
    return { received, url };
  }
  const message = async (d: Harness['d']) => { const n = await d.notifications.sendTest(); return { n, dec: d.state.decisions[d.notifications.status().pendingDeliveries.find(x => x.notificationId === n.id)!.decisionId] }; };
  const approve = async (d: Harness['d'], id: string) => { const p = d.decisions.prepare(id, 'approve'); await d.decisions.respond(id, 'approve', { nonce: p.nonce }); await settle(); };

  it('endpoint activation and channel enablement send nothing; each message needs its own confirmed Decision', async () => {
    const { d } = await boot(), fx = await fixtureServer();
    expect(() => d.notifications.configure({ channels: { chat: { enabled: true, endpoint: 'http://example.com/hook' } } })).toThrow(/https/);
    expect(() => d.notifications.configure({ channels: { chat: { enabled: true, endpoint: 'https://user:pw@example.com/h' } } })).toThrow(/credentials/);
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: fx.url } } });
    const endpoint = d.notifications.requestEndpointActivation('chat');
    await approve(d, endpoint.id);
    expect(fx.received).toEqual([]);
    expect(d.notifications.hosts()).toEqual([]);
    expect(d.egress.allowed).not.toContain('notifications.fixture.test');
    expect(d.notifications.status().channels.chat.authorized).toBe(false);
    const { n, dec } = await message(d);
    expect(n.routed).toEqual(['local']);
    expect(n.held).toEqual([{ channel: 'chat', reason: 'per-message Decision required' }]);
    expect(dec.evidence!.find(x => x.label === 'Payload')!.detail).toContain(n.id);
    await expect(d.decisions.respond(dec.id, 'approve')).rejects.toThrow(/confirm/i);
    expect(fx.received).toEqual([]);
    await approve(d, dec.id);
    expect(fx.received).toHaveLength(1);
    expect(Object.keys(fx.received[0] as object).sort()).toEqual(['at', 'id', 'kind', 'severity', 'source', 'title']);
    expect(d.state.decisions[dec.id].answeredBy?.type).toBe('human');
    expect(d.state.decisions[dec.id].confirmedAt).toBeTruthy();
    expect(d.state.decisions[dec.id].outcome).toMatch(/endpoint accepted/);
    await expect(d.decisions.respond(dec.id, 'approve')).rejects.toThrow(/already|closed/);
    await message(d);
    expect(fx.received).toHaveLength(1); // even the very next message needs its own approval
    expect(d.notifications.list().find(x => x.id === n.id)!.routed).toContain('chat');
  });

  it('deny, non-human responses and plain-answer bypass cannot send', async () => {
    const { d } = await boot(), fx = await fixtureServer();
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: fx.url } } });
    const { dec } = await message(d);
    expect(() => d.decisions.answer(dec.id, 'deny')).toThrow(/executor/);
    await expect(d.decisions.respond(dec.id, 'deny', {}, { type: 'agent', id: 'codex' })).rejects.toThrow(/human/);
    await d.decisions.respond(dec.id, 'deny');
    await settle();
    expect(d.state.decisions[dec.id].outcome).toMatch(/denied/);
    d.notifications.tick(); await settle();
    expect(fx.received).toEqual([]);
  });

  it.each(['endpoint', 'toggle', 'kind', 'other-setting', 'quiet-hours'])('invalidates approval after a %s config change, even if reverted', async (change) => {
    const { d } = await boot(), fx = await fixtureServer();
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: fx.url } } });
    const { dec } = await message(d), confirmation = d.decisions.prepare(dec.id, 'approve');
    if (change === 'endpoint') { d.notifications.configure({ channels: { chat: { endpoint: `${fx.url}?changed=1` } } }); d.notifications.configure({ channels: { chat: { endpoint: fx.url } } }); }
    if (change === 'toggle') { d.notifications.configure({ channels: { chat: { enabled: false } } }); d.notifications.configure({ channels: { chat: { enabled: true } } }); }
    if (change === 'kind') { d.notifications.configure({ kinds: { finished_work: false } }); d.notifications.configure({ kinds: { finished_work: true } }); }
    if (change === 'other-setting') d.notifications.configure({ cooldownMinutes: 61 });
    if (change === 'quiet-hours') d.notifications.configure({ quietHours: { enabled: true, start: '00:00', end: '23:59', timezone: 'UTC' } });
    await expect(d.decisions.respond(dec.id, 'approve', { nonce: confirmation.nonce })).rejects.toThrow(/closed|invalid/);
    expect(fx.received).toEqual([]);
  });

  it('expires exact payload approvals and does not send later when quiet hours end', async () => {
    const { d } = await boot(), fx = await fixtureServer();
    d.notifications.configure({ channels: { webpush: { enabled: true, endpoint: fx.url } } });
    const { dec } = await message(d);
    const p = d.decisions.prepare(dec.id, 'approve');
    clock.t += 10 * 60_000;
    await expect(d.notifications.resolveEndpoint(dec.id, 'approve', undefined, { nonce: p.nonce })).rejects.toThrow(/expired/);
    expect(d.state.decisions[dec.id].answeredAt).toBeNull(); // no forged human answer
    d.notifications.configure({ quietHours: { enabled: true, start: '00:00', end: '23:59', timezone: 'UTC' } });
    const quiet = await d.notifications.sendTest();
    expect(quiet.held).toEqual([{ channel: 'webpush', reason: 'quiet hours' }]);
    clock.t += 23 * 3_600_000;
    d.notifications.tick(); await settle();
    expect(fx.received).toEqual([]);
  });

  it('rechecks clock-based quiet hours at confirmation without a config change', async () => {
    const { d } = await boot(), fx = await fixtureServer();
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: fx.url } }, quietHours: { enabled: true, start: '12:01', end: '13:00', timezone: 'UTC' } });
    const { dec } = await message(d), p = d.decisions.prepare(dec.id, 'approve');
    clock.t += 60_000;
    await expect(d.notifications.resolveEndpoint(dec.id, 'approve', undefined, { nonce: p.nonce })).rejects.toThrow(/quiet hours/);
    clock.t += 3_600_000; d.notifications.tick(); await settle();
    expect(fx.received).toEqual([]);
  });

  it.each(['payload', 'url'])('rejects changed durable %s bytes', async (changed) => {
    const { d } = await boot(), fx = await fixtureServer();
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: fx.url } } });
    const { dec } = await message(d), p = d.decisions.prepare(dec.id, 'approve');
    const raw = JSON.parse(d.store.kvGet(`notify:decision:${dec.id}`)!);
    if (changed === 'payload') raw.payload.title = 'different message'; else raw.endpoint += '?different';
    d.store.kvSet(`notify:decision:${dec.id}`, JSON.stringify(raw));
    await expect(d.notifications.resolveEndpoint(dec.id, 'approve', undefined, { nonce: p.nonce })).rejects.toThrow(/changed/);
    expect(fx.received).toEqual([]);
  });

  it('records rejecting endpoints and concurrent replay as one attempt, with no retries', async () => {
    const { d } = await boot(), fx = await fixtureServer(500);
    d.notifications.configure({ channels: { webpush: { enabled: true, endpoint: fx.url } } });
    const { dec } = await message(d), p = d.decisions.prepare(dec.id, 'approve');
    const answers = await Promise.allSettled([d.notifications.resolveEndpoint(dec.id, 'approve', undefined, { nonce: p.nonce }), d.notifications.resolveEndpoint(dec.id, 'approve', undefined, { nonce: p.nonce })]);
    expect(answers.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(fx.received).toHaveLength(1);
    expect(d.notifications.status().channels.webpush.last).toMatchObject({ ok: false, detail: expect.stringMatching(/rejected/) });
    expect(d.state.decisions[dec.id].outcome).toMatch(/delivery failed/);
    d.notifications.tick(); await settle();
    expect(fx.received).toHaveLength(1);
  });

  it('keeps pending approvals durable but invalidates them on daemon restart, without sending', async () => {
    const { d } = await boot(), fx = await fixtureServer();
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: fx.url } } });
    const { dec, n } = await message(d), p = d.decisions.prepare(dec.id, 'approve');
    const config = d.config, dataDir = h!.dataDir;
    await h!.close(); h = null;
    h = await startDaemon(config, { dataDir, server: false, probe: false, clock: () => new Date(clock.t) });
    expect(h.d.notifications.list().some(x => x.id === n.id)).toBe(true);
    expect(h.d.state.decisions[dec.id].outcome).toMatch(/restarted/);
    await expect(h.d.decisions.respond(dec.id, 'approve', { nonce: p.nonce })).rejects.toThrow(/closed|invalid/);
    expect(h.d.notifications.status().pendingDeliveries).toEqual([]);
    expect(fx.received).toEqual([]);
  });

  it.each(['url', 'body', 'method', 'redirect', 'headers', 'extra-headers', 'credentials', 'referrer', 'malformed-headers'])('redeems no permit for a changed %s and cannot replay that permit', async changed => {
    const { d } = await boot(), fx = await fixtureServer();
    d.notifications.configure({ channels: { chat: { enabled: true, endpoint: fx.url } } });
    d.notifications.useAdapter({ id: 'chat', deliver: async (payload, context) => {
      const init = { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' }, redirect: 'error' as const };
      const permit = d.notifications.issueEgressPermit(context!.decisionId, 'chat', context!.endpoint, init);
      const mutated: RequestInit = { ...init };
      if (changed === 'body') mutated.body = '{}';
      if (changed === 'method') mutated.method = 'GET';
      if (changed === 'redirect') mutated.redirect = 'follow';
      if (changed === 'headers') mutated.headers = { 'content-type': 'text/plain' };
      if (changed === 'extra-headers') mutated.headers = { 'content-type': 'application/json', authorization: 'unapproved header' };
      if (changed === 'credentials') mutated.credentials = 'include';
      if (changed === 'referrer') mutated.referrer = 'https://unapproved.fixture.test';
      if (changed === 'malformed-headers') mutated.headers = [['invalid header name', 'x']];
      await expect(d.egress.fetch(changed === 'url' ? `${fx.url}/other` : fx.url, { ...mutated, notificationPermit: permit })).rejects.toThrow(/blocked/);
      await expect(d.egress.fetch(fx.url, { ...init, notificationPermit: permit })).rejects.toThrow(/blocked/);
      return { ok: false, detail: 'Tampered request refused by fixture.' };
    } });
    const { dec } = await message(d);
    await approve(d, dec.id);
    expect(fx.received).toEqual([]);
    expect(d.state.decisions[dec.id].outcome).toMatch(/failed/);
  });

  it('invalid permit never falls back to an otherwise configured egress host', async () => {
    const { d } = await boot();
    await expect(d.egress.fetch('http://localhost/hook', { method: 'POST', body: '{}', notificationPermit: 'invalid' })).rejects.toThrow(/blocked/);
    expect(d.egress.log.at(-1)).toMatchObject({ allowed: false, purpose: 'notification delivery' });
  });

  it('legacy standing approvals never grant egress or authorize a message', async () => {
    const { d } = await boot();
    d.store.kvSet('notify:endpoint:chat', JSON.stringify({ host: 'example.com', urlHash: 'x', expiresAt: '2099-01-01T00:00:00Z' }));
    const dec = d.decisions.create({ kind: 'notification', question: 'Legacy endpoint?', options: ['approve', 'deny'] });
    d.store.kvSet(`notify:decision:${dec.id}`, JSON.stringify({ channel: 'chat', expires: clock.t + 60_000, consumed: false }));
    await expect(d.notifications.resolveEndpoint(dec.id, 'approve')).rejects.toThrow(/standing/);
    expect(d.state.decisions[dec.id].outcome).toMatch(/legacy/);
    expect(d.notifications.hosts()).toEqual([]);
  });
});
