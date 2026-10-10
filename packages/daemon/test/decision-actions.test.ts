// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Authenticated phone requests against local protocol fixtures; no vendor or Docker is contacted.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentActor, HUMAN } from '@acc/core';
import { ProjectEnvironment, type DockerExec } from '../src/environment/workbench.ts';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

function phone(route: string, body: unknown, authenticated = true) {
  const token = fs.readFileSync(h!.d.paths.installToken, 'utf8').trim();
  return fetch(h!.url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}
const answer = (id: string, option = 'approve', nonce?: string | null) => phone(`/api/decisions/${id}/answer`, { answer: option, nonce, channel: 'phone' });

async function environment() {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'compose.yaml'), 'services:\n  db: { image: "postgres:16-alpine" }\n');
  h = await startDaemon(makeConfig(repo), { probe: false });
  const calls: string[][] = [];
  const exec: DockerExec = async args => {
    calls.push(args);
    const stdout = args[0] === 'version' ? JSON.stringify({ Client: { Version: '29' }, Server: { Version: '29' } })
      : args[0] === 'context' ? JSON.stringify('unix:///var/run/docker.sock')
      : args[0] === 'compose' && args[1] === 'version' ? '2.40.0'
      : args[0] === 'image' ? 'sha256:present' : '';
    return { code: 0, stdout, stderr: '', timedOut: false };
  };
  const env = new ProjectEnvironment(h.d, { exec, portProbe: async () => false });
  Object.defineProperty(h.d, 'environment', { value: env });
  const mutations = () => calls.filter(c => c[0] === 'compose' && !c.includes('version'));
  return { repo, env, mutations };
}

describe('one inbox for bound actions', () => {
  it('a phone answer atomically activates exactly the requested connector and cannot be replayed', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const { d } = h;
    d.connectors.save({ id: 'issues', name: 'Issues', config: { kind: 'linear', team: 'ENG' } }, null);
    const requested = d.connectors.requestActivation('issues', 'import').decision!;
    expect((await answer(requested.id, 'approve')).status).toBe(428);
    const confirmation = await phone(`/api/decisions/${requested.id}/prepare`, { answer: 'approve' });
    const { nonce } = await confirmation.json() as { nonce: string };
    expect((await answer(requested.id, 'approve', nonce)).status).toBe(200);
    expect(d.connectors.list().connections[0].state).toBe('active');
    expect(d.state.decisions[requested.id]).toMatchObject({ answeredBy: HUMAN, channel: 'phone', answer: 'approve' });
    expect(JSON.parse(d.store.kvGet(`connector:decision:${requested.id}`)!)).toMatchObject({ consumed: true });
    const history = d.decisions.history(requested.id);
    expect(history.map(e => e.type)).toContain('connector.activated');
    expect((await answer(requested.id)).status).toBe(409);
    expect(d.store.list({ types: ['connector.activated'] })).toHaveLength(1);
    expect(d.egress.log).toEqual([]); // Activation is not an import or a connectivity probe.
    await expect(d.decisions.respond(requested.id, 'approve', {}, agentActor('codex'))).rejects.toMatchObject({ status: 403 });
  });

  it('stale connector settings are never approved through the generic inbox', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const draft = h.d.connectors.save({ id: 'issues', name: 'Issues', config: { kind: 'linear', team: 'ENG' } }, null);
    const requested = h.d.connectors.requestActivation('issues', 'import').decision!;
    expect((await phone(`/api/decisions/${requested.id}/answer`, { answer: 'approve' }, false)).status).toBe(401);
    expect(() => h!.d.decisions.answer(requested.id, 'approve')).toThrow(/action executor/);
    const confirmation = await phone(`/api/decisions/${requested.id}/prepare`, { answer: 'approve' });
    const { nonce } = await confirmation.json() as { nonce: string };
    h.d.connectors.save({ id: 'issues', name: 'Issues', config: { kind: 'linear', team: 'OTHER' } }, draft.configHash);
    expect((await answer(requested.id, 'approve', nonce)).status).toBe(409);
    expect(h.d.connectors.list().connections[0].state).toBe('draft');
    expect(h.d.store.list({ types: ['connector.activated'] })).toEqual([]);
  });

  it('the phone inbox starts an exact Docker action once, with its answer and durable job evidence', async () => {
    const { env, mutations } = await environment();
    const request = await env.request('restart', ['db']);
    const id = request.decision!.id;
    const results = await Promise.all([answer(id), answer(id)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    await waitFor(() => h!.d.store.list({ types: ['docker.action'] }).find(e => (e.data as { decisionId: string }).decisionId === id));
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]).toEqual(expect.arrayContaining(['restart', 'db']));
    expect(mutations()[0].some(x => x.includes('approval-snapshots'))).toBe(true);
    expect(h!.d.state.decisions[id]).toMatchObject({ answer: 'approve', channel: 'phone', answeredBy: HUMAN });
    expect(JSON.parse(h!.d.store.kvGet(`env-action:${id}`)!).consumed).toBe(true);
    expect(h!.d.decisions.history(id).map(e => e.type)).toContain('docker.action');
  });

  it('destructive and network Docker actions require a second confirmation on every route', async () => {
    const { env, mutations } = await environment();
    const request = await env.request('down');
    const id = request.decision!.id;
    expect((await answer(id)).status).toBe(428);
    await expect(env.resolve(id, 'approve', request.digest!)).rejects.toMatchObject({ status: 428 });
    expect(mutations()).toEqual([]);
    expect(h!.d.state.decisions[id].answeredAt).toBeNull();
    const prepared = await (await phone(`/api/decisions/${id}/prepare`, { answer: 'approve' })).json() as { confirm: boolean; nonce: string };
    expect(prepared.confirm).toBe(true);
    expect((await answer(id, 'approve', 'wrong')).status).toBe(428);
    expect((await answer(id, 'approve', prepared.nonce)).status).toBe(200);
    expect(h!.d.state.decisions[id].confirmedAt).toBeTruthy();
    expect(h!.d.store.kvGet(`decision-confirm:${id}`)).toBeNull();
    expect((await answer(id, 'approve', prepared.nonce)).status).toBe(409);
    expect((await env.request('pull', ['db'])).decision?.confirmOptions).toEqual(['approve']);
  });

  it('a confirmed phone action still refuses changed Compose content without consuming the approval', async () => {
    const { repo, env, mutations } = await environment();
    const request = await env.request('pull', ['db']);
    const id = request.decision!.id;
    const prepared = h!.d.decisions.prepare(id, 'approve');
    fs.writeFileSync(path.join(repo, 'compose.yaml'), 'services:\n  db: { image: "different:latest" }\n');
    expect((await answer(id, 'approve', prepared.nonce)).status).toBe(409);
    expect(mutations()).toEqual([]);
    expect(h!.d.state.decisions[id].answeredAt).toBeNull();
    expect(JSON.parse(h!.d.store.kvGet(`env-action:${id}`)!).consumed).toBe(false);
    expect((await answer(id, 'deny')).status).toBe(200);
  });

  it('ordinary questions still record a phone answer, and legacy irreversible decisions require confirmation', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const question = h.d.decisions.create({ question: 'Choose the layout', options: ['compact', 'spacious'] });
    expect((await answer(question.id, 'compact')).status).toBe(200);
    expect(h.d.state.decisions[question.id]).toMatchObject({ answer: 'compact', channel: 'phone' });
    const legacy = { ...h.d.decisions.create({ question: 'Remove the fixture?', options: ['remove', 'keep'], irreversible: true }), confirmOptions: undefined };
    h.d.commit([{ type: 'decision.created', actor: HUMAN, data: { decision: legacy } }]);
    expect((await answer(legacy.id, 'remove')).status).toBe(428);
    expect((await answer(legacy.id, 'keep')).status).toBe(200);
  });
});
