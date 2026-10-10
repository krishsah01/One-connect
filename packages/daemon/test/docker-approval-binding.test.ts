// SPDX-License-Identifier: Apache-2.0
// Injected Docker only; no socket, subprocess, engine or external account access.
import { afterEach, describe, expect, it } from 'vitest';
import { Daemon } from '../src/daemon.ts';
import { ProjectDocker } from '../src/docker.ts';
import { makeConfig, tmpDir } from './helpers.ts';
const daemons: Daemon[] = [];
afterEach(() => { for (const d of daemons.splice(0)) { d.closed = true; d.store.close(); } });
const id = 'abcdef123456';
function fixture() {
  let now = Date.parse('2026-10-07T20:00:00Z');
  let gate: (() => Promise<void>) | null = null;
  const calls: string[][] = [];
  const d = new Daemon({ config: makeConfig(tmpDir('docker-binding-repo')), dataDir: tmpDir('docker-binding-data'), allowTempDataDir: true, clock: () => new Date(now), baseEnv: {} });
  daemons.push(d);
  const docker = new ProjectDocker(d, async args => {
    calls.push(args);
    if (args[0] === 'ps') await gate?.();
    return { code: 0, stderr: '', stdout: args[0] === 'ps' ? JSON.stringify({ ID: id, Names: 'fixture-db', State: 'running', Status: 'up', Image: 'fixture' }) : '', timedOut: false };
  });
  Object.defineProperty(d, 'docker', { value: docker });
  return { d, docker, calls, advance: (ms: number) => { now += ms; }, gate: (fn: (() => Promise<void>) | null) => { gate = fn; } };
}
describe('exact container approval binding', () => {
  it('requires confirmation and records one human answer before a single concurrent write', async () => {
    const { d, docker, calls } = fixture();
    const { decision } = await docker.request(id, 'restart');
    expect(decision).toMatchObject({ confirmOptions: ['approve'], expiresAt: expect.any(String) });
    await expect(d.decisions.respond(decision.id, 'approve')).rejects.toMatchObject({ status: 428 });
    expect(calls.some(x => x[0] === 'restart')).toBe(false);
    const { nonce } = d.decisions.prepare(decision.id, 'approve');
    const outcomes = await Promise.allSettled([d.decisions.respond(decision.id, 'approve', { nonce, channel: 'phone' }), d.decisions.respond(decision.id, 'approve', { nonce, channel: 'phone' })]);
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(calls.filter(x => x[0] === 'restart')).toEqual([['restart', id]]);
    expect(d.state.decisions[decision.id]).toMatchObject({ answer: 'approve', confirmedAt: expect.any(String), channel: 'phone', answeredBy: { type: 'human' } });
    expect(JSON.parse(d.store.kvGet(`docker:${decision.id}`)!)).toMatchObject({ consumed: true, project: d.config.project.repo, namespace: 'sample' });
  });
  it.each(['repo', 'namespace', 'expiry'] as const)('rechecks %s while the container read is pending and permits safe denial', async change => {
    const f = fixture(), { d, docker, calls } = f;
    const { decision } = await docker.request(id, 'stop');
    const { nonce } = d.decisions.prepare(decision.id, 'approve');
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    f.gate(async () => { started(); await new Promise<void>(r => { release = r; }); });
    const resolving = docker.resolve(decision.id, 'approve', { nonce });
    const rejected = expect(resolving).rejects.toThrow(change === 'expiry' ? /expired/ : /project changed/);
    await entered;
    if (change === 'repo') d.config.project.repo = `${d.config.project.repo}-different`;
    if (change === 'namespace') d.config.project.docker_project = 'other-project';
    if (change === 'expiry') f.advance(120_000);
    release(); await rejected;
    expect(calls.some(x => x[0] === 'stop')).toBe(false);
    expect(d.state.decisions[decision.id].answeredAt).toBeNull();
    const before = calls.length;
    expect(await docker.resolve(decision.id, 'deny')).toEqual({ executed: false });
    expect(calls).toHaveLength(before);
    expect(d.state.decisions[decision.id].answer).toBe('deny');
  });
  it('rejects an old unbound record before accessing Docker', async () => {
    const { d, docker, calls } = fixture();
    const { decision } = await docker.request(id, 'start');
    const record = JSON.parse(d.store.kvGet(`docker:${decision.id}`)!);
    delete record.project; delete record.namespace;
    d.store.kvSet(`docker:${decision.id}`, JSON.stringify(record));
    const { nonce } = d.decisions.prepare(decision.id, 'approve'), before = calls.length;
    await expect(docker.resolve(decision.id, 'approve', { nonce })).rejects.toThrow(/project changed/);
    expect(calls).toHaveLength(before);
    expect(d.state.decisions[decision.id].answeredAt).toBeNull();
  });
});
