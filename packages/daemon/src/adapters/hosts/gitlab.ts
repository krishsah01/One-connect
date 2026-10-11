// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Read-only GitLab REST shapes: protected branches, merge requests and pipelines.
// Nothing is merged or changed. Live https is used only when the caller already activated it.
import type { CodeHostCheck, CodeHostPull, CodeHostSnapshot } from '@acc/core';
import type { Fetch } from '../../egress.ts';
import { readCapability, type HostReadOpt } from './github.ts';
import { asRecord } from '@acc/core';

function pipelineStatus(status: unknown): CodeHostCheck['status'] {
  const s = String(status ?? '');
  if (s === 'success') return 'passed';
  if (s === 'failed' || s === 'canceled' || s === 'canceling') return 'failed';
  if (s === 'skipped') return 'unknown';
  if (s === 'running' || s === 'pending' || s === 'created' || s === 'manual' || s === 'preparing' || s === 'waiting_for_resource' || s === 'scheduled') return 'pending';
  return 'unknown';
}

export async function readGitLab(fetch: Fetch, base: string, project: string, branch: string, opt: HostReadOpt = {}): Promise<Pick<CodeHostSnapshot, 'protected' | 'protectionDetail' | 'pulls' | 'checks' | 'error'>> {
  const id = encodeURIComponent(project);
  const root = `/api/v4/projects/${id}`;
  const protectedRes = await readCapability(fetch, base, `${root}/protected_branches?per_page=100`, 'branch-protection:read', opt);
  let protected_: boolean | null = null;
  let protectionDetail = '';
  let error: string | null = null;
  if (protectedRes?.status === 200 && Array.isArray(protectedRes.json)) {
    // GitLab protected branch names may contain wildcard rules.
    const match = protectedRes.json.some(row => {
      const pattern = asRecord(row)?.name;
      if (typeof pattern !== 'string') return false;
      const escaped = pattern.split('*').map(part => [...part].map(char => /[A-Za-z0-9_-]/.test(char) ? char : '\\' + char).join('')).join('.*');
      return new RegExp(`^${escaped}$`).test(branch);
    });
    const malformed = protectedRes.json.some(row => typeof asRecord(row)?.name !== 'string');
    protected_ = match ? true : malformed || protectedRes.headers.get('x-next-page') ? null : false;
    protectionDetail = protected_ ? `${branch} is protected.` : `${branch} is not protected.`;
  } else {
    protectionDetail = protectedRes ? `Protected branches were not readable (HTTP ${protectedRes.status}).` : 'Branch protection read was not approved; protection remains unknown.';
    error = protectionDetail;
  }

  if (protected_ === null) { protectionDetail = 'Branch protection remains unknown; the returned rules are incomplete or unreadable.'; error = protectionDetail; }
  const mrs = await readCapability(fetch, base, `${root}/merge_requests?state=opened`, 'pulls:read', opt);
  const pulls: CodeHostPull[] = [];
  if (mrs?.status === 200 && Array.isArray(mrs.json)) {
    for (const row of mrs.json) {
      const r = asRecord(row);
      if (!r) continue;
      pulls.push({
        id: String(r.iid ?? r.id ?? ''),
        title: String(r.title ?? ''),
        state: String(r.state ?? ''),
        sha: String(r.sha ?? ''),
        base: String(r.target_branch ?? ''),
        head: String(r.source_branch ?? ''),
        url: typeof r.web_url === 'string' ? r.web_url : null,
      });
    }
  } else error = error ?? `Merge requests were not readable (HTTP ${mrs?.status ?? 'not approved'}).`;

  const pipes = await readCapability(fetch, base, `${root}/pipelines?ref=${encodeURIComponent(branch)}`, 'checks:read', opt);
  const checks: CodeHostCheck[] = [];
  if (pipes?.status === 200 && Array.isArray(pipes.json)) {
    for (const row of pipes.json) {
      const r = asRecord(row);
      if (!r) continue;
      checks.push({ name: `pipeline ${String(r.id ?? '')}`, status: pipelineStatus(r.status), sha: String(r.sha ?? ''), detail: String(r.status ?? '') });
    }
  } else error = error ?? `Pipelines were not readable (HTTP ${pipes?.status ?? 'not approved'}).`;
  return { protected: protected_, protectionDetail, pulls, checks, error };
}
