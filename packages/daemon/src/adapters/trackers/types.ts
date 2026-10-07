// SPDX-License-Identifier: Apache-2.0
// The one interface a new work tracker implements. The tracker owns issues and statuses; the
// control center mirrors them as work items and writes back through the transactional outbox.
import type { LifecycleState, TrackerCategory } from '@acc/core';

export interface TrackerIssue {
  /** Tracker-native id used for API calls (GitHub number, Linear uuid, local id). */
  id: string;
  /** Human key used in branch names: GH-12, ENG-12, LOC-3. */
  key: string;
  url: string | null;
  title: string;
  description: string;
  acceptance: string[];
  labels: string[];
  priority: number | null;
  status: { category: TrackerCategory; native: string };
  parentKey: string | null;
  updatedAt: string;
}

export interface NewIssue {
  title: string;
  description: string;
  acceptance: string[];
  labels: string[];
  priority?: number | null;
}

export interface TrackerAdapter {
  readonly type: 'local' | 'github' | 'linear';
  /** e.g. "github.com/owner/repo", "Linear team ENG", "local tracker". */
  readonly target: string;
  /** Outbound integrations stay off (dry run, no network) until the owner sets live: true. */
  readonly live: boolean;
  init(): Promise<void>;
  createIssue(i: NewIssue): Promise<TrackerIssue>;
  getIssue(id: string): Promise<TrackerIssue | null>;
  listIssues(o?: { updatedSince?: string | null }): Promise<TrackerIssue[]>;
  setStatus(id: string, category: TrackerCategory, lifecycle: LifecycleState): Promise<void>;
  comment(id: string, body: string): Promise<void>;
}

export class TrackerNotLiveError extends Error {
  constructor(target: string) {
    super(`tracker ${target} is not live: set tracker.live: true in control-center.yaml to allow outbound writes`);
  }
}

const AC_HEADING = /^#{1,6}\s*acceptance criteria\s*$/im;

/** Acceptance criteria travel inside the issue body as a checklist section. */
export function composeBody(description: string, acceptance: string[]): string {
  const d = description.trim();
  if (acceptance.length === 0) return d;
  return `${d}${d ? '\n\n' : ''}## Acceptance criteria\n${acceptance.map((a) => `- [ ] ${a}`).join('\n')}\n`;
}

export function splitBody(body: string): { description: string; acceptance: string[] } {
  const m = AC_HEADING.exec(body ?? '');
  if (!m) return { description: (body ?? '').trim(), acceptance: [] };
  const before = body.slice(0, m.index).trim();
  const rest = body.slice(m.index + m[0].length).split('\n');
  const acceptance: string[] = [];
  let i = 0;
  for (; i < rest.length; i++) {
    const l = rest[i];
    if (/^#{1,6}\s/.test(l)) break;
    const item = /^\s*[-*+]\s*(?:\[[ xX]\]\s*)?(.+)$/.exec(l);
    if (item) acceptance.push(item[1].trim());
  }
  const after = rest.slice(i).join('\n').trim();
  return { description: [before, after].filter(Boolean).join('\n\n'), acceptance };
}

export const CATEGORY_LABEL: Record<TrackerCategory, string> = {
  backlog: 'backlog',
  todo: 'todo',
  in_progress: 'in-progress',
  in_review: 'in-review',
  done: 'done',
  canceled: 'canceled',
};
