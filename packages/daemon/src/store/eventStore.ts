// SPDX-License-Identifier: Apache-2.0
// Append-only event log on SQLite (node:sqlite, no native build). UPDATE and DELETE on
// `events` are rejected by triggers. Projections are rebuilt by replaying through the shared
// reducer; snapshots only speed up boot.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ControlState, EventEnvelope, EventType, NewEvent } from '@acc/core';
import { emptyState, isTranscriptType, newId, SYSTEM } from '@acc/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  agent_id TEXT,
  run_id TEXT,
  work_item_id TEXT,
  assignment_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS events_item ON events(work_item_id, seq);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  event_seq INTEGER,
  work_item_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(delivered_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS snapshots (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_tails (run_id TEXT PRIMARY KEY, stdout_offset INTEGER NOT NULL DEFAULT 0, stderr_offset INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface OutboxOp {
  workItemId: string;
  op: 'create_issue' | 'set_status' | 'comment';
  payload: Record<string, unknown>;
}

export interface OutboxRow extends OutboxOp {
  id: number;
  attempts: number;
  createdAt: string;
  lastError: string | null;
}

type Row = Record<string, SQLInputValue>;

export class EventStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside BEGIN IMMEDIATE … COMMIT; rolls back on throw. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Append events (and outbox rows) atomically. Returns the stored envelopes in order. */
  append(events: NewEvent[], outbox: OutboxOp[] = [], opts: { now?: () => string; inTx?: () => void } = {}): EventEnvelope[] {
    if (events.length === 0 && outbox.length === 0 && !opts.inTx) return [];
    const now = opts.now ?? (() => new Date().toISOString());
    const ins = this.db.prepare(
      'INSERT INTO events (id, ts, type, kind, actor, agent_id, run_id, work_item_id, assignment_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insOut = this.db.prepare('INSERT INTO outbox (created_at, event_seq, work_item_id, op, payload, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)');
    return this.tx(() => {
      const out: EventEnvelope[] = [];
      for (const e of events) {
        const ts = e.ts ?? now();
        const id = newId('ev');
        const kind = isTranscriptType(e.type) ? 'transcript' : 'control';
        const actor = e.actor ?? SYSTEM;
        const r = ins.run(id, ts, e.type, kind, JSON.stringify(actor), e.agentId ?? null, e.runId ?? null, e.workItemId ?? null, e.assignmentId ?? null, JSON.stringify(e.data));
        out.push({
          seq: Number(r.lastInsertRowid),
          id,
          ts,
          type: e.type,
          kind,
          actor,
          agentId: e.agentId ?? null,
          runId: e.runId ?? null,
          workItemId: e.workItemId ?? null,
          assignmentId: e.assignmentId ?? null,
          data: e.data,
        } as EventEnvelope);
      }
      const lastSeq = out.at(-1)?.seq ?? null;
      for (const o of outbox) insOut.run(now(), lastSeq, o.workItemId, o.op, JSON.stringify(o.payload), now());
      opts.inTx?.();
      return out;
    });
  }

  private toEnvelope(r: Row): EventEnvelope {
    return {
      seq: Number(r.seq),
      id: String(r.id),
      ts: String(r.ts),
      type: String(r.type) as EventType,
      kind: String(r.kind) as 'control' | 'transcript',
      actor: JSON.parse(String(r.actor)),
      agentId: (r.agent_id as string | null) ?? null,
      runId: (r.run_id as string | null) ?? null,
      workItemId: (r.work_item_id as string | null) ?? null,
      assignmentId: (r.assignment_id as string | null) ?? null,
      data: JSON.parse(String(r.data)),
    } as EventEnvelope;
  }

  *iterate(opts: { afterSeq?: number; kind?: 'control' | 'transcript' } = {}): Generator<EventEnvelope> {
    const after = opts.afterSeq ?? 0;
    const sql = opts.kind ? 'SELECT * FROM events WHERE seq > ? AND kind = ? ORDER BY seq' : 'SELECT * FROM events WHERE seq > ? ORDER BY seq';
    const stmt = this.db.prepare(sql);
    const rows = (opts.kind ? stmt.iterate(after, opts.kind) : stmt.iterate(after)) as Iterable<Row>;
    for (const r of rows) yield this.toEnvelope(r);
  }

  list(opts: { afterSeq?: number; kind?: 'control' | 'transcript'; runId?: string; workItemId?: string; limit?: number; types?: string[] } = {}): EventEnvelope[] {
    const where: string[] = ['seq > ?'];
    const args: SQLInputValue[] = [opts.afterSeq ?? 0];
    if (opts.kind) {
      where.push('kind = ?');
      args.push(opts.kind);
    }
    if (opts.runId) {
      where.push('run_id = ?');
      args.push(opts.runId);
    }
    if (opts.workItemId) {
      where.push('work_item_id = ?');
      args.push(opts.workItemId);
    }
    if (opts.types?.length) {
      where.push(`type IN (${opts.types.map(() => '?').join(',')})`);
      args.push(...opts.types);
    }
    const limit = Math.min(opts.limit ?? 1000, 10_000);
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ${limit}`).all(...args) as Row[];
    return rows.map((r) => this.toEnvelope(r));
  }

  lastSeq(): number {
    const r = this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as Row | undefined;
    return Number(r?.s ?? 0);
  }

  // ---- snapshots -------------------------------------------------------------------------

  saveSnapshot(state: ControlState): void {
    this.db.prepare('INSERT OR REPLACE INTO snapshots (seq, ts, state) VALUES (?, ?, ?)').run(state.seq, new Date().toISOString(), JSON.stringify(state));
    this.db.prepare('DELETE FROM snapshots WHERE seq NOT IN (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT 3)').run();
  }

  latestSnapshot(): ControlState | null {
    const r = this.db.prepare('SELECT state FROM snapshots ORDER BY seq DESC LIMIT 1').get() as Row | undefined;
    return r ? (JSON.parse(String(r.state)) as ControlState) : null;
  }

  clearSnapshots(): void {
    this.db.prepare('DELETE FROM snapshots').run();
  }

  /** Snapshot + tail replay. */
  loadState(reduce: (s: ControlState, e: EventEnvelope) => ControlState): ControlState {
    // Transcript events update run liveness too, so the tail replays every kind. Snapshots are
    // taken often enough that the tail stays short.
    let s = { ...emptyState(), ...(this.latestSnapshot() ?? {}) };
    for (const e of this.iterate({ afterSeq: s.seq })) s = reduce(s, e);
    return s;
  }

  // ---- outbox ----------------------------------------------------------------------------

  pendingOutbox(now: string, limit = 50): OutboxRow[] {
    const rows = this.db
      .prepare('SELECT * FROM outbox WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY id LIMIT ?')
      .all(now, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      workItemId: String(r.work_item_id),
      op: String(r.op) as OutboxOp['op'],
      payload: JSON.parse(String(r.payload)),
      attempts: Number(r.attempts),
      createdAt: String(r.created_at),
      lastError: (r.last_error as string | null) ?? null,
    }));
  }

  /** Oldest undelivered row per work item, so ops for one issue are applied in order. */
  undeliveredBefore(workItemId: string, id: number): boolean {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE work_item_id = ? AND delivered_at IS NULL AND id < ?').get(workItemId, id) as Row;
    return Number(r.n) > 0;
  }

  markDelivered(id: number): void {
    this.db.prepare('UPDATE outbox SET delivered_at = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), id);
  }

  markFailed(id: number, error: string, nextAttemptAt: string): void {
    this.db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?').run(error, nextAttemptAt, id);
  }

  outboxStats(): { pending: number; failing: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS p, SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS f FROM outbox WHERE delivered_at IS NULL').get() as Row;
    return { pending: Number(r.p ?? 0), failing: Number(r.f ?? 0) };
  }

  // ---- run tail offsets & kv -------------------------------------------------------------

  getTail(runId: string): { stdout: number; stderr: number } {
    const r = this.db.prepare('SELECT stdout_offset, stderr_offset FROM run_tails WHERE run_id = ?').get(runId) as Row | undefined;
    return { stdout: Number(r?.stdout_offset ?? 0), stderr: Number(r?.stderr_offset ?? 0) };
  }

  setTail(runId: string, stdout: number, stderr: number): void {
    this.db
      .prepare('INSERT INTO run_tails (run_id, stdout_offset, stderr_offset, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET stdout_offset = excluded.stdout_offset, stderr_offset = excluded.stderr_offset, updated_at = excluded.updated_at')
      .run(runId, stdout, stderr, new Date().toISOString());
  }

  kvGet(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  kvSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  kvDelete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
}
