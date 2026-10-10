// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { HUMAN, SYSTEM } from '@acc/core';
import { git, makeConfig, makeRepo, startDaemon, tmpDir, type Harness } from './helpers.ts';
import { ensureNativeMockHelper } from './mock-file-helper.ts';
beforeAll(ensureNativeMockHelper);
let h: Harness | null = null;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); h = null; });
const digest = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const wt = fs.realpathSync(makeRepo());
  h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
  const issue = h.d.createIssue({ title: 'Race fixture' });
  const a = h.d.createAssignment({ workItemId: issue.id, agentId: 'codex', allowedPaths: ['design/**'] });
  h.d.commit([{ type: 'assignment.worktree_ready', actor: SYSTEM, assignmentId: a.id, data: { worktree: wt, branch: 'main', baseSha: git(wt, 'rev-parse', 'HEAD') } }]);
  const dir = path.join(wt, 'design/race'); fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html lang="en"><body>safe</body></html>');
  fs.writeFileSync(path.join(dir, 'nested/app.js'), 'document.body.dataset.safe="yes"');
  const outside = tmpDir('mock-outside');
  fs.writeFileSync(path.join(outside, 'app.js'), `ghp_${'x'.repeat(36)}`);
  return { d: h.d, a, dir, outside };
}

it.each(['leaf', 'ancestor'])('rejects a %s symlink swapped after lstat and before open, without reading outside bytes', async kind => {
  const { d, a, dir, outside } = await fixture();
  const target = path.join(dir, 'nested/app.js');
  const ancestor = path.join(dir, 'nested');
  const lstat = fs.lstatSync;
  let swapped = false;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file, ...args) => {
    const result = (lstat as Function)(file, ...args);
    if (String(file) === target && !swapped) {
      swapped = true;
      if (kind === 'leaf') { fs.renameSync(target, target + '.held'); fs.symlinkSync(path.join(outside, 'app.js'), target); }
      else { fs.renameSync(ancestor, ancestor + '.held'); fs.symlinkSync(outside, ancestor); }
    }
    return result;
  }) as typeof fs.lstatSync);
  await expect(d.mocks.capture(a.id, 'design/race', HUMAN)).rejects.toThrow(/symlink|changed/);
  expect(swapped).toBe(true); expect(d.state.mocks).toEqual({});
});

it('stores the verified buffer even when the source becomes an outside symlink exactly at blob persistence', async () => {
  const { d, a, dir, outside } = await fixture();
  const html = path.join(dir, 'index.html'); const expected = fs.readFileSync(html);
  const originalWrite = fs.writeFileSync; let swapped = false;
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file, ...args) => {
    if (String(file).includes('design-mocks/blobs/') && !swapped) {
      swapped = true; fs.renameSync(html, html + '.held'); fs.symlinkSync(path.join(outside, 'app.js'), html);
    }
    return (originalWrite as Function)(file, ...args);
  }) as typeof fs.writeFileSync);
  const captured = await d.mocks.capture(a.id, 'design/race', HUMAN);
  expect(swapped).toBe(true);
  const recorded = captured.revision.files.find(f => f.path === 'index.html')!;
  expect(recorded.sha256).toBe(digest(expected));
  const stored = fs.readFileSync(path.join(d.paths.root, 'design-mocks/blobs', recorded.sha256));
  expect(stored.equals(expected)).toBe(true);
  expect(d.mocks.readSource(captured.artifact.id, 1, 'index.html').content).toBe(expected.toString());
});
