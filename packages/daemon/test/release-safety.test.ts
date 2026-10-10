// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRuntimeKey, defaultReleaseSteps, type ReleasePlan, type ReleaseStep } from '@acc/core';
import { safeGitEnv } from '../src/adapters/vcs/git-policy.ts';
import { run } from '../src/exec.ts';
import { allowlistedPush, allowlistedPr, executeReleaseStep, isProtectedBranch, type ReleaseExec, type ReleaseProof } from '../src/release/runner.ts';
import { git, makeRepo, makeConfig, tmpDir } from './helpers.ts';

function setup(kind: ReleaseStep['kind'] = 'push') {
  const repo = makeRepo();
  const sha = git(repo, 'rev-parse', 'HEAD');
  const config = makeConfig(repo, { code_host: { provider: 'github', repo: 'acme/widgets', activated: true, host: 'api.github.com', scopes: ['repo'] } });
  config.project.checks = { action: 'do-action', verify: 'actual-probe', rollback: 'restore' };
  const environment = checkRuntimeKey(config.project.check_runtime)!;
  const step: ReleaseStep = { ...defaultReleaseSteps('main', sha, environment)[0], id: 'step', kind, target: 'integration', command: kind === 'push' ? allowlistedPush('github', 'acme/widgets', 'integration', sha) : 'check:action', check: kind === 'push' ? 'remote-ref' : 'check:verify', rollback: 'check:rollback', decisionId: null, approval: 'pending', status: 'pending', evidence: null, checkedAt: null };
  const plan: ReleasePlan = { id: 'plan', name: 'Release', status: 'active', productionBranch: 'main', sha, workItemId: null, mergeId: null, steps: [step], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return { config, step, plan };
}

it('uploads newly local commit objects with an exact non-force refspec, ignores hostile repo config, and freshly verifies the remote SHA (offline bare fixture)', async () => {
  const input = setup();
  const repo = input.config.project.repo;
  const before = input.plan.sha!;
  fs.writeFileSync(path.join(repo, 'release-new.txt'), 'new commit objects\n');
  git(repo, 'add', 'release-new.txt');
  git(repo, 'commit', '-qm', 'new local release');
  const sha = git(repo, 'rev-parse', 'HEAD');
  input.plan.sha = sha;
  input.step.command = allowlistedPush('github', 'acme/widgets', 'integration', sha);
  const remote = path.join(tmpDir('release-remote'), 'fixture.git');
  git(repo, 'init', '--bare', remote);
  git(repo, 'push', remote, `${before}:refs/heads/integration`);
  const marker = path.join(tmpDir('release-hooks'), 'executed');
  const hooks = path.join(repo, 'evil-hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(repo, 'config', 'core.hooksPath', hooks);
  git(repo, 'config', 'url.ext::evil.insteadOf', 'https://github.com/');
  git(repo, 'config', 'remote.origin.pushurl', 'ext::evil');
  git(repo, 'config', 'credential.helper', `!touch '${marker}'`);
  git(repo, 'config', 'http.proxy', 'http://bad.invalid');
  const calls: { bin: string; args: string[]; cwd?: string }[] = [];
  const exec: ReleaseExec = async (bin, args, opts) => {
    calls.push({ bin, args, cwd: opts?.cwd });
    if (bin === 'gh') return { code: 0, stdout: JSON.stringify({ name: args.at(-1)?.endsWith('/main') ? 'main' : 'integration', protected: args.at(-1)?.endsWith('/main') }), stderr: '' };
    expect(opts?.cwd).not.toBe(repo);
    expect(args).toContain('core.hooksPath=/dev/null');
    expect(args).toContain('credential.helper=');
    expect(args).toContain('http.followRedirects=false');
    // Production argv remains HTTPS; only this test executor substitutes a local
    // bare fixture. No external service or transport is contacted by this test.
    const testArgs = args.map(a => a === 'https://github.com/acme/widgets.git' ? remote : a);
    return run(bin, ['-c', 'protocol.file.allow=always', ...testArgs], { cwd: opts?.cwd, env: safeGitEnv() });
  };
  const result = await executeReleaseStep({ ...input, command: input.step.command, mode: 'run', exec, project: async () => { throw new Error('project must not run'); } });
  expect(result).toMatchObject({ executed: true, ok: true });
  const push = calls.find(c => c.args.includes('push'))!;
  expect(push.args.at(-1)).toBe(`${sha}:refs/heads/integration`);
  expect(push.args.join(' ')).not.toMatch(/--force|\+.*refs\/heads|PATCH|POST/);
  expect(calls.at(-1)?.args).toContain('ls-remote');
  expect(git(remote, 'rev-parse', 'refs/heads/integration')).toBe(sha);
  expect(git(remote, 'show', `${sha}:release-new.txt`)).toBe('new commit objects');
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(push.cwd!)).toBe(false);
});

it('denies protected branches and force/foreign-repo commands before dispatch', async () => {
  const input = setup();
  let calls = 0;
  const exec: ReleaseExec = async () => { calls++; throw new Error('must not execute'); };
  for (const target of ['main', 'refs/heads/main', '-x', 'bad..name']) {
    input.step.target = target;
    const result = await executeReleaseStep({ ...input, command: input.step.command, mode: 'run', exec, project: async () => { throw new Error('must not execute'); } });
    expect(result.ok).toBe(false);
  }
  input.step.target = 'integration';
  for (const command of [input.step.command + ' --force', input.step.command.replace('acme/widgets', 'other/repo')]) {
    expect((await executeReleaseStep({ ...input, command, mode: 'run', exec, project: async () => { throw new Error('must not execute'); } })).ok).toBe(false);
  }
  input.config.project.protected_branches.push('release/*');
  expect(isProtectedBranch('release/v2', input.plan, input.config.project)).toBe(true);
  expect(calls).toBe(0);
});

it('does not pass a push on exit 0 when the actual remote SHA is wrong', async () => {
  const input = setup();
  const result = await executeReleaseStep({ ...input, command: input.step.command, mode: 'run', exec: async (bin, args) => ({ code: 0, stdout: bin === 'gh' ? JSON.stringify({ name: args.at(-1)?.endsWith('/main') ? 'main' : 'integration', protected: args.at(-1)?.endsWith('/main') }) : args.includes('ls-remote') ? `${'b'.repeat(40)}\trefs/heads/integration\n` : 'pushed', stderr: '' }), project: async () => { throw new Error('no project'); } });
  expect(result).toMatchObject({ executed: true, ok: false });
});

it('pins PR repo/head/base and SHA before and after creation, rejecting a moved head', async () => {
  const input = setup('pr');
  input.step.check = 'pull-head-base';
  input.step.command = allowlistedPr('github', 'github.com/acme/widgets', 'main', 'integration', input.step.title);
  let reads = 0;
  const calls: string[][] = [];
  const result = await executeReleaseStep({ ...input, command: input.step.command, mode: 'run', exec: async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'git') return { code: 0, stdout: `${++reads === 1 ? input.plan.sha : 'b'.repeat(40)}\trefs/heads/integration\n`, stderr: '' };
    if (args.at(-1)?.includes('/branches/')) return { code: 0, stdout: JSON.stringify({ name: args.at(-1)?.endsWith('/main') ? 'main' : 'integration', protected: args.at(-1)?.endsWith('/main') }), stderr: '' };
    if (args.includes('create')) return { code: 0, stdout: 'https://github.com/acme/widgets/pull/3', stderr: '' };
    return { code: 0, stdout: JSON.stringify([{ state: 'open', head: { sha: input.plan.sha, ref: 'integration', repo: { full_name: 'acme/widgets' } }, base: { ref: 'main', repo: { full_name: 'acme/widgets' } } }]), stderr: '' };
  }, project: async () => { throw new Error('no project'); } });
  expect(result).toMatchObject({ executed: true, ok: false });
  const create = calls.find(c => c.includes('create'))!;
  expect(create).toContain('github.com/acme/widgets');
  expect(create).toContain('--head');
  expect(create).toContain('--base');
  expect(create).not.toContain('--fill');
});

it('binds self-hosted GitLab commands to its explicit project URL and source/target branches', async () => {
  const input = setup('pr');
  input.config.code_host = { provider: 'gitlab', project: 'team/widgets', activated: true, host: 'gitlab.example.com', scopes: ['api'], finding_issues: 'manual' };
  input.step.check = 'pull-head-base';
  input.step.command = allowlistedPr('gitlab', 'gitlab.example.com/team/widgets', 'main', 'integration', input.step.title);
  let created = false;
  const result = await executeReleaseStep({ ...input, command: input.step.command, mode: 'run', exec: async (bin, args) => {
    if (bin === 'git') return { code: 0, stdout: `${input.plan.sha}\trefs/heads/integration\n`, stderr: '' };
    if (args.at(-1)?.includes('/branches/')) return { code: 0, stdout: JSON.stringify({ name: args.at(-1)?.endsWith('/main') ? 'main' : 'integration', protected: args.at(-1)?.endsWith('/main') }), stderr: '' };
    if (args.at(-1) === 'projects/team%2Fwidgets') return { code: 0, stdout: JSON.stringify({ id: 4, path_with_namespace: 'team/widgets' }), stderr: '' };
    if (args.includes('create')) { created = true; expect(args).toContain('--repo'); expect(args).toContain('gitlab.example.com/team/widgets'); return { code: 0, stdout: 'created', stderr: '' }; }
    expect(args).toContain('--hostname'); expect(args).toContain('gitlab.example.com');
    return { code: 0, stdout: JSON.stringify([{ state: 'opened', sha: input.plan.sha, source_branch: 'integration', target_branch: 'main', source_project_id: 4, target_project_id: 4 }]), stderr: '' };
  }, project: async () => { throw new Error('no project'); } });
  expect(created).toBe(true);
  expect(result.ok).toBe(true);
});

describe.each(['ci', 'backup', 'migrate', 'env_flags', 'deploy', 'verify_routes', 'migration_dry_run', 'device_qa', 'custom'] as const)('%s verification', kind => {
  it('requires fresh configured proof, rejecting exit 0, cached or wrong-SHA evidence', async () => {
    const input = setup(kind);
    for (const failure of ['none', 'sha', 'stale', 'target', 'environment', 'id', 'artifact', 'source', 'phase', 'future', 'runtime', 'result_sha', 'nonzero', 'detail']) {
      const result = await executeReleaseStep({ ...input, command: input.step.command, mode: 'run', exec: async () => { throw new Error('no host'); }, project: async (_command, request) => {
        const proof: ReleaseProof | undefined = request && failure !== 'none' ? { ...request, sha: failure === 'sha' ? 'b'.repeat(40) : request.sha, target: failure === 'target' ? 'unrelated' : request.target, environment: failure === 'environment' ? 'other' : request.environment, id: failure === 'id' ? 'old' : request.id, phase: failure === 'phase' ? 'rollback' : request.phase, observedAt: failure === 'future' ? '2099-01-01T00:00:00Z' : failure === 'stale' ? '2000-01-01T00:00:00Z' : new Date().toISOString(), source: failure === 'source' ? 'real_device' : 'probe', ok: true, detail: failure === 'detail' ? '' : 'checked' } : undefined;
        return { status: 'passed', exitCode: failure === 'nonzero' ? 1 : 0, detail: 'exit 0', sha: failure === 'result_sha' ? 'b'.repeat(40) : input.plan.sha, runtimeKey: failure === 'runtime' ? 'foreign-runtime' : input.step.environment, proof };
      } });
      if (failure === 'artifact' && kind !== 'backup' && kind !== 'device_qa') continue;
      if (failure === 'source' && kind === 'device_qa') continue;
      expect(result.ok, failure).toBe(false);
    }
    const verified = await executeReleaseStep({ ...input, command: input.step.command, mode: 'run', exec: async () => { throw new Error('no host'); }, project: async (_command, request) => ({ status: 'passed', exitCode: 0, detail: 'checked', sha: input.plan.sha, runtimeKey: input.step.environment, proof: request ? { ...request, observedAt: new Date().toISOString(), source: kind === 'device_qa' ? 'real_device' : 'probe', artifact: 'verified-artifact', acceptanceEnvironment: kind === 'device_qa' ? 'device' : 'local', ok: true, detail: 'state actually probed' } : undefined }) });
    expect(verified.ok).toBe(true);
    expect(verified.proof?.kind).toBe(kind);
  });
});
