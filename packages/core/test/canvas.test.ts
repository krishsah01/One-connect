// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { describe, expect, it } from 'vitest';
import {
  CANVAS_LIMITS, compileSketch, continuationSketch, DEFAULT_SHOW_WHEN, deriveGraph, emptyTaskState, frameVisible, isWorkflowLocked, normalizeCanvas, normalizeGraph,
  pickupPoint, workflowAttention, linkBodyFor, linkMatches, type CanvasGate, type CanvasGraph, type ControlState, type Workflow,
} from '../src/index.ts';

const at = '2026-10-10T00:00:00.000Z';

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
  it('keeps only well-formed, bounded fields and migrates version 1 sketches to graphs', () => {
    const l = normalizeCanvas({
      frames: { wf1: { x: 12.6, y: 'nope', hidden: true, showWhen: { input: false } }, 'bad id!': { x: 1, y: 1 } },
      nodes: { 'wf1/t:build': { x: 1e12, y: -3 }, 'no-slash': { x: 0, y: 0 } },
      sketches: { s1: { name: 'x'.repeat(500), mode: 'weird', tasks: [{ id: 'build', kind: 'evil', agentId: 'codex', workItemId: 'w1', pickup: 'p'.repeat(5000) }], issues: ['w9'] } },
      gates: { g0: { from: 'wf1', kind: 'jev', question: 'Unconfirmed', autoDecide: true, options: [] }, g1: { from: 'wf1', kind: 'jev', question: 'Which next?', autoDecide: true, confirmedAt: '2026-10-10T00:00:00.000Z', options: [{ label: 'Backend', to: 'wf2' }, { label: '', to: 'x' }] }, g2: { from: 'bad id!' } },
      chains: { c1: { from: 'wf1', to: 'wf1' }, c2: { from: 'wf1', to: 'wf2' } },
      injected: true,
    });
    expect(l.version).toBe(2);
    expect(l.frames).toEqual({ wf1: { x: 13, y: 0, hidden: true, showWhen: { input: false, failure: true, finished: false } } });
    expect(l.nodes).toEqual({ 'wf1/t:build': { x: 1e6, y: -3 } });
    const s = l.sketches.s1;
    expect(s.name).toHaveLength(120);
    expect(s.mode).toBe('collaborative');
    expect(s.graph.nodes.map(n => n.id).sort()).toEqual(['a:codex', 'i:w1', 'i:w9', 't:build']);
    expect(s.graph.nodes.find(n => n.id === 't:build')!.data).toMatchObject({ kind: 'code', taskId: 'build' });
    expect(String(s.graph.nodes.find(n => n.id === 't:build')!.data.pickup)).toHaveLength(CANVAS_LIMITS.pickup);
    expect(l.gates.g1).toEqual({ id: 'g1', x: 0, y: 0, from: 'wf1', kind: 'jev', question: 'Which next?', options: [{ label: 'Backend', to: 'wf2' }], autoDecide: true, confirmedAt: '2026-10-10T00:00:00.000Z', maxEvidenceBytes: 8000 });
    // JEV never decides on its own without the owner's recorded confirmation.
    expect(l.gates.g0).toMatchObject({ autoDecide: false, confirmedAt: null });
    expect(Object.keys(l.chains)).toEqual(['c2']);
    expect(Object.keys(l)).toEqual(['version', 'frames', 'nodes', 'sketches', 'gates', 'chains']);
  });

  it('accepts only typed edges and keeps the latest edge on a single-value input', () => {
    const g = normalizeGraph({
      nodes: [{ id: 'a1', type: 'agent', data: { agentId: 'codex', effort: 'huge' } }, { id: 'a2', type: 'agent', data: { agentId: 'cursor' } }, { id: 's', type: 'step', data: { taskId: 'build', kind: 'code' } }, { id: 'i', type: 'issue', data: { workItemId: 'w1' } }, { id: 'evil', type: 'shell', data: {} }],
      edges: [
        { from: 'a1', fromPort: 'agent', to: 's', toPort: 'agent' },
        { from: 'a2', fromPort: 'agent', to: 's', toPort: 'agent' },  // replaces a1: one agent per step
        { from: 'i', fromPort: 'issue', to: 's', toPort: 'agent' },   // wrong type
        { from: 'i', fromPort: 'issue', to: 'evil', toPort: 'x' },
      ],
    });
    expect(g.nodes.map(n => n.id)).toEqual(['a1', 'a2', 's', 'i']);
    expect(g.nodes[0].data.effort).toBeNull();
    expect(g.edges).toEqual([{ id: 'a2.agent>s.agent', from: 'a2', fromPort: 'agent', to: 's', toPort: 'agent' }]);
  });

  it('locks every workflow that is not a draft', () => {
    expect(isWorkflowLocked({ status: 'draft' })).toBe(false);
    for (const s of ['running', 'paused', 'blocked', 'failed', 'completed', 'canceled'] as const) expect(isWorkflowLocked({ status: s })).toBe(true);
  });
});

describe('compiling a graph into a workflow', () => {
  const graph: CanvasGraph = normalizeGraph({
    nodes: [
      { id: 'arch', type: 'agent', data: { agentId: 'claude', model: 'opus', effort: 'high' } },
      { id: 'dev', type: 'agent', data: { agentId: 'codex' } },
      { id: 'rev', type: 'agent', data: { agentId: 'cursor' } },
      { id: 'iss', type: 'issue', data: { workItemId: 'w1' } },
      { id: 'mock', type: 'design', data: { artifactId: 'checkout', rev: 3 } },
      { id: 'sk', type: 'skill', data: { skillId: 'a11y' } },
      { id: 'sk2', type: 'skill', data: { skillId: 'tests' } },
      { id: 'gh', type: 'connector', data: { connectorId: 'github' } },
      { id: 'ask', type: 'ask', data: { question: 'Where is checkout?', answer: 'src/checkout handles it.' } },
      { id: 'b', type: 'step', data: { taskId: 'build', kind: 'code', title: 'Build checkout', allowedPaths: ['src/checkout/**'] } },
      { id: 'r', type: 'step', data: { taskId: 'review', kind: 'review' } },
      { id: 'n', type: 'note', data: { text: 'never sent' } },
    ],
    edges: [
      { from: 'dev', fromPort: 'agent', to: 'b', toPort: 'agent' }, { from: 'iss', fromPort: 'issue', to: 'b', toPort: 'issue' },
      { from: 'mock', fromPort: 'design', to: 'b', toPort: 'design' }, { from: 'sk', fromPort: 'skill', to: 'b', toPort: 'skills' },
      { from: 'sk2', fromPort: 'skill', to: 'dev', toPort: 'skills' }, { from: 'gh', fromPort: 'tools', to: 'dev', toPort: 'tools' },
      { from: 'ask', fromPort: 'context', to: 'b', toPort: 'context' },
      { from: 'dev', fromPort: 'consult', to: 'arch', toPort: 'consult' },
      { from: 'rev', fromPort: 'agent', to: 'r', toPort: 'agent' }, { from: 'b', fromPort: 'done', to: 'r', toPort: 'after' },
    ],
  });

  it('turns wiring into tasks: agent, issue, review target, skills, connectors, design, context and consults', () => {
    const { definition, problems } = compileSketch({ name: 'Checkout', mode: 'collaborative', graph });
    expect(problems).toEqual([]);
    const [build, review] = definition.tasks;
    expect(build).toMatchObject({ id: 'build', agentId: 'codex', workItemId: 'w1', kind: 'code', allowedPaths: ['src/checkout/**'], design: { artifactId: 'checkout', rev: 3 }, context: 'src/checkout handles it.', consults: ['claude'], connectors: ['github'] });
    expect(build.skills!.sort()).toEqual(['a11y', 'tests']);
    expect(review).toMatchObject({ id: 'review', agentId: 'cursor', reviewOf: 'build', dependsOn: ['build'], workItemId: 'w1' });
    expect(JSON.stringify(definition)).not.toContain('never sent');
  });

  it('says what is missing instead of guessing', () => {
    const { problems } = compileSketch({ name: '', mode: 'collaborative', graph: normalizeGraph({ nodes: [{ id: 's', type: 'step', data: { kind: 'code' } }, { id: 'r', type: 'step', data: { kind: 'review', taskId: 'r1' } }], edges: [] }) });
    expect(problems.map(p => p.message)).toEqual(expect.arrayContaining(['Connect an Agent node to this step.', 'Connect an Issue to this step.', 'Connect the Build step this review checks to its After input.']));
    expect(compileSketch({ name: '', mode: 'collaborative', graph: { nodes: [], edges: [] } }).problems.map(p => p.message)).toContain('Add a step.');
  });

  it('draws a saved workflow back as the same graph', () => {
    const g = deriveGraph(workflow('draft').definition.tasks);
    expect(g.nodes.filter(n => n.type === 'agent').map(n => n.data.agentId).sort()).toEqual(['codex', 'cursor']);
    const again = compileSketch({ name: 'Checkout', mode: 'collaborative', graph: g }).definition.tasks.map(({ id, agentId, workItemId, reviewOf, dependsOn }) => ({ id, agentId, workItemId, reviewOf, dependsOn }));
    expect(again).toEqual([
      { id: 'build', agentId: 'codex', workItemId: 'w1', reviewOf: null, dependsOn: [] },
      { id: 'review', agentId: 'cursor', workItemId: 'w1', reviewOf: 'build', dependsOn: ['build'] },
      { id: 'docs', agentId: 'codex', workItemId: 'w2', reviewOf: null, dependsOn: ['build'] },
    ]);
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
    expect(workflowAttention(w, state({ decisions: { d: { id: 'd', workItemId: 'w2', answeredAt: null, consumedAt: null } } as never })).input).toBe(1);
    const blocked = workflowAttention(workflow('running', { docs: { status: 'blocked' } }), state());
    expect(frameVisible(hidden, blocked)).toBe(true);
    const done = workflowAttention(workflow('completed'), state());
    expect(frameVisible(hidden, done)).toBe(false);
    expect(frameVisible({ ...hidden, showWhen: { ...DEFAULT_SHOW_WHEN, finished: true } }, done)).toBe(true);
  });
});

describe('terminate and continue', () => {
  it('reopens only unfinished steps, with the pickup point from their last handoff or the engine', () => {
    const w = workflow('canceled', { build: { status: 'done', assignmentId: 'a1' }, review: { status: 'canceled', assignmentId: 'a2' }, docs: { status: 'canceled', assignmentId: 'a3' } });
    const runs = {
      old: run('old', 'a3', { createdAt: '2026-10-08T00:00:00.000Z', exit: { kind: 'stopped', message: 'older' } }),
      r3: run('r3', 'a3', { handoff: { done: 'API split', next: 'Write the client docs', blocked: null, commit: { sha: 'abcdef1234567890', branch: 'acc/docs' }, evidence: [], source: 'mcp', raw: '' } }),
      r2: run('r2', 'a2', { exit: { kind: 'stopped', message: 'stopped by owner' } }),
    } as unknown as ControlState['runs'];
    expect(pickupPoint(w, 'docs', { runs })).toBe('Done: API split\nNext: Write the client docs\nLast commit: abcdef123456 on acc/docs');
    expect(pickupPoint(w, 'review', { runs })).toBe('Stopped: stopped by owner');
    const s = continuationSketch(w, { runs }, 'cont-wf1', at, { review: 'Agent wrote: re-run the review once docs land' });
    expect(s).toMatchObject({ id: 'cont-wf1', name: 'Checkout (continued)', continues: 'wf1', workflowId: null });
    const steps = s.graph.nodes.filter(n => n.type === 'step');
    expect(steps.map(n => n.data.taskId)).toEqual(['review', 'docs']);
    expect(steps.find(n => n.data.taskId === 'docs')!.data.pickup).toContain('Next: Write the client docs');
    expect(steps.find(n => n.data.taskId === 'review')!.data.pickup).toBe('Agent wrote: re-run the review once docs land');
    // The finished build stays on the original; nothing depends on it in the continuation.
    expect(s.graph.edges.some(e => e.from === 't:build')).toBe(false);
  });
});

describe('canvas links become engine workflow links', () => {
  const saved = (id: string) => ['wf-fe', 'wf-be', 'wf-qa'].includes(id);
  const gate = (p: Partial<CanvasGate> = {}): CanvasGate => ({ id: 'g1', x: 0, y: 0, from: 'wf-fe', kind: 'human', question: 'Ready for the backend?', options: [{ label: 'Backend', to: 'wf-be' }, { label: 'More QA', to: 'wf-qa' }], autoDecide: false, confirmedAt: null, maxEvidenceBytes: 8000, ...p });

  it('activates a chain only between saved workflows', () => {
    expect(linkBodyFor({ kind: 'chain', chain: { id: 'c1', from: 'wf-fe', to: 'sketch-1' } }, saved, null)).toEqual({ body: null, waiting: 'Save both workflows to activate this hand-off.' });
    expect(linkBodyFor({ kind: 'chain', chain: { id: 'c1', from: 'wf-fe', to: 'wf-be' } }, saved, null).body).toEqual({ id: 'canvas-chain-c1', from: 'wf-fe', to: ['wf-be'], gate: null });
  });

  it('says what a decision is missing, and needs a confirmed JEV policy even to recommend', () => {
    expect(linkBodyFor({ kind: 'gate', gate: gate({ options: [{ label: 'Backend', to: 'wf-be' }] }) }, saved, null).waiting).toBe('A decision needs at least two options.');
    expect(linkBodyFor({ kind: 'gate', gate: gate({ options: [{ label: 'A', to: 'wf-be' }, { label: 'A', to: 'wf-qa' }] }) }, saved, null).waiting).toBe('Give each option a different label.');
    expect(linkBodyFor({ kind: 'gate', gate: gate({ kind: 'jev' }) }, saved, 'api.typesafe.ai').waiting).toBe('Confirm what JEV may receive before it can advise.');
    expect(linkBodyFor({ kind: 'gate', gate: gate({ kind: 'jev', confirmedAt: '2026-10-10T00:00:00.000Z' }) }, saved, null).waiting).toBe('Turn JEV on in Settings first, or let you decide.');
    const { body } = linkBodyFor({ kind: 'gate', gate: gate({ kind: 'jev', autoDecide: true, confirmedAt: '2026-10-10T00:00:00.000Z', maxEvidenceBytes: 4000 }) }, saved, 'api.typesafe.ai');
    expect(body).toEqual({ id: 'canvas-gate-g1', from: 'wf-fe', to: ['wf-be', 'wf-qa'], gate: { kind: 'jev', question: 'Ready for the backend?', options: [{ label: 'Backend', to: 'wf-be' }, { label: 'More QA', to: 'wf-qa' }], jev: { autoDecide: true, host: 'api.typesafe.ai', maxEvidenceBytes: 4000, confirmedAt: '2026-10-10T00:00:00.000Z', confirmedBy: 'owner' } } });
    // The engine stamps its own confirmation time and owner; a match ignores those.
    expect(linkMatches({ ...body!, gate: { ...body!.gate!, jev: { ...body!.gate!.jev!, confirmedAt: '2026-10-11T00:00:00.000Z', confirmedBy: 'krish' } } }, body!)).toBe(true);
    expect(linkMatches({ ...body!, to: ['wf-be'] }, body!)).toBe(false);
  });
});
