// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Metrics are projections of recorded state, never forecasts or claims of unverified work.
import type { ControlState, Run, UsageInfo } from './entities.ts';
import { isActiveRun } from './reducer.ts';
import { sharedCapacity } from './capacity.ts';

export function remainingCapacity(usage: UsageInfo): number | null {
  const values = usage.windows.map(w => w.usedPercent).filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
  return values.length ? Math.max(0, Math.min(100, 100 - Math.max(...values))) : null;
}

function runTime(runs: Run[], now: number): number {
  const spans = runs.filter(r => r.startedAt).map(r => [Date.parse(r.startedAt!), Math.min(now, r.endedAt ? Date.parse(r.endedAt) : now)] as [number,number]).filter(([start,end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a,b) => a[0]-b[0]);
  let total = 0, start = 0, end = 0;
  for (const [a,b] of spans) {
    if (a > end) { total += end-start; start=a; end=b; }
    else end=Math.max(end,b);
  }
  return total+end-start;
}

export function projectAnalytics(state: ControlState, nowIso: string) {
  const now = Date.parse(nowIso);
  const runs = Object.values(state.runs);
  const items = Object.values(state.workItems);
  const messages = Object.values(state.teamMessages ?? {});
  const agents = Object.values(state.agents).map(a => {
    const own = runs.filter(r => r.agentId === a.id);
    const capacity=sharedCapacity(state.agents,a.id);
    return { id:a.id,name:a.config.name,status:a.status,runs:own.length,finished:own.filter(r => r.state === 'finished').length,failed:own.filter(r => ['failed','orphaned'].includes(r.state)).length,
      inputTokens:own.reduce((n,r) => n+r.usage.inputTokens,0),outputTokens:own.reduce((n,r) => n+r.usage.outputTokens,0),costUsd:own.reduce((n,r) => n+(r.usage.costUsd ?? 0),0),runTimeMs:runTime(own,now),
      idleMs:a.idleMsTotal+Math.max(0,a.idleSince ? now-Date.parse(a.idleSince) : 0),remainingPercent:capacity.limitedUntil?0:remainingCapacity(capacity.usage),capacitySource:capacity.usage.source,capacityCheckedAt:capacity.usage.checkedAt,subscriptionGroup:capacity.group,sharedWith:capacity.peerIds.filter(id=>id!==a.id),
      unread:messages.filter(m => m.recipients.includes(a.id) && !m.acknowledgedBy[a.id]).length };
  });
  return { project:state.project?.name ?? '',asOf:nowIso,agents,totalRuns:runs.length,activeRuns:runs.filter(isActiveRun).length,finishedRuns:runs.filter(r => r.state === 'finished').length,failedRuns:runs.filter(r => ['failed','orphaned'].includes(r.state)).length,
    verifiedItems:items.filter(w => w.state === 'verified' && w.evidence.some(e => e.kind === 'merge' && e.verified) && w.evidence.some(e => e.kind === 'acceptance' && e.verified && (!w.requiresProductionVerification || ['production','device'].includes(e.env ?? '')))).length,
    inputTokens:agents.reduce((n,a) => n+a.inputTokens,0),outputTokens:agents.reduce((n,a) => n+a.outputTokens,0),recordedCostUsd:agents.reduce((n,a) => n+a.costUsd,0),
    messages:messages.length,acknowledged:messages.reduce((n,m) => n+Object.keys(m.acknowledgedBy).length,0),pendingDecisions:Object.values(state.approvals).filter(a => !a.resolvedAt).length,
    modelAvailability:agents.filter(a => state.agents[a.id].models.newest && state.agents[a.id].models.current !== state.agents[a.id].models.newest).length,
    lifecycle:items.reduce<Record<string,number>>((all,w) => { all[w.state]=(all[w.state] ?? 0)+1;return all; },{}) };
}
