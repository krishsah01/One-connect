// SPDX-License-Identifier: Apache-2.0
// Read-only GitHub REST shapes: branch protection, pull requests and check runs.
// Nothing is merged, pushed or changed. Live https is used only when the caller already activated it.
import type { CodeHostCheck, CodeHostPull, CodeHostSnapshot, ReleaseCapability } from '@acc/core';
import type { Fetch } from '../../egress.ts';
import { ProviderRefused, fixtureUrl, liveUrl, readJson } from './http.ts';

export interface HostReadOpt {
  headers?: Record<string, string>;
  live?: boolean;
  scopes?: string[];
  capabilities?: readonly ReleaseCapability[];
  authorize?: (capability: ReleaseCapability) => void;
}

/** Fixture reads are local; live reads require a capability bound by the connector manager. */
export async function readCapability(fetch: Fetch, base: string, route: string, capability: ReleaseCapability, opt: HostReadOpt) {
  if (opt.live) {
    if (!opt.authorize) throw new ProviderRefused('A live read requires a current human connector Decision. No request was sent.');
    if (!opt.capabilities?.includes(capability)) return null;
    opt.authorize(capability);
  }
  const result = await readJson(fetch, endpoint(base, route, opt.live), opt);
  if (opt.live) opt.authorize!(capability);
  return result;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function checkStatus(status: unknown, conclusion: unknown): CodeHostCheck['status'] {
  const c = typeof conclusion === 'string' ? conclusion : '';
  const s = typeof status === 'string' ? status : '';
  if (c === 'success') return 'passed';
  if (c === 'failure' || c === 'cancelled' || c === 'timed_out' || c === 'action_required') return 'failed';
  if (c === 'skipped' || c === 'neutral') return 'unknown';
  if (s === 'queued' || s === 'in_progress' || s === 'pending' || s === 'waiting' || !c) return 'pending';
  return 'unknown';
}

function endpoint(base: string, path: string, live: boolean | undefined): string {
  return live ? liveUrl(base, path) : fixtureUrl(base, path);
}

export async function readGitHub(fetch: Fetch, base: string, repo: string, branch: string, opt: HostReadOpt = {}): Promise<Pick<CodeHostSnapshot, 'protected' | 'protectionDetail' | 'pulls' | 'checks' | 'error'>> {
  const [owner, name] = repo.split('/');
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const protection = await readCapability(fetch, base, `${root}/branches/${encodeURIComponent(branch)}/protection`, 'branch-protection:read', opt);
  let protected_: boolean | null = null;
  let protectionDetail = '';
  const protectionBody = asRecord(protection?.json);
  if (protection?.status === 200 && protectionBody && (!opt.live || ['required_status_checks', 'required_pull_request_reviews', 'enforce_admins', 'restrictions'].some(key => key in protectionBody))) {
    protected_ = true;
    protectionDetail = `${branch} is protected.`;
  } else if (protection?.status === 404 && !opt.live) {
    protected_ = false;
    protectionDetail = `${branch} is not protected.`;
  } else {
    protectionDetail = protection ? `Branch protection was not readable (HTTP ${protection.status}); protection remains unknown.` : 'Branch protection read was not approved; protection remains unknown.';
  }

  const pullsRes = await readCapability(fetch, base, `${root}/pulls?state=open`, 'pulls:read', opt);
  const pulls: CodeHostPull[] = [];
  if (pullsRes?.status === 200 && Array.isArray(pullsRes.json)) {
    for (const row of pullsRes.json) {
      const r = asRecord(row);
      const head = asRecord(r?.head);
      const baseRef = asRecord(r?.base);
      if (!r || !head) continue;
      pulls.push({
        id: String(r.number ?? r.id ?? ''),
        title: String(r.title ?? ''),
        state: String(r.state ?? ''),
        sha: String(head.sha ?? ''),
        base: String(baseRef?.ref ?? ''),
        head: String(head.ref ?? ''),
        url: typeof r.html_url === 'string' ? r.html_url : null,
      });
    }
  }

  const commit = await readCapability(fetch, base, `${root}/commits/${encodeURIComponent(branch)}`, 'checks:read', opt);
  const tip = asRecord(commit?.json);
  const sha = commit?.status === 200 && typeof tip?.sha === 'string' ? tip.sha : '';
  const checks: CodeHostCheck[] = [];
  let error: string | null = protected_ === null ? protectionDetail : null;
  if (!sha) {
    error = error ?? (commit ? `The tip of ${branch} was not returned (HTTP ${commit.status}).` : 'CI read was not approved; CI remains unknown.');
  } else {
    const runs = await readCapability(fetch, base, `${root}/commits/${encodeURIComponent(sha)}/check-runs`, 'checks:read', opt);
    const body = asRecord(runs?.json);
    const list = Array.isArray(body?.check_runs) ? body.check_runs : [];
    if (runs?.status !== 200) error = error ?? `Check runs were not readable (HTTP ${runs?.status ?? 'not approved'}).`;
    for (const row of list) {
      const r = asRecord(row);
      if (!r) continue;
      const status = checkStatus(r.status, r.conclusion);
      checks.push({ name: String(r.name ?? 'check'), status, sha, detail: String(r.conclusion ?? r.status ?? '') });
    }
  }
  if (pullsRes && (pullsRes.status !== 200 || !Array.isArray(pullsRes.json))) error = error ?? `Pull requests were not readable (HTTP ${pullsRes.status}).`;
  const scopeError = protection ? missingScopes(protection.headers, opt.scopes ?? []) : null;
  if (scopeError) error = error ? `${error} ${scopeError}` : scopeError;
  return { protected: protected_, protectionDetail, pulls, checks, error };
}

function missingScopes(headers: Headers, wanted: string[]): string | null {
  if (!wanted.length || wanted.some(scope => scope.includes(':'))) return null;
  const raw = headers.get('x-oauth-scopes');
  if (raw === null) return null;
  const granted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  const missing = wanted.filter((s) => !granted.has(s));
  return missing.length ? `Token is missing configured scopes: ${missing.join(', ')}.` : null;
}
