// SPDX-License-Identifier: Apache-2.0
// Independent SHA-bound reviews, action-bound human decisions and local integration merges, with
// scripted fake agents in disposable git repos. Nothing is pushed; no vendor is contacted.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlCenterConfig } from '@acc/core';
import { agentActor, HUMAN } from '@acc/core';
import type { LocalTracker } from '../src/adapters/trackers/local.ts';
import { git, makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function authored(hh: Harness, title: string, description = '') {
  const { d } = hh;
  const item = d.createIssue({ title, description, acceptance: ['a notes file exists'] });
  await waitFor(() => d.state.workItems[item.id].key, 5000, 'tracker key');
  const a = d.createAssignment({ workItemId: item.id, agentId: 'claude', allowedPaths: ['notes/**'] });
  await d.dispatch(a.id);
  await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 20_000, 'author handoff');
  const asg = d.state.assignments[a.id];
  const head = git(asg.worktree!, 'rev-parse', 'HEAD');
  await waitFor(() => d.state.workItems[item.id].evidence.find((e) => e.kind === 'test' && e.verified && e.sha === head), 20_000, 'daemon checks');
  return { itemId: item.id, asg, head };
}

async function reviewed(hh: Harness, itemId: string, reviewer = 'codex') {
  const ra = await hh.d.reviewMerge.createReviewAssignment({ workItemId: itemId, reviewerAgentId: reviewer });
  await hh.d.dispatch(ra.id);
  const review = await waitFor(() => Object.values(hh.d.state.reviews).find((r) => r.assignmentId === ra.id), 20_000, 'review record');
  await waitFor(() => !Object.values(hh.d.state.runs).some((r) => r.assignmentId === ra.id && !r.endedAt), 20_000, 'review run end');
  return { ra, review };
}

/** Owner approves a merge decision through both confirmation steps. */
async function approveMerge(hh: Harness, decisionId: string) {
  const p = hh.d.decisions.prepare(decisionId, 'merge');
  expect(p.confirm).toBe(true);
  return hh.d.reviewMerge.answer(decisionId, 'merge', { nonce: p.nonce, channel: 'phone' });
}

const cfg = (over: Record<string, unknown> = {}): ControlCenterConfig => makeConfig(makeRepo(), over);

describe('independent SHA-bound reviews', () => {
  it('reviewer sees the exact SHA, records a typed approval, files findings as linked follow-ups', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const tracker = d.tracker as LocalTracker;
    const { itemId, asg, head } = await authored(h, 'Add notes');

    // The author can never be the reviewer.
    await expect(d.reviewMerge.createReviewAssignment({ workItemId: itemId, reviewerAgentId: 'claude' })).rejects.toMatchObject({ status: 409 });
    // A review must target the current head.
    await expect(d.reviewMerge.createReviewAssignment({ workItemId: itemId, reviewerAgentId: 'codex', targetSha: asg.baseSha! })).rejects.toThrow(/moved/);

    const { ra, review } = await reviewed(h, itemId);
    expect(d.state.assignments[ra.id].prompt).toContain(`Target SHA: ${head}`);
    expect(d.state.assignments[ra.id].prompt).toContain('PASS test');
    expect(git(d.state.assignments[ra.id].worktree!, 'rev-parse', 'HEAD')).toBe(head);
    expect(review).toMatchObject({ verdict: 'approve', targetSha: head, sourceBranch: asg.branch, authorAgentId: 'claude', reviewer: { type: 'agent', id: 'codex' }, source: 'mcp', staleAt: null });
    expect(review.evidenceIds.length).toBeGreaterThan(0);
    const item = d.state.workItems[itemId];
    expect(item.state).toBe('approved');
    // The reviewer never takes over the issue.
    expect(item.ownerAgentId).toBe('claude');

    // The minor finding became a linked issue under the reviewed one, through the tracker outbox.
    const fid = await waitFor(() => d.state.reviews[review.id].findings[0]?.followUpWorkItemId, 5000, 'follow-up link');
    const follow = await waitFor(() => (d.state.workItems[fid].key ? d.state.workItems[fid] : null), 5000, 'follow-up key');
    expect(follow).toMatchObject({ parentKey: item.key, labels: ['review-finding', 'minor'] });
    expect(follow.title).toMatch(/^Review: Mention the issue key/);
    await waitFor(() => tracker.comments(item.trackerId!).some((c) => c.includes('**Review by Codex: approved**')), 5000, 'review comment');

    // The handoff verdict does not record a second review for the same assignment.
    expect(Object.values(d.state.reviews).filter((r) => r.assignmentId === ra.id)).toHaveLength(1);
  }, 90_000);

  it('a handoff verdict is recorded when the reviewer skips submit_review; changes requested blocks merge', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const a = await authored(h, 'Handoff verdict', '[fake:review-handoff-approve]');
    const { review } = await reviewed(h, a.itemId);
    expect(review).toMatchObject({ verdict: 'approve', source: 'handoff', targetSha: a.head });
    expect(review.findings[0]).toMatchObject({ severity: 'nit', path: `notes/${d.state.workItems[a.itemId].key}.md`, line: 1, followUpWorkItemId: null });

    const b = await authored(h, 'Needs work', '[fake:review-changes]');
    const r2 = await reviewed(h, b.itemId);
    expect(r2.review.verdict).toBe('request_changes');
    expect(d.state.workItems[b.itemId].state).toBe('changes_requested');
    expect(d.state.workItems[r2.review.findings[0].followUpWorkItemId!].labels).toEqual(['review-finding', 'major']);
    await expect(d.reviewMerge.requestMerge(b.itemId)).rejects.toThrow(/changes requested/);
  }, 90_000);

  it('a new commit invalidates a stale approval and the merge is refused', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const { itemId, asg } = await authored(h, 'Will move');
    const { review } = await reviewed(h, itemId);
    expect(d.state.workItems[itemId].state).toBe('approved');

    fs.writeFileSync(path.join(asg.worktree!, 'notes', 'extra.md'), 'later change\n');
    git(asg.worktree!, 'add', '-A');
    git(asg.worktree!, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'later change');

    const g = await d.reviewMerge.gatesFor(itemId);
    expect(g.gates.find((x) => x.id === 'review')).toMatchObject({ ok: false, detail: expect.stringMatching(/stale/) });
    await waitFor(() => d.state.reviews[review.id].staleAt, 2000, 'invalidated');
    expect(d.state.workItems[itemId].state).toBe('changes_requested');
    await expect(d.reviewMerge.requestMerge(itemId)).rejects.toMatchObject({ status: 409 });
    const refused = d.store.list({ kind: 'control', types: ['merge.refused'], workItemId: itemId });
    expect(refused.length).toBe(1);
  }, 90_000);
});

describe('human decisions', () => {
  it('irreversible answers need a second confirmation; only the human owner can answer; Jev only recommends', async () => {
    let now = new Date('2026-10-06T10:00:00Z');
    h = await startDaemon(cfg(), { clock: () => now });
    const { d } = h;
    const dec = d.decisions.create({ question: 'Ship it?', options: ['merge', 'reject'], irreversible: true, kind: 'question' });
    expect(dec.confirmOptions).toEqual(['merge']);

    expect(() => d.decisions.answer(dec.id, 'merge', {}, agentActor('claude'))).toThrow(/only the human owner/);
    expect(() => d.decisions.answer(dec.id, 'merge', {}, { type: 'human', id: 'jev' })).toThrow(/only the human owner/);
    expect(() => d.decisions.prepare(dec.id, 'merge', { type: 'human', id: 'Jev' })).toThrow(/only the human owner/);
    d.decisions.recommend(dec.id, 'merge', 'checks are green', { type: 'agent', id: 'jev' });
    expect(d.state.decisions[dec.id]).toMatchObject({ recommendedBy: { type: 'agent', id: 'jev' }, recommendation: 'merge', answer: null });

    expect(() => d.decisions.answer(dec.id, 'merge')).toThrow(expect.objectContaining({ status: 428 }));
    const p = d.decisions.prepare(dec.id, 'merge');
    expect(() => d.decisions.answer(dec.id, 'merge', { nonce: 'forged' })).toThrow(expect.objectContaining({ status: 428 }));
    now = new Date(now.getTime() + 3 * 60_000);
    expect(() => d.decisions.answer(dec.id, 'merge', { nonce: p.nonce })).toThrow(expect.objectContaining({ status: 410 }));

    const p2 = d.decisions.prepare(dec.id, 'merge');
    d.decisions.answer(dec.id, 'merge', { nonce: p2.nonce, channel: 'phone' });
    expect(d.state.decisions[dec.id]).toMatchObject({ answer: 'merge', channel: 'phone', answeredBy: { type: 'human', id: 'owner' } });
    expect(d.state.decisions[dec.id].confirmedAt).toBeTruthy();
    // The nonce is single-use.
    expect(() => d.decisions.answer(dec.id, 'merge', { nonce: p2.nonce })).toThrow(/already answered/);
    // A plain question decision authorizes no action.
    expect(d.decisions.authorizes(dec.id, 'merge', 'x')).toMatchObject({ ok: false });

    const easy = d.decisions.create({ question: 'Which name?', options: ['a', 'b'] });
    expect(d.decisions.prepare(easy.id, 'a')).toMatchObject({ confirm: false });
    d.decisions.answer(easy.id, 'a');
    expect(d.decisions.history(dec.id).map((e) => e.type)).toEqual(['decision.created', 'decision.recommended', 'decision.confirmation_requested', 'decision.confirmation_requested', 'decision.answered']);
  });
});

describe('integration merge', () => {
  it('merges only the approved SHA after a confirmed human decision; post-merge checks; acceptance → Done', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const repo = d.config.project.repo;
    const tracker = d.tracker as LocalTracker;
    const { itemId, asg, head } = await authored(h, 'Merge me');
    const { review } = await reviewed(h, itemId);
    const before = git(repo, 'rev-parse', 'integration');

    const { decision, gates } = await d.reviewMerge.requestMerge(itemId);
    expect(gates.every((g) => g.ok)).toBe(true);
    expect(decision).toMatchObject({ kind: 'merge', irreversible: true, confirmOptions: ['merge'], action: { sourceSha: head, sourceBranch: asg.branch, target: 'integration', targetSha: before, reviewId: review.id } });
    expect(decision.evidence?.some((e) => e.label === 'Scope' && /nothing is pushed/.test(e.detail))).toBe(true);
    // Asking again for the same exact action reuses the open decision.
    expect((await d.reviewMerge.requestMerge(itemId)).decision.id).toBe(decision.id);

    // Without an answer nothing merges.
    expect(await d.reviewMerge.executeMerge(decision.id)).toMatchObject({ merged: false, reason: expect.stringMatching(/not approved/) });
    expect(git(repo, 'rev-parse', 'integration')).toBe(before);

    const r = await approveMerge(h, decision.id);
    expect(r.merge).toMatchObject({ merged: true });
    const mergeSha = git(repo, 'rev-parse', 'integration');
    expect(r.merge!.mergeSha).toBe(mergeSha);
    expect(git(repo, 'rev-parse', `${mergeSha}^1`)).toBe(before);
    expect(git(repo, 'rev-parse', `${mergeSha}^2`)).toBe(head);
    expect(git(repo, 'log', '-1', '--format=%B', mergeSha)).toContain(`One-Connect-Decision: ${decision.id}`);
    expect(git(repo, 'remote')).toBe('');
    expect(d.state.workItems[itemId].state).toBe('merged');
    expect(d.state.decisions[decision.id].consumedAt).toBeTruthy();
    // A consumed decision cannot be replayed.
    expect(await d.reviewMerge.executeMerge(decision.id)).toMatchObject({ merged: false, reason: expect.stringMatching(/already used/) });

    // Done needs the post-merge checks green and the owner's acceptance.
    expect(() => d.reviewMerge.recordAcceptance(itemId, { summary: 'looked at it' }, agentActor('claude'))).toThrow(/only the owner/);
    const merge = await waitFor(() => Object.values(d.state.merges).find((m) => m.postChecks.status !== 'pending'), 20_000, 'post-merge checks');
    expect(merge).toMatchObject({ mergeSha, method: 'ref', postChecks: { status: 'passed' } });
    expect(d.state.workItems[itemId].evidence.some((e) => e.kind === 'test' && e.sha === mergeSha && e.branch === 'integration' && e.verified)).toBe(true);
    expect(d.state.workItems[itemId].state).toBe('merged');
    expect(d.reviewMerge.recordAcceptance(itemId, { summary: 'opened notes and read them', env: 'local' }, HUMAN)).toEqual({ verified: true, reason: null });
    expect(d.state.workItems[itemId].state).toBe('verified');
    await waitFor(async () => (await tracker.getIssue(d.state.workItems[itemId].trackerId!))?.status.category === 'done', 5000, 'tracker done');
    expect(d.decisions.history(decision.id).map((e) => e.type)).toEqual(expect.arrayContaining(['decision.created', 'decision.confirmation_requested', 'decision.answered', 'merge.completed', 'decision.consumed', 'merge.post_checks']));
  }, 120_000);

  it('refuses dirty or colliding target worktrees without touching them, preserves but never executes user hooks, then merges in place', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const repo = d.config.project.repo;
    const { itemId } = await authored(h, 'Dirty target');
    await reviewed(h, itemId);
    const key = d.state.workItems[itemId].key!;

    // The owner has integration checked out, with an uncommitted edit and a user hook.
    git(repo, 'checkout', '-q', 'integration');
    const before = git(repo, 'rev-parse', 'HEAD');
    const readme = fs.readdirSync(repo).find((f) => fs.statSync(path.join(repo, f)).isFile() && !f.startsWith('.'))!;
    const original = fs.readFileSync(path.join(repo, readme), 'utf8');
    fs.writeFileSync(path.join(repo, readme), original + '\nuncommitted owner edit\n');
    const hook = path.join(repo, '.git', 'hooks', 'pre-merge-commit');
    const hookBody = '#!/bin/sh\necho ran >> "$(git rev-parse --git-common-dir)/user-hook-ran"\n';
    fs.writeFileSync(hook, hookBody, { mode: 0o755 });

    const { decision } = await d.reviewMerge.requestMerge(itemId);
    const r1 = await approveMerge(h, decision.id);
    expect(r1.merge).toMatchObject({ merged: false, reason: expect.stringMatching(/uncommitted change/) });
    expect(fs.readFileSync(path.join(repo, readme), 'utf8')).toBe(original + '\nuncommitted owner edit\n');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    // A dirty worktree is the owner's to fix; the decision stays usable.
    expect(d.state.decisions[decision.id].consumedAt).toBeNull();

    // Untracked file in the way of an incoming file: refuse, keep it.
    fs.writeFileSync(path.join(repo, readme), original);
    fs.mkdirSync(path.join(repo, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'notes', `${key}.md`), 'owner scratch\n');
    const r2 = await d.reviewMerge.executeMerge(decision.id);
    expect(r2).toMatchObject({ merged: false, reason: expect.stringMatching(/untracked files .* would be overwritten/) });
    expect(fs.readFileSync(path.join(repo, 'notes', `${key}.md`), 'utf8')).toBe('owner scratch\n');

    // Unrelated untracked files survive; approval never authorizes repository hook code.
    fs.rmSync(path.join(repo, 'notes', `${key}.md`));
    fs.writeFileSync(path.join(repo, 'owner-scratch.txt'), 'keep me\n');
    const r3 = await d.reviewMerge.executeMerge(decision.id);
    expect(r3).toMatchObject({ merged: true });
    expect(d.state.merges[r3.mergeId!].method).toBe('worktree');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(r3.mergeSha);
    expect(fs.readFileSync(path.join(repo, 'owner-scratch.txt'), 'utf8')).toBe('keep me\n');
    expect(fs.existsSync(path.join(repo, 'notes', `${key}.md`))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.git', 'user-hook-ran'))).toBe(false);
    expect(fs.readFileSync(hook, 'utf8')).toBe(hookBody);
  }, 120_000);

  it('scratch merges and post-checks never execute repository marker hooks, even after approval', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const repo = d.config.project.repo;
    const { itemId } = await authored(h, 'Repository hooks are data');
    await reviewed(h, itemId);
    const marker = path.join(repo, '.git', 'hook-executed');
    for (const name of ['pre-merge-commit', 'post-merge', 'post-checkout', 'reference-transaction', 'prepare-commit-msg', 'commit-msg']) {
      fs.writeFileSync(path.join(repo, '.git', 'hooks', name), `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
    }
    const { decision } = await d.reviewMerge.requestMerge(itemId);
    const r = await approveMerge(h, decision.id);
    expect(r.merge).toMatchObject({ merged: true });
    await waitFor(() => Object.values(d.state.merges).find(m => m.postChecks.status === 'passed'), 20_000);
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain('merge-scratch');
  }, 120_000);

  it('refuses configured custom merge drivers without executing their harmless marker command', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const repo = d.config.project.repo;
    const { itemId } = await authored(h, 'Driver needs separate authorization');
    await reviewed(h, itemId);
    const marker = path.join(repo, '.git', 'merge-driver-executed');
    git(repo, 'config', 'merge.marker.driver', `printf ran >> '${marker}'`);
    const before = git(repo, 'rev-parse', 'integration');
    const gates = await d.reviewMerge.gatesFor(itemId);
    expect(gates.gates.find(g => g.id === 'conflicts')).toMatchObject({ ok: false });
    await expect(d.reviewMerge.requestMerge(itemId)).rejects.toThrow(/Conflicts/);
    expect(git(repo, 'rev-parse', 'integration')).toBe(before);
    expect(fs.existsSync(marker)).toBe(false);
  }, 120_000);

  it('rejects stale runtime proof and records unavailable post-merge checks as failed acceptance gates', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const { itemId } = await authored(h, 'Runtime proof stays explicit');
    await reviewed(h, itemId);
    const fixtureRuntime = d.config.project.check_runtime;
    delete d.config.project.check_runtime;
    expect((await d.reviewMerge.gatesFor(itemId)).gates.find(g => g.label === 'Check runtime')).toMatchObject({ ok: false });
    await expect(d.reviewMerge.requestMerge(itemId)).rejects.toThrow(/current configured Docker proof/);
    d.config.project.check_runtime = fixtureRuntime;
    const { decision } = await d.reviewMerge.requestMerge(itemId);
    // Simulate runtime removal between the merge and its asynchronous post-checks.
    const removeRuntime = (events: { type: string }[]) => { if (events.some(e => e.type === 'merge.completed')) delete d.config.project.check_runtime; };
    d.bus.on('events', removeRuntime);
    try {
      const r = await approveMerge(h, decision.id);
      expect(r.merge).toMatchObject({ merged: true });
      const merge = await waitFor(() => Object.values(d.state.merges).find(m => m.postChecks.status === 'failed'), 20_000);
      expect(d.state.workItems[itemId].evidence.filter(e => merge.postChecks.evidenceIds.includes(e.id))).toEqual(expect.arrayContaining([expect.objectContaining({ verified: true, exitCode: null, sha: merge.mergeSha, summary: expect.stringContaining('unavailable') })]));
      expect(() => d.reviewMerge.recordAcceptance(itemId, { summary: 'checked manually' })).toThrow(/post-merge checks are failed/);
    } finally { d.bus.off('events', removeRuntime); }
  }, 120_000);

  it('checks committed assignment path scope explicitly when app-owned merges suppress hooks', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const { itemId, asg } = await authored(h, 'Explicit path scope gate');
    fs.writeFileSync(path.join(asg.worktree!, 'outside.txt'), 'not in notes scope\n');
    git(asg.worktree!, 'add', 'outside.txt');
    git(asg.worktree!, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'bypassed native hook');
    const run = Object.values(d.state.runs).find(r => r.assignmentId === asg.id)!;
    await d.runs.postRunChecks(run.id);
    await d.reviewMerge.recordHumanReview(itemId, { verdict: 'approve' });
    expect((await d.reviewMerge.gatesFor(itemId)).gates.find(g => g.label === 'Path scope')).toMatchObject({ ok: false, detail: expect.stringContaining('outside.txt') });
    await expect(d.reviewMerge.requestMerge(itemId)).rejects.toThrow(/Path scope/);
  }, 120_000);

  it('refuses stale target SHAs, conflicts and non-green checks', async () => {
    h = await startDaemon(cfg());
    const { d } = h;
    const repo = d.config.project.repo;

    // Target moved after the decision: refused and the decision is consumed.
    const a = await authored(h, 'Target moves');
    await reviewed(h, a.itemId);
    const { decision } = await d.reviewMerge.requestMerge(a.itemId);
    const side = path.join(path.dirname(repo), `${path.basename(repo)}-side`);
    git(repo, 'worktree', 'add', '-q', side, 'integration');
    fs.writeFileSync(path.join(side, 'side.txt'), 'side\n');
    git(side, 'add', '-A');
    git(side, 'commit', '-q', '-m', 'someone else landed first');
    const moved = git(repo, 'rev-parse', 'integration');
    const r = await approveMerge(h, decision.id);
    expect(r.merge).toMatchObject({ merged: false, reason: expect.stringMatching(/integration moved/) });
    expect(git(repo, 'rev-parse', 'integration')).toBe(moved);
    expect(d.state.decisions[decision.id].consumedAt).toBeTruthy();

    // Conflicting change on integration.
    const key = d.state.workItems[a.itemId].key!;
    fs.mkdirSync(path.join(side, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(side, 'notes', `${key}.md`), 'conflicting content\n');
    git(side, 'add', '-A');
    git(side, 'commit', '-q', '-m', 'conflict');
    git(repo, 'worktree', 'remove', '--force', side);
    const g = await d.reviewMerge.gatesFor(a.itemId);
    expect(g.gates.find((x) => x.id === 'conflicts')).toMatchObject({ ok: false, detail: expect.stringContaining(`notes/${key}.md`) });
    await expect(d.reviewMerge.requestMerge(a.itemId)).rejects.toThrow(/Conflicts/);

    // Checks failed at the source SHA, even with an approval.
    const b = await authored(h, 'Broken tests', '[fake:break-tests]');
    await reviewed(h, b.itemId);
    const gb = await d.reviewMerge.gatesFor(b.itemId);
    expect(gb.gates.find((x) => x.id === 'checks')).toMatchObject({ ok: false, detail: expect.stringMatching(/test failed/) });
    await expect(d.reviewMerge.requestMerge(b.itemId)).rejects.toThrow(/Required checks/);
  }, 150_000);
});
