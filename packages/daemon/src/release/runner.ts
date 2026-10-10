// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Exact release operations. Transport runs outside the repository's configuration;
// successful writes still need fresh evidence of their actual result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ControlCenterConfig, ReleaseCapability, ReleasePlan, ReleaseStep } from '@acc/core';
import { isolatedGit, SAFE_GIT_FLAGS } from '../adapters/vcs/git-policy.ts';

export interface ReleaseExecResult { code: number | null; stdout: string; stderr: string; error?: string; timedOut?: boolean }
export type ReleaseExec = (bin: string, args: string[], opts?: { cwd?: string; input?: string; decisionId?: string }) => Promise<ReleaseExecResult>;
export interface VerificationRequest {
  id: string;
  sha: string;
  target: string;
  environment: string;
  kind: ReleaseStep['kind'];
  phase: 'run' | 'rollback';
  startedAt: string;
}
export interface ReleaseProof extends VerificationRequest {
  ok: boolean;
  observedAt: string;
  source: 'probe' | 'real_device';
  detail: string;
  /** Required for backup and real device checks: an independently checked artifact/session. */
  artifact?: string;
  /** Environment actually probed; a runtime label does not imply production. */
  acceptanceEnvironment?: 'local' | 'production' | 'device';
}
export interface ProjectCommandResult {
  status: 'passed' | 'failed' | 'unavailable'; exitCode: number | null; detail: string;
  sha?: string | null; runtimeKey?: string; proof?: ReleaseProof;
  uncertain?: boolean;
}
/** Context for a parent-owned, independently scoped action/probe protocol. */
export interface ReleaseCommandContext {
  decisionId: string;
  planId: string;
  stepId: string;
  kind: ReleaseStep['kind'];
  target: string;
  environment: string;
  phase: 'run' | 'rollback';
  configHash: string;
}
export interface StepRunResult {
  executed: boolean; ok: boolean | null; summary: string; exitCode: number | null; attestation: 'human' | null;
  proof?: ReleaseProof;
  uncertain?: boolean;
}
const WRITE_KINDS = new Set<ReleaseStep['kind']>(['push', 'pr', 'backup', 'migrate', 'env_flags', 'deploy', 'custom']);
export const isWriteStep = (kind: ReleaseStep['kind']): boolean => WRITE_KINDS.has(kind);
const exactSha = (sha: string | null): sha is string => !!sha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha);
const safeBranch = (branch: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/') && !branch.split('/').some(p => p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'));
export function isProtectedBranch(branch: string, plan: ReleasePlan, project: ControlCenterConfig['project']): boolean {
  if (!safeBranch(branch) || branch === plan.productionBranch || branch === project.production_branch) return true;
  return project.protected_branches.some(pattern => {
    const regex = pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${regex}$`).test(branch);
  });
}
export function reviewedHost(config: ControlCenterConfig): { provider: 'github' | 'gitlab'; host: string; apiHost: string; repo: string; url: string } | null {
  const c = config.code_host;
  if (!c || !c.host || !c.activated || !c.scopes.length || c.fixture_base) return null;
  const host = c.provider === 'github' && c.host === 'api.github.com' ? 'github.com' : c.host;
  const repo = c.provider === 'github' ? c.repo : c.project;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?$/.test(host) || !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repo) || repo.split('/').some(s => s === '.' || s === '..' || s.endsWith('.git'))) return null;
  return { provider: c.provider, host, apiHost: c.host, repo, url: `https://${host}/${repo}.git` };
}
export function allowlistedPush(provider: 'github' | 'gitlab', repo: string, branch: string, sha: string, host = provider === 'github' ? 'github.com' : 'gitlab.com'): string {
  return ['git', 'push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--', `https://${host}/${repo}.git`, `${sha}:refs/heads/${branch}`].join(' ');
}
function prArgs(provider: 'github' | 'gitlab', repo: string, base: string, head: string, title: string): string[] {
  return provider === 'github'
    ? ['pr', 'create', '-R', repo, '--base', base, '--head', head, '--title', title, '--body', 'Release reviewed in One Connect.', '--no-maintainer-edit']
    : ['mr', 'create', '--repo', repo, '--source-branch', head, '--target-branch', base, '--title', title, '--description', 'Release reviewed in One Connect.', '--yes'];
}
export function allowlistedPr(provider: 'github' | 'gitlab', repo: string, base: string, head: string, title: string): string {
  return [provider === 'github' ? 'gh' : 'glab', ...prArgs(provider, repo, base, head, title)].join(' ');
}
export function configuredCommand(command: string, config: ControlCenterConfig): string | null {
  if (!command.startsWith('check:')) return null;
  const value = config.project.checks[command.slice(6)];
  return value?.trim() || null;
}
const success = (r: ReleaseExecResult) => r.code === 0 && !r.error && !r.timedOut;
const failed = (summary: string, executed = false, code: number | null = null): StepRunResult => ({ executed, ok: false, summary, exitCode: code, attestation: null });
type Input = {
  step: ReleaseStep; plan: ReleasePlan; config: ControlCenterConfig; command: string; exec: ReleaseExec;
  project: (command: string, verification?: VerificationRequest) => Promise<ProjectCommandResult>;
  mode: 'run' | 'rollback';
  /** Revalidate durable authorization and current config immediately before each child operation. */
  guard?: () => void;
  /** Enforce the connector's approved read ceiling as well as the exact release action. */
  authorizeRead?: (capability: ReleaseCapability) => void;
};

// Only Git object reads use the actual repository. No executable local/global Git
// configuration, remotes, URL rewrites, helpers, proxy or hooks enter the transport.
async function transport<T>(input: Input, localObjects: boolean, fn: (cwd: string, git: (args: string[]) => Promise<ReleaseExecResult>) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-connect-release-'));
  try {
    const dir = path.join(root, 'repo.git');
    fs.mkdirSync(path.join(dir, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/unused\n');
    fs.writeFileSync(path.join(dir, 'config'), `[core]\n\tbare = true\n\trepositoryFormatVersion = ${input.plan.sha?.length === 64 ? 1 : 0}\n${input.plan.sha?.length === 64 ? '[extensions]\n\tobjectFormat = sha256\n' : ''}`);
    if (localObjects) {
      const obj = await isolatedGit(input.config.project.repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
      const commit = await isolatedGit(input.config.project.repo, ['rev-parse', '--verify', `${input.plan.sha}^{commit}`]);
      if (!success(obj) || !success(commit) || commit.stdout.trim() !== input.plan.sha) throw new Error('Exact release commit objects are unavailable locally; nothing was pushed.');
      const objects = fs.realpathSync(obj.stdout.trim());
      if (/[\r\n]/.test(objects)) throw new Error('Unsafe Git object directory.');
      fs.writeFileSync(path.join(dir, 'objects', 'info', 'alternates'), `${objects}\n`);
    }
    const git = (args: string[]) => {
      input.guard?.();
      return input.exec('git', [...SAFE_GIT_FLAGS, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', ...args], { cwd: dir });
    };
    return await fn(dir, git);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function api(input: Input, cwd: string, endpoint: string, capability: ReleaseCapability): Promise<ReleaseExecResult> {
  const h = reviewedHost(input.config)!;
  input.guard?.();
  input.authorizeRead?.(capability);
  return h.provider === 'github'
    ? input.exec('gh', ['api', '--hostname', h.host, '--method', 'GET', endpoint], { cwd })
    : input.exec('glab', ['api', '--hostname', h.host, '--method', 'GET', endpoint], { cwd });
}
function hostAction(input: Input): StepRunResult | null {
  const { step, plan, config } = input;
  const h = reviewedHost(config);
  if (!h) return failed('Activate a reviewed code host, repository path and write scope first. Nothing was executed.');
  if (!safeBranch(plan.productionBranch) || isProtectedBranch(step.target, plan, config.project)) return failed('Production and protected branch heads are refused. One Connect did not push or open a PR.');
  if (!config.code_host?.scopes.some(s => h.provider === 'github' ? ['repo', 'public_repo', step.kind === 'push' ? 'contents:write' : 'pull_requests:write'].includes(s) : (step.kind === 'push' ? ['api', 'write_repository'] : ['api']).includes(s))) return failed('Owner-reviewed write scope metadata is missing. Actual token permission remains unverified until the host accepts the operation.');
  const want = step.kind === 'push' ? allowlistedPush(h.provider, h.repo, step.target, plan.sha!, h.host) : allowlistedPr(h.provider, `${h.host}/${h.repo}`, plan.productionBranch, step.target, step.title);
  if (input.command !== want || step.check !== (step.kind === 'push' ? 'remote-ref' : 'pull-head-base')) return failed('The exact host, repo, SHA, head/base command or verification changed. Nothing was written.');
  return null;
}
async function protection(input: Input, cwd: string): Promise<boolean> {
  const h = reviewedHost(input.config)!;
  for (const [branch, protectedValue] of [[input.plan.productionBranch, true], [input.step.target, false]] as const) {
    const r = await api(input, cwd, h.provider === 'github' ? `repos/${h.repo}/branches/${encodeURIComponent(branch)}` : `projects/${encodeURIComponent(h.repo)}/repository/branches/${encodeURIComponent(branch)}`, 'branch-protection:read');
    try { const value = JSON.parse(r.stdout); if (!success(r) || value.name !== branch || value.protected !== protectedValue) return false; }
    catch { return false; }
  }
  return true;
}
async function verifyHost(input: Input, cwd: string, git: (args: string[]) => Promise<ReleaseExecResult>): Promise<StepRunResult> {
  const { step, plan } = input;
  const h = reviewedHost(input.config)!;
  if (!await protection(input, cwd)) return failed('Production/release branch protection is unknown or changed; inspect without replay.');
  if (await remoteSha(git, h.url, step.target) !== plan.sha) return failed('Fresh remote verification did not match the exact release SHA.');
  if (step.kind === 'push') return { executed: false, ok: true, exitCode: 0, attestation: null, summary: `Freshly verified ${plan.sha} at ${h.url} refs/heads/${step.target}.` };
  let projectId: number | undefined;
  if (h.provider === 'gitlab') {
    const project = await api(input, cwd, `projects/${encodeURIComponent(h.repo)}`, 'pulls:read');
    try { const value = JSON.parse(project.stdout); if (success(project) && value.path_with_namespace === h.repo && Number.isSafeInteger(value.id) && value.id > 0) projectId = value.id; } catch { /* unknown identity */ }
    if (!projectId) return failed('Exact GitLab project identity could not be verified.');
  }
  const pulls = await api(input, cwd, h.provider === 'github' ? `repos/${h.repo}/pulls?state=open&head=${encodeURIComponent(`${h.repo.split('/')[0]}:${step.target}`)}&base=${encodeURIComponent(plan.productionBranch)}` : `projects/${encodeURIComponent(h.repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(step.target)}&target_branch=${encodeURIComponent(plan.productionBranch)}`, 'pulls:read');
  let matching = false;
  try {
    const rows = JSON.parse(pulls.stdout);
    matching = Array.isArray(rows) && rows.some(p => h.provider === 'github'
      ? p.state === 'open' && p.head?.sha === plan.sha && p.head?.ref === step.target && p.base?.ref === plan.productionBranch && p.head?.repo?.full_name === h.repo && p.base?.repo?.full_name === h.repo
      : p.state === 'opened' && p.sha === plan.sha && p.source_branch === step.target && p.target_branch === plan.productionBranch && p.source_project_id === projectId && p.target_project_id === projectId);
  } catch { /* malformed proof fails closed */ }
  const unchanged = await remoteSha(git, h.url, step.target) === plan.sha;
  return success(pulls) && matching && unchanged
    ? { executed: false, ok: true, exitCode: 0, attestation: null, summary: `Freshly verified PR ${step.target} @ ${plan.sha} into ${plan.productionBranch} in ${h.host}/${h.repo}.` }
    : failed('Fresh exact PR repository/head/base verification failed.');
}
async function remoteSha(git: (args: string[]) => Promise<ReleaseExecResult>, url: string, head: string): Promise<string | null> {
  const r = await git(['ls-remote', '--exit-code', '--refs', '--', url, `refs/heads/${head}`]);
  if (!success(r)) return null;
  const lines = r.stdout.trim().split('\n');
  if (lines.length !== 1) return null;
  const [sha, ref] = lines[0].split(/\s+/);
  return exactSha(sha) && ref === `refs/heads/${head}` ? sha : null;
}
export async function executeReleaseStep(input: Input): Promise<StepRunResult> {
  const { step, plan, config } = input;
  if (input.mode === 'run' && step.kind === 'device_qa' && input.command === 'attest:device') {
    return { executed: false, ok: null, exitCode: null, attestation: 'human', summary: 'Human attestation recorded. Real-device acceptance remains unverified; configure a real-device check to pass this step.' };
  }
  if (!exactSha(plan.sha)) return failed('An exact release SHA is required. Nothing was executed.');
  if ((step.kind === 'push' || step.kind === 'pr') && input.mode === 'rollback') return failed('Host rollback is unsupported. Configure a separate reviewed action; no push or PR was repeated.');
  if (step.kind === 'push' || step.kind === 'pr') {
    const refusal = hostAction(input);
    if (refusal) return refusal;
    const h = reviewedHost(config)!;
    return transport(input, step.kind === 'push', async (cwd, git) => {
      if (!await protection(input, cwd)) return failed('Production/release branch protection is unknown or protected. Nothing was written.');
      if (step.kind === 'pr' && await remoteSha(git, h.url, step.target) !== plan.sha) return failed('PR head does not match the exact release SHA; nothing was opened.');
      input.guard?.();
      const ran = step.kind === 'push'
        ? await git(input.command.split(' ').slice(1))
        : await input.exec(h.provider === 'github' ? 'gh' : 'glab', prArgs(h.provider, `${h.host}/${h.repo}`, plan.productionBranch, step.target, step.title), { cwd });
      if (ran.timedOut || ran.error || ran.code === null) return { ...failed('Host write was interrupted; inspect without replaying this action.', true, ran.code), ok: null, uncertain: true };
      const verified = await verifyHost(input, cwd, git);
      return { ...verified, executed: true, exitCode: ran.code, ok: success(ran) && verified.ok === true, summary: `${success(ran) ? 'Host command completed.' : 'Host command failed.'} ${verified.summary}` };
    });
  }
  const command = configuredCommand(input.command, config);
  const check = configuredCommand(input.mode === 'rollback' ? step.rollbackCheck ?? '' : step.check, config);
  if (!command || !check || command === check) return failed('Configure distinct reviewed action and verification commands using check:<name>. Exit 0 alone is not release evidence.');
  input.guard?.();
  const ran = await input.project(command);
  if (ran.uncertain || (ran.status === 'failed' && ran.exitCode === null)) return { ...failed('Command outcome is unknown; inspect its effect without replay.', true, ran.exitCode), ok: null, uncertain: true };
  const verified = await verifyReleaseStep(input);
  if (ran.status !== 'passed' || verified.ok !== true) return { ...verified, executed: ran.status !== 'unavailable', ok: false, exitCode: ran.exitCode, summary: `${ran.detail}; ${verified.summary} Rollback: ${step.rollback}` };
  return { ...verified, executed: true, exitCode: ran.exitCode };
}
/** Inspect effects without replaying an interrupted write. */
export async function verifyReleaseStep(input: Input): Promise<StepRunResult> {
  const { step, plan, config } = input;
  if (!exactSha(plan.sha)) return failed('An exact release SHA is required for inspection.');
  if (step.kind === 'push' || step.kind === 'pr') {
    if (input.mode === 'rollback') return failed('Host rollback inspection is unsupported; no write was replayed.');
    const refusal = hostAction(input);
    if (refusal) return refusal;
    return transport(input, false, (cwd, git) => verifyHost(input, cwd, git));
  }
  const command = configuredCommand(input.mode === 'rollback' ? step.rollbackCheck ?? '' : step.check, config);
  if (!command) return failed('Configured verification is unavailable; human attestation cannot make this step green.');
  const request: VerificationRequest = { id: randomUUID(), sha: plan.sha, target: step.target, environment: step.environment, kind: step.kind, phase: input.mode, startedAt: new Date().toISOString() };
  input.guard?.();
  const result = await input.project(command, request);
  const proof = result.proof;
  const fresh = proof && Number.isFinite(Date.parse(proof.observedAt)) && Date.parse(proof.observedAt) >= Date.parse(request.startedAt) && Date.parse(proof.observedAt) <= Date.now() + 5000;
  const match = proof && Object.entries(request).every(([k, v]) => proof[k as keyof VerificationRequest] === v);
  const artifact = proof && typeof proof.artifact === 'string' && !!proof.artifact.trim();
  const real = proof && (step.kind === 'device_qa' && input.mode === 'run' ? proof.source === 'real_device' && proof.acceptanceEnvironment === 'device' && artifact : proof.source === 'probe') && (step.kind !== 'backup' || artifact);
  const ok = result.status === 'passed' && result.exitCode === 0 && result.sha === plan.sha && result.runtimeKey === step.environment && fresh && match && real && proof.ok === true && typeof proof.detail === 'string' && !!proof.detail.trim();
  if (!ok) return failed('Verification failed, stale, wrong SHA/target/runtime, or lacked an actual probe/artifact. Command exit 0 and passive host readiness are insufficient.', result.status !== 'unavailable', result.exitCode);
  const accepted: ReleaseProof = { ...request, ok: true, observedAt: proof.observedAt, source: proof.source, detail: proof.detail, artifact: typeof proof.artifact === 'string' ? proof.artifact : undefined, acceptanceEnvironment: ['local', 'production', 'device'].includes(proof.acceptanceEnvironment ?? '') ? proof.acceptanceEnvironment : undefined };
  return { executed: true, ok: true, exitCode: result.exitCode, attestation: null, proof: accepted, summary: `Fresh verification: ${accepted.detail}` };
}
