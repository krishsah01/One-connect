// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// One contract every tracker adapter must pass. A new tracker = implement TrackerAdapter and add
// a factory here.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitHubTracker } from '../src/adapters/trackers/github.ts';
import { LinearTracker } from '../src/adapters/trackers/linear.ts';
import { LocalTracker } from '../src/adapters/trackers/local.ts';
import { composeBody, splitBody, TrackerNotLiveError, type TrackerAdapter } from '../src/adapters/trackers/types.ts';
import { tmpDir } from './helpers.ts';

const FIX = path.join(import.meta.dirname, 'fixtures');

/** In-memory Linear GraphQL fake: just enough of the schema the adapter uses. */
function fakeLinear() {
  const states = [
    { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
    { id: 's-prog', name: 'In Progress', type: 'started', position: 2 },
    { id: 's-rev', name: 'In Review', type: 'started', position: 3 },
    { id: 's-done', name: 'Done', type: 'completed', position: 4 },
    { id: 's-canc', name: 'Canceled', type: 'canceled', position: 5 },
  ];
  const issues = new Map<string, Record<string, unknown>>();
  const comments: { issueId: string; body: string }[] = [];
  let n = 0;
  const auths: string[] = [];
  const out = (i: Record<string, unknown>) => ({ ...i, state: states.find((s) => s.id === i.stateId), labels: { nodes: [] }, parent: null });
  const fetch = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    auths.push(init.headers.Authorization);
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, any> };
    let data: unknown;
    if (query.includes('teams(')) data = { teams: { nodes: variables.key === 'ENG' ? [{ id: 'team-1', key: 'ENG', states: { nodes: states } }] : [] } };
    else if (query.includes('issueCreate')) {
      const id = `uuid-${++n}`;
      issues.set(id, { id, identifier: `ENG-${n}`, url: `https://linear.app/x/issue/ENG-${n}`, title: variables.input.title, description: variables.input.description, priority: variables.input.priority ?? 0, updatedAt: new Date().toISOString(), stateId: 's-backlog' });
      data = { issueCreate: { success: true, issue: out(issues.get(id)!) } };
    } else if (query.includes('issue(id')) data = { issue: issues.has(variables.id) ? out(issues.get(variables.id)!) : null };
    else if (query.includes('issues(')) data = { issues: { nodes: [...issues.values()].map(out) } };
    else if (query.includes('issueUpdate')) {
      issues.get(variables.id)!.stateId = variables.stateId;
      data = { issueUpdate: { success: true } };
    } else if (query.includes('commentCreate')) {
      comments.push(variables.input);
      data = { commentCreate: { success: true } };
    } else throw new Error(`unexpected query ${query}`);
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetch, issues, comments, auths, states };
}

interface Case {
  name: string;
  make(): { t: TrackerAdapter; comments(id: string): string[]; nativeStatus(id: string): string };
}

const cases: Case[] = [
  {
    name: 'local',
    make() {
      const t = new LocalTracker(path.join(tmpDir('lt'), 't.sqlite'), 'LOC');
      return { t, comments: (id) => t.comments(id), nativeStatus: () => '' };
    },
  },
  {
    name: 'github (via gh)',
    make() {
      const state = path.join(tmpDir('gh'), 'state.json');
      const t = new GitHubTracker({ repo: 'o/r', live: true, labelPrefix: 'acc:', gh: path.join(FIX, 'fake-gh.mjs'), env: { ...process.env, FAKE_GH_STATE: state } });
      const read = () => JSON.parse(fs.readFileSync(state, 'utf8'));
      return { t, comments: (id) => read().comments[id] ?? [], nativeStatus: (id) => `${read().issues[id].state} ${read().issues[id].labels.join(',')}` };
    },
  },
  {
    name: 'linear',
    make() {
      const f = fakeLinear();
      const secrets: string[] = [];
      const t = new LinearTracker({ team: 'ENG', live: true, apiUrl: 'https://linear.test/graphql', stateNames: {}, fetch: f.fetch, readKey: async () => 'lin_api_testkey000000000000000000', onSecret: (v) => secrets.push(v) });
      return {
        t,
        comments: (id) => f.comments.filter((c) => c.issueId === id).map((c) => c.body),
        nativeStatus: (id) => {
          expect(secrets).toEqual(['lin_api_testkey000000000000000000']);
          return f.states.find((s) => s.id === f.issues.get(id)!.stateId)!.name;
        },
      };
    },
  },
];

describe.each(cases)('tracker contract: $name', ({ make }) => {
  it('creates, reads, lists, moves status and comments', async () => {
    const { t, comments } = make();
    await t.init();
    const created = await t.createIssue({ title: 'Fix login', description: 'It double-submits.', acceptance: ['one request per click'], labels: [], priority: 2 });
    expect(created.key).toMatch(/^[A-Z]+-\d+$/);
    expect(created.title).toBe('Fix login');
    expect(created.acceptance).toEqual(['one request per click']);
    const got = await t.getIssue(created.id);
    expect(got).toMatchObject({ id: created.id, key: created.key, description: 'It double-submits.' });
    expect((await t.listIssues()).map((i) => i.id)).toContain(created.id);

    for (const cat of ['in_progress', 'in_review', 'done'] as const) {
      await t.setStatus(created.id, cat, 'running');
      expect((await t.getIssue(created.id))!.status.category).toBe(cat);
    }
    await t.setStatus(created.id, 'todo', 'assigned_now');
    expect((await t.getIssue(created.id))!.status.category).toBe('todo');

    await t.comment(created.id, '### Handoff\nDone: x');
    expect(comments(created.id)).toEqual(['### Handoff\nDone: x']);
  });
});

describe('tracker specifics', () => {
  it('github maps statuses to acc: labels plus open/closed', async () => {
    const c = cases[1].make();
    const i = await c.t.createIssue({ title: 'x', description: '', acceptance: [], labels: [] });
    await c.t.setStatus(i.id, 'in_review', 'in_review');
    expect(c.nativeStatus(i.id)).toBe('OPEN acc:in-review');
    await c.t.setStatus(i.id, 'canceled', 'canceled');
    expect(c.nativeStatus(i.id)).toBe('CLOSED acc:canceled');
    expect((await c.t.getIssue(i.id))!.status.category).toBe('canceled');
  });

  it('linear maps categories to workflow states, preferring an "In Review" state', async () => {
    const c = cases[2].make();
    const i = await c.t.createIssue({ title: 'x', description: '', acceptance: [], labels: [] });
    await c.t.setStatus(i.id, 'in_review', 'in_review');
    expect(c.nativeStatus(i.id)).toBe('In Review');
    await c.t.setStatus(i.id, 'in_progress', 'running');
    expect(c.nativeStatus(i.id)).toBe('In Progress');
  });

  it('outbound trackers do nothing until live: true', async () => {
    const gh = new GitHubTracker({ repo: 'o/r', live: false, labelPrefix: 'acc:', gh: '/nonexistent' });
    await gh.init();
    await expect(gh.createIssue({ title: 'x', description: '', acceptance: [], labels: [] })).rejects.toBeInstanceOf(TrackerNotLiveError);
    const calls: unknown[] = [];
    const lin = new LinearTracker({ team: 'ENG', live: false, apiUrl: 'x', stateNames: {}, fetch: async () => (calls.push(1), { ok: true, status: 200, json: async () => ({}) }) });
    await expect(lin.comment('1', 'x')).rejects.toBeInstanceOf(TrackerNotLiveError);
    expect(calls).toEqual([]);
  });

  it('acceptance criteria round-trip through the issue body', () => {
    const body = composeBody('Do the thing.', ['a', 'b']);
    expect(splitBody(body)).toEqual({ description: 'Do the thing.', acceptance: ['a', 'b'] });
    expect(splitBody('no criteria')).toEqual({ description: 'no criteria', acceptance: [] });
  });
});
