// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Design mock artifacts: issue/assignment-bound local HTML/CSS/JS captured as immutable revisions.
import { z } from 'zod';
import type { Actor } from './entities.ts';

export const MOCK_LIMITS = { files: 40, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024, screenshotBytes: 5 * 1024 * 1024, previewShellBytes: 15 * 1024 * 1024 } as const;
export const MOCK_EXTENSIONS: Record<string, MockFile['kind']> = { '.html': 'html', '.css': 'css', '.js': 'js', '.mjs': 'js', '.svg': 'svg', '.json': 'json', '.md': 'md', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image' };
export const MOCK_DIR_RE = /^design\/[a-z0-9][a-z0-9-]{0,63}$/;

export interface MockFile { path: string; sha256: string; bytes: number; kind: 'html' | 'css' | 'js' | 'svg' | 'json' | 'md' | 'image' }
export interface MockFinding { id: string; severity: 'error' | 'warn' | 'info'; rule: string; message: string; file?: string; line?: number }
export interface MockException { id: string; findingIds: string[]; rationale: string; by: Actor; at: string }

/** What a reviewer checked on one exact revision. Static measurement alone never passes the gate. */
export const REVIEW_CHECKLIST = [
  { id: 'responsive', label: 'Responsive layout', help: 'Phone 390, tablet 820 and desktop 1280 widths: nothing clipped, overlapping or scrolling sideways.' },
  { id: 'keyboard', label: 'Keyboard and focus', help: 'Every interaction works with Tab, Shift+Tab, Enter, Space, Escape and arrow keys where expected. Focus is always visible and returns after dialogs.' },
  { id: 'contrast', label: 'Contrast', help: 'Text, actions and focus meet the contract’s measured contrast. Status never relies on color alone.' },
  { id: 'states', label: 'Content states', help: 'Empty, loading, error and success states exist for every data view, with real copy.' },
  { id: 'tokens', label: 'Visual and token compliance', help: 'Colors, type, spacing, radius and motion come from the frozen contract tokens. Exceptions are recorded.' },
] as const;
export type ChecklistId = (typeof REVIEW_CHECKLIST)[number]['id'];
export interface ChecklistResult {
  id: ChecklistId;
  result: 'pass' | 'fail' | 'not_checked';
  /** static = measured from source; browser = an executed browser check; human = a person looked at the rendered mock. */
  basis: 'static' | 'browser' | 'human';
  evidenceIds: string[];
  note?: string;
}
export interface MockReview {
  decision: 'approved' | 'changes_requested';
  note: string;
  by: Actor;
  at: string;
  /** The exact identity reviewed. Approvals never carry to another revision. */
  hash?: string;
  designHash?: string | null;
  checklist?: ChecklistResult[];
  /** False when the reviewer authored this revision's content. */
  independent?: boolean;
  runId?: string | null;
}
export interface MockEvidence {
  id: string;
  kind: 'command' | 'screenshot' | 'viewport';
  summary: string;
  viewport?: { name: string; width: number; height: number };
  command?: string;
  exitCode?: number | null;
  screenshot?: { path: string; sha256: string; bytes: number; stored?: 'revision' | 'evidence' };
  /** Status as reported; `passed` is only accepted for an executed check. */
  status: 'passed' | 'failed' | 'not_run';
  executed: boolean;
  /** True only when One Connect recorded the command itself (run transcript) with this exit code. */
  verified: boolean;
  source: 'agent' | 'human';
  runId?: string;
  at: string;
  by: Actor;
  /** What was done, with which tool, against which page: required context for rendered evidence. */
  action?: string;
  tool?: string;
  page?: string;
  artifactHash?: string;
  designHash?: string | null;
}

/** Agent-reported structured handoff. One Connect stores it as a claim, never as proof. */
export const DesignHandoffSchema = z.object({
  summary: z.string().trim().max(2000).default(''),
  pages: z.array(z.object({ path: z.string().trim().max(120), title: z.string().trim().max(120).optional(), purpose: z.string().trim().max(300).optional() })).max(20).default([]),
  states: z.array(z.string().trim().max(60)).max(30).default([]),
  interactions: z.array(z.string().trim().max(200)).max(30).default([]),
  checks: z.array(z.object({ name: z.string().trim().max(120), status: z.enum(['passed', 'failed', 'not_run']), command: z.string().trim().max(500).optional(), detail: z.string().trim().max(300).optional() })).max(30).default([]),
  limitations: z.array(z.string().trim().max(300)).max(20).default([]),
  questions: z.array(z.string().trim().max(300)).max(10).default([]),
  designHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type DesignHandoff = z.infer<typeof DesignHandoffSchema>;

export type MockOrigin = 'agent' | 'capture' | 'auto' | 'edit';
export interface MockRevision {
  document?: { id: string; version: number; hash: string; releaseHash: string };
  rev: number;
  hash: string;
  entry: string;
  files: MockFile[];
  designRevision: { hash: string; version: number } | null;
  gitSha: string | null;
  runId: string | null;
  findings: MockFinding[];
  exceptions: MockException[];
  reviews: MockReview[];
  evidence: MockEvidence[];
  capturedAt: string;
  /** Who captured. */
  by: Actor;
  /** Who wrote the content: the assignment's agent for worktree captures, the human for scoped edits. */
  authoredBy?: Actor;
  origin?: MockOrigin;
  /** The assignment this revision came from (a refinement can continue an artifact on a new assignment). */
  assignmentId?: string;
  workItemId?: string;
  agentId?: string;
  handoff?: DesignHandoff | null;
  parentRev?: number | null;
}
export interface MockArtifact {
  id: string;
  workItemId: string;
  assignmentId: string;
  agentId: string;
  dir: string;
  title: string;
  revisions: MockRevision[];
  createdAt: string;
  updatedAt: string;
}

export const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

export type MockGateState = 'clear' | 'needs_review' | 'excepted' | 'approved' | 'changes_requested' | 'needs_independent_review';
export interface MockGate {
  state: MockGateState;
  open: MockFinding[];
  drift: MockFinding | null;
  /** The latest approving human review and whether it still holds for the current contract. */
  approval: { review: MockReview; valid: boolean; reason: string | null } | null;
  author: Actor;
}

export const authorOf = (r: MockRevision): Actor => r.authoredBy ?? r.by;
const sameActor = (a: Actor, b: Actor) => a.type === b.type && a.id === b.id;

/**
 * Findings that still need a human, including drift from the current project contract, and whether
 * an approval is independent. The author of a revision's content cannot be its only approving reviewer.
 */
export function mockGate(r: MockRevision, currentDesignHash: string | null): MockGate {
  const drift: MockFinding | null = !r.designRevision
    ? { id: 'contract-missing', severity: 'warn', rule: 'contract', message: 'No design contract was frozen for this assignment.' }
    : currentDesignHash && r.designRevision.hash !== currentDesignHash
      ? { id: `contract-drift:${currentDesignHash.slice(0, 12)}`, severity: 'warn', rule: 'contract', message: `Built against contract v${r.designRevision.version}; the project contract has changed since.` }
      : null;
  const all = [...r.findings, ...(drift ? [drift] : [])].filter(f => f.severity !== 'info');
  const covered = new Set(r.exceptions.flatMap(e => e.findingIds));
  const open = all.filter(f => !covered.has(f.id));
  const author = authorOf(r);
  const last = r.reviews.at(-1);
  const humanApproval = [...r.reviews].reverse().find(v => v.by.type === 'human');
  const approvalReview = humanApproval?.decision === 'approved' ? humanApproval : null;
  const approval = approvalReview ? { review: approvalReview, valid: open.length === 0, reason: open.length ? (drift && open.some(f => f.id === drift.id) ? 'The project contract changed after this approval. Record a drift exception or approve a revision built on the current contract.' : 'Open findings must be fixed or excepted.') : null } : null;
  if (last?.decision === 'changes_requested') return { state: 'changes_requested', open, drift, approval, author };
  if (open.length) return { state: 'needs_review', open, drift, approval, author };
  if (approvalReview) {
    const independent = r.reviews.some(v => v.decision === 'approved' && !sameActor(v.by, author) && r.reviews.indexOf(v) >= r.reviews.findLastIndex(x => x.decision === 'changes_requested'));
    return { state: independent ? 'approved' : 'needs_independent_review', open, drift, approval: approval && { ...approval, valid: independent, reason: independent ? null : 'You authored this revision. An independent reviewer must also approve it.' }, author };
  }
  return { state: all.length ? 'excepted' : 'clear', open, drift, approval, author };
}

/** Where an artifact stands overall: its latest revision and the latest one still validly approved. */
export function artifactStatus(a: MockArtifact, currentDesignHash: string | null) {
  const latest = a.revisions.at(-1)!;
  const gates = a.revisions.map(r => ({ rev: r.rev, gate: mockGate(r, currentDesignHash) }));
  const approved = [...gates].reverse().find(g => g.gate.state === 'approved') ?? null;
  const stale = [...gates].reverse().find(g => g.gate.approval && !g.gate.approval.valid) ?? null;
  return {
    latestRev: latest.rev,
    latestGate: gates.at(-1)!.gate,
    approvedRev: approved?.rev ?? null,
    approvedIsLatest: approved?.rev === latest.rev,
    staleApproval: stale ? { rev: stale.rev, reason: stale.gate.approval!.reason } : null,
    oldContract: Boolean(currentDesignHash && latest.designRevision && latest.designRevision.hash !== currentDesignHash),
  };
}

/** File-level comparison of two revisions by content hash. */
export function compareRevisions(a: MockRevision, b: MockRevision) {
  const before = new Map(a.files.map(f => [f.path, f])), after = new Map(b.files.map(f => [f.path, f]));
  return {
    from: a.rev, to: b.rev,
    added: b.files.filter(f => !before.has(f.path)).map(f => f.path),
    removed: a.files.filter(f => !after.has(f.path)).map(f => f.path),
    changed: b.files.filter(f => before.has(f.path) && before.get(f.path)!.sha256 !== f.sha256).map(f => f.path),
    unchanged: b.files.filter(f => before.get(f.path)?.sha256 === f.sha256).map(f => f.path),
    contract: { from: a.designRevision, to: b.designRevision, changed: a.designRevision?.hash !== b.designRevision?.hash },
  };
}

export type DiffLine = { op: '=' | '+' | '-'; text: string } | { op: '…'; count: number };
/** Bounded line diff (LCS). Returns null when either side is too large to compare inline. */
export function lineDiff(a: string, b: string, o: { context?: number; maxLines?: number } = {}): DiffLine[] | null {
  const x = a.split('\n'), y = b.split('\n'), max = o.maxLines ?? 1200, context = o.context ?? 3;
  if (x.length > max || y.length > max) return null;
  const n = x.length, m = y.length, w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const out: { op: '=' | '+' | '-'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: '=', text: x[i] }); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  const keep = out.map((l, k) => l.op !== '=' || out.slice(Math.max(0, k - context), k + context + 1).some(z => z.op !== '='));
  const res: DiffLine[] = [];
  for (let k = 0; k < out.length; k++) {
    if (keep[k]) { res.push(out[k]); continue; }
    const last = res.at(-1);
    if (last?.op === '…') last.count++; else res.push({ op: '…', count: 1 });
  }
  return res;
}

/** Injected first into every preview document. The iframe is also sandboxed without same-origin. */
export const MOCK_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'";
export const MOCK_IFRAME_SANDBOX = 'allow-scripts';

/**
 * A script-free rendering of a preview document for the browser dashboard. Scripts are removed and
 * links are inert; the dashboard shows it in an iframe sandboxed with no permissions at all. It is a
 * layout check, not the interactive mock, and it does not provide the native host's isolation.
 */
export function mockStaticDocument(previewHtml: string): string {
  return previewHtml
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<(a|area)\b([^>]*)>/gi, (_m, tag: string, attrs: string) => `<${tag}${attrs.replace(/\shref\s*=/gi, ' data-href=').replace(/\starget\s*=/gi, ' data-target=')} aria-disabled="true">`)
    .replace(/<[a-z][^>]*>/gi, tag => tag.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''))
    .replace(/<(iframe|object|embed|frame|frameset)\b[\s\S]*?(?:<\/\1\s*>|\/?>)/gi, '');
}

/** Trusted shell: the untrusted document cannot change this ancestor's policy. Child-initiated
 * navigations are checked against frame-src, including encoded Location assignments. The shell
 * is used only by the native host (which also denies WebRTC, network requests and navigation).
 * CSP alone is not a blanket network boundary: browsers can expose WebRTC outside connect-src.
 * Local page links are routed here; everything else is explained in a polite status message.
 */
export function mockPreviewShell(html: string, pages: Record<string, string> = {}, o: { page?: string; label?: string } = {}): string {
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MOCK_PREVIEW_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interactive mock</title><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}#status{position:fixed;left:8px;bottom:8px;max-width:calc(100% - 16px);padding:6px 10px;border-radius:6px;background:#18343b;color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 2px 8px rgb(0 0 0 / 25%)}#status:empty{display:none}</style></head><body><iframe id="mock" title="Interactive mock" sandbox="${MOCK_IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe><div id="status" role="status" aria-live="polite"></div><script>
(()=>{const frame=document.getElementById('mock'),status=document.getElementById('status');const pages=${json(pages)};const label=${json(o.label ?? 'Interactive mock')};let current=${json(o.page ?? 'index.html')};const back=[];let timer=0;
const say=t=>{status.textContent=t;clearTimeout(timer);timer=setTimeout(()=>{status.textContent=''},6000)};
const show=(page,push)=>{if(push)back.push(current);current=page;frame.srcdoc=pages[page];document.title=label+' · '+page;say('Showing '+page);};
const WHY={external:'External links are blocked in previews',form:'Form submission is simulated; nothing was sent',popup:'New windows are blocked in previews',page:'That page is not part of this revision'};
window.addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!=='null')return;const m=e.data;if(!m||m.source!=='one-connect-mock')return;
if(m.type==='navigate'&&typeof m.page==='string'){if(Object.hasOwn(pages,m.page))show(m.page,true);else say(WHY.page+': '+String(m.page).slice(0,80));return;}
if(m.type==='back'){if(back.length)show(back.pop(),false);else say('Already on the first page');return;}
if(m.type==='blocked')say((WHY[m.reason]||'Blocked navigation')+(m.href?': '+String(m.href).slice(0,120):''));
});document.title=label+' · '+current;frame.srcdoc=${json(html)};})();</script></body></html>`;
}
