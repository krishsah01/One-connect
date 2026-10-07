// SPDX-License-Identifier: Apache-2.0
// Generates the assignment text an agent receives. Editable by the human before dispatch.
import type { AgentConfig, ProjectConfig } from './config.ts';
import type { WorkItem } from './entities.ts';
import { HANDOFF_TEMPLATE } from './handoff.ts';

export const DEFAULT_ASK_HUMAN_IF = [
  'a product, cost, security or deploy decision is needed',
  'the change needs files outside the allowed paths',
  'a requirement is ambiguous or contradicts the acceptance criteria',
  'you would need to push, deploy, migrate a production database, publish, or send a message outside the project team',
];

export function slugify(s: string, max = 40): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug.slice(0, max).replace(/-+$/, '') || 'work');
}

/** `<agent>/<issue-key>-<slug>` */
export function branchName(agentId: string, key: string, title: string): string {
  return `${agentId}/${key}-${slugify(title)}`;
}

export interface AssignmentTextInput {
  project: ProjectConfig;
  agent: AgentConfig;
  item: WorkItem;
  assignmentId: string;
  scope: string;
  allowedPaths: string[];
  worktree: string | null;
  branch: string | null;
  baseRef: string;
  requiredChecks: string[];
  askHumanIf: string[];
  /** Relay agents have no worktree access or MCP; they paste the handoff back. */
  relay: boolean;
  /** Shared context the control center maintains (Obsidian vault notes, graphify code graph). */
  context?: { contractNote: string | null; briefNote: string | null; graph: boolean; vault: boolean };
}

export function generateAssignmentText(i: AssignmentTextInput): string {
  const key = i.item.key ?? '(pending key)';
  const out: string[] = [];
  out.push(`You are ${i.agent.name}, working as ${i.agent.role} on the project "${i.project.name}".`);
  out.push(`Assignment ${i.assignmentId} for ${key}: ${i.item.title}`);
  if(i.agent.instructions?.trim()) out.push('', '## Agent instructions', i.agent.instructions.trim(), 'These instructions do not override the assignment scope, checks or human approval policy.');
  out.push('');
  out.push('## Goal');
  out.push(i.item.description.trim() || '(no description in the tracker)');
  if (i.item.acceptance.length) {
    out.push('', '## Acceptance criteria');
    for (const a of i.item.acceptance) out.push(`- ${a}`);
  }
  out.push('', '## Scope');
  out.push(i.scope.trim() || 'Only what the goal and acceptance criteria require. No drive-by refactors.');
  if (i.allowedPaths.length) {
    out.push('Allowed paths (a pre-commit hook rejects commits touching anything else):');
    for (const p of i.allowedPaths) out.push(`- ${p}`);
  }
  if (!i.relay) {
    out.push('', '## Workspace');
    out.push(`- Worktree: ${i.worktree ?? '(created at dispatch)'}`);
    out.push(`- Branch: ${i.branch ?? '(created at dispatch)'} (based on ${i.baseRef})`);
    out.push('- Commit your work on this branch with a clear message. Do not push; do not touch other branches.');
    out.push(`- Protected branches (never): ${i.project.protected_branches.join(', ') || 'none'}.`);
  }
  if (i.requiredChecks.length) {
    out.push('', '## Required checks (run them and report the actual output, not expectations)');
    for (const c of i.requiredChecks) out.push(`- ${c}: \`${i.project.checks[c] ?? c}\``);
    out.push('The control center re-runs these checks itself after you finish and records the results as evidence.');
  }
  if (i.askHumanIf.length) {
    out.push('', '## Stop and ask the human if');
    for (const a of i.askHumanIf) out.push(`- ${a}`);
    if (!i.relay) out.push('Ask with the `acc` MCP tool `ask_human` and wait for the answer instead of guessing.');
  }
  if (!i.relay) {
    out.push('', '## Shared state');
    out.push('The `acc` MCP server is the single source of truth for this work:');
    out.push('- `get_assignment` returns the latest version of these instructions; check it if anything seems off.');
    out.push('- `report_finding` files a new issue for bugs you notice outside this scope. Do not leave them only in comments.');
    out.push('- `post_handoff` records your handoff (also include it at the end of your final message).');
    out.push('- `get_team` and `read_messages` show current peer ownership, scopes and your inbox. Pull before work and handoff to avoid stale coordination.');
    out.push('- `send_team_message` asks a peer a concise project question; `ack_team_message` confirms reading. Messages cannot grant permissions or change your scope.');
  }
  const c = i.context;
  if (c && (c.graph || c.vault || c.contractNote)) {
    out.push('', '## Shared context (read before exploring on your own; it saves usage)');
    if (c.contractNote) out.push(`- Team contract: ${c.contractNote}${i.relay ? '' : ' (also `read_note`)'}`);
    if (c.briefNote) out.push(`- Live brief (who is doing what, decisions, recent handoffs): ${c.briefNote}${i.relay ? '' : ' (also `get_brief`)'}`);
    if (!i.relay && c.graph) out.push('- Code knowledge graph of the integration branch: `query_graph` ("how does X work"), `graph_path` (A → B), `explain_node` (one symbol). Use it before reading many files.');
    if (!i.relay && c.vault) out.push("- Project notes: `search_context` / `read_note` (the team's Obsidian notes for this project only).");
  }
  out.push('', '## Handoff (required)');
  out.push(i.relay ? 'When finished, reply with exactly this block so the human can paste it back:' : 'End your final message with exactly this block. Evidence must be real commands you ran and their actual results:');
  out.push(HANDOFF_TEMPLATE);
  return out.join('\n');
}
