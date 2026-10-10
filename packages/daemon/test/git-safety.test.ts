// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Harmless marker programs expose accidental execution of repository/global Git configuration.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedFiles, createWorktree, diffPatch, git as appGit, installWorktreeHooks, mergeConflicts } from '../src/adapters/vcs/git.ts';
import { safeGit } from '../src/projects/safe-git.ts';
import { git, makeRepo, tmpDir } from './helpers.ts';
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const repo = () => { const r = makeRepo(); owned.push(r); return r; };
const temp = (name: string) => { const d = tmpDir(name); owned.push(d); return d; };
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

describe('app-owned Git executable configuration isolation', () => {
  it('never runs repository fsmonitor, hooks, included clean/smudge/process, diff or textconv drivers during reads and worktree operations', async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'data.txt'), 'hello\n');
    fs.writeFileSync(path.join(r, '.gitattributes'), '*.txt filter=marker diff=marker\n');
    git(r, 'add', '.'); git(r, 'commit', '-qm', 'attributes');
    const sha = git(r, 'rev-parse', 'HEAD');
    const mark = path.join(r, '.git', 'EXECUTED');
    const script = path.join(r, '.git', 'marker.sh');
    fs.writeFileSync(script, `#!/bin/sh\nprintf ran >> ${quote(mark)}\ncat\n`, { mode: 0o755 });
    for (const name of ['post-checkout', 'reference-transaction', 'post-merge']) fs.copyFileSync(script, path.join(r, '.git', 'hooks', name));
    git(r, 'config', 'core.fsmonitor', script);
    git(r, 'config', 'diff.marker.command', script); git(r, 'config', 'diff.marker.textconv', script);
    const include = path.join(r, '.git', 'included.conf');
    fs.writeFileSync(include, `[filter "marker"]\n\tclean = ${script}\n\tsmudge = ${script}\n\tprocess = ${script}\n\trequired = true\n`);
    git(r, 'config', 'include.path', include);
    expect((await appGit(r, ['status', '--porcelain'])).code).toBe(0);
    expect((await safeGit(r, ['show', `${sha}:data.txt`])).stdout).toBe('hello\n');
    fs.writeFileSync(path.join(r, 'data.txt'), 'changed\n');
    expect((await changedFiles(r, sha)).map(x => x.path)).toContain('data.txt');
    expect((await diffPatch(r, sha)).patch).toContain('changed');
    const wt = path.join(temp('wt-parent'), 'worktree');
    await createWorktree({ repo: r, dir: wt, branch: 'safe-work', baseRef: sha });
    expect(fs.readFileSync(path.join(wt, 'data.txt'), 'utf8')).toBe('hello\n');
    await appGit(r, ['worktree', 'remove', wt]);
    expect(fs.existsSync(mark)).toBe(false);
  });

  it('ignores inherited Git environment and global hooks/drivers', async () => {
    const r = repo();
    const home = temp('fake-home'); const marker = path.join(home, 'EXECUTED');
    const hooks = path.join(home, 'hooks'); fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\nprintf ran >> ${quote(marker)}\n`, { mode: 0o755 });
    const cfg = path.join(home, '.gitconfig');
    fs.writeFileSync(cfg, `[core]\n\thooksPath = ${hooks}\n\tfsmonitor = printf ran >> ${marker}\n[merge "external"]\n\tdriver = printf ran >> ${marker}\n`);
    const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0, GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF };
    Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: `printf ran >> ${marker}`, GIT_EXTERNAL_DIFF: `printf ran >> ${marker}` });
    try {
      expect((await appGit(r, ['status', '--porcelain'])).code).toBe(0);
      expect(await mergeConflicts(r, 'main', 'integration')).toEqual([]);
      const wt = path.join(temp('global-wt'), 'worktree');
      await createWorktree({ repo: r, dir: wt, branch: 'global-safe', baseRef: 'main' });
      await appGit(r, ['worktree', 'remove', wt]);
      expect(fs.existsSync(marker)).toBe(false);
    } finally { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; }
  });

  it('refuses included custom merge drivers before executing either conflict preview or merge', async () => {
    const r = repo(); const marker = path.join(r, '.git', 'EXECUTED');
    const cfg = path.join(r, '.git', 'merge.conf');
    fs.writeFileSync(cfg, `[merge "marker"]\n\tdriver = printf ran >> ${marker}\n`); git(r, 'config', 'include.path', cfg);
    expect(await mergeConflicts(r, 'main', 'integration')).toBeNull();
    const result = await appGit(r, ['merge', 'integration'], { allowFail: true });
    expect(result.code).toBeNull(); expect(result.stderr).toContain('custom Git merge drivers');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('installs only app guards and rejects out-of-scope commits and protected pushes without chaining user hooks', async () => {
    const r = repo(); const marker = path.join(r, '.git', 'EXECUTED');
    fs.writeFileSync(path.join(r, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nprintf ran >> ${quote(marker)}\n`, { mode: 0o755 });
    const wt = path.join(temp('guard-wt'), "with'quote");
    await createWorktree({ repo: r, dir: wt, branch: 'guard-safe', baseRef: 'main' });
    const hooks = path.join(temp('guard-hooks'), "hooks'quote");
    await installWorktreeHooks({ repo: r, worktree: wt, hooksDir: hooks, scope: { allowedPaths: ['notes/**'], ignore: [], protectedBranches: ['main'] } });
    expect(JSON.parse(fs.readFileSync(path.join(hooks, 'scope.json'), 'utf8')).chainHooksDir).toBeNull();
    fs.writeFileSync(path.join(wt, 'outside.txt'), 'outside\n'); git(wt, 'add', 'outside.txt');
    // Native agent commit enters the app-owned guard. App-owned reads inside it are isolated.
    expect(() => git(wt, 'commit', '-qm', 'outside')).toThrow(/outside this assignment/);
    expect(fs.existsSync(marker)).toBe(false);
    const { run } = await import('../src/exec.ts');
    const push = await run(path.join(hooks, 'pre-push'), ['origin', 'local'], { cwd: wt, input: `${'a'.repeat(40)} ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`, timeoutMs: 10_000 });
    expect(push.code).toBe(1); expect(push.stderr).toContain('protected branch');
  });
});
