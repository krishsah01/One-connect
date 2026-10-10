// SPDX-License-Identifier: Apache-2.0
// Read-only Vercel deployment list. Live https is used only when the caller already activated it.
import type { InfraHealthReport } from '@acc/core';
import type { Fetch } from '../egress.ts';
import { ProviderRefused } from '../adapters/hosts/http.ts';
import type { HostReadOpt } from '../adapters/hosts/github.ts';
import { readCapability } from '../adapters/hosts/github.ts';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function readVercel(fetch: Fetch, base: string, project: string, opt: HostReadOpt = {}): Promise<InfraHealthReport['vercel']> {
  const source = opt.live ? 'live' as const : 'fixture' as const;
  try {
    const res = await readCapability(fetch, base, `/${opt.live ? 'v7' : 'v6'}/deployments?projectId=${encodeURIComponent(project)}&limit=5`, 'deployments:read', opt);
    if (!res) return { state: 'unchecked', source: 'refused', detail: 'Deployment read was not approved. No request was sent.' };
    const body = asRecord(res.json);
    const rows = Array.isArray(body?.deployments) ? body.deployments : null;
    if (res.status !== 200 || !rows) return { state: 'error', source, detail: `Vercel did not return deployments (HTTP ${res.status}).` };
    if (rows.length === 0) return { state: 'unchecked', source, detail: `Vercel for ${project} returned no deployments, so hosting is not reported ready.` };
    const latest = asRecord(rows[0]);
    if (opt.live && latest?.projectId && latest.projectId !== project) return { state: 'unchecked', source, detail: 'The returned deployment belongs to a different project. Hosting remains unknown.' };
    const ready = String(latest?.readyState ?? latest?.state ?? '');
    if (ready === 'READY') return { state: 'ready', source, detail: `${project} deployment ${String(latest?.uid ?? '')} is READY.` };
    if (ready === 'ERROR' || ready === 'CANCELED') return { state: 'error', source, detail: `${project} deployment is ${ready}.` };
    if (ready === 'BUILDING' || ready === 'QUEUED' || ready === 'INITIALIZING') return { state: 'degraded', source, detail: `${project} deployment is ${ready}.` };
    return { state: 'unchecked', source, detail: `${project} deployment state ${ready || 'unknown'} is not a ready result.` };
  } catch (e) {
    if (e instanceof ProviderRefused) return { state: 'unchecked', source: 'refused', detail: e.message };
    return { state: 'error', source, detail: (e as Error).message };
  }
}
