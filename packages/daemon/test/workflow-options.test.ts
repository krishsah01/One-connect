// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUMAN, SYSTEM } from '@acc/core';
import { applyWorkflowOptions, terminateWithPickup } from '../src/workflowOptions.ts';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';
let h: Harness | null = null;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); h = null; });
async function setup() {
  h = await startDaemon(makeConfig(makeRepo()), { server: false });
  const item = h.d.createIssue({ title: 'Workflow options', acceptance: ['Check options'] });
  await waitFor(() => h!.d.state.workItems[item.id].key, 5000);
  return { d: h.d, item };
}
describe('workflow assignment options', () => {
  it('freezes selected skills, persists prompt context and scopes tools and peers through dispatch', async () => {
    const { d, item } = await setup();
    const draft = { id: 'selected-skill', name: 'selected-skill', description: 'Use when reviewing workflow steps.', instructions: 'Inspect relevant workflow boundaries.', references: [] };
    d.skillLib.saveDraft(draft, null);
    const hash = d.state.skills![draft.id].draft!.hash;
    d.skillLib.publish(draft.id, null, hash);
    const w = d.workflows.save({ definition: { name: 'Graph', tasks: [{ id: 'build', agentId: 'ag', workItemId: item.id, skills: [draft.id], model: 'chosen', effort: 'medium', context: 'Frozen One Ask answer', pickup: 'Continue from the API', connectors: [], consults: ['codex'] }] } });
    // Relay is a zero-network fixture; promotion still goes through real preflight and dispatch.
    await d.workflows.launch(w.id);
    const a = d.state.assignments[d.workflows.get(w.id).tasks.build.assignmentId!];
    expect(a).toMatchObject({ model: 'chosen', effort: 'medium', connectors: [], consults: ['codex'] });
    expect(a.skills!.some(s => s.id === draft.id && s.version === '1')).toBe(true);
    expect(a.prompt).toContain('Frozen One Ask answer');
    expect(d.assignmentText(a)).toContain('Continue from the API');
    d.skillLib.saveDraft({ ...draft, instructions: 'Changed later' }, null);
    expect(a.skills![0].hash).toBe(d.state.skills![draft.id].versions[0].hash);
    const run = Object.values(d.state.runs).find(r => r.assignmentId === a.id)!;
    expect(run).toBeTruthy();
    expect(() => d.connectors.requestToolCall('unattached', 'read', {}, { runId: run.id })).toThrow('not attached');
    expect(() => d.team.send({ recipients: ['claude'], subject: 'Question', body: 'Can you review?', runId: run.id }, { type: 'agent', id: 'ag' })).toThrow('not connected');
    expect(d.team.send({ recipients: ['codex'], subject: 'Question', body: 'Can you review?', runId: run.id }, { type: 'agent', id: 'ag' }).recipients).toEqual(['codex']);
    const pickups = await d.workflows.terminateWithPickup(w.id);
    expect(d.workflows.get(w.id).status).toBe('canceled');
    expect(pickups.build).toContain('Previous run:');
    expect(pickups.build!.length).toBeLessThanOrEqual(2000);
  });
  it('waits for a new streaming handoff, then cancels even on timeout', async () => {
    const { d, item } = await setup();
    const w = d.workflows.save({ definition: { name: 'Streaming', tasks: [{ id: 'build', agentId: 'ag', workItemId: item.id }] } });
    await d.workflows.launch(w.id);
    const run = Object.values(d.state.runs).find(r => r.assignmentId === d.workflows.get(w.id).tasks.build.assignmentId)!;
    // Stored relay run is replaced with a streaming protocol fixture; no executable is launched.
    d.state.runs[run.id] = { ...run, adapter: 'claude-headless', state: 'running' };
    vi.spyOn(d.runs, 'send').mockImplementation(async id => {
      d.commit([{ type: 'run.handoff', runId: id, actor: SYSTEM, data: { handoff: { done: 'Saved the API stub', evidence: [], commit: null, blocked: null, next: 'Finish validation', source: 'mcp', raw: '' } } }]);
      return { delivered: 'live' };
    });
    const pickups = await terminateWithPickup(d, w.id, HUMAN, 20);
    expect(d.runs.send).toHaveBeenCalledOnce();
    expect(pickups.build).toContain('Finish validation');
    expect(d.workflows.get(w.id).status).toBe('canceled');
  });
  it('rechecks option resources immediately before assignment dispatch', async () => {
    const { d, item } = await setup();
    const a = d.createAssignment({ workItemId: item.id, agentId: 'ag' });
    expect(() => applyWorkflowOptions(d, a, { id: 'a', title: 'a', workItemId: item.id, agentId: 'ag', kind: 'code', dependsOn: [], reviewOf: null, requiredChecks: null, allowedPaths: [], skills: ['not-published'] })).toThrow('published');
  });
});
