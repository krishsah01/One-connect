// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { InfraHealthReport } from '../src/release.ts';
import { candidatesFromEvents } from '../src/phone.ts';
import { classifyInfraHealth, genericEventHealth, infraComponentFailed, infraFailuresRecovered } from '../src/reports.ts';

const baseHealth = (): InfraHealthReport => ({
  checkedAt: '2026-01-01T00:00:00Z',
  docker: { state: 'unknown', detail: 'No project services are declared.' },
  postgres: { state: 'unknown', service: null, detail: 'No local Postgres service is declared.' },
  vercel: { state: 'unchecked', source: 'unconfigured', detail: 'Vercel reachability remains unknown.' },
  migrations: { state: 'unchecked', source: 'none', repo: [], applied: [], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: 'Migration history was not read.' },
});

describe('infra health classification', () => {
  it('does not treat unknown, unchecked or unconfigured states as failures', () => {
    const c = classifyInfraHealth(baseHealth());
    expect(c.failed).toBe(false);
    expect(c.fingerprint).toBe('infra:unknown');
    expect(c.summary).toContain('docker unknown');
    expect(c.summary).toContain('migrations unchecked');
    expect(genericEventHealth('infra.checked', { health: baseHealth() }).failed).toBe(false);
    expect(candidatesFromEvents({ agents: {}, runs: {}, workItems: {}, approvals: {}, decisions: {}, alerts: {} }, [{ seq: 1, type: 'infra.checked', data: { health: baseHealth() } }])).toHaveLength(0);
  });

  it('treats unchecked migration history as unknown but approved read failures as alerts', () => {
    const unchecked = { ...baseHealth(), migrations: { ...baseHealth().migrations, state: 'unchecked' as const, source: 'none' as const, detail: 'Migration history was not read.' } };
    expect(classifyInfraHealth(unchecked).failed).toBe(false);
    expect(classifyInfraHealth(unchecked).fingerprint).toBe('infra:unknown');
    const readFailed = { ...baseHealth(), migrations: { ...baseHealth().migrations, state: 'error' as const, source: 'local_postgres' as const, detail: 'Local Postgres is ready but its migration history could not be read: permission denied.' } };
    expect(classifyInfraHealth(readFailed).failed).toBe(true);
    expect(classifyInfraHealth(readFailed).fingerprint).toBe('infra:migrations:error');
    expect(infraComponentFailed('migrations', { state: 'error' })).toBe(true);
  });

  it('reports evidenced failures with a stable fingerprint', () => {
    const health: InfraHealthReport = {
      ...baseHealth(),
      docker: { state: 'degraded', detail: 'A project service is unhealthy or paused.' },
      postgres: { state: 'paused', service: 'db', detail: 'Database service db is paused.' },
      migrations: { state: 'drift', source: 'fixture', repo: ['a'], applied: [], missingInDatabase: ['a'], extraInDatabase: [], hashMismatch: [], detail: '1 repo migration missing.' },
    };
    const c = classifyInfraHealth(health);
    expect(c.failed).toBe(true);
    expect(c.fingerprint).toBe('infra:docker:degraded|migrations:drift|postgres:paused:db');
    const again = classifyInfraHealth({ ...health, checkedAt: '2026-01-01T01:00:00Z' });
    expect(again.fingerprint).toBe(c.fingerprint);
  });

  it('treats configured Vercel errors as failures but not unconfigured checks', () => {
    expect(infraComponentFailed('vercel', { state: 'error', source: 'fixture' })).toBe(true);
    expect(infraComponentFailed('vercel', { state: 'unchecked', source: 'unconfigured' })).toBe(false);
    expect(infraComponentFailed('vercel', { state: 'unchecked', source: 'refused' })).toBe(false);
  });

  it('does not label healthy or absent-database states as passed production verification', () => {
    const ready: InfraHealthReport = {
      ...baseHealth(),
      docker: { state: 'ready', detail: 'Every declared service is healthy.' },
      postgres: { state: 'ready', service: 'db', detail: 'Database service db is healthy.' },
      vercel: { state: 'ready', source: 'fixture', detail: 'READY deployment.' },
      migrations: { state: 'in_sync', source: 'local_postgres', repo: ['20240101120000_init'], applied: ['20240101120000_init'], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: 'Repo migrations match local Postgres (1).' },
    };
    const c = classifyInfraHealth(ready);
    expect(c.failed).toBe(false);
    expect(c.summary).not.toMatch(/passed|healthy release|production verified/i);
    expect(genericEventHealth('infra.checked', { health: ready }).failed).toBe(false);
  });

  it('uses stable release fingerprints without event sequence numbers', () => {
    const data = { plan: { id: 'p1', name: 'v1', status: 'active', steps: [{ status: 'failed' }] } };
    const a = genericEventHealth('release.saved', data);
    const b = genericEventHealth('release.saved', data);
    expect(a.fingerprint).toBe('release:p1:failed');
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('still treats release and deploy status:error as failures outside infra classification', () => {
    const failed = genericEventHealth('deploy.finished', { id: 'd1', status: 'error', summary: 'Deploy failed after health check.' });
    expect(failed.failed).toBe(true);
    expect(failed.fingerprint).toBe('deploy.finished:d1:error');
    expect(candidatesFromEvents({ agents: {}, runs: {}, workItems: {}, approvals: {}, decisions: {}, alerts: {} }, [{ seq: 1, type: 'deploy.finished', data: { id: 'd1', status: 'error', summary: 'Deploy failed after health check.' } }])).toHaveLength(1);
  });

  it('detects infra recovery only from positive evidence for the prior failure', () => {
    const paused = {
      ...baseHealth(),
      postgres: { state: 'paused' as const, service: 'db', detail: 'Database service db is paused.' },
    };
    const unknown = baseHealth();
    const recovered = {
      ...baseHealth(),
      postgres: { state: 'ready' as const, service: 'db', detail: 'Database service db is healthy.' },
    };
    const fingerprint = classifyInfraHealth(paused).fingerprint;
    expect(infraFailuresRecovered(unknown, fingerprint)).toBe(false);
    expect(infraFailuresRecovered(recovered, fingerprint)).toBe(true);
  });
});
