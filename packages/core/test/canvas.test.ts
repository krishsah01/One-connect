// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  CANVAS_LIMITS, continuationSketch, DEFAULT_SHOW_WHEN, emptyTaskState, frameVisible, isWorkflowLocked, normalizeCanvas, pickupPoint,
  sketchDefinition, workflowAttention, type ControlState, type Workflow,
} from '../src/index.ts';

const at = '2026-10-09T00:00:00.000Z';

function workflow(status: Workflow['status'], tasks: Record<string, Partial<ReturnType<typeof emptyTaskState>>> = {}): Workflow {
  return {
    id: 'wf1', version: 2, status, statusReason: null, createdAt: at, updatedAt: at, startedAt: at, endedAt: null,
    definition: { name: 'Checkout', mode: 'collaborative', tasks: [
      { id: 'build', title: 'Build it', workItemId: 'w1', agentId: 'codex', kind: 'code', dependsOn: [], allowedPaths: ['src/**'], requiredChecks: null, reviewOf: null },
      { id: 'review', title: 'Review it', workItemId: 'w1', agentId: 'cursor', kind: 'review', dependsOn: ['build'], allowedPaths: [], requiredChecks: null, reviewOf: 'build' },
      { id: 'docs', title: 'Docs', workItemId: 'w2', agentId: 'codex', kind: 'code', dependsOn: ['build'], allowedPaths: [], requiredChecks: null, reviewOf: null },
    ] },
    tasks: { build: { ...emptyTaskState(at), ...tasks.build }, review: { ...emptyTaskState(at), ...tasks.review }, docs: { ...emptyTaskState(at), ...tasks.docs } },
  };
}

const run = (id: string, assignmentId: string, extra: Record<string, unknown> = {}) => ({ id, assignmentId, createdAt: at, handoff: null, exit: null, ...extra });

describe('canvas layout', () => {
  it('keeps only well-formed, bounded fields', () => {
    const l = normalizeCanvas({
      frames: { wf1: { x: 12.6, y: 'nope', hidden: true, showWhen: { input: false } }, 'bad id!': { x: 1, y: 1 } },
      nodes: { 'wf1/t:build': { x: 1e12, y: -3 }, 'no-slash': { x: 0, y: 0 } },
      sketches: { s1: { name: 'x'.repeat(500), mode: 'weird', tasks: [{ id: 't', kind: 'evil', dependsOn: ['a', 'a'], pickup: 'p'.repeat(5000) }], extra: 1 } },
      injected: true,
    });
    expect(l.frames).toEqual({ wf1: { x: 13, y: 0, hidden: true, showWhen: { input: false, failure: true, finished: false } } });
    expect(l.nodes).toEqual({ 'wf1/t:build': { x: 1e6, y: -3 } });
    const s = l.sketches.s1;
    expect(s.name).toHaveLength(120);
    expect(s.mode).toBe('collaborative');
    expect(s.tasks[0]).toMatchObject({ kind: 'code', dependsOn: ['a'], reviewOf: null });
    expect(s.tasks[0].pickup).toHaveLength(CANVAS_LIMITS.pickup);
    expect(Object.keys(l)).toEqual(['version', 'frames', 'nodes', 'sketches']);
  });

  it('turns a sketch into a workflow definition with the implicit review dependency', () => {
    const def = sketchDefinition({ id: 's', name: 'N', mode: 'collaborative', workflowId: null, version: null, continues: null, issues: [], updatedAt: at, tasks: [
      { id: 'b', title: '', kind: 'code', agentId: 'codex', workItemId: 'w1', dependsOn: [], reviewOf: null, allowedPaths: [], pickup: null },
      { id: 'r', title: '', kind: 'review', agentId: 'cursor', workItemId: '', dependsOn: [], reviewOf: 'b', allowedPaths: [], pickup: 'ignored by the engine' },
    ] });
    expect(def.tasks[1]).toMatchObject({ reviewOf: 'b', dependsOn: ['b'], workItemId: 'w1' });
    expect(JSON.stringify(def)).not.toContain('pickup');
  });

  it('locks every workflow that is not a draft', () => {
    expect(isWorkflowLocked({ status: 'draft' })).toBe(false);
    for (const s of ['running', 'paused', 'blocked', 'failed', 'completed', 'canceled'] as const) expect(isWorkflowLocked({ status: s })).toBe(true);
  });
});

describe('hidden workflows', () => {
  const state = (extra: Partial<ControlState> = {}) => ({ approvals: {}, decisions: {}, runs: {}, ...extra }) as unknown as ControlState;

  it('come back only for the conditions the owner chose', () => {
    const w = workflow('running', { build: { status: 'running', assignmentId: 'a1' } });
    const quiet = workflowAttention(w, state({ runs: { r1: run('r1', 'a1') } as never }));
    expect(quiet).toEqual({ input: 0, failure: false, finished: false });
    const hidden = { x: 0, y: 0, hidden: true, showWhen: DEFAULT_SHOW_WHEN };
    expect(frameVisible(hidden, quiet)).toBe(false);
    expect(frameVisible(undefined, quiet)).toBe(true);

    const asking = workflowAttention(w, state({ runs: { r1: run('r1', 'a1') } as never, approvals: { ap: { id: 'ap', runId: 'r1', resolvedAt: null } } as never }));
    expect(asking.input).toBe(1);
    expect(frameVisible(hidden, asking)).toBe(true);
    expect(frameVisible({ ...hidden, showWhen: { input: false, failure: true, finished: true } }, asking)).toBe(false);

    const decided = workflowAttention(w, state({ decisions: { d: { id: 'd', workItemId: 'w2', answeredAt: null, consumedAt: null } } as never }));
    expect(decided.input).toBe(1);

    const blocked = workflowAttention(workflow('running', { docs: { status: 'blocked' } }), state());
    expect(blocked.failure).toBe(true);
    expect(frameVisible(hidden, blocked)).toBe(true);

    const done = workflowAttention(workflow('completed'), state());
    expect(frameVisible(hidden, done)).toBe(false);
    expect(frameVisible({ ...hidden, showWhen: { ...DEFAULT_SHOW_WHEN, finished: true } }, done)).toBe(true);
  });
});

describe('terminate and continue', () => {
  it('reopens only unfinished steps, with the pickup point from their last handoff', () => {
    const w = workflow('canceled', { build: { status: 'done', assignmentId: 'a1' }, review: { status: 'canceled', assignmentId: 'a2' }, docs: { status: 'canceled', assignmentId: 'a3' } });
    const runs = {
      old: run('old', 'a3', { createdAt: '2026-10-08T00:00:00.000Z', exit: { kind: 'stopped', message: 'older' } }),
      r3: run('r3', 'a3', { handoff: { done: 'API split', next: 'Write the client docs', blocked: null, commit: { sha: 'abcdef1234567890', branch: 'acc/docs' }, evidence: [], source: 'mcp', raw: '' } }),
      r2: run('r2', 'a2', { exit: { kind: 'stopped', message: 'stopped by owner' } }),
    } as unknown as ControlState['runs'];
    expect(pickupPoint(w, 'docs', { runs })).toBe('Done: API split\nNext: Write the client docs\nLast commit: abcdef123456 on acc/docs');
    expect(pickupPoint(w, 'review', { runs })).toBe('Stopped: stopped by owner');
    const s = continuationSketch(w, { runs }, 'cont-wf1', at);
    expect(s).toMatchObject({ id: 'cont-wf1', name: 'Checkout (continued)', continues: 'wf1', workflowId: null });
    expect(s.tasks.map(t => t.id)).toEqual(['review', 'docs']);
    // The finished build stays on the original; dependencies on it are dropped, never invented.
    expect(s.tasks.find(t => t.id === 'docs')).toMatchObject({ dependsOn: [], pickup: expect.stringContaining('Next: Write the client docs') });
    expect(s.tasks.find(t => t.id === 'review')).toMatchObject({ reviewOf: null });
  });
});
