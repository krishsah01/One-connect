// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Failing CI, an unprotected branch, and migration drift become tracker issues through the
// existing outbox. The work item stays unsynced until that outbox delivers.
import { HUMAN, productionBranchOf, type WorkItem } from '@acc/core';
import { CommandError } from '../errors.ts';
import { sha256 } from '../util/hash.ts';
import type { Kernel, WorkCommands } from '../kernel.ts';
import type { Connectors } from '../connectors.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type ReleaseFindingsDeps = Kernel & Pick<WorkCommands, 'buildIssue'> & { readonly connectors: Connectors };

export const FINDING_KINDS = ['ci', 'unprotected_branch', 'migration_drift'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export class ReleaseFindings {
  readonly d: ReleaseFindingsDeps;

  constructor(d: ReleaseFindingsDeps) {
    this.d = d;
  }

  active(kind: FindingKind): boolean {
    const config = this.d.connectors.approvedReleaseConfig();
    if (kind === 'migration_drift') {
      const drift = this.d.state.infra?.migrations;
      return drift?.state === 'drift' && (drift.source !== 'live' || this.d.connectors.releaseReadCurrent('supabase', 'migrations:read'));
    }
    const host = this.d.state.codeHost;
    if (!host || host.productionBranch !== productionBranchOf(config.project)) return false;
    if (host.source === 'live' && (host.provider !== config.code_host?.provider || !this.d.connectors.releaseReadCurrent(host.provider, kind === 'ci' ? 'checks:read' : 'branch-protection:read'))) return false;
    if (host.source !== 'live' && host.source !== 'fixture') return false;
    return kind === 'unprotected_branch' ? host.protected === false : host.checks.some(c => c.status === 'failed');
  }

  link(kind: FindingKind): { item: WorkItem; sync: WorkItem['sync']['status'] } {
    if (!(FINDING_KINDS as readonly string[]).includes(kind)) throw new CommandError('unknown finding', 404);
    if (!this.active(kind)) throw new CommandError('That finding has no current scoped proof, so no issue was created.', 409);
    const config = this.d.connectors.approvedReleaseConfig();
    const scope = sha256(JSON.stringify([this.d.config.project.repo, productionBranchOf(config.project), kind === 'migration_drift' ? config.infra?.supabase : config.code_host]));
    const key = `finding:${kind}:${scope}`;
    const existingId = this.d.store.kvGet(key);
    const existing = existingId ? this.d.state.workItems[existingId] : undefined;
    if (existing) return { item: existing, sync: existing.sync.status };
    const copy = findingCopy(kind, this.d);
    const built = this.d.buildIssue({ title: copy.title, description: copy.description, labels: ['release-finding', kind], priority: kind === 'migration_drift' ? 2 : 1 }, HUMAN);
    this.d.commit(built.events, built.outbox, () => this.d.store.kvSet(key, built.item.id));
    const item = this.d.state.workItems[built.item.id];
    return { item, sync: item.sync.status };
  }

  /** Rule mode files an issue once. Manual mode waits for the cockpit button. */
  maybeAuto(): void {
    const config = this.d.connectors.approvedReleaseConfig();
    const hostMode = config.code_host?.finding_issues ?? 'manual';
    const infraMode = config.infra?.finding_issues ?? 'manual';
    if (hostMode === 'rule') {
      if (this.active('ci')) this.link('ci');
      if (this.active('unprotected_branch')) this.link('unprotected_branch');
    }
    if (infraMode === 'rule' && this.active('migration_drift')) this.link('migration_drift');
  }
}

function findingCopy(kind: FindingKind, d: ReleaseFindingsDeps): { title: string; description: string } {
  if (kind === 'unprotected_branch') {
    const branch = d.state.codeHost?.productionBranch ?? 'the production branch';
    return { title: `Unprotected branch ${branch}`, description: d.state.codeHost?.protectionDetail || `${branch} is not protected.` };
  }
  if (kind === 'ci') {
    const failed = (d.state.codeHost?.checks ?? []).filter((c) => c.status === 'failed').map((c) => c.name);
    return { title: 'Failing integration CI', description: failed.length ? `Failing checks: ${failed.join(', ')}.` : 'CI reported a failure.' };
  }
  return { title: 'Migration drift', description: d.state.infra?.migrations.detail || 'Repository migrations do not match the recorded history.' };
}
