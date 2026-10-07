// SPDX-License-Identifier: Apache-2.0
// Docker workbench against a protocol fixture: a fake `docker` that answers the exact CLI
// shapes the workbench uses. No real engine, image or container is involved.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { dockerIgnore, readScopedBytes } from '../src/environment/compose.ts';
import type { ExecResult } from '../src/exec.ts';
import * as execution from '../src/exec.ts';
import { ProjectEnvironment, type DockerExec } from '../src/environment/workbench.ts';
import { parseDatabaseSpec } from '../src/environment/database.ts';
import { git, makeConfig, startDaemon, tmpDir, type Harness } from './helpers.ts';

/** The real two-step approval: confirmation step (single-use nonce) for irreversible/network actions, then resolve. */
async function approveWith<E extends { resolve(id: string, a: string, dg: string, o?: { nonce?: string | null }): Promise<unknown> }>(env: E, decisionId: string, digest: string): Promise<Awaited<ReturnType<E['resolve']>>> {
  const w = env as unknown as { d: { decisions: { prepare(id: string, answer: string): { nonce: string | null } } } };
  let nonce: string | null = null;
  try {
    nonce = w.d.decisions.prepare(decisionId, 'approve').nonce;
  } catch {
    /* already answered / unknown: resolve reports the real error */
  }
  return env.resolve(decisionId, 'approve', digest, { nonce }) as Promise<Awaited<ReturnType<E['resolve']>>>;
}

let h: Harness | undefined;
const environments: ProjectEnvironment[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const env of environments.splice(0)) await env.close(); await h?.close(); h = undefined; });

interface FakeContainer { id: string; name: string; project: string; service: string; workingDir: string; status: string; health?: string; healthLog?: string; image: string; ports?: string }
class FakeDocker {
  calls: string[][] = [];
  containers: FakeContainer[] = [];
  images = new Set<string>(['postgres:16-alpine']);
  engine = true;
  installed = true;
  endpoint = 'unix:///var/run/docker.sock';
  logs = '';
  hold: Promise<void> | null = null;
  beforeMutation: ((args: string[]) => void) | null = null;
  beforeAvailability: (() => void) | null = null;
  failure: 'throw' | 'timeout' | null = null;
  exec: DockerExec = async (args, o) => {
    this.calls.push(args);
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });
    if (!this.installed) return { code: null, stdout: '', stderr: '', timedOut: false, error: 'spawn docker ENOENT' };
    if (args[0] === 'version') this.beforeAvailability?.();
    if (args[0] === 'version') return this.engine ? ok(JSON.stringify({ Client: { Version: '29.0.0' }, Server: { Version: '29.0.0' } })) : { code: 1, stdout: JSON.stringify({ Client: { Version: '29.0.0' }, Server: null }), stderr: 'Cannot connect', timedOut: false };
    if (args[0] === 'context') return ok(JSON.stringify(this.endpoint));
    if (args[0] === 'compose' && args[1] === 'version') return ok('2.40.0\n');
    if (args[0] === 'ps' && args.includes('-a')) {
      const label = args[args.indexOf('--filter') + 1].split('=')[2];
      return ok(this.containers.filter(c => c.project === label).map(c => c.id).join('\n'));
    }
    if (args[0] === 'ps') return ok(this.containers.filter(c => c.status === 'running').map(c => JSON.stringify({ ID: c.id.slice(0, 12), Names: c.name, Ports: c.ports ?? '' })).join('\n'));
    if (args[0] === 'inspect') return ok(JSON.stringify(args.slice(3).map(id => this.containers.find(c => c.id === id)!).map(c => ({ Id: c.id, Name: `/${c.name}`, Config: { Image: c.image, Labels: { 'com.docker.compose.project': c.project, 'com.docker.compose.service': c.service, 'com.docker.compose.project.working_dir': c.workingDir } }, State: { Status: c.status, StartedAt: '2026-10-06T00:00:00Z', ...(c.health ? { Health: { Status: c.health, Log: [{ Output: c.healthLog ?? '' }] } } : {}) } }))));
    if (args[0] === 'image') return this.images.has(args.at(-1)!) ? ok('sha256:abc') : { code: 1, stdout: '', stderr: 'No such image', timedOut: false };
    if (args[0] === 'compose' && args.includes('logs')) return ok(this.logs);
    this.beforeMutation?.(args);
    if (this.failure === 'throw') throw new Error('fixture spawn error');
    if (this.failure === 'timeout') return { code: null, stdout: '', stderr: '', timedOut: true };
    if (this.hold) { await new Promise<void>(resolve => { o?.signal?.addEventListener('abort', () => resolve()); void this.hold!.then(resolve); }); return { code: o?.signal?.aborted ? null : 0, stdout: '', stderr: '', timedOut: false, error: o?.signal?.aborted ? 'aborted' : undefined }; }
    return ok('done');
  };
}

function composeRepo(): string {
  const dir = fs.realpathSync(tmpDir('compose-app'));
  fs.writeFileSync(path.join(dir, 'compose.yaml'), [
    'services:',
    '  db: { image: "postgres:16-alpine", ports: ["127.0.0.1:55432:5432"], healthcheck: { test: ["CMD", "pg_isready"] }, volumes: ["pgdata:/var/lib/postgresql/data"] }',
    '  web: { build: ., ports: ["3000:3000"] }',
    '  worker: { image: "acme/worker:missing", ports: ["8080:8080"] }',
    'volumes: { pgdata: {} }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\nCOPY . /app\n');
  fs.writeFileSync(path.join(dir, '.dockerignore'), '.git\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'compose');
  git(dir, 'branch', 'integration');
  return dir;
}

async function setup(o: { repo?: string; dataDir?: string; busyPorts?: number[] } = {}) {
  const repo = o.repo ?? composeRepo();
  h = await startDaemon(makeConfig(repo, { project: { name: 'Shop', repo, docker_project: 'shop', integration_branch: 'integration', protected_branches: ['main'] } }), { probe: false, server: false, dataDir: o.dataDir ?? tmpDir('data') });
  const docker = new FakeDocker();
  let now = 1_000_000;
  const env = new ProjectEnvironment(h.d, { exec: docker.exec, portProbe: async p => (o.busyPorts ?? []).includes(p), now: () => now });
  environments.push(env);
  return { repo, docker, env, advance: (ms: number) => { now += ms; } };
}

const ID = (n: number) => `${n}`.padStart(2, '0').repeat(32);

describe('Docker workbench', () => {
  it('reports missing Docker and a stopped engine honestly, without blocking reads of declared services', async () => {
    const { docker, env } = await setup();
    docker.installed = false;
    let s = await env.status();
    expect(s.availability).toMatchObject({ installed: false, engine: false });
    expect(s.availability.error).toMatch(/not installed/);
    expect(s.services.map(x => [x.name, x.readiness])).toEqual([['db', 'not-created'], ['web', 'not-created'], ['worker', 'not-created']]);
    docker.installed = true; docker.engine = false;
    expect((await env.status()).availability.installed).toBe(false);
    s = await env.status(true);
    expect(s.availability).toMatchObject({ installed: true, engine: false });
    expect((await env.request('restart', ['db'])).blockers[0]).toMatch(/engine is not running/);
  });

  it('shows only exactly bound containers with healthcheck readiness, missing images and port conflicts', async () => {
    const { repo, docker, env } = await setup({ busyPorts: [8080] });
    docker.containers = [
      { id: ID(1), name: 'shop-db-1', project: 'shop', service: 'db', workingDir: repo, status: 'running', health: 'healthy', healthLog: 'accepting connections', image: 'postgres:16-alpine', ports: '127.0.0.1:55432->5432/tcp' },
      { id: ID(2), name: 'shop-web-1', project: 'shop', service: 'web', workingDir: repo, status: 'exited', image: 'shop-web' },
      { id: ID(3), name: 'shop-db-1', project: 'shop', service: 'db', workingDir: '/elsewhere/shop', status: 'running', health: 'healthy', image: 'postgres:16' },
      { id: ID(4), name: 'unrelated-api', project: 'unrelated', service: 'api', workingDir: '/u', status: 'running', image: 'api', ports: '0.0.0.0:3000->3000/tcp' },
    ];
    const s = await env.status();
    expect(s.foreign).toEqual([{ id: ID(3).slice(0, 12), name: 'shop-db-1', workingDir: '/elsewhere/shop' }]);
    const by = Object.fromEntries(s.services.map(x => [x.name, x]));
    expect(by.db).toMatchObject({ readiness: 'ready', imagePresent: true, container: { id: ID(1).slice(0, 12), health: 'healthy', healthLog: 'accepting connections' }, volumes: ['shop_pgdata'] });
    expect(by.db.ports[0].conflict).toBeNull();
    expect(by.web).toMatchObject({ readiness: 'stopped', imagePresent: null });
    expect(by.web.ports[0].conflict).toMatch(/another container \(unrelated-api\)/);
    expect(by.worker).toMatchObject({ readiness: 'not-created', imagePresent: false });
    expect(by.worker.ports[0].conflict).toMatch(/in use by another process/);
    docker.containers[0].health = undefined;
    expect((await env.status()).services[0]).toMatchObject({ readiness: 'running-unchecked', readinessDetail: expect.stringMatching(/readiness is unknown/) });
    docker.containers[0].health = 'unhealthy';
    expect((await env.status()).services[0].readiness).toBe('unhealthy');
  });

  it('runs only the exact approved Compose command, once, before expiry, and never pulls implicitly', async () => {
    const { repo, docker, env, advance } = await setup();
    const blocked = await env.request('up', []);
    expect(blocked.decision).toBeNull();
    expect(blocked.blockers.join(' ')).toMatch(/acme\/worker:missing is not present locally/);
    const req = await env.request('restart', ['db']);
    expect(req.argv).toEqual(['docker', 'compose', '--project-name', 'shop', '--project-directory', repo, '-f', path.join(repo, 'compose.yaml'), 'restart', '--no-deps', 'db']);
    const up = await env.request('up', ['db']);
    expect(up.argv.slice(-7)).toEqual(['up', '--detach', '--no-deps', '--no-build', '--pull', 'never', 'db']);
    expect((await env.request('pull', ['worker'])).network).toBe(true);
    await expect(env.request('down', ['db'])).rejects.toThrow(/whole project/);
    await expect(env.request('rm', ['db'])).rejects.toThrow(/Unsupported/);
    await expect(env.request('stop', ['unknown'])).rejects.toThrow(/not declared/);
    const mutations = () => docker.calls.filter(c => c[0] === 'compose' && ['restart', 'up', 'pull'].some(a => c.includes(a)) && !c.includes('version'));
    await expect(approveWith(env, req.decision!.id, 'f'.repeat(64))).rejects.toThrow(/different command/);
    expect(mutations()).toEqual([]);
    const ran = await approveWith(env, req.decision!.id, req.digest!);
    expect(ran.executed).toBe(true);
    await expect(approveWith(env, req.decision!.id, req.digest!)).rejects.toThrow(/already used/);
    await new Promise(r => setTimeout(r, 20));
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]).toEqual(expect.arrayContaining(['restart', 'db', '--project-name', 'shop']));
    expect(mutations()[0].some(a => a.includes('approval-snapshots'))).toBe(true);
    expect(h!.d.store.list({ types: ['docker.action'] }).at(-1)?.data).toMatchObject({ command: expect.arrayContaining(['restart', 'db']), exitCode: 0 });
    expect((await env.status()).jobs[0]).toMatchObject({ state: 'succeeded', action: 'restart', services: ['db'] });

    advance(121_000);
    await expect(approveWith(env, up.decision!.id, up.digest!)).rejects.toThrow(/expired/);
    const denied = await env.request('stop', ['db']);
    expect(await env.resolve(denied.decision!.id, 'deny', '')).toEqual({ executed: false, job: null });
    expect(mutations()).toHaveLength(1);
  });

  it('refuses approval when Compose content changes but argv paths stay the same', async () => {
    const { repo, docker, env } = await setup();
    const req = await env.request('restart', ['db']);
    const composePath = path.join(repo, 'compose.yaml');
    const original = fs.readFileSync(composePath, 'utf8');
    fs.writeFileSync(composePath, original
      .replace('postgres:16-alpine', 'evil:hack')
      .replace('pgdata:/var/lib/postgresql/data', '/:/host:rw'));
    expect(req.argv).toEqual(['docker', 'compose', '--project-name', 'shop', '--project-directory', repo, '-f', composePath, 'restart', '--no-deps', 'db']);
    await expect(approveWith(env, req.decision!.id, req.digest!)).rejects.toThrow(/Compose content/);
    expect(docker.calls.filter(c => c[0] === 'compose' && c.includes('restart'))).toEqual([]);
    fs.writeFileSync(composePath, original);
    const fresh = await env.request('restart', ['db']);
    await approveWith(env, fresh.decision!.id, fresh.digest!);
  });

  it.each([
    ['image', (doc: any) => { doc.services.db.image = 'postgres:17-alpine'; }],
    ['command', (doc: any) => { doc.services.db.command = ['echo', 'changed']; }],
    ['mount', (doc: any) => { doc.services.db.volumes = ['other:/data']; doc.volumes.other = {}; }],
    ['port', (doc: any) => { doc.services.db.ports = ['127.0.0.1:55434:5432']; }],
    ['environment', (doc: any) => { doc.services.db.environment = { APP_MODE: 'changed' }; }],
  ])('invalidates the approval on a changed %s before even checking Docker', async (_name, edit) => {
    const { repo, docker, env } = await setup();
    const req = await env.request('restart', ['db']);
    const file = path.join(repo, 'compose.yaml');
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    edit(doc);
    fs.writeFileSync(file, YAML.stringify(doc));
    docker.calls = [];
    await expect(approveWith(env, req.decision!.id, req.digest!)).rejects.toThrow(/Compose content changed/);
    expect(docker.calls).toEqual([]);
  });

  it.each(['Dockerfile', 'source', 'addition', 'deletion', 'ignore', 'mode', 'context path'])('invalidates a build approval when %s changes', async change => {
    const { repo, docker, env } = await setup();
    fs.writeFileSync(path.join(repo, 'app.txt'), 'approved source');
    const req = await env.request('build', ['web']);
    if (change === 'Dockerfile') fs.appendFileSync(path.join(repo, 'Dockerfile'), 'RUN echo harmless-change\n');
    if (change === 'source') fs.writeFileSync(path.join(repo, 'app.txt'), 'changed source');
    if (change === 'addition') fs.writeFileSync(path.join(repo, 'new.txt'), 'new source');
    if (change === 'deletion') fs.unlinkSync(path.join(repo, 'app.txt'));
    if (change === 'ignore') fs.appendFileSync(path.join(repo, '.dockerignore'), 'app.txt\n');
    if (change === 'mode') fs.chmodSync(path.join(repo, 'app.txt'), 0o755);
    if (change === 'context path') {
      fs.mkdirSync(path.join(repo, 'other'));
      fs.writeFileSync(path.join(repo, 'other', 'Dockerfile'), 'FROM scratch\n');
      const file = path.join(repo, 'compose.yaml');
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.services.web.build = './other';
      fs.writeFileSync(file, YAML.stringify(doc));
    }
    docker.calls = [];
    await expect(approveWith(env, req.decision!.id, req.digest!)).rejects.toThrow(/Compose content changed/);
    expect(docker.calls).toEqual([]);
  });

  it('seals a relative context, custom Dockerfile, env file and mounts while a harmless race changes the repo at execution', async () => {
    const { repo, docker, env } = await setup();
    fs.mkdirSync(path.join(repo, 'app', 'docker'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'app', 'empty'));
    fs.mkdirSync(path.join(repo, 'data'));
    fs.writeFileSync(path.join(repo, 'app', 'docker', 'Appfile'), 'FROM scratch\nCOPY . /app\n');
    fs.writeFileSync(path.join(repo, 'app', 'source.txt'), 'approved source');
    fs.writeFileSync(path.join(repo, 'dev.env'), 'MODE=approved\n');
    fs.writeFileSync(path.join(repo, '.env'), 'MODE=implicit-must-not-be-loaded\n');
    const doc = { services: {
      web: { build: { context: './app', dockerfile: 'docker/Appfile' }, env_file: './dev.env', volumes: ['./data:/data:rw', 'cache:/cache'], command: ['echo', 'approved'] },
      other: { image: 'never/pull:unapproved', privileged: true },
    }, volumes: { cache: {} } };
    fs.writeFileSync(path.join(repo, 'compose.yaml'), YAML.stringify(doc));
    const req = await env.request('build', ['web']);
    expect(req.network).toBe(true);
    expect(req.decision!.question).toMatch(/explicitly permits network/);
    let composeFile = '', context = '';
    docker.beforeMutation = args => {
      expect(args).toEqual(expect.arrayContaining(['--project-name', 'shop', '--project-directory', repo, 'build', 'web']));
      composeFile = args[args.indexOf('-f') + 1];
      const sealed = YAML.parse(fs.readFileSync(composeFile, 'utf8'));
      context = sealed.services.web.build.context;
      // Mutate only harmless fixture files in the check/use window, then follow the actual argv.
      fs.writeFileSync(path.join(repo, 'app', 'docker', 'Appfile'), 'FROM scratch\nRUN echo raced\n');
      fs.writeFileSync(path.join(repo, 'app', 'source.txt'), 'raced source');
      fs.writeFileSync(path.join(repo, 'dev.env'), 'MODE=raced\n');
      fs.writeFileSync(path.join(repo, 'compose.yaml'), 'services: { intruder: { image: unapproved } }\n');
      expect(Object.keys(sealed.services)).toEqual(['web']);
      expect(sealed.services.web.command).toEqual(['echo', 'approved']);
      expect(context.startsWith(repo)).toBe(false);
      expect(fs.readFileSync(path.join(context, 'docker', 'Appfile'), 'utf8')).toBe('FROM scratch\nCOPY . /app\n');
      expect(fs.readFileSync(path.join(context, 'source.txt'), 'utf8')).toBe('approved source');
      expect(fs.existsSync(path.join(context, 'empty'))).toBe(true);
      expect(fs.statSync(composeFile).mode & 0o777).toBe(0o400);
      expect(fs.statSync(context).mode & 0o222).toBe(0);
      expect(sealed.services.web.build.dockerfile).toBe('docker/Appfile');
      expect(sealed.services.web.volumes[0]).toMatchObject({ type: 'bind', source: path.join(repo, 'data'), target: '/data', read_only: false });
      expect(sealed.services.web.volumes[1].source).toBe('cache');
      expect(fs.readFileSync(sealed.services.web.env_file[0].path, 'utf8')).toBe('MODE=approved\n');
      expect(fs.readFileSync(args[args.indexOf('--env-file') + 1], 'utf8')).toBe('');
    };
    const result = await approveWith(env, req.decision!.id, req.digest!);
    await env.close();
    expect(result.job!.state).toBe('succeeded');
    expect(fs.existsSync(composeFile)).toBe(false);
    expect(fs.existsSync(context)).toBe(false);
  });

  it('rechecks files after approval availability awaits and cleans snapshots on failed engine checks', async () => {
    const { repo, docker, env } = await setup();
    const req = await env.request('build', ['web']);
    docker.beforeAvailability = () => fs.appendFileSync(path.join(repo, 'Dockerfile'), 'RUN echo harmless-race\n');
    await expect(approveWith(env, req.decision!.id, req.digest!)).rejects.toThrow(/Compose content changed/);
    expect(docker.calls.some(c => c.includes('build'))).toBe(false);
    expect(fs.existsSync(path.join(env.files.dir, 'approval-snapshots'))).toBe(false);
    docker.beforeAvailability = null;
    const fresh = await env.request('build', ['web']);
    docker.endpoint = 'tcp://remote:2376';
    await expect(approveWith(env, fresh.decision!.id, fresh.digest!)).rejects.toThrow(/not a local socket/);
    expect(fs.existsSync(path.join(env.files.dir, 'approval-snapshots'))).toBe(false);
  });

  it.each(['throw', 'timeout'] as const)('cleans a snapshot and records a failed job on %s', async failure => {
    const { docker, env } = await setup();
    const req = await env.request('build', ['web']);
    docker.failure = failure;
    const result = await approveWith(env, req.decision!.id, req.digest!);
    await env.close();
    expect(result.job!.state).toBe('failed');
    expect(result.job!.output).toMatch(failure === 'throw' ? /fixture spawn error/ : /timed out/);
    expect(fs.readdirSync(path.join(env.files.dir, 'approval-snapshots'))).toEqual([]);
  });

  it('rejects a second concurrent approval and retains single-use state', async () => {
    const { docker, env } = await setup();
    const req = await env.request('restart', ['db']);
    const first = approveWith(env, req.decision!.id, req.digest!);
    await expect(approveWith(env, req.decision!.id, req.digest!)).rejects.toThrow(/already/);
    await first;
    await env.close();
    expect(docker.calls.filter(c => c.includes('restart'))).toHaveLength(1);
  });

  it('requires dependencies to be included explicitly and never widens a scoped command', async () => {
    const { repo, docker, env } = await setup();
    const file = path.join(repo, 'compose.yaml');
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    doc.services.web.depends_on = ['db'];
    fs.writeFileSync(file, YAML.stringify(doc));
    await expect(env.request('up', ['web'])).rejects.toThrow(/explicitly included/);
    const req = await env.request('up', ['db']);
    docker.beforeMutation = args => {
      const sealed = YAML.parse(fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
      expect(Object.keys(sealed.services)).toEqual(['db']);
      expect(args).toContain('--no-deps');
      expect(args).toEqual(expect.arrayContaining(['--no-build', '--pull', 'never']));
    };
    const result = await approveWith(env, req.decision!.id, req.digest!);
    await env.close();
    expect(result.job!.state).toBe('succeeded');
  });

  it.each([
    { privileged: true }, { network_mode: 'host' }, { pid: 'host' }, { ipc: 'host' }, { cap_add: ['SYS_ADMIN'] },
    { devices: ['/dev/sda'] }, { volumes: ['/:/host'] }, { volumes: ['/var/run/docker.sock:/var/run/docker.sock'] },
    { volumes: ['../:/host'] }, { extends: { file: '../compose.yaml', service: 'db' } },
    { build: { context: 'https://example.invalid/context' } }, { build: { context: '../' } },
    { build: { context: '.', dockerfile: '../Dockerfile' } }, { build: { context: '.', additional_contexts: { host: '/' } } },
    { build: { context: '.', ssh: ['default'] } }, { build: { context: '.', secrets: ['token'] } },
    { build: { context: '.', network: 'host' } }, { build: { context: '.', entitlements: ['security.insecure'] } },
    { image: '${UNAPPROVED_IMAGE}' }, { environment: ['UNAPPROVED_TOKEN'] },
  ])('rejects unsafe or unresolved scoped settings %j', async settings => {
    const { repo, docker, env } = await setup();
    fs.writeFileSync(path.join(repo, 'compose.yaml'), YAML.stringify({ services: { web: { image: 'postgres:16-alpine', ...settings } } }));
    docker.calls = [];
    await expect(env.request('build', ['web'])).rejects.toThrow(/Cannot seal/);
    expect(docker.calls).toEqual([]);
  });

  it.each(['file symlink', 'ancestor symlink', 'hardlink', 'secret filename', 'secret content', 'oversized'])('rejects %s in a build context', async kind => {
    const { repo, docker, env } = await setup();
    const outside = path.join(fs.realpathSync(tmpDir('outside')), 'fixture.txt');
    fs.writeFileSync(outside, 'harmless fixture');
    if (kind === 'file symlink') fs.symlinkSync(outside, path.join(repo, 'linked.txt'));
    if (kind === 'ancestor symlink') {
      fs.symlinkSync(path.dirname(outside), path.join(repo, 'linked'));
      const doc = YAML.parse(fs.readFileSync(path.join(repo, 'compose.yaml'), 'utf8'));
      doc.services.web.build = './linked';
      fs.writeFileSync(path.join(repo, 'compose.yaml'), YAML.stringify(doc));
    }
    if (kind === 'hardlink') fs.linkSync(outside, path.join(repo, 'hard.txt'));
    if (kind === 'secret filename') fs.writeFileSync(path.join(repo, '.env'), 'MODE=private\n');
    if (kind === 'secret content') { h!.d.addSecret('fixture-secret-value'); fs.writeFileSync(path.join(repo, 'plain.txt'), 'fixture-secret-value'); }
    if (kind === 'oversized') fs.writeFileSync(path.join(repo, 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1));
    docker.calls = [];
    await expect(env.request('build', ['web'])).rejects.toThrow(/Cannot seal/);
    expect(docker.calls).toEqual([]);
  });

  it('honors Dockerfile-specific ignore rules and refuses secret re-inclusions', async () => {
    const { repo, docker, env } = await setup();
    fs.writeFileSync(path.join(repo, '.env'), 'MODE=private\n');
    fs.writeFileSync(path.join(repo, 'Dockerfile.dockerignore'), '.git\n.env\n');
    const req = await env.request('build', ['web']);
    docker.beforeMutation = args => {
      const sealed = YAML.parse(fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
      const ctx = sealed.services.web.build.context;
      expect(fs.existsSync(path.join(ctx, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(ctx, '.git'))).toBe(false);
      expect(fs.readFileSync(path.join(ctx, 'Dockerfile.dockerignore'), 'utf8')).toBe('.git\n.env\n');
    };
    const result = await approveWith(env, req.decision!.id, req.digest!);
    await new Promise(r => setTimeout(r, 20));
    expect(result.job!.state).toBe('succeeded');
    fs.appendFileSync(path.join(repo, 'Dockerfile.dockerignore'), '!.env\n');
    await expect(env.request('build', ['web'])).rejects.toThrow(/secret files/);
  });

  it('keeps inactive profiles out of an unscoped action', async () => {
    const { repo, docker, env } = await setup();
    const file = path.join(repo, 'compose.yaml');
    fs.writeFileSync(file, YAML.stringify({ services: {
      db: { image: 'postgres:16-alpine' },
      optional: { image: 'unapproved:missing', profiles: ['optional'], privileged: true },
    } }));
    const req = await env.request('up');
    docker.beforeMutation = args => {
      const sealed = YAML.parse(fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
      expect(Object.keys(sealed.services)).toEqual(['db']);
      expect(args.at(-1)).toBe('db');
      expect(args).not.toContain('optional');
    };
    const result = await approveWith(env, req.decision!.id, req.digest!);
    await new Promise(r => setTimeout(r, 20));
    expect(result.job!.state).toBe('succeeded');
  });

  it('rejects a symlink nested in a repository bind directory before checking Docker', async () => {
    const { repo, docker, env } = await setup();
    fs.mkdirSync(path.join(repo, 'mount'));
    const outside = fs.realpathSync(tmpDir('outside-bind'));
    fs.writeFileSync(path.join(outside, 'harmless.txt'), 'fixture');
    fs.symlinkSync(path.join(outside, 'harmless.txt'), path.join(repo, 'mount', 'linked.txt'));
    fs.writeFileSync(path.join(repo, 'compose.yaml'), YAML.stringify({ services: { db: { image: 'postgres:16-alpine', volumes: ['./mount:/app'] } } }));
    docker.calls = [];
    await expect(env.request('up', ['db'])).rejects.toThrow(/Symlinks/);
    expect(docker.calls).toEqual([]);
  });

  it('strips host Compose overrides and inherited variables from the actual subprocess environment', async () => {
    const { repo, docker } = await setup();
    h!.d.opts.baseEnv = { PATH: '/fixture/bin', HOME: '/fixture/home', DOCKER_HOST: 'unix:///fixture.sock', COMPOSE_FILE: '/unapproved.yaml', COMPOSE_PROFILES: 'unapproved', COMPOSE_PROJECT_NAME: 'foreign', UNAPPROVED_IMAGE: 'foreign:latest' };
    const call = vi.spyOn(execution, 'run').mockImplementation(async (cmd, args, options) => {
      expect(cmd).toBe('docker');
      expect(options?.cwd).toBe(repo);
      expect(options?.env).toMatchObject({ PATH: '/fixture/bin', DOCKER_HOST: 'unix:///fixture.sock', COMPOSE_DISABLE_ENV_FILE: 'true' });
      for (const key of ['COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'UNAPPROVED_IMAGE']) expect(options?.env).not.toHaveProperty(key);
      return docker.exec([...args], options);
    });
    const env = new ProjectEnvironment(h!.d, { portProbe: async () => false });
    environments.push(env);
    const req = await env.request('build', ['web']);
    const result = await approveWith(env, req.decision!.id, req.digest!);
    await new Promise(r => setTimeout(r, 20));
    expect(result.job!.state).toBe('succeeded');
    expect(call).toHaveBeenCalled();
  });

  it('binds explicit env-file contents to the approval', async () => {
    const { repo, docker, env } = await setup();
    fs.writeFileSync(path.join(repo, 'dev.env'), 'MODE=approved\n');
    const file = path.join(repo, 'compose.yaml');
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    doc.services.db.env_file = './dev.env';
    fs.writeFileSync(file, YAML.stringify(doc));
    const req = await env.request('restart', ['db']);
    fs.writeFileSync(path.join(repo, 'dev.env'), 'MODE=changed\n');
    docker.calls = [];
    await expect(approveWith(env, req.decision!.id, req.digest!)).rejects.toThrow(/Compose content changed/);
    expect(docker.calls).toEqual([]);
  });

  it('bounds the combined build input count', async () => {
    const { repo, docker, env } = await setup();
    for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(repo, `entry-${i}.txt`), 'x');
    docker.calls = [];
    await expect(env.request('build', ['web'])).rejects.toThrow(/2000 entries/);
    expect(docker.calls).toEqual([]);
  });

  it('pins a bounded file descriptor and refuses a harmless replacement during open', () => {
    const root = fs.realpathSync(tmpDir('capture-race'));
    const input = path.join(root, 'source.txt');
    const replacement = path.join(root, 'replacement.txt');
    fs.writeFileSync(input, 'approved');
    fs.writeFileSync(replacement, 'harmless replacement');
    const open = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (file === input) fs.renameSync(replacement, input);
      return open(file, flags, mode);
    });
    expect(() => readScopedBytes(root, input, 100)).toThrow(/changed/);
  });

  it('bounds ignore syntax and applies root-relative glob/negation rules', () => {
    const ignore = dockerIgnore('**/private\n*.log\n!keep.log\n');
    expect(ignore('app/private/key.txt')).toBe(true);
    expect(ignore('a.log')).toBe(true);
    expect(ignore('nested/a.log')).toBe(false);
    expect(ignore('keep.log')).toBe(false);
    expect(() => dockerIgnore('[abc]')).toThrow(/Unsupported/);
  });

  it('refuses mutations on a non-local Docker endpoint', async () => {
    const { docker, env } = await setup();
    docker.endpoint = 'tcp://prod-docker.example:2376';
    const r = await env.request('stop', ['db']);
    expect(r.decision).toBeNull();
    expect(r.blockers[0]).toMatch(/not a local socket/);
  });

  it('checks the actual context endpoint when DOCKER_CONTEXT overrides a local DOCKER_HOST', async () => {
    const { docker, env } = await setup();
    h!.d.opts.baseEnv = { DOCKER_CONTEXT: 'remote', DOCKER_HOST: 'unix:///local.sock' };
    docker.endpoint = 'tcp://remote:2376';
    const req = await env.request('stop', ['db']);
    expect(req.decision).toBeNull();
    expect(req.blockers.join(' ')).toMatch(/not a local socket/);
    expect(docker.calls.some(c => c.includes('stop'))).toBe(false);
  });

  it('returns bounded, redacted service logs', async () => {
    const { docker, env } = await setup();
    h!.d.addSecret('hunter2-super-secret');
    docker.logs = `db | password hunter2-super-secret\n${'x'.repeat(200 * 1024)}`;
    const logs = await env.logs('db');
    expect(logs.truncated).toBe(true);
    expect(Buffer.byteLength(logs.text)).toBeLessThanOrEqual(128 * 1024);
    docker.logs = 'db | password hunter2-super-secret\n';
    expect((await env.logs('db')).text).not.toContain('hunter2-super-secret');
    expect(docker.calls.find(c => c.includes('logs'))).toEqual(expect.arrayContaining(['--tail', '300', 'db']));
    await expect(env.logs('missing')).rejects.toThrow(/Unknown service/);
  });
});

describe('Local database wizard', () => {
  it('previews a project-owned Postgres plan, writes 0600 files, and keeps the password out of every surface', async () => {
    const dataDir = tmpDir('data');
    const { repo, docker, env } = await setup({ dataDir });
    docker.images.delete('postgres:17-alpine');
    expect(() => parseDatabaseSpec({ kind: 'postgres', database: 'prod_main' })).toThrow(/production/);
    expect(() => parseDatabaseSpec({ kind: 'postgres', port: 80 })).toThrow(/port/);
    await expect(env.planDatabase({ kind: 'postgres', service: 'db' })).rejects.toThrow(/already declares a service named db/);
    const plan = await env.planDatabase({ kind: 'postgres', service: 'devdb', database: 'shop', user: 'shop', version: '17-alpine', port: 55433 });
    expect(fs.existsSync(env.files.composeFile)).toBe(false);
    expect(plan.steps.map(s => [s.id, s.needed, s.network])).toEqual([['image', true, true], ['up', true, false]]);
    expect(plan.steps[1].argv).toEqual(expect.arrayContaining(['--project-name', 'shop', '--pull', 'never', 'devdb']));
    expect(plan.connection).toMatchObject({ host: '127.0.0.1', port: 55433, password: 'hidden', url: 'postgresql://shop:<password>@127.0.0.1:55433/shop', volume: 'shop_devdb-data' });

    const created = await env.createDatabase({ kind: 'postgres', service: 'devdb', database: 'shop', user: 'shop', version: '17-alpine', port: 55433 });
    const secretFile = env.files.secretFile('devdb');
    const password = fs.readFileSync(secretFile, 'utf8').trim();
    expect(password.length).toBeGreaterThanOrEqual(24);
    for (const f of [secretFile, env.files.composeFile]) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const compose = fs.readFileSync(env.files.composeFile, 'utf8');
    expect(compose).toContain('POSTGRES_PASSWORD_FILE: /run/secrets/devdb_password');
    expect(compose).toContain('127.0.0.1:55433:5432');
    expect(compose).toContain('pg_isready -U shop -d shop');
    expect(compose).toContain('devdb-data:/var/lib/postgresql/data');
    const surfaces = [compose, JSON.stringify(plan), JSON.stringify(created), JSON.stringify(h!.d.store.list({ limit: 5000 })), JSON.stringify(h!.d.state), h!.d.store.kvGet('environment:databases') ?? ''];
    for (const s of surfaces) expect(s).not.toContain(password);
    expect(h!.d.redactText(`url=postgresql://shop:${password}@127.0.0.1`)).not.toContain(password);
    expect(env.baseArgs()).toEqual(['compose', '--project-name', 'shop', '--project-directory', repo, '-f', path.join(repo, 'compose.yaml'), '-f', env.files.composeFile]);
    const status = await env.status();
    expect(status.services.find(s => s.name === 'devdb')).toMatchObject({ source: 'database', declaredHealthcheck: true, imagePresent: false, volumes: ['shop_devdb-data'] });
    expect(status.databases[0]).toMatchObject({ kind: 'postgres', service: 'devdb', password: 'hidden' });
    const blocked = await env.request('up', ['devdb']);
    expect(blocked.blockers.join(' ')).toMatch(/postgres:17-alpine is not present locally/);

    // Restart: definitions, password and volume binding survive; a fresh daemon redacts the password again.
    await h!.close(); h = undefined;
    const again = await setup({ repo, dataDir });
    expect(again.env.connections()).toEqual(status.databases);
    expect(fs.readFileSync(again.env.files.secretFile('devdb'), 'utf8').trim()).toBe(password);
    await again.env.createDatabase({ kind: 'postgres', service: 'devdb', database: 'shop', user: 'shop', version: '17-alpine', port: 55433 });
    expect(fs.readFileSync(again.env.files.secretFile('devdb'), 'utf8').trim()).toBe(password);
    expect(h!.d.redactText(password)).not.toContain(password);
  });

  it('keeps wizard passwords private and immutable through an approved scoped start', async () => {
    const { docker, env } = await setup();
    await env.createDatabase({ kind: 'postgres', service: 'devdb' });
    const password = env.files.readSecret('devdb')!;
    const req = await env.request('up', ['devdb']);
    docker.beforeMutation = args => {
      const sealed = YAML.parse(fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
      expect(Object.keys(sealed.services)).toEqual(['devdb']);
      expect(sealed.services.devdb.ports).toEqual(['127.0.0.1:5432:5432']);
      expect(sealed.services.devdb.volumes[0].source).toBe('devdb-data');
      const secret = sealed.secrets.devdb_password.file;
      fs.writeFileSync(env.files.secretFile('devdb'), 'changed-but-harmless-password');
      expect(secret).not.toBe(env.files.secretFile('devdb'));
      expect(fs.statSync(secret).mode & 0o777).toBe(0o400);
      expect(fs.readFileSync(secret, 'utf8')).toBe(password);
      expect(JSON.stringify(req)).not.toContain(password);
    };
    const result = await approveWith(env, req.decision!.id, req.digest!);
    await env.close();
    expect(result.job!.state).toBe('succeeded');
    expect(fs.readdirSync(path.join(env.files.dir, 'approval-snapshots'))).toEqual([]);
  });

  it('removes crash leftovers, persists interrupted jobs and never replays an approved action on restart', async () => {
    const dataDir = tmpDir('data');
    const first = await setup({ dataDir });
    const req = await first.env.request('build', ['web']);
    const stale = path.join(first.env.files.dir, 'approval-snapshots', `${req.decision!.id}-crash`);
    fs.mkdirSync(path.join(stale, 'builds'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stale, 'builds', 'source.txt'), 'harmless crash fixture', { mode: 0o400 });
    fs.chmodSync(path.join(stale, 'builds'), 0o500);
    fs.chmodSync(stale, 0o500);
    h!.d.store.kvSet('environment:jobs', JSON.stringify([{ id: 'crashed', decisionId: req.decision!.id, action: 'build', services: ['web'], argv: req.argv, state: 'running', exitCode: null, output: 'partial log', startedAt: h!.d.nowIso(), endedAt: null }]));
    await h!.close(); h = undefined;
    const second = await setup({ repo: first.repo, dataDir });
    const job = (await second.env.status()).jobs[0];
    expect(job).toMatchObject({ state: 'interrupted', exitCode: null, action: 'build' });
    expect(job.output).toMatch(/check service status/);
    expect(job.endedAt).not.toBeNull();
    expect(JSON.parse(h!.d.store.kvGet('environment:jobs')!)[0].state).toBe('interrupted');
    expect(fs.existsSync(stale)).toBe(false);
    expect(second.docker.calls.some(c => c.includes('build'))).toBe(false);
  });

  it('creates a private SQLite file without Docker', async () => {
    const { docker, env } = await setup();
    const r = await env.createDatabase({ kind: 'sqlite', name: 'dev' });
    expect(r.database).toMatchObject({ kind: 'sqlite', exists: true });
    const file = env.files.sqliteFile('dev');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(docker.calls.some(c => c[0] === 'compose' && !c.includes('version'))).toBe(false);
  });

  it('reports an action interrupted by daemon shutdown after restart instead of claiming success', async () => {
    const dataDir = tmpDir('data');
    const first = await setup({ dataDir });
    let release!: () => void;
    first.docker.hold = new Promise(r => { release = r; });
    const req = await first.env.request('restart', ['db']);
    await approveWith(first.env, req.decision!.id, req.digest!);
    await first.env.close();
    release();
    await new Promise(r => setTimeout(r, 20));
    await h!.close(); h = undefined;
    const second = await setup({ repo: first.repo, dataDir });
    expect((await second.env.status()).jobs[0]).toMatchObject({ action: 'restart', state: 'interrupted' });
  });
});
