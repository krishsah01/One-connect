// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Opt-in real Docker smoke test: ONE_CONNECT_DOCKER_SMOKE=1 and postgres:16-alpine already
// present locally. Scope is one disposable Compose project named ocsmoke<random>; cleanup runs
// `down -v` for that project only. Nothing is pulled; other containers are never addressed.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { run } from '../src/exec.ts';
import { portInUse } from '../src/environment/workbench.ts';
import { makeConfig, makeRepo, startDaemon } from './helpers.ts';

const enabled = process.env.ONE_CONNECT_DOCKER_SMOKE === '1';

describe.skipIf(!enabled)('real Docker smoke (disposable project)', () => {
  it('starts a wizard Postgres, reports healthcheck readiness, and keeps data in its scoped volume across down/up', async () => {
    if ((await run('docker', ['image', 'inspect', 'postgres:16-alpine'], { timeoutMs: 10_000 })).code !== 0) {
      throw new Error('Docker smoke was explicitly enabled but postgres:16-alpine is not present locally. Install the image separately; this test never pulls.');
    }
    const project = `ocsmoke${randomBytes(4).toString('hex')}`;
    const repo = makeRepo();
    const h = await startDaemon(makeConfig(repo, { project: { name: project, repo, docker_project: project, integration_branch: 'integration', protected_branches: ['main'] } }), { probe: false });
    const env = h.d.environment;
    let port = 55500;
    while (await portInUse(port)) port++;
    const approve = async (action: string, services: string[]) => {
      const r = await env.request(action, services);
      expect(r.blockers).toEqual([]);
      const decision = r.decision!;
      const confirmation = h.d.decisions.prepare(decision.id, 'approve');
      const { job } = await env.resolve(decision.id, 'approve', r.digest!, { nonce: confirmation.nonce ?? undefined });
      for (let i = 0; i < 240; i++) {
        const j = (await env.status()).jobs.find(x => x.id === job!.id);
        if (j && j.state !== 'running') return j;
        await new Promise(res => setTimeout(res, 500));
      }
      throw new Error(`${action} did not finish`);
    };
    const psql = (sql: string) => run('docker', [...env.baseArgs(), 'exec', '-T', 'devdb', 'psql', '-U', 'app', '-d', 'app', '-tAc', sql], { timeoutMs: 30_000 });
    try {
      await env.createDatabase({ kind: 'postgres', service: 'devdb', database: 'app', user: 'app', version: '16-alpine', port });
      expect((await approve('up', ['devdb'])).state).toBe('succeeded');
      const ready = async () => (await env.status(true)).services.find(s => s.name === 'devdb')?.readiness;
      for (let i = 0; i < 90 && (await ready()) !== 'ready'; i++) await new Promise(r => setTimeout(r, 1000));
      expect(await ready()).toBe('ready');
      expect((await psql('create table smoke(x int); insert into smoke values (42);')).code).toBe(0);
      const logs = await env.logs('devdb');
      expect(logs.text).not.toContain(env.files.readSecret('devdb')!);
      expect((await approve('down', [])).state).toBe('succeeded');
      expect((await env.status(true)).services.find(s => s.name === 'devdb')?.readiness).toBe('not-created');
      expect((await run('docker', ['volume', 'inspect', `${project}_devdb-data`], { timeoutMs: 10_000 })).code).toBe(0);
      expect((await approve('up', ['devdb'])).state).toBe('succeeded');
      for (let i = 0; i < 90 && (await ready()) !== 'ready'; i++) await new Promise(r => setTimeout(r, 1000));
      expect((await psql('select x from smoke')).stdout.trim()).toBe('42');
    } finally {
      await run('docker', [...env.baseArgs(), 'down', '-v'], { timeoutMs: 120_000 });
      await h.close();
    }
    expect((await run('docker', ['volume', 'inspect', `${project}_devdb-data`], { timeoutMs: 10_000 })).code).not.toBe(0);
  }, 300_000);
});
