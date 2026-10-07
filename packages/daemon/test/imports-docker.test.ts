// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { IssueImports } from '../src/imports.ts';
import { ProjectDocker } from '../src/docker.ts';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';
let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
describe('Issue import', () => {
  it('previews both offline sources, imports selected issues once, and keeps source identity through replay', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { baseEnv: { ...process.env, ACC_DEMO_FIXTURES: '1' } });
    const d = h.d;
    expect(d.imports.sources().map(s => s.type)).toEqual(['github', 'linear']);
    const g = await d.imports.preview('demo-github', 'negative');
    expect(g.issues).toHaveLength(1);
    const l = await d.imports.preview('demo-linear');
    expect(l.issues).toHaveLength(2);
    expect(() => d.imports.import(g.token, ['missing'])).toThrow('Select issues');
    const result = d.imports.import(g.token, [g.issues[0].id]);
    const item = result.items[0];
    await waitFor(() => d.state.workItems[item.id].key);
    expect(d.state.workItems[item.id].origin).toMatchObject({ type: 'github', key: 'GH-13', readOnly: true });
    expect(d.state.workItems[item.id].key).toBe('LOC-1');
    expect(d.imports.import(g.token, [g.issues[0].id])).toMatchObject({ items: [], skipped: 1 });
    const fromLinear = d.imports.import(l.token, [l.issues[1].id]);
    expect(fromLinear.items).toHaveLength(1); // same issue number in another source is independent
    await waitFor(() => d.state.workItems[fromLinear.items[0].id].key);
    const replay = d.store.loadState((await import('@acc/core')).applyEvent);
    expect(replay.workItems[item.id].origin).toEqual(d.state.workItems[item.id].origin);
  });
  it('disabled sources cannot contact a vendor, and stale preview tokens cannot import', async () => {
    h = await startDaemon(makeConfig(makeRepo(), { import_sources: [{ id: 'github', name: 'My repo', type: 'github', repo: 'owner/repo' }] }));
    await expect(h.d.imports.preview('github')).rejects.toThrow('disabled');
    expect(() => h!.d.imports.import('expired', ['12'])).toThrow('expired');
    expect(h.d.egress.log).toEqual([]);
  });
});
describe('Docker project controls', () => {
  it('scopes reads to a Compose project and requires a single-use exact approval before writes', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const calls: string[][] = [];
    const id = '012345abcdef';
    const docker = new ProjectDocker(h.d, async args => {
      calls.push(args);
      return { code: 0, stderr: '', stdout: args[0] === 'ps' ? JSON.stringify({ ID: id, Names: 'sample-db', State: 'running', Status: 'Up', Image: 'postgres' }) : args[0] === 'logs' ? 'safe log' : 'ok', timedOut: false };
    });
    expect((await docker.list()).containers[0].ID).toBe(id);
    expect(calls[0]).toContain('label=com.docker.compose.project=sample');
    await expect(docker.logs('abcdefabcdef')).rejects.toThrow('outside');
    await expect(docker.resolve('not-approved', 'approve')).rejects.toThrow('missing');
    const denied = await docker.request(id, 'stop');
    expect(calls.some(c => c[0] === 'stop')).toBe(false);
    await docker.resolve(denied.decision.id, 'deny');
    expect(calls.some(c => c[0] === 'stop')).toBe(false);
    const requested = await docker.request(id, 'restart');
    const outcomes = await Promise.allSettled([docker.resolve(requested.decision.id, 'approve'), docker.resolve(requested.decision.id, 'approve')]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(calls.filter(c => c[0] === 'restart')).toEqual([['restart', id]]);
    expect(h.d.state.decisions[requested.decision.id]).toMatchObject({ answer: 'approve', channel: 'dashboard' });
    expect(h.d.store.list({ types: ['docker.action'] })).toHaveLength(1);
  });
});
