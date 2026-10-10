// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { compileSketch, deriveGraph, type WorkflowTaskDef } from '../src/index.ts';
const task = (id: string, agentId: string, consults: string[]): WorkflowTaskDef => ({
  id, agentId, consults, title: id, workItemId: 'issue', kind: 'code', dependsOn: [],
  allowedPaths: [], requiredChecks: null, reviewOf: null,
});
it('preserves peer-only consults and different scopes for steps using the same agent without granting reciprocal access', () => {
  const tasks = [task('first', 'ag', ['codex']), task('second', 'codex', []), task('third', 'ag', ['claude'])];
  const { definition, problems } = compileSketch({ name: 'Saved graph', mode: 'collaborative', graph: deriveGraph(tasks) });
  expect(problems).toEqual([]);
  expect(definition.tasks.map(t => ({ id: t.id, consults: t.consults }))).toEqual(tasks.map(t => ({ id: t.id, consults: t.consults })));
});
it('draws reciprocal task peers once and preserves both scopes on recompile', () => {
  const graph = deriveGraph([task('first', 'ag', ['codex']), task('second', 'codex', ['ag'])]);
  expect(graph.nodes.filter(n => n.type === 'agent')).toHaveLength(2);
  expect(graph.edges.filter(e => e.fromPort === 'consult')).toHaveLength(1);
  expect(compileSketch({ name: 'Reciprocal', mode: 'collaborative', graph }).definition.tasks.map(t => t.consults)).toEqual([['codex'], ['ag']]);
});
