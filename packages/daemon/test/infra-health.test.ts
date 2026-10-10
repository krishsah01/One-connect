// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_QUERIES, compareMigrations, parseMigrationRows, psqlReadArgv } from '../src/infra/migrations.ts';
import { summarizeWorkbench } from '../src/infra/health.ts';
import { makeConfig, makeRepo, startDaemon } from './helpers.ts';

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))) });
    });
  });
}

describe('infra health', () => {
  it('compares migration ids and only allows a fixed read-only psql argv', () => {
    const drift = compareMigrations(['20240101120000_init', '20240202120000_add'], ['20240101120000_init'], 'fixture');
    expect(drift.state).toBe('drift');
    expect(drift.missingInDatabase).toEqual(['20240202120000_add']);
    expect(compareMigrations(['20240101120000_init'], null, 'none').state).toBe('unchecked');
    expect(compareMigrations(['20240101120000_init'], null, 'local_postgres', 'permission denied').state).toBe('error');
    expect(compareMigrations(['20240101120000_init'], ['20240101120000_init'], 'local_postgres').state).toBe('in_sync');
    const argv = psqlReadArgv(['docker', 'compose', '--project-name', 'sample', 'exec', 'db', 'psql', '-U', 'app', '-d', 'app'], MIGRATION_QUERIES[0]);
    expect(argv.slice(0, 6)).toEqual(['docker', 'compose', '--project-name', 'sample', 'exec', '-T']);
    expect(argv).toContain(MIGRATION_QUERIES[0]);
    expect(argv.join(' ')).not.toMatch(/\b(drop|delete|insert|update|alter)\b/i);
    expect(() => psqlReadArgv(['psql', '-c', 'select 1'], MIGRATION_QUERIES[0])).toThrow(/Compose exec/);
    expect(parseMigrationRows('20240101120000_init\n\n20240202120000_add\n')).toEqual(['20240101120000_init', '20240202120000_add']);
    const paused = summarizeWorkbench({
      availability: { engine: true },
      services: [{ name: 'db', source: 'database', image: 'postgres:16-alpine', readiness: 'stopped', readinessDetail: 'Container is paused.', container: { state: 'paused' } }],
    });
    expect(paused.postgres.state).toBe('paused');
    expect(paused.docker.state).not.toBe('ready');
  });

  it('reports paused Postgres, Vercel fixture state and Supabase migration drift without calling real providers', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'supabase/migrations'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'supabase/migrations/20240101120000_init.sql'), '-- init\n');
    fs.writeFileSync(path.join(repo, 'supabase/migrations/20240202120000_add.sql'), '-- add\n');
    const fx = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/migrations')) {
        res.end(JSON.stringify([{ version: '20240101120000_init', name: 'init' }]));
        return;
      }
      if (url.pathname === '/v6/deployments') {
        res.end(JSON.stringify({ deployments: [{ uid: 'dpl_1', name: 'app', readyState: 'READY', url: 'http://127.0.0.1/app' }] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const cfg = makeConfig(repo, {
      infra: {
        vercel: { project: 'app', fixture_base: fx.url },
        supabase: { project_ref: 'ref', fixture_base: fx.url },
      },
    });
    const h = await startDaemon(cfg, { probe: false });
    try {
      h.d.environment.status = (async () => ({
        availability: { engine: true, error: null },
        services: [{ name: 'db', source: 'database', image: 'postgres:16-alpine', readiness: 'stopped', readinessDetail: 'Container is paused.', container: { state: 'paused' } }],
      })) as typeof h.d.environment.status;
      const health = await h.d.infra.refresh();
      expect(health.postgres).toMatchObject({ state: 'paused', service: 'db' });
      expect(health.docker.state).toBe('degraded');
      expect(health.vercel).toMatchObject({ state: 'ready', source: 'fixture' });
      expect(health.migrations.state).toBe('drift');
      expect(health.migrations.missingInDatabase).toEqual(['20240202120000_add']);
      expect(health.migrations.detail).not.toMatch(/in sync|healthy/i);
      expect(Object.values(h.d.state.alerts).some((a) => !a.resolvedAt && /paused/.test(a.message))).toBe(true);
      expect(Object.values(h.d.state.alerts).some((a) => !a.resolvedAt && a.dedupeKey === 'migration-drift')).toBe(true);

      let called = false;
      h.d.egress.fetch = async () => {
        called = true;
        throw new Error('should not dial');
      };
      h.d.config = { ...h.d.config, infra: { finding_issues: 'manual', vercel: { project: 'app', fixture_base: 'https://api.vercel.com', activated: false, scopes: [] } } };
      const refused = await h.d.infra.refresh();
      expect(called).toBe(false);
      expect(refused.vercel.source).toBe('refused');
      expect(refused.vercel.state).not.toBe('ready');
    } finally {
      await h.close();
      await fx.close();
    }
  });

  it('reads local Postgres migration history with the fixed SELECT and labels it as local', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'prisma/migrations/20240101120000_init'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'prisma/migrations/20240101120000_init/migration.sql'), '-- init\n');
    const h = await startDaemon(makeConfig(repo), { probe: false });
    try {
      h.d.environment.status = (async () => ({
        availability: { engine: true, error: null },
        services: [{ name: 'db', source: 'database', image: 'postgres:16-alpine', readiness: 'ready', readinessDetail: 'Healthcheck passing.', container: { state: 'running' } }],
      })) as typeof h.d.environment.status;
      h.d.environment.connections = () => [{ kind: 'postgres', service: 'db', host: '127.0.0.1', port: 5432, database: 'app', user: 'app', password: 'hidden', passwordFile: '/tmp/secret', url: 'postgresql://app:<password>@127.0.0.1:5432/app', volume: 'sample_db', shell: ['docker', 'compose', '--project-name', 'sample', 'exec', 'db', 'psql', '-U', 'app', '-d', 'app'] }];
      const seen: string[][] = [];
      h.d.infra.exec = async (argv) => {
        seen.push(argv);
        return { code: 0, stdout: '20240101120000_init\n', stderr: '' };
      };
      const health = await h.d.infra.refresh();
      expect(seen).toHaveLength(1);
      expect(seen[0][0]).toBe('docker');
      expect(seen[0]).toContain(MIGRATION_QUERIES[0]);
      expect(health.migrations).toMatchObject({ state: 'in_sync', source: 'local_postgres' });
      expect(health.migrations.detail).toMatch(/not a remote production host/);
      expect(health.postgres.state).toBe('ready');
    } finally {
      await h.close();
    }
  });

  it('records an approved local Postgres migration read failure as error, not unchecked drift', async () => {
    const repo = makeRepo();
    const h = await startDaemon(makeConfig(repo), { probe: false });
    try {
      h.d.environment.status = (async () => ({
        availability: { engine: true, error: null },
        services: [{ name: 'db', source: 'database', image: 'postgres:16-alpine', readiness: 'ready', readinessDetail: 'Healthcheck passing.', container: { state: 'running' } }],
      })) as typeof h.d.environment.status;
      h.d.environment.connections = () => [{ kind: 'postgres', service: 'db', host: '127.0.0.1', port: 5432, database: 'app', user: 'app', password: 'hidden', passwordFile: '/tmp/secret', url: 'postgresql://app:<password>@127.0.0.1:5432/app', volume: 'sample_db', shell: ['docker', 'compose', '--project-name', 'sample', 'exec', 'db', 'psql', '-U', 'app', '-d', 'app'] }];
      h.d.infra.exec = async () => ({ code: 1, stdout: '', stderr: 'permission denied', error: 'permission denied' });
      const health = await h.d.infra.refresh();
      expect(health.migrations).toMatchObject({ state: 'error', source: 'local_postgres' });
      expect(health.migrations.detail).toMatch(/could not be read/i);
      expect(health.migrations.state).not.toBe('unchecked');
    } finally {
      await h.close();
    }
  });
});
