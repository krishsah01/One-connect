// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Read-only infra health: Docker and local Postgres from the project workbench,
// Vercel from a loopback fixture, and migration drift from repo files plus a history that was read.
import { SYSTEM, type InfraHealthReport, type MigrationDrift } from '@acc/core';
import type { ExecResult } from '../exec.ts';
import { run } from '../exec.ts';
import { liveOrigin } from '../adapters/hosts/index.ts';
import { ProviderRefused, fixtureUrl, liveUrl, readJson } from '../adapters/hosts/http.ts';
import { getSecret } from '../secrets.ts';
import { compareMigrations, listRepoMigrationFiles, MIGRATION_QUERIES, parseMigrationRows, psqlReadArgv } from './migrations.ts';
import { readVercel } from './vercel.ts';
import { readCapability } from '../adapters/hosts/github.ts';
import type { Kernel } from '../kernel.ts';
import type { Connectors } from '../connectors.ts';
import type { ProjectEnvironment } from '../environment/workbench.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type InfraHealthDeps = Kernel & { readonly connectors: Connectors; readonly environment: ProjectEnvironment };

type ServiceLike = {
  name: string;
  source?: string;
  image?: string | null;
  readiness?: string;
  readinessDetail?: string;
  container?: { state?: string } | null;
};

export class InfraHealth {
  readonly d: InfraHealthDeps;
  exec: (argv: string[]) => Promise<Pick<ExecResult, 'code' | 'stdout' | 'stderr' | 'error'>>;

  constructor(d: InfraHealthDeps) {
    this.d = d;
    this.exec = (argv) => run(argv[0] ?? 'docker', argv.slice(1), { timeoutMs: 15_000, maxBytes: 64_000 });
  }

  async refresh(opt: { live?: boolean; connectorId?: string } = {}): Promise<InfraHealthReport> {
    const selected = opt.connectorId ? this.d.state.connectors?.[opt.connectorId]?.kind : null;
    const dockerProbe = selected ? { docker: this.d.state.infra?.docker ?? { state: 'unknown' as const, detail: 'Docker was not probed by this provider read.' }, postgres: this.d.state.infra?.postgres ?? { state: 'unknown' as const, service: null, detail: 'Local Postgres was not probed by this provider read.' } } : await this.probeDocker();
    const migrations = selected && selected !== 'supabase' ? this.d.state.infra?.migrations ?? unknownDrift([], 'Migration history was not probed by this provider read.') : await this.drift(dockerProbe.postgres, opt);
    const vercel = selected && selected !== 'vercel' ? this.d.state.infra?.vercel ?? { state: 'unchecked' as const, source: 'unconfigured' as const, detail: 'Vercel was not probed by this provider read.' } : await this.vercel(opt);
    const health: InfraHealthReport = { checkedAt: this.d.nowIso(), docker: dockerProbe.docker, postgres: dockerProbe.postgres, vercel, migrations };
    this.d.commit([{ type: 'infra.checked', actor: SYSTEM, data: { health } }]);
    this.warn(health);
    return health;
  }

  private warn(health: InfraHealthReport): void {
    const d = this.d;
    const pg = health.postgres;
    if (pg.state === 'paused' || pg.state === 'unhealthy') {
      d.alert({ kind: 'infra', severity: 'critical', message: pg.detail, dedupeKey: `postgres:${pg.service ?? 'db'}:${pg.state}` });
    } else if (pg.state === 'ready') d.resolveAlerts((a) => a.kind === 'infra' && a.dedupeKey.startsWith('postgres:'), 'postgres is ready');
    if (health.migrations.state === 'drift') {
      d.alert({ kind: 'infra', severity: 'warn', message: health.migrations.detail, dedupeKey: 'migration-drift' });
    } else if (health.migrations.state === 'in_sync') d.resolveAlerts((a) => a.dedupeKey === 'migration-drift', 'migrations match');
  }

  private async probeDocker(): Promise<{ docker: InfraHealthReport['docker']; postgres: InfraHealthReport['postgres'] }> {
    try {
      const status = await this.d.environment.status();
      return summarizeWorkbench(status as { availability?: { engine?: boolean; error?: string | null }; services?: ServiceLike[] });
    } catch (e) {
      return {
        docker: { state: 'unknown', detail: `Docker status could not be read: ${(e as Error).message}` },
        postgres: { state: 'unknown', service: null, detail: 'Local Postgres was not checked because the Docker workbench could not be read.' },
      };
    }
  }

  private async drift(postgres: InfraHealthReport['postgres'], opt: { live?: boolean; connectorId?: string }): Promise<MigrationDrift> {
    const access = opt.live ? this.d.connectors.releaseAccess('supabase', opt.connectorId) : null;
    const approved = access?.config.kind === 'supabase' ? access.config : null;
    const files = listRepoMigrationFiles(this.d.config.project.repo, approved?.migrations_dir ?? this.d.config.infra?.supabase?.migrations_dir, approved ? [approved.migrations_dir] : undefined);
    const repo = files.ids;
    if (files.error) return unknownDrift(repo, files.error);
    const supa = this.d.config.infra?.supabase;
    if (access && approved) {
      try {
        access.authorize('migrations:read');
        if (!this.d.egress.allowed.includes(approved.host)) return unknownDrift(repo, `${approved.host} is not on the egress allowlist. No request was sent.`);
        const token = await getSecret('supabase', this.d.baseEnv());
        if (!token) return unknownDrift(repo, 'No Supabase token is stored. No request was sent.');
        this.d.addSecret(token);
        const res = await readCapability(this.d.egress.fetch, liveOrigin('supabase', approved.host), `/v1/projects/${encodeURIComponent(approved.project_ref)}/database/migrations`, 'migrations:read', { live: true, headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, capabilities: approved.capabilities, authorize: access.authorize });
        const rows = res && Array.isArray(res.json) ? res.json : null;
        if (!res) return unknownDrift(repo, 'The migration read capability was not approved. No request was sent.');
        if (res.status !== 200 || !rows) return compareMigrations(repo, null, 'live', `Supabase migration history was not readable (HTTP ${res.status}).`);
        const parsed = appliedFromRows(rows);
        if (!parsed.valid) return compareMigrations(repo, null, 'live', 'Supabase returned malformed migration history after an approved read.');
        const want = supabaseVersions(repo, files.hashes);
        const have = supabaseVersions(parsed.ids, parsed.hashes);
        return compareMigrations(want.ids, have.ids, 'live', undefined, { repo: want.hashes, applied: have.hashes });
      } catch (e) {
        // Revoked permissions and refused requests provide no evidence of a database failure.
        try { access.authorize('migrations:read'); } catch { return unknownDrift(repo, this.d.redactText((e as Error).message)); }
        if (e instanceof ProviderRefused || !this.d.egress.allowed.includes(approved.host)) return unknownDrift(repo, this.d.redactText((e as Error).message));
        return compareMigrations(repo, null, 'live', this.d.redactText((e as Error).message));
      }
    }
    if (supa?.fixture_base) {
      try {
        const url = fixtureUrl(supa.fixture_base, `/v1/projects/${encodeURIComponent(supa.project_ref)}/database/migrations`);
        const res = await readJson(this.d.egress.fetch, url);
        const rows = Array.isArray(res.json) ? res.json : null;
        if (res.status !== 200 || !rows) return compareMigrations(repo, null, 'fixture', `Supabase migration history was not readable (HTTP ${res.status}).`);
        const parsed = appliedFromRows(rows);
        if (!parsed.valid) return unknownDrift(repo, 'The migration fixture returned malformed history. Drift remains unknown.');
        return compareMigrations(repo, parsed.ids, 'fixture', undefined, { repo: files.hashes, applied: parsed.hashes });
      } catch (e) {
        if (e instanceof ProviderRefused) return compareMigrations(repo, null, 'none', e.message);
        return compareMigrations(repo, null, 'fixture', (e as Error).message);
      }
    }
    if (!supa) {
      if (opt.connectorId || this.d.connectors.releaseAccess('supabase')) return unknownDrift(repo, 'Supabase read needs an active matching Decision and an explicit Read now action. No request was sent.');
    } else if (!supa.fixture_base) {
      return unknownDrift(repo, 'Supabase migration history remains unknown. Approve a matching read in Decisions, then choose Read now. No request was sent.');
    }
    if (postgres.state !== 'ready') {
      return compareMigrations(repo, null, 'none', postgres.state === 'unknown' && !this.d.config.infra?.supabase
        ? 'Local Postgres is not ready and no Supabase fixture is configured, so migration drift was not checked.'
        : `${postgres.detail} Migration drift was not checked.`);
    }
    const connection = this.d.environment.connections().find((c) => c.kind === 'postgres' && c.service === postgres.service) ?? this.d.environment.connections().find((c) => c.kind === 'postgres');
    if (!connection || connection.kind !== 'postgres') return compareMigrations(repo, null, 'none', 'No local Postgres connection is recorded for this project.');
    let lastError = 'Local Postgres did not return a migration history.';
    for (const sql of MIGRATION_QUERIES) {
      const argv = psqlReadArgv(connection.shell, sql);
      const result = await this.exec(argv);
      if (result.code === 0) {
        const drift = compareMigrations(repo, parseMigrationRows(result.stdout), 'local_postgres');
        drift.detail = `${drift.detail} This is the project database on this Mac, not a remote production host.`;
        return drift;
      }
      lastError = (result.stderr || result.error || `psql exited ${result.code}`).trim().slice(0, 300);
    }
    return compareMigrations(repo, null, 'local_postgres', `Local Postgres is ready but its migration history could not be read: ${lastError}`);
  }

  private async vercel(opt: { live?: boolean; connectorId?: string }): Promise<InfraHealthReport['vercel']> {
    const cfg = this.d.config.infra?.vercel;
    const access = opt.live ? this.d.connectors.releaseAccess('vercel', opt.connectorId) : null;
    const approved = access?.config.kind === 'vercel' ? access.config : null;
    if (access && approved) {
      access.authorize('deployments:read');
      if (!this.d.egress.allowed.includes(approved.host)) return { state: 'unchecked', source: 'refused', detail: `${approved.host} is not on the egress allowlist. No request was sent.` };
      const token = await getSecret('vercel', this.d.baseEnv());
      if (!token) return { state: 'unchecked', source: 'refused', detail: 'No Vercel token is in the Keychain. No request was sent.' };
      this.d.addSecret(token);
      return readVercel(this.d.egress.fetch, liveOrigin('vercel', approved.host), approved.project, { live: true, headers: { authorization: `Bearer ${token}` }, capabilities: approved.capabilities, authorize: access.authorize });
    }
    if (!cfg?.fixture_base) return { state: 'unchecked', source: 'unconfigured', detail: 'Vercel reachability remains unknown. Approve a matching read in Decisions, then choose Read now. No request was sent.' };
    return readVercel(this.d.egress.fetch, cfg.fixture_base, cfg.project);
  }
}

function unknownDrift(repo: string[], detail: string): MigrationDrift {
  return { ...compareMigrations(repo, null, 'none'), detail };
}

function supabaseVersions(ids: string[], hashes: Record<string, string>): { ids: string[]; hashes: Record<string, string> } {
  const version = (id: string) => id.match(/^([0-9]{8,20})(?:_|$)/)?.[1] ?? id;
  return { ids: ids.map(version), hashes: Object.fromEntries(Object.entries(hashes).map(([id, hash]) => [version(id), hash])) };
}

function appliedFromRows(rows: unknown[]): { ids: string[]; hashes: Record<string, string>; valid: boolean } {
  const ids: string[] = [];
  const hashes: Record<string, string> = {};
  let valid = true;
  for (const row of rows) {
    const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const id = typeof r.version === 'string' ? r.version.trim() : '';
    if (!id || ids.includes(id)) { valid = false; continue; }
    ids.push(id);
    const hash = r.hash ?? r.checksum;
    if (typeof hash === 'string' && hash) hashes[id] = hash;
  }
  return { ids, hashes, valid };
}

export function summarizeWorkbench(status: { availability?: { engine?: boolean; error?: string | null }; services?: ServiceLike[] }): { docker: InfraHealthReport['docker']; postgres: InfraHealthReport['postgres'] } {
  const engine = status.availability?.engine === true;
  const services = status.services ?? [];
  let docker: InfraHealthReport['docker'];
  if (!engine) docker = { state: 'unavailable', detail: status.availability?.error || 'Docker is not available. Nothing is reported healthy.' };
  else if (services.length === 0) docker = { state: 'unknown', detail: 'Docker is available. No project services are declared, so nothing is reported healthy.' };
  else if (services.some((s) => s.readiness === 'unhealthy' || s.container?.state === 'paused')) docker = { state: 'degraded', detail: 'A project service is unhealthy or paused.' };
  else if (services.every((s) => s.readiness === 'ready')) docker = { state: 'ready', detail: 'Every declared service is healthy.' };
  else docker = { state: 'unknown', detail: 'Docker is available, but not every declared service is healthy, so the project is not reported ready.' };

  const pg = services.find((s) => s.source === 'database' || /postgres/i.test(s.image ?? '') || /postgres/i.test(s.name));
  let postgres: InfraHealthReport['postgres'];
  if (!pg) postgres = { state: 'unknown', service: null, detail: engine ? 'No local Postgres service is declared for this project.' : 'Local Postgres was not checked because Docker is unavailable.' };
  else if (pg.container?.state === 'paused') postgres = { state: 'paused', service: pg.name, detail: `Database service ${pg.name} is paused.` };
  else if (pg.readiness === 'ready') postgres = { state: 'ready', service: pg.name, detail: `Database service ${pg.name} is healthy.` };
  else if (pg.readiness === 'unhealthy') postgres = { state: 'unhealthy', service: pg.name, detail: pg.readinessDetail || `Database service ${pg.name} is unhealthy.` };
  else if (pg.readiness === 'stopped') postgres = { state: 'stopped', service: pg.name, detail: pg.readinessDetail || `Database service ${pg.name} is stopped.` };
  else if (pg.readiness === 'not-created') postgres = { state: 'missing', service: pg.name, detail: `Database service ${pg.name} has no container yet.` };
  else postgres = { state: 'unknown', service: pg.name, detail: pg.readinessDetail || `Database service ${pg.name} is ${pg.readiness ?? 'unchecked'}.` };
  return { docker, postgres };
}
