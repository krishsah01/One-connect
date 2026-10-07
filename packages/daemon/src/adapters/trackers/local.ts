// SPDX-License-Identifier: Apache-2.0
// A real (if minimal) tracker stored in its own SQLite file, standing in for an external
// system: offline use, demos and tests. It is deliberately separate from the event log.
import { DatabaseSync } from 'node:sqlite';
import type { LifecycleState, TrackerCategory } from '@acc/core';
import type { NewIssue, TrackerAdapter, TrackerIssue } from './types.ts';

type Row = Record<string, unknown>;

export class LocalTracker implements TrackerAdapter {
  readonly type = 'local' as const;
  readonly live = true;
  readonly target = 'local tracker';
  private db: DatabaseSync;

  private prefix: string;

  constructor(file: string, prefix = 'LOC') {
    this.prefix = prefix;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS issues (
        n INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL,
        labels TEXT NOT NULL, priority INTEGER, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, issue INTEGER NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
    `);
  }

  async init(): Promise<void> {}

  private toIssue(r: Row): TrackerIssue {
    const status = String(r.status) as TrackerCategory;
    return {
      id: String(r.n),
      key: `${this.prefix}-${r.n}`,
      url: null,
      title: String(r.title),
      description: String(r.description),
      acceptance: JSON.parse(String(r.acceptance)),
      labels: JSON.parse(String(r.labels)),
      priority: r.priority === null ? null : Number(r.priority),
      status: { category: status, native: status },
      parentKey: null,
      updatedAt: String(r.updated_at),
    };
  }

  async createIssue(i: NewIssue): Promise<TrackerIssue> {
    const now = new Date().toISOString();
    const r = this.db
      .prepare('INSERT INTO issues (title, description, acceptance, labels, priority, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(i.title, i.description, JSON.stringify(i.acceptance), JSON.stringify(i.labels), i.priority ?? null, 'backlog', now);
    return (await this.getIssue(String(r.lastInsertRowid)))!;
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    const r = this.db.prepare('SELECT * FROM issues WHERE n = ?').get(Number(id)) as Row | undefined;
    return r ? this.toIssue(r) : null;
  }

  async listIssues(o: { updatedSince?: string | null } = {}): Promise<TrackerIssue[]> {
    const rows = this.db.prepare('SELECT * FROM issues WHERE updated_at > ? ORDER BY n').all(o.updatedSince ?? '') as Row[];
    return rows.map((r) => this.toIssue(r));
  }

  async setStatus(id: string, category: TrackerCategory, _lifecycle: LifecycleState): Promise<void> {
    this.db.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE n = ?').run(category, new Date().toISOString(), Number(id));
  }

  async comment(id: string, body: string): Promise<void> {
    this.db.prepare('INSERT INTO comments (issue, body, at) VALUES (?, ?, ?)').run(Number(id), body, new Date().toISOString());
  }

  /** For tests and the UI: comments are what a human would see in the tracker. */
  comments(id: string): string[] {
    return (this.db.prepare('SELECT body FROM comments WHERE issue = ? ORDER BY id').all(Number(id)) as Row[]).map((r) => String(r.body));
  }

  /** Simulates a human editing the issue in the tracker UI. */
  externalUpdate(id: string, patch: { title?: string; status?: TrackerCategory }): void {
    const cur = this.db.prepare('SELECT * FROM issues WHERE n = ?').get(Number(id)) as Row;
    this.db.prepare('UPDATE issues SET title = ?, status = ?, updated_at = ? WHERE n = ?').run(patch.title ?? String(cur.title), patch.status ?? String(cur.status), new Date().toISOString(), Number(id));
  }

  close(): void {
    this.db.close();
  }
}
