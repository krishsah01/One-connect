// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Brief & Reports and Timeline over this project's own event log. No model call: pure derivation
// from recorded events and the live state (see packages/core/src/reports.ts).
import type { ReportFilter } from '@acc/core';
import { buildBrief, buildMorningReport, buildTimeline, isReleaseLike, renderStandupMarkdown, type ReportEvent } from '@acc/core';
import { CommandError, type Daemon } from '../daemon.ts';

const TYPES = [
  'daemon.started', 'work_item.created', 'work_item.transitioned', 'work_item.evidence_added', 'run.created', 'run.ended', 'run.handoff', 'run.tests',
  'approval.requested', 'approval.resolved', 'alert.raised', 'alert.resolved', 'decision.created', 'decision.answered', 'decision.consumed', 'kill_switch.set',
  'merge.completed', 'merge.post_checks', 'merge.refused', 'review.recorded', 'agent.limited', 'agent.unlimited', 'agent.paused', 'agent.resumed',
  'workflow.status', 'notification.emitted', 'remote.paired', 'remote.session_revoked', 'remote.tunnel_state', 'benchmark.completed', 't.commit', 't.test_result', 't.error',
];
const MAX_EVENTS = 30_000;

interface Row { seq: number; id: string; ts: string; type: string; actor: string; agent_id: string | null; run_id: string | null; work_item_id: string | null; assignment_id: string | null; data: string }

export class Reports {
  readonly d: Daemon;
  private cache: ReportEvent[] = [];
  private lastSeq = 0;
  constructor(d: Daemon) { this.d = d; }

  /** Incrementally loaded, bounded view of the report-relevant events. */
  events(): ReportEvent[] {
    const marks = TYPES.map(() => '?').join(',');
    const rows = this.d.store.db.prepare(`SELECT seq,id,ts,type,actor,agent_id,run_id,work_item_id,assignment_id,data FROM events WHERE seq > ? AND (type IN (${marks}) OR type LIKE 'release.%' OR type LIKE 'deploy.%' OR type LIKE 'infra.%' OR type LIKE 'ci.%' OR type LIKE 'code_host.%') ORDER BY seq LIMIT 20000`).all(this.lastSeq, ...TYPES) as unknown as Row[];
    for (const r of rows) {
      this.cache.push({ seq: Number(r.seq), id: String(r.id), ts: String(r.ts), type: String(r.type), actor: JSON.parse(String(r.actor)), agentId: r.agent_id, runId: r.run_id, workItemId: r.work_item_id, assignmentId: r.assignment_id, data: JSON.parse(String(r.data)) });
      this.lastSeq = Number(r.seq);
    }
    if (rows.length === 20000) return this.events();
    if (this.cache.length > MAX_EVENTS) this.cache.splice(0, this.cache.length - MAX_EVENTS);
    return this.cache;
  }

  filter(q: Record<string, string | undefined>): ReportFilter {
    const date = (v: string | undefined, name: string) => {
      if (!v) return null;
      if (Number.isNaN(Date.parse(v))) throw new CommandError(`${name} must be an ISO date or time`);
      return new Date(v).toISOString();
    };
    const clean = (v: string | undefined) => (v && v.length <= 200 ? v : null);
    return { issue: clean(q.issue), agent: clean(q.agent), from: date(q.from, 'from'), to: date(q.to, 'to'), types: q.types ? q.types.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20) : null };
  }

  brief(q: Record<string, string | undefined>) { return buildBrief(this.d.state, this.events(), this.filter(q), this.d.nowIso()); }

  timeline(q: Record<string, string | undefined>) {
    const limit = Math.max(1, Math.min(Number(q.limit ?? 100) || 100, 500));
    const before = q.before ? Number(q.before) : null;
    return buildTimeline(this.d.state, this.events(), this.filter(q), { limit, beforeSeq: before && Number.isSafeInteger(before) ? before : null });
  }

  morning(q: Record<string, string | undefined>) {
    const f = this.filter(q);
    const to = f.to ?? this.d.nowIso();
    const from = f.from ?? new Date(Date.parse(to) - 24 * 3_600_000).toISOString();
    return buildMorningReport(this.d.state, this.events(), { from, to, filter: { issue: f.issue, agent: f.agent } }, this.d.nowIso());
  }

  standup(q: Record<string, string | undefined>) {
    const report = this.morning(q);
    const brief = this.brief({ issue: q.issue, agent: q.agent });
    return { markdown: renderStandupMarkdown(report, brief), report };
  }

  /** Release-like events seen so far (for tests and the dashboard's honest "none recorded" state). */
  releaseEventCount(): number { return this.events().filter(e => isReleaseLike(e.type)).length; }
}
