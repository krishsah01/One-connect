// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Repo migration filenames compared with a database history that was actually read.
// Missing history is unchecked, never "in sync".
import fs from 'node:fs';
import path from 'node:path';
import type { MigrationDrift } from '@acc/core';
import { sha256 } from '../util/hash.ts';

export const MIGRATION_QUERIES = [
  'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
  'SELECT migration_name FROM _prisma_migrations ORDER BY migration_name',
] as const;

export function migrationHash(content: Buffer | string): string {
  return sha256(content);
}

export function listRepoMigrations(repo: string, extraDir?: string): string[] {
  return listRepoMigrationFiles(repo, extraDir).ids;
}

export function listRepoMigrationFiles(repo: string, extraDir?: string, onlyDirs?: readonly string[]): { ids: string[]; hashes: Record<string, string>; error?: string } {
  let root: string;
  try { root = fs.realpathSync(repo); } catch { return { ids: [], hashes: {}, error: 'The configured repository could not be read. Migration drift remains unknown.' }; }
  const rels = new Set<string>(onlyDirs ?? ['supabase/migrations', 'prisma/migrations']);
  if (extraDir && !extraDir.startsWith('/') && !extraDir.split('/').some((p) => p === '..' || p === '.' || !p)) rels.add(extraDir);
  const hashes: Record<string, string> = {};
  for (const rel of rels) {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    if (!fs.existsSync(abs)) continue;
    const within = (p: string) => { const real = fs.realpathSync(p); return real.startsWith(root + path.sep); };
    if (!within(abs)) return { ids: [], hashes: {}, error: 'A migration folder resolves outside this project. Migration drift remains unknown.' };
    for (const name of fs.readdirSync(abs)) {
      if (name.startsWith('.')) continue;
      const p = path.join(abs, name);
      let st: fs.Stats;
      try {
        if (!within(p)) return { ids: [], hashes: {}, error: 'A migration file resolves outside this project. Migration drift remains unknown.' };
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isFile() && name.endsWith('.sql')) hashes[name.replace(/\.sql$/, '')] = migrationHash(fs.readFileSync(p));
      else if (st.isDirectory() && fs.existsSync(path.join(p, 'migration.sql'))) {
        const file = path.join(p, 'migration.sql');
        if (!within(file)) return { ids: [], hashes: {}, error: 'A migration file resolves outside this project. Migration drift remains unknown.' };
        hashes[name] = migrationHash(fs.readFileSync(file));
      }
    }
  }
  return { ids: Object.keys(hashes).sort(), hashes };
}

export function compareMigrations(repo: string[], applied: string[] | null, source: MigrationDrift['source'], detail?: string, hashes?: { repo: Record<string, string>; applied: Record<string, string> }): MigrationDrift {
  if (applied === null) {
    const state = source === 'none' ? 'unchecked' : 'error';
    const fallback = state === 'unchecked'
      ? 'Migration history was not read, so drift is unchecked.'
      : 'Migration history could not be read after an approved or configured database request.';
    return { state, source, repo, applied: [], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: detail ?? fallback };
  }
  const have = new Set(applied);
  const want = new Set(repo);
  const missingInDatabase = repo.filter((id) => !have.has(id));
  const extraInDatabase = applied.filter((id) => !want.has(id));
  const hashMismatch = hashes
    ? repo.filter((id) => hashes.repo[id] && hashes.applied[id] && hashes.repo[id] !== hashes.applied[id])
    : [];
  const hashesCompared = Boolean(hashes && Object.keys(hashes.applied).length > 0);
  const drift = missingInDatabase.length > 0 || extraInDatabase.length > 0 || hashMismatch.length > 0;
  const where = source === 'local_postgres' ? 'local Postgres' : source === 'fixture' ? 'the database fixture' : source === 'live' ? 'the remote database' : 'the database';
  const parts = [
    `${missingInDatabase.length} repo migration${missingInDatabase.length === 1 ? '' : 's'} missing from ${where}`,
    `${extraInDatabase.length} applied there ${extraInDatabase.length === 1 ? 'is' : 'are'} not in the repo`,
    hashMismatch.length ? `${hashMismatch.length} hash mismatch${hashMismatch.length === 1 ? '' : 'es'}` : '',
  ].filter(Boolean);
  const hashNote = hashesCompared ? '' : ' Hash comparison unavailable.';
  return {
    state: drift ? 'drift' : 'in_sync',
    source,
    repo,
    applied,
    missingInDatabase,
    extraInDatabase,
    hashMismatch,
    detail: (drift ? `${parts.join('; ')}.` : `Repo migrations match ${where} (${repo.length}).`) + (applied.length || repo.length ? hashNote : ''),
  };
}

/** Compose exec of a fixed SELECT. The SQL is one of MIGRATION_QUERIES, never caller text. */
export function psqlReadArgv(shell: readonly string[], sql: (typeof MIGRATION_QUERIES)[number]): string[] {
  if (!(MIGRATION_QUERIES as readonly string[]).includes(sql)) throw new Error('Refusing a migration query that is not a fixed SELECT.');
  const execAt = shell.lastIndexOf('exec');
  if (shell[0] !== 'docker' || execAt < 0) throw new Error('Refusing a database command that is not this project’s Compose exec.');
  return [...shell.slice(0, execAt + 1), '-T', ...shell.slice(execAt + 1), '-c', sql, '-tA'];
}

export function parseMigrationRows(stdout: string): string[] {
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('(') && !/^ERROR:/i.test(l));
}
