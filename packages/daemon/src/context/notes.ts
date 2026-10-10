// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Markdown notes generated from real state only: the team contract (one shared copy of the
// instructions), a live brief, one note per issue, per handoff and per answered decision.
// Every claim links to where it came from; nothing implies a merge, deploy or passing test
// without recorded evidence.
import type { Approval, ControlCenterConfig, ControlState, Run, WorkItem } from '@acc/core';
import { DEFAULT_ASK_HUMAN_IF, formatHandoff, HANDOFF_TEMPLATE, LIFECYCLE_LABELS, ruleEnabled, RULE_NAMES, isManualRelay } from '@acc/core';
import { safeName } from './vault.ts';

export interface NoteLinks {
  issue(key: string): string;
  handoff(run: Run & { workItemKey?: string | null }): string;
  decision(a: Approval): string;
  link(rel: string, label?: string): string;
  brief: string;
  contract: string;
  graphReport: string;
}

const fm = (o: Record<string, unknown>) =>
  `---\n${Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join('\n')}\n---\n`;

const ago = (iso: string | null, now: number) => {
  if (!iso) return '';
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const hhmm = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export function noteLinks(folder: string, link: (rel: string, label?: string) => string): NoteLinks {
  const p = (...xs: string[]) => [folder, ...xs].join('/');
  return {
    issue: (key) => p('Issues', `${safeName(key)}.md`),
    // Key + agent + minute + run suffix: unique even when several handoffs land in the same minute.
    handoff: (run) => p('Handoffs', `${safeName(`${run.endedAt ? run.endedAt.slice(0, 16).replace(/[T:]/g, '-') : 'pending'} ${run.workItemKey ?? ''} ${run.agentId} ${run.id.slice(-4)}`)}.md`),
    decision: (a) => p('Decisions', `${safeName(`${(a.resolvedAt ?? a.createdAt).slice(0, 10)} ${a.title.slice(0, 60)} ${a.id.slice(-4)}`)}.md`),
    link,
    brief: p('Brief.md'),
    contract: p('Team Contract.md'),
    graphReport: p('Graph Report.md'),
  };
}

export function contractNote(cfg: ControlCenterConfig, s: ControlState, L: NoteLinks, graph: boolean): string {
  const p = cfg.project;
  const lines: string[] = [
    fm({ acc: 'team-contract', project: p.name, generated_by: 'agent-control-center' }),
    `# Team contract: ${p.name}`,
    '',
    '> Generated from `control-center.yaml`. This is the one shared copy of the team instructions: edit the config, not this note.',
    '',
    '## Ground rules',
    '- **No issue, no dispatch.** Every run belongs to a tracker issue; statuses move with the work.',
    '- **Pull, not push.** Get your current assignment from the `acc` MCP tool `get_assignment`. Earlier copies may be stale.',
    '- **Evidence over claims.** Finish with the handoff block. The control center re-runs the required checks itself.',
    `- **Never push** to protected branches (${p.protected_branches.join(', ') || 'none'}). Work only on your assignment branch.`,
    '- **Ask, don\'t guess.** Use `ask_human` for product, cost, security or deploy decisions.',
    `- **Zero extra spend.** Included subscription usage only${cfg.policies.zero_extra_spend ? '' : ' (policy relaxed in config)'}; no paid fallbacks.`,
    '- **File findings.** Bugs outside your scope go to `report_finding`, not into comments.',
    '',
    '## Team',
    '| Agent | Subscription | Role | Adapter | Model | Mode |',
    '|---|---|---|---|---|---|',
    ...cfg.agents.map((a) => `| ${a.name} | ${a.subscription ?? '-'} | ${a.role} | ${a.adapter} | ${a.model === 'newest' ? `newest ${a.model_family ?? ''}`.trim() : a.model}${a.effort ? ` @ ${a.effort}` : ''} | ${a.mode} |`),
    '',
    '## Project',
    `- Integration branch: \`${p.integration_branch}\``,
    `- Required checks: ${(p.required_checks ?? Object.keys(p.checks)).map((c) => `${c} → \`${p.checks[c] ?? c}\``).join(', ') || 'none'}`,
    `- Needs a recorded human approval: ${cfg.policies.require_approval.join(', ')}`,
    `- Rules: ${RULE_NAMES.map((r) => `${r.replace('_', ' ')} ${(s.rules[r] ?? ruleEnabled(cfg.policies, r)) ? 'on' : 'off'}`).join(' · ')}`,
    '',
    '## Stop and ask the human if',
    ...DEFAULT_ASK_HUMAN_IF.map((x) => `- ${x}`),
    '',
    '## Handoff format',
    '```markdown',
    HANDOFF_TEMPLATE,
    '```',
    '',
    '## Shared context',
    `- Live brief: ${L.link(L.brief, 'Brief')}`,
    graph ? `- Code graph (graphify, integration branch): \`query_graph\`, \`graph_path\`, \`explain_node\`; report: ${L.link(L.graphReport, 'Graph Report')}` : '- Code graph: not configured',
    '',
  ];
  return lines.join('\n');
}

function itemLine(w: WorkItem, L: NoteLinks, s: ControlState): string {
  const owner = w.ownerAgentId ? s.agents[w.ownerAgentId]?.config.name ?? w.ownerAgentId : 'unassigned';
  return `${w.key ? L.link(L.issue(w.key), w.key) : '(not in tracker yet)'} ${w.title}: ${LIFECYCLE_LABELS[w.state]} · ${owner}`;
}

export function briefNote(cfg: ControlCenterConfig, s: ControlState, L: NoteLinks, nowIso: string): string {
  const now = Date.parse(nowIso);
  const lines: string[] = [fm({ acc: 'brief', project: cfg.project.name, updated: nowIso }), `# Brief: ${cfg.project.name}`, '', `_Built from live control-center state at ${hhmm(nowIso)}. Rewritten on every change._`, ''];

  lines.push('## Agents', '| Agent | Status | Now | Next | Model |', '|---|---|---|---|---|');
  for (const a of Object.values(s.agents)) {
    const nowA = a.queue.now ? s.assignments[a.queue.now] : null;
    const nowItem = nowA ? s.workItems[nowA.workItemId] : null;
    const run = a.activeRunIds.map((id) => s.runs[id]).find(Boolean);
    const next = a.queue.next.map((id) => s.workItems[s.assignments[id]?.workItemId]?.key).filter(Boolean).join(', ');
    const model = isManualRelay(a.config) ? 'in its app' : (a.models.current ?? (a.config.model === 'newest' ? (a.models.newest ?? `newest ${a.config.model_family ?? ''}`.trim()) : a.config.model));
    lines.push(`| ${a.config.name} | ${a.status}${a.limitedUntil ? ' (usage limit)' : ''}${a.pausedReason ? ` (paused: ${a.pausedReason})` : ''} | ${nowItem ? `${nowItem.key ? L.link(L.issue(nowItem.key), nowItem.key) : ''} ${nowItem.title}${run?.startedAt ? ` (${ago(run.startedAt, now)})` : ''}` : '-'} | ${next || '-'} | ${model} |`);
  }

  const pending = Object.values(s.approvals).filter((x) => !x.resolvedAt);
  lines.push('', '## Waiting on you');
  if (pending.length === 0) lines.push('- nothing');
  for (const ap of pending) lines.push(`- [ ] **${s.agents[ap.agentId]?.config.name ?? ap.agentId}** asks: ${ap.title} (${ago(ap.createdAt, now)}): answer in the control center`);

  const alerts = Object.values(s.alerts).filter((x) => !x.resolvedAt).sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1));
  lines.push('', '## Open alerts');
  if (alerts.length === 0) lines.push('- none');
  for (const al of alerts.slice(0, 15)) lines.push(`- ${al.severity === 'critical' ? '🔴' : al.severity === 'warn' ? '🟠' : 'ℹ️'} ${al.message}`);

  const active = Object.values(s.workItems).filter((w) => w.state !== 'verified' && w.state !== 'canceled').sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  lines.push('', '## Work in flight (by priority)');
  if (active.length === 0) lines.push('- none');
  for (const w of active.slice(0, 40)) lines.push(`- ${itemLine(w, L, s)}`);

  const handoffs = Object.values(s.runs).filter((r) => r.handoff && r.endedAt).sort((a, b) => b.endedAt!.localeCompare(a.endedAt!));
  lines.push('', '## Recent handoffs');
  if (handoffs.length === 0) lines.push('- none yet');
  for (const r of handoffs.slice(0, 10)) {
    const w = s.workItems[r.workItemId];
    const tests = r.tests ? ` · checks: ${r.tests.failed === 0 ? '✅' : '❌'} ${r.tests.passed} passed, ${r.tests.failed} failed${r.tests.source === 'daemon' ? ' (verified)' : ' (claimed)'}` : ' · checks: not recorded';
    lines.push(`- ${hhmm(r.endedAt!)} ${L.link(L.handoff({ ...r, workItemKey: w?.key }), `${w?.key ?? '?'} · ${s.agents[r.agentId]?.config.name ?? r.agentId}`)}: ${r.handoff!.done}${tests}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function issueNote(w: WorkItem, s: ControlState, L: NoteLinks): string {
  const runs = w.runIds.map((id) => s.runs[id]).filter(Boolean);
  const lines = [
    fm({ acc: 'issue', key: w.key, state: w.state, owner: w.ownerAgentId, tracker: w.url, branches: w.branches, priority: w.priority }),
    `# ${w.key ?? 'pending'}: ${w.title}`,
    '',
    `**State:** ${LIFECYCLE_LABELS[w.state]}${w.blockedOn ? ` (blocked on ${w.blockedOn.kind}${w.blockedOn.ref ? ` ${w.blockedOn.ref}` : ''}: ${w.blockedOn.reason})` : ''}${w.url ? ` · [tracker](${w.url})` : ''}`,
    '',
    w.description || '_No description._',
    '',
    '## Acceptance criteria',
    ...(w.acceptance.length ? w.acceptance.map((a) => `- [ ] ${a}`) : ['- none given']),
    '',
    '## Evidence',
    ...(w.evidence.length ? w.evidence.map((e) => `- ${e.verified ? '✅ verified' : '◻️ claimed'} · ${e.kind}: ${e.summary}${e.sha ? ` @ \`${e.sha.slice(0, 10)}\`` : ''}`) : ['- none recorded']),
    '',
    '## Runs',
    ...(runs.length ? runs.map((r) => `- ${r.createdAt.slice(0, 16).replace('T', ' ')} ${s.agents[r.agentId]?.config.name ?? r.agentId} (attempt ${r.attempt}): ${r.state}${r.exit ? ` · ${r.exit.kind}` : ''}${r.handoff ? ` · ${L.link(L.handoff({ ...r, workItemKey: w.key }), 'handoff')}` : ''}`) : ['- none yet']),
    '',
  ];
  return lines.join('\n');
}

export function handoffNote(r: Run, s: ControlState, L: NoteLinks): string {
  const w = s.workItems[r.workItemId];
  const h = r.handoff!;
  const checks = w.evidence.filter((e) => e.runId === r.id && e.verified && (e.kind === 'test' || e.kind === 'command'));
  return [
    fm({ acc: 'handoff', key: w.key, agent: r.agentId, run: r.id, sha: h.commit?.sha, branch: h.commit?.branch, source: h.source, ended: r.endedAt }),
    `# Handoff: ${w.key ?? w.title} · ${s.agents[r.agentId]?.config.name ?? r.agentId}`,
    '',
    `Issue: ${w.key ? L.link(L.issue(w.key), w.key) : w.title} · model ${r.resolvedModel ?? r.model ?? '?'} · attempt ${r.attempt}${h.source === 'skeleton' ? ' · **generated skeleton (agent wrote no handoff)**' : ''}`,
    '',
    formatHandoff(h),
    '',
    '## Verified by the control center',
    ...(checks.length ? checks.map((e) => `- ${e.exitCode === 0 ? '✅' : '❌'} ${e.summary}${e.sha ? ` @ \`${e.sha.slice(0, 10)}\`` : ''}`) : ['- checks not recorded yet']),
    ...h.evidence.map((e) => `- claimed \`${e.command}\`: ${e.verified ? 'matches a recorded command' : 'not seen in the run'}`),
    '',
  ].join('\n');
}

export function decisionNote(a: Approval, s: ControlState, L: NoteLinks): string {
  const w = a.workItemId ? s.workItems[a.workItemId] : null;
  let detail = a.detail;
  try {
    const j = JSON.parse(a.detail) as { tool?: string; reason?: string };
    if (j.tool) detail = `Tool: ${j.tool}${j.reason ? ` (${j.reason})` : ''}`;
  } catch {
    /* plain text */
  }
  return [
    fm({ acc: 'decision', kind: a.kind, agent: a.agentId, key: w?.key, decision: a.decision, by: a.by, channel: a.channel, asked: a.createdAt, answered: a.resolvedAt }),
    `# Decision: ${a.title}`,
    '',
    `Asked by ${s.agents[a.agentId]?.config.name ?? a.agentId}${w?.key ? ` on ${L.link(L.issue(w.key), w.key)}` : ''} at ${hhmm(a.createdAt)}.`,
    '',
    detail ? `> ${detail.replace(/\n/g, '\n> ')}` : '',
    '',
    `**Answer:** ${a.decision} · by ${a.by} via ${a.channel} at ${a.resolvedAt ? hhmm(a.resolvedAt) : '?'}`,
    '',
  ].join('\n');
}
