// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  currentApproval,
  deriveWorkflowStatus,
  emptyState,
  emptyTaskState,
  evaluateMergeGates,
  findCycle,
  generateReviewText,
  mergeActionHash,
  modelFamilyKey,
  newAgentState,
  normalizeWorkflow,
  parseConfig,
  parseFindingText,
  pickNewest,
  readyTaskIds,
  runPreflight,
  selectNewestModel,
  sharedUsageView,
  validateWorkflow,
  type Assignment,
  type ControlState,
  type ModelInfo,
  type ReviewRecord,
  type WorkItem,
  type Workflow,
} from '../src/index.ts';

const cfg = parseConfig({
  project: { name: 'demo', repo: '/tmp/demo', integration_branch: 'integration', protected_branches: ['main'], production_branch: 'prod', checks: { test: 'npm test' } },
  agents: [
    { id: 'claude', name: 'Claude', role: 'engineer', adapter: 'claude-headless' },
    { id: 'claude2', name: 'Claude Reviewer', role: 'reviewer', adapter: 'claude-headless' },
    { id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' },
    { id: 'lead', name: 'Lead', role: 'lead', adapter: 'claude-headless', mode: 'coordinator-only' },
    { id: 'cursor', name: 'Cursor', role: 'engineer', adapter: 'cursor-agent-cli', model: 'newest' },
  ],
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id, key: id.toUpperCase(), trackerId: id, url: null, title: id, description: '', acceptance: [], labels: [], priority: 2, parentKey: null, blockedBy: [],
    state: 'selected', blockedOn: null, resumeTo: null, ownerAgentId: null, assignmentIds: [], runIds: [], branches: [], evidence: [], requiresProductionVerification: false,
    trackerStatus: null, sync: { status: 'synced', lastError: null, at: null }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
  };
}

function state(items: WorkItem[] = [item('wi1'), item('wi2')]): ControlState {
  const s = emptyState();
  for (const a of cfg.agents) s.agents[a.id] = newAgentState(a);
  for (const i of items) s.workItems[i.id] = i;
  return s;
}

describe('workflow validation', () => {
  const s = state();
  const code = (id: string, over: Record<string, unknown> = {}) => ({ id, workItemId: 'wi1', agentId: 'claude', kind: 'code', allowedPaths: [`src/${id}/**`], ...over });

  it('normalizes review edges and finds cycles with their path', () => {
    const def = normalizeWorkflow({ name: 'x', tasks: [code('a', { dependsOn: ['c'] }), { id: 'b', kind: 'review', reviewOf: 'a', agentId: 'codex' }, code('c', { workItemId: 'wi2', dependsOn: ['b'] })] });
    expect(def.mode).toBe('collaborative');
    expect(def.tasks[1]).toMatchObject({ workItemId: 'wi1', dependsOn: ['a'] });
    expect(findCycle(def)).toEqual(['a', 'c', 'b', 'a']);
    expect(validateWorkflow(def, s).map((i) => i.code)).toContain('cycle');
  });

  it('every task needs an existing issue and agent; coordinator-only agents only coordinate', () => {
    const issues = validateWorkflow(normalizeWorkflow({ name: 'x', tasks: [code('a', { workItemId: 'nope' }), code('b', { workItemId: 'wi2', agentId: 'ghost' }), code('c', { workItemId: 'wi2', agentId: 'lead', allowedPaths: ['docs/**'] })] }), s);
    expect(issues.map((i) => [i.code, i.taskId])).toEqual(expect.arrayContaining([['unknown_item', 'a'], ['unknown_agent', 'b'], ['coordinator_code', 'c']]));
    const coord = validateWorkflow(normalizeWorkflow({ name: 'x', tasks: [{ id: 'plan', workItemId: 'wi1', agentId: 'lead', kind: 'coordination' }] }), s);
    expect(coord.map((i) => i.code)).toEqual(['coordinator_label']);
    const labeled = state([item('wi1', { labels: ['planning'] })]);
    expect(validateWorkflow(normalizeWorkflow({ name: 'x', tasks: [{ id: 'plan', workItemId: 'wi1', agentId: 'lead', kind: 'coordination' }] }), labeled)).toEqual([]);
  });

  it('rejects concurrent overlapping writers but allows ordered ones; reviewers must be independent', () => {
    const parallel = normalizeWorkflow({ name: 'x', mode: 'independent', tasks: [code('a', { allowedPaths: ['src/**'] }), code('b', { workItemId: 'wi2', agentId: 'codex', allowedPaths: ['src/api/**'] })] });
    expect(validateWorkflow(parallel, s).map((i) => i.code)).toEqual(['overlap']);
    const ordered = normalizeWorkflow({ name: 'x', tasks: [code('a', { allowedPaths: ['src/**'] }), code('b', { workItemId: 'wi2', agentId: 'codex', allowedPaths: ['src/api/**'], dependsOn: ['a'] })] });
    expect(validateWorkflow(ordered, s)).toEqual([]);
    const self = normalizeWorkflow({ name: 'x', tasks: [code('a'), { id: 'r', kind: 'review', reviewOf: 'a', agentId: 'claude' }] });
    expect(validateWorkflow(self, s).map((i) => i.code)).toEqual(['review_self']);
    expect(validateWorkflow(normalizeWorkflow({ name: 'x', tasks: [code('a')] }), state([item('wi1', { key: null, trackerId: null })]), { forStart: true }).map((i) => i.code)).toEqual(['item_untracked']);
    expect(validateWorkflow(normalizeWorkflow({ name: 'x', tasks: [code('a', { requiredChecks: ['lint'] })] }), s, { projectChecks: cfg.project.checks }).map((i) => i.code)).toEqual(['unknown_check']);
  });

  it('promotion order and derived status come only from task states', () => {
    const def = normalizeWorkflow({ name: 'x', tasks: [code('a'), { id: 'r', kind: 'review', reviewOf: 'a', agentId: 'codex' }, code('b', { workItemId: 'wi2', dependsOn: ['r'] })] });
    const now = '2026-01-01T00:00:00Z';
    const w: Workflow = { id: 'wf', version: 1, definition: def, status: 'running', statusReason: null, tasks: { a: emptyTaskState(now), r: emptyTaskState(now), b: emptyTaskState(now) }, createdAt: now, updatedAt: now, startedAt: now, endedAt: null };
    expect(readyTaskIds(w)).toEqual(['a']);
    w.tasks.a = { ...w.tasks.a, status: 'done' };
    expect(readyTaskIds(w)).toEqual(['r']);
    w.tasks.r = { ...w.tasks.r, status: 'changes_requested', reason: 'needs work' };
    expect(deriveWorkflowStatus(w)).toEqual({ status: 'blocked', reason: 'r: needs work' });
    expect(deriveWorkflowStatus({ ...w, status: 'paused' }).status).toBe('paused');
    w.tasks.r = { ...w.tasks.r, status: 'done' };
    w.tasks.b = { ...w.tasks.b, status: 'failed', reason: 'test failed' };
    expect(deriveWorkflowStatus(w).status).toBe('failed');
    w.tasks.b = { ...w.tasks.b, status: 'done' };
    expect(deriveWorkflowStatus(w).status).toBe('completed');
  });
});

describe('safe model selection', () => {
  const ids = (...x: string[]): ModelInfo[] => x.map((id) => ({ id }));

  it('never compares version numbers across unrelated families', () => {
    const models = ids('claude-opus-5-thinking-high', 'gpt-5.6-sol-high', 'claude-opus-4-8-thinking-high');
    expect(modelFamilyKey('claude-opus-4-8-thinking-high')).toBe('claude-opus');
    expect(modelFamilyKey('gpt-5.6-sol-high')).toBe('gpt-sol');
    // The old picker would choose gpt-5.6 because 5.6 > 5.
    expect(pickNewest(models)?.id).toBe('gpt-5.6-sol-high');
    expect(selectNewestModel(models)).toMatchObject({ model: null, reason: 'ambiguous', families: ['claude-opus', 'gpt-sol'] });
    expect(selectNewestModel(models, { family: 'claude-opus' })).toMatchObject({ model: { id: 'claude-opus-5-thinking-high' }, reason: 'single_family' });
    expect(selectNewestModel(models, { allowed: ['claude-opus-*', 'gpt-*'] })).toMatchObject({ model: { id: 'claude-opus-5-thinking-high' }, reason: 'allowlist_order' });
    expect(selectNewestModel([{ id: 'gpt-6-astra', priority: 2 }, { id: 'gpt-5.6-sol', priority: 5 }]).model?.id).toBe('gpt-6-astra');
  });

  it('preflight blocks an ambiguous "newest" instead of guessing', () => {
    const a = newAgentState(cfg.agents.find((x) => x.id === 'cursor')!);
    a.auth = { state: 'logged_in' };
    a.billing = { mode: 'subscription', source: 'test', overage: 'off' };
    a.models.available = ids('claude-opus-5-thinking-high', 'gpt-5.6-sol-high');
    const asg = { id: 'as1', workItemId: 'wi1', agentId: 'cursor', position: 'draft', scope: '', allowedPaths: ['src/**'], worktree: null, branch: null, baseRef: 'integration', baseSha: null, requiredChecks: ['test'], askHumanIf: [], handoffFormat: '', prompt: 'x', promptEdited: false, model: null, effort: null, preflight: null, createdAt: '', dispatchedAt: null } satisfies Assignment;
    const r = runPreflight({ now: '2026-01-01T00:00:00Z', project: cfg.project, policies: cfg.policies, killSwitch: false, activeAssignments: [], item: item('wi1'), assignment: asg, agent: a });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'model')).toMatchObject({ status: 'fail', message: expect.stringMatching(/several model lines/) });
  });
});

describe('shared usage', () => {
  it('says which agents share a login and who reported the numbers', () => {
    const s = state();
    s.agents.claude2.usage = { windows: [{ name: 'five_hour', usedPercent: 62, resetsAt: null }], status: 'ok', checkedAt: '2026-01-01T00:00:00Z', source: 'probe' };
    const v = sharedUsageView(s.agents, 'claude');
    expect(v).toMatchObject({ group: 'anthropic', shared: true, reportedBy: { id: 'claude2' } });
    expect(v.peers.map((p) => p.id).sort()).toEqual(['claude2', 'lead']);
    expect(v.note).toBe('Shared anthropic subscription with Claude Reviewer, Lead · numbers reported by Claude Reviewer');
    expect(sharedUsageView(s.agents, 'codex').note).toBe('openai subscription · vendor does not expose remaining usage');
  });
});

describe('reviews and merge gates', () => {
  function review(over: Partial<ReviewRecord> = {}): ReviewRecord {
    return { id: 'rev1', workItemId: 'wi1', targetSha: SHA_A, sourceBranch: 'claude/WI1-x', baseSha: null, authorAgentId: 'claude', reviewer: { type: 'agent', id: 'codex' }, assignmentId: 'as2', runId: null, workflowId: null, taskId: null, verdict: 'approve', summary: '', findings: [], evidenceIds: [], source: 'mcp', at: '2026-01-01T00:00:00Z', staleAt: null, staleReason: null, ...over };
  }
  function mergeState(over: { item?: Partial<WorkItem>; reviews?: ReviewRecord[] } = {}) {
    const s = state([item('wi1', { state: 'approved', branches: ['claude/WI1-x'], evidence: [{ id: 'e1', kind: 'test', summary: 'ok', command: 'npm test', exitCode: 0, sha: SHA_A, verified: true, at: '' }], ...over.item })]);
    s.assignments.as1 = { id: 'as1', workItemId: 'wi1', agentId: 'claude', position: 'done', scope: '', allowedPaths: [], worktree: '/w', branch: 'claude/WI1-x', baseRef: 'integration', baseSha: null, requiredChecks: ['test'], askHumanIf: [], handoffFormat: '', prompt: '', promptEdited: false, model: null, effort: null, preflight: null, createdAt: '1', dispatchedAt: null };
    for (const r of over.reviews ?? [review()]) s.reviews[r.id] = r;
    return s;
  }
  const gates = (s: ControlState, o: { target?: string; sha?: string } = {}) => evaluateMergeGates({ state: s, project: cfg.project, workItemId: 'wi1', sourceBranch: 'claude/WI1-x', sourceSha: o.sha ?? SHA_A, target: o.target ?? 'integration' });
  const failing = (g: ReturnType<typeof gates>) => g.filter((x) => !x.ok).map((x) => x.id);

  it('passes with an independent approval and green checks at the exact SHA', () => {
    expect(failing(gates(mergeState()))).toEqual([]);
  });

  it('refuses protected or production targets', () => {
    expect(failing(gates(mergeState(), { target: 'main' }))).toEqual(['target']);
    expect(failing(gates(mergeState(), { target: 'prod' }))).toEqual(['target']);
    expect(gates(mergeState(), { target: 'feature' }).find((g) => g.id === 'target')?.detail).toMatch(/not the integration branch/);
  });

  it('refuses self-approval, stale approvals, and non-green checks', () => {
    const self = mergeState({ reviews: [review({ reviewer: { type: 'agent', id: 'claude' } })] });
    expect(currentApproval(self, 'wi1', SHA_A)).toBeNull();
    expect(gates(self).find((g) => g.id === 'review')?.detail).toMatch(/cannot approve their own/);
    const moved = gates(mergeState(), { sha: SHA_B });
    expect(moved.find((g) => g.id === 'review')?.detail).toMatch(/stale/);
    expect(moved.find((g) => g.id === 'checks')?.detail).toMatch(/not recorded/);
    const red = mergeState({ item: { evidence: [{ id: 'e1', kind: 'test', summary: 'x', command: 'npm test', exitCode: 1, sha: SHA_A, verified: true, at: '' }] } });
    expect(failing(gates(red))).toEqual(['checks']);
    const claimed = mergeState({ item: { evidence: [{ id: 'e1', kind: 'test', summary: 'x', command: 'npm test', exitCode: 0, sha: SHA_A, verified: false, at: '' }] } });
    expect(failing(gates(claimed))).toEqual(['checks']);
    expect(failing(gates(mergeState({ item: { state: 'handoff_received' } })))).toEqual(['lifecycle']);
  });

  it('refuses while a workflow prerequisite is unfinished or the workflow is paused', () => {
    const s = mergeState();
    const def = normalizeWorkflow({ name: 'Flow', tasks: [{ id: 'spec', workItemId: 'wi2', agentId: 'codex', kind: 'code', allowedPaths: ['docs/**'] }, { id: 'impl', workItemId: 'wi1', agentId: 'claude', kind: 'code', allowedPaths: ['src/**'], dependsOn: ['spec'] }] });
    const now = '2026-01-01T00:00:00Z';
    s.workflows.wf = { id: 'wf', version: 1, definition: def, status: 'running', statusReason: null, tasks: { spec: { ...emptyTaskState(now), status: 'running' }, impl: { ...emptyTaskState(now), status: 'done' } }, createdAt: now, updatedAt: now, startedAt: now, endedAt: null };
    expect(gates(s).find((g) => g.id === 'workflow')).toMatchObject({ ok: false, detail: 'Flow/spec is running' });
    s.workflows.wf = { ...s.workflows.wf, status: 'paused', tasks: { spec: { ...emptyTaskState(now), status: 'done' }, impl: { ...emptyTaskState(now), status: 'done' } } };
    expect(gates(s).find((g) => g.id === 'workflow')?.detail).toMatch(/paused/);
  });

  it('binds merge actions to exact SHAs and records invalidation once', () => {
    const base = { workItemId: 'wi1', sourceBranch: 'b', sourceSha: SHA_A, target: 'integration', targetSha: SHA_B, reviewId: 'rev1' };
    expect(mergeActionHash(base)).toBe(mergeActionHash({ ...base }));
    expect(mergeActionHash(base)).not.toBe(mergeActionHash({ ...base, sourceSha: SHA_B }));
    expect(mergeActionHash(base)).not.toBe(mergeActionHash({ ...base, targetSha: SHA_A }));
    let s = mergeState();
    const env = (seq: number, type: string, data: unknown) => ({ seq, id: `e${seq}`, ts: `2026-01-01T00:00:0${seq}Z`, kind: 'control', type, actor: { type: 'system', id: 'cc' }, data }) as never;
    s = applyEvent(s, env(1, 'review.invalidated', { reviewId: 'rev1', reason: 'new commit' }));
    s = applyEvent(s, env(2, 'review.invalidated', { reviewId: 'rev1', reason: 'again' }));
    expect(s.reviews.rev1).toMatchObject({ staleReason: 'new commit', staleAt: '2026-01-01T00:00:01Z' });
    expect(currentApproval(s, 'wi1', SHA_A)).toBeNull();
  });

  it('parses findings and writes a review prompt bound to the target SHA', () => {
    expect(parseFindingText('major: src/a.ts:12 - leaks the token')).toMatchObject({ severity: 'major', path: 'src/a.ts', line: 12, title: 'leaks the token' });
    const text = generateReviewText({ project: cfg.project, agent: { name: 'Codex', role: 'reviewer' }, item: { key: 'WI1', title: 'x', description: 'goal', acceptance: ['works'] }, assignmentId: 'as2', scope: '', review: { targetSha: SHA_A, sourceBranch: 'claude/WI1-x', baseSha: SHA_B, authorAgentId: 'claude', authorAssignmentId: 'as1' }, authorName: 'Claude', worktree: '/r', branch: 'review/x', checks: [{ name: 'test', command: 'npm test', status: 'pass', evidence: null }], authorHandoff: 'Done: it', relay: false });
    expect(text).toContain(`Target SHA: ${SHA_A}`);
    expect(text).toContain("Author's handoff (a claim, not evidence)");
    expect(text).toContain('submit_review');
  });
});
