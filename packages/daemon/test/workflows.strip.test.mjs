// SPDX-License-Identifier: Apache-2.0
// Direct Node 24 contract: real fixture processes, SQLite replay and local Git; no transpiler.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../../core/src/index.ts';
import { Daemon } from '../src/daemon.ts';
import { HOST_FIXTURE_MARKER, HOST_FIXTURE_NOTICE } from '../src/checks.ts';
import { createServer } from '../src/server/http.ts';

test('strip-only workflow: independent SHA review, stale completion, replay without duplicate dispatch', { timeout: 90_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-connect-workflow-strip-'));
  const repo = path.join(root, 'repo');
  fs.cpSync(path.resolve(import.meta.dirname, '../../../examples/sample-repo'), repo, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture'); git(repo, 'branch', 'integration');
  fs.writeFileSync(path.join(repo, '.git', HOST_FIXTURE_MARKER), HOST_FIXTURE_NOTICE + '\n');
  const fakeBin = path.resolve(import.meta.dirname, '../../../examples/fake-agent/bin');
  const cfg = parseConfig({
    project: { name: 'Workflow fixture', repo, integration_branch: 'integration', checks: { test: 'node --test' }, check_runtime: { mode: 'host-fixture', fixture_repo: repo } },
    tracker: { type: 'local' }, graphify: { enabled: false }, policies: { quality_floor: {} },
    agents: [
      { id: 'claude', name: 'Author fixture', role: 'engineer', adapter: 'claude-headless', binary: path.join(fakeBin, 'claude'), model: 'newest', model_family: 'opus' },
      { id: 'codex', name: 'Reviewer fixture', role: 'reviewer', adapter: 'codex-cli', binary: path.join(fakeBin, 'codex'), model: 'newest' },
    ],
  });
  let daemon = null;
  let server = null;
  const start = async () => {
    const d = new Daemon({ config: cfg, dataDir: path.join(root, 'data'), allowTempDataDir: true, outboxTickMs: 100, rulesTickMs: 3_600_000, supervisorPollMs: 50 });
    daemon = d;
    const probe = d.probe.bind(d);
    d.probe = async id => {
      await probe(id);
      const a = d.state.agents[id];
      if (a?.config.binary && path.dirname(a.config.binary) === fakeBin && a.auth.state === 'logged_in' && a.billing.mode === 'subscription' && a.billing.overage === 'unknown') d.subscriptionSafety.confirm(id, true);
    };
    server = await createServer(d, { port: 0 });
    await d.start();
    return d;
  };
  const wait = async predicate => {
    const until = Date.now() + 30_000;
    while (!predicate()) {
      if (Date.now() > until) throw new Error('Local workflow fixture did not reach the expected state');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const stop = async () => { await server?.app.close(); server = null; await daemon?.shutdown(); daemon = null; };
  try {
    let d = await start();
    const issue = d.createIssue({ title: 'Reviewable notes' });
    await wait(() => d.state.workItems[issue.id]?.key);
    const workflow = d.workflows.save({ definition: { name: 'Exact review', tasks: [
      { id: 'code', workItemId: issue.id, agentId: 'claude', allowedPaths: ['notes/**'] },
      { id: 'review', kind: 'review', reviewOf: 'code', agentId: 'codex' },
    ] } });
    await d.workflows.launch(workflow.id);
    await wait(() => d.state.workflows[workflow.id].status === 'completed');
    const done = d.state.workflows[workflow.id];
    const a = d.state.assignments[done.tasks.code.assignmentId];
    const review = d.state.reviews[done.tasks.review.reviewId];
    assert.equal(review.targetSha, git(a.worktree, 'rev-parse', 'HEAD'));
    assert.notEqual(review.reviewer.id, review.authorAgentId);
    assert.equal(d.state.workItems[issue.id].state, 'approved');
    const runs = Object.keys(d.state.runs).sort();
    assert.equal(runs.length, 2);
    git(a.worktree, 'commit', '--allow-empty', '-qm', 'New author SHA');
    await d.reviewMerge.gatesFor(issue.id);
    await wait(() => d.state.workflows[workflow.id].status === 'blocked');
    assert.equal(d.state.workflows[workflow.id].tasks.code.completedSha, null);
    assert.ok(d.state.reviews[review.id].staleAt);
    await stop();
    d = await start();
    await d.workflows.idle();
    assert.equal(d.state.workflows[workflow.id].status, 'blocked');
    assert.deepEqual(Object.keys(d.state.runs).sort(), runs);
    assert.notEqual(d.state.workItems[issue.id].state, 'verified');
    await stop();
  } finally {
    if (daemon) await daemon.setKillSwitch(true).catch(() => undefined);
    await stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
