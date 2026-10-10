// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  branchName,
  canTransition,
  checkQualityFloor,
  emptyState,
  inScope,
  isNewest,
  modelClass,
  newAgentState,
  outOfScope,
  parseConfig,
  parseModelId,
  pickNewest,
  replay,
  runPreflight,
  scopesOverlap,
  type AgentConfig,
  type Assignment,
  type EventEnvelope,
  type ModelInfo,
  type WorkItem,
} from '../src/index.ts';

const cursorModels: ModelInfo[] = [
  'auto',
  'gpt-5.3-codex-high',
  'gpt-5.3-codex-high-fast',
  'claude-opus-5-thinking-high',
  'claude-opus-5-thinking-high-fast',
  'claude-opus-4-8-thinking-high',
  'gpt-5.6-sol-high',
  'gpt-5.6-sol-xhigh',
  'claude-sonnet-5-thinking-high',
  'gemini-3.7-flash-high',
].map((id) => ({ id }));

describe('lifecycle', () => {
  it('rejects invalid transitions', () => {
    expect(canTransition('backlog', 'merged')).toMatchObject({ ok: false });
    expect(canTransition('running', 'handoff_received')).toEqual({ ok: true });
  });

  it('Done requires verified merge AND acceptance evidence', () => {
    expect(canTransition('merged', 'verified')).toMatchObject({ ok: false, reason: expect.stringContaining('merge') });
    expect(canTransition('merged', 'verified', { evidence: [{ kind: 'merge', verified: true }] })).toMatchObject({ ok: false, reason: expect.stringContaining('acceptance') });
    expect(canTransition('merged', 'verified', { evidence: [{ kind: 'acceptance', verified: true }] })).toMatchObject({ ok: false, reason: expect.stringContaining('merge') });
    const ev = [
      { kind: 'merge', verified: true },
      { kind: 'acceptance', verified: true, env: 'local' },
    ];
    expect(canTransition('merged', 'verified', { evidence: ev })).toEqual({ ok: true });
    expect(canTransition('deployed', 'verified', { evidence: ev, requiresProductionVerification: true })).toMatchObject({ ok: false });
    expect(canTransition('deployed', 'verified', { evidence: [...ev, { kind: 'acceptance', verified: true, env: 'production' }], requiresProductionVerification: true })).toEqual({ ok: true });
  });
});

describe('models', () => {
  it('parses ids', () => {
    expect(parseModelId('gpt-5.3-codex-high-fast')).toMatchObject({ version: [5, 3], effort: 'high', fast: true, base: 'gpt-5.3-codex' });
    expect(parseModelId('claude-opus-4-1-20250805')).toMatchObject({ version: [4, 1], date: 20250805 });
    expect(parseModelId('o3')).toMatchObject({ version: [3] });
  });

  it('picks the newest model in a family, skipping fast variants and auto', () => {
    expect(pickNewest(cursorModels, { family: 'claude-opus', effort: 'high' })?.id).toBe('claude-opus-5-thinking-high');
    expect(pickNewest(cursorModels, { family: 'gpt', effort: 'xhigh' })?.id).toBe('gpt-5.6-sol-xhigh');
    expect(pickNewest(cursorModels, { family: 'gpt', effort: 'high' })?.id).toBe('gpt-5.6-sol-high');
  });

  it('flags a stale model', () => {
    expect(isNewest('claude-opus-4-8-thinking-high', cursorModels, { family: 'claude-opus', effort: 'high' })).toEqual({ newest: false, best: 'claude-opus-5-thinking-high' });
    expect(isNewest('claude-opus-5-thinking-high', cursorModels, { family: 'claude-opus' }).newest).toBe(true);
  });

  it('uses vendor priority as a tiebreaker (Codex catalog)', () => {
    const codex: ModelInfo[] = [
      { id: 'gpt-6-astra', priority: 2 },
      { id: 'gpt-reserve', priority: 4, hidden: true },
      { id: 'gpt-5.6-sol', priority: 5 },
    ];
    expect(pickNewest(codex)?.id).toBe('gpt-6-astra');
  });

  it('classifies models and checks quality floors', () => {
    expect(modelClass('gemini-3.7-flash-lite')).toBe('lite');
    expect(modelClass('claude-haiku-4-5')).toBe('lite');
    expect(modelClass('gemini-3.7-flash-high')).toBe('standard');
    expect(modelClass('claude-opus-5-thinking-high')).toBe('opus-class');
    expect(modelClass('opus')).toBe('opus-class');
    expect(modelClass('claude-sonnet-5-thinking-high')).toBe('sonnet-class');
    expect(modelClass('mystery-model')).toBeNull();
    expect(checkQualityFloor('gemini-3.7-flash-lite', 'high', 'sonnet-class high').status).toBe('fail');
    expect(checkQualityFloor('claude-sonnet-5-thinking-high', null, 'opus-class high').status).toBe('fail');
    expect(checkQualityFloor('claude-opus-5-thinking-high', null, 'opus-class high').status).toBe('pass');
    expect(checkQualityFloor('gpt-6-astra', 'low', 'sonnet-class high').status).toBe('fail');
    expect(checkQualityFloor('mystery', 'high', 'sonnet-class').status).toBe('warn');
  });
});

describe('path scopes', () => {
  it('matches globs', () => {
    expect(inScope('src/auth/login.ts', ['src/**'])).toBe(true);
    expect(inScope('docs/a.md', ['docs/*.md'])).toBe(true);
    expect(inScope('docs/x/a.md', ['docs/*.md'])).toBe(false);
    expect(inScope('package.json', ['src/**'])).toBe(false);
    expect(outOfScope(['src/a.ts', 'README.md', '.cursor/mcp.json'], ['src/**'], ['.cursor/mcp.json'])).toEqual(['README.md']);
  });

  it('detects possible overlap conservatively', () => {
    expect(scopesOverlap(['src/**'], ['src/auth/**'])).toBe(true);
    expect(scopesOverlap(['src/api/**'], ['src/web/**'])).toBe(false);
    expect(scopesOverlap(['package.json'], ['*.json'])).toBe(true);
    expect(scopesOverlap([], ['docs/**'])).toBe(true);
  });

  it('builds branch names', () => {
    expect(branchName('codex', 'ENG-12', 'Fix: login double-submit!')).toBe('codex/ENG-12-fix-login-double-submit');
  });
});

const cfg = parseConfig({
  project: { name: 'demo', repo: '/tmp/demo', checks: { test: 'npm test' } },
  policies: { quality_floor: { code: 'sonnet-class high' } },
  agents: [
    { id: 'cursor', name: 'Cursor', role: 'engineer', adapter: 'cursor-agent-cli', model: 'newest', model_family: 'claude-opus', effort: 'high' },
    { id: 'lead', name: 'Lead', role: 'lead', adapter: 'claude-headless', mode: 'coordinator-only' },
  ],
});

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi_1', key: 'LOC-1', trackerId: '1', url: null, title: 'Fix login', description: '', acceptance: [], labels: [], priority: 2, parentKey: null, blockedBy: [],
    state: 'selected', blockedOn: null, resumeTo: null, ownerAgentId: null, assignmentIds: [], runIds: [], branches: [], evidence: [], requiresProductionVerification: false,
    trackerStatus: null, sync: { status: 'synced', lastError: null, at: null }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
  };
}
function assignment(over: Partial<Assignment> = {}): Assignment {
  return {
    id: 'as_1', workItemId: 'wi_1', agentId: 'cursor', position: 'draft', scope: '', allowedPaths: ['src/**'], worktree: null, branch: null, baseRef: 'integration', baseSha: null,
    requiredChecks: ['test'], askHumanIf: [], handoffFormat: '', prompt: 'do the thing', promptEdited: false, model: null, effort: null, preflight: null, createdAt: '', dispatchedAt: null, ...over,
  };
}
function agent(c: AgentConfig) {
  const a = newAgentState(c);
  a.auth = { state: 'logged_in' };
  a.billing = { mode: 'subscription', source: 'test', overage: 'off' };
  a.models.available = cursorModels;
  return a;
}

describe('preflight', () => {
  const base = { now: '2026-01-01T00:00:00Z', project: cfg.project, policies: cfg.policies, killSwitch: false, activeAssignments: [] as Assignment[] };

  it('passes a clean dispatch and resolves the newest model', () => {
    const r = runPreflight({ ...base, item: item(), assignment: assignment(), agent: agent(cfg.agents[0]) });
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.model).toBe('claude-opus-5-thinking-high');
  });

  it('blocks: no tracker issue, stale model, metered billing, path overlap, secrets, coordinator-only', () => {
    const a = agent(cfg.agents[0]);
    a.billing = { mode: 'metered', source: 'CURSOR_API_KEY set', overage: 'unknown' };
    const r = runPreflight({
      ...base,
      item: item({ key: null, trackerId: null }),
      assignment: assignment({ model: 'claude-opus-4-8-thinking-high', prompt: `token ghp_${'a'.repeat(36)}` }),
      agent: a,
      activeAssignments: [assignment({ id: 'as_2', agentId: 'codex', allowedPaths: ['src/auth/**'], position: 'now' })],
    });
    const failed = r.checks.filter((c) => c.status === 'fail').map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(['issue', 'billing', 'newest', 'paths', 'secrets']));
    expect(r.checks.find((c) => c.id === 'newest')?.fix).toEqual({ kind: 'use_model', model: 'claude-opus-5-thinking-high' });
    expect(r.ok).toBe(false);

    const lead = runPreflight({ ...base, item: item(), assignment: assignment({ agentId: 'lead' }), agent: agent(cfg.agents[1]) });
    expect(lead.checks.find((c) => c.id === 'coordinator')?.status).toBe('fail');
  });

  it('blocks everything when the kill switch is engaged', () => {
    const r = runPreflight({ ...base, killSwitch: true, item: item(), assignment: assignment(), agent: agent(cfg.agents[0]) });
    expect(r.ok).toBe(false);
  });
});

describe('config', () => {
  it('rejects silent paid fallbacks', () => {
    expect(() => parseConfig({ project: { name: 'x', repo: '/x' }, agents: [{ id: 'c', name: 'C', role: 'engineer', adapter: 'cursor-agent-cli', on_demand: true }] })).toThrow(/on_demand requires metered_opt_in/);
    expect(() => parseConfig({ project: { name: 'x', repo: '/x' }, agents: [{ id: 'c', name: 'C', role: 'engineer', adapter: 'codex-cli', billing: 'metered' }] })).toThrow(/metered_opt_in/);
  });
});

describe('reducer', () => {
  let seq = 0;
  const ev = (type: string, data: unknown, refs: Partial<EventEnvelope> = {}, ts = '2026-01-01T00:00:00Z'): EventEnvelope =>
    ({ seq: ++seq, id: `e${seq}`, ts, type, kind: type.startsWith('t.') ? 'transcript' : 'control', actor: { type: 'system', id: 't' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data, ...refs }) as EventEnvelope;

  it('tracks agent status, approvals, liveness and idle time', () => {
    const run = { id: 'r1', assignmentId: 'as_1', workItemId: 'wi_1', agentId: 'cursor', adapter: 'cursor-agent-cli', model: null, resolvedModel: null, effort: null, attempt: 1, retryOf: null, pid: null, sessionId: null, state: 'queued', createdAt: '', startedAt: null, endedAt: null, lastEventAt: null, lastMeaningful: null, eventCount: 0, usage: { inputTokens: 0, outputTokens: 0 }, exit: null, handoff: null, filesChanged: [], outOfScope: [], tests: null, logDir: null };
    let s = replay([
      ev('agent.registered', { config: cfg.agents[0] }, {}, '2026-01-01T00:00:00Z'),
      ev('work_item.created', { item: item() }),
      ev('run.created', { run }, { agentId: 'cursor' }, '2026-01-01T00:01:00Z'),
      ev('run.started', { pid: 42 }, { agentId: 'cursor', runId: 'r1' }, '2026-01-01T00:01:00Z'),
    ]);
    expect(s.agents.cursor.status).toBe('starting');
    expect(s.agents.cursor.idleMsTotal).toBe(60_000);
    s = applyEvent(s, ev('t.command', { command: 'npm test', status: 'started' }, { agentId: 'cursor', runId: 'r1' }, '2026-01-01T00:02:00Z'));
    expect(s.runs.r1.state).toBe('running');
    expect(s.runs.r1.lastMeaningful?.summary).toBe('$ npm test');
    expect(s.agents.cursor.status).toBe('running');
    const approval = { id: 'ap1', runId: 'r1', agentId: 'cursor', workItemId: 'wi_1', kind: 'ask_human', title: 'q', detail: '', options: [], createdAt: '', resolvedAt: null, decision: null, by: null, channel: null };
    s = applyEvent(s, ev('approval.requested', { approval }, { agentId: 'cursor', runId: 'r1' }));
    expect(s.runs.r1.state).toBe('waiting-for-approval');
    expect(s.agents.cursor.status).toBe('waiting');
    s = applyEvent(s, ev('approval.resolved', { approvalId: 'ap1', decision: 'approve', by: 'owner', channel: 'web' }, { agentId: 'cursor', runId: 'r1' }));
    expect(s.runs.r1.state).toBe('running');
    s = applyEvent(s, ev('run.ended', { exit: { kind: 'completed', message: 'ok' } }, { agentId: 'cursor', runId: 'r1' }, '2026-01-01T00:03:00Z'));
    expect(s.runs.r1.state).toBe('finished');
    expect(s.agents.cursor.status).toBe('idle');
    expect(s.agents.cursor.idleSince).toBe('2026-01-01T00:03:00Z');
  });

  it('is deterministic over replay', () => {
    const events = [ev('agent.registered', { config: cfg.agents[0] }), ev('kill_switch.set', { engaged: true })];
    expect(replay(events)).toEqual(replay(events));
    expect(replay(events).killSwitch.engaged).toBe(true);
    expect(emptyState().seq).toBe(0);
  });
});
