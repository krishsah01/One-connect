// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Issue, assignment and dispatch commands: "no issue, no dispatch", pre-flight before any run,
// Now/Next queues, and lifecycle transitions that record every intermediate state and queue the
// matching tracker status. Daemon exposes these through its facade methods.
import type { Actor, Assignment, LifecycleState, NewEvent, PreflightResult, WorkItem } from '@acc/core';
import {
  canTransition,
  DEFAULT_ASK_HUMAN_IF,
  DEFAULT_TRACKER_CATEGORY,
  generateAssignmentText,
  HANDOFF_TEMPLATE,
  HUMAN,
  isManualRelay,
  newId,
  runPreflight,
  sharedCapacity,
  SYSTEM,
  transitionPath,
} from '@acc/core';
import type { TrackerAdapter } from './adapters/trackers/index.ts';
import type { Connectors } from './connectors.ts';
import type { ContextSync } from './context/sync.ts';
import type { Designer } from './designer.ts';
import { CommandError } from './errors.ts';
import type { AgentCommands, AssignmentInput, ChangeSet, IssueInput, Kernel, WorkCommands } from './kernel.ts';
import type { OutboxWorker } from './outbox.ts';
import type { ReviewMerge } from './reviewMerge.ts';
import type { Rules } from './rules.ts';
import type { RunManager } from './runManager.ts';
import type { SkillLibrary } from './skills.ts';
import type { OutboxOp } from './store/eventStore.ts';
import type { SubscriptionSafety } from './subscriptionSafety.ts';
import type { AccountCompliance } from './accountCompliance.ts';
import { workflowPrompt } from './workflowOptions.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type WorkServiceDeps = Kernel & Pick<AgentCommands, 'probe' | 'spentToday'> & {
  readonly runs: RunManager;
  readonly rules: Rules;
  readonly skillLib: SkillLibrary;
  readonly outbox: OutboxWorker;
  readonly designer: Designer;
  readonly tracker: TrackerAdapter;
  readonly subscriptionSafety: SubscriptionSafety;
  readonly accounts: AccountCompliance;
  readonly reviewMerge: ReviewMerge;
  readonly context: ContextSync;
  readonly connectors: Connectors;
};

export class WorkService implements WorkCommands {
  readonly d: WorkServiceDeps;

  constructor(d: WorkServiceDeps) {
    this.d = d;
  }

  /** Events + outbox for a lifecycle transition; throws CommandError if it isn't allowed. */
  transition(itemId: string, to: LifecycleState, reason: string, actor: Actor = SYSTEM, blockedOn?: WorkItem['blockedOn']): { events: NewEvent[]; outbox: OutboxOp[] } {
    const item = this.d.state.workItems[itemId];
    if (!item) throw new CommandError(`unknown work item ${itemId}`, 404);
    if (item.state === to) return { events: [], outbox: [] };
    const ctx = { evidence: item.evidence, requiresProductionVerification: item.requiresProductionVerification };
    const direct = canTransition(item.state, to, ctx);
    // Not a direct hop (e.g. backlog → running): walk the shortest valid path so every
    // intermediate state is recorded too.
    const path = direct.ok ? [to] : to === 'verified' ? null : transitionPath(item.state, to);
    if (!path) throw new CommandError(`${item.key ?? item.id}: ${direct.ok ? 'unreachable' : direct.reason}`, 409);
    if (!direct.ok) {
      const final = canTransition(path.length > 1 ? path[path.length - 2] : item.state, to, ctx);
      if (!final.ok) throw new CommandError(`${item.key ?? item.id}: ${final.reason}`, 409);
    }
    const events: NewEvent[] = [];
    let from = item.state;
    for (const step of path) {
      events.push({ type: 'work_item.transitioned', actor, workItemId: itemId, data: { from, to: step, reason, blockedOn: step === 'blocked' ? (blockedOn ?? null) : null } });
      from = step;
    }
    const outbox: OutboxOp[] = [];
    const trackerWritable = !(item.origin?.localMirror === true && !item.trackerId);
    if (trackerWritable && DEFAULT_TRACKER_CATEGORY[item.state] !== DEFAULT_TRACKER_CATEGORY[to]) {
      outbox.push({ workItemId: itemId, op: 'set_status', payload: { category: DEFAULT_TRACKER_CATEGORY[to], lifecycle: to } });
    }
    return { events, outbox };
  }

  /** Transition if allowed; returns false instead of throwing. */
  tryTransition(itemId: string, to: LifecycleState, reason: string, extra: NewEvent[] = [], extraOutbox: OutboxOp[] = [], actor: Actor = SYSTEM, blockedOn?: WorkItem['blockedOn']): boolean {
    try {
      const t = this.transition(itemId, to, reason, actor, blockedOn);
      this.d.commit([...extra, ...t.events], [...extraOutbox, ...t.outbox]);
      return true;
    } catch {
      this.d.commit(extra, extraOutbox);
      return false;
    }
  }

  createIssue(input: IssueInput, actor: Actor = HUMAN): WorkItem {
    const { item, events, outbox } = this.buildIssue(input, actor);
    this.d.commit(events, outbox);
    this.d.outbox.kick();
    return this.d.state.workItems[item.id];
  }

  /** Events + outbox for a new issue, so callers can create it atomically with other changes. */
  buildIssue(input: IssueInput, actor: Actor = HUMAN, o?: { mirror?: boolean; bind?: { trackerId: string; key: string; url: string | null; trackerStatus: WorkItem['trackerStatus'] } }): { item: WorkItem; events: NewEvent[]; outbox: OutboxOp[] } {
    const title = input.title?.trim();
    if (!title) throw new CommandError('title is required');
    const now = this.d.nowIso();
    const item: WorkItem = {
      id: newId('wi'),
      key: o?.bind?.key ?? null,
      trackerId: o?.bind?.trackerId ?? null,
      url: o?.bind?.url ?? null,
      title,
      description: input.description?.trim() ?? '',
      acceptance: (input.acceptance ?? []).map((a) => a.trim()).filter(Boolean),
      labels: input.labels ?? [],
      priority: input.priority ?? 3,
      parentKey: input.parentKey ?? null,
      blockedBy: [],
      state: 'backlog',
      blockedOn: null,
      resumeTo: null,
      ownerAgentId: null,
      assignmentIds: [],
      runIds: [],
      branches: [],
      evidence: [],
      requiresProductionVerification: input.requiresProductionVerification ?? false,
      trackerStatus: o?.bind?.trackerStatus ?? null,
      sync: o?.bind
        ? { status: 'synced', lastError: null, at: now }
        : o?.mirror
          ? { status: 'dry_run', lastError: 'Local mirror only; the authoritative tracker was not written.', at: now }
          : { status: 'pending', lastError: null, at: null },
      createdAt: now,
      updatedAt: now,
    };
    return {
      item,
      events: [{ type: 'work_item.created', actor, workItemId: item.id, data: { item } }],
      outbox: o?.bind || o?.mirror ? [] : [{ workItemId: item.id, op: 'create_issue', payload: { title: item.title, description: item.description, acceptance: item.acceptance, labels: item.labels, priority: item.priority, ...(item.parentKey ? { parentKey: item.parentKey } : {}) } }],
    };
  }

  createAssignment(input: AssignmentInput, actor: Actor = HUMAN): Assignment {
    const item = this.d.state.workItems[input.workItemId];
    if (!item) throw new CommandError(`unknown work item ${input.workItemId}`, 404);
    const agent = this.d.state.agents[input.agentId];
    if (!agent) throw new CommandError(`unknown agent ${input.agentId}`, 404);
    const relay = isManualRelay(agent.config);
    const requiredChecks = input.requiredChecks ?? this.d.config.project.required_checks ?? Object.keys(this.d.config.project.checks);
    const a: Assignment = {
      id: newId('as'),
      workItemId: item.id,
      agentId: agent.id,
      position: 'draft',
      scope: input.scope ?? '',
      allowedPaths: input.allowedPaths ?? [],
      worktree: null,
      branch: null,
      baseRef: input.baseRef ?? this.d.config.project.integration_branch,
      baseSha: null,
      requiredChecks,
      askHumanIf: input.askHumanIf ?? DEFAULT_ASK_HUMAN_IF,
      handoffFormat: HANDOFF_TEMPLATE,
      designRevision:this.d.state.design?.hash??null,
      skills: this.d.skillLib.freeze(agent.id, item.id),
      prompt: '',
      promptEdited: false,
      model: input.model ?? null,
      effort: agent.config.effort ?? null,
      preflight: null,
      createdAt: this.d.nowIso(),
      dispatchedAt: null,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.review ? { review: input.review } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId, taskId: input.taskId ?? null } : {}),
    };
    a.prompt = this.assignmentText(a, relay);
    this.d.commit([{ type: 'assignment.created', actor, agentId: a.agentId, workItemId: a.workItemId, assignmentId: a.id, data: { assignment: a } }]);
    return this.d.state.assignments[a.id];
  }

  assignmentText(a: Assignment, relay = isManualRelay(this.d.state.agents[a.agentId]?.config ?? { adapter: 'relay' })): string {
    const item = this.d.state.workItems[a.workItemId];
    const agent = this.d.state.agents[a.agentId];
    if (a.kind === 'review' && a.review) return this.d.reviewMerge.reviewText(a, relay) + this.d.designer.prompt(a) + workflowPrompt(a);
    return generateAssignmentText({
      project: this.d.config.project,
      agent: agent.config,
      item,
      assignmentId: a.id,
      scope: a.scope,
      allowedPaths: a.allowedPaths,
      worktree: a.worktree,
      branch: a.branch,
      baseRef: a.baseRef,
      requiredChecks: a.requiredChecks,
      askHumanIf: a.askHumanIf,
      relay,
      context: this.d.context?.templateContext(),
    })+this.d.connectors.promptNote(item)+this.d.designer.prompt(a)+workflowPrompt(a);
  }

  updateAssignment(id: string, patch: Partial<Pick<Assignment, 'prompt' | 'scope' | 'allowedPaths' | 'requiredChecks' | 'askHumanIf' | 'model' | 'effort'>>, actor: Actor = HUMAN): Assignment {
    const a = this.d.state.assignments[id];
    if (!a) throw new CommandError(`unknown assignment ${id}`, 404);
    if (a.position === 'done' || a.position === 'canceled') throw new CommandError(`assignment is ${a.position}`, 409);
    const next = { ...a, ...patch };
    const promptEdited = patch.prompt !== undefined ? patch.prompt !== this.assignmentText({ ...next, prompt: '' }) : a.promptEdited;
    const prompt = patch.prompt ?? (a.promptEdited ? a.prompt : this.assignmentText(next));
    this.d.commit([{ type: 'assignment.updated', actor, assignmentId: id, agentId: a.agentId, workItemId: a.workItemId, data: { patch: { ...patch, prompt, promptEdited } } }]);
    return this.d.state.assignments[id];
  }

  preflight(assignmentId: string, record = true): PreflightResult {
    const a = this.d.state.assignments[assignmentId];
    if (!a) throw new CommandError(`unknown assignment ${assignmentId}`, 404);
    const agent = this.d.state.agents[a.agentId];
    const active = Object.values(this.d.state.assignments).filter((x) => x.id !== a.id && x.position === 'now');
    const result = runPreflight({
      now: this.d.nowIso(),
      item: this.d.state.workItems[a.workItemId],
      assignment: a,
      agent:agent?{...agent,...sharedCapacity(this.d.state.agents,agent.id)}:agent,
      project: this.d.config.project,
      policies: this.d.config.policies,
      killSwitch: this.d.state.killSwitch.engaged,
      activeAssignments: active,
      binaryCheck: agent ? this.d.runs.binaryCheck(agent) : undefined,
      denylist: this.d.denylist(),
      spentTodayUsd: agent ? this.d.spentToday(agent.id) : 0,
      subscriptionConfirmation: agent ? this.d.subscriptionSafety.status(agent.id) : undefined,
      accountTerms: agent ? this.d.accounts.check(agent.id) : undefined,
      signature: agent ? this.d.accounts.signature(agent.id) : undefined,
    });
    if (record) this.d.commit([{ type: 'assignment.updated', assignmentId, agentId: a.agentId, workItemId: a.workItemId, data: { patch: { preflight: result } } }]);
    return result;
  }

  /**
   * Dispatch: Now if the agent is free (starts immediately), otherwise appended to its Next queue.
   * Pre-flight must pass to start; queued items are checked again when they're promoted.
   */
  async dispatch(assignmentId: string, o: { position?: 'now' | 'next'; actor?: Actor } = {}): Promise<{ started: boolean; queued: boolean; preflight: PreflightResult; runId?: string }> {
    const actor = o.actor ?? HUMAN;
    const a = this.d.state.assignments[assignmentId];
    if (!a) throw new CommandError(`unknown assignment ${assignmentId}`, 404);
    if (a.position === 'done' || a.position === 'canceled') throw new CommandError(`assignment is ${a.position}`, 409);
    if(this.d.state.agents[a.agentId]?.config.enabled===false) throw new CommandError('Enable this saved agent before dispatch.',412);
    // Never dispatch on guesses: probe login, billing and models first if we haven't yet.
    if (!this.d.state.agents[a.agentId].probedAt) await this.d.probe(a.agentId).catch(() => undefined);
    const agent = this.d.state.agents[a.agentId];
    const pf = this.preflight(assignmentId);
    const free = this.agentFree(agent.id) && agent.queue.now === null;
    if (o.position !== 'next' && free) {
      if (!pf.ok) throw new CommandError(`pre-flight failed: ${pf.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.message}`).join('; ')}`, 412);
      const runId = await this.d.runs.startAssignment(assignmentId, actor);
      return { started: true, queued: false, preflight: pf, runId };
    }
    // Queue as Next. "No issue, no dispatch" still applies when it's queued.
    if (!this.d.state.workItems[a.workItemId]?.key) throw new CommandError('issue is not in the tracker yet: no issue, no dispatch', 412);
    const next = agent.queue.next.filter((x) => x !== a.id).concat(a.id);
    // A queued reviewer leaves the issue where the author's work is (handoff received).
    const { events, outbox } = a.kind === 'review' ? { events: [], outbox: [] } : this.safeTransition(a.workItemId, 'assigned_next', `queued next for ${agent.config.name}`, actor);
    this.d.commit(
      [
        { type: 'assignment.positioned', actor, assignmentId: a.id, agentId: a.agentId, workItemId: a.workItemId, data: { position: 'next' } },
        { type: 'agent.queue_set', actor, agentId: agent.id, data: { now: agent.queue.now, next } },
        ...events,
      ],
      outbox,
    );
    void this.d.rules.refill(agent.id);
    return { started: false, queued: true, preflight: pf };
  }

  /**
   * Quick task from an agent's console: issue → tracker key → assignment → dispatch (Now if the
   * agent is free, else Next). Still "no issue, no dispatch": it waits for the tracker to confirm.
   */
  async quickTask(input: { agentId: string; title: string; description?: string; allowedPaths?: string[]; labels?: string[] }, actor: Actor = HUMAN) {
    if (!this.d.state.agents[input.agentId]) throw new CommandError(`unknown agent ${input.agentId}`, 404);
    const item = this.createIssue({ title: input.title, description: input.description, labels: input.labels ?? ['quick-task'] }, actor);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const w = this.d.state.workItems[item.id];
      if (w.key) break;
      if (w.sync.status === 'dry_run') throw new CommandError(`${this.d.tracker.target} is not live, so the issue can't be created there. Set tracker.live: true (or use the local tracker).`, 412);
      if (Date.now() > deadline) throw new CommandError(`the tracker hasn't confirmed the issue yet${w.sync.lastError ? `: ${w.sync.lastError}` : ''}`, 504);
      this.d.outbox.kick();
      await new Promise((r) => setTimeout(r, 100));
    }
    const a = this.createAssignment({ workItemId: item.id, agentId: input.agentId, allowedPaths: input.allowedPaths ?? [] }, actor);
    const r = await this.dispatch(a.id, { actor });
    return { item: this.d.state.workItems[item.id], assignment: this.d.state.assignments[a.id], ...r };
  }

  safeTransition(itemId: string, to: LifecycleState, reason: string, actor: Actor = SYSTEM, blockedOn?: WorkItem['blockedOn']): { events: NewEvent[]; outbox: OutboxOp[] } {
    try {
      return this.transition(itemId, to, reason, actor, blockedOn);
    } catch {
      return { events: [], outbox: [] };
    }
  }

  agentFree(agentId: string): boolean {
    const a = this.d.state.agents[agentId];
    if (!a) return false;
    const capacity=sharedCapacity(this.d.state.agents,a.id);
    return a.config.enabled!==false && a.activeRunIds.length < a.config.concurrency && !a.pausedReason && !capacity.limitedUntil && capacity.usage?.status!=='limited' && !capacity.usage?.windows.some(w=>w.usedPercent!==null&&w.usedPercent>=100);
  }

  /** Reorder an agent's Next queue, or move an assignment to another agent's queue. */
  setQueue(agentId: string, next: string[], actor: Actor = HUMAN): void {
    const agent = this.d.state.agents[agentId];
    if (!agent) throw new CommandError(`unknown agent ${agentId}`, 404);
    const events: NewEvent[] = [];
    const outbox: OutboxOp[] = [];
    for (const id of next) {
      const a = this.d.state.assignments[id];
      if (!a) throw new CommandError(`unknown assignment ${id}`, 404);
      if (a.position === 'now' || a.position === 'done' || a.position === 'canceled') throw new CommandError(`assignment ${id} is ${a.position}`, 409);
      if (a.agentId !== agentId) {
        if (a.kind === 'review' && a.review?.authorAgentId === agentId) throw new CommandError('the author cannot review their own work', 409);
        const from = this.d.state.agents[a.agentId];
        events.push({ type: 'agent.queue_set', actor, agentId: from.id, data: { now: from.queue.now, next: from.queue.next.filter((x) => x !== id) } });
        const patch = { agentId, prompt: '', promptEdited: false, skills: this.d.skillLib.freeze(agentId, a.workItemId) };
        const moved = { ...a, ...patch };
        patch.prompt = this.assignmentText(moved, isManualRelay(agent.config));
        events.push({ type: 'assignment.updated', actor, assignmentId: id, agentId, workItemId: a.workItemId, data: { patch: { ...patch, preflight: null, model: null } } });
      }
      if (a.position !== 'next') {
        events.push({ type: 'assignment.positioned', actor, assignmentId: id, agentId, workItemId: a.workItemId, data: { position: 'next' } });
        if (a.kind !== 'review') {
          const t = this.safeTransition(a.workItemId, 'assigned_next', `queued next for ${agent.config.name}`, actor);
          events.push(...t.events);
          outbox.push(...t.outbox);
        }
      }
    }
    events.push({ type: 'agent.queue_set', actor, agentId, data: { now: agent.queue.now, next } });
    this.d.commit(events, outbox);
    void this.d.rules.refill(agentId);
  }

  reassign(assignmentId: string, toAgentId: string, actor: Actor = HUMAN): void {
    const a = this.d.state.assignments[assignmentId];
    if (!a) throw new CommandError(`unknown assignment ${assignmentId}`, 404);
    if (a.position === 'now') {
      const run = this.d.runs.activeRunFor(assignmentId);
      if (run) throw new CommandError('stop the active run before reassigning', 409);
      const from = this.d.state.agents[a.agentId];
      this.d.commit([
        { type: 'agent.queue_set', actor, agentId: from.id, data: { now: null, next: from.queue.next } },
        { type: 'assignment.positioned', actor, assignmentId, agentId: a.agentId, workItemId: a.workItemId, data: { position: 'draft' } },
      ]);
      if (a.kind !== 'review') {
        const t = this.safeTransition(a.workItemId, 'selected', 'reassigned', actor);
        this.d.commit(t.events, t.outbox);
      }
    }
    const to = this.d.state.agents[toAgentId];
    if (!to) throw new CommandError(`unknown agent ${toAgentId}`, 404);
    if (a.kind === 'review' && a.review?.authorAgentId === toAgentId) throw new CommandError('the author cannot review their own work', 409);
    this.setQueue(toAgentId, [...to.queue.next.filter((x) => x !== assignmentId), assignmentId], actor);
    void this.d.rules.refill(a.agentId);
  }

  cancelAssignment(assignmentId: string, actor: Actor = HUMAN): void {
    const a = this.d.state.assignments[assignmentId];
    if (!a) throw new CommandError(`unknown assignment ${assignmentId}`, 404);
    if (this.d.runs.activeRunFor(assignmentId)) throw new CommandError('stop the active run first', 409);
    const agent = this.d.state.agents[a.agentId];
    this.d.commit([
      { type: 'assignment.positioned', actor, assignmentId, agentId: a.agentId, workItemId: a.workItemId, data: { position: 'canceled' } },
      { type: 'agent.queue_set', actor, agentId: agent.id, data: { now: agent.queue.now === assignmentId ? null : agent.queue.now, next: agent.queue.next.filter((x) => x !== assignmentId) } },
    ]);
  }
}
