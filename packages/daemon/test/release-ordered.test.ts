// SPDX-License-Identifier: Apache-2.0
// Disposable Git, local tracker, repository-owned fake agents and injected protocols only.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRuntimeKey, type IntegrationMerge, type ReleaseStep, type ReleaseCapability } from '@acc/core';
import { Daemon } from '../src/daemon.ts';
import { LocalTracker } from '../src/adapters/trackers/local.ts';
import { safeGitEnv } from '../src/adapters/vcs/git-policy.ts';
import { run } from '../src/exec.ts';
import { git, makeConfig, makeRepo, startDaemon, tmpDir, waitFor, type Harness } from './helpers.ts';
import type { ProjectCommandResult, ReleaseExec, ReleaseProof, VerificationRequest } from '../src/release/runner.ts';

const resources: { d: Daemon; close: () => Promise<void> }[] = [];
afterEach(async () => { for (const h of resources.splice(0)) await h.close(); });
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
function offline(config = makeConfig(makeRepo()), dataDir = tmpDir('release-ordered-data'), clock?: () => Date) {
  const d = new Daemon({ config, dataDir, allowTempDataDir: true, clock, baseEnv: { PATH: process.env.PATH }, fetch: async () => { throw new Error('No live provider allowed'); } });
  d.outbox.kick = () => {};
  resources.push({ d, close: async () => { if (!d.closed) { d.closed = true; d.store.close(); } } });
  return d;
}
function bind(d: Daemon) {
  const item = d.createIssue({ title: 'Fixture release', description: '', requiresProductionVerification: true });
  const sha = git(d.config.project.repo, 'rev-parse', 'HEAD');
  const merge: IntegrationMerge = { id: 'fixture-merge', workItemId: item.id, decisionId: 'fixture-review-decision', reviewId: 'fixture-review', sourceBranch: 'feature', sourceSha: sha, target: 'integration', targetShaBefore: sha, mergeSha: sha, method: 'ref', at: d.nowIso(), postChecks: { status: 'passed', evidenceIds: [], at: d.nowIso() } };
  d.commit([{ type: 'merge.completed', workItemId: item.id, data: { merge } }, { type: 'work_item.evidence_added', workItemId: item.id, data: { evidence: { id: 'fixture-merge-proof', kind: 'merge', sha, branch: 'integration', summary: 'Fixture merge', verified: true, env: 'local', at: d.nowIso() } } }, { type: 'work_item.transitioned', workItemId: item.id, data: { from: item.state, to: 'merged', reason: 'Fixture setup', blockedOn: null } }]);
  return d.releasePlans.create({ name: 'Fixture', workItemId: item.id });
}
async function answer(d: Daemon, id: string, option = 'approve') {
  const prep = d.decisions.prepare(id, option);
  return d.decisions.respond(id, option, { nonce: prep.nonce, channel: 'phone' });
}
function proofResult(sha: string | null, environment: string, request?: VerificationRequest, patch: Partial<ReleaseProof> = {}): ProjectCommandResult {
  return { status: 'passed', exitCode: 0, detail: 'local protocol fixture', sha, runtimeKey: environment, proof: request ? { ...request, observedAt: new Date().toISOString(), source: 'probe', acceptanceEnvironment: 'local', ok: true, detail: 'Actual fixture state checked', artifact: 'fixture-artifact', ...patch } : undefined };
}
async function approveHost(d: Daemon, capabilities: readonly ReleaseCapability[] = ['branch-protection:read', 'pulls:read', 'checks:read']) {
  d.connectors.save({ id: 'host', name: 'Scoped fixture', config: { ...d.connectors.defaults().github, capabilities: [...capabilities] } }, null);
  await answer(d, d.connectors.requestActivation('host', 'read').decision!.id);
}
function hostExec(d: Daemon, sha: string, hooks: { afterWrite?: () => void; wrongBranch?: boolean } = {}) {
  const calls: { bin: string; args: string[]; decisionId?: string }[] = [];
  let remote = false;
  let pull = false;
  const exec: ReleaseExec = async (bin, args, opts) => {
    const dec = d.state.decisions[opts!.decisionId!];
    expect(dec.answeredBy?.type).toBe('human');
    expect(dec.answer === 'approve' || dec.answer === 'attested').toBe(true);
    expect(JSON.parse(d.store.kvGet(`release:authorization:${dec.id}`)!).status).toBe('reserved');
    calls.push({ bin, args, decisionId: opts?.decisionId });
    if (args.includes('push')) { remote = true; hooks.afterWrite?.(); return { code: 0, stdout: '', stderr: '' }; }
    if (args.includes('create')) { pull = true; hooks.afterWrite?.(); return { code: 0, stdout: 'fixture PR', stderr: '' }; }
    if (args.includes('ls-remote')) return { code: remote ? 0 : 2, stdout: remote ? `${sha}\trefs/heads/integration\n` : '', stderr: '' };
    if (args.at(-1)?.includes('/branches/')) { const name = args.at(-1)!.endsWith('/main') ? 'main' : 'integration'; return { code: 0, stdout: JSON.stringify({ name: hooks.wrongBranch ? 'foreign' : name, protected: name === 'main' }), stderr: '' }; }
    return { code: 0, stdout: JSON.stringify(pull ? [{ state: 'open', head: { sha, ref: 'integration', repo: { full_name: 'acme/widgets' } }, base: { ref: 'main', repo: { full_name: 'acme/widgets' } } }] : []), stderr: '' };
  };
  return { exec, calls };
}

// Both action and verification execute real fixture commands in the committed-source
// runtime. The verifier independently reads the effect; it cannot pass on exit 0 alone.
function installReleaseFixture(repo: string, effectDir: string) {
  const script = `import fs from 'node:fs';
import path from 'node:path';
const [root, mode, kind, value] = process.argv.slice(2);
const file = path.join(root, kind + '.json');
fs.mkdirSync(root, { recursive: true });
if (mode === 'action') {
  fs.writeFileSync(file, JSON.stringify({ sha: value, kind, applied: true }));
  fs.appendFileSync(path.join(root, 'writes'), kind + '\\n');
} else {
  const request = JSON.parse(value);
  const actual = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!actual.applied || actual.sha !== request.sha || actual.kind !== kind) process.exit(1);
  console.log('ONE_CONNECT_RELEASE_PROOF ' + JSON.stringify({ ...request, ok: true, observedAt: new Date().toISOString(), source: 'probe', acceptanceEnvironment: 'production', artifact: file, detail: 'Read applied fixture ' + kind + ' at exact SHA' }));
}`;
  fs.writeFileSync(path.join(repo, 'release-fixture.mjs'), script);
  git(repo, 'add', 'release-fixture.mjs');
  git(repo, 'commit', '-qm', 'install local release fixture');
  git(repo, 'branch', '-f', 'integration', 'HEAD');
  return Object.fromEntries(['ci', 'migration_dry_run', 'backup', 'migrate', 'env_flags', 'deploy', 'routes', 'device_qa'].flatMap(kind => [[`release_${kind}`, `node release-fixture.mjs ${quote(effectDir)} action ${kind} {release_sha}`], [`release_${kind}_verify`, `node release-fixture.mjs ${quote(effectDir)} verify ${kind} {release_verification}`]]));
}

describe('ordered fixture acceptance', () => {
  it('develops, independently reviews and merges, then executes every default step in order with real local command probes and a scoped device protocol fixture', async () => {
    const repo = makeRepo();
    const effects = tmpDir('release-effects');
    const checks = installReleaseFixture(repo, effects);
    const cfg = makeConfig(repo, { code_host: { provider: 'github', repo: 'acme/widgets', host: 'api.github.com', scopes: ['repo'] } });
    cfg.project.checks = { test: 'node --test', ...checks };
    cfg.project.required_checks = ['test'];
    const h: Harness = await startDaemon(cfg, { fetch: async () => { throw new Error('No outbound provider traffic is allowed'); } });
    resources.push(h);
    const { d } = h;
    const item = d.createIssue({ title: 'Ordered fixture delivery', description: '', acceptance: ['notes file exists'], requiresProductionVerification: true });
    await waitFor(() => d.state.workItems[item.id].trackerId);
    const asg = d.createAssignment({ workItemId: item.id, agentId: 'claude', allowedPaths: ['notes/**'], requiredChecks: ['test'] });
    await d.dispatch(asg.id);
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received');
    const authorSha = git(d.state.assignments[asg.id].worktree!, 'rev-parse', 'HEAD');
    await waitFor(() => d.state.workItems[item.id].evidence.find(e => e.kind === 'test' && e.sha === authorSha && e.verified));
    const reviewAsg = await d.reviewMerge.createReviewAssignment({ workItemId: item.id, reviewerAgentId: 'codex' });
    await d.dispatch(reviewAsg.id);
    const review = await waitFor(() => Object.values(d.state.reviews).find(r => r.assignmentId === reviewAsg.id), 20_000, 'independent fixture review');
    expect(review.verdict, review.summary).toBe('approve');
    await waitFor(() => !Object.values(d.state.runs).some(r => r.assignmentId === reviewAsg.id && !r.endedAt));
    const mergeDecision = (await d.reviewMerge.requestMerge(item.id)).decision;
    const mergePrep = d.decisions.prepare(mergeDecision.id, 'merge');
    await d.decisions.respond(mergeDecision.id, 'merge', { nonce: mergePrep.nonce });
    const merge = await waitFor(() => Object.values(d.state.merges).find(m => m.workItemId === item.id && m.postChecks.status === 'passed'));
    expect(d.state.workItems[item.id].state).toBe('merged');
    await approveHost(d);
    const plan = d.releasePlans.create({ workItemId: item.id });
    expect(plan.sha).toBe(merge.mergeSha);
    const remote = path.join(tmpDir('ordered-bare'), 'remote.git');
    git(repo, 'init', '--bare', '-q', remote);
    git(repo, 'push', remote, `${merge.targetShaBefore}:refs/heads/integration`);
    const host = hostExec(d, merge.mergeSha);
    // Real Git object upload in an isolated bare transport; only the fixture executor
    // replaces the exact approved HTTPS endpoint with this disposable bare repo.
    d.releasePlans.exec = async (bin, args, opts) => {
      if (bin !== 'git') return host.exec(bin, args, opts);
      host.calls.push({ bin, args, decisionId: opts?.decisionId });
      expect(d.state.decisions[opts!.decisionId!].answer).toMatch(/approve|attested/);
      expect(opts?.cwd).not.toBe(repo);
      return run('git', ['-c', 'protocol.file.allow=always', ...args.map(a => a === 'https://github.com/acme/widgets.git' ? remote : a)], { cwd: opts?.cwd, env: safeGitEnv() });
    };
    for (const step of plan.steps.slice(0, -1)) {
      const pending = d.releasePlans.get(plan.id);
      expect(pending.steps.find(s => s.status !== 'approved')!.id).toBe(step.id);
      const decision = d.releasePlans.requestStep(plan.id, step.id).decision;
      await expect(d.releasePlans.resolve(decision.id, 'approve')).rejects.toThrow(/confirmation/);
      const resolved = await answer(d, decision.id);
      expect('release' in resolved ? resolved.release : null, step.kind).toMatchObject({ status: 'approved', evidence: { ok: true } });
      await expect(d.releasePlans.resolve(decision.id, 'approve')).rejects.toThrow(/missing|answered/);
      if (step.kind === 'push') expect(d.state.workItems[item.id].state).toBe('release_candidate');
      if (step.kind === 'deploy') expect(d.state.workItems[item.id].state).toBe('deployed');
      if (step.kind !== 'push' && step.kind !== 'pr') expect(d.releasePlans.get(plan.id).steps[step.order].evidence?.proof?.acceptanceEnvironment).toBe('local');
      expect(d.state.workItems[item.id].state).not.toBe('verified');
    }
    expect(git(remote, 'rev-parse', 'refs/heads/integration')).toBe(merge.mergeSha);
    expect(git(remote, 'show', `${merge.mergeSha}:notes/${d.state.workItems[item.id].key}.md`)).toContain('Done by the fake claude agent.');
    const device = plan.steps.at(-1)!;
    // Local stdout claimed production above and is clamped to local. It cannot
    // impersonate real-device evidence either: the ordinary default QA fails.
    await answer(d, d.releasePlans.requestStep(plan.id, device.id).decision.id);
    expect(d.releasePlans.get(plan.id).steps.at(-1)!.status).toBe('failed');
    expect(d.state.workItems[item.id].state).toBe('deployed');
    const localProject = d.releasePlans.projectCommand;
    d.releasePlans.projectCommand = async (command, sha, request, context) => {
      expect(context).toMatchObject({ planId: plan.id, stepId: device.id, kind: 'device_qa', target: 'device', environment: device.environment, phase: 'run', configHash: expect.any(String) });
      expect(d.state.decisions[context!.decisionId].answeredAt).toBeTruthy();
      if (!command.includes('device_qa')) return localProject(command, sha, request);
      // Injected device session protocol verifies its own fixture effect. This is
      // synthetic contract evidence in a disposable daemon, never real device QA.
      if (!request) fs.writeFileSync(path.join(effects, 'device-session'), JSON.stringify({ sha, environment: device.environment }));
      else expect(JSON.parse(fs.readFileSync(path.join(effects, 'device-session'), 'utf8'))).toEqual({ sha: request.sha, environment: request.environment });
      return proofResult(sha, device.environment, request, { source: 'real_device', acceptanceEnvironment: 'device', artifact: 'injected-fixture-session' });
    };
    await answer(d, d.releasePlans.requestStep(plan.id, device.id).decision.id);
    expect(d.releasePlans.get(plan.id).status).toBe('completed');
    expect(d.state.workItems[item.id].state).toBe('verified');
    expect(d.state.workItems[item.id].evidence.find(e => e.kind === 'acceptance')).toMatchObject({ sha: merge.mergeSha, env: 'device', verified: true });
    expect(fs.readFileSync(path.join(effects, 'writes'), 'utf8').trim().split('\n')).toEqual(['ci', 'migration_dry_run', 'backup', 'migrate', 'env_flags', 'deploy', 'routes', 'device_qa']);
    const tracker = d.tracker as LocalTracker;
    await waitFor(() => tracker.comments(d.state.workItems[item.id].trackerId!).filter(body => body.includes('**Release')).length === 11);
    expect((await tracker.getIssue(d.state.workItems[item.id].trackerId!))?.status.category).toBe('done');
    expect(tracker.comments(d.state.workItems[item.id].trackerId!).filter(body => body.includes('**Release'))).toHaveLength(11);
    const events = d.store.list({ kind: 'control', types: ['work_item.transitioned'], workItemId: item.id });
    expect(events.slice(-3).map(e => e.data)).toEqual(expect.arrayContaining([expect.objectContaining({ to: 'release_candidate' }), expect.objectContaining({ to: 'deployed' }), expect.objectContaining({ to: 'verified' })]));
  }, 90_000);

  it('blocks failed/stale steps and rechecks confirmation/hash/config without dispatch; local completion never grants production acceptance', async () => {
    let now = new Date();
    const d = offline(undefined, undefined, () => now);
    d.config.project.checks = { action: 'action', verify: 'probe' };
    const plan = bind(d);
    d.releasePlans.update(plan.id, { steps: [0, 1].map(i => ({ ...plan.steps[i], kind: i ? 'verify_routes' as const : 'deploy' as const, command: 'check:action', check: 'check:verify', target: 'fixture' })) });
    let calls = 0;
    d.releasePlans.projectCommand = async (_cmd, sha, request) => { calls++; return proofResult(sha, plan.steps[0].environment, request); };
    const first = d.releasePlans.requestStep(plan.id, plan.steps[0].id).decision;
    const expired = d.decisions.prepare(first.id, 'approve');
    now = new Date(now.getTime() + 180_000);
    await expect(d.releasePlans.resolve(first.id, 'approve', { nonce: expired.nonce })).rejects.toThrow(/expired/);
    expect(calls).toBe(0);
    const confirmed = d.decisions.prepare(first.id, 'approve');
    d.config.project.checks.verify = 'changed-probe';
    await expect(d.releasePlans.resolve(first.id, 'approve', { nonce: confirmed.nonce })).rejects.toThrow(/configuration/);
    expect(calls).toBe(0);
    const replacement = d.releasePlans.requestStep(plan.id, plan.steps[0].id).decision;
    expect(d.state.decisions[first.id].consumedAt).toBeTruthy();
    expect(replacement.id).not.toBe(first.id);
    // Same hash with a tampered action payload is not an exact authorization.
    const originalAction = replacement.action;
    d.state.decisions[replacement.id].action = { ...replacement.action!, command: 'foreign action' } as typeof replacement.action;
    await expect(d.releasePlans.resolve(replacement.id, 'approve')).rejects.toThrow(/step changed/);
    d.state.decisions[replacement.id].action = originalAction;
    for (const step of d.releasePlans.get(plan.id).steps) await answer(d, d.releasePlans.requestStep(plan.id, step.id).decision.id);
    expect(d.releasePlans.get(plan.id).status).toBe('completed');
    expect(d.state.workItems[plan.workItemId!].state).toBe('deployed');
    expect(d.state.workItems[plan.workItemId!].evidence.some(e => e.kind === 'acceptance')).toBe(false);
  });

  it.each(['push', 'pr'] as const)('recovers an interrupted %s from durable approval and inspects only exact reads, never replaying the write', async kind => {
    const cfg = makeConfig(makeRepo(), { code_host: { provider: 'github', repo: 'acme/widgets', host: 'api.github.com', scopes: ['repo'] } });
    const d = offline(cfg);
    await approveHost(d);
    const plan = bind(d);
    let interrupt = kind === 'push';
    const host = hostExec(d, plan.sha!, { afterWrite: () => { if (interrupt) d.closed = true; } });
    d.releasePlans.exec = host.exec;
    if (kind === 'pr') await answer(d, d.releasePlans.requestStep(plan.id, plan.steps[0].id).decision.id);
    d.closed = false;
    const step = plan.steps[kind === 'push' ? 0 : 1];
    interrupt = true;
    const decision = d.releasePlans.requestStep(plan.id, step.id).decision;
    await answer(d, decision.id);
    expect(d.state.decisions[decision.id]).toMatchObject({ answer: 'approve', confirmedAt: expect.any(String) });
    expect(d.releasePlans.get(plan.id).steps[step.order].status).toBe('running');
    d.closed = false;
    d.store.close();
    d.closed = true;
    const restored = offline(cfg, d.paths.root);
    expect(restored.releasePlans.get(plan.id).steps[step.order].status).toBe('uncertain');
    expect(() => restored.releasePlans.requestStep(plan.id, step.id)).toThrow(/will not be run again/);
    await expect(restored.releasePlans.resolve(decision.id, 'approve')).rejects.toThrow(/answered|missing/);
    const read = hostExec(restored, plan.sha!);
    restored.releasePlans.exec = async (bin, args, opts) => {
      expect(args).not.toContain('push'); expect(args).not.toContain('create');
      if (bin === 'git') return { code: 0, stdout: `${plan.sha}\trefs/heads/integration\n`, stderr: '' };
      if (args.at(-1)?.includes('/pulls?')) return { code: 0, stdout: JSON.stringify([{ state: 'open', head: { sha: plan.sha, ref: 'integration', repo: { full_name: 'acme/widgets' } }, base: { ref: 'main', repo: { full_name: 'acme/widgets' } } }]), stderr: '' };
      return read.exec(bin, args, opts);
    };
    const original = restored.state.merges[plan.mergeId!]!;
    restored.commit([{ type: 'merge.completed', workItemId: plan.workItemId, data: { merge: { ...original, id: 'newer-merge', mergeSha: 'b'.repeat(40), at: '2099-01-01T00:00:00Z' } } }]);
    const inspection = restored.releasePlans.requestInspection(plan.id, step.id).decision;
    expect(restored.releasePlans.requestInspection(plan.id, step.id).decision.id).toBe(inspection.id);
    await answer(restored, inspection.id, 'attested');
    expect(restored.releasePlans.get(plan.id).steps[step.order]).toMatchObject({ status: 'approved', evidence: { ok: true, attestation: 'human' } });
    expect(host.calls.filter(c => c.args.includes(kind === 'push' ? 'push' : 'create'))).toHaveLength(1);
  });

  it('uses the rollback verifier after a rollback restart, never advances the failed forward step, and consumes removed pending Decisions', async () => {
    const cfg = makeConfig(makeRepo());
    cfg.project.checks = { action: 'forward', verify: 'forward-probe', rollback: 'restore', rollback_verify: 'restore-probe' };
    const d = offline(cfg);
    const plan = bind(d);
    const step: ReleaseStep = { ...plan.steps[0], kind: 'custom', target: 'fixture', command: 'check:action', check: 'check:verify', rollback: 'check:rollback', rollbackCheck: 'check:rollback_verify' };
    d.releasePlans.update(plan.id, { steps: [step, { ...plan.steps[1], kind: 'custom', command: 'check:action', check: 'check:verify', target: 'fixture' }] });
    d.commit([{ type: 'work_item.transitioned', workItemId: plan.workItemId, data: { from: 'merged', to: 'deployed', reason: 'Existing fixture deployment', blockedOn: null } }]);
    const effects: string[] = [];
    d.releasePlans.projectCommand = async (cmd, sha, request) => {
      effects.push(cmd);
      if (cmd === 'forward') return { status: 'failed', exitCode: 1, detail: 'fixture failure', sha, runtimeKey: step.environment };
      if (cmd === 'restore') d.closed = true;
      return proofResult(sha, step.environment, request);
    };
    await answer(d, d.releasePlans.requestStep(plan.id, step.id).decision.id);
    expect(() => d.releasePlans.requestStep(plan.id, plan.steps[1].id)).toThrow(/cannot be skipped/);
    const rollback = d.releasePlans.requestRollback(plan.id, step.id).decision;
    expect(d.releasePlans.requestRollback(plan.id, step.id).decision.id).toBe(rollback.id);
    await expect(d.releasePlans.resolve(rollback.id, 'approve')).rejects.toThrow(/confirmation/);
    await answer(d, rollback.id);
    d.closed = false; d.store.close(); d.closed = true;
    const restored = offline(cfg, d.paths.root);
    expect(restored.releasePlans.get(plan.id).steps[0]).toMatchObject({ status: 'uncertain', recoveryPhase: 'rollback' });
    restored.releasePlans.projectCommand = async (cmd, sha, request) => { expect(cmd).toBe('restore-probe'); expect(request?.phase).toBe('rollback'); effects.push(cmd); return proofResult(sha, step.environment, request); };
    await answer(restored, restored.releasePlans.requestInspection(plan.id, step.id).decision.id, 'attested');
    expect(restored.releasePlans.get(plan.id).steps[0]).toMatchObject({ status: 'failed', evidence: { ok: true, proof: { phase: 'rollback' } } });
    expect(restored.releasePlans.get(plan.id).steps[1].status).toBe('pending');
    expect(restored.state.workItems[plan.workItemId!].state).toBe('release_candidate');
    expect(effects).toEqual(['forward', 'forward-probe', 'restore', 'restore-probe']);
    const pending = restored.releasePlans.requestStep(plan.id, step.id).decision;
    restored.releasePlans.update(plan.id, { steps: [restored.releasePlans.get(plan.id).steps[1]] });
    expect(restored.state.decisions[pending.id].consumedAt).toBeTruthy();
    await expect(restored.releasePlans.resolve(pending.id, 'approve')).rejects.toThrow(/missing/);
  });
});

it('refuses missing protection capability before action dispatch and leaves no misleading uncertain write', async () => {
  const d = offline(makeConfig(makeRepo(), { code_host: { provider: 'github', repo: 'acme/widgets', host: 'api.github.com', scopes: ['repo'] } }));
  await approveHost(d, ['checks:read']);
  const plan = bind(d);
  let calls = 0;
  d.releasePlans.exec = async () => { calls++; throw new Error('Unapproved provider call'); };
  const result = await answer(d, d.releasePlans.requestStep(plan.id, plan.steps[0].id).decision.id);
  expect('release' in result && result.release).toMatchObject({ status: 'failed', executed: false, evidence: { ok: false } });
  expect(calls).toBe(0);
  expect(d.releasePlans.get(plan.id).steps[1].status).toBe('pending');
});
