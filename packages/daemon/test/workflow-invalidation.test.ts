// SPDX-License-Identifier: Apache-2.0
// Real local Git refs and child-process fixtures. No vendor, cloud tracker or Docker pull.
import { afterEach, expect, it } from 'vitest';
import { newId, SYSTEM, type Workflow } from '@acc/core';
import { git, makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

async function item(title: string, description = '') {
  const d = h!.d;
  const issue = d.createIssue({ title, description });
  await waitFor(() => d.state.workItems[issue.id]?.key);
  return d.state.workItems[issue.id];
}

async function chain(description = '') {
  const d = h!.d;
  const a = await item('Author');
  const b = await item('Dependent', description);
  const w = d.workflows.save({ definition: { name: 'Current proof', mode: 'collaborative', tasks: [
    { id: 'author', workItemId: a.id, agentId: 'claude', allowedPaths: [`notes/${a.key}.md`] },
    { id: 'review', kind: 'review', reviewOf: 'author', agentId: 'codex' },
    { id: 'dependent', workItemId: b.id, agentId: 'cursor', allowedPaths: [`notes/${b.key}.md`], dependsOn: ['review'] },
  ] } });
  await d.workflows.launch(w.id);
  return { id: w.id, author: a.id, dependent: b.id };
}

const current = (id: string): Workflow => h!.d.state.workflows[id];

it('a completed workflow loses readiness on a real moved author SHA; downstream evidence stays historical and restart never duplicates work', async () => {
  const cfg = makeConfig(makeRepo());
  h = await startDaemon(cfg);
  const { id, author } = await chain();
  await waitFor(() => current(id).status === 'completed', 45_000, 'completed workflow');
  const d = h.d;
  const original = current(id);
  const count = Object.keys(d.state.runs).length;
  const a = d.state.assignments[original.tasks.author.assignmentId!];
  git(a.worktree!, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'Move author ref');
  const head = git(a.worktree!, 'rev-parse', 'HEAD');
  expect(head).not.toBe(original.tasks.author.completedSha);
  const gates = await d.reviewMerge.gatesFor(author);
  expect(gates.gates.find(g => g.id === 'review')?.ok).toBe(false);
  await waitFor(() => current(id).status === 'blocked', 10_000, 'stale workflow');
  await d.workflows.idle();
  expect(current(id).tasks.author).toMatchObject({ status: 'blocked', completedSha: null, evidenceIds: [] });
  expect(current(id).tasks.review.status).toBe('blocked');
  expect(current(id).tasks.dependent).toMatchObject({ status: 'blocked', completedSha: null, evidenceIds: [] });
  expect(d.state.workItems[author].state).toBe('changes_requested');
  expect(d.state.workItems[author].evidence.some(e => e.sha === original.tasks.author.completedSha && e.verified)).toBe(true);
  expect(Object.keys(d.state.runs)).toHaveLength(count);

  const dataDir = h.dataDir;
  await d.shutdown();
  h = await startDaemon(cfg, { dataDir, server: false });
  await h.d.workflows.idle();
  expect(current(id).status).toBe('blocked');
  expect(current(id).endedAt).toBeNull();
  expect(Object.keys(h.d.state.runs)).toHaveLength(count);
  expect(h.d.state.workItems[author].state).not.toBe('verified');
}, 90_000);

it('late failed check evidence at the completed SHA removes completion without a new run', async () => {
  h = await startDaemon(makeConfig(makeRepo()));
  const d = h.d;
  const a = await item('Checked implementation');
  const w = d.workflows.save({ definition: { name: 'One task', mode: 'independent', tasks: [{ id: 'code', workItemId: a.id, agentId: 'claude', allowedPaths: [`notes/${a.key}.md`] }] } });
  await d.workflows.launch(w.id);
  await waitFor(() => current(w.id).status === 'completed', 30_000);
  const proof = d.state.workItems[a.id].evidence.filter(e => e.verified && e.kind === 'test').at(-1)!;
  const count = Object.keys(d.state.runs).length;
  d.commit([{ type: 'work_item.evidence_added', actor: SYSTEM, workItemId: a.id, data: { evidence: { ...proof, id: newId('ev'), exitCode: 1, summary: 'Actual fixture recheck failed', at: d.nowIso() } } }]);
  await waitFor(() => current(w.id).status === 'failed', 10_000);
  expect(current(w.id).tasks.code).toMatchObject({ status: 'failed', completedSha: null, reason: expect.stringMatching(/test failed at/) });
  expect(Object.keys(d.state.runs)).toHaveLength(count);
}, 60_000);

it('a passing result from another check runtime cannot preserve completion', async () => {
  h = await startDaemon(makeConfig(makeRepo()));
  const d = h.d;
  const a = await item('Runtime-bound implementation');
  const w = d.workflows.save({ definition: { name: 'Runtime bound', tasks: [{ id: 'code', workItemId: a.id, agentId: 'claude', allowedPaths: [`notes/${a.key}.md`] }] } });
  await d.workflows.launch(w.id);
  await waitFor(() => current(w.id).status === 'completed', 30_000);
  const proof = d.state.workItems[a.id].evidence.filter(e => e.verified && e.kind === 'test').at(-1)!;
  const count = Object.keys(d.state.runs).length;
  d.commit([{ type: 'work_item.evidence_added', actor: SYSTEM, workItemId: a.id, data: { evidence: { ...proof, id: newId('ev'), checkRuntime: 'another-runtime', at: d.nowIso() } } }]);
  await waitFor(() => current(w.id).status === 'blocked', 10_000);
  expect(current(w.id).tasks.code).toMatchObject({ completedSha: null, reason: expect.stringMatching(/current configured runtime evidence/) });
  expect(Object.keys(d.state.runs)).toHaveLength(count);
}, 60_000);

it('a dependent that is already running stays visibly live but cannot complete from stale upstream evidence', async () => {
  h = await startDaemon(makeConfig(makeRepo()), { baseEnv: { ...process.env, FAKE_SLOW_MS: '2500' } });
  const d = h.d;
  const { id, author, dependent } = await chain('[fake:slow]');
  await waitFor(() => current(id).tasks.dependent.status === 'running', 30_000);
  const w = current(id);
  const a = d.state.assignments[w.tasks.author.assignmentId!];
  git(a.worktree!, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'New author commit while client runs');
  await d.reviewMerge.gatesFor(author);
  await d.workflows.idle();
  expect(current(id).tasks.dependent).toMatchObject({ status: 'running', completedSha: null, reason: expect.stringMatching(/upstream task/) });
  const assignmentId = w.tasks.dependent.assignmentId!;
  await waitFor(() => !d.runs.activeRunFor(assignmentId), 20_000);
  await waitFor(() => current(id).status === 'blocked', 10_000);
  expect(current(id).tasks.dependent).toMatchObject({ status: 'blocked', completedSha: null });
  expect(d.state.workItems[dependent].state).not.toBe('verified');
  expect(Object.values(d.state.runs).filter(r => r.assignmentId === assignmentId)).toHaveLength(1);
}, 90_000);

it('restart detects a moved completed branch even when no invalidation event was recorded while offline', async () => {
  const cfg = makeConfig(makeRepo());
  h = await startDaemon(cfg);
  const d = h.d;
  const a = await item('Offline source change');
  const w = d.workflows.save({ definition: { name: 'Offline reconciliation', tasks: [{ id: 'code', workItemId: a.id, agentId: 'claude', allowedPaths: [`notes/${a.key}.md`] }] } });
  await d.workflows.launch(w.id);
  await waitFor(() => current(w.id).status === 'completed', 30_000);
  const assignment = d.state.assignments[current(w.id).tasks.code.assignmentId!];
  const dataDir = h.dataDir;
  const runs = Object.keys(d.state.runs).sort();
  await d.shutdown();
  git(assignment.worktree!, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'Offline author update');
  h = await startDaemon(cfg, { dataDir, server: false });
  await waitFor(() => current(w.id).status === 'blocked', 10_000);
  expect(current(w.id).tasks.code).toMatchObject({ status: 'blocked', completedSha: null, reason: expect.stringMatching(/moved from/) });
  expect(Object.keys(h.d.state.runs).sort()).toEqual(runs);
}, 60_000);

it('stale upstream proof removes a dependent from Next without stopping unrelated current work', async () => {
  h = await startDaemon(makeConfig(makeRepo()), { baseEnv: { ...process.env, FAKE_SLOW_MS: '30000' } });
  const d = h.d;
  const busy = await item('Other Cursor work', '[fake:slow]');
  const assignment = d.createAssignment({ workItemId: busy.id, agentId: 'cursor', allowedPaths: [`notes/${busy.key}.md`] });
  const dispatched = await d.dispatch(assignment.id);
  await waitFor(() => d.state.runs[dispatched.runId!].state === 'running', 10_000);
  const { id, author, dependent } = await chain();
  await waitFor(() => current(id).tasks.dependent.status === 'queued', 30_000);
  const queued = current(id).tasks.dependent.assignmentId!;
  expect(d.state.agents.cursor.queue.next).toContain(queued);
  const a = d.state.assignments[current(id).tasks.author.assignmentId!];
  git(a.worktree!, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'Invalidate queued dependency');
  await d.reviewMerge.gatesFor(author);
  await waitFor(() => current(id).status === 'blocked', 10_000);
  expect(current(id).tasks.dependent.status).toBe('blocked');
  expect(d.state.assignments[queued].position).toBe('canceled');
  expect(d.state.agents.cursor.queue.next).not.toContain(queued);
  expect(d.state.runs[dispatched.runId!].state).toBe('running');
  expect(Object.values(d.state.runs).filter(r => r.workItemId === dependent)).toHaveLength(0);
}, 90_000);
