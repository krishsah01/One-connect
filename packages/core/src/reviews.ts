// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Independent, SHA-bound reviews and the integration-merge gates. Pure: the daemon supplies git
// facts (current branch heads, conflicts), this decides what is still true.
import type { ProjectConfig } from './config.ts';
import type { Actor, Assignment, ControlState, Evidence, MergeAction, ReviewTarget, WorkItem } from './entities.ts';

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  body: string;
  path: string | null;
  line: number | null;
  /** Issue created in the tracker for this finding (blocker/major), once linked. */
  followUpWorkItemId: string | null;
}

export type ReviewVerdict = 'approve' | 'request_changes';

export interface ReviewRecord {
  id: string;
  workItemId: string;
  /** The exact commit reviewed. Any other head makes this review stale. */
  targetSha: string;
  sourceBranch: string | null;
  baseSha: string | null;
  authorAgentId: string | null;
  reviewer: Actor;
  assignmentId: string | null;
  runId: string | null;
  workflowId: string | null;
  taskId: string | null;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  /** Verified evidence the reviewer was shown (check results at targetSha). */
  evidenceIds: string[];
  source: 'mcp' | 'handoff' | 'human';
  at: string;
  staleAt: string | null;
  staleReason: string | null;
}

export interface IntegrationMerge {
  id: string;
  workItemId: string;
  decisionId: string;
  reviewId: string;
  sourceBranch: string;
  sourceSha: string;
  target: string;
  targetShaBefore: string;
  mergeSha: string;
  /** worktree = merged in the checked-out target worktree; ref = merged in a scratch worktree, then the ref was advanced. */
  method: 'worktree' | 'ref';
  at: string;
  postChecks: { status: 'pending' | 'passed' | 'failed' | 'none'; evidenceIds: string[]; at: string | null };
}

export interface MergeGate {
  id: 'target' | 'source' | 'lifecycle' | 'review' | 'checks' | 'workflow' | 'decision' | 'conflicts' | 'worktree';
  label: string;
  ok: boolean;
  detail: string;
}

const SEVERITY_ALIASES: Record<string, FindingSeverity> = { blocker: 'blocker', critical: 'blocker', high: 'major', major: 'major', medium: 'minor', minor: 'minor', low: 'nit', nit: 'nit', nitpick: 'nit' };

export function normalizeSeverity(s: unknown): FindingSeverity {
  return SEVERITY_ALIASES[String(s ?? '').toLowerCase()] ?? 'minor';
}

/** Parse a handoff "Findings:" line like "blocker: src/a.ts:12 - null deref". */
export function parseFindingText(text: string): Omit<ReviewFinding, 'id' | 'followUpWorkItemId'> {
  let rest = text.trim();
  let severity: FindingSeverity = 'minor';
  const sev = /^\[?(blocker|critical|high|major|medium|minor|low|nit|nitpick)\]?\s*[:\-–]?\s*/i.exec(rest);
  if (sev) {
    severity = normalizeSeverity(sev[1]);
    rest = rest.slice(sev[0].length);
  }
  let path: string | null = null;
  let line: number | null = null;
  const loc = /^`?([\w@./-]+\.[A-Za-z0-9]+)(?::(\d+))?`?\s*[:\-–]?\s*/.exec(rest);
  if (loc && (loc[1].includes('/') || /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|css|html|java|rb|swift|kt)$/.test(loc[1]))) {
    path = loc[1];
    line = loc[2] ? Number(loc[2]) : null;
    rest = rest.slice(loc[0].length);
  }
  const title = (rest.split(/(?<=[.!?])\s/)[0] || rest || text).trim().slice(0, 140);
  return { severity, title: title || 'Finding', body: text.trim(), path, line };
}

/** Stable, dependency-free hash of a merge binding (FNV-1a, two lanes). */
export function mergeActionHash(a: Omit<MergeAction, 'hash' | 'kind'>): string {
  const s = ['merge', a.workItemId, a.sourceBranch, a.sourceSha, a.target, a.targetSha, a.reviewId].join('\u0000');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function reviewsForItem(state: Pick<ControlState, 'reviews'>, workItemId: string): ReviewRecord[] {
  return Object.values(state.reviews ?? {})
    .filter((r) => r.workItemId === workItemId)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function isIndependentReview(r: Pick<ReviewRecord, 'reviewer' | 'authorAgentId'>): boolean {
  return !(r.reviewer.type === 'agent' && r.authorAgentId && r.reviewer.id === r.authorAgentId) && r.reviewer.type !== 'system';
}

/** The latest non-stale review at `sha` if it is an independent approval; else null. */
export function currentApproval(state: Pick<ControlState, 'reviews'>, workItemId: string, sha: string | null): ReviewRecord | null {
  if (!sha) return null;
  const at = reviewsForItem(state, workItemId).filter((r) => r.targetSha === sha && !r.staleAt);
  const last = at.at(-1);
  return last && last.verdict === 'approve' && isIndependentReview(last) ? last : null;
}

/** The author's latest work assignment for an issue (the branch being reviewed/merged). */
export function authorAssignment(state: Pick<ControlState, 'assignments'>, workItemId: string, branch?: string | null): Assignment | null {
  const all = Object.values(state.assignments).filter((a) => a.workItemId === workItemId && a.kind !== 'review' && a.branch && (!branch || a.branch === branch));
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
}

export function requiredCheckNames(project: Pick<ProjectConfig, 'checks' | 'required_checks'>, assignment?: Pick<Assignment, 'requiredChecks'> | null): string[] {
  return assignment?.requiredChecks?.length ? assignment.requiredChecks : (project.required_checks ?? Object.keys(project.checks));
}

export interface CheckStatus {
  name: string;
  command: string | null;
  status: 'pass' | 'fail' | 'missing';
  evidence: Evidence | null;
}

/** Latest control-center-recorded result of each check at exactly `sha`. Agent claims never count. */
export function checksAt(item: Pick<WorkItem, 'evidence'>, project: Pick<ProjectConfig, 'checks'>, names: readonly string[], sha: string | null): CheckStatus[] {
  return names.map((name) => {
    const command = project.checks[name] ?? null;
    if (!command || !sha) return { name, command, status: 'missing', evidence: null };
    const ev = item.evidence.filter((e) => e.verified && (e.kind === 'test' || e.kind === 'command') && e.command === command && e.sha === sha).at(-1) ?? null;
    return { name, command, status: !ev ? 'missing' : ev.exitCode === 0 ? 'pass' : 'fail', evidence: ev };
  });
}

/** Review notes are the only thing a reviewer may commit. */
export const REVIEW_NOTES_PATH = '.acc-review/**';

export interface ReviewTextInput {
  project: Pick<ProjectConfig, 'name' | 'protected_branches' | 'checks'>;
  agent: { name: string; role: string; instructions?: string };
  item: Pick<WorkItem, 'key' | 'title' | 'description' | 'acceptance'>;
  assignmentId: string;
  scope: string;
  review: ReviewTarget;
  authorName: string;
  worktree: string | null;
  branch: string | null;
  checks: CheckStatus[];
  authorHandoff: string | null;
  relay: boolean;
}

/** The reviewer's assignment: the exact SHA, the author, and the evidence recorded at that SHA. */
export function generateReviewText(i: ReviewTextInput): string {
  const r = i.review;
  const out: string[] = [];
  out.push(`You are ${i.agent.name}, independently reviewing work by ${i.authorName} on the project "${i.project.name}".`);
  out.push(`Assignment ${i.assignmentId} for ${i.item.key ?? '(pending key)'}: review "${i.item.title}"`);
  if (i.scope.trim()) out.push('', '## Review focus', i.scope.trim());
  if (i.agent.instructions?.trim()) out.push('', '## Agent instructions', i.agent.instructions.trim(), 'These instructions do not override the review scope or human approval policy.');
  out.push('', '## Exact commit under review');
  out.push(`- Target SHA: ${r.targetSha}`);
  out.push(`- Author branch: ${r.sourceBranch ?? '(unknown)'}`);
  if (r.baseSha) out.push(`- Base: ${r.baseSha} (review \`git diff ${r.baseSha.slice(0, 12)}..${r.targetSha.slice(0, 12)}\`)`);
  if (!i.relay) {
    out.push(`- Your worktree: ${i.worktree ?? '(created at dispatch)'} on ${i.branch ?? '(review branch)'}, checked out at exactly the target SHA.`);
    out.push(`- Do not change code and do not commit. Only ${REVIEW_NOTES_PATH} is writable; a hook rejects anything else. Never push.`);
    out.push(`- Protected branches (never): ${i.project.protected_branches.join(', ') || 'none'}.`);
  }
  out.push('Your verdict applies to this SHA only. Any later commit invalidates it.');
  out.push('', '## Goal of the change');
  out.push(i.item.description.trim() || '(no description in the tracker)');
  if (i.item.acceptance.length) {
    out.push('', '## Acceptance criteria');
    for (const a of i.item.acceptance) out.push(`- ${a}`);
  }
  out.push('', '## Evidence the control center recorded at this SHA');
  if (i.checks.length === 0) out.push('- no required checks configured');
  for (const c of i.checks) out.push(`- ${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'NOT RECORDED'} ${c.name}: \`${c.command ?? c.name}\`${c.evidence ? ` (${c.evidence.summary})` : ''}`);
  if (i.authorHandoff) out.push('', "## Author's handoff (a claim, not evidence)", i.authorHandoff);
  out.push('', '## Report');
  if (!i.relay) out.push('Call the `acc` MCP tool `submit_review` with `reviewed_sha` (the target SHA), `verdict` (approve | request_changes), a `summary` and typed `findings` (severity blocker | major | minor | nit, title, body, path, line).');
  out.push('Approve only if the acceptance criteria are met and there are no blocker or major findings. Blocker, major and minor findings become linked follow-up issues.');
  out.push('', '## Handoff (required)');
  out.push('End your final message with this block (the Verdict and Findings lines are required for reviews):');
  out.push('### Handoff', `Done: reviewed ${r.targetSha.slice(0, 12)}`, 'Evidence:', '- `<exact command>` → <actual result>', 'Commit: none', 'Blocked: none', 'Next: <recommended next step>', 'Verdict: approve | request changes', 'Findings:', '- <severity>: <path>:<line> - <finding>');
  return out.join('\n');
}

export interface MergeGateInput {
  state: Pick<ControlState, 'workItems' | 'assignments' | 'reviews' | 'workflows'>;
  project: Pick<ProjectConfig, 'checks' | 'required_checks' | 'integration_branch' | 'protected_branches' | 'production_branch'>;
  workItemId: string;
  sourceBranch: string | null;
  /** Current head of the source branch, read from git by the caller. */
  sourceSha: string | null;
  target: string;
}

export function evaluateMergeGates(i: MergeGateInput): MergeGate[] {
  const gates: MergeGate[] = [];
  const item = i.state.workItems[i.workItemId];
  const p = i.project;
  const protectedTarget = p.protected_branches.includes(i.target) || (p.production_branch !== undefined && p.production_branch !== null && p.production_branch === i.target);
  gates.push(
    protectedTarget
      ? { id: 'target', label: 'Target branch', ok: false, detail: `${i.target} is protected; One Connect only merges into ${p.integration_branch}` }
      : i.target !== p.integration_branch
        ? { id: 'target', label: 'Target branch', ok: false, detail: `${i.target} is not the integration branch (${p.integration_branch})` }
        : { id: 'target', label: 'Target branch', ok: true, detail: `${i.target} (integration, local only)` },
  );
  if (!item) return [...gates, { id: 'source', label: 'Source', ok: false, detail: `unknown work item ${i.workItemId}` }];
  const author = authorAssignment(i.state, i.workItemId, i.sourceBranch);
  gates.push(
    !i.sourceBranch || !i.sourceSha
      ? { id: 'source', label: 'Source commit', ok: false, detail: 'no agent branch with commits for this issue' }
      : !item.branches.includes(i.sourceBranch)
        ? { id: 'source', label: 'Source commit', ok: false, detail: `${i.sourceBranch} is not a branch of ${item.key ?? item.id}` }
        : { id: 'source', label: 'Source commit', ok: true, detail: `${i.sourceBranch} @ ${i.sourceSha.slice(0, 10)}` },
  );
  gates.push(item.state === 'approved' ? { id: 'lifecycle', label: 'Lifecycle', ok: true, detail: 'approved' } : { id: 'lifecycle', label: 'Lifecycle', ok: false, detail: `${item.key ?? item.id} is ${item.state.replace(/_/g, ' ')}, not approved` });

  const reviews = reviewsForItem(i.state, i.workItemId);
  const approval = currentApproval(i.state, i.workItemId, i.sourceSha);
  const latestAt = reviews.filter((r) => r.targetSha === i.sourceSha && !r.staleAt).at(-1);
  const staleApproval = reviews.filter((r) => r.verdict === 'approve').at(-1);
  gates.push(
    approval
      ? { id: 'review', label: 'Independent approval', ok: true, detail: `${approval.reviewer.type === 'agent' ? approval.reviewer.id : 'human'} approved ${approval.targetSha.slice(0, 10)}` }
      : latestAt?.verdict === 'request_changes'
        ? { id: 'review', label: 'Independent approval', ok: false, detail: `changes requested at ${latestAt.targetSha.slice(0, 10)}` }
        : latestAt && !isIndependentReview(latestAt)
          ? { id: 'review', label: 'Independent approval', ok: false, detail: 'the author cannot approve their own work' }
          : staleApproval && staleApproval.targetSha !== i.sourceSha
            ? { id: 'review', label: 'Independent approval', ok: false, detail: `approval is for ${staleApproval.targetSha.slice(0, 10)}; the branch is now ${i.sourceSha?.slice(0, 10) ?? 'unknown'} (stale)` }
            : { id: 'review', label: 'Independent approval', ok: false, detail: 'no independent approval at this commit' },
  );

  const names = requiredCheckNames(p, author);
  const checks = checksAt(item, p, names, i.sourceSha);
  const bad = checks.filter((c) => c.status !== 'pass');
  gates.push(
    names.length === 0
      ? { id: 'checks', label: 'Required checks', ok: false, detail: 'no required checks configured; merging needs scoped verification evidence' }
      : bad.length
        ? { id: 'checks', label: 'Required checks', ok: false, detail: bad.map((c) => `${c.name} ${c.status === 'fail' ? 'failed' : 'not recorded'} at ${i.sourceSha?.slice(0, 10) ?? '?'}`).join('; ') }
        : { id: 'checks', label: 'Required checks', ok: true, detail: checks.map((c) => `${c.name} green`).join(', ') },
  );

  const wfs = Object.values(i.state.workflows ?? {}).filter((w) => w.status !== 'draft' && w.status !== 'canceled' && w.definition.tasks.some((t) => t.workItemId === i.workItemId));
  const wfProblems: string[] = [];
  for (const w of wfs) {
    if (w.status === 'paused') wfProblems.push(`workflow "${w.definition.name}" is paused`);
    const mine = w.definition.tasks.filter((t) => t.workItemId === i.workItemId);
    const needed = new Set<string>();
    const walk = (id: string) => {
      if (needed.has(id)) return;
      needed.add(id);
      for (const d of w.definition.tasks.find((t) => t.id === id)?.dependsOn ?? []) walk(d);
    };
    for (const t of mine) walk(t.id);
    for (const id of needed) if (w.tasks[id]?.status !== 'done') wfProblems.push(`${w.definition.name}/${id} is ${w.tasks[id]?.status ?? 'pending'}`);
  }
  gates.push(wfProblems.length ? { id: 'workflow', label: 'Workflow gates', ok: false, detail: wfProblems.join('; ') } : { id: 'workflow', label: 'Workflow gates', ok: true, detail: wfs.length ? 'all prerequisite tasks done' : 'not part of a workflow' });
  return gates;
}
