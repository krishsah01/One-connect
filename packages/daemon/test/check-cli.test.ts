// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Run the actual installed Node runtime/CLI against disposable, offline source.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { HOST_FIXTURE_MARKER, HOST_FIXTURE_NOTICE } from '../src/checks.ts';
import { git, makeConfig, makeRepo, ROOT, tmpDir } from './helpers.ts';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
it('actual CLI labels explicit fixture execution and exits nonzero when production runtime config is missing', () => {
  const repo = makeRepo(); const root = tmpDir('check-cli'); dirs.push(repo, root);
  fs.writeFileSync(path.join(repo, '.git', HOST_FIXTURE_MARKER), HOST_FIXTURE_NOTICE + '\n');
  const config = makeConfig(repo); config.project.check_runtime = { mode: 'host-fixture', fixture_repo: repo };
  const file = path.join(root, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
  const cli = path.join(ROOT, 'packages/daemon/src/cli.ts');
  const args = [cli, 'check', '--config', file, '--sha', 'HEAD', '--log-dir', path.join(root, 'logs')];
  const success = JSON.parse(execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } }));
  expect(success).toMatchObject({ sha: git(repo, 'rev-parse', 'HEAD'), results: [{ status: 'passed', runtime: HOST_FIXTURE_NOTICE, counts: { passed: 2, failed: 0 } }] });
  delete config.project.check_runtime; fs.writeFileSync(file, JSON.stringify(config));
  const failure = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  expect(failure.status).toBe(1);
  expect(JSON.parse(failure.stdout).results[0]).toMatchObject({ status: 'unavailable', exitCode: null, detail: expect.stringContaining('check_runtime is missing') });
});
