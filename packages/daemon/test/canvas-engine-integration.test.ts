// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { compileSketch, deriveGraph, parseHandoff, SYSTEM, type CanvasLayout, type Workflow } from '@acc/core';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); h = null; });
async function api<T>(method: string, route: string, body?: unknown) {
  const token = fs.readFileSync(h!.d.paths.installToken, 'utf8').trim();
  const response = await fetch(h!.url + route, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() as T };
}

it('captures a staged MCP pickup through the canvas route and dispatches a durable continuation with its original scopes', async () => {
  const config = makeConfig(makeRepo());
  h = await startDaemon(config, { probe: false });
  const d = h.d;
  const item = d.createIssue({ title: 'Continue the API', acceptance: ['Verify the API boundary'] });
  await waitFor(() => d.state.workItems[item.id].key, 5000);
  const skill = { id: 'boundary-review', name: 'boundary-review', description: 'Use to verify API boundaries.', instructions: 'Check the saved interface contract.', references: [] };
  d.skillLib.saveDraft(skill, null);
  d.skillLib.publish(skill.id, null, d.state.skills![skill.id].draft!.hash);
  const connector = d.connectors.save({ id: 'api-tools', name: 'API tools', config: { kind: 'mcp', command: process.execPath, args: [], tools: ['read'], read_roots: [] } }, null);
  const task = {
    id: 'build', title: 'Finish the API', kind: 'code' as const, agentId: 'ag', workItemId: item.id,
    dependsOn: [], allowedPaths: ['src/**'], requiredChecks: null, reviewOf: null,
    model: 'selected-model', effort: 'medium' as const, skills: [skill.id], connectors: [connector.id],
    context: 'The saved One Ask answer', consults: ['codex'],
  };
  const original = (await api<{ workflow: Workflow }>('POST', '/api/workflows', { definition: { name: 'API', tasks: [task] } })).body.workflow;
  expect((await api('POST', `/api/workflows/${original.id}/start`)).status).toBe(200);
  const assignmentId = d.workflows.get(original.id).tasks.build.assignmentId!;
  const run = Object.values(d.state.runs).find(r => r.assignmentId === assignmentId)!;
  // A streaming protocol fixture on a real relay assignment: no vendor executable or model call.
  d.state.runs[run.id] = { ...run, adapter: 'claude-headless', state: 'running' };
  vi.spyOn(d.runs, 'send').mockImplementation(async id => {
    // Mirrors post_handoff: stage the parsed handoff, then append the MCP receipt.
    d.runs.setMcpHandoff(id, parseHandoff('### Handoff\nDone: Saved the API stub\nCommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa on fake/claim\nNext: Verify the request parser\nBlocked: none', 'mcp')!);
    d.commit([{ type: 't.system', actor: SYSTEM, runId: id, data: { text: 'handoff posted via MCP: Saved the API stub' } }]);
    return { delivered: 'live' };
  });
  const terminated = await api<{ layout: CanvasLayout; rev: number; sketchId: string }>('POST', `/api/canvas/workflows/${original.id}/terminate`);
  expect(terminated.status).toBe(200);
  expect(d.runs.send).toHaveBeenCalledOnce();
  expect(d.workflows.get(original.id).status).toBe('canceled');
  const sketch = terminated.body.layout.sketches[terminated.body.sketchId];
  const compiled = compileSketch(sketch);
  expect(compiled.problems).toEqual([]);
  expect(compiled.definition.tasks[0]).toMatchObject({
    model: task.model, effort: task.effort, skills: task.skills, connectors: task.connectors,
    context: task.context, consults: task.consults, allowedPaths: task.allowedPaths,
    pickup: expect.stringContaining('Verify the request parser'),
  });
  expect(compiled.definition.tasks[0].pickup).not.toContain('a'.repeat(40)); // staged commit claims are not verified evidence
  expect(Object.values(d.state.assignments)).toHaveLength(1);
  expect(d.state.connectors![connector.id].approvals).toEqual({});
  const saved = await api<{ workflow: Workflow }>('POST', '/api/workflows', { definition: compiled.definition });
  expect(saved.status).toBe(200);
  const dataDir = h.dataDir;
  await h.close();
  h = await startDaemon(config, { dataDir, probe: false });
  const stored = await api<{ layout: CanvasLayout }>('GET', '/api/canvas');
  expect(compileSketch(stored.body.layout.sketches[terminated.body.sketchId]).definition.tasks[0].pickup).toContain('Verify the request parser');
  expect((await api('POST', `/api/workflows/${saved.body.workflow.id}/start`)).status).toBe(200);
  const next = h.d.state.assignments[h.d.workflows.get(saved.body.workflow.id).tasks.build.assignmentId!];
  expect(next.id).not.toBe(assignmentId);
  expect(next).toMatchObject({ model: task.model, effort: task.effort, connectors: task.connectors, consults: task.consults });
  expect(next.skills!.some(s => s.id === skill.id && s.version === '1')).toBe(true);
  expect(next.prompt).toContain(task.context);
  expect(next.prompt).toContain('Verify the request parser');
  expect(h.d.connectors.toolsForAgents(next.id)).toEqual([]);
}, 15_000);

it('leaves completed steps and their evidence on the original workflow when rebuilding the continuation', async () => {
  h = await startDaemon(makeConfig(makeRepo()), { probe: false });
  const d = h.d;
  const item = d.createIssue({ title: 'Continue after planning' });
  await waitFor(() => d.state.workItems[item.id].key, 5000);
  const w = d.workflows.save({ definition: { name: 'Plan then build', tasks: [
    { id: 'plan', kind: 'coordination', agentId: 'ag', workItemId: item.id },
    { id: 'build', kind: 'code', agentId: 'ag', workItemId: item.id, dependsOn: ['plan'], allowedPaths: ['src/**'] },
  ] } });
  await d.workflows.launch(w.id);
  const run = Object.values(d.state.runs).find(r => r.assignmentId === d.workflows.get(w.id).tasks.plan.assignmentId)!;
  await d.workflows.pause(w.id);
  await d.runs.relayResult(run.id, '### Handoff\nDone: Planned the interface\nNext: Implement the parser\nBlocked: none');
  await waitFor(() => d.workflows.get(w.id).tasks.plan.status === 'done', 5000, 'plan completed from the relay handoff');
  const finished = d.workflows.get(w.id).tasks.plan;
  const result = await api<{ layout: CanvasLayout; sketchId: string }>('POST', `/api/canvas/workflows/${w.id}/terminate`);
  expect(result.status).toBe(200);
  const { definition, problems } = compileSketch(result.body.layout.sketches[result.body.sketchId]);
  expect(problems).toEqual([]);
  expect(definition.tasks.map(t => t.id)).toEqual(['build']);
  expect(definition.tasks[0].dependsOn).toEqual([]);
  expect(d.workflows.get(w.id).tasks.plan).toEqual(finished);
  expect(d.state.runs[run.id].handoff?.done).toBe('Planned the interface');
  expect(deriveGraph(definition.tasks).nodes.some(n => n.id === 't:plan')).toBe(false);
});
