// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Durable ordered release plans. Each step is bound to one human Decision.
// After that exact approval, a write runs once through the bounded runner.
// A restart marks an in-progress write uncertain and does not repeat it.
import path from 'node:path';
import fs from 'node:fs';
import type { Decision, IntegrationMerge, NewEvent, ReleaseAction, ReleasePlan, ReleaseStep, ReleaseStepKind } from '@acc/core';
import {
  HUMAN,
  IRREVERSIBLE_RELEASE_STEPS,
  RELEASE_STEP_KINDS,
  SYSTEM,
  checkRuntimeKey,
  canTransition,
  DEFAULT_TRACKER_CATEGORY,
  defaultReleaseSteps,
  newId,
  productionBranchOf,
  shellQuote,
} from '@acc/core';
import type { OutboxOp } from '../store/eventStore.ts';
import { CommandError, type Daemon } from '../daemon.ts';
import type { AnswerOptions } from '../decisions.ts';
import { runChecks } from '../checks.ts';
import { run } from '../exec.ts';
import { safeGitEnv } from '../adapters/vcs/git-policy.ts';
import { getSecret } from '../secrets.ts';
import { allowlistedPr, allowlistedPush, configuredCommand, executeReleaseStep, verifyReleaseStep, reviewedHost, isProtectedBranch, type ProjectCommandResult, type ReleaseCommandContext, type ReleaseExec, type StepRunResult, type VerificationRequest, type ReleaseProof } from './runner.ts';
import { sha256 } from '../util/hash.ts';

const KINDS = new Set<string>(RELEASE_STEP_KINDS);

interface StepDraft {
  id?: string;
  kind: ReleaseStepKind;
  title: string;
  owner: string;
  command: string;
  check: string;
  rollback: string;
  rollbackCheck?: string;
  target?: string;
  environment?: string;
}

type Phase = 'run' | 'rollback' | 'inspect';
const restores = (step: ReleaseStep, phase: Phase) => phase === 'rollback' || phase === 'inspect' && step.recoveryPhase === 'rollback';

export class ReleasePlans {
  readonly d: Daemon;
  projectCommand: (command: string, sha: string | null, verification?: VerificationRequest, context?: ReleaseCommandContext) => Promise<ProjectCommandResult>;
  exec: ReleaseExec;
  private busy = new Set<string>();

  constructor(d: Daemon) {
    this.d = d;
    this.projectCommand = (command, sha, verification) => this.runProject(command, sha, verification);
    this.exec = async (bin, args, opts) => {
      const digest = this.configHash();
      const h = reviewedHost(this.d.connectors.approvedReleaseConfig());
      if (!h || !this.d.egress.allowed.includes(h.apiHost)) throw new CommandError('The reviewed API host must be allowlisted.', 409);
      const id = opts?.decisionId;
      const decision = id ? this.d.state.decisions[id] : null;
      const receipt = id ? this.d.store.kvGet(`release:authorization:${id}`) : null;
      const authorization = receipt ? JSON.parse(receipt) : null;
      if (!decision?.answeredAt || decision.answeredBy?.type !== 'human' || decision.consumedAt || (this.d.decisions.needsConfirmation(decision, decision.answer!) && !decision.confirmedAt) || authorization?.status !== 'reserved' || authorization.action?.hash !== decision.action?.hash || authorization.answer !== decision.answer) throw new CommandError('A durable, confirmed exact release action is required for transport.', 409);
      const token = await getSecret(h.provider, this.d.baseEnv());
      if (!token || /[\r\n\0]/.test(token)) throw new CommandError('The activated code host has no usable connection token.', 409);
      this.d.addSecret(token);
      if (!opts?.cwd) throw new CommandError('An isolated transport directory is required.', 409);
      const home = path.dirname(opts.cwd);
      const env = safeGitEnv({ PATH: this.d.baseEnv().PATH ?? '', HOME: home, GH_CONFIG_DIR: path.join(home, 'gh'), GLAB_CONFIG_DIR: path.join(home, 'glab'), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
      if (bin === 'git') {
        // No secret in argv, config files or event history; this one header is scoped
        // to the exact reviewed HTTPS repository. Redirects and repo helpers are disabled.
        const credential = Buffer.from(`${h.provider === 'github' ? 'x-access-token' : 'oauth2'}:${token}`).toString('base64');
        this.d.addSecret(credential);
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = `http.${h.url}.extraHeader`;
        env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${credential}`;
      } else if (bin === 'gh') { env.GH_TOKEN = token; env.GH_HOST = h.host; }
      else if (bin === 'glab') { env.GITLAB_TOKEN = token; env.GITLAB_HOST = h.host; }
      else throw new CommandError('Unsupported release executable.', 409);
      if (this.d.closed || digest !== this.configHash()) throw new CommandError('Release configuration changed while preparing credentials.', 409);
      return run(bin, args, { cwd: opts?.cwd, input: opts?.input, timeoutMs: 60_000, maxBytes: 64_000, env });
    };
    this.recover();
  }

  list(): ReleasePlan[] {
    return Object.values(this.d.state.releases ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): ReleasePlan {
    const plan = this.d.state.releases?.[id];
    if (!plan) throw new CommandError(`unknown release plan ${id}`, 404);
    return plan;
  }

  create(input: { name?: string; workItemId?: string | null }): ReleasePlan {
    const name = input.name?.trim() || 'Release'.slice(0, 120);
    const bound = this.bindSha(input.workItemId ?? null);
    const now = this.d.nowIso();
    const branch = productionBranchOf(this.d.config.project);
    const cfg = this.d.connectors.approvedReleaseConfig().code_host;
    const sourceBranch = this.d.config.project.integration_branch;
    const host = cfg?.provider === 'github' ? (cfg.host === 'api.github.com' || !cfg.host ? 'github.com' : cfg.host) : cfg?.host ?? 'gitlab.com';
    const repo = cfg?.provider === 'github' ? cfg.repo : cfg?.project;
    const source = { branch: sourceBranch, push: cfg && repo && bound.sha ? allowlistedPush(cfg.provider, repo, sourceBranch, bound.sha, host) : 'configure:push', pr: cfg && repo ? allowlistedPr(cfg.provider, `${host}/${repo}`, branch, sourceBranch, 'Pull request') : 'configure:pr' };
    const steps = defaultReleaseSteps(branch, bound.sha, this.environment(), source).map((row) => ({
      ...row,
      id: newId('step'),
      decisionId: null,
      approval: 'pending' as const,
      status: 'pending' as const,
      evidence: null,
      checkedAt: null,
    }));
    const plan: ReleasePlan = {
      id: newId('plan'),
      name,
      status: 'active',
      productionBranch: branch,
      sha: bound.sha,
      workItemId: bound.workItemId,
      mergeId: bound.mergeId,
      steps,
      createdAt: now,
      updatedAt: now,
    };
    this.d.commit([{ type: 'release.saved', actor: HUMAN, workItemId: plan.workItemId, data: { plan } }]);
    return this.get(plan.id);
  }

  update(id: string, input: { name?: string; workItemId?: string | null; steps?: StepDraft[] }): ReleasePlan {
    const plan = this.get(id);
    if (plan.status !== 'active') throw new CommandError(`this release is ${plan.status}`, 409);
    this.assertIdle(plan);
    const drafts = (input.steps ? input.steps.map((row) => normalizeDraft(row, this.environment())) : plan.steps.map((step) => normalizeDraft(toDraft(step), this.environment())));
    if (drafts.length < 1 || drafts.length > 30) throw new CommandError('a release plan needs between 1 and 30 steps');
    const bound = this.bindSha(input.workItemId === undefined ? plan.workItemId : input.workItemId);
    const shaChanged = (bound.sha ?? null) !== (plan.sha ?? null) || bound.workItemId !== plan.workItemId || bound.mergeId !== plan.mergeId;
    let blocked = shaChanged;
    const drop: string[] = [];
    const seen = new Set<string>();
    const steps: ReleaseStep[] = drafts.map((draft, order) => {
      if (draft.id && seen.has(draft.id)) throw new CommandError('duplicate step id');
      if (draft.id) seen.add(draft.id);
      const prev = draft.id ? plan.steps.find((s) => s.id === draft.id) : undefined;
      const materialChanged = !prev || prev.kind !== draft.kind || prev.command !== draft.command || prev.target !== draft.target || prev.environment !== draft.environment || prev.rollback !== draft.rollback || prev.rollbackCheck !== draft.rollbackCheck || prev.check !== draft.check || prev.order !== order || (prev.kind === 'pr' && prev.title !== draft.title);
      if (prev && !blocked && !materialChanged) return { ...prev, order, title: draft.title, owner: draft.owner };
      blocked = true;
      if (prev?.decisionId) drop.push(prev.decisionId);
      return {
        id: prev?.id ?? newId('step'),
        order,
        kind: draft.kind,
        title: draft.title,
        owner: draft.owner,
        target: draft.target,
        environment: draft.environment,
        command: draft.command,
        check: draft.check,
        rollback: draft.rollback,
        rollbackCheck: draft.rollbackCheck,
        decisionId: null,
        approval: 'pending',
        status: 'pending',
        evidence: null,
        checkedAt: null,
      };
    });
    const still = steps.filter((s) => s.status === 'approved').map((s) => s.id);
    const previous = plan.steps.filter((s) => s.status === 'approved').map((s) => s.id);
    if (still.length !== previous.length || still.some((stepId, index) => previous[index] !== stepId)) throw new CommandError('Approved steps stay at the front, in order. They cannot be skipped, removed or reordered.', 409);
    // Include removed rows and rollback/inspection decisions, which need not be on step.decisionId.
    for (const dec of Object.values(this.d.state.decisions)) {
      const action = dec.action;
      if (!action || !('planId' in action) || action.planId !== plan.id || dec.answeredAt || dec.consumedAt) continue;
      const nextStep = steps.find(s => s.id === action.stepId);
      if (!nextStep || nextStep.status === 'pending' && !nextStep.decisionId) drop.push(dec.id);
    }
    const next: ReleasePlan = { ...plan, name: input.name !== undefined ? input.name.trim().slice(0, 120) : plan.name, ...bound, steps, updatedAt: this.d.nowIso() };
    if (!next.name) throw new CommandError('a release plan needs a name');
    const events: NewEvent[] = [{ type: 'release.saved', actor: HUMAN, workItemId: next.workItemId, data: { plan: next } }];
    for (const decisionId of new Set(drop)) {
      const dec = this.d.state.decisions[decisionId];
      if (dec && !dec.consumedAt && !dec.answeredAt) events.push({ type: 'decision.consumed', actor: HUMAN, workItemId: dec.workItemId ?? null, data: { decisionId, outcome: 'invalidated: the release step changed' } });
    }
    this.d.commit(events, [], () => {
      for (const decisionId of new Set(drop)) {
        this.d.store.kvDelete(`release:${decisionId}`);
        this.d.store.kvDelete(`release-rollback:${decisionId}`);
        this.d.store.kvDelete(`release-inspect:${decisionId}`);
      }
    });
    return this.get(id);
  }

  cancel(id: string): ReleasePlan {
    const plan = this.get(id);
    if (plan.status !== 'active') return plan;
    this.assertIdle(plan);
    this.assertNoOpenDecision(plan);
    const next = { ...plan, status: 'canceled' as const, updatedAt: this.d.nowIso() };
    this.save(next, HUMAN);
    return this.get(id);
  }

  requestStep(planId: string, stepId: string): { decision: Decision; plan: ReleasePlan } {
    const plan = this.get(planId);
    if (plan.status !== 'active') throw new CommandError(`this release is ${plan.status}`, 409);
    const step = this.current(plan);
    if (step.id !== stepId) throw new CommandError(`Step “${step.title}” is next. Later steps cannot be skipped.`, 409);
    if (step.status === 'uncertain') throw new CommandError('This step was interrupted and needs inspection. It will not be run again.', 409);
    if (step.status === 'running') throw new CommandError('This step is already writing.', 409);
    return this.openDecision(plan, step, 'run');
  }

  requestRollback(planId: string, stepId: string): { decision: Decision; plan: ReleasePlan } {
    const plan = this.get(planId);
    if (plan.status !== 'active') throw new CommandError(`this release is ${plan.status}`, 409);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new CommandError('that step is no longer on the plan', 404);
    if (step.status !== 'failed') throw new CommandError('Rollback needs its own approval after the step has failed.', 409);
    return this.openDecision(plan, step, 'rollback');
  }

  requestInspection(planId: string, stepId: string): { decision: Decision; plan: ReleasePlan } {
    const plan = this.get(planId);
    if (plan.status !== 'active') throw new CommandError(`this release is ${plan.status}`, 409);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new CommandError('that step is no longer on the plan', 404);
    if (step.status !== 'uncertain') throw new CommandError('Only an interrupted write can be inspected.', 409);
    return this.openDecision(plan, step, 'inspect');
  }

  async resolve(decisionId: string, answer: string, o: AnswerOptions = {}) {
    if (this.busy.has(decisionId)) throw new CommandError('This approval is already being resolved.', 409);
    this.busy.add(decisionId);
    try {
      const found = this.binding(decisionId);
      const decision = this.d.state.decisions[decisionId];
      if (!found || !decision || decision.kind !== 'release' || !decision.action || !decision.action.kind.startsWith('release')) throw new CommandError('The release binding is missing; request a fresh approval', 409);
      const plan = this.get(found.binding.planId);
      const step = plan.steps.find((s) => s.id === found.binding.stepId);
      if (!step) throw new CommandError('that step is no longer on the plan', 409);
      if (decision.answeredAt || decision.consumedAt) throw new CommandError('This release decision was already answered; it cannot execute again.', 409);
      if (plan.status !== 'active') throw new CommandError(`this release is ${plan.status}`, 409);
      if (found.phase === 'run' && this.current(plan).id !== step.id) throw new CommandError('this step is no longer the next step', 409);
      this.assertCurrentBinding(plan, step, decision, found.phase);
      if (plan.steps.some(s => s.status === 'running')) throw new CommandError('This release already has an in-flight action.', 409);
      if (found.phase === 'run' && step.status === 'uncertain') throw new CommandError('This step was interrupted and needs inspection. It will not be run again.', 409);
      if (found.phase === 'inspect') return await this.finishInspect(decisionId, plan, step, answer, o);
      if (answer !== 'approve' && answer !== 'reject') throw new CommandError('choose approve or reject');
      if (found.phase === 'rollback' && step.status !== 'failed') throw new CommandError('Rollback is only available for a failed step.', 409);
      if (answer === 'reject') return this.finish(decisionId, plan, step, 'reject', { executed: false, ok: false, exitCode: null, attestation: null, summary: `The owner rejected this step. Rollback: ${step.rollback}` }, o, found.phase);
      if (found.phase === 'rollback') return await this.finishRollback(decisionId, plan, step, o);
      const gate = this.gate(plan, step);
      if (!gate.allow && !gate.record) throw new CommandError(gate.reason, 409);
      // ANSWER, exact authorization and the in-flight reservation commit together.
      // Nothing below can dispatch before that durable transaction succeeds.
      const current = this.beginWrite(decisionId, plan, step, o, 'run');
      const execution = this.execution(decisionId, current, step, step.command, 'run');
      let outcome: StepRunResult;
      if (!gate.allow) outcome = { executed: false, ok: false, exitCode: null, attestation: null, summary: `${gate.reason} Rollback: ${step.rollback}` };
      else {
        try { outcome = await executeReleaseStep(execution); }
        catch (e) { outcome = { executed: execution.wasDispatched(), ok: execution.wasDispatched() ? null : false, uncertain: execution.wasDispatched(), exitCode: null, attestation: null, summary: `${execution.wasDispatched() ? 'Execution was interrupted or its result is unknown.' : 'Refused before action dispatch.'} ${(e as Error).message} Rollback: ${step.rollback}` }; }
      }
      if (this.d.closed) return { planId: current.id, stepId: step.id, status: 'running' as const, executed: execution.wasDispatched(), evidence: { summary: 'The daemon stopped during execution; the reserved action will not be replayed.', ok: null, attestation: null, exitCode: null } };
      return this.finish(decisionId, current, step, 'approve', outcome, o, 'run');
    } finally {
      this.busy.delete(decisionId);
    }
  }

  private async finishRollback(decisionId: string, plan: ReleasePlan, step: ReleaseStep, o: AnswerOptions) {
    const current = this.beginWrite(decisionId, plan, step, o, 'rollback');
    const execution = this.execution(decisionId, current, step, step.rollback, 'rollback');
    let outcome: StepRunResult;
    try {
      outcome = await executeReleaseStep(execution);
    } catch (e) {
      outcome = { executed: execution.wasDispatched(), ok: execution.wasDispatched() ? null : false, uncertain: execution.wasDispatched(), exitCode: null, attestation: null, summary: (e as Error).message };
    }
    if (this.d.closed) return { planId: current.id, stepId: step.id, status: 'running' as const, executed: execution.wasDispatched(), evidence: { summary: 'The daemon stopped while rollback was writing.', ok: null, attestation: null, exitCode: null } };
    const summary = outcome.executed ? `Rollback ran. ${outcome.summary}` : `Rollback was not executed. ${outcome.summary}`;
    return this.finish(decisionId, current, step, 'approve', { ...outcome, summary }, o, 'rollback');
  }

  private async finishInspect(decisionId: string, plan: ReleasePlan, step: ReleaseStep, answer: string, o: AnswerOptions) {
    if (answer !== 'attested' && answer !== 'failed') throw new CommandError('choose attested or failed');
    const current = this.beginWrite(decisionId, plan, step, o, 'inspect', answer);
    let outcome: StepRunResult = { executed: false, ok: false, exitCode: null, attestation: 'human', summary: `Human attestation: inspection recorded; no interrupted action was replayed. Rollback: ${step.rollback}` };
    if (answer === 'attested') {
      try {
        const mode = step.recoveryPhase ?? 'run';
        const verified = await verifyReleaseStep(this.execution(decisionId, current, step, mode === 'rollback' ? step.rollback : step.command, mode));
        outcome = { ...verified, ok: verified.ok === true ? true : null, uncertain: verified.ok !== true, attestation: 'human', summary: `Human requested inspection without replay. ${verified.summary}` };
      } catch (e) { outcome = { ...outcome, ok: null, uncertain: true, summary: `${outcome.summary} Verification unavailable: ${(e as Error).message}` }; }
    }
    if (this.d.closed) return { planId: current.id, stepId: step.id, status: 'running' as const, executed: false, evidence: { summary: 'Inspection was interrupted; it cannot replay the original action.', ok: null, attestation: 'human' as const, exitCode: null } };
    return this.finish(decisionId, current, step, answer, outcome, o, 'inspect');
  }

  private finish(decisionId: string, plan: ReleasePlan, step: ReleaseStep, answer: string, outcome: StepRunResult, o: AnswerOptions, phase: Phase) {
    const checkedAt = this.d.nowIso();
    const approved = (phase === 'run' && answer === 'approve' && outcome.ok === true) || (phase === 'inspect' && step.recoveryPhase !== 'rollback' && answer === 'attested' && outcome.ok === true);
    const status = outcome.uncertain ? 'uncertain' as const : approved ? 'approved' as const : 'failed' as const;
    const evidence = { summary: this.d.redactText(outcome.summary).slice(0, 2000), ok: outcome.ok, attestation: outcome.attestation, exitCode: outcome.exitCode, proof: outcome.proof ? { ...outcome.proof, detail: this.d.redactText(outcome.proof.detail).slice(0, 2000), artifact: outcome.proof.artifact ? this.d.redactText(outcome.proof.artifact).slice(0, 1000) : undefined } : undefined };
    const steps = plan.steps.map((s) => s.id === step.id ? { ...s, recoveryPhase: outcome.uncertain ? (phase === 'rollback' ? 'rollback' as const : step.recoveryPhase ?? 'run' as const) : undefined, approval: approved ? 'approved' as const : 'denied' as const, status, evidence, checkedAt } : s);
    const done = steps.every((s) => s.status === 'approved');
    const next: ReleasePlan = { ...plan, steps, status: done ? 'completed' : 'active', updatedAt: checkedAt };
    const saved = steps.find((s) => s.id === step.id)!;
    const outbox: OutboxOp[] = plan.workItemId ? [{ workItemId: plan.workItemId, op: 'comment', payload: { body: releaseComment(next, saved) } }] : [];
    const prefix = phase === 'rollback' ? 'release-rollback:' : phase === 'inspect' ? 'release-inspect:' : 'release:';
    const events: NewEvent[] = [{ type: 'release.saved', actor: HUMAN, workItemId: plan.workItemId, data: { plan: next } }, { type: 'decision.consumed', actor: HUMAN, workItemId: plan.workItemId, data: { decisionId, outcome: `${phase}: ${status}` } }];
    if (approved) {
      const completion = this.completion(next);
      events.push(...completion.events);
      outbox.push(...completion.outbox);
    }
    if (restores(step, phase) && outcome.ok === true && plan.workItemId) {
      const item = this.d.state.workItems[plan.workItemId];
      if (item?.state === 'deployed') {
        events.push({ type: 'work_item.transitioned', actor: HUMAN, workItemId: item.id, data: { from: 'deployed', to: 'release_candidate', reason: 'Release rollback verified; deployment acceptance needs fresh verification.', blockedOn: null } });
        outbox.push({ workItemId: item.id, op: 'set_status', payload: { category: DEFAULT_TRACKER_CATEGORY.release_candidate, lifecycle: 'release_candidate' } });
      }
    }
    const transaction = () => {
      this.d.store.kvDelete(`${prefix}${decisionId}`);
      this.d.store.kvDelete(`release:inflight:${decisionId}`);
      const receipt = this.d.store.kvGet(`release:authorization:${decisionId}`);
      if (receipt) this.d.store.kvSet(`release:authorization:${decisionId}`, JSON.stringify({ ...JSON.parse(receipt), status: 'settled', checkedAt }));
    };
    // The answer was already written before execution. A rejection has no side effect.
    if (this.d.state.decisions[decisionId]?.answeredAt) this.d.commit(events, outbox, transaction);
    else this.d.decisions.answerAtomic(decisionId, answer, o, HUMAN, events, transaction, outbox);
    this.d.outbox.kick();
    return { planId: next.id, stepId: step.id, status, executed: outcome.executed, evidence };
  }

  private openDecision(plan: ReleasePlan, step: ReleaseStep, phase: Phase): { decision: Decision; plan: ReleasePlan } {
    if (plan.steps.some(s => s.status === 'running')) throw new CommandError('This release already has an in-flight action.', 409);
    const prefix = phase === 'rollback' ? 'release-rollback:' : phase === 'inspect' ? 'release-inspect:' : 'release:';
    const kind: ReleaseAction['kind'] = phase === 'rollback' ? 'release_rollback' : phase === 'inspect' ? 'release_inspect' : 'release';
    const superseded: string[] = [];
    for (const open of Object.values(this.d.state.decisions)) {
      if (!open.action || !('planId' in open.action) || open.action.planId !== plan.id || open.action.stepId !== step.id || open.answeredAt || open.consumedAt) continue;
      if (open.action.kind === kind && open.action.hash === this.hash(plan, step, kind) && this.binding(open.id)) return { decision: open, plan };
      superseded.push(open.id);
    }
    const command = restores(step, phase) ? step.rollback : step.command;
    const hash = this.hash(plan, step, kind);
    const irreversible = phase === 'rollback' || (phase === 'run' && (IRREVERSIBLE_RELEASE_STEPS.includes(step.kind) || step.command.startsWith('check:')));
    const action: ReleaseAction = { kind, planId: plan.id, stepId: step.id, stepKind: step.kind, command, target: step.target, environment: step.environment, sha: plan.sha, hash, configHash: this.configHash() };
    const decision = this.d.decisions.createBound({
      question: phase === 'inspect' ? `Inspect interrupted step ${step.order + 1}. ${step.title}? The command will not be run again.` : phase === 'rollback' ? `Run the rollback for “${step.title}”?` : `Approve release step ${step.order + 1}. ${step.title}?`,
      options: phase === 'inspect' ? ['attested', 'failed'] : ['approve', 'reject'],
      recommendation: null,
      evidence: this.evidence(plan, step, phase),
      urgency: irreversible ? 'high' : 'normal',
      irreversible,
      kind: 'release',
      workItemId: plan.workItemId,
      risk: irreversible ? 'high' : 'medium',
      action,
      confirmOptions: irreversible ? ['approve'] : [],
    }, HUMAN, (id) => {
      const events: NewEvent[] = [];
      for (const id of superseded) events.push({ type: 'decision.consumed', actor: HUMAN, workItemId: plan.workItemId, data: { decisionId: id, outcome: 'invalidated: release action changed' } });
      if (phase === 'run') events.push({ type: 'release.saved', actor: HUMAN, workItemId: plan.workItemId, data: { plan: { ...plan, steps: plan.steps.map(s => s.id === step.id ? { ...s, decisionId: id, approval: 'pending' as const } : s), updatedAt: this.d.nowIso() } } });
      return events;
    }, (id) => {
      for (const id of superseded) for (const key of ['release:', 'release-rollback:', 'release-inspect:']) this.d.store.kvDelete(`${key}${id}`);
      this.d.store.kvSet(`${prefix}${id}`, JSON.stringify({ planId: plan.id, stepId: step.id, hash, phase }));
    });
    return { decision: this.d.state.decisions[decision.id], plan: this.get(plan.id) };
  }

  private beginWrite(decisionId: string, plan: ReleasePlan, step: ReleaseStep, o: AnswerOptions, phase: Phase, answer = 'approve'): ReleasePlan {
    if (this.d.store.kvGet(`release:authorization:${decisionId}`)) throw new CommandError('This exact action was already reserved. It cannot be replayed.', 409);
    const recoveryPhase = phase === 'inspect' ? step.recoveryPhase ?? 'run' : phase;
    const steps = plan.steps.map(s => s.id === step.id ? { ...s, decisionId, recoveryPhase, status: 'running' as const } : s);
    const next = { ...plan, steps, updatedAt: this.d.nowIso() };
    const action = this.d.state.decisions[decisionId].action;
    this.d.decisions.answerAtomic(decisionId, answer, o, HUMAN, [{ type: 'release.saved', actor: HUMAN, workItemId: plan.workItemId, data: { plan: next } }], () => {
      this.d.store.kvSet(`release:authorization:${decisionId}`, JSON.stringify({ action, phase, verificationPhase: recoveryPhase, answer, authorizedAt: this.d.nowIso(), status: 'reserved' }));
      this.d.store.kvSet(`release:inflight:${decisionId}`, JSON.stringify({ planId: plan.id, stepId: step.id, phase }));
    });
    return this.get(plan.id);
  }

  private execution(decisionId: string, plan: ReleasePlan, step: ReleaseStep, command: string, mode: 'run' | 'rollback') {
    const config = this.d.connectors.approvedReleaseConfig();
    let dispatched = false;
    const guard = () => {
      if (this.d.closed) throw new CommandError('Daemon stopped; no further release operation may start.', 409);
      const decision = this.d.state.decisions[decisionId];
      const found = this.binding(decisionId);
      const raw = this.d.store.kvGet(`release:authorization:${decisionId}`);
      const receipt = raw ? JSON.parse(raw) : null;
      if (!found || !decision?.answeredAt || decision.answeredBy?.type !== 'human' || decision.consumedAt || receipt?.status !== 'reserved' || receipt.action?.hash !== decision.action?.hash || receipt.answer !== decision.answer) throw new CommandError('Durable release authorization is missing or consumed.', 409);
      this.assertCurrentBinding(this.get(plan.id), step, decision, found.phase);
      if (this.get(plan.id).steps.find(s => s.id === step.id)?.status !== 'running') throw new CommandError('The action is no longer reserved.', 409);
    };
    return { step, plan, config, command, mode, guard, wasDispatched: () => dispatched,
      authorizeRead: (capability: Parameters<NonNullable<ReturnType<Daemon['connectors']['releaseAccess']>>['authorize']>[0]) => {
        const h = reviewedHost(config);
        const access = h ? this.d.connectors.releaseAccess(h.provider) : null;
        if (!access) throw new CommandError('The approved release read connection is unavailable.', 409);
        access.authorize(capability);
      },
      exec: async (...args: Parameters<ReleaseExec>) => { guard(); const [bin, argv, opts] = args; if (argv.includes('push') || argv.includes('create')) dispatched = true; const result = await this.exec(bin, argv, { ...opts, decisionId }); guard(); return result; },
      project: async (cmd: string, verification?: VerificationRequest) => { guard(); if (!verification) dispatched = true; const context: ReleaseCommandContext = { decisionId, planId: plan.id, stepId: step.id, kind: step.kind, target: step.target, environment: step.environment, phase: mode, configHash: this.configHash() }; const result = await this.projectCommand(cmd, plan.sha, verification, context); guard(); return result; },
    };
  }

  private assertIdle(plan: ReleasePlan): void {
    if (plan.steps.some(s => s.status === 'running')) throw new CommandError('An in-flight release cannot be edited or canceled.', 409);
    if (plan.steps.some(s => s.status === 'uncertain')) throw new CommandError('Inspect an interrupted action before editing its release.', 409);
  }

  /** Candidate/deployed progress reflects verified steps. Done additionally needs the
   * entire plan and acceptance for this exact merge, never a passive READY snapshot. */
  private completion(plan: ReleasePlan): { events: NewEvent[]; outbox: OutboxOp[] } {
    const item = plan.workItemId ? this.d.state.workItems[plan.workItemId] : undefined;
    const merge = plan.mergeId ? this.d.state.merges[plan.mergeId] : undefined;
    if (!item || !merge || merge.mergeSha !== plan.sha || merge.postChecks.status !== 'passed' || !['merged', 'release_candidate', 'deployed'].includes(item.state)) return { events: [], outbox: [] };
    const proven = (kind: ReleaseStepKind) => plan.steps.find(s => s.kind === kind && s.status === 'approved' && s.evidence?.proof?.sha === plan.sha && s.evidence.proof.environment === s.environment && s.evidence.proof.phase === 'run' && s.evidence.proof.ok);
    const deploy = proven('deploy')?.evidence?.proof;
    const routes = proven('verify_routes')?.evidence?.proof;
    const device = proven('device_qa')?.evidence?.proof;
    const deployed = deploy?.source === 'probe' && ['local', 'production'].includes(deploy.acceptanceEnvironment ?? '');
    const routeVerified = routes?.source === 'probe' && routes.acceptanceEnvironment === deploy?.acceptanceEnvironment;
    const env = deploy?.acceptanceEnvironment === 'production' && routes?.acceptanceEnvironment === 'production' ? 'production' as const
      : device?.source === 'real_device' && device.acceptanceEnvironment === 'device' && device.artifact ? 'device' as const : 'local' as const;
    const exactMerge = item.evidence.some(e => e.kind === 'merge' && e.sha === plan.sha && e.verified);
    const done = plan.status === 'completed' && deployed && routeVerified && exactMerge && (!item.requiresProductionVerification || env !== 'local');
    const evidence = { id: newId('evd'), kind: 'acceptance' as const, summary: `Human-approved release ${plan.id}: deployment, routes and ordered checks freshly verified at ${plan.sha} (${env}).`, sha: plan.sha!, branch: merge.target, env, verified: true, at: this.d.nowIso() };
    const events: NewEvent[] = [];
    const outbox: OutboxOp[] = [];
    let from = item.state;
    const targets = ['release_candidate', ...(deployed ? ['deployed'] as const : []), ...(done ? ['verified'] as const : [])] as const;
    for (const to of targets) {
      if (from === to || (from === 'deployed' && to === 'release_candidate')) continue;
      const proof = done ? [...item.evidence, evidence] : item.evidence;
      if (!canTransition(from, to, { evidence: proof, requiresProductionVerification: item.requiresProductionVerification }).ok) break;
      if (to === 'verified') events.push({ type: 'work_item.evidence_added', actor: HUMAN, workItemId: item.id, data: { evidence } });
      events.push({ type: 'work_item.transitioned', actor: HUMAN, workItemId: item.id, data: { from, to, reason: to === 'verified' ? evidence.summary : `Release ${plan.id}: ${to === 'deployed' ? 'fresh deployment proof' : 'approved ordered release started'} at ${plan.sha}.`, blockedOn: null } });
      from = to;
    }
    if (events.length) outbox.push({ workItemId: item.id, op: 'set_status', payload: { category: DEFAULT_TRACKER_CATEGORY[from], lifecycle: from } });
    return { events, outbox };
  }

  private recover(): void {
    const raw = this.d.store.kvGet('release:inflight');
    let inflight: { planId?: string; stepId?: string } | null = null;
    if (raw) {
      try {
        inflight = JSON.parse(raw) as { planId?: string; stepId?: string };
      } catch {
        inflight = {};
      }
    }
    const events: NewEvent[] = [];
    const interrupted: string[] = [];
    for (const plan of Object.values(this.d.state.releases ?? {})) {
      let touched = false;
      const steps = plan.steps.map((s) => {
        const marked = s.status === 'running' || (inflight?.planId === plan.id && inflight?.stepId === s.id && s.status !== 'approved' && s.status !== 'failed' && s.status !== 'uncertain');
        if (!marked) return s;
        touched = true;
        if (s.decisionId) {
          interrupted.push(s.decisionId);
          events.push({ type: 'decision.consumed', actor: SYSTEM, workItemId: plan.workItemId, data: { decisionId: s.decisionId, outcome: 'interrupted: inspect without replay' } });
        }
        const receipt = s.decisionId ? this.d.store.kvGet(`release:authorization:${s.decisionId}`) : null;
        let recoveryPhase = s.recoveryPhase ?? 'run';
        try { const value = receipt ? JSON.parse(receipt) : null; if (value?.verificationPhase === 'rollback' || value?.phase === 'rollback') recoveryPhase = 'rollback'; } catch { /* preserve conservative reservation */ }
        return { ...s, recoveryPhase, status: 'uncertain' as const, evidence: { summary: 'This step was writing when One Connect restarted. It was not run again. A person has to inspect it.', ok: null, attestation: null, exitCode: null }, checkedAt: this.d.nowIso() };
      });
      if (touched) events.push({ type: 'release.saved', actor: SYSTEM, workItemId: plan.workItemId, data: { plan: { ...plan, steps, updatedAt: this.d.nowIso() } } });
    }
    if (!events.length && !raw) return;
    this.d.commit(events, [], () => {
      if (raw) this.d.store.kvDelete('release:inflight');
      for (const id of interrupted) {
        this.d.store.kvDelete(`release:inflight:${id}`);
        for (const prefix of ['release:', 'release-rollback:', 'release-inspect:']) this.d.store.kvDelete(`${prefix}${id}`);
        const receipt = this.d.store.kvGet(`release:authorization:${id}`);
        if (receipt) this.d.store.kvSet(`release:authorization:${id}`, JSON.stringify({ ...JSON.parse(receipt), status: 'uncertain' }));
      }
    });
  }

  private binding(decisionId: string): { phase: Phase; binding: { planId: string; stepId: string; hash: string } } | null {
    const run = this.d.store.kvGet(`release:${decisionId}`);
    const rollback = this.d.store.kvGet(`release-rollback:${decisionId}`);
    const inspect = this.d.store.kvGet(`release-inspect:${decisionId}`);
    const raw = run ?? rollback ?? inspect;
    if (!raw) return null;
    const phase: Phase = rollback ? 'rollback' : inspect ? 'inspect' : 'run';
    return { phase, binding: JSON.parse(raw) as { planId: string; stepId: string; hash: string } };
  }

  private assertCurrentBinding(plan: ReleasePlan, step: ReleaseStep, decision: Decision, phase: Phase): void {
    // Recovery inspects/restores the original recorded effect even when newer work
    // has merged. A new forward write always requires the latest source binding.
    const original = plan.mergeId ? this.d.state.merges[plan.mergeId] : undefined;
    const live = phase === 'run' ? this.bindSha(plan.workItemId) : { sha: original?.mergeSha ?? null, mergeId: original?.id ?? null, workItemId: original?.workItemId ?? null };
    if ((live.sha ?? null) !== (plan.sha ?? null) || live.mergeId !== plan.mergeId || live.workItemId !== plan.workItemId) throw new CommandError('The source SHA or merge binding changed; request a fresh decision', 409);
    if (this.environment() !== step.environment) throw new CommandError('The environment changed; request a fresh decision', 409);
    if (decision.action?.kind?.startsWith('release') && 'configHash' in decision.action && decision.action.configHash !== this.configHash()) throw new CommandError('The reviewed configuration, host/repo, checks or protection policy changed; request a fresh decision', 409);
    const kind: ReleaseAction['kind'] = phase === 'rollback' ? 'release_rollback' : phase === 'inspect' ? 'release_inspect' : 'release';
    const hash = this.hash(plan, step, kind);
    const bound = this.binding(decision.id);
    const action = decision.action;
    if (!action || !('planId' in action) || action.kind !== kind || action.planId !== plan.id || action.stepId !== step.id || action.stepKind !== step.kind || action.command !== (restores(step, phase) ? step.rollback : step.command) || action.target !== step.target || action.environment !== step.environment || action.sha !== plan.sha || hash !== action.hash || bound?.binding.hash !== hash) throw new CommandError('the step changed; request a fresh decision', 409);
  }

  private current(plan: ReleasePlan): ReleaseStep {
    const step = plan.steps.find((s) => s.status !== 'approved');
    if (!step) throw new CommandError('every step on this release is already approved', 409);
    return step;
  }

  private hash(plan: ReleasePlan, step: ReleaseStep, kind: ReleaseAction['kind']): string {
    const phase = kind === 'release_rollback' ? 'rollback' : kind === 'release_inspect' ? 'inspect' : 'run';
    return sha256(JSON.stringify({ kind, planId: plan.id, workItemId: plan.workItemId, mergeId: plan.mergeId, stepId: step.id, stepKind: step.kind, command: restores(step, phase) ? step.rollback : step.command, target: step.target, environment: step.environment, check: step.check, rollback: step.rollback, rollbackCheck: step.rollbackCheck, recoveryPhase: kind === 'release_inspect' ? step.recoveryPhase ?? 'run' : null, sha: plan.sha, order: step.order, configHash: this.configHash(), productionBranch: plan.productionBranch, title: step.kind === 'pr' ? step.title : null }));
  }

  private configHash(): string {
    return sha256(JSON.stringify([this.d.config, this.d.connectors.approvedReleaseConfig(), Object.values(this.d.state.connectors ?? {}).filter(c => ['github', 'gitlab', 'vercel', 'supabase'].includes(c.kind)).map(c => ({ id: c.id, configHash: c.configHash, disabled: c.disabled, approvals: c.approvals }))]));
  }

  private environment(): string {
    return checkRuntimeKey(this.d.config.project.check_runtime) ?? 'unconfigured';
  }

  private bindSha(workItemId: string | null): { sha: string | null; workItemId: string | null; mergeId: string | null } {
    if (workItemId && !this.d.state.workItems[workItemId]) throw new CommandError(`unknown work item ${workItemId}`, 404);
    if (!workItemId) return { sha: null, workItemId: null, mergeId: null };
    const merge = latestMerge(this.d, workItemId);
    if (!merge) return { sha: null, workItemId, mergeId: null };
    return { sha: merge.mergeSha, workItemId: merge.workItemId, mergeId: merge.id };
  }

  private evidence(plan: ReleasePlan, step: ReleaseStep, phase: Phase): { label: string; detail: string; ok?: boolean | null }[] {
    const rows: { label: string; detail: string; ok?: boolean | null }[] = [
      { label: 'Command', detail: restores(step, phase) ? step.rollback : step.command, ok: null },
      { label: 'Target', detail: step.target, ok: null },
      { label: 'Environment', detail: step.environment, ok: null },
      { label: 'Check', detail: restores(step, phase) ? step.rollbackCheck ?? 'Not configured' : step.check, ok: null },
      { label: 'Rollback', detail: step.rollback, ok: null },
      { label: 'Rollback check', detail: step.rollbackCheck ?? 'Not configured; no rollback command can run.', ok: null },
    ];
    const actionCommand = configuredCommand(restores(step, phase) ? step.rollback : step.command, this.d.connectors.approvedReleaseConfig());
    const verificationCommand = configuredCommand(restores(step, phase) ? step.rollbackCheck ?? '' : step.check, this.d.connectors.approvedReleaseConfig());
    if (actionCommand) rows.push({ label: 'Configured action', detail: actionCommand, ok: null });
    if (verificationCommand) rows.push({ label: 'Configured verification', detail: verificationCommand, ok: null });
    const h = reviewedHost(this.d.connectors.approvedReleaseConfig());
    if (h) rows.push({ label: 'Reviewed code host', detail: `${h.provider}: ${h.url}; API ${h.apiHost}; base ${plan.productionBranch}; SHA ${plan.sha ?? 'unbound'}`, ok: null });
    if (step.kind === 'device_qa' || phase === 'inspect') rows.push({ label: 'Verification', detail: 'A fresh exact probe is required. Human attestation alone cannot pass this step or replace device evidence.', ok: null });
    if (step.kind === 'push') rows.push({ label: 'Push', detail: isProtectedBranch(step.target, plan, this.d.config.project) ? 'This target is a production or protected branch. The push will be refused.' : 'The exact SHA is uploaded with Git using the reviewed HTTPS repository; a fresh remote read must match.', ok: isProtectedBranch(step.target, plan, this.d.config.project) ? false : null });
    const merge = plan.mergeId ? this.d.state.merges[plan.mergeId] : undefined;
    if (merge) rows.push({ label: 'Merge evidence', detail: `${merge.sourceBranch} @ ${merge.sourceSha.slice(0, 10)} into ${merge.target} as ${merge.mergeSha.slice(0, 10)}. Post-merge checks: ${merge.postChecks.status}.`, ok: merge.postChecks.status === 'failed' ? false : merge.postChecks.status === 'passed' ? true : null });
    else rows.push({ label: 'Source SHA', detail: plan.sha ? plan.sha.slice(0, 10) : 'No recorded merge is bound to this plan.', ok: plan.sha ? null : false });
    return rows;
  }

  private gate(plan: ReleasePlan, step: ReleaseStep): { allow: boolean; record: boolean; reason: string } {
    if (step.kind === 'push' && isProtectedBranch(step.target, plan, this.d.config.project)) return { allow: false, record: true, reason: `Refusing production or protected target ${step.target}. One Connect did not push.` };
    const merge = plan.mergeId ? this.d.state.merges[plan.mergeId] : undefined;
    if (plan.sha && (!merge || merge.mergeSha !== plan.sha || merge.target !== this.d.config.project.integration_branch || merge.postChecks.status !== 'passed')) return { allow: false, record: false, reason: 'A recorded integration merge with passing post-merge checks is required.' };
    // Cached CI, migration history and passive deployment readiness never verify an action.
    return { allow: true, record: false, reason: 'Execute the reviewed action and its fresh verification.' };
  }

  private async runProject(command: string, sha: string | null, verification?: VerificationRequest): Promise<ProjectCommandResult> {
    if (!sha) return { status: 'unavailable', exitCode: null, detail: 'No source SHA is bound, so the command was not run.' };
    command = command.replaceAll('{release_sha}', shellQuote(sha));
    if (verification) {
      // The reviewed verifier receives a unique challenge, never a reusable cached proof.
      if (!command.includes('{release_verification}')) return { status: 'unavailable', exitCode: null, detail: 'Verification command must accept {release_verification}.' };
      command = command.replaceAll('{release_verification}', shellQuote(JSON.stringify(verification)));
    }
    const results = await runChecks({
      cwd: this.d.config.project.repo,
      repo: this.d.config.project.repo,
      sha,
      runtime: this.d.config.project.check_runtime,
      checks: [{ name: 'release', command }],
      logDir: path.join(this.d.paths.root, 'release-checks', verification?.id ?? newId('action')),
      env: { PATH: this.d.baseEnv().PATH },
      denylist: this.d.denylist(),
      timeoutMs: 120_000,
    });
    const result = results[0];
    if (!result) return { status: 'unavailable', exitCode: null, detail: 'The check runtime returned no result.' };
    let proof: ReleaseProof | undefined;
    if (verification && result.logPath) {
      try {
        const lines = fs.readFileSync(result.logPath, 'utf8').split('\n').filter(line => line.startsWith('ONE_CONNECT_RELEASE_PROOF '));
        if (lines.length === 1) proof = JSON.parse(lines[0].slice('ONE_CONNECT_RELEASE_PROOF '.length));
      } catch { /* no usable proof */ }
    }
    // This executor runs local committed-source checks. Stdout cannot promote its
    // acceptance scope to production/device; those require an independent protocol.
    if (proof) proof = { ...proof, source: 'probe', acceptanceEnvironment: 'local' };
    return { status: result.status, exitCode: result.exitCode, detail: result.detail || result.status, sha: result.sha, runtimeKey: result.runtimeKey, proof, uncertain: result.timedOut };
  }

  private assertNoOpenDecision(plan: ReleasePlan): void {
    for (const decision of Object.values(this.d.state.decisions)) {
      if (decision.action && 'planId' in decision.action && decision.action.planId === plan.id && !decision.answeredAt && !decision.consumedAt) throw new CommandError('Answer the open release decision before editing the plan.', 409);
    }
  }

  private save(plan: ReleasePlan, actor: typeof HUMAN): void {
    this.d.commit([{ type: 'release.saved', actor, workItemId: plan.workItemId, data: { plan } }]);
  }
}

function latestMerge(d: Daemon, workItemId: string): IntegrationMerge | null {
  const rows = Object.values(d.state.merges ?? {}).filter((m) => m.workItemId === workItemId);
  return rows.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

function toDraft(step: ReleaseStep): StepDraft {
  return { id: step.id, kind: step.kind, title: step.title, owner: step.owner, command: step.command, check: step.check, rollback: step.rollback, rollbackCheck: step.rollbackCheck, target: step.target, environment: step.environment };
}

function normalizeDraft(input: StepDraft, environment: string): Required<Omit<StepDraft, 'id' | 'rollbackCheck'>> & { id?: string; rollbackCheck?: string } {
  const kind = String(input.kind ?? '');
  if (!KINDS.has(kind)) throw new CommandError(`unknown step kind ${kind}`);
  const title = String(input.title ?? '').trim().slice(0, 120);
  const command = String(input.command ?? '').trim().slice(0, 500);
  const check = String(input.check ?? '').trim().slice(0, 500);
  const rollback = String(input.rollback ?? '').trim().slice(0, 500);
  const rollbackCheck = input.rollbackCheck ? String(input.rollbackCheck).trim().slice(0, 500) : undefined;
  const owner = (String(input.owner ?? 'owner').trim() || 'owner').slice(0, 80);
  const target = String(input.target ?? '').trim().slice(0, 200);
  const env = (String(input.environment ?? environment).trim() || environment).slice(0, 500);
  if (!title || !command || !check || !rollback || !target) throw new CommandError('each step needs a title, command, target, check and rollback');
  return { id: input.id, kind: kind as ReleaseStepKind, title, owner, command, check, rollback, rollbackCheck, target, environment: env };
}

function releaseComment(plan: ReleasePlan, step: ReleaseStep): string {
  const lines = [`**Release “${plan.name}” step ${step.order + 1}. ${step.title}:** ${step.status}.`, step.evidence?.summary ?? ''];
  if (step.evidence?.attestation === 'human') lines.push('Human attestation. This is not command output.');
  if (step.status === 'failed') lines.push(`Rollback: ${step.rollback}`);
  return lines.filter(Boolean).join('\n');
}

