// SPDX-License-Identifier: Apache-2.0
// In-process fixtures only: no daemon start, CLI login, Keychain access or live provider traffic.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentActor, RELEASE_CONNECTOR_DEFAULTS } from '@acc/core';
import { Daemon } from '../src/daemon.ts';
import { readGitHub } from '../src/adapters/hosts/github.ts';
import { readGitLab } from '../src/adapters/hosts/gitlab.ts';
import { readVercel } from '../src/infra/vercel.ts';
import { makeConfig, tmpDir } from './helpers.ts';

const daemons: Daemon[] = [];
afterEach(() => { for (const d of daemons.splice(0)) { d.closed = true; d.store.close(); } });
function fixture(over: Record<string, unknown> = {}, response?: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const repo = tmpDir('release-connectors-repo');
  const d = new Daemon({ config: makeConfig(repo, over), dataDir: tmpDir('release-connectors-data'), allowTempDataDir: true,
    baseEnv: { ACC_SECRET_GITHUB: 'fixture-only', ACC_SECRET_GITLAB: 'fixture-only', ACC_SECRET_VERCEL: 'fixture-only', ACC_SECRET_SUPABASE: 'fixture-only' },
    fetch: async (url, init) => { calls.push({ url, init }); return response ? response(url, init) : new Response('{}', { status: 403 }); },
  });
  daemons.push(d);
  d.environment.status = async () => ({ availability: { engine: false, error: 'fixture: no Docker probe' }, services: [] }) as unknown as Awaited<ReturnType<typeof d.environment.status>>;
  return { d, calls, repo };
}
async function approve(d: Daemon, id: string) {
  const request = d.connectors.requestActivation(id, 'read');
  expect(request.decision).not.toBeNull();
  const prep = d.decisions.prepare(request.decision!.id, 'approve');
  await d.decisions.respond(request.decision!.id, 'approve', { channel: 'web', nonce: prep.nonce });
  return request.decision!;
}
const json = (body: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status: 200, headers });

describe('release connector Decision activation', () => {
  it('raw activated flags, drafts, local checks and approval alone never send provider requests', async () => {
    const { d, calls } = fixture({
      code_host: { provider: 'github', repo: 'owner/repo', activated: true, host: 'api.github.com', scopes: ['repo:read'] },
      infra: { vercel: { project: 'prj_fixture', activated: true, host: 'api.vercel.com', scopes: ['deployments:read'] }, supabase: { project_ref: 'fixture', activated: true, host: 'api.supabase.com', scopes: ['database:read'] } },
    });
    expect((await d.hosts.refresh({ live: true })).protected).toBeNull();
    const unknown = await d.infra.refresh({ live: true });
    expect(unknown.vercel.state).toBe('unchecked');
    expect(unknown.migrations.state).toBe('unchecked');
    expect(calls).toEqual([]);
    const draft = d.connectors.save({ id: 'github-read', name: 'GitHub read', config: d.connectors.defaults().github }, null);
    expect(draft.state).toBe('draft');
    expect((await d.connectors.check(draft.id)).availability.status).toBe('not_checked');
    await expect(d.connectors.readRelease(draft.id)).rejects.toThrow(/human must approve/i);
    const pending = d.connectors.requestActivation(draft.id, 'read');
    expect(pending.decision!.question).toContain('api.github.com');
    expect(pending.decision!.question).toContain('repo:read');
    expect(pending.decision!.question).toContain(d.config.project.repo);
    await expect(d.decisions.respond(pending.decision!.id, 'approve', {}, agentActor('claude'))).rejects.toThrow(/human owner/i);
    const prep = d.decisions.prepare(pending.decision!.id, 'approve');
    await d.decisions.respond(pending.decision!.id, 'approve', { nonce: prep.nonce });
    await expect(d.decisions.respond(pending.decision!.id, 'approve', { nonce: prep.nonce })).rejects.toThrow(/already answered/);
    expect(d.connectors.releaseAccess('github')).not.toBeNull();
    expect(d.connectors.approvedReleaseConfig().code_host?.activated).toBe(true);
    expect(d.config.code_host?.activated).toBe(true); // Raw flags are preserved, never used as approval.
    await d.hosts.refresh();
    await d.infra.refresh();
    expect(calls).toEqual([]);
  });

  it('reads with raw activation false, enforces individual capabilities, and invalidates on project/config mutation', async () => {
    const { d, calls } = fixture({ code_host: { provider: 'github', repo: 'owner/repo', activated: false, host: 'api.github.com', scopes: ['repo:read'] } }, async url => {
      if (url.endsWith('/commits/main')) return json({ sha: 'exact-tip' });
      if (url.endsWith('/check-runs')) return json({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
      throw new Error('Unapproved endpoint called');
    });
    d.connectors.save({ id: 'github-read', name: 'GitHub', config: { ...d.connectors.defaults().github, capabilities: ['checks:read'] } }, null);
    await approve(d, 'github-read');
    const result = await d.connectors.readRelease('github-read');
    expect('source' in result.result && result.result.source).toBe('live');
    expect(calls.map(c => new URL(c.url).pathname)).toEqual(['/repos/owner/repo/commits/main', '/repos/owner/repo/commits/exact-tip/check-runs']);
    expect(calls.every(c => c.init?.method === 'GET' && c.init.redirect === 'error')).toBe(true);
    expect(d.state.codeHost?.protected).toBeNull();
    expect(d.state.codeHost?.checks[0].status).toBe('passed');
    expect(d.config.code_host?.activated).toBe(false);
    expect(d.connectors.approvedReleaseConfig().code_host?.activated).toBe(true);
    expect(d.connectors.releaseReadCurrent('github', 'checks:read')).toBe(true);
    expect(d.connectors.releaseReadCurrent('github', 'branch-protection:read')).toBe(false);
    const access = d.connectors.releaseAccess('github')!;
    d.config = { ...d.config, code_host: { ...d.config.code_host!, host: 'github.enterprise.example' } };
    expect(d.connectors.releaseAccess('github')).toBeNull();
    expect(d.connectors.approvedReleaseConfig().code_host?.activated).toBe(false);
    expect(d.connectors.releaseReadCurrent('github', 'checks:read')).toBe(false);
    expect(() => access.authorize('checks:read')).toThrow(/changed/);
    await expect(d.connectors.readRelease('github-read')).rejects.toThrow(/approve/);
    const view = d.connectors.list().connections[0];
    expect(view).toMatchObject({ state: 'draft', bindingCurrent: false, readCurrent: false });
    expect(() => d.connectors.requestActivation(view.id, 'read')).toThrow(/settings/);
    expect(() => d.connectors.save({ id: view.id, name: view.name, config: view.config }, view.configHash)).toThrow(/differ/);
    const changed = d.connectors.save({ id: view.id, name: view.name, config: { ...view.config, host: 'github.enterprise.example' } }, view.configHash);
    expect(changed.configHash).not.toBe(view.configHash);
    const pending = d.connectors.requestActivation(view.id, 'read');
    d.config = { ...d.config, project: { ...d.config.project, production_branch: 'release' } };
    await expect(d.connectors.resolve(pending.decision!.id, 'approve')).rejects.toThrow(/project changed/);
    expect(calls).toHaveLength(2);
  });

  it('stops before the next request when Settings changes during an in-flight read', async () => {
    const { d, calls } = fixture({ code_host: { provider: 'github', repo: 'owner/repo', host: 'api.github.com', scopes: ['repo:read'] } }, async () => {
      d.config = { ...d.config, project: { ...d.config.project, name: 'changed-during-read' } };
      return json({ required_status_checks: {} });
    });
    d.connectors.save({ id: 'github-read', name: 'GitHub', config: d.connectors.defaults().github }, null);
    await approve(d, 'github-read');
    await expect(d.connectors.readRelease('github-read')).rejects.toThrow(/changed/);
    expect(calls).toHaveLength(1);
    expect(d.state.codeHost?.protected).toBeNull();
    expect(d.state.codeHost?.checks).toEqual([]);
  });

  it('reads Vercel and Supabase independently and never turns activation into a background read', async () => {
    const { d, calls, repo } = fixture({ infra: { vercel: { project: 'prj_fixture', host: 'api.vercel.com', scopes: ['deployments:read'] }, supabase: { project_ref: 'fixture', host: 'api.supabase.com', scopes: ['database:read'] } } }, async url => {
      return new URL(url).host === 'api.vercel.com' ? json({ deployments: [{ uid: 'dpl_fixture', readyState: 'READY' }] }) : json([{ version: '20260101', name: 'init' }]);
    });
    fs.mkdirSync(path.join(repo, 'supabase/migrations'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'supabase/migrations/20260101_init.sql'), '-- fixture migration\n');
    for (const kind of ['vercel', 'supabase'] as const) {
      d.connectors.save({ id: `${kind}-read`, name: kind, config: d.connectors.defaults()[kind] }, null);
      await approve(d, `${kind}-read`);
    }
    await d.infra.refresh();
    expect(calls).toEqual([]);
    await d.connectors.readRelease('vercel-read');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.vercel.com/v7/deployments?projectId=prj_fixture&limit=5');
    await d.connectors.readRelease('supabase-read');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://api.supabase.com/v1/projects/fixture/database/migrations');
    expect(d.state.infra?.migrations).toMatchObject({ state: 'in_sync', source: 'live' });
    expect(d.state.infra?.migrations.detail).toContain('Hash comparison unavailable');
    expect(d.connectors.releaseReadCurrent('vercel', 'deployments:read')).toBe(true);
    expect(d.connectors.releaseReadCurrent('supabase', 'migrations:read')).toBe(true);
    expect(d.connectors.approvedReleaseConfig().infra?.vercel?.activated).toBe(true);
    expect(d.connectors.approvedReleaseConfig().infra?.supabase?.activated).toBe(true);
    expect(d.config.infra?.supabase?.activated).toBe(false);
    expect(d.state.infra?.migrations.repo).toEqual(['20260101']);
    d.connectors.setDisabled('supabase-read', true);
    expect(d.connectors.releaseAccess('supabase')).toBeNull();
    await expect(d.connectors.readRelease('supabase-read')).rejects.toThrow(/approve/);
    expect(calls).toHaveLength(2);
  });

  it('distinguishes an approved migration read failure from a revoked read', async () => {
    const over = { infra: { supabase: { project_ref: 'fixture', host: 'api.supabase.com', scopes: ['database:read'] } } };
    const failed = fixture(over);
    failed.d.connectors.save({ id: 'db-read', name: 'Database', config: failed.d.connectors.defaults().supabase }, null);
    await approve(failed.d, 'db-read');
    await failed.d.connectors.readRelease('db-read');
    expect(failed.calls).toHaveLength(1);
    expect(failed.d.state.infra?.migrations).toMatchObject({ state: 'error', source: 'live' });
    expect(failed.d.state.infra?.migrations.detail).toContain('403');

    let revoke: (() => void) | undefined;
    const revoked = fixture(over, async () => { revoke!(); return json([]); });
    revoked.d.connectors.save({ id: 'db-read', name: 'Database', config: revoked.d.connectors.defaults().supabase }, null);
    await approve(revoked.d, 'db-read');
    revoke = () => revoked.d.connectors.setDisabled('db-read', true);
    await expect(revoked.d.connectors.readRelease('db-read')).rejects.toThrow(/disabled|changed|approval/);
    expect(revoked.calls).toHaveLength(1);
    expect(revoked.d.state.infra?.migrations).toMatchObject({ state: 'unchecked', source: 'none' });
  });

  it('requires a binding for direct live adapters and treats GitHub 404 and paginated GitLab protection as unknown', async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => { calls.push(url); return json([]); };
    await expect(readGitHub(fetch, 'https://api.github.com', 'owner/repo', 'main', { live: true })).rejects.toThrow(/Decision/);
    await expect(readGitLab(fetch, 'https://gitlab.com', 'owner/repo', 'main', { live: true })).rejects.toThrow(/Decision/);
    expect((await readVercel(fetch, 'https://api.vercel.com', 'prj_fixture', { live: true })).source).toBe('refused');
    expect(calls).toEqual([]);
    const opt = { live: true, capabilities: ['branch-protection:read'] as const, authorize: () => {} };
    const gh = await readGitHub(async () => new Response('{}', { status: 404 }), 'https://api.github.com', 'owner/repo', 'main', opt);
    expect(gh.protected).toBeNull();
    const gl = await readGitLab(async () => json([{ name: 'release/*' }]), 'https://gitlab.com', 'owner/repo', 'release/one', opt);
    expect(gl.protected).toBe(true);
    const paginated = await readGitLab(async () => json([{ name: 'other' }], { 'x-next-page': '2' }), 'https://gitlab.com', 'owner/repo', 'main', opt);
    expect(paginated.protected).toBeNull();
    expect(RELEASE_CONNECTOR_DEFAULTS.github.kind).toBe('github');
  });
});
