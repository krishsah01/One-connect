// SPDX-License-Identifier: Apache-2.0
// Connected dashboard API journey using repository-owned zero-cost CLI fixtures. The
// commands/worktrees/WebSocket/logs are real; this is not vendor, tracker-cloud or phone proof.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assignment, Decision, EventEnvelope, WorkItem } from '@acc/core';
import type { LocalTracker } from '../src/adapters/trackers/local.ts';
import { createServer } from '../src/server/http.ts';
import { git, makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | null = null;
let server: Awaited<ReturnType<typeof createServer>> | null = null;
let socket: WebSocket | null = null;
afterEach(async () => {
  socket?.close(); socket = null;
  await server?.app.close(); server = null;
  await h?.close(); h = null;
});

async function request<T>(route: string, body?: unknown, expectedStatus = 200): Promise<T> {
  const token = fs.readFileSync(path.join(h!.d.paths.secrets, 'install-token'), 'utf8').trim();
  const response = await fetch(server!.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, route).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

async function assigned(title: string, agentId: string, description = '') {
  const { item } = await request<{ item: WorkItem }>('/api/issues', { title, description, acceptance: ['The scoped notes file is present and readable.'] });
  await waitFor(() => h!.d.state.workItems[item.id].trackerId, 5000, 'tracker issue');
  const { assignment } = await request<{ assignment: Assignment }>('/api/assignments', { workItemId: item.id, agentId, allowedPaths: ['notes/**'] });
  return { item: h!.d.state.workItems[item.id], assignment };
}

describe('connected development acceptance', () => {
  it('dashboard issue → question → Next → exact-SHA review → confirmed merge → evidence → retry/relay → live restart', async () => {
    const repo = makeRepo();
    const config = makeConfig(repo);
    config.agents = config.agents.filter(a => ['claude', 'codex', 'ag'].includes(a.id));
    let clockOffset = 0;
    const options = { server: false, clock: () => new Date(Date.now() + clockOffset), baseEnv: { ...process.env, FAKE_TOKEN_MS: '25', FAKE_SLOW_MS: '2500' } };
    h = await startDaemon(config, options);
    server = await createServer(h.d, { port: 0 });
    const tracker = h.d.tracker as LocalTracker;
    const mainBefore = git(repo, 'rev-parse', 'main');
    const { ticket } = await request<{ ticket: string }>('/api/auth/ws-ticket', {});
    socket = new WebSocket(server.url.replace(/^http/, 'ws') + `/ws?ticket=${encodeURIComponent(ticket)}`);
    const received: Array<{ type: string; runId?: string; text?: string; events?: EventEnvelope[] }> = [];
    socket.addEventListener('message', e => received.push(JSON.parse(String(e.data))));
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true });
      socket!.addEventListener('error', () => reject(new Error('fixture WebSocket failed')), { once: true });
    });
    socket.send(JSON.stringify({ type: 'hello', since: 0 }));
    await waitFor(() => received.some(m => m.type === 'snapshot'), 5000, 'dashboard snapshot');

    const now = await assigned('Connected author task', 'claude', '[fake:ask-human]');
    const next = await assigned('Automatic next task', 'claude');
    expect(await tracker.getIssue(now.item.trackerId!)).toMatchObject({ title: now.item.title });
    const authorStart = await request<{ started: boolean; runId: string }>(`/api/assignments/${now.assignment.id}/dispatch`, {});
    expect(authorStart.started).toBe(true);
    socket.send(JSON.stringify({ type: 'subscribe_run', runId: authorStart.runId }));
    expect(await request(`/api/assignments/${next.assignment.id}/dispatch`, {})).toMatchObject({ started: false, queued: true });
    const approval = await waitFor(() => Object.values(h!.d.state.approvals).find(a => a.runId === authorStart.runId && !a.resolvedAt), 20_000, 'in-app question');
    expect(h.d.state.runs[authorStart.runId].state).toBe('waiting-for-approval');
    clockOffset += 20 * 60_000;
    await h.d.rules.tick();
    const stalled = Object.values(h.d.state.alerts).find(a => a.kind === 'approval_pending' && a.runId === authorStart.runId && !a.resolvedAt);
    expect(stalled?.severity).toBe('critical');
    await request(`/api/approvals/${approval.id}/resolve`, { decision: 'yes', channel: 'web' });
    await waitFor(() => h!.d.state.workItems[now.item.id].state === 'handoff_received', 20_000, 'author handoff');
    const worktree = h.d.state.assignments[now.assignment.id].worktree!;
    const authorSha = git(worktree, 'rev-parse', 'HEAD');
    expect(fs.readFileSync(path.join(worktree, 'notes', `${now.item.key}.md`), 'utf8')).toContain('Owner said: yes');
    await waitFor(() => h!.d.state.workItems[now.item.id].evidence.some(e => e.kind === 'test' && e.verified && e.sha === authorSha), 20_000, 'SHA-bound check evidence');
    await waitFor(() => h!.d.state.workItems[next.item.id].state === 'handoff_received', 20_000, 'Next automatic handoff');
    const nextRuns = Object.values(h.d.state.runs).filter(r => r.assignmentId === next.assignment.id);
    expect(nextRuns).toHaveLength(1);
    expect(nextRuns[0].createdAt >= h.d.state.runs[authorStart.runId].endedAt!).toBe(true);
    await waitFor(() => tracker.comments(now.item.trackerId!).some(c => c.includes(authorSha.slice(0, 10)) && c.includes(h!.d.state.assignments[now.assignment.id].branch!)), 5000, 'SHA-linked tracker handoff comment');
    await waitFor(async () => (await tracker.getIssue(now.item.trackerId!))?.status.category === 'in_review', 5000, 'tracker handoff');
    await waitFor(() => received.some(m => m.type === 'live' && m.runId === authorStart.runId && m.text?.includes('Handoff')), 5000, 'actual dashboard live handoff text');
    expect(received.flatMap(m => m.events ?? []).some(e => e.runId === authorStart.runId && e.type === 't.message')).toBe(true);

    await request(`/api/work-items/${now.item.id}/review-request`, { reviewerAgentId: 'claude' }, 409);
    const reviewed = await request<{ assignment: Assignment; started: boolean }>(`/api/work-items/${now.item.id}/review-request`, { reviewerAgentId: 'codex', targetSha: authorSha });
    expect(reviewed.started).toBe(true);
    const review = await waitFor(() => Object.values(h!.d.state.reviews).find(r => r.assignmentId === reviewed.assignment.id), 20_000, 'independent review');
    expect(review).toMatchObject({ targetSha: authorSha, verdict: 'approve', reviewer: { type: 'agent', id: 'codex' } });
    await waitFor(() => !Object.values(h!.d.state.runs).some(r => r.assignmentId === reviewed.assignment.id && !r.endedAt), 20_000, 'review exit');
    const { decision } = await request<{ decision: Decision }>(`/api/work-items/${now.item.id}/merge-request`, {});
    await request(`/api/decisions/${decision.id}/answer`, { answer: 'merge' }, 428);
    const confirmation = await request<{ confirm: boolean; nonce: string }>(`/api/decisions/${decision.id}/prepare`, { answer: 'merge' });
    expect(confirmation.confirm).toBe(true);
    // channel is audit metadata here; this API fixture is not a real paired-phone proof.
    expect(await request(`/api/decisions/${decision.id}/answer`, { answer: 'merge', nonce: confirmation.nonce, channel: 'phone' })).toMatchObject({ merge: { merged: true } });
    const mergeSha = git(repo, 'rev-parse', 'integration');
    const merge = await waitFor(() => Object.values(h!.d.state.merges).find(m => m.workItemId === now.item.id && m.postChecks.status !== 'pending'), 20_000, 'post-merge checks');
    expect(merge.postChecks.status).toBe('passed');
    expect(merge.sourceSha).toBe(authorSha);
    expect(h.d.state.workItems[now.item.id].state).toBe('merged');
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(repo, 'remote')).toBe('');
    expect(await request(`/api/work-items/${now.item.id}/acceptance`, { summary: 'Fixture owner read the scoped notes file.', env: 'local' })).toMatchObject({ verified: true });
    await waitFor(async () => (await tracker.getIssue(now.item.trackerId!))?.status.category === 'done', 5000, 'tracker acceptance');

    const relay = await assigned('Relay result remains a claim', 'ag');
    const relayStart = await request<{ runId: string }>(`/api/assignments/${relay.assignment.id}/dispatch`, {});
    expect(h.d.state.runs[relayStart.runId].state).toBe('waiting-for-input');
    await request(`/api/runs/${relayStart.runId}/relay`, { text: '### Handoff\nDone: reviewed the wording\nEvidence:\n- `manual review` → looks right\nBlocked: none\nNext: independent review' });
    expect(h.d.state.workItems[relay.item.id].state).toBe('handoff_received');
    expect(h.d.state.workItems[relay.item.id].evidence.some(e => e.verified && e.kind === 'commit')).toBe(false);

    const failure = await assigned('Connection failure', 'codex', '[fake:network-fail]');
    await request(`/api/assignments/${failure.assignment.id}/dispatch`, {});
    const exhausted = await waitFor(() => Object.values(h!.d.state.alerts).find(a => a.kind === 'retry_exhausted' && a.workItemId === failure.item.id), 20_000, 'one retry exhausted');
    const failedRuns = Object.values(h.d.state.runs).filter(r => r.assignmentId === failure.assignment.id);
    expect(failedRuns).toHaveLength(2);
    expect(failedRuns.every(r => r.exit?.kind === 'network')).toBe(true);
    expect(exhausted.suggestion?.kind).toBe('reassign');
    // Failed work retains ownership until the owner explicitly cancels/reassigns it.
    await request(`/api/assignments/${failure.assignment.id}/cancel`, {});

    const slow = await assigned('Restart with live author', 'claude', '[fake:slow]');
    const slowStart = await request<{ runId: string }>(`/api/assignments/${slow.assignment.id}/dispatch`, {});
    await waitFor(() => h!.d.state.runs[slowStart.runId].state === 'running', 10_000, 'live restart target');
    const dataDir = h.dataDir;
    const beforeSeq = h.d.state.seq;
    const authorLog = fs.readFileSync(path.join(dataDir, 'runs', authorStart.runId, 'stdout.jsonl'), 'utf8');
    socket.close(); socket = null;
    await server.app.close(); server = null;
    await h.d.shutdown(); h = null;
    h = await startDaemon(config, { ...options, dataDir });
    server = await createServer(h.d, { port: 0 });
    await waitFor(() => h!.d.state.workItems[slow.item.id].state === 'handoff_received', 20_000, 'reattached author handoff');
    expect(Object.values(h.d.state.runs).filter(r => r.assignmentId === slow.assignment.id).map(r => r.id)).toEqual([slowStart.runId]);
    expect(h.d.state.seq).toBeGreaterThan(beforeSeq);
    expect(fs.readFileSync(path.join(dataDir, 'runs', authorStart.runId, 'stdout.jsonl'), 'utf8')).toBe(authorLog);
    expect(h.d.state.workItems[now.item.id].state).toBe('verified');
    const { events } = await request<{ events: EventEnvelope[] }>(`/api/runs/${slowStart.runId}/events`);
    expect(events.some(e => e.type === 't.system' && e.data.text.includes('reattached to the live run'))).toBe(true);
    const report = h.d.reports.morning({});
    const claims = report.sections.flatMap(s => s.claims);
    const indexedSequences = new Set(report.evidenceIndex.map(e => e.seq));
    for (const claim of claims) for (const evidence of claim.evidence) expect(indexedSequences.has(evidence.seq)).toBe(true);
    expect(claims.some(c => c.evidence.some(e => e.sha === mergeSha))).toBe(true);
    expect(h.d.reports.standup({}).markdown).toContain('## Evidence index');

    if (process.env.ONE_CONNECT_JOURNEY_EVIDENCE) {
      fs.writeFileSync(process.env.ONE_CONNECT_JOURNEY_EVIDENCE, JSON.stringify({
        scope: 'Authenticated local dashboard API and real child-process protocol fixtures; host checks only in disposable marked sample repo. No live vendor/cloud tracker/paired phone/deployment claim.',
        recordedAt: new Date().toISOString(), repo, dataDir, authorRunId: authorStart.runId,
        authorAssignmentId: now.assignment.id, authorIssueId: now.item.id, authorSha,
        reviewId: review.id, reviewer: review.reviewer, decisionId: decision.id,
        mergeId: merge.id, mergeSha, nextRunId: nextRuns[0].id,
        relayRunId: relayStart.runId, failureRunIds: failedRuns.map(r => r.id),
        stallAlertId: stalled!.id, exhaustedAlertId: exhausted.id, reattachedRunId: slowStart.runId,
        eventSequences: report.evidenceIndex.map(e => e.seq), restoredSeq: h.d.state.seq,
      }, null, 2) + '\n');
    }
  }, 120_000);
});
