// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Linear over its public GraphQL API. The personal API key is read at runtime from the macOS
// Keychain or LINEAR_API_KEY, never written to config, logs or the event store, and added to the
// redaction denylist.
import type { LifecycleState, TrackerCategory } from '@acc/core';
import { run } from '../../exec.ts';
import { composeBody, splitBody, TrackerNotLiveError, type NewIssue, type TrackerAdapter, type TrackerIssue } from './types.ts';

export const KEYCHAIN_SERVICE = 'agent-control-center';
export const KEYCHAIN_ACCOUNT = 'linear';

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface LState {
  id: string;
  name: string;
  type: string;
  position: number;
}

interface LIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  priority: number | null;
  updatedAt: string;
  state: { name: string; type: string };
  labels: { nodes: { name: string }[] };
  parent: { identifier: string } | null;
}

const ISSUE_FIELDS = 'id identifier url title description priority updatedAt state { name type } labels { nodes { name } } parent { identifier }';

export async function readLinearKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.LINEAR_API_KEY) return env.LINEAR_API_KEY;
  if (process.platform !== 'darwin') return null;
  const r = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export function categoryOf(state: { name: string; type: string }): TrackerCategory {
  switch (state.type) {
    case 'backlog':
    case 'triage':
      return 'backlog';
    case 'unstarted':
      return 'todo';
    case 'started':
      return /review/i.test(state.name) ? 'in_review' : 'in_progress';
    case 'completed':
      return 'done';
    case 'canceled':
    case 'duplicate':
      return 'canceled';
    default:
      return 'todo';
  }
}

export type LinearOptions = {
  team: string;
  project?: string;
  live: boolean;
  apiUrl: string;
  stateNames: Record<string, string>;
  fetch?: Fetch;
  readKey?: () => Promise<string | null>;
  /** Called with the key once read, so the daemon can add it to the redaction denylist. */
  onSecret?: (v: string) => void;
};

export class LinearTracker implements TrackerAdapter {
  readonly type = 'linear' as const;
  readonly target: string;
  private key: string | null = null;
  private teamId: string | null = null;
  private projectId: string | null = null;
  private states: LState[] = [];

  private o: LinearOptions;

  constructor(o: LinearOptions) {
    this.o = o;
    this.target = `Linear team ${o.team}`;
  }

  get live(): boolean {
    return this.o.live;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.o.live) throw new TrackerNotLiveError(this.target);
    if (!this.key) {
      this.key = await (this.o.readKey ?? readLinearKey)();
      if (!this.key) {
        throw new Error(`no Linear API key: store one with \`security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w\` (macOS) or set LINEAR_API_KEY`);
      }
      this.o.onSecret?.(this.key);
    }
    const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
    const res = await f(this.o.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: this.key }, body: JSON.stringify({ query, variables }) });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) throw new Error(`Linear API ${res.status}: ${body.errors?.map((e) => e.message).join('; ') ?? 'request failed'}`);
    return body.data as T;
  }

  async init(): Promise<void> {
    if (!this.o.live) return;
    const d = await this.gql<{ teams: { nodes: { id: string; key: string; states: { nodes: LState[] } }[] } }>(
      'query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type position } } } } }',
      { key: this.o.team },
    );
    const team = d.teams.nodes[0];
    if (!team) throw new Error(`Linear team with key ${this.o.team} not found`);
    this.teamId = team.id;
    this.states = team.states.nodes;
    if (this.o.project) {
      const p = await this.gql<{ projects: { nodes: { id: string }[] } }>('query($name: String!) { projects(filter: { name: { eq: $name } }) { nodes { id } } }', { name: this.o.project });
      this.projectId = p.projects.nodes[0]?.id ?? null;
    }
  }

  private async ensureInit(): Promise<void> {
    if (!this.teamId) await this.init();
  }

  private toIssue(i: LIssue): TrackerIssue {
    const { description, acceptance } = splitBody(i.description ?? '');
    return {
      id: i.id,
      key: i.identifier,
      url: i.url,
      title: i.title,
      description,
      acceptance,
      labels: i.labels.nodes.map((l) => l.name),
      priority: i.priority,
      status: { category: categoryOf(i.state), native: i.state.name },
      parentKey: i.parent?.identifier ?? null,
      updatedAt: i.updatedAt,
    };
  }

  async createIssue(n: NewIssue): Promise<TrackerIssue> {
    await this.ensureInit();
    let labelIds: string[] | undefined;
    if (n.labels.length) {
      const l = await this.gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>('query($names: [String!]) { issueLabels(filter: { name: { in: $names } }) { nodes { id name } } }', { names: n.labels });
      labelIds = l.issueLabels.nodes.map((x) => x.id);
    }
    const input: Record<string, unknown> = { teamId: this.teamId, title: n.title, description: composeBody(n.description, n.acceptance) };
    if (n.priority !== undefined && n.priority !== null) input.priority = n.priority;
    if (this.projectId) input.projectId = this.projectId;
    if (labelIds?.length) input.labelIds = labelIds;
    const d = await this.gql<{ issueCreate: { success: boolean; issue: LIssue } }>(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { input });
    if (!d.issueCreate.success) throw new Error('Linear issueCreate failed');
    return this.toIssue(d.issueCreate.issue);
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    const d = await this.gql<{ issue: LIssue | null }>(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id });
    return d.issue ? this.toIssue(d.issue) : null;
  }

  async listIssues(o: { updatedSince?: string | null } = {}): Promise<TrackerIssue[]> {
    await this.ensureInit();
    const filter: Record<string, unknown> = { team: { id: { eq: this.teamId } } };
    if (o.updatedSince) filter.updatedAt = { gt: o.updatedSince };
    if (this.projectId) filter.project = { id: { eq: this.projectId } };
    const d = await this.gql<{ issues: { nodes: LIssue[] } }>(`query($filter: IssueFilter) { issues(filter: $filter, first: 100, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`, { filter });
    return d.issues.nodes.map((i) => this.toIssue(i));
  }

  pickState(category: TrackerCategory): LState | null {
    const named = this.o.stateNames[category];
    if (named) return this.states.find((s) => s.name.toLowerCase() === named.toLowerCase()) ?? null;
    const byPos = (xs: LState[]) => [...xs].sort((a, b) => a.position - b.position)[0] ?? null;
    switch (category) {
      case 'backlog':
        return byPos(this.states.filter((s) => s.type === 'backlog')) ?? byPos(this.states.filter((s) => s.type === 'unstarted'));
      case 'todo':
        return byPos(this.states.filter((s) => s.type === 'unstarted'));
      case 'in_progress':
        return byPos(this.states.filter((s) => s.type === 'started' && !/review/i.test(s.name))) ?? byPos(this.states.filter((s) => s.type === 'started'));
      case 'in_review':
        return byPos(this.states.filter((s) => s.type === 'started' && /review/i.test(s.name))) ?? byPos(this.states.filter((s) => s.type === 'started'));
      case 'done':
        return byPos(this.states.filter((s) => s.type === 'completed'));
      case 'canceled':
        return byPos(this.states.filter((s) => s.type === 'canceled'));
    }
  }

  async setStatus(id: string, category: TrackerCategory, _lifecycle: LifecycleState): Promise<void> {
    await this.ensureInit();
    const state = this.pickState(category);
    if (!state) throw new Error(`no Linear workflow state for ${category}; set tracker.state_names.${category}`);
    const d = await this.gql<{ issueUpdate: { success: boolean } }>('mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }', { id, stateId: state.id });
    if (!d.issueUpdate.success) throw new Error('Linear issueUpdate failed');
  }

  async comment(id: string, body: string): Promise<void> {
    const d = await this.gql<{ commentCreate: { success: boolean } }>('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: id, body } });
    if (!d.commentCreate.success) throw new Error('Linear commentCreate failed');
  }
}
