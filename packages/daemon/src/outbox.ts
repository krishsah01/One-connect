// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Tracker sync. Writes come from the transactional outbox (committed together with the lifecycle
// event that caused them) and are delivered in order per issue with retries; failures are loud.
// The poller ingests changes made directly in the tracker.
import type { LifecycleState, NewEvent, TrackerCategory, WorkItem } from '@acc/core';
import { DEFAULT_TRACKER_CATEGORY, newId } from '@acc/core';
import { TrackerNotLiveError, type TrackerIssue } from './adapters/trackers/types.ts';
import type { OutboxRow } from './store/eventStore.ts';
import type { Kernel } from './kernel.ts';
import type { TrackerAdapter } from './adapters/trackers/index.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type OutboxDeps = Kernel & { readonly tracker: TrackerAdapter };

export class OutboxWorker {
  readonly d: OutboxDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;

  constructor(d: OutboxDeps) {
    this.d = d;
  }

  start(ms: number): void {
    if (!this.timer) this.timer = setInterval(() => void this.drain(), ms);
    void this.drain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick(): void {
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        const rows = this.d.store.pendingOutbox(this.d.nowIso());
        const blocked = new Set<string>();
        for (const row of rows) {
          if (blocked.has(row.workItemId) || this.d.store.undeliveredBefore(row.workItemId, row.id)) {
            blocked.add(row.workItemId);
            continue;
          }
          const ok = await this.deliver(row);
          if (!ok) blocked.add(row.workItemId);
        }
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private async deliver(row: OutboxRow): Promise<boolean> {
    const d = this.d;
    const t = d.tracker;
    const item = d.state.workItems[row.workItemId];
    if (!item) {
      d.store.markDelivered(row.id);
      return true;
    }
    if (item.origin?.localMirror === true && !item.trackerId) {
      // Retire even an accidentally queued create intent. Read approval cannot publish a mirror.
      // The audit states that no tracker request happened; it never fabricates synced evidence.
      d.commit([{ type: 'tracker.operation_skipped', workItemId: item.id, data: { operation: row.op, reason: 'Local mirror has no approved authoritative tracker binding.' } }], [], () => d.store.markDelivered(row.id));
      return true;
    }
    try {
      if (row.op === 'create_issue') {
        const p = row.payload as { title: string; description: string; acceptance: string[]; labels: string[]; priority?: number };
        const issue = await t.createIssue(p);
        d.commit([{ type: 'work_item.synced', workItemId: item.id, data: { status: 'synced', key: issue.key, trackerId: issue.id, url: issue.url } }, { type: 'work_item.updated', workItemId: item.id, data: { patch: { trackerStatus: issue.status } } }]);
      } else {
        if (!item.trackerId) throw new Error('issue not created in the tracker yet');
        if (row.op === 'set_status') {
          const p = row.payload as { category: TrackerCategory; lifecycle: LifecycleState };
          await t.setStatus(item.trackerId, p.category, p.lifecycle);
          d.commit([{ type: 'work_item.synced', workItemId: item.id, data: { status: 'synced' } }, { type: 'work_item.updated', workItemId: item.id, data: { patch: { trackerStatus: { category: p.category, native: p.category } } } }]);
        } else if (row.op === 'comment') {
          await t.comment(item.trackerId, String((row.payload as { body: string }).body));
          d.commit([{ type: 'work_item.synced', workItemId: item.id, data: { status: 'synced' } }]);
        }
      }
      d.store.markDelivered(row.id);
      d.resolveAlerts((a) => a.dedupeKey === `sync:${item.id}`, 'delivered');
      return true;
    } catch (e) {
      const notLive = e instanceof TrackerNotLiveError;
      const delayMs = notLive ? 60_000 : Math.min(5_000 * 2 ** row.attempts, 5 * 60_000);
      d.store.markFailed(row.id, (e as Error).message, new Date(d.now().getTime() + delayMs).toISOString());
      if (notLive) {
        if (item.sync.status !== 'dry_run') d.commit([{ type: 'work_item.synced', workItemId: item.id, data: { status: 'dry_run', error: (e as Error).message } }]);
      } else {
        if (item.sync.status !== 'failed' || item.sync.lastError !== (e as Error).message) d.commit([{ type: 'work_item.synced', workItemId: item.id, data: { status: 'failed', error: (e as Error).message } }]);
        if (row.attempts >= 1) {
          d.alert({ kind: 'tracker_out_of_sync', severity: 'critical', workItemId: item.id, message: `${item.key ?? item.title}: ${row.op.replace('_', ' ')} to ${t.target} keeps failing (${(e as Error).message}). The tracker is out of sync until this is delivered.`, dedupeKey: `sync:${item.id}` });
        }
      }
      return false;
    }
  }
}

const STATE_FOR_NEW: Partial<Record<TrackerCategory, LifecycleState>> = { backlog: 'backlog', todo: 'selected', in_progress: 'selected', in_review: 'selected' };

export class TrackerPoller {
  readonly d: OutboxDeps;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(d: OutboxDeps) {
    this.d = d;
  }

  start(): void {
    const c = this.d.config.tracker;
    const secs = c.type === 'local' ? 10 : c.poll_seconds;
    if (!this.timer) this.timer = setInterval(() => void this.poll(), secs * 1000);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<number> {
    if (this.busy || !this.d.tracker.live) return 0;
    this.busy = true;
    try {
      const since = this.d.store.kvGet('tracker:last_poll');
      const started = this.d.nowIso();
      const issues = await this.d.tracker.listIssues({ updatedSince: since });
      let n = 0;
      for (const i of issues) n += this.ingest(i) ? 1 : 0;
      this.d.store.kvSet('tracker:last_poll', since && since > started ? since : started);
      this.d.resolveAlerts((a) => a.dedupeKey === 'tracker-poll', 'polling works');
      return n;
    } catch (e) {
      this.d.alert({ kind: 'tracker_out_of_sync', severity: 'warn', message: `polling ${this.d.tracker.target} failed: ${(e as Error).message}`, dedupeKey: 'tracker-poll' });
      return 0;
    } finally {
      this.busy = false;
    }
  }

  /** Mirror one tracker issue. Returns true if anything changed. */
  ingest(i: TrackerIssue): boolean {
    const d = this.d;
    const existing = Object.values(d.state.workItems).find((w) => w.trackerId === i.id);
    if (!existing) {
      const state = STATE_FOR_NEW[i.status.category];
      if (!state) return false; // closed issues are history, not work
      const now = d.nowIso();
      const item: WorkItem = {
        id: newId('wi'),
        key: i.key,
        trackerId: i.id,
        url: i.url,
        title: i.title,
        description: i.description,
        acceptance: i.acceptance,
        labels: i.labels,
        priority: i.priority ?? 3,
        parentKey: i.parentKey,
        blockedBy: [],
        state,
        blockedOn: null,
        resumeTo: null,
        ownerAgentId: null,
        assignmentIds: [],
        runIds: [],
        branches: [],
        evidence: [],
        requiresProductionVerification: false,
        trackerStatus: i.status,
        sync: { status: 'synced', lastError: null, at: now },
        createdAt: now,
        updatedAt: now,
      };
      d.commit([{ type: 'work_item.created', actor: { type: 'human', id: `tracker:${d.tracker.type}` }, workItemId: item.id, data: { item } }]);
      if (i.status.category === 'in_progress') this.mismatch(item, `${i.key} is "${i.status.native}" in the tracker but has no live run here`);
      return true;
    }
    const patch: NonNullable<Extract<NewEvent, { type: 'work_item.updated' }>['data']>['patch'] = {};
    if (existing.title !== i.title) patch.title = i.title;
    if (existing.description !== i.description) patch.description = i.description;
    if (JSON.stringify(existing.acceptance) !== JSON.stringify(i.acceptance)) patch.acceptance = i.acceptance;
    if (JSON.stringify(existing.labels) !== JSON.stringify(i.labels)) patch.labels = i.labels;
    if (JSON.stringify(existing.trackerStatus) !== JSON.stringify(i.status)) patch.trackerStatus = i.status;
    if (Object.keys(patch).length === 0) return false;
    d.commit([{ type: 'work_item.updated', actor: { type: 'human', id: `tracker:${d.tracker.type}` }, workItemId: existing.id, data: { patch } }]);
    // Drift: the tracker says something our lifecycle (and pending writes) don't.
    const pending = d.store.pendingOutbox('9999').some((r) => r.workItemId === existing.id);
    const ours = DEFAULT_TRACKER_CATEGORY[existing.state];
    if (!pending && patch.trackerStatus && ours !== i.status.category) {
      if (i.status.category === 'done' && existing.state !== 'verified') this.mismatch(existing, `${i.key} was closed as done in the tracker, but Done here needs merge and acceptance evidence (state: ${existing.state})`);
      else if (i.status.category === 'canceled' && existing.state !== 'canceled') this.mismatch(existing, `${i.key} was canceled in the tracker; cancel it here too or reopen it there`);
      else this.mismatch(existing, `${i.key} is "${i.status.native}" in the tracker but "${existing.state}" here`);
    }
    return true;
  }

  private mismatch(item: WorkItem, message: string): void {
    this.d.alert({ kind: 'tracker_mismatch', severity: 'warn', workItemId: item.id, message, dedupeKey: `mismatch:${item.id}:${message}` });
  }
}
