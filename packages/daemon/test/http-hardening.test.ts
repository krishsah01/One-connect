// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// HTTP boundary regressions: server-side session lifetime, validated bodies, no mass assignment.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/daemon.ts';
import { makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const token = () => fs.readFileSync(h!.d.paths.installToken, 'utf8').trim();
const call = (route: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => fetch(h!.url + route, {
  method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
  headers: {
    ...(init.cookie ? { cookie: init.cookie, origin: h!.url } : { authorization: `Bearer ${token()}` }),
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
  },
  body: init.body === undefined ? undefined : JSON.stringify(init.body),
});

describe('http boundary', () => {
  it('reports the daemon version from one constant', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    expect(await (await fetch(h.url + '/api/health')).json()).toEqual({ ok: true, version: VERSION });
  });

  it('expires browser sessions on the server, not only in the cookie', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const { code } = await (await call('/api/auth/code', { body: {} })).json() as { code: string };
    const signIn = await fetch(`${h.url}/auth?code=${code}`, { redirect: 'manual' });
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0];
    expect((await call('/api/state', { cookie })).status).toBe(200);
    const [key] = h.d.store.kvKeys('session:');
    h.d.store.kvSet(key, new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString());
    expect((await call('/api/state', { cookie })).status).toBe(401);
    expect(h.d.store.kvGet(key)).toBeNull();
  });

  it('drops assignment fields a client may not set and rejects missing bodies with 400', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const item = h.d.createIssue({ title: 'Bounded edit' });
    const created = await (await call('/api/assignments', { body: { workItemId: item.id, agentId: 'claude', kind: 'review', review: { targetSha: 'x' } } })).json() as { assignment: { id: string; kind?: string } };
    expect(created.assignment.kind).toBeUndefined();
    const id = created.assignment.id;
    const patched = await call(`/api/assignments/${id}`, { method: 'PATCH', body: { scope: 'docs only', worktree: '/etc', agentId: 'codex', position: 'done' } });
    expect(patched.status).toBe(200);
    expect(h.d.state.assignments[id]).toMatchObject({ scope: 'docs only', worktree: null, agentId: 'claude', position: 'draft' });
    expect((await call(`/api/assignments/${id}/reassign`, { body: {} })).status).toBe(400);
    expect((await call('/api/agents/claude/model', { body: {} })).status).toBe(400);
    expect(h.d.state.agents.claude.config.model).toBe('newest');
  });
});
