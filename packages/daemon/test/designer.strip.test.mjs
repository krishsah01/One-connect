// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Run directly with Node 24 --test: the Designer studio modules load as plain TypeScript, without a
// transpiler, exactly as the strip-only CLI daemon runs them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_DESIGN, designCss, HUMAN, jobStatus, parseConfig, SYSTEM } from '../../core/src/index.ts';
import { Daemon } from '../src/daemon.ts';
import { ensureNativeMockHelper } from './mock-file-helper.ts';

test('strip-only designer studio: contract, draft, job, capture, preview and restart', async () => {
  ensureNativeMockHelper();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designer-strip-'));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture'); git(repo, 'branch', 'integration');
  const config = parseConfig({ project: { name: 'strip', repo }, tracker: { type: 'local' }, graphify: { enabled: false }, agents: [{ id: 'codex', name: 'Codex fixture', role: 'engineer', adapter: 'codex-cli', binary: path.resolve(import.meta.dirname, '../../../examples/fake-agent/bin/codex') }] });
  const live = new Set();
  const start = async () => { const d = new Daemon({ config, dataDir: path.join(root, 'data'), allowTempDataDir: true, probe: false, rulesTickMs: 3600000 }); live.add(d); await d.start(); return d; };
  try {
    let d = await start();
    const v = d.designer.validate(DEFAULT_DESIGN);
    assert.equal(v.ok, true);
    const rev = d.designer.save(DEFAULT_DESIGN, null, 'strip');
    assert.equal(d.designer.fullExports().tokens.$extensions['one-connect'].contract.hash, rev.hash);
    d.designer.saveDraft('brief', { title: 'kept' });
    const view = d.designer.studio.createJob({ title: 'Strip mock', brief: 'A mock that proves strip-only module loading works.', audience: 'Maintainers', screens: [{ name: 'Overview' }, { name: 'Detail' }], agentId: 'codex' }, HUMAN);
    const a = d.state.assignments[view.job.assignmentId];
    assert.match(a.prompt, /Designer studio generate job/);
    const wt = path.join(root, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'strip-mock', wt, 'integration'], { cwd: repo });
    d.commit([{ type: 'assignment.worktree_ready', actor: SYSTEM, assignmentId: a.id, agentId: a.agentId, workItemId: a.workItemId, data: { worktree: wt, branch: 'strip-mock', baseSha: git(wt, 'rev-parse', 'HEAD') } }]);
    const dir = path.join(wt, view.job.dir);
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tokens.css'), designCss(rev.system));
    for (const [file, body] of [['index.html', '<a href="detail.html">Detail</a>'], ['detail.html', '<a href="index.html">Back</a>']]) fs.writeFileSync(path.join(dir, file), `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="tokens.css"></head><body style="color:var(--design-text)">${body}<script>document.body.dataset.ready='1'</script></body></html>`);
    fs.writeFileSync(path.join(dir, 'evidence', 'note.png'), 'not part of the mock');
    const cap = await d.designer.studio.captureJob(view.job.id, HUMAN);
    assert.deepEqual(cap.revision.files.map(f => f.path), ['detail.html', 'index.html', 'tokens.css']);
    assert.equal(jobStatus(d.state.designStudio.jobs[view.job.id], d.state).phase, 'captured');
    const p = d.mocks.preview(cap.artifact.id, 1);
    assert.ok(p.shell.includes('"detail.html"'));
    assert.ok(!/<script/i.test(p.static));
    await d.shutdown(); live.delete(d);
    d = await start();
    assert.equal(d.mocks.get(cap.artifact.id).revisions[0].hash, cap.revision.hash);
    assert.deepEqual(d.designer.draft('brief').value, { title: 'kept' });
    assert.equal(Object.values(d.state.designStudio.captures).filter(c => c.ok).length, 1);
    await d.shutdown(); live.delete(d);
  } finally {
    for (const d of live) await d.shutdown().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
