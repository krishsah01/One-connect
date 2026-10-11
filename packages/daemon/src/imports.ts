// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Preview is read-only. Imported items live in the local tracker with immutable source identity.
import { newId, HUMAN, type WorkItem } from '@acc/core';
import { GitHubTracker, LinearTracker, type TrackerIssue, type TrackerAdapter } from './adapters/trackers/index.ts';
import { getSecret } from './secrets.ts';
import type { Kernel, WorkCommands } from './kernel.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type IssueImportsDeps = Kernel & Pick<WorkCommands, 'createIssue'> & { readonly tracker: TrackerAdapter };

export interface ImportSource {
  id: string;
  name: string;
  type: 'github' | 'linear';
  enabled: boolean;
  repo?: string;
  team?: string;
  project?: string;
  fixture?: boolean;
}
const example = (type: string, n: number, title: string): TrackerIssue => ({
  id: String(n), key: `${type === 'github' ? 'GH' : 'ENG'}-${n}`, url: type === 'github' ? `https://github.com/example/sample/issues/${n}` : null,
  title, description: 'Offline example for testing import. No vendor connection is active.', acceptance: ['Record test evidence'], labels: ['demo'], priority: 3,
  status: { category: 'todo', native: 'Todo' }, parentKey: null, updatedAt: '2026-10-06T00:00:00.000Z',
});
export class IssueImports {
  private previews = new Map<string, { source: ImportSource; issues: TrackerIssue[]; at: number }>();
  readonly d: IssueImportsDeps;
  constructor(d: IssueImportsDeps) { this.d = d; }
  sources(): ImportSource[] {
    const configured = this.d.config.import_sources;
    return [
      ...configured,
      ...(this.d.baseEnv().ACC_DEMO_FIXTURES === '1' ? [
        { id: 'demo-github', name: 'GitHub examples', type: 'github' as const, enabled: true, fixture: true },
        { id: 'demo-linear', name: 'Linear examples', type: 'linear' as const, enabled: true, fixture: true },
      ] : []),
    ];
  }
  async preview(sourceId: string, query = '') {
    const source = this.sources().find(s => s.id === sourceId);
    if (!source) throw new Error('Unknown import source');
    if (!source.enabled) throw new Error('This source is disabled. Enable it in import_sources after approving the connection.');
    let issues: TrackerIssue[];
    if (source.fixture) issues = [example(source.type, 12, 'Add math helper documentation'), example(source.type, 13, 'Cover negative inputs in tests')];
    else if (source.type === 'github') {
      const t = new GitHubTracker({ repo: source.repo!, live: true, labelPrefix: 'acc:' });
      issues = await t.listIssues();
    } else {
      const t = new LinearTracker({ team: source.team!, project: source.project, live: true, apiUrl: 'https://api.linear.app/graphql', stateNames: {}, fetch: this.d.egress.fetch,
        readKey: () => getSecret('linear', this.d.baseEnv()), onSecret: v => this.d.addSecret(v) });
      issues = await t.listIssues();
    }
    issues = issues.filter(i => !['done', 'canceled'].includes(i.status.category) && (!query || `${i.key} ${i.title} ${i.labels.join(' ')}`.toLowerCase().includes(query.toLowerCase())));
    const token = newId('preview');
    for (const [k, p] of this.previews) if (Date.now() - p.at > 600_000) this.previews.delete(k);
    this.previews.set(token, { source, issues, at: Date.now() });
    return { token, source, issues: issues.map(i => ({ ...i, imported: this.existing(source.id, i.id) !== undefined })), limited: source.type === 'github' ? 200 : 100 };
  }
  private existing(sourceId: string, issueId: string) {
    return Object.values(this.d.state.workItems).find(w => w.origin?.sourceId === sourceId && w.origin.issueId === issueId);
  }
  import(token: string, ids: string[]) {
    const p = this.previews.get(token);
    if (!p || Date.now() - p.at > 600_000) throw new Error('Preview expired. Preview this source again.');
    if (!ids.length || ids.some(id => !p.issues.some(i => i.id === id))) throw new Error('Select issues from this preview');
    // Deliberately local: no status/comment can ever be routed to the wrong external tracker.
    if (this.d.tracker.type !== 'local') throw new Error('Multi-source import currently requires the local tracker; the configured external tracker already imports through polling.');
    const items: WorkItem[] = [];
    let skipped = 0;
    for (const id of new Set(ids)) {
      if (this.existing(p.source.id, id)) { skipped++; continue; }
      const i = p.issues.find(i => i.id === id)!;
      const item = this.d.createIssue({ title: i.title, description: i.description, acceptance: i.acceptance, labels: i.labels, priority: i.priority ?? 3 }, HUMAN);
      this.d.commit([{ type: 'work_item.updated', actor: HUMAN, workItemId: item.id, data: { patch: {
        origin: { sourceId: p.source.id, type: p.source.type, issueId: id, key: i.key, url: i.url, importedAt: this.d.nowIso(), readOnly: true },
      } } }]);
      items.push(this.d.state.workItems[item.id]);
    }
    return { items, skipped };
  }
}
