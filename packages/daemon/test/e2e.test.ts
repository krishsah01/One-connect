// SPDX-License-Identifier: Apache-2.0
// End-to-end flows with real detached runners and the scripted fake vendor CLIs.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalTracker } from '../src/adapters/trackers/local.ts';
import { Daemon } from '../src/daemon.ts';
import { git, makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function issueAndAssignment(hh: Harness, title: string, agentId: string, over: { description?: string; allowedPaths?: string[] } = {}) {
  const item = hh.d.createIssue({ title, description: over.description ?? '', acceptance: ['a notes file exists'] });
  await waitFor(() => hh.d.state.workItems[item.id].key, 5000, 'tracker key');
  const a = hh.d.createAssignment({ workItemId: item.id, agentId, allowedPaths: over.allowedPaths ?? ['notes/**', 'src/**'] });
  return { item: hh.d.state.workItems[item.id], a };
}

const runsOf = (hh: Harness, assignmentId: string) => Object.values(hh.d.state.runs).filter((r) => r.assignmentId === assignmentId).sort((x, y) => x.createdAt.localeCompare(y.createdAt));

describe('acceptance flows', () => {
  it('issue → tracker → dispatch → live events → handoff → tracker update → verified checks → Next auto-starts', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const tracker = d.tracker as LocalTracker;
    const one = await issueAndAssignment(h, 'Add notes', 'claude');
    expect(one.item.key).toBe('LOC-1');
    expect(await tracker.getIssue(one.item.trackerId!)).toMatchObject({ title: 'Add notes', acceptance: ['a notes file exists'] });
    const two = await issueAndAssignment(h, 'Second task', 'claude');

    const r1 = await d.dispatch(one.a.id);
    expect(r1).toMatchObject({ started: true });
    expect(r1.preflight.ok).toBe(true);
    const r2 = await d.dispatch(two.a.id);
    expect(r2).toMatchObject({ started: false, queued: true });
    expect(d.state.agents.claude.queue).toEqual({ now: one.a.id, next: [two.a.id] });

    const asg = await waitFor(() => (d.state.assignments[one.a.id].worktree ? d.state.assignments[one.a.id] : null), 10_000, 'worktree');
    expect(asg.branch).toBe('claude/LOC-1-add-notes');
    expect(git(asg.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('claude/LOC-1-add-notes');

    await waitFor(() => d.state.workItems[one.item.id].state === 'handoff_received', 20_000, 'handoff');
    const run = runsOf(h, one.a.id)[0];
    expect(run.state).toBe('finished');
    expect(run.resolvedModel).toBe('claude-opus-resolved');
    const events = d.store.list({ runId: run.id });
    expect(events.some((e) => e.type === 't.command' && e.data.command === 'node --test' && e.data.exitCode === 0)).toBe(true);
    expect(events.some((e) => e.type === 't.file_edit' && e.data.path === 'notes/LOC-1.md')).toBe(true);
    expect(events.some((e) => e.type === 't.test_result' && e.data.counts.passed === 2)).toBe(true);
    expect(run.handoff).toMatchObject({ done: 'added notes/LOC-1.md', source: 'final_message' });
    expect(run.handoff!.evidence[0]).toMatchObject({ command: 'node --test', result: '2 passed, 0 failed', verified: true });
    expect(run.handoff!.commit?.verified).toBe(true);

    // Daemon re-runs required checks and records verified evidence with the SHA.
    const testEv = await waitFor(() => d.state.workItems[one.item.id].evidence.find((e) => e.kind === 'test' && e.verified), 20_000, 'daemon checks');
    expect(testEv.counts).toMatchObject({ passed: 2, failed: 0 });
    expect(testEv.sha).toBe(git(asg.worktree!, 'rev-parse', 'HEAD'));
    expect(d.state.workItems[one.item.id].evidence.some((e) => e.kind === 'commit' && e.verified)).toBe(true);

    // Tracker got the status and the handoff comment, from the outbox.
    await waitFor(async () => (await tracker.getIssue(one.item.trackerId!))?.status.category === 'in_review', 5000).catch(() => undefined);
    await waitFor(() => tracker.comments(one.item.trackerId!).some((c) => c.includes('Verified by Agent Control Center')), 10_000, 'tracker comment');
    expect((await tracker.getIssue(one.item.trackerId!))!.status.category).toBe('in_review');
    expect(tracker.comments(one.item.trackerId!)[0]).toContain('✅ [HOST FIXTURE (unsandboxed; disposable tests/demo only)] passed: test: `node --test` → 2 passed, 0 failed');

    // Now finished → Next auto-started without anyone pushing it.
    await waitFor(() => d.state.workItems[two.item.id].state === 'handoff_received', 20_000, 'next auto-start');
    expect(runsOf(h, two.a.id)[0].createdAt >= run.endedAt!).toBe(true);
    expect(d.state.agents.claude.queue).toEqual({ now: null, next: [] });
  }, 60_000);

  it.each(['claude', 'cursor'])('%s: text streams live while it is written, then is recorded exactly once', async (agentId) => {
    h = await startDaemon(makeConfig(makeRepo()), { baseEnv: { ...process.env, FAKE_TOKEN_MS: '25' } });
    const { d } = h;
    const live: { runId: string; text: string }[] = [];
    d.bus.on('live', (m: { runId: string; role: string; text: string }) => m.role === 'assistant' && live.push(m));
    const { item, a } = await issueAndAssignment(h, 'Stream it', agentId);
    await d.dispatch(a.id);
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 20_000, 'handoff');
    const growing = live.filter((m) => m.text.includes('### Handoff'));
    expect(growing.length).toBeGreaterThan(0);
    expect(live.at(-1)?.text).toBe(''); // bubble cleared when the full message landed
    const msgs = d.store.list({ runId: runsOf(h, a.id)[0].id, types: ['t.message'] }).filter((e) => e.type === 't.message' && e.data.text.includes('### Handoff'));
    expect(msgs).toHaveLength(1);
    expect(fs.existsSync(path.join(h.dataDir, 'runs', runsOf(h, a.id)[0].id, 'live.jsonl'))).toBe(false);
    if (agentId === 'claude') {
      const stdout = fs.readFileSync(path.join(h.dataDir, 'runs', runsOf(h, a.id)[0].id, 'stdout.jsonl'), 'utf8');
      expect(stdout).not.toContain('stream_event'); // deltas stay out of the evidence log
    }
  }, 60_000);

  it('quick task: one call creates the issue, waits for the tracker, assigns and dispatches', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const r = await d.quickTask({ agentId: 'codex', title: 'Tidy the README', allowedPaths: ['notes/**'] });
    expect(r.item.key).toBe('LOC-1');
    expect(r.started).toBe(true);
    await waitFor(() => d.state.workItems[r.item.id].state === 'handoff_received', 20_000, 'quick task done');
    const second = await d.quickTask({ agentId: 'codex', title: 'Second quick one', allowedPaths: ['notes/**'] });
    expect(second.item.labels).toEqual(['quick-task']);
  }, 60_000);

  it('network failure → failed → retried once (resuming the session) → flagged with a reassignment suggestion', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const { item, a } = await issueAndAssignment(h, 'Flaky network', 'codex', { description: '[fake:network-fail]' });
    await d.dispatch(a.id);
    const alert = await waitFor(() => Object.values(d.state.alerts).find((x) => x.kind === 'retry_exhausted'), 20_000, 'retry exhausted');
    const runs = runsOf(h, a.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].exit?.kind).toBe('network');
    expect(runs[1]).toMatchObject({ attempt: 2, retryOf: runs[0].id, sessionId: runs[0].sessionId });
    expect(runs[1].exit?.kind).toBe('network');
    expect(d.state.workItems[item.id].state).toBe('failed');
    expect(d.state.agents.codex.pausedReason).toContain('network');
    expect(alert.suggestion).toMatchObject({ kind: 'reassign' });
    expect((alert.suggestion as { agentIds: string[] }).agentIds).toEqual(expect.arrayContaining(['claude', 'cursor']));
    const sys = d.store.list({ runId: runs[0].id, types: ['t.system'] }).map((e) => (e.data as { text: string }).text);
    expect(sys.some((t) => t.includes('retrying once'))).toBe(true);
  }, 60_000);

  it('network failure once → retried with the same session → succeeds', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const { item, a } = await issueAndAssignment(h, 'Blip', 'claude', { description: '[fake:network-fail-once]' });
    await d.dispatch(a.id);
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 20_000, 'handoff after retry');
    const runs = runsOf(h, a.id);
    expect(runs.map((r) => r.exit?.kind)).toEqual(['network', 'completed']);
    expect(runs[1].sessionId).toBe(runs[0].sessionId);
    expect(Object.values(d.state.alerts).some((x) => x.kind === 'retry_exhausted')).toBe(false);
  }, 60_000);

  it('pending approval (ask_human over MCP) → stall alert → human answers → run completes', async () => {
    let now = new Date();
    h = await startDaemon(makeConfig(makeRepo()), { clock: () => now });
    const { d } = h;
    const { item, a } = await issueAndAssignment(h, 'Needs a decision', 'cursor', { description: '[fake:ask-human]' });
    await d.dispatch(a.id);
    const ap = await waitFor(() => Object.values(d.state.approvals).find((x) => !x.resolvedAt), 20_000, 'approval request');
    expect(ap).toMatchObject({ kind: 'ask_human', agentId: 'cursor', options: ['yes', 'no'] });
    expect(runsOf(h, a.id)[0].state).toBe('waiting-for-approval');
    expect(d.state.agents.cursor.status).toBe('waiting');

    now = new Date(now.getTime() + 20 * 60_000);
    await d.rules.tick();
    const alert = Object.values(d.state.alerts).find((x) => x.kind === 'approval_pending' && !x.resolvedAt);
    expect(alert?.severity).toBe('critical');
    expect(alert?.message).toContain('waiting 20 min for your answer');

    d.resolveApproval(ap.id, 'yes', 'test');
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 20_000, 'handoff after answer');
    const wt = d.state.assignments[a.id].worktree!;
    expect(fs.readFileSync(path.join(wt, 'notes', `${item.key}.md`), 'utf8')).toContain('Owner said: yes');
    expect(d.state.alerts[alert!.id].resolvedAt).not.toBeNull();
  }, 60_000);

  it('daemon restart mid-run: reattaches to the live run; state and logs survive', async () => {
    const repo = makeRepo();
    const cfg = makeConfig(repo);
    h = await startDaemon(cfg, { baseEnv: { ...process.env, FAKE_SLOW_MS: '2500' } });
    const dataDir = h.dataDir;
    const { item, a } = await issueAndAssignment(h, 'Slow work', 'claude', { description: '[fake:slow]' });
    await h.d.dispatch(a.id);
    const run = await waitFor(() => runsOf(h!, a.id).find((r) => r.state === 'running'), 10_000, 'running');
    const before = h.d.store.list({ runId: run.id }).length;
    // Stop the daemon; the agent keeps running detached.
    await h.d.shutdown();
    h = null;

    const d2 = new Daemon({ config: cfg, dataDir, allowTempDataDir: true, rulesTickMs: 3_600_000, outboxTickMs: 100, supervisorPollMs: 50, probe: false, baseEnv: { ...process.env, FAKE_SLOW_MS: '2500' } });
    await d2.start();
    h = { d: d2, url: '', dataDir, close: async () => { await d2.setKillSwitch(true); await d2.shutdown(); } };
    expect(d2.state.workItems[item.id].key).toBe(item.key);
    expect(d2.store.list({ runId: run.id }).length).toBeGreaterThanOrEqual(before);
    const sys = d2.store.list({ runId: run.id, types: ['t.system'] }).map((e) => (e.data as { text: string }).text);
    expect(sys).toContain('daemon restarted: reattached to the live run');
    await waitFor(() => d2.state.workItems[item.id].state === 'handoff_received', 20_000, 'handoff after restart');
    expect(fs.existsSync(path.join(dataDir, 'runs', run.id, 'stdout.jsonl'))).toBe(true);
    expect(d2.state.runs[run.id].handoff?.done).toContain('notes/');
  }, 60_000);

  it('blocks silent paid usage: a session reporting an API key is killed and the agent paused', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { baseEnv: { ...process.env, FAKE_API_KEY_SOURCE: 'ANTHROPIC_API_KEY', FAKE_SLOW_MS: '3000' } });
    const { d } = h;
    const { item, a } = await issueAndAssignment(h, 'Paid?', 'claude', { description: '[fake:slow]' });
    await d.dispatch(a.id);
    await waitFor(() => runsOf(h!, a.id)[0]?.exit, 20_000, 'run end');
    expect(runsOf(h, a.id)[0].exit?.kind).toBe('billing_violation');
    expect(Object.values(d.state.alerts).some((x) => x.kind === 'billing' && x.severity === 'critical')).toBe(true);
    expect(d.state.agents.claude.pausedReason).toBe('billing violation');
    expect(d.state.workItems[item.id].state).toBe('failed');
  }, 60_000);

  it('paid overage in use (vendor rate_limit_event) → run stopped, agent paused, usage meter updated', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const { a } = await issueAndAssignment(h, 'Overage', 'claude', { description: '[fake:overage]' });
    await d.dispatch(a.id);
    await waitFor(() => runsOf(h!, a.id)[0]?.exit, 20_000, 'run end');
    expect(runsOf(h, a.id)[0].exit).toMatchObject({ kind: 'billing_violation', message: expect.stringContaining('paid overage') });
    expect(d.state.agents.claude.usage.windows).toEqual([expect.objectContaining({ name: '5h window', usedPercent: 100 }), expect.objectContaining({ name: '7d window', usedPercent: 40 })]);
    expect(d.state.agents.claude.pausedReason).toBe('billing violation');
  }, 60_000);

  it('usage limit: agent is marked limited with reset time; no paid fallback', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const { a } = await issueAndAssignment(h, 'Out of usage', 'codex', { description: '[fake:usage-limit]' });
    await d.dispatch(a.id);
    await waitFor(() => d.state.agents.codex.limitedUntil, 20_000, 'limited');
    const until = Date.parse(d.state.agents.codex.limitedUntil!);
    expect(until - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(d.state.agents.codex.status).toBe('limited');
    const alert = Object.values(d.state.alerts).find((x) => x.kind === 'usage_limit')!;
    expect(alert.message).toContain('No paid fallback');
  }, 60_000);

  it('handoff enforcement: no handoff → skeleton from events, item blocked, owner can accept', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const { item, a } = await issueAndAssignment(h, 'Forgetful', 'cursor', { description: '[fake:no-handoff]' });
    await d.dispatch(a.id);
    await waitFor(() => d.state.workItems[item.id].state === 'blocked', 20_000, 'blocked');
    const run = runsOf(h, a.id)[0];
    expect(run.handoff?.source).toBe('skeleton');
    expect(run.handoff?.evidence.some((e) => e.command === 'node --test' && e.verified)).toBe(true);
    expect(Object.values(d.state.alerts).some((x) => x.kind === 'handoff_missing')).toBe(true);
    expect(d.state.agents.cursor.queue.now).toBeNull();
    d.runs.acceptSkeleton(run.id);
    expect(d.state.workItems[item.id].state).toBe('handoff_received');
  }, 60_000);

  it('path scope: the pre-commit hook rejects out-of-scope commits and the dashboard warns', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const { a } = await issueAndAssignment(h, 'Scoped', 'claude', { description: '[fake:out-of-scope]', allowedPaths: ['notes/**'] });
    await d.dispatch(a.id);
    const run = await waitFor(() => runsOf(h!, a.id)[0]?.exit && runsOf(h!, a.id)[0], 20_000, 'run end');
    const commit = d.store.list({ runId: run.id, types: ['t.command'] }).find((e) => e.type === 't.command' && e.data.status !== 'started' && e.data.command.startsWith('git add'));
    expect(commit?.type === 't.command' && commit.data.exitCode).not.toBe(0);
    expect(commit?.type === 't.command' && commit.data.output).toContain('outside this assignment');
    await waitFor(() => Object.values(d.state.alerts).find((x) => x.kind === 'scope_violation'), 10_000, 'scope alert');
    expect(d.state.runs[run.id].outOfScope).toEqual([`outside-${d.state.workItems[run.workItemId].key}.txt`]);
  }, 60_000);

  it('relay agent: prompt waits for a paste; pasted handoff completes it', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const { item, a } = await issueAndAssignment(h, 'Relay me', 'ag');
    const r = await d.dispatch(a.id);
    expect(d.state.runs[r.runId!].state).toBe('waiting-for-input');
    expect(d.state.assignments[a.id].prompt).toContain('reply with exactly this block');
    await expect(d.runs.relayResult(r.runId!, 'no block')).rejects.toThrow(/no handoff block/);
    await d.runs.relayResult(r.runId!, '### Handoff\nDone: drafted the copy\nEvidence:\n- `manual review` → looks right\nBlocked: none\nNext: ship it');
    expect(d.state.workItems[item.id].state).toBe('handoff_received');
    expect(d.state.runs[r.runId!].handoff?.source).toBe('relay_paste');
  }, 60_000);

  it('kill switch stops live runs and blocks new dispatch', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const { d } = h;
    const { a } = await issueAndAssignment(h, 'Hangs', 'codex', { description: '[fake:hang]' });
    await d.dispatch(a.id);
    await waitFor(() => runsOf(h!, a.id).find((r) => r.state === 'running'), 10_000, 'running');
    const stopped = await d.setKillSwitch(true);
    expect(stopped).toBe(1);
    await waitFor(() => runsOf(h!, a.id)[0].exit, 15_000, 'killed');
    expect(runsOf(h, a.id)[0].exit?.kind).toBe('killed');
    const { a: a2 } = await issueAndAssignment(h, 'Another', 'claude');
    await expect(d.dispatch(a2.id)).rejects.toThrow(/Kill switch/);
  }, 60_000);
});
