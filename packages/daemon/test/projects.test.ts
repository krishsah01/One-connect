// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { executeClone, executeGitInit, parseCloneUrl, planClone, planGitInit } from '../src/projects/clone.ts';
import { inspectProject } from '../src/projects/inspect.ts';
import { prepareProject } from '../src/projects/prepare.ts';
import { git, makeConfig, makeRepo, ROOT, startDaemon, tmpDir, type Harness } from './helpers.ts';

const harnesses: Harness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.close(); });

const real = (p: string) => fs.realpathSync(p);
/** A repository whose manifests declare checks and services. Executing any script would leave EXECUTED behind. */
function appRepo(): string {
  const dir = tmpDir('app');
  const marker = "node -e \"require('fs').writeFileSync('EXECUTED','x')\"";
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/Shop-App', scripts: { test: marker, lint: marker, build: marker, postinstall: marker }, dependencies: { next: '1', react: '1', pg: '1' }, devDependencies: { vitest: '1' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:24\n');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'check:\n\techo hi\n');
  fs.writeFileSync(path.join(dir, 'compose.yaml'), [
    'name: Shop App',
    'services:',
    '  web: { build: ., ports: ["3000:3000"], depends_on: [db] }',
    '  db:',
    '    image: postgres:16-alpine',
    '    ports: ["127.0.0.1:5432:5432"]',
    '    volumes: ["pgdata:/var/lib/postgresql/data", "./seed:/seed"]',
    '    healthcheck: { test: ["CMD", "pg_isready"] }',
    '  cache: { image: "redis:7", ports: ["${REDIS_PORT:-6379}:6379"] }',
    'volumes: { pgdata: {} }',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const ok = true;\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return real(dir);
}

describe('project intake', () => {
  it('describes declared frameworks, checks and Compose services without executing scripts', async () => {
    const repo = appRepo();
    const i = await inspectProject(repo);
    expect(i.path).toBe(repo);
    expect(i.name).toBe('shop-app');
    expect(i.git).toMatchObject({ state: 'clean', root: repo, branch: 'main', integrationBranch: null });
    expect(i.intake).toMatchObject({ indexable: true, ref: 'HEAD', revision: git(repo, 'rev-parse', 'HEAD') });
    expect(i.frameworks).toEqual(expect.arrayContaining(['Node.js', 'Next.js', 'React', 'PostgreSQL client', 'Vitest']));
    expect(i.packageManager).toBe('pnpm');
    expect(i.checks.map(c => [c.name, c.command])).toEqual([['test', 'pnpm run test'], ['lint', 'pnpm run lint'], ['build', 'pnpm run build'], ['check', 'make check']]);
    expect(i.compose?.project).toBe('shopapp');
    expect(i.compose?.services.find(s => s.name === 'db')).toMatchObject({ image: 'postgres:16-alpine', healthcheck: true, volumes: ['pgdata'], ports: [{ hostIp: '127.0.0.1', host: 5432, container: 5432 }] });
    expect(i.compose?.services.find(s => s.name === 'web')).toMatchObject({ build: true, dependsOn: ['db'] });
    expect(i.warnings.join(' ')).toMatch(/cache: a published port uses interpolation/);
    expect(i.dockerfiles).toEqual(['Dockerfile']);
    expect(fs.existsSync(path.join(repo, 'EXECUTED'))).toBe(false);
  });

  it('labels dirty, uncommitted and uninitialized folders with explicit onboarding steps', async () => {
    const repo = appRepo();
    fs.appendFileSync(path.join(repo, 'src', 'index.js'), 'export const dirty = 1;\n');
    fs.writeFileSync(path.join(repo, 'notes.md'), 'draft\n');
    const dirty = await inspectProject(repo);
    expect(dirty.git).toMatchObject({ state: 'dirty', dirtyFiles: 1, untrackedFiles: 1 });
    expect(dirty.intake.indexable).toBe(true);
    expect(dirty.intake.message).toMatch(/1 changed and 1 untracked files are excluded/);
    expect(dirty.intake.steps[0].id).toBe('commit-changes');

    const empty = real(tmpDir('empty-repo'));
    git(empty, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(empty, 'a.txt'), 'a');
    const fresh = await inspectProject(empty);
    expect(fresh.git.state).toBe('no_commits');
    expect(fresh.intake).toMatchObject({ indexable: false, revision: null });
    expect(fresh.intake.steps.map(s => s.id)).toEqual(['first-commit']);

    const plain = real(tmpDir('plain'));
    const none = await inspectProject(plain);
    expect(none.git.state).toBe('not_git');
    expect(none.intake.steps[0]).toMatchObject({ id: 'git-init', runIn: 'approved-action' });
    await expect(prepareProject(plain, tmpDir('cfg'))).rejects.toThrow(/Initialize Git/);
    const plan = await planGitInit(plain);
    expect(plan.argv).toEqual(expect.arrayContaining(['init', '-b', 'main', '--', plain, 'core.hooksPath=/dev/null']));
    await expect(executeGitInit(plain, 'f'.repeat(64))).rejects.toThrow(/no longer matches/);
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
    expect((await executeGitInit(plain, plan.digest)).git.state).toBe('no_commits');
    await expect(planGitInit(plain)).rejects.toThrow(/already a Git repository/);
  });

  it('binds exactly one repository root and refuses unrelated folders', async () => {
    const repo = appRepo();
    const sub = (await inspectProject(path.join(repo, 'src'))).git;
    expect(sub).toMatchObject({ state: 'not_root', root: repo });
    await expect(prepareProject(path.join(repo, 'src'), tmpDir('cfg'))).rejects.toThrow(/repository root/);
    await expect(inspectProject(os.homedir())).rejects.toThrow(/whole home folder/);
    await expect(inspectProject('/')).rejects.toThrow(/disk/);
    await expect(inspectProject('relative/path')).rejects.toThrow(/absolute/);
    await expect(inspectProject(path.join(repo, 'package.json'))).rejects.toThrow(/not a file/);
    await expect(inspectProject(path.join(os.homedir(), 'Library'))).rejects.toThrow(/credential data|System/);
  });

  it('writes a private generated config outside the repository, or uses a repository config only when it binds this folder', async () => {
    const repo = appRepo();
    const configDir = tmpDir('configs');
    const p = await prepareProject(repo, configDir);
    expect(p.generated).toBe(true);
    expect(p.config.startsWith(real(configDir))).toBe(true);
    expect(fs.statSync(p.config).mode & 0o777).toBe(0o600);
    const cfg = loadConfig(p.config);
    expect(cfg.project).toMatchObject({ name: 'shop-app', repo, docker_project: 'shopapp', integration_branch: 'integration', protected_branches: ['main'], required_checks: [] });
    expect(cfg.project.checks).toMatchObject({ test: 'pnpm run test', check: 'make check' });
    expect(cfg.agents.every(a => a.billing === 'subscription' && !a.on_demand && !a.metered_opt_in)).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect((await prepareProject(repo, configDir)).config).toBe(p.config);

    fs.writeFileSync(path.join(repo, 'control-center.yaml'), `project: { name: own, repo: . }\nagents: [{ id: a, name: A, role: engineer, adapter: relay }]\n`);
    expect(await prepareProject(repo, configDir)).toMatchObject({ generated: false, config: path.join(repo, 'control-center.yaml') });
    fs.writeFileSync(path.join(repo, 'control-center.yaml'), `project: { name: own, repo: ${os.tmpdir()} }\nagents: [{ id: a, name: A, role: engineer, adapter: relay }]\n`);
    await expect(prepareProject(repo, configDir)).rejects.toThrow(/points at/);
  });

  it('starts an added project and indexes its exact committed revision while excluding dirty work', async () => {
    const repo = appRepo();
    fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'export const secretDraft = "UNCOMMITTED_MARKER";\n');
    const p = await prepareProject(repo, tmpDir('configs'));
    const h = await startDaemon({ ...loadConfig(p.config), graphify: { enabled: false } as never }, { probe: false });
    harnesses.push(h);
    const status = h.d.context.answer.status;
    expect(status.revision).toBe(p.inspection.intake.revision);
    expect(status.notesRevision).toBe(p.inspection.intake.revision);
    expect(['ready', 'partial']).toContain(status.state);
    const notesDir = path.join(h.d.context.vault!.root, h.d.context.vault!.notePath('Dictionary'));
    const notes = fs.readdirSync(notesDir).map(f => fs.readFileSync(path.join(notesDir, f), 'utf8')).join('\n');
    expect(notes).toContain('export const ok = true;');
    expect(notes).not.toContain('UNCOMMITTED_MARKER');
    expect(h.d.environment.project).toBe('shopapp');
  });

  it('exposes onboarding through the authenticated project API', async () => {
    const repo = appRepo();
    const h = await startDaemon(makeConfig(repo), { probe: false });
    harnesses.push(h);
    expect((await fetch(`${h.url}/api/project/onboarding`)).status).toBe(401);
    const token = fs.readFileSync(h.d.paths.installToken, 'utf8').trim();
    const r = await (await fetch(`${h.url}/api/project/onboarding`, { headers: { authorization: `Bearer ${token}` } })).json() as { inspection: { path: string; compose: { project: string } }; answer: { state: string } };
    expect(r.inspection.path).toBe(repo);
    expect(r.answer.state).toBeTruthy();
  });
});

describe('clone planning', () => {
  it('validates URLs and destinations before any outbound action', () => {
    const parent = real(tmpDir('parent'));
    expect(parseCloneUrl('https://github.com/acme/shop.git')).toMatchObject({ network: true, name: 'shop' });
    expect(parseCloneUrl('git@github.com:acme/shop.git')).toMatchObject({ network: true, name: 'shop' });
    expect(parseCloneUrl('ssh://git@host.example/acme/shop')).toMatchObject({ network: true, name: 'shop' });
    for (const bad of ['https://user:token@github.com/a/b.git', 'ext::sh -c touch% /tmp/pwned', '-uhttps://x/y', 'http://github.com/a/b', 'https://github.com/a/b?x=1', 'file:///does/not/exist', 'two words']) expect(() => parseCloneUrl(bad), bad).toThrow();
    fs.mkdirSync(path.join(parent, 'shop'));
    expect(() => planClone('https://github.com/acme/shop.git', parent)).toThrow(/already exists/);
    const plan = planClone('https://github.com/acme/shop.git', parent, 'shop-2');
    expect(plan).toMatchObject({ kind: 'clone', network: true, target: path.join(parent, 'shop-2') });
    expect(plan.argv.slice(-4)).toEqual(['--no-recurse-submodules', '--', 'https://github.com/acme/shop.git', path.join(parent, 'shop-2')]);
    expect(plan.argv).toContain('core.hooksPath=/dev/null');
    expect(planClone('https://github.com/acme/shop.git', parent, 'shop-2').digest).toBe(plan.digest);
    expect(planClone('https://github.com/acme/other.git', parent, 'shop-2').digest).not.toBe(plan.digest);
  });

  it('clones a local repository only with the approved plan digest', async () => {
    const source = makeRepo();
    const bare = path.join(tmpDir('bare'), 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', source, bare]);
    const parent = real(tmpDir('parent'));
    const plan = planClone(`file://${bare}`, parent);
    expect(plan).toMatchObject({ network: false, target: path.join(parent, 'origin') });
    await expect(executeClone(`file://${bare}`, parent, undefined, planClone(`file://${bare}`, parent, 'other').digest)).rejects.toThrow(/no longer matches/);
    expect(fs.existsSync(plan.target)).toBe(false);
    const cloned = await executeClone(`file://${bare}`, parent, undefined, plan.digest);
    expect(cloned.git).toMatchObject({ state: 'clean', root: plan.target, head: git(source, 'rev-parse', 'HEAD') });
    await expect(executeClone(`file://${bare}`, parent, undefined, plan.digest)).rejects.toThrow(/already exists/);
  });

  it('gives the native shell a JSON command contract', () => {
    const repo = appRepo();
    const cli = path.join(ROOT, 'packages', 'daemon', 'src', 'cli.ts');
    const ok = spawnSync(process.execPath, [cli, 'project', 'inspect', '--dir', repo], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, inspection: { path: repo, git: { state: 'clean' } } });
    const bad = spawnSync(process.execPath, [cli, 'project', 'clone-plan', '--url', 'https://u:p@github.com/a/b', '--parent', repo], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/credentials/) });
  });
});

describe('multiple projects', () => {
  it('keeps tokens, tickets, state and kill switches separate per project daemon', async () => {
    const a = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const b = await startDaemon(makeConfig(makeRepo(), { project: { name: 'other', repo: makeRepo(), integration_branch: 'integration', protected_branches: ['main'] } }), { probe: false });
    harnesses.push(a, b);
    const token = (h: Harness) => fs.readFileSync(h.d.paths.installToken, 'utf8').trim();
    expect(token(a)).not.toBe(token(b));
    const get = (h: Harness, t: string) => fetch(`${h.url}/api/state`, { headers: { authorization: `Bearer ${t}` } });
    expect((await get(b, token(a))).status).toBe(401);
    const sa = await (await get(a, token(a))).json() as { state: { project: { name: string; repo: string } } };
    const sb = await (await get(b, token(b))).json() as { state: { project: { name: string; repo: string } } };
    expect(sa.state.project.repo).not.toBe(sb.state.project.repo);
    const { ticket } = await (await fetch(`${a.url}/api/auth/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${token(a)}` } })).json() as { ticket: string };
    const opened = await new Promise<boolean>(resolve => {
      const ws = new WebSocket(`${b.url.replace('http:', 'ws:')}/ws?ticket=${ticket}`);
      ws.once('open', () => { ws.terminate(); resolve(true); });
      ws.once('unexpected-response', (_q, r) => { r.resume(); ws.terminate(); resolve(false); });
      ws.once('error', () => resolve(false));
    });
    expect(opened).toBe(false);
    await a.d.setKillSwitch(true);
    expect(a.d.state.killSwitch.engaged).toBe(true);
    expect(b.d.state.killSwitch.engaged).toBe(false);
  });
});
