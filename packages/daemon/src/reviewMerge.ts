// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Independent SHA-bound reviews and local integration merges. Reviews are typed durable records;
// a merge needs a human decision bound to the exact source/target SHAs, an independent approval,
// green required checks at the source SHA and finished workflow gates. Never pushes or deploys.
import fs from 'node:fs';
import path from 'node:path';
import type { Actor, Assignment, Evidence, EventEnvelope, IntegrationMerge, LifecycleState, MergeAction, MergeGate, NewEvent, ReviewFinding, ReviewRecord, ReviewVerdict } from '@acc/core';
import {
  agentActor,
  authorAssignment,
  canTransition,
  checksAt,
  checkRuntimeKey,
  currentApproval,
  DEFAULT_TRACKER_CATEGORY,
  evaluateMergeGates,
  generateReviewText,
  HUMAN,
  mergeActionHash,
  newId,
  normalizeSeverity,
  outOfScope,
  parseFindingText,
  REVIEW_NOTES_PATH,
  requiredCheckNames,
  reviewsForItem,
  SYSTEM,
  ellipsize,
} from '@acc/core';
import { git, mergeConflicts, removeWorktree, revParse } from './adapters/vcs/git.ts';
import { runChecks } from './checks.ts';
import { CommandError, type Daemon } from './daemon.ts';
import type { OutboxOp } from './store/eventStore.ts';

export interface FindingInput {
  severity?: string;
  title?: string;
  body?: string;
  path?: string | null;
  line?: number | null;
}

export interface MergeOutcome {
  merged: boolean;
  mergeId?: string;
  mergeSha?: string;
  reason?: string;
  gates: MergeGate[];
}

const MERGE_OPTION = 'merge';
const REJECT_OPTION = 'reject';
const short = (s: string | null | undefined) => (s ? s.slice(0, 10) : 'unknown');

export class ReviewMerge {
  readonly d: Daemon;
  /** Merges and recordings run one at a time so two answers can never race the same refs. */
  private chain: Promise<unknown> = Promise.resolve();
  private listening = false;
  private readonly onEvents = (events: EventEnvelope[]) => this.react(events);

  constructor(d: Daemon) {
    this.d = d;
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.d.bus.on('events', this.onEvents);
  }

  stop(): void {
    this.listening = false;
    this.d.bus.off('events', this.onEvents);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private get repo(): string {
    return this.d.config.project.repo;
  }

  // ---- review assignments ------------------------------------------------------------------

  reviewText(a: Assignment, relay: boolean): string {
    const d = this.d;
    const item = d.state.workItems[a.workItemId];
    const agent = d.state.agents[a.agentId];
    const r = a.review!;
    const authorAsg = r.authorAssignmentId ? d.state.assignments[r.authorAssignmentId] : null;
    const authorRun = authorAsg ? Object.values(d.state.runs).filter((x) => x.assignmentId === authorAsg.id && x.handoff).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).at(-1) : null;
    return generateReviewText({
      project: d.config.project,
      agent: agent.config,
      item,
      assignmentId: a.id,
      scope: a.scope,
      review: r,
      authorName: (r.authorAgentId && d.state.agents[r.authorAgentId]?.config.name) || r.authorAgentId || 'the author',
      worktree: a.worktree,
      branch: a.branch,
      checks: checksAt(item, d.config.project, requiredCheckNames(d.config.project, authorAsg), r.targetSha),
      authorHandoff: authorRun?.handoff && authorRun.handoff.source !== 'skeleton' ? authorRun.handoff.raw : null,
      relay,
    });
  }

  /** A read-only review of the author's branch at its current (or the given) exact SHA. */
  async createReviewAssignment(input: { workItemId: string; reviewerAgentId: string; targetSha?: string | null; authorAssignmentId?: string | null; workflowId?: string | null; taskId?: string | null; scope?: string }, actor: Actor = HUMAN): Promise<Assignment> {
    const d = this.d;
    const item = d.state.workItems[input.workItemId];
    if (!item) throw new CommandError(`unknown work item ${input.workItemId}`, 404);
    const reviewer = d.state.agents[input.reviewerAgentId];
    if (!reviewer) throw new CommandError(`unknown agent ${input.reviewerAgentId}`, 404);
    const author = input.authorAssignmentId ? d.state.assignments[input.authorAssignmentId] : authorAssignment(d.state, item.id);
    if (!author?.branch) throw new CommandError(`${item.key ?? item.title} has no agent branch to review yet`, 409);
    if (author.agentId === reviewer.id) throw new CommandError(`${reviewer.config.name} wrote this change and cannot be its only reviewer; choose a different reviewer`, 409);
    if (reviewer.config.mode === 'coordinator-only') throw new CommandError(`${reviewer.config.name} is coordinator-only; choose a reviewer agent`, 409);
    const head = await revParse(this.repo, `refs/heads/${author.branch}`);
    if (!head) throw new CommandError(`branch ${author.branch} no longer exists`, 409);
    if (input.targetSha && input.targetSha !== head) throw new CommandError(`${author.branch} moved from ${short(input.targetSha)} to ${short(head)} after the work completed; the review must target the current commit`, 409);
    return d.createAssignment(
      {
        workItemId: item.id,
        agentId: reviewer.id,
        allowedPaths: [REVIEW_NOTES_PATH],
        requiredChecks: [],
        scope: input.scope ?? `Independent review of ${author.branch} at ${head}`,
        baseRef: head,
        kind: 'review',
        review: { targetSha: head, sourceBranch: author.branch, baseSha: author.baseSha, authorAgentId: author.agentId, authorAssignmentId: author.id },
        workflowId: input.workflowId ?? null,
        taskId: input.taskId ?? null,
      },
      actor,
    );
  }

  // ---- recording ---------------------------------------------------------------------------

  /** MCP `submit_review` from the reviewer's own run. */
  async submitFromRun(runId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const d = this.d;
    const run = d.state.runs[runId];
    const asg = run ? d.state.assignments[run.assignmentId] : null;
    if (!run || !asg) throw new CommandError('unknown run', 404);
    if (asg.kind !== 'review' || !asg.review) return { ok: false, error: 'submit_review is only for review assignments; use post_handoff for your own work' };
    const sha = String(args.reviewed_sha ?? '').trim().toLowerCase();
    if (sha.length < 7 || !asg.review.targetSha.startsWith(sha)) return { ok: false, error: `reviewed_sha must be the target SHA ${asg.review.targetSha}` };
    const verdict = parseVerdict(args.verdict);
    if (!verdict) return { ok: false, error: 'verdict must be approve or request_changes' };
    const findings = Array.isArray(args.findings) ? (args.findings as FindingInput[]) : [];
    if (verdict === 'approve' && findings.some((f) => normalizeSeverity(f.severity) === 'blocker')) return { ok: false, error: 'an approval cannot carry blocker findings; request changes instead' };
    if (this.reviewForAssignment(asg.id)) return { ok: false, error: 'a review was already recorded for this assignment' };
    const review = await this.serial(() => this.record({ workItemId: run.workItemId, targetSha: asg.review!.targetSha, reviewer: agentActor(run.agentId), assignment: asg, runId, verdict, summary: String(args.summary ?? ''), findings, source: 'mcp' }));
    return { ok: true, reviewId: review.id, verdict: review.verdict, stale: Boolean(review.staleAt), followUps: review.findings.filter((f) => f.followUpWorkItemId).length };
  }

  /** Reviewer run finished: fall back to the handoff verdict if no typed review was submitted. */
  async onReviewRunEnded(runId: string): Promise<void> {
    const d = this.d;
    const run = d.state.runs[runId];
    const asg = run ? d.state.assignments[run.assignmentId] : null;
    if (!run || !asg?.review || this.reviewForAssignment(asg.id)) return;
    const h = run.handoff;
    if (run.exit?.kind !== 'completed') return;
    if (!h?.verdict || h.source === 'skeleton') {
      d.alert({ kind: 'review', severity: 'warn', agentId: run.agentId, runId, workItemId: run.workItemId, message: `${d.state.agents[run.agentId]?.config.name ?? run.agentId} finished reviewing ${d.state.workItems[run.workItemId]?.key ?? ''} without a verdict. Nothing was approved.`, dedupeKey: `review-verdict:${runId}` });
      return;
    }
    const findings = (h.findings ?? []).map((t) => parseFindingText(t));
    // An "approval" that lists a blocker is treated as a request for changes.
    const verdict: ReviewVerdict = h.verdict === 'approve' && findings.some((f) => f.severity === 'blocker') ? 'request_changes' : h.verdict;
    await this.serial(() => this.record({ workItemId: run.workItemId, targetSha: asg.review!.targetSha, reviewer: agentActor(run.agentId), assignment: asg, runId, verdict, summary: h.done, findings, source: 'handoff' }));
  }

  /** The owner reviews the current head of the author's branch directly. */
  async recordHumanReview(workItemId: string, input: { verdict: unknown; sha?: string; summary?: string; findings?: FindingInput[] }, actor: Actor = HUMAN): Promise<ReviewRecord> {
    if (actor.type !== 'human') throw new CommandError('only the owner can record a review here', 403);
    const d = this.d;
    const item = d.state.workItems[workItemId];
    if (!item) throw new CommandError(`unknown work item ${workItemId}`, 404);
    const verdict = parseVerdict(input.verdict);
    if (!verdict) throw new CommandError('verdict must be approve or request_changes');
    const author = authorAssignment(d.state, workItemId);
    if (!author?.branch) throw new CommandError(`${item.key ?? item.title} has no agent branch to review`, 409);
    const head = await revParse(this.repo, `refs/heads/${author.branch}`);
    if (!head || (input.sha && !head.startsWith(input.sha))) throw new CommandError(`${author.branch} is at ${short(head)}; review the current commit`, 409);
    if (!['handoff_received', 'in_review', 'approved', 'changes_requested'].includes(item.state)) throw new CommandError(`${item.key ?? item.id} is ${item.state.replace(/_/g, ' ')}; reviews start after a handoff`, 409);
    return this.serial(() => this.record({ workItemId, targetSha: head, reviewer: actor, assignment: null, runId: null, verdict, summary: input.summary ?? '', findings: input.findings ?? [], source: 'human' }));
  }

  private reviewForAssignment(assignmentId: string): ReviewRecord | null {
    return Object.values(this.d.state.reviews ?? {}).find((r) => r.assignmentId === assignmentId) ?? null;
  }

  private async record(i: { workItemId: string; targetSha: string; reviewer: Actor; assignment: Assignment | null; runId: string | null; verdict: ReviewVerdict; summary: string; findings: FindingInput[]; source: ReviewRecord['source'] }): Promise<ReviewRecord> {
    const d = this.d;
    const item = d.state.workItems[i.workItemId];
    if (!item) throw new CommandError(`unknown work item ${i.workItemId}`, 404);
    if (i.reviewer.type === 'system') throw new CommandError('the control center cannot review work', 403);
    const target = i.assignment?.review ?? null;
    const author = target?.authorAssignmentId ? d.state.assignments[target.authorAssignmentId] : authorAssignment(d.state, item.id);
    const sourceBranch = target?.sourceBranch ?? author?.branch ?? null;
    const authorAgentId = target?.authorAgentId ?? author?.agentId ?? null;
    if (i.reviewer.type === 'agent' && i.reviewer.id === authorAgentId) throw new CommandError('the author cannot review their own work', 409);
    const head = sourceBranch ? await revParse(this.repo, `refs/heads/${sourceBranch}`) : null;
    const stale = head !== i.targetSha;
    const now = d.nowIso();
    const findings: ReviewFinding[] = i.findings.slice(0, 50).map((f) => ({
      id: newId('fnd'),
      severity: normalizeSeverity(f.severity),
      title: ellipsize(String(f.title ?? f.body ?? 'Finding').trim() || 'Finding', 140),
      body: ellipsize(String(f.body ?? f.title ?? '').trim(), 4000),
      path: typeof f.path === 'string' && f.path.trim() ? f.path.trim() : null,
      line: typeof f.line === 'number' && Number.isFinite(f.line) ? Math.trunc(f.line) : null,
      followUpWorkItemId: null,
    }));
    const checks = checksAt(item, d.config.project, requiredCheckNames(d.config.project, author), i.targetSha);
    const review: ReviewRecord = {
      id: newId('rev'),
      workItemId: item.id,
      targetSha: i.targetSha,
      sourceBranch,
      baseSha: target?.baseSha ?? author?.baseSha ?? null,
      authorAgentId,
      reviewer: i.reviewer,
      assignmentId: i.assignment?.id ?? null,
      runId: i.runId,
      workflowId: i.assignment?.workflowId ?? null,
      taskId: i.assignment?.taskId ?? null,
      verdict: i.verdict,
      summary: ellipsize(i.summary.trim(), 2000),
      findings,
      evidenceIds: checks.flatMap((c) => (c.evidence ? [c.evidence.id] : [])),
      source: i.source,
      at: now,
      staleAt: stale ? now : null,
      staleReason: stale ? `${sourceBranch ?? 'the branch'} is at ${short(head)}, not the reviewed commit` : null,
    };
    const refs = { workItemId: item.id, assignmentId: i.assignment?.id ?? null, runId: i.runId, agentId: i.reviewer.type === 'agent' ? i.reviewer.id : null };
    const events: NewEvent[] = [{ type: 'review.recorded', actor: i.reviewer, ...refs, data: { review } }];
    const outbox: OutboxOp[] = [];
    for (const f of findings) {
      if (f.severity === 'nit') continue;
      const fu = d.buildIssue(
        {
          title: ellipsize(`Review: ${f.title}`, 200),
          description: [f.body, '', `Found in the ${i.verdict === 'approve' ? 'approving' : 'change-requesting'} review ${review.id} of ${item.key ?? item.title} at \`${short(i.targetSha)}\`${f.path ? ` (${f.path}${f.line ? `:${f.line}` : ''})` : ''}.`].join('\n'),
          labels: ['review-finding', f.severity],
          priority: f.severity === 'blocker' ? 1 : f.severity === 'major' ? 2 : 3,
          parentKey: item.key,
        },
        i.reviewer,
      );
      events.push(...fu.events, { type: 'review.finding_linked', actor: i.reviewer, workItemId: item.id, data: { reviewId: review.id, findingId: f.id, workItemId: fu.item.id } });
      outbox.push(...fu.outbox);
    }
    const who = i.reviewer.type === 'agent' ? (d.state.agents[i.reviewer.id]?.config.name ?? i.reviewer.id) : 'the owner';
    outbox.push({
      workItemId: item.id,
      op: 'comment',
      payload: {
        body: [
          `**Review by ${who}: ${i.verdict === 'approve' ? 'approved' : 'changes requested'}** at \`${short(i.targetSha)}\`${sourceBranch ? ` on \`${sourceBranch}\`` : ''}${stale ? ` (stale: ${review.staleReason})` : ''}`,
          review.summary,
          ...findings.map((f) => `- ${f.severity}: ${f.path ? `\`${f.path}${f.line ? `:${f.line}` : ''}\` ` : ''}${f.title}`),
          ...checks.map((c) => `- ${c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⚪'} ${c.name} at this SHA`),
        ].filter(Boolean).join('\n'),
      },
    });
    if (!stale) {
      const to: LifecycleState = i.verdict === 'approve' ? 'approved' : 'changes_requested';
      try {
        const t = d.transition(item.id, to, `${who} ${i.verdict === 'approve' ? 'approved' : 'requested changes on'} ${short(i.targetSha)}`, i.reviewer);
        events.push(...t.events);
        outbox.push(...t.outbox);
      } catch {
        // The issue moved on (e.g. canceled); the review stays on record.
      }
    }
    d.commit(events, outbox);
    d.outbox.kick();
    if (stale) d.alert({ kind: 'review', severity: 'warn', workItemId: item.id, message: `${who}'s review of ${item.key ?? item.title} is for ${short(i.targetSha)} but the branch is now ${short(head)}; it does not count as an approval.`, dedupeKey: `review-stale:${review.id}` });
    return d.state.reviews[review.id];
  }

  // ---- invalidation ------------------------------------------------------------------------

  private react(events: EventEnvelope[]): void {
    const hits: { reviewIds: string[]; reason: string; workItemId: string }[] = [];
    for (const e of events) {
      if (e.type !== 'work_item.evidence_added' || e.data.evidence.kind !== 'commit' || !e.workItemId) continue;
      const ev = e.data.evidence;
      const stale = reviewsForItem(this.d.state, e.workItemId).filter((r) => !r.staleAt && r.sourceBranch && r.sourceBranch === ev.branch && r.targetSha !== ev.sha);
      if (stale.length) hits.push({ reviewIds: stale.map((r) => r.id), reason: `new commit ${short(ev.sha)} on ${ev.branch}`, workItemId: e.workItemId });
    }
    if (hits.length) queueMicrotask(() => { for (const h of hits) this.invalidate(h.workItemId, h.reviewIds, h.reason); });
  }

  /** Mark reviews stale, pull an approved issue back to changes requested, close stale merge decisions. */
  invalidate(workItemId: string, reviewIds: string[], reason: string): void {
    const d = this.d;
    if (d.closed) return;
    const live = reviewIds.filter((id) => d.state.reviews[id] && !d.state.reviews[id].staleAt);
    if (live.length === 0) return;
    const events: NewEvent[] = live.map((reviewId) => ({ type: 'review.invalidated' as const, actor: SYSTEM, workItemId, data: { reviewId, reason } }));
    for (const dec of Object.values(d.state.decisions)) {
      if (dec.kind === 'merge' && dec.workItemId === workItemId && !dec.consumedAt && dec.action?.kind === 'merge' && live.includes(dec.action.reviewId)) events.push({ type: 'decision.consumed', actor: SYSTEM, workItemId, data: { decisionId: dec.id, outcome: `superseded: ${reason}` } });
    }
    const approvals = live.filter((id) => d.state.reviews[id].verdict === 'approve');
    const outbox: OutboxOp[] = approvals.length ? [{ workItemId, op: 'comment', payload: { body: `Approval of \`${short(d.state.reviews[approvals[0]].targetSha)}\` is stale: ${reason}. A new independent review is required.` } }] : [];
    if (d.state.workItems[workItemId]?.state === 'approved') d.tryTransition(workItemId, 'changes_requested', `approval invalidated: ${reason}`, events, outbox);
    else d.commit(events, outbox);
  }

  // ---- merge -------------------------------------------------------------------------------

  /** Every merge gate, evaluated against the live git refs. Also invalidates approvals git shows are stale. */
  async gatesFor(workItemId: string): Promise<{ gates: MergeGate[]; sourceBranch: string | null; sourceSha: string | null; target: string; targetSha: string | null }> {
    const d = this.d;
    const p = d.config.project;
    const author = authorAssignment(d.state, workItemId);
    const sourceBranch = author?.branch ?? null;
    const sourceSha = sourceBranch ? await revParse(this.repo, `refs/heads/${sourceBranch}`) : null;
    const target = p.integration_branch;
    const targetSha = await revParse(this.repo, `refs/heads/${target}`);
    if (sourceSha) {
      const stale = reviewsForItem(d.state, workItemId).filter((r) => !r.staleAt && r.sourceBranch === sourceBranch && r.targetSha !== sourceSha);
      if (stale.length) this.invalidate(workItemId, stale.map((r) => r.id), `${sourceBranch} is now at ${short(sourceSha)}`);
    }
    const gates = evaluateMergeGates({ state: d.state, project: p, workItemId, sourceBranch, sourceSha, target });
    const names = requiredCheckNames(p, author);
    const key = checkRuntimeKey(p.check_runtime);
    if (names.length) {
      const proof = checksAt(d.state.workItems[workItemId] ?? { evidence: [] }, p, names, sourceSha);
      const currentRuntime = Boolean(key) && proof.every(c => c.evidence?.checkRuntime === key);
      gates.push({ id: 'checks', label: 'Check runtime', ok: currentRuntime, detail: currentRuntime ? 'proof matches the configured project check runtime' : 'required checks need current configured Docker proof (or explicitly marked disposable host fixture proof)' });
    }
    // App-owned merges suppress Git hooks, so enforce assignment scope as an explicit gate.
    if (sourceSha && author?.baseSha) {
      const files = await git(this.repo, ['diff', '--name-only', '-z', '--no-renames', author.baseSha, sourceSha], { allowFail: true });
      const bad = outOfScope(files.stdout.split('\0').filter(Boolean), author.allowedPaths, []);
      gates.push({ id: 'worktree', label: 'Path scope', ok: files.code === 0 && !bad.length, detail: files.code !== 0 ? 'could not inspect source paths' : bad.length ? `outside assignment scope: ${bad.slice(0, 8).join(', ')}` : 'committed paths fit the assignment' });
    }
    if (!targetSha) gates.push({ id: 'conflicts', label: 'Conflicts', ok: false, detail: `${target} does not exist` });
    else if (sourceSha) {
      const conflicts = await mergeConflicts(this.repo, targetSha, sourceSha);
      gates.push(conflicts === null ? { id: 'conflicts', label: 'Conflicts', ok: false, detail: 'could not check for conflicts (git 2.38 or newer is required)' } : conflicts.length ? { id: 'conflicts', label: 'Conflicts', ok: false, detail: `conflicts in ${conflicts.slice(0, 8).join(', ')}` } : { id: 'conflicts', label: 'Conflicts', ok: true, detail: `merges cleanly into ${target}` });
    }
    return { gates, sourceBranch, sourceSha, target, targetSha };
  }

  /** Ask the owner for one exact merge. Refuses (and records why) when any gate already fails. */
  async requestMerge(workItemId: string, actor: Actor = HUMAN) {
    const d = this.d;
    const item = d.state.workItems[workItemId];
    if (!item) throw new CommandError(`unknown work item ${workItemId}`, 404);
    const g = await this.gatesFor(workItemId);
    const failing = g.gates.filter((x) => !x.ok);
    const approval = currentApproval(d.state, workItemId, g.sourceSha);
    if (failing.length || !approval || !g.sourceBranch || !g.sourceSha || !g.targetSha) {
      const reason = failing.map((x) => `${x.label}: ${x.detail}`).join('; ') || 'no independent approval at the current commit';
      d.commit([{ type: 'merge.refused', actor, workItemId, data: { workItemId, decisionId: null, reason, gates: g.gates } }]);
      throw new CommandError(`merge refused: ${reason}`, 409);
    }
    const binding = { workItemId, sourceBranch: g.sourceBranch, sourceSha: g.sourceSha, target: g.target, targetSha: g.targetSha, reviewId: approval.id };
    const action: MergeAction = { kind: 'merge', ...binding, hash: mergeActionHash(binding) };
    const open = Object.values(d.state.decisions).filter((x) => x.kind === 'merge' && x.workItemId === workItemId && !x.consumedAt && !(x.answeredAt && x.answer === REJECT_OPTION));
    const same = open.find((x) => x.action?.hash === action.hash && !x.answeredAt);
    if (same) return { decision: same, gates: g.gates };
    for (const x of open) d.decisions.consume(x.id, 'superseded by a newer merge request', actor);
    const stat = await git(this.repo, ['diff', '--shortstat', g.targetSha, g.sourceSha], { allowFail: true });
    const files = Number(/(\d+) files? changed/.exec(stat.stdout)?.[1] ?? 0);
    const lines = Number(/(\d+) insertions?/.exec(stat.stdout)?.[1] ?? 0) + Number(/(\d+) deletions?/.exec(stat.stdout)?.[1] ?? 0);
    const risk = files > 15 || lines > 500 ? 'high' : files > 5 || lines > 150 ? 'medium' : 'low';
    const reviewer = approval.reviewer.type === 'agent' ? (d.state.agents[approval.reviewer.id]?.config.name ?? approval.reviewer.id) : 'the owner';
    const decision = d.decisions.create(
      {
        kind: 'merge',
        workItemId,
        question: `Merge ${item.key ?? item.title} (${g.sourceBranch} @ ${short(g.sourceSha)}) into ${g.target} @ ${short(g.targetSha)}?`,
        options: [MERGE_OPTION, REJECT_OPTION],
        confirmOptions: [MERGE_OPTION],
        irreversible: true,
        urgency: 'normal',
        risk,
        action,
        evidence: [
          ...g.gates.map((x) => ({ label: x.label, detail: x.detail, ok: x.ok })),
          { label: 'Change size', detail: stat.stdout.trim() || 'no file changes', ok: null },
          { label: 'Reviewer', detail: `${reviewer} (${approval.source}) at ${short(approval.targetSha)}`, ok: null },
          { label: 'Scope', detail: `local merge into ${g.target} only; nothing is pushed or deployed`, ok: null },
        ],
      },
      actor,
    );
    return { decision, gates: g.gates };
  }

  /** Answer a decision; a confirmed merge approval runs the merge immediately. */
  async answer(decisionId: string, answer: string, o: { nonce?: string | null; channel?: string }, actor: Actor = HUMAN): Promise<{ decision: unknown; merge?: MergeOutcome }> {
    const d = this.d;
    const dec = d.state.decisions[decisionId];
    if (!dec) throw new CommandError(`unknown decision ${decisionId}`, 404);
    if (dec.kind === 'docker') throw new CommandError('answer container actions from the Docker panel', 409);
    d.decisions.answer(decisionId, answer, o, actor);
    if (dec.kind === 'merge') {
      if (answer === REJECT_OPTION) {
        d.decisions.consume(decisionId, 'rejected by the owner', actor);
        return { decision: d.state.decisions[decisionId] };
      }
      const merge = await this.executeMerge(decisionId, actor);
      return { decision: d.state.decisions[decisionId], merge };
    }
    return { decision: d.state.decisions[decisionId] };
  }

  executeMerge(decisionId: string, actor: Actor = HUMAN): Promise<MergeOutcome> {
    return this.serial(() => this.doMerge(decisionId, actor));
  }

  private refuse(workItemId: string, decisionId: string | null, reason: string, gates: MergeGate[], consume: boolean, actor: Actor): MergeOutcome {
    const d = this.d;
    const events: NewEvent[] = [{ type: 'merge.refused', actor, workItemId, data: { workItemId, decisionId, reason, gates } }];
    if (consume && decisionId && !d.state.decisions[decisionId]?.consumedAt) events.push({ type: 'decision.consumed', actor: SYSTEM, workItemId, data: { decisionId, outcome: `refused: ${reason}` } });
    d.commit(events);
    d.alert({ kind: 'merge', severity: 'warn', workItemId, message: `Merge of ${d.state.workItems[workItemId]?.key ?? workItemId} refused: ${reason}`, dedupeKey: `merge-refused:${decisionId ?? workItemId}:${ellipsize(reason, 60)}` });
    return { merged: false, reason, gates };
  }

  private async doMerge(decisionId: string, actor: Actor): Promise<MergeOutcome> {
    const d = this.d;
    const dec = d.state.decisions[decisionId];
    if (!dec || dec.kind !== 'merge' || dec.action?.kind !== 'merge') throw new CommandError(`unknown merge decision ${decisionId}`, 404);
    const a = dec.action;
    const auth = d.decisions.authorizes(decisionId, MERGE_OPTION, a.hash);
    if (!auth.ok) return this.refuse(a.workItemId, decisionId, auth.reason, [{ id: 'decision', label: 'Human decision', ok: false, detail: auth.reason }], false, actor);
    const g = await this.gatesFor(a.workItemId);
    const gates: MergeGate[] = [{ id: 'decision', label: 'Human decision', ok: true, detail: `approved by ${dec.answeredBy?.id ?? 'owner'} via ${dec.channel ?? 'web'}` }, ...g.gates];
    const drift: string[] = [];
    if (g.sourceBranch !== a.sourceBranch) drift.push(`source branch is now ${g.sourceBranch ?? 'missing'}, decision was for ${a.sourceBranch}`);
    if (g.sourceSha !== a.sourceSha) drift.push(`${a.sourceBranch} moved from ${short(a.sourceSha)} to ${short(g.sourceSha)}`);
    if (g.target !== a.target) drift.push(`integration branch is now ${g.target}, decision was for ${a.target}`);
    if (g.targetSha !== a.targetSha) drift.push(`${a.target} moved from ${short(a.targetSha)} to ${short(g.targetSha)}`);
    const failing = g.gates.filter((x) => !x.ok);
    if (drift.length || failing.length) return this.refuse(a.workItemId, decisionId, [...drift, ...failing.map((x) => `${x.label}: ${x.detail}`)].join('; '), gates, true, actor);
    const item = d.state.workItems[a.workItemId];
    const result = await this.performMerge(a, decisionId, item.key ?? item.id);
    if (!result.ok) return this.refuse(a.workItemId, decisionId, result.reason, [...gates, { id: 'worktree', label: 'Merge', ok: false, detail: result.reason }], result.permanent, actor);

    const approval = currentApproval(d.state, a.workItemId, a.sourceSha);
    const checkNames = requiredCheckNames(d.config.project, authorAssignment(d.state, a.workItemId, a.sourceBranch));
    const merge: IntegrationMerge = {
      id: newId('mrg'),
      workItemId: a.workItemId,
      decisionId,
      reviewId: approval?.id ?? a.reviewId,
      sourceBranch: a.sourceBranch,
      sourceSha: a.sourceSha,
      target: a.target,
      targetShaBefore: a.targetSha,
      mergeSha: result.mergeSha,
      method: result.method,
      at: d.nowIso(),
      postChecks: { status: checkNames.length ? 'pending' : 'none', evidenceIds: [], at: null },
    };
    const evidence: Evidence = { id: newId('evd'), kind: 'merge', summary: `merged ${a.sourceBranch} @ ${short(a.sourceSha)} into ${a.target} as ${short(result.mergeSha)} (decision ${decisionId})`, sha: result.mergeSha, branch: a.target, env: 'local', verified: true, at: d.nowIso() };
    const events: NewEvent[] = [
      { type: 'merge.completed', actor, workItemId: a.workItemId, data: { merge } },
      { type: 'work_item.evidence_added', actor: SYSTEM, workItemId: a.workItemId, data: { evidence } },
      { type: 'decision.consumed', actor: SYSTEM, workItemId: a.workItemId, data: { decisionId, outcome: `merged as ${result.mergeSha}` } },
    ];
    const outbox: OutboxOp[] = [];
    try {
      const t = d.transition(a.workItemId, 'merged', `merged into ${a.target} as ${short(result.mergeSha)}`, actor);
      events.push(...t.events);
      outbox.push(...t.outbox);
    } catch (e) {
      d.alert({ kind: 'merge', severity: 'critical', workItemId: a.workItemId, message: `merged as ${short(result.mergeSha)} but the lifecycle could not move to merged: ${(e as Error).message}`, dedupeKey: `merge-lifecycle:${merge.id}` });
    }
    outbox.push({ workItemId: a.workItemId, op: 'comment', payload: { body: `**Merged into \`${a.target}\`** locally as \`${short(result.mergeSha)}\` from \`${a.sourceBranch}\` @ \`${short(a.sourceSha)}\` after the owner's decision ${decisionId}. Nothing was pushed or deployed. Post-merge checks: ${checkNames.length ? 'running' : 'none configured'}.` } });
    d.commit(events, outbox);
    d.outbox.kick();
    void d.runs.track(this.postMergeChecks(merge.id)).catch((e) => d.alert({ kind: 'merge', severity: 'critical', workItemId: a.workItemId, message: `post-merge checks could not run: ${(e as Error).message}`, dedupeKey: `merge-checks:${merge.id}` }));
    return { merged: true, mergeId: merge.id, mergeSha: result.mergeSha, gates };
  }

  private async identityArgs(cwd: string): Promise<string[]> {
    const email = (await git(cwd, ['config', 'user.email'], { allowFail: true })).stdout.trim();
    const name = (await git(cwd, ['config', 'user.name'], { allowFail: true })).stdout.trim();
    return [...(name ? [] : ['-c', 'user.name=One Connect']), ...(email ? [] : ['-c', 'user.email=one-connect@localhost'])];
  }

  private async checkedOutAt(branch: string): Promise<string | null> {
    const r = await git(this.repo, ['worktree', 'list', '--porcelain'], { allowFail: true });
    for (const block of r.stdout.split('\n\n')) {
      const wt = /^worktree (.+)$/m.exec(block)?.[1];
      if (wt && new RegExp(`^branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(block)) return wt;
    }
    return null;
  }

  /**
   * Local merge with repository/global hooks and executable drivers suppressed. If the target is checked out, merge there only when
   * its tracked files are clean and no untracked file would be overwritten; otherwise merge in a
   * scratch worktree and advance the ref with a compare-and-swap.
   */
  private async performMerge(a: MergeAction, decisionId: string, key: string): Promise<{ ok: true; mergeSha: string; method: IntegrationMerge['method'] } | { ok: false; reason: string; permanent: boolean }> {
    const d = this.d;
    const message = `Merge ${a.sourceBranch} (${key}) into ${a.target}\n\nOne-Connect-Decision: ${decisionId}\nReviewed-SHA: ${a.sourceSha}\nReview: ${a.reviewId}`;
    const wt = await this.checkedOutAt(a.target);
    if (wt) {
      const id = await this.identityArgs(wt);
      const status = (await git(wt, ['status', '--porcelain', '--untracked-files=all'], { allowFail: true })).stdout.split('\n').filter(Boolean);
      const tracked = status.filter((l) => !l.startsWith('??'));
      if (tracked.length) return { ok: false, permanent: false, reason: `${a.target} is checked out at ${wt} with ${tracked.length} uncommitted change${tracked.length > 1 ? 's' : ''}; commit or stash them first (nothing was touched)` };
      const untracked = status.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
      const incoming = (await git(this.repo, ['diff', '--name-only', a.targetSha, a.sourceSha], { allowFail: true })).stdout.split('\n').filter(Boolean);
      const collide = untracked.filter((f) => incoming.includes(f) || incoming.some((x) => f.endsWith('/') && x.startsWith(f)));
      if (collide.length) return { ok: false, permanent: false, reason: `untracked files in ${wt} would be overwritten: ${collide.slice(0, 5).join(', ')} (nothing was touched)` };
      if ((await revParse(wt, 'HEAD')) !== a.targetSha) return { ok: false, permanent: true, reason: `${a.target} moved since the decision` };
      const r = await git(wt, [...id, 'merge', '--no-ff', '-m', message, a.sourceSha], { allowFail: true, timeoutMs: 120_000 });
      if (r.code !== 0) {
        await git(wt, ['merge', '--abort'], { allowFail: true });
        return { ok: false, permanent: true, reason: `git merge failed (repository hooks disabled): ${ellipsize((r.stderr || r.stdout).trim(), 300)}` };
      }
      const mergeSha = await revParse(wt, 'HEAD');
      return mergeSha ? { ok: true, mergeSha, method: 'worktree' } : { ok: false, permanent: true, reason: 'merge produced no commit' };
    }
    const scratch = path.join(d.paths.root, 'merge-scratch', newId('mg'));
    fs.mkdirSync(path.dirname(scratch), { recursive: true });
    const add = await git(this.repo, ['worktree', 'add', '--detach', scratch, a.targetSha], { allowFail: true });
    if (add.code !== 0) return { ok: false, permanent: false, reason: `could not create a scratch worktree: ${ellipsize(add.stderr.trim(), 200)}` };
    try {
      const id = await this.identityArgs(scratch);
      const r = await git(scratch, [...id, 'merge', '--no-ff', '-m', message, a.sourceSha], { allowFail: true, timeoutMs: 120_000 });
      if (r.code !== 0) {
        await git(scratch, ['merge', '--abort'], { allowFail: true });
        return { ok: false, permanent: true, reason: `git merge failed (repository hooks disabled): ${ellipsize((r.stderr || r.stdout).trim(), 300)}` };
      }
      const mergeSha = await revParse(scratch, 'HEAD');
      if (!mergeSha) return { ok: false, permanent: true, reason: 'merge produced no commit' };
      const u = await git(this.repo, ['update-ref', '-m', `one-connect: merge ${a.sourceBranch} (${decisionId})`, `refs/heads/${a.target}`, mergeSha, a.targetSha], { allowFail: true });
      if (u.code !== 0) return { ok: false, permanent: true, reason: `${a.target} moved during the merge; nothing was changed` };
      return { ok: true, mergeSha, method: 'ref' };
    } finally {
      await removeWorktree(this.repo, scratch);
    }
  }

  /** Required checks at the merge commit, in a scratch worktree (never the user's checkout). */
  async postMergeChecks(mergeId: string): Promise<void> {
    const d = this.d;
    const m = d.state.merges[mergeId];
    if (!m || m.postChecks.status !== 'pending') return;
    const author = authorAssignment(d.state, m.workItemId, m.sourceBranch);
    const checks = requiredCheckNames(d.config.project, author).map(name => ({ name, command: d.config.project.checks[name] ?? '' }));
    // The checks runner exports m.mergeSha directly from Git objects, even if the target moves.
    try {
      const results = await runChecks({ cwd: this.repo, repo: this.repo, sha: m.mergeSha, runtime: d.config.project.check_runtime, checks, logDir: path.join(d.paths.root, 'merge-checks', mergeId), env: { PATH: d.baseEnv().PATH }, denylist: d.denylist() });
      if (d.closed) return;
      const evidence: Evidence[] = results.map((r) => ({ id: newId('evd'), kind: r.counts ? 'test' : 'command', summary: `[${r.runtime}] post-merge ${r.name}: ${r.status} on ${m.target} @ ${short(m.mergeSha)} (exit ${r.exitCode ?? 'none'})${r.status === 'unavailable' ? `: ${r.detail}` : ''}`, command: r.command, exitCode: r.exitCode, counts: r.counts ?? undefined, sha: r.sha ?? undefined, branch: m.target, logPath: r.logPath, checkRuntime: r.runtimeKey, checkImage: r.imageId, env: 'local', verified: true, at: d.nowIso() }));
      const passed = results.length === checks.length && results.length > 0 && results.every(r => r.status === 'passed');
      d.commit(
        [...evidence.map(e => ({ type: 'work_item.evidence_added' as const, actor: SYSTEM, workItemId: m.workItemId, data: { evidence: e } })), { type: 'merge.post_checks', actor: SYSTEM, workItemId: m.workItemId, data: { mergeId, status: passed ? 'passed' : 'failed', evidenceIds: evidence.map(e => e.id) } }],
        [{ workItemId: m.workItemId, op: 'comment', payload: { body: [`**Post-merge checks on \`${m.target}\` @ \`${short(m.mergeSha)}\`:** ${passed ? 'green' : 'FAILED'}`, ...results.map(r => `- ${r.status === 'passed' ? '✅' : '❌'} [${r.runtime}] ${r.name}: ${r.status}`)].join('\n') } }],
      );
      d.outbox.kick();
      if (!passed) d.alert({ kind: 'merge', severity: 'critical', workItemId: m.workItemId, message: `${d.state.workItems[m.workItemId]?.key ?? ''}: required checks failed or unavailable on ${m.target} after the merge (${short(m.mergeSha)}). It cannot be marked Done.`, dedupeKey: `post-merge:${mergeId}` });
    } catch (e) {
      // Fail closed even if evidence storage/source setup throws; never leave a green/pending gate.
      d.commit([{ type: 'merge.post_checks', actor: SYSTEM, workItemId: m.workItemId, data: { mergeId, status: 'failed', evidenceIds: [] } }]);
      throw e;
    }
  }

  /** The owner's acceptance. Done only with verified merge + green post-merge checks + acceptance evidence. */
  recordAcceptance(workItemId: string, input: { summary?: string; env?: Evidence['env'] }, actor: Actor = HUMAN): { verified: boolean; reason: string | null } {
    if (actor.type !== 'human' || /^jev$/i.test(actor.id)) throw new CommandError('only the owner can accept work', 403);
    const d = this.d;
    const item = d.state.workItems[workItemId];
    if (!item) throw new CommandError(`unknown work item ${workItemId}`, 404);
    const summary = String(input.summary ?? '').trim();
    if (!summary) throw new CommandError('describe what you verified');
    if (!['merged', 'release_candidate', 'deployed'].includes(item.state)) throw new CommandError(`${item.key ?? item.id} is ${item.state.replace(/_/g, ' ')}; accept it after the merge`, 409);
    const merge = Object.values(d.state.merges ?? {}).filter((m) => m.workItemId === workItemId).sort((x, y) => x.at.localeCompare(y.at)).at(-1);
    if (!merge) throw new CommandError('no recorded integration merge', 409);
    if (merge.postChecks.status !== 'passed') throw new CommandError(`post-merge checks are ${merge.postChecks.status}; Done needs them green`, 409);
    const env = input.env && ['local', 'ci', 'production', 'device'].includes(input.env) ? input.env : 'local';
    const evidence: Evidence = { id: newId('evd'), kind: 'acceptance', summary: ellipsize(summary, 500), sha: merge.mergeSha, branch: merge.target, env, verified: true, at: d.nowIso() };
    const events: NewEvent[] = [{ type: 'work_item.evidence_added', actor, workItemId, data: { evidence } }];
    const outbox: OutboxOp[] = [{ workItemId, op: 'comment', payload: { body: `**Accepted by the owner** (${env}) at \`${short(merge.mergeSha)}\`: ${evidence.summary}` } }];
    const check = canTransition(item.state, 'verified', { evidence: [...item.evidence, evidence], requiresProductionVerification: item.requiresProductionVerification });
    if (check.ok) {
      events.push({ type: 'work_item.transitioned', actor, workItemId, data: { from: item.state, to: 'verified', reason: 'accepted with verified merge and acceptance evidence', blockedOn: null } });
      if (DEFAULT_TRACKER_CATEGORY[item.state] !== DEFAULT_TRACKER_CATEGORY.verified) outbox.push({ workItemId, op: 'set_status', payload: { category: DEFAULT_TRACKER_CATEGORY.verified, lifecycle: 'verified' } });
    }
    d.commit(events, outbox);
    d.outbox.kick();
    return { verified: check.ok, reason: check.ok ? null : check.reason };
  }
}

function parseVerdict(v: unknown): ReviewVerdict | null {
  const s = String(v ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'approve' || s === 'approved') return 'approve';
  if (s === 'request_changes' || s === 'changes_requested' || s === 'request_change') return 'request_changes';
  return null;
}
