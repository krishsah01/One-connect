// SPDX-License-Identifier: Apache-2.0
// Workflow engine end to end: validation over HTTP, dependency-ordered promotion from recorded
// evidence, pause/resume, failure, cancel and restart durability. Scripted fake agents only.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlCenterConfig, Workflow, WorkflowIssue } from '@acc/core';
import { FAKE_BIN, git, makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function config(): ControlCenterConfig {
  const base = makeConfig(makeRepo());
  return makeConfig(base.project.repo, {
    agents: [
      ...base.agents.map((a) => ({ ...a })),
      { id: 'coord', name: 'Coordinator', role: 'lead', adapter: 'claude-headless', binary: path.join(FAKE_BIN, 'claude'), model: 'newest', model_family: 'opus', mode: 'coordinator-only' },
    ],
  });
}

async function issue(hh: Harness, title: string, description = '') {
  const item = hh.d.createIssue({ title, description, acceptance: ['a notes file exists'] });
  await waitFor(() => hh.d.state.workItems[item.id].key && hh.d.state.workItems[item.id].trackerId, 5000, 'tracker key');
  return hh.d.state.workItems[item.id];
}

async function api<T>(hh: Harness, method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const token = fs.readFileSync(hh.d.paths.installToken, 'utf8').trim();
  const r = await fetch(`${hh.url}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.status, body: (await r.json()) as T };
}

const wf = (hh: Harness, id: string): Workflow => hh.d.state.workflows[id];
const until = (hh: Harness, id: string, status: Workflow['status'], ms = 30_000) => waitFor(() => wf(hh, id).status === status && wf(hh, id), ms, `workflow ${status} (is ${wf(hh, id)?.status}: ${wf(hh, id)?.statusReason})`);

async function restart(hh: Harness, cfg: ControlCenterConfig, env: NodeJS.ProcessEnv = process.env): Promise<Harness> {
  await hh.d.shutdown();
  return startDaemon(cfg, { dataDir: hh.dataDir, server: false, baseEnv: env });
}

describe('workflow definitions', () => {
  it('rejects cycles, unknown issues or agents, overlapping writers, self-review and code for coordinator-only agents', async () => {
    h = await startDaemon(config());
    const a = await issue(h, 'One');
    const b = await issue(h, 'Two');
    const t = (id: string, o: Record<string, unknown> = {}) => ({ id, title: id, workItemId: a.id, agentId: 'claude', kind: 'code', allowedPaths: [`src/${id}/**`], ...o });
    const save = (definition: unknown) => api<{ error: string; issues: WorkflowIssue[] }>(h!, 'POST', '/api/workflows', { definition });
    const codes = async (definition: unknown) => {
      const r = await save(definition);
      expect(r.status).toBe(422);
      return r.body.issues.map((i) => i.code);
    };

    expect(await codes({ name: 'cycle', mode: 'collaborative', tasks: [t('x', { dependsOn: ['y'] }), t('y', { workItemId: b.id, dependsOn: ['x'] })] })).toContain('cycle');
    expect(await codes({ name: 'ghosts', tasks: [t('x', { workItemId: 'wi_missing' }), t('y', { workItemId: b.id, agentId: 'nobody' })] })).toEqual(expect.arrayContaining(['unknown_item', 'unknown_agent']));
    expect(await codes({ name: 'overlap', tasks: [t('x', { allowedPaths: ['notes/**'] }), t('y', { workItemId: b.id, agentId: 'codex', allowedPaths: ['notes/a.md'] })] })).toContain('overlap');
    expect(await codes({ name: 'two writers', tasks: [t('x'), t('y', { agentId: 'codex' })] })).toContain('duplicate_writer');
    expect(await codes({ name: 'coord', tasks: [t('x', { agentId: 'coord' })] })).toContain('coordinator_code');
    expect(await codes({ name: 'self review', tasks: [t('x'), { id: 'rx', kind: 'review', reviewOf: 'x', agentId: 'claude' }] })).toContain('review_self');
    expect(await codes({ name: 'indep', mode: 'independent', tasks: [t('x'), t('y', { workItemId: b.id, dependsOn: ['x'] })] })).toContain('independent_dependency');

    // Ordered writers may share paths; a review inherits its target's issue.
    const ok = await save({ name: 'ok', mode: 'collaborative', tasks: [t('x', { allowedPaths: ['notes/**'] }), { id: 'rx', kind: 'review', reviewOf: 'x', agentId: 'codex' }, t('y', { workItemId: b.id, agentId: 'cursor', allowedPaths: ['notes/**'], dependsOn: ['rx'] })] });
    expect(ok.status).toBe(200);
    const saved = (ok.body as unknown as { workflow: Workflow }).workflow;
    expect(saved).toMatchObject({ status: 'draft', version: 1 });
    expect(saved.definition.tasks[1]).toMatchObject({ workItemId: a.id, dependsOn: ['x'] });
    // Another workflow cannot claim the same issues while this one is active.
    expect((await api(h, 'POST', `/api/workflows/${saved.id}/start`)).status).toBe(200);
    expect(await codes({ name: 'again', tasks: [t('z', { allowedPaths: ['other/**'] })] })).toContain('item_in_other_workflow');
    // Started workflows are not editable.
    expect((await api(h, 'POST', '/api/workflows', { id: saved.id, definition: saved.definition })).status).toBe(409);
  }, 90_000);
});

describe('workflow execution', () => {
  it('collaborative: code → independent review → dependent code built on the reviewed SHA, all from recorded evidence', async () => {
    h = await startDaemon(config());
    const { d } = h;
    const a = await issue(h, 'Schema');
    const b = await issue(h, 'Client');
    const def = {
      name: 'Schema then client',
      mode: 'collaborative',
      tasks: [
        { id: 'schema', title: 'Write the schema notes', workItemId: a.id, agentId: 'claude', kind: 'code', allowedPaths: ['notes/**'] },
        { id: 'schema-review', title: 'Review the schema', kind: 'review', reviewOf: 'schema', agentId: 'codex' },
        { id: 'client', title: 'Client notes', workItemId: b.id, agentId: 'cursor', kind: 'code', allowedPaths: ['notes/**'], dependsOn: ['schema-review'] },
      ],
    };
    const saved = (await api<{ workflow: Workflow }>(h, 'POST', '/api/workflows', { definition: def })).body.workflow;
    const started = await api<{ workflow: Workflow }>(h, 'POST', `/api/workflows/${saved.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.workflow.status).toBe('running');
    expect(started.body.workflow.tasks.schema.status).toBe('running');
    expect(started.body.workflow.tasks.client.status).toBe('pending');

    const done = await until(h, saved.id, 'completed', 60_000);
    const schema = done.tasks.schema;
    const review = d.state.reviews[done.tasks['schema-review'].reviewId!];
    const client = d.state.assignments[done.tasks.client.assignmentId!];
    const schemaAsg = d.state.assignments[schema.assignmentId!];
    expect(schema.completedSha).toBe(git(schemaAsg.worktree!, 'rev-parse', 'HEAD'));
    // Completion is backed by verified commit + daemon check evidence at that SHA.
    const ev = d.state.workItems[a.id].evidence.filter((e) => schema.evidenceIds.includes(e.id));
    expect(ev.map((e) => e.kind).sort()).toEqual(['commit', 'test']);
    expect(ev.every((e) => e.verified && e.sha === schema.completedSha)).toBe(true);
    expect(review).toMatchObject({ verdict: 'approve', targetSha: schema.completedSha, reviewer: { id: 'codex' }, workflowId: saved.id, taskId: 'schema-review' });
    // The dependent task only started after the review was recorded, from the reviewed SHA.
    const clientRun = Object.values(d.state.runs).find((r) => r.assignmentId === client.id)!;
    expect(clientRun.createdAt >= review.at).toBe(true);
    expect(client).toMatchObject({ baseRef: schema.completedSha, workflowId: saved.id, taskId: 'client' });
    expect(git(client.worktree!, 'merge-base', '--is-ancestor', schema.completedSha!, 'HEAD')).toBe('');
    expect(fs.existsSync(path.join(client.worktree!, 'notes', `${a.key}.md`))).toBe(true);
    expect(done.startedAt).toBeTruthy();
    expect(done.endedAt).toBeTruthy();

    // The workflow gate is now satisfied for merging the schema issue.
    const gates = await d.reviewMerge.gatesFor(a.id);
    expect(gates.gates.find((g) => g.id === 'workflow')).toMatchObject({ ok: true });
    expect(gates.gates.every((g) => g.ok)).toBe(true);
  }, 120_000);

  it('pause holds promotion across a restart; resume continues; nothing completes on a timer', async () => {
    const cfg = config();
    const env = { ...process.env, FAKE_SLOW_MS: '1500' };
    h = await startDaemon(cfg, { baseEnv: env });
    const a = await issue(h, 'Slow first', '[fake:slow]');
    const b = await issue(h, 'Second');
    const saved = h.d.workflows.save({ definition: { name: 'Pausable', mode: 'collaborative', tasks: [{ id: 'first', workItemId: a.id, agentId: 'claude', allowedPaths: ['notes/**'] }, { id: 'second', workItemId: b.id, agentId: 'codex', allowedPaths: ['notes/**'], dependsOn: ['first'] }] } });
    await h.d.workflows.launch(saved.id);
    await waitFor(() => wf(h!, saved.id).tasks.first.status === 'running', 10_000, 'first running');
    await h.d.workflows.pause(saved.id);
    expect(wf(h, saved.id).status).toBe('paused');
    // The running agent finishes; its task completes from evidence, but nothing new is promoted.
    await waitFor(() => wf(h!, saved.id).tasks.first.status === 'done', 30_000, 'first done while paused');
    await h.d.workflows.idle();
    expect(wf(h, saved.id).tasks.second).toMatchObject({ status: 'pending', assignmentId: null });

    h = await restart(h, cfg, env);
    expect(wf(h, saved.id)).toMatchObject({ status: 'paused', tasks: { first: { status: 'done' }, second: { status: 'pending' } } });
    await new Promise((r) => setTimeout(r, 400));
    await h.d.workflows.idle();
    expect(Object.values(h.d.state.assignments).some((x) => x.workItemId === b.id)).toBe(false);

    await h.d.workflows.resume(saved.id);
    const done = await until(h, saved.id, 'completed', 60_000);
    expect(done.tasks.second.completedSha).toBeTruthy();
  }, 120_000);

  it('failed checks, changes requested and cancel are durable states; retry reruns through dispatch', async () => {
    const cfg = config();
    const env = { ...process.env, FAKE_SLOW_MS: '4000' };
    h = await startDaemon(cfg, { baseEnv: env });
    const { d } = h;
    const broken = await issue(h, 'Broken', '[fake:break-tests]');
    const changes = await issue(h, 'Gets changes', '[fake:review-changes]');
    const slow = await issue(h, 'Slow', '[fake:slow]');

    const own = (key: string | null) => [`notes/${key}.*`];
    const failing = d.workflows.save({ definition: { name: 'Failing', mode: 'independent', tasks: [{ id: 'fix', workItemId: broken.id, agentId: 'claude', allowedPaths: own(broken.key) }] } });
    const reviewing = d.workflows.save({ definition: { name: 'Reviewed', mode: 'collaborative', tasks: [{ id: 'work', workItemId: changes.id, agentId: 'codex', allowedPaths: own(changes.key) }, { id: 'check', kind: 'review', reviewOf: 'work', agentId: 'cursor' }] } });
    const cancel = d.workflows.save({ definition: { name: 'Canceled', mode: 'independent', tasks: [{ id: 'long', workItemId: slow.id, agentId: 'claude', allowedPaths: own(slow.key) }] } });
    await d.workflows.launch(failing.id);
    await d.workflows.launch(reviewing.id);
    await d.workflows.launch(cancel.id);
    // claude is busy with "fix", so "long" waits in its Next queue (shared capacity is respected).
    expect(wf(h, cancel.id).tasks.long.status).toBe('queued');

    const f = await until(h, failing.id, 'failed');
    expect(f.tasks.fix).toMatchObject({ status: 'failed', reason: expect.stringMatching(/test failed at/) });
    const r = await until(h, reviewing.id, 'blocked', 45_000);
    expect(r.tasks.check.status).toBe('changes_requested');
    expect(d.state.workItems[changes.id].state).toBe('changes_requested');

    await waitFor(() => wf(h!, cancel.id).tasks.long.status === 'running', 20_000, 'long running');
    await d.workflows.cancel(cancel.id);
    expect(wf(h, cancel.id)).toMatchObject({ status: 'canceled', tasks: { long: { status: 'canceled' } } });
    const longRunId = Object.values(d.state.runs).find((x) => x.workItemId === slow.id)!.id;
    await waitFor(() => d.state.runs[longRunId]?.exit?.kind === 'stopped', 15_000, 'long run stopped');
    expect(d.state.runs[longRunId].exit?.kind).toBe('stopped');

    h = await restart(h, cfg, env);
    expect(wf(h, failing.id).status).toBe('failed');
    expect(wf(h, reviewing.id).status).toBe('blocked');
    expect(wf(h, cancel.id).status).toBe('canceled');
    await h.d.workflows.idle();
    expect(wf(h, cancel.id).tasks.long.status).toBe('canceled');

    // Retry goes back through preflight/dispatch and is judged by the same evidence.
    await h.d.workflows.retry(failing.id, 'fix');
    expect(wf(h, failing.id).tasks.fix.attempts).toBe(2);
    const again = await until(h, failing.id, 'failed');
    expect(again.tasks.fix.assignmentId).not.toBe(f.tasks.fix.assignmentId);
  }, 150_000);
});
