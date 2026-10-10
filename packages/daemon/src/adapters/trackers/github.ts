// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// GitHub Issues through the user's own signed-in `gh` CLI. The control center never sees a
// GitHub token. Statuses map to `acc:<status>` labels plus open/closed.
import type { LifecycleState, TrackerCategory } from '@acc/core';
import { run } from '../../exec.ts';
import { CATEGORY_LABEL, composeBody, splitBody, TrackerNotLiveError, type NewIssue, type TrackerAdapter, type TrackerIssue } from './types.ts';

const FIELDS = 'number,title,body,labels,state,stateReason,updatedAt,url';
const LABEL_COLORS: Record<TrackerCategory, string> = { backlog: 'c5def5', todo: 'bfd4f2', in_progress: 'fbca04', in_review: '5319e7', done: '0e8a16', canceled: 'cccccc' };

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  state: 'OPEN' | 'CLOSED';
  stateReason?: string | null;
  updatedAt: string;
  url: string;
}

export class GitHubTracker implements TrackerAdapter {
  readonly type = 'github' as const;
  readonly target: string;
  private labelsEnsured = false;

  private o: { repo: string; live: boolean; labelPrefix: string; gh?: string; env?: NodeJS.ProcessEnv };

  constructor(o: { repo: string; live: boolean; labelPrefix: string; gh?: string; env?: NodeJS.ProcessEnv }) {
    this.o = o;
    this.target = `github.com/${o.repo}`;
  }

  get live(): boolean {
    return this.o.live;
  }

  private async gh(args: string[], input?: string): Promise<string> {
    if (!this.o.live) throw new TrackerNotLiveError(this.target);
    const r = await run(this.o.gh ?? 'gh', args, { input, timeoutMs: 60_000, env: { ...(this.o.env ?? process.env), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    if (r.error) throw new Error(`gh not available: ${r.error}. Install GitHub CLI and run \`gh auth login\`.`);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return r.stdout;
  }

  async init(): Promise<void> {
    if (!this.o.live) return;
    await this.gh(['repo', 'view', this.o.repo, '--json', 'name']);
  }

  private label(c: TrackerCategory): string {
    return `${this.o.labelPrefix}${CATEGORY_LABEL[c]}`;
  }

  private async ensureLabels(): Promise<void> {
    if (this.labelsEnsured) return;
    for (const c of Object.keys(LABEL_COLORS) as TrackerCategory[]) {
      await this.gh(['label', 'create', this.label(c), '-R', this.o.repo, '--force', '--color', LABEL_COLORS[c], '--description', 'Managed by Agent Control Center']);
    }
    this.labelsEnsured = true;
  }

  private toIssue(g: GhIssue): TrackerIssue {
    const names = g.labels.map((l) => l.name);
    const accLabel = names.find((n) => n.startsWith(this.o.labelPrefix));
    let category: TrackerCategory = 'todo';
    if (g.state === 'CLOSED') category = /not[_ ]planned/i.test(g.stateReason ?? '') ? 'canceled' : 'done';
    else if (accLabel) {
      const found = (Object.entries(CATEGORY_LABEL) as [TrackerCategory, string][]).find(([, v]) => `${this.o.labelPrefix}${v}` === accLabel);
      if (found && found[0] !== 'done' && found[0] !== 'canceled') category = found[0];
    }
    const { description, acceptance } = splitBody(g.body ?? '');
    return {
      id: String(g.number),
      key: `GH-${g.number}`,
      url: g.url,
      title: g.title,
      description,
      acceptance,
      labels: names.filter((n) => !n.startsWith(this.o.labelPrefix)),
      priority: null,
      status: { category, native: g.state === 'CLOSED' ? `closed (${g.stateReason ?? 'completed'})` : accLabel ?? 'open' },
      parentKey: null,
      updatedAt: g.updatedAt,
    };
  }

  async createIssue(i: NewIssue): Promise<TrackerIssue> {
    const args = ['issue', 'create', '-R', this.o.repo, '--title', i.title, '--body-file', '-'];
    for (const l of i.labels) args.push('--label', l);
    const url = (await this.gh(args, composeBody(i.description, i.acceptance))).trim().split('\n').pop() ?? '';
    const n = /\/issues\/(\d+)/.exec(url)?.[1];
    if (!n) throw new Error(`gh issue create returned no issue URL: ${url}`);
    return (await this.getIssue(n))!;
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    const out = await this.gh(['issue', 'view', id, '-R', this.o.repo, '--json', FIELDS]);
    return this.toIssue(JSON.parse(out) as GhIssue);
  }

  async listIssues(o: { updatedSince?: string | null } = {}): Promise<TrackerIssue[]> {
    const args = ['issue', 'list', '-R', this.o.repo, '--state', 'all', '--limit', '200', '--json', FIELDS];
    if (o.updatedSince) args.push('--search', `updated:>=${o.updatedSince.slice(0, 19)}Z`);
    return (JSON.parse(await this.gh(args)) as GhIssue[]).map((g) => this.toIssue(g));
  }

  async setStatus(id: string, category: TrackerCategory, _lifecycle: LifecycleState): Promise<void> {
    await this.ensureLabels();
    const cur = JSON.parse(await this.gh(['issue', 'view', id, '-R', this.o.repo, '--json', 'labels,state'])) as Pick<GhIssue, 'labels' | 'state'>;
    const remove = cur.labels.map((l) => l.name).filter((n) => n.startsWith(this.o.labelPrefix) && n !== this.label(category));
    const args = ['issue', 'edit', id, '-R', this.o.repo, '--add-label', this.label(category)];
    if (remove.length) args.push('--remove-label', remove.join(','));
    await this.gh(args);
    if (category === 'done' || category === 'canceled') {
      if (cur.state === 'OPEN') await this.gh(['issue', 'close', id, '-R', this.o.repo, '--reason', category === 'done' ? 'completed' : 'not planned']);
    } else if (cur.state === 'CLOSED') await this.gh(['issue', 'reopen', id, '-R', this.o.repo]);
  }

  async comment(id: string, body: string): Promise<void> {
    await this.gh(['issue', 'comment', id, '-R', this.o.repo, '--body-file', '-'], body);
  }
}
