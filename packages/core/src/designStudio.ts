// SPDX-License-Identifier: Apache-2.0
// Designer studio: briefs become ordinary issues and assignments; every job is tracked by the same
// durable run stream as engineering work. A job is "captured" only when an immutable mock revision
// exists for it, never because a run exited. Pure: the daemon and the UI derive status the same way.
import { z } from 'zod';
import type { Actor, AgentState, Approval, ControlState, Run } from './entities.ts';
import type { MockArtifact, MockRevision } from './mocks.ts';

export const DESIGN_STATES = ['empty', 'loading', 'error', 'success', 'partial', 'permission', 'offline'] as const;
export const DESIGN_STATE_LABELS: Record<(typeof DESIGN_STATES)[number], string> = {
  empty: 'Empty', loading: 'Loading', error: 'Error', success: 'Success', partial: 'Partial data', permission: 'No permission', offline: 'Offline',
};
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DesignBriefSchema = z.object({
  /** A new prototype, or a revision of existing project UI studied read-only. */
  mode: z.enum(['prototype', 'revise']).default('prototype'),
  title: z.string().trim().min(3, 'Give the brief a short title').max(90),
  brief: z.string().trim().min(20, 'Describe the problem and the main task (20+ characters)').max(4000),
  audience: z.string().trim().min(3, 'Say who uses these screens').max(400),
  screens: z.array(z.object({ name: z.string().trim().min(1).max(60), purpose: z.string().trim().max(300).default('') })).min(1, 'List at least one screen').max(8),
  states: z.array(z.enum(DESIGN_STATES)).min(1).default(['empty', 'loading', 'error', 'success']),
  interactions: z.string().trim().max(1500).default(''),
  fixtures: z.string().trim().max(1500).default(''),
  existingPaths: z.array(z.string().trim().min(1).max(200).regex(/^[\w./*-]+$/, 'Use repository-relative paths or globs').refine(p => !p.split('/').includes('..'), 'Paths cannot leave the repository')).max(12).default([]),
  slug: z.string().regex(SLUG, 'Folder names use lowercase letters, digits and dashes').optional(),
  agentId: z.string().trim().min(1, 'Choose a design agent'),
}).superRefine((b, ctx) => {
  if (b.mode === 'revise' && !b.existingPaths.length) ctx.addIssue({ code: 'custom', path: ['existingPaths'], message: 'Revising existing UI needs the paths of the screens to study' });
  const names = b.screens.map(s => s.name.toLowerCase());
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['screens'], message: 'Screen names must be unique' });
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;
export type DesignBriefInput = z.input<typeof DesignBriefSchema>;

export const designSlug = (s: string, max = 40) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '') || 'mock';

/** index.html for the first screen, then one file per further screen. */
export function briefPages(b: Pick<DesignBrief, 'screens'>): { path: string; name: string; purpose: string }[] {
  const seen = new Set<string>(['index']);
  return b.screens.map((s, i) => {
    if (i === 0) return { path: 'index.html', name: s.name, purpose: s.purpose };
    let base = designSlug(s.name, 32), n = 2, slug = base;
    while (seen.has(slug)) slug = `${base}-${n++}`;
    seen.add(slug);
    return { path: `${slug}.html`, name: s.name, purpose: s.purpose };
  });
}

export type DesignJobKind = 'generate' | 'refine' | 'engineering' | 'review';
export interface DesignJob {
  id: string;
  kind: DesignJobKind;
  title: string;
  brief: DesignBrief | null;
  slug: string;
  dir: string;
  workItemId: string;
  assignmentId: string;
  /** Refine, review and engineering jobs act on one exact artifact revision. */
  artifactId: string | null;
  fromRev: number | null;
  identity: { contentHash: string; designHash: string | null; designVersion: number | null } | null;
  request: string | null;
  /** Refinements continue the same assignment session when possible. */
  mode: 'new-assignment' | 'follow-up';
  runId: string | null;
  designRevision: { hash: string; version: number } | null;
  createdAt: string;
  by: Actor;
  canceledAt?: string | null;
}
export interface CaptureAttempt {
  id: string;
  jobId: string | null;
  assignmentId: string;
  runId: string | null;
  dir: string;
  trigger: 'auto' | 'human' | 'agent';
  ok: boolean;
  error: string | null;
  artifactId: string | null;
  rev: number | null;
  unchanged?: boolean;
  at: string;
  by: Actor;
}
export interface DesignStudioState { jobs: Record<string, DesignJob>; captures: Record<string, CaptureAttempt> }
export type DesignStudioEvent =
  | { kind: 'job_created'; job: DesignJob }
  | { kind: 'job_updated'; jobId: string; patch: Partial<Pick<DesignJob, 'runId' | 'canceledAt' | 'artifactId'>> }
  | { kind: 'capture_recorded'; attempt: CaptureAttempt };

export const emptyDesignStudio = (): DesignStudioState => ({ jobs: {}, captures: {} });

export function applyDesignStudioEvent(cur: DesignStudioState | undefined, e: DesignStudioEvent): DesignStudioState {
  const s = cur ?? emptyDesignStudio();
  switch (e.kind) {
    case 'job_created': return { ...s, jobs: { ...s.jobs, [e.job.id]: e.job } };
    case 'job_updated': {
      const j = s.jobs[e.jobId];
      return j ? { ...s, jobs: { ...s.jobs, [j.id]: { ...j, ...e.patch } } } : s;
    }
    case 'capture_recorded': return { ...s, captures: { ...s.captures, [e.attempt.id]: e.attempt } };
    default: return s;
  }
}

// ---- status, derived identically in the daemon and the UI --------------------------------------

export type JobPhase = 'draft' | 'queued' | 'running' | 'waiting' | 'captured' | 'capture_failed' | 'no_capture' | 'failed' | 'interrupted' | 'canceled' | 'prepared';
export interface JobStatus {
  phase: JobPhase;
  label: string;
  tone: 'ok' | 'warn' | 'crit' | 'info' | 'idle';
  runs: Run[];
  run: Run | null;
  approvals: Approval[];
  capture: CaptureAttempt | null;
  artifactId: string | null;
  revision: MockRevision | null;
  detail: string;
}

const WAITING = new Set(['waiting-for-approval', 'waiting-for-input']);
const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input', 'stalled']);

/** Revisions this job produced: from its assignment and folder, captured after it was created. */
export function jobRevisions(job: DesignJob, mocks: Record<string, MockArtifact> | undefined, until: string | null = null): { artifact: MockArtifact; revision: MockRevision }[] {
  const out: { artifact: MockArtifact; revision: MockRevision }[] = [];
  for (const a of Object.values(mocks ?? {})) {
    if (a.dir !== job.dir) continue;
    for (const r of a.revisions) if ((r.assignmentId ?? a.assignmentId) === job.assignmentId && r.capturedAt >= job.createdAt && (!until || r.capturedAt < until)) out.push({ artifact: a, revision: r });
  }
  return out.sort((x, y) => x.revision.capturedAt.localeCompare(y.revision.capturedAt));
}

export function jobStatus(job: DesignJob, s: Pick<ControlState, 'assignments' | 'runs' | 'approvals' | 'mocks'> & { designStudio?: DesignStudioState }): JobStatus {
  const asg = s.assignments[job.assignmentId];
  // A later job on the same assignment (a same-session refinement) owns what happens after it starts.
  const until = Object.values(s.designStudio?.jobs ?? {}).filter(j => j.id !== job.id && j.assignmentId === job.assignmentId && j.createdAt > job.createdAt && !j.canceledAt).map(j => j.createdAt).sort()[0] ?? null;
  const inWindow = (at: string) => at >= job.createdAt && (!until || at < until);
  const runs = Object.values(s.runs).filter(r => r.assignmentId === job.assignmentId && inWindow(r.createdAt)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const run = runs.at(-1) ?? null;
  const approvals = Object.values(s.approvals).filter(a => !a.resolvedAt && runs.some(r => r.id === a.runId));
  const captures = Object.values(s.designStudio?.captures ?? {}).filter(c => c.jobId === job.id || (c.assignmentId === job.assignmentId && inWindow(c.at))).sort((a, b) => a.at.localeCompare(b.at));
  const capture = captures.at(-1) ?? null;
  const produced = jobRevisions(job, s.mocks, until).at(-1) ?? null;
  const base = { runs, run, approvals, capture, artifactId: produced?.artifact.id ?? job.artifactId, revision: produced?.revision ?? null };
  const make = (phase: JobPhase, label: string, tone: JobStatus['tone'], detail: string): JobStatus => ({ ...base, phase, label, tone, detail });
  if (job.canceledAt || asg?.position === 'canceled') return make('canceled', 'Canceled', 'idle', 'This job was canceled. Its issue and any captured revisions remain.');
  if (job.kind === 'engineering' && (!run || asg?.position === 'draft')) return make('prepared', 'Engineering task prepared', 'info', 'A draft engineering assignment is bound to the approved design identity. Review and dispatch it from the work board.');
  if (run && ACTIVE.has(run.state)) {
    if (approvals.length || WAITING.has(run.state)) return make('waiting', 'Waiting for you', 'warn', approvals[0] ? `The agent asked: ${approvals[0].title}` : 'The run is waiting for input.');
    if (run.state === 'stalled') return make('running', 'Stalled', 'warn', 'No meaningful output recently. Check the transcript, nudge or stop it.');
    return make('running', run.state === 'running' ? 'Generating' : 'Starting', 'info', 'Streaming the agent’s actual output below.');
  }
  if (produced && (!run || produced.revision.capturedAt >= run.createdAt)) return make('captured', `Captured rev ${produced.revision.rev}`, 'ok', `Immutable revision ${produced.revision.rev} (${produced.revision.hash.slice(0, 12)}) is ready for review.`);
  if (!run) {
    if (!asg || asg.position === 'draft') return make('draft', 'Ready to dispatch', 'idle', 'Review the exact assignment and pre-flight, then dispatch. Nothing has run yet.');
    return make('queued', 'Queued', 'info', 'Queued as Next for this agent. It starts when the agent is free.');
  }
  if (capture && !capture.ok && capture.at >= (run.endedAt ?? run.createdAt)) return make('capture_failed', 'Capture failed', 'crit', capture.error ?? 'The mock folder could not be captured.');
  if (run.state === 'orphaned' || run.exit?.kind === 'stopped' || run.exit?.kind === 'killed' || run.exit?.kind === 'orphaned') return make('interrupted', 'Interrupted', 'warn', run.exit?.message ?? 'The run did not finish. Its worktree is kept; capture it or continue the session.');
  if (run.state === 'failed') return make('failed', 'Run failed', 'crit', run.exit?.message ?? 'The run failed before registering a mock.');
  return make('no_capture', 'Finished without a mock', 'warn', `The run ended but no revision of ${job.dir} was captured. Capture the folder from the worktree or ask the agent to register it.`);
}

export interface AgentEligibility { ok: boolean; paid: boolean; label: string; reason: string }
/** Who may run a design job from the studio. Pre-flight remains the final check at dispatch. */
export function designAgentEligibility(a: AgentState): AgentEligibility {
  const c = a.config;
  if (c.enabled === false) return { ok: false, paid: false, label: 'disabled', reason: 'Enable this agent in agent settings first.' };
  if (c.mode === 'coordinator-only') return { ok: false, paid: false, label: 'coordinator only', reason: 'Coordinator-only agents do not take assignments.' };
  if (c.adapter === 'relay') return { ok: false, paid: false, label: 'relay', reason: 'Relay agents need you to work in another app. The studio runs headless harnesses inside One Connect.' };
  if (a.auth.state === 'expired' || a.auth.state === 'not_installed') return { ok: false, paid: false, label: a.auth.state === 'expired' ? 'signed out' : 'not installed', reason: a.auth.detail ?? 'Sign in with the vendor’s own login, then probe the agent again.' };
  if (c.billing === 'local') return { ok: true, paid: false, label: 'local model', reason: 'Runs on this machine at no cost.' };
  if (c.metered_opt_in) return { ok: true, paid: true, label: 'metered (approved)', reason: `This agent has an approved per-token configuration${c.budget_usd_per_day ? ` capped at $${c.budget_usd_per_day}/day` : ''}. It is never used as a fallback.` };
  if (a.billing.mode === 'metered') return { ok: false, paid: true, label: 'metered: blocked', reason: 'This login bills per token. Paid generation stays off unless the agent is explicitly configured for it.' };
  if (a.billing.mode === 'subscription') return { ok: true, paid: false, label: a.billing.overage === 'on' ? 'included plan · overage on' : 'included plan', reason: a.billing.overage === 'on' ? 'Paid overage is on for this account; pre-flight will block dispatch.' : 'Uses your existing subscription.' };
  return { ok: true, paid: false, label: 'billing unknown', reason: 'Billing has not been confirmed yet. Pre-flight checks it before anything runs.' };
}

// ---- issue and prompt text ----------------------------------------------------------------------

export function designIssueText(b: DesignBrief, dir: string) {
  const pages = briefPages(b);
  const lines = [
    b.brief.trim(), '',
    `**Audience:** ${b.audience.trim()}`,
    `**Mode:** ${b.mode === 'revise' ? 'revise existing project UI (study it read-only, recreate it as a mock)' : 'new prototype'}`, '',
    '**Screens**', ...pages.map(p => `- \`${p.path}\` — ${p.name}${p.purpose ? `: ${p.purpose}` : ''}`), '',
    `**States for every data view:** ${b.states.map(x => DESIGN_STATE_LABELS[x]).join(', ')}`,
    ...(b.interactions.trim() ? ['', `**Key interactions:** ${b.interactions.trim()}`] : []),
    ...(b.fixtures.trim() ? ['', `**Fixture data:** ${b.fixtures.trim()}`] : []),
    ...(b.existingPaths.length ? ['', '**Existing UI to study (read-only):**', ...b.existingPaths.map(p => `- \`${p}\``)] : []),
    '', `Deliverable folder: \`${dir}/\`. Created in the One Connect Designer studio.`,
  ];
  return {
    title: `Design: ${b.title.trim()}`.slice(0, 120),
    description: lines.join('\n'),
    acceptance: [
      `A self-contained interactive mock exists in ${dir}/ with ${pages.map(p => p.path).join(', ')}.`,
      `Every data view shows ${b.states.join(', ')} states using local fixture data.`,
      'Keyboard operable with visible focus; uses only the frozen contract tokens.',
      'Registered with register_design_mock and a structured handoff; checks are actual or marked not run.',
    ],
    labels: ['design', 'ui', 'mock'],
  };
}

const RUNTIME_LIMITS = [
  'No network: fetch, XMLHttpRequest, WebSocket, EventSource, remote fonts, CDNs and external images are blocked. Bundle or inline everything.',
  'No storage: localStorage, sessionStorage, IndexedDB and cookies are unavailable in the opaque sandbox. Keep state in memory.',
  'No new windows, top-level navigation, downloads or real form submission. Forms call preventDefault and simulate their result.',
  'Files: html, css, js, mjs, svg, json, md, png, jpg, webp only; at most 40 files, 512 KiB each, 2 MiB total; no symlinks or dotfiles.',
];
export const DESIGN_RUNTIME_LIMITS = RUNTIME_LIMITS;

/** Exact, bounded deliverable instructions for a studio job. The brief itself is in the issue. */
export function designJobPrompt(job: DesignJob, o: { contract: { version: number; hash: string } | null; source?: MockRevision | null }): string {
  const out: string[] = ['', `## Design deliverable (Designer studio ${job.kind} job ${job.id})`];
  const contract = o.contract ? `contract v${o.contract.version}, SHA-256 ${o.contract.hash}` : 'no saved contract (ask the human before inventing a visual system)';
  if (job.kind === 'generate' && job.brief) {
    const b = job.brief;
    out.push(`Write a self-contained interactive mock in \`${job.dir}/\` and nowhere else.${b.mode === 'revise' ? ' Study the existing UI listed in the goal read-only; do not modify application code.' : ''}`);
    out.push(`- Pages: ${briefPages(b).map(p => `\`${p.path}\` (${p.name})`).join(', ')}. Link pages with relative \`<a href="page.html">\`; the preview routes them. Use \`history.back()\` for Back.`);
    out.push(`- Every data view covers ${b.states.join(', ')} states with realistic local fixture data (inline JSON or a local .js file). Add a visible, keyboard-operable state switcher so reviewers can see each state.`);
  } else if (job.kind === 'refine') {
    out.push(`Refine \`${job.dir}/\` starting from revision ${job.fromRev}${o.source ? ` (content ${o.source.hash.slice(0, 12)})` : ''}. Change only what the request needs; keep other pages and states intact.`);
    out.push(`- Request: ${job.request ?? ''}`);
  }
  out.push(`- Include \`tokens.css\` exactly as \`get_design_system\` returns it (${contract}) and style only with \`var(--design-*)\`. Do not edit the tokens; propose exceptions in your handoff.`);
  out.push('- Accessibility: semantic HTML with <html lang> and a viewport meta tag, visible labels, keyboard operation (Tab, Enter, Space, Escape, arrows), visible focus, focus return after dialogs, live-region announcements, reduced motion and the contract’s minimum target size.');
  out.push('Isolated preview limits (design within them; do not work around them):', ...RUNTIME_LIMITS.map(l => `- ${l}`));
  out.push('Ask with `ask_human` when audience, content or scope is unclear; the human answers inside One Connect.');
  out.push(`When done: commit, then call \`register_design_mock\` with \`dir: "${job.dir}"\` and a \`handoff\` object { summary, pages[{path,title,purpose}], states[], interactions[], checks[{name,status,command}], limitations[], questions[], designHash }. Fix error findings and register again. Record checks you actually ran with \`record_mock_evidence\`; mark the rest not run. Exiting without a registered mock does not produce a mock.`);
  return out.join('\n');
}

export function refineMessage(job: Pick<DesignJob, 'dir' | 'fromRev' | 'request' | 'artifactId'>, source: MockRevision): string {
  return [
    `Refinement request from the Designer studio for ${job.dir}/ (artifact ${job.artifactId}).`,
    `Start from revision ${job.fromRev}: content ${source.hash.slice(0, 12)}${source.designRevision ? `, contract v${source.designRevision.version}` : ''}${source.gitSha ? `, git ${source.gitSha.slice(0, 12)}` : ''}.`,
    `Request: ${job.request}`,
    'Change only what the request needs and keep the frozen tokens. Then commit and call register_design_mock again with a handoff listing what changed. Earlier revisions stay immutable.',
  ].join('\n');
}

export function engineeringIssueText(o: { title: string; artifactId: string; dir: string; revision: MockRevision; contract: { version: number; hash: string }; approvedBy: string; approvedAt: string; pages: string[]; states: string[]; notes: string; checks: string[] }) {
  const r = o.revision;
  return {
    title: `Implement design: ${o.title}`.slice(0, 120),
    description: [
      `Implement the approved design **${o.title}** in the application.`, '',
      '**Approved design identity (do not implement anything else):**',
      `- Mock artifact \`${o.artifactId}\` (${o.dir}/), revision ${r.rev}, content SHA-256 \`${r.hash}\`${r.gitSha ? `, git ${r.gitSha}` : ''}`,
      `- Design contract v${o.contract.version}, SHA-256 \`${o.contract.hash}\` (read it with get_design_system)`,
      `- Approved by ${o.approvedBy} at ${o.approvedAt}`, '',
      `Pages: ${o.pages.join(', ')}. States: ${o.states.join(', ') || 'see the mock'}.`,
      ...(o.notes.trim() ? ['', o.notes.trim()] : []), '',
      'The mock is a reference, not production code: rebuild it with the application’s components. A mock approval is not a passing implementation.',
    ].join('\n'),
    acceptance: [
      `Uses design contract v${o.contract.version} tokens; no literal colors, sizes or durations outside tokens.`,
      'Implements every page, interaction and empty/loading/error/success state of the approved revision.',
      'Keyboard operation and visible focus verified; phone, tablet and desktop layouts have actual evidence.',
      ...(o.checks.length ? [`Project checks pass with actual output: ${o.checks.join(', ')}.`] : []),
      'Deviations from the approved mock are recorded as design exceptions by a human.',
    ],
    labels: ['design-implementation', 'frontend'],
  };
}

export function reviewPrompt(o: { artifactId: string; dir: string; revision: MockRevision }): string {
  return [
    '', '## Independent design review',
    `Review mock \`${o.artifactId}\` (${o.dir}/) revision ${o.revision.rev}, content ${o.revision.hash}. You did not author it; review only.`,
    'Read its files with `get_design_mock` (bounded pages) and the frozen contract with `get_design_system`. Do not edit or commit anything.',
    'Assess each checklist item: responsive (phone 390, tablet 820, desktop 1280), keyboard and focus, contrast, content states, visual and token compliance. Base each on what you actually inspected: static (source) or browser (an executed check you ran). Static inspection cannot prove responsive, keyboard or state behavior.',
    'Submit with `submit_design_review` { artifactId, revision, verdict: approve|request_changes, summary, checklist[{id,result,basis,note}] }. A human makes the final approval.',
  ].join('\n');
}
