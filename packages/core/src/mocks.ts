// SPDX-License-Identifier: Apache-2.0
// Design mock artifacts: issue/assignment-bound local HTML/CSS/JS captured as immutable revisions.
import type { Actor } from './entities.ts';

export const MOCK_LIMITS = { files: 40, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024, screenshotBytes: 5 * 1024 * 1024 } as const;
export const MOCK_EXTENSIONS: Record<string, MockFile['kind']> = { '.html': 'html', '.css': 'css', '.js': 'js', '.mjs': 'js', '.svg': 'svg', '.json': 'json', '.md': 'md', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image' };
export const MOCK_DIR_RE = /^design\/[a-z0-9][a-z0-9-]{0,63}$/;

export interface MockFile { path: string; sha256: string; bytes: number; kind: 'html' | 'css' | 'js' | 'svg' | 'json' | 'md' | 'image' }
export interface MockFinding { id: string; severity: 'error' | 'warn' | 'info'; rule: string; message: string; file?: string; line?: number }
export interface MockException { id: string; findingIds: string[]; rationale: string; by: Actor; at: string }
export interface MockReview { decision: 'approved' | 'changes_requested'; note: string; by: Actor; at: string }
export interface MockEvidence {
  id: string;
  kind: 'command' | 'screenshot' | 'viewport';
  summary: string;
  viewport?: { name: string; width: number; height: number };
  command?: string;
  exitCode?: number | null;
  screenshot?: { path: string; sha256: string; bytes: number };
  /** Status as reported; `passed` is only accepted for an executed check. */
  status: 'passed' | 'failed' | 'not_run';
  executed: boolean;
  /** True only when One Connect recorded the command itself (run transcript) with this exit code. */
  verified: boolean;
  source: 'agent' | 'human';
  runId?: string;
  at: string;
  by: Actor;
}
export interface MockRevision {
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
  by: Actor;
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

/** Findings that still need a human, including drift from the current project contract. */
export function mockGate(r: MockRevision, currentDesignHash: string | null): { state: 'clear' | 'needs_review' | 'excepted' | 'approved' | 'changes_requested'; open: MockFinding[]; drift: MockFinding | null } {
  const drift: MockFinding | null = !r.designRevision
    ? { id: 'contract-missing', severity: 'warn', rule: 'contract', message: 'No design contract was frozen for this assignment.' }
    : currentDesignHash && r.designRevision.hash !== currentDesignHash
      ? { id: `contract-drift:${currentDesignHash.slice(0, 12)}`, severity: 'warn', rule: 'contract', message: `Built against contract v${r.designRevision.version}; the project contract has changed since.` }
      : null;
  const all = [...r.findings, ...(drift ? [drift] : [])].filter(f => f.severity !== 'info');
  const covered = new Set(r.exceptions.flatMap(e => e.findingIds));
  const open = all.filter(f => !covered.has(f.id));
  const review = r.reviews.at(-1);
  if (review?.decision === 'changes_requested') return { state: 'changes_requested', open, drift };
  if (open.length) return { state: 'needs_review', open, drift };
  if (review?.decision === 'approved') return { state: 'approved', open, drift };
  return { state: all.length ? 'excepted' : 'clear', open, drift };
}

/** Injected first into every preview document. The iframe is also sandboxed without same-origin. */
export const MOCK_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'";
export const MOCK_IFRAME_SANDBOX = 'allow-scripts';

/** Trusted shell: the untrusted document cannot change this ancestor's policy. Child-initiated
 * navigations are checked against frame-src, including encoded Location assignments. The shell
 * is used only by the native host (which also denies WebRTC, network requests and navigation).
 * CSP alone is not a blanket network boundary: browsers can expose WebRTC outside connect-src.
 */
export function mockPreviewShell(html: string, pages: Record<string, string> = {}): string {
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MOCK_PREVIEW_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}#status{position:fixed;bottom:0;background:#fff;color:#222;font:12px sans-serif}</style></head><body><iframe id="mock" title="Interactive mock" sandbox="${MOCK_IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe><div id="status" role="status"></div><script>
(()=>{const frame=document.getElementById('mock'),status=document.getElementById('status');const pages=${json(pages)};
window.addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!=='null')return;const m=e.data;if(!m||m.source!=='one-connect-mock')return;
if(m.type==='navigate'&&typeof m.page==='string'&&Object.hasOwn(pages,m.page)){frame.srcdoc=pages[m.page];status.textContent='';return;}
if(m.type==='blocked')status.textContent='Blocked navigation: '+String(m.href||'').slice(0,120);
});frame.srcdoc=${json(html)};})();</script></body></html>`;
}
