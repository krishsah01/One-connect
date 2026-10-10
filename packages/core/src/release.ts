// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Ordered release plans and the read-only facts the cockpit is allowed to show.
// A step is never skipped. Green requires fresh verification of the exact action. A human attestation
// is labelled and does not substitute for verification. Interrupted writes become uncertain and are not repeated.
import type { ProjectConfig } from './config.ts';

export const RELEASE_STEP_KINDS = ['push', 'pr', 'ci', 'migration_dry_run', 'backup', 'migrate', 'env_flags', 'deploy', 'verify_routes', 'device_qa', 'custom'] as const;
export type ReleaseStepKind = (typeof RELEASE_STEP_KINDS)[number];

/** Outward actions. Approving them needs the second confirmation in Decisions. */
export const IRREVERSIBLE_RELEASE_STEPS: readonly ReleaseStepKind[] = ['push', 'pr', 'backup', 'migrate', 'env_flags', 'deploy', 'custom', 'migration_dry_run', 'verify_routes'];

export interface ReleaseStepEvidence {
  summary: string;
  /** True only when a command or probe actually returned that result. Null means it was not executed. */
  ok: boolean | null;
  /** Set when a person attested. Command output is not this evidence. */
  attestation?: 'human' | null;
  exitCode?: number | null;
  /** Fresh verification output, bound to the exact action; absent for attestations. */
  proof?: { id: string; sha: string; target: string; environment: string; kind: ReleaseStepKind; phase: 'run' | 'rollback'; startedAt: string; observedAt: string; ok: boolean; source: 'probe' | 'real_device'; detail: string; artifact?: string; acceptanceEnvironment?: 'local' | 'production' | 'device' };
}

export interface ReleaseStep {
  id: string;
  order: number;
  kind: ReleaseStepKind;
  title: string;
  owner: string;
  /** Branch, deploy target, or other exact target. A change invalidates approval. */
  target: string;
  /** Runtime the command is bound to. A change invalidates approval. */
  environment: string;
  command: string;
  check: string;
  rollback: string;
  /** A rollback verifies restored state, independently of the forward action. */
  rollbackCheck?: string;
  /** Effect to inspect after interruption; inspection never repeats this action. */
  recoveryPhase?: 'run' | 'rollback';
  decisionId: string | null;
  approval: 'pending' | 'approved' | 'denied';
  /** `running` is an in-progress write. Restart turns it into `uncertain` and does not repeat it. */
  status: 'pending' | 'running' | 'approved' | 'failed' | 'uncertain';
  evidence: ReleaseStepEvidence | null;
  checkedAt: string | null;
}

export interface ReleasePlan {
  id: string;
  name: string;
  status: 'active' | 'completed' | 'canceled';
  productionBranch: string;
  sha: string | null;
  workItemId: string | null;
  mergeId: string | null;
  steps: ReleaseStep[];
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseAction {
  kind: 'release' | 'release_rollback' | 'release_inspect';
  planId: string;
  stepId: string;
  stepKind: ReleaseStepKind;
  command: string;
  target: string;
  environment: string;
  sha: string | null;
  hash: string;
  /** Reviewed configuration digest, including host/repo, checks, runtime and protection policy. */
  configHash?: string;
}

export interface CodeHostPull {
  id: string;
  title: string;
  state: string;
  sha: string;
  base: string;
  head: string;
  url: string | null;
}

export interface CodeHostCheck {
  name: string;
  status: 'passed' | 'failed' | 'pending' | 'unknown';
  sha: string;
  detail: string;
}

export interface CodeHostSnapshot {
  provider: 'github' | 'gitlab' | 'unconfigured';
  checkedAt: string;
  source: 'fixture' | 'live' | 'unconfigured' | 'refused';
  productionBranch: string;
  protected: boolean | null;
  protectionDetail: string;
  pulls: CodeHostPull[];
  checks: CodeHostCheck[];
  error: string | null;
  /** Polling is the fallback. `registered` stays false: nothing is registered on the host. */
  delivery: { registered: false; pollSeconds: number; webhook: 'configured' | 'off'; lastDeliveryAt: string | null };
}

export interface MigrationDrift {
  state: 'in_sync' | 'drift' | 'unchecked' | 'error';
  source: 'fixture' | 'local_postgres' | 'live' | 'none';
  repo: string[];
  applied: string[];
  missingInDatabase: string[];
  extraInDatabase: string[];
  /** Same id on both sides, different file hash. Empty when hashes were not available. */
  hashMismatch: string[];
  detail: string;
}

export interface InfraHealthReport {
  checkedAt: string;
  docker: { state: 'ready' | 'unavailable' | 'degraded' | 'unknown'; detail: string };
  postgres: { state: 'ready' | 'paused' | 'unhealthy' | 'stopped' | 'missing' | 'unknown'; service: string | null; detail: string };
  vercel: { state: 'unchecked' | 'ready' | 'degraded' | 'error'; detail: string; source: 'fixture' | 'live' | 'unconfigured' | 'refused' };
  migrations: MigrationDrift;
}

export function productionBranchOf(project: Pick<ProjectConfig, 'production_branch' | 'protected_branches'> | null | undefined): string {
  return project?.production_branch || project?.protected_branches?.[0] || 'main';
}

export function defaultReleaseSteps(branch: string, sha: string | null, environment: string, source: { branch: string; push: string; pr: string } = { branch: 'integration', push: 'configure:push', pr: 'configure:pr' }): Omit<ReleaseStep, 'id' | 'decisionId' | 'approval' | 'status' | 'evidence' | 'checkedAt'>[] {
  const short = sha ? sha.slice(0, 10) : 'the release SHA';
  const rows: { kind: ReleaseStepKind; title: string; target: string; command: string; check: string; rollback: string; rollbackCheck?: string }[] = [
    { kind: 'push', title: 'Push', target: source.branch, command: source.push, check: 'remote-ref', rollback: 'Do not force-push. A correction needs a new reviewed release.' },
    { kind: 'pr', title: 'Pull request', target: source.branch, command: source.pr, check: 'pull-head-base', rollback: 'Close the pull request with a separately reviewed action.' },
    { kind: 'ci', title: 'CI green', target: sha ?? short, command: 'check:release_ci', check: 'check:release_ci_verify', rollback: 'Do not merge or deploy a red SHA.' },
    { kind: 'migration_dry_run', title: 'Migration dry-run', target: 'database', command: 'check:release_migration_dry_run', check: 'check:release_migration_dry_run_verify', rollback: 'Do not apply unverified migrations.' },
    { kind: 'backup', title: 'Backup', target: 'database', command: 'check:release_backup', check: 'check:release_backup_verify', rollback: 'check:release_backup_rollback', rollbackCheck: 'check:release_backup_rollback_verify' },
    { kind: 'migrate', title: 'Migrate', target: 'database', command: 'check:release_migrate', check: 'check:release_migrate_verify', rollback: 'check:release_migrate_rollback', rollbackCheck: 'check:release_migrate_rollback_verify' },
    { kind: 'env_flags', title: 'Environment flags', target: environment, command: 'check:release_env_flags', check: 'check:release_env_flags_verify', rollback: 'check:release_env_flags_rollback', rollbackCheck: 'check:release_env_flags_rollback_verify' },
    { kind: 'deploy', title: 'Deploy', target: sha ?? short, command: 'check:release_deploy', check: 'check:release_deploy_verify', rollback: 'check:release_deploy_rollback', rollbackCheck: 'check:release_deploy_rollback_verify' },
    { kind: 'verify_routes', title: 'Verify routes', target: sha ?? short, command: 'check:release_routes', check: 'check:release_routes_verify', rollback: 'check:release_deploy_rollback', rollbackCheck: 'check:release_deploy_rollback_verify' },
    { kind: 'device_qa', title: 'Device QA', target: 'device', command: 'check:release_device_qa', check: 'check:release_device_qa_verify', rollback: 'check:release_deploy_rollback', rollbackCheck: 'check:release_deploy_rollback_verify' },
  ];
  return rows.map((row, order) => ({ ...row, order, owner: 'owner', environment }));
}

/** Stable hash of one release step. Command, target, environment, rollback, check, SHA or order changes invalidate it. */
export function releaseActionHash(a: Omit<ReleaseAction, 'hash'> & { check: string; rollback: string; rollbackCheck?: string; order: number }): string {
  const s = [a.kind, a.planId, a.stepId, a.stepKind, String(a.order), a.command, a.target, a.environment, a.rollback, a.rollbackCheck ?? '', a.check, a.configHash ?? '', a.sha ?? ''].join('\u0000');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function ciSummary(checks: CodeHostCheck[]): { state: 'green' | 'failing' | 'pending' | 'unknown'; detail: string } {
  if (checks.length === 0) return { state: 'unknown', detail: 'No checks have been returned.' };
  const failed = checks.filter((c) => c.status === 'failed');
  if (failed.length) return { state: 'failing', detail: failed.map((c) => c.name).join(', ') };
  if (checks.some((c) => c.status !== 'passed')) return { state: 'pending', detail: 'A check is still running or was not a pass.' };
  return { state: 'green', detail: `${checks.length} check${checks.length === 1 ? '' : 's'} passed.` };
}
