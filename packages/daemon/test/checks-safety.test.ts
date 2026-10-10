// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Offline Docker protocol fixtures plus real disposable Git source; no daemon/image install.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckRuntimeSchema, checksAt } from '@acc/core';
import { HOST_FIXTURE_MARKER, HOST_FIXTURE_NOTICE, runChecks, type CheckExecutor, type CheckOptions } from '../src/checks.ts';
import { git, makeRepo, tmpDir } from './helpers.ts';
import type { ExecOptions, ExecResult } from '../src/exec.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const IMAGE = `sha256:${'a'.repeat(64)}`;
const CID = 'b'.repeat(64);
class DockerFixture {
  calls: { args: string[]; options: ExecOptions }[] = [];
  failure = '';
  output = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\n';
  processExit = 0;
  snapshot?: string;
  onCreate?: (source: string) => void;
  exec: CheckExecutor = async (cmd, argv, options) => {
    expect(cmd).toBe('docker');
    const args = [...argv];
    this.calls.push({ args, options });
    expect(args.slice(0, 2)).toEqual(['--host', 'unix:///fixture/docker.sock']);
    const command = args[2];
    if (this.failure === command) return { code: null, stdout: '', stderr: 'fixture unavailable', timedOut: command === 'start' };
    if (command === 'version') return ok('27.0');
    if (command === 'image') return ok(JSON.stringify([{ Id: IMAGE, Config: { Volumes: {} } }]));
    if (command === 'create') {
      const mount = args[args.indexOf('--mount') + 1];
      this.snapshot = /src=([^,]+)/.exec(mount)![1];
      this.onCreate?.(this.snapshot);
      return ok(CID);
    }
    if (command === 'start') return ok(this.output);
    if (command === 'inspect') return ok(JSON.stringify({ Running: false, ExitCode: this.processExit, OOMKilled: false, Error: '' }));
    if (command === 'rm') return ok(CID);
    throw new Error(`unexpected Docker command ${command}`);
  };
}
function setup(): { o: CheckOptions; docker: DockerFixture } {
  const repo = makeRepo(); dirs.push(repo);
  fs.writeFileSync(path.join(repo, '.git', HOST_FIXTURE_MARKER), HOST_FIXTURE_NOTICE + '\n');
  const logs = tmpDir('check-logs'); dirs.push(logs);
  return {
    o: { repo, cwd: repo, sha: git(repo, 'rev-parse', 'HEAD'), runtime: CheckRuntimeSchema.parse({ mode: 'docker', image: 'fixture:local', endpoint: 'unix:///fixture/docker.sock' }), checks: [{ name: 'test', command: 'node --test' }], logDir: logs, env: { PATH: process.env.PATH, OPENAI_API_KEY: 'super-secret-key', DOCKER_HOST: 'tcp://external:2375', NODE_OPTIONS: '--require=bad.js' }, denylist: ['super-secret-key'] },
    docker: new DockerFixture(),
  };
}

describe('committed-source checks in offline Docker', () => {
  it('runs immutable SHA source despite dirty/untracked files and a moving branch, with bounded resources and no host credentials', async () => {
    const { o, docker } = setup();
    const original = fs.readFileSync(path.join(o.repo, 'src/math.js'), 'utf8');
    const binary = Buffer.from([0, 128, 255, 4]);
    fs.writeFileSync(path.join(o.repo, 'bytes.bin'), binary);
    git(o.repo, 'add', 'bytes.bin'); git(o.repo, 'commit', '-qm', 'binary source');
    o.sha = git(o.repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(o.repo, 'src/math.js'), 'dirty host source');
    fs.writeFileSync(path.join(o.repo, '.env'), 'OPENAI_API_KEY=super-secret-key');
    docker.onCreate = source => {
      expect(fs.readFileSync(path.join(source, 'src/math.js'), 'utf8')).toBe(original);
      expect(fs.readFileSync(path.join(source, 'bytes.bin'))).toEqual(binary);
      expect(fs.existsSync(path.join(source, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(source, '.git'))).toBe(false);
      // A newer commit after export cannot change this check's source identity.
      git(o.repo, 'add', 'src/math.js'); git(o.repo, 'commit', '-qm', 'later');
    };
    const [result] = await runChecks(o, docker.exec);
    expect(result).toMatchObject({ status: 'passed', exitCode: 0, sha: o.sha, counts: { passed: 1, failed: 0 } });
    const create = docker.calls.find(c => c.args[2] === 'create')!;
    expect(create.args).toEqual(expect.arrayContaining(['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534', '--pids-limit=128', '--cpus=1', '--memory=512m', '--memory-swap=512m', IMAGE]));
    expect(create.args.filter(a => a === '--mount')).toHaveLength(1);
    expect(JSON.stringify(create.options.env)).not.toMatch(/super-secret|external:2375|NODE_OPTIONS/);
    expect(docker.calls.filter(c => c.args[2] === 'rm')).toHaveLength(1);
    expect(fs.existsSync(docker.snapshot!)).toBe(false);
    expect(fs.readFileSync(result.logPath, 'utf8')).toContain('Docker (local, offline, committed source)');
  });

  it.each(['version', 'image', 'create', 'start', 'inspect'])('fails closed for unavailable %s with no host fallback', async failure => {
    const { o, docker } = setup(); docker.failure = failure;
    const marker = path.join(o.repo, 'HOST-RAN');
    o.checks[0].command = `touch '${marker}'`;
    const [result] = await runChecks(o, docker.exec);
    expect(result.status).not.toBe('passed'); expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    if (['create', 'start', 'inspect'].includes(failure)) expect(docker.calls.at(-1)?.args[2]).toBe('rm');
  });

  it('never treats successful attach as successful checks; records the actual nonzero container exit', async () => {
    const { o, docker } = setup(); docker.processExit = 17;
    const [result] = await runChecks(o, docker.exec);
    expect(result).toMatchObject({ status: 'failed', exitCode: 17 });
    const ev = { id: 'proof', kind: 'command' as const, command: result.command, sha: result.sha!, exitCode: result.exitCode, verified: true, at: '' , summary: result.status };
    expect(checksAt({ evidence: [ev] }, { checks: { test: o.checks[0].command } }, ['test'], o.sha)[0].status).toBe('fail');
  });

  it('fails the proof when owned-container cleanup fails', async () => {
    const { o, docker } = setup(); docker.failure = 'rm';
    const [result] = await runChecks(o, docker.exec);
    expect(result).toMatchObject({ status: 'failed', exitCode: null, detail: 'owned check container cleanup failed' });
    expect(docker.calls.at(-1)?.args[2]).toBe('rm');
  });

  it('bounds and redacts both output and command headers, and handles colliding/traversal check names', async () => {
    const { o, docker } = setup(); docker.output = `super-secret-key\n${'x'.repeat(600_000)}`;
    o.checks = [{ name: '..', command: 'echo super-secret-key' }, { name: '/', command: 'echo hello' }, { name: '_', command: 'echo hello' }];
    const results = await runChecks(o, docker.exec);
    expect(new Set(results.map(r => r.logPath)).size).toBe(3);
    for (const r of results) {
      const log = fs.readFileSync(r.logPath, 'utf8');
      expect(log.length).toBeLessThan(270_000); expect(log).not.toContain('super-secret-key');
      expect(path.dirname(r.logPath)).toBe(o.logDir); expect(r.command).not.toContain('super-secret-key');
    }
  });

  it('missing runtime or missing command produces unavailable proof and never spawns Docker or a host shell', async () => {
    const { o, docker } = setup(); delete o.runtime;
    const [r] = await runChecks(o, docker.exec);
    expect(r).toMatchObject({ status: 'unavailable', exitCode: null }); expect(r.detail).toContain('check_runtime is missing');
    expect(docker.calls).toHaveLength(0);
    o.runtime = CheckRuntimeSchema.parse({ mode: 'docker', image: 'fixture:local', endpoint: 'unix:///fixture/docker.sock' }); o.checks[0].command = '';
    expect((await runChecks(o, docker.exec))[0]).toMatchObject({ status: 'unavailable', exitCode: null });
  });

  it('refuses tracked source symlinks and a source worktree from another repository', async () => {
    const { o, docker } = setup();
    fs.symlinkSync('/etc/passwd', path.join(o.repo, 'outside')); git(o.repo, 'add', 'outside'); git(o.repo, 'commit', '-qm', 'link'); o.sha = git(o.repo, 'rev-parse', 'HEAD');
    expect((await runChecks(o, docker.exec))[0]).toMatchObject({ status: 'unavailable', exitCode: null, detail: expect.stringContaining('symlinks') });
    const other = makeRepo(); dirs.push(other); o.cwd = other;
    expect((await runChecks(o, docker.exec))[0].detail).toContain('outside the configured repository');
    expect(docker.calls).toHaveLength(0);
  });

  it('refuses symlink log targets and returns unavailable proof when private logs cannot be written', async () => {
    const { o, docker } = setup();
    const outside = path.join(o.repo, 'owner-log'); fs.writeFileSync(outside, 'keep me');
    fs.symlinkSync(outside, path.join(o.logDir, '0-test.log'));
    const [r] = await runChecks(o, docker.exec);
    expect(r).toMatchObject({ status: 'unavailable', exitCode: null, logPath: '' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep me');
  });

  it('rejects remote endpoints and arbitrary mount/privileged config fields', () => {
    expect(() => CheckRuntimeSchema.parse({ mode: 'docker', image: 'fixture', endpoint: 'tcp://remote:2375' })).toThrow();
    expect(() => CheckRuntimeSchema.parse({ mode: 'docker', image: 'fixture', endpoint: 'unix:///tmp/docker.sock', privileged: true, mounts: ['/'] })).toThrow();
  });
});

describe('explicit disposable host fixture escape hatch', () => {
  it('requires both the exact fixture repo config and marker; labels every result/log', async () => {
    const { o, docker } = setup(); o.runtime = { mode: 'host-fixture', fixture_repo: o.repo };
    fs.unlinkSync(path.join(o.repo, '.git', HOST_FIXTURE_MARKER));
    expect((await runChecks(o, docker.exec))[0].status).toBe('unavailable');
    fs.writeFileSync(path.join(o.repo, '.git', HOST_FIXTURE_MARKER), HOST_FIXTURE_NOTICE + '\n');
    const [result] = await runChecks(o, docker.exec);
    expect(result).toMatchObject({ status: 'passed', exitCode: 0, runtime: HOST_FIXTURE_NOTICE, sha: o.sha });
    expect(fs.readFileSync(result.logPath, 'utf8')).toContain(HOST_FIXTURE_NOTICE);
    expect(docker.calls).toHaveLength(0);
    const other = makeRepo(); dirs.push(other); o.runtime.fixture_repo = other;
    expect((await runChecks(o, docker.exec))[0].status).toBe('unavailable');
  });
});
