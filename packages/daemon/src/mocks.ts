// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Design mock artifacts. An assigned design agent writes self-contained HTML/CSS/JS under
// design/<slug>/ in its worktree; capture validates the folder, copies it into content-addressed
// app storage and records an immutable revision bound to the issue, assignment, git SHA and the
// frozen design contract. Previews are assembled into one document with every local asset inlined,
// a restrictive CSP and a convenience link handler. Execution requires the native preview boundary;
// the browser dashboard only shows a script-free layout render.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  agentActor, artifactStatus, authorOf, briefPages, compareRevisions, containsSecret, designCss, designMarkdown, DesignHandoffSchema, designPalette, designSpecimenHtml,
  designTokensJson, HUMAN, inScope, isActiveRun, lineDiff, mockGate, MOCK_DIR_RE, MOCK_EXTENSIONS, MOCK_IFRAME_SANDBOX, MOCK_LIMITS, MOCK_PREVIEW_CSP,
  mockPreviewShell, mockStaticDocument, newId, REVIEW_CHECKLIST, VIEWPORTS,
  type Actor, type Assignment, type ChecklistResult, type DesignHandoff, type DesignRevision, type MockArtifact, type MockEvidence, type MockFile,
  type MockFinding, type MockOrigin, type MockReview, type MockRevision,
} from '@acc/core';
import { headSha } from './adapters/vcs/git.ts';
import { CommandError, type Daemon } from './daemon.ts';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const TEXT_KINDS = new Set(['html', 'css', 'js', 'svg', 'json', 'md']);
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const IGNORED = new Set(['.DS_Store']);
/** design/<slug>/evidence/ holds check screenshots. It is read as evidence, never captured as mock content. */
const EVIDENCE_DIR = 'evidence';
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

interface Collected { rel: string; abs: string; bytes: number; content: Buffer }

function hexes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
    out.add(`#${h.toLowerCase()}`);
  }
  return [...out];
}
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Image type from magic bytes; null for anything that is not a PNG, JPEG or WebP. */
export function imageType(b: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Static checks. They catch remote resources, network calls and off-token colors; they do not prove visual compliance. */
export function lintMock(files: { path: string; kind: MockFile['kind']; text: string | null }[], design: DesignRevision | null, entry: string): MockFinding[] {
  const findings: MockFinding[] = [];
  const names = new Set(files.map(f => f.path));
  const palette = new Set(design ? designPalette(design.system) : []);
  let usesTokens = false;
  for (const f of files) {
    if (f.text === null) continue;
    const t = f.text;
    if (/var\(\s*--design-/.test(t)) usesTokens = true;
    const refs: { value: string; index: number }[] = [];
    // Unquoted attribute values only exist in markup; in scripts and styles `data = …` is code.
    const attrs = f.kind === 'html' || f.kind === 'svg' ? /\b(?:src|href|action|poster|data|srcset|formaction|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi : /\b(?:src|href|action|poster|data|srcset|formaction|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    for (const m of t.matchAll(attrs)) refs.push({ value: (m[1] ?? m[2] ?? m[3] ?? '').trim(), index: m.index ?? 0 });
    for (const m of t.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) refs.push({ value: (m[1] ?? m[2] ?? m[3] ?? '').trim(), index: m.index ?? 0 });
    for (const m of t.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) refs.push({ value: (m[1] ?? m[2] ?? '').trim(), index: m.index ?? 0 });
    for (const m of t.matchAll(/\bimport\s*(?:[\w{}\s,*]+from\s*)?["']([^"']+)["']/g)) if (f.kind === 'js' || f.kind === 'html') refs.push({ value: m[1].trim(), index: m.index ?? 0 });
    for (const r of refs) {
      const v = r.value.split(/\s+/)[0];
      if (!v || v.startsWith('#') || v.startsWith('data:') || v.startsWith('blob:') || /^javascript:\s*void/i.test(v)) continue;
      if (REMOTE.test(v) || (SCHEME.test(v) && !/^(?:mailto|tel):/i.test(v))) {
        findings.push({ id: `remote:${f.path}:${sha(v).slice(0, 10)}`, severity: 'error', rule: 'remote-resource', message: `Remote or external reference ${v.slice(0, 120)}. Mocks must be self-contained; the preview blocks it.`, file: f.path, line: lineOf(t, r.index) });
        continue;
      }
      if (/^(?:mailto|tel):/i.test(v)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), v.split(/[?#]/)[0]));
      if (target.startsWith('..')) findings.push({ id: `outside:${f.path}:${sha(v).slice(0, 10)}`, severity: 'error', rule: 'outside-folder', message: `${v} points outside the mock folder.`, file: f.path, line: lineOf(t, r.index) });
      else if (!names.has(target)) findings.push({ id: `missing:${f.path}:${target}`, severity: 'warn', rule: 'missing-asset', message: `${v} is not in this mock folder.`, file: f.path, line: lineOf(t, r.index) });
    }
    for (const m of t.matchAll(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|RTCPeerConnection)\s*\(/g)) {
      findings.push({ id: `network:${f.path}:${m[1]}`, severity: 'warn', rule: 'network-api', message: `${m[1]} is blocked in previews (connect-src 'none'). Use local fixture data.`, file: f.path, line: lineOf(t, m.index ?? 0) });
    }
    if (f.kind === 'js' || f.kind === 'html') for (const m of t.matchAll(/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/g)) {
      findings.push({ id: `storage:${f.path}:${m[1]}`, severity: 'warn', rule: 'storage-api', message: `${m[1]} is unavailable in the isolated preview (opaque sandbox) and will throw. Keep mock state in memory.`, file: f.path, line: lineOf(t, m.index ?? 0) });
    }
    if (f.kind === 'css' || f.kind === 'html' || f.kind === 'svg') {
      const off = hexes(t).filter(h => !palette.has(h));
      if (design && off.length) findings.push({ id: `palette:${f.path}:${sha(off.sort().join(',')).slice(0, 10)}`, severity: 'warn', rule: 'off-token-color', message: `${off.length} color${off.length === 1 ? '' : 's'} outside the contract palette: ${off.slice(0, 8).join(', ')}${off.length > 8 ? '…' : ''}. Use --design-* tokens or record an exception.`, file: f.path });
    }
    if (f.kind === 'html' && /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(t)) findings.push({ id: `refresh:${f.path}`, severity: 'error', rule: 'navigation', message: 'meta refresh navigates away; removed from previews.', file: f.path });
  }
  const html = files.find(f => f.path === entry);
  if (html?.text !== null && html && !/<meta[^>]+name\s*=\s*["']?viewport/i.test(html.text!)) findings.push({ id: `viewport:${entry}`, severity: 'warn', rule: 'viewport-meta', message: 'No viewport meta tag; phone previews will not reflect the real layout.', file: entry });
  if (html?.text && !/<html[^>]*\blang\s*=/i.test(html.text)) findings.push({ id: `lang:${entry}`, severity: 'warn', rule: 'document-language', message: 'Set <html lang> for screen readers.', file: entry });
  if (design && !usesTokens) findings.push({ id: 'tokens-unused', severity: 'warn', rule: 'tokens', message: 'No var(--design-*) token is used. Include the contract tokens.css and reference its variables.' });
  const tokens = files.find(f => f.path === 'tokens.css');
  if (design && tokens?.text && tokens.text.trim() !== designCss(design.system).trim()) findings.push({ id: `tokens-stale:${sha(tokens.text).slice(0, 10)}`, severity: 'warn', rule: 'tokens', message: `tokens.css differs from contract v${design.version}.`, file: 'tokens.css' });
  findings.push({ id: 'static-only', severity: 'info', rule: 'scope', message: 'Static checks cannot prove visual compliance. Review the preview at phone, tablet and desktop widths and attach executed evidence.' });
  return [...new Map(findings.map(f => [f.id, f])).values()];
}

/** Claims in a structured handoff, compared with what was actually captured. */
function handoffFindings(o: { handoff: DesignHandoff | null; invalid: string | null; files: MockFile[]; contractHash: string | null; expectedPages: string[]; studio: boolean; origin: MockOrigin }): MockFinding[] {
  const out: MockFinding[] = [];
  const names = new Set(o.files.map(f => f.path));
  if (o.invalid) out.push({ id: 'handoff:invalid', severity: 'warn', rule: 'handoff', message: `The structured handoff was not valid and was not stored: ${o.invalid.slice(0, 200)}` });
  else if (!o.handoff && o.studio && o.origin !== 'edit') out.push({ id: 'handoff:missing', severity: 'warn', rule: 'handoff', message: 'No structured handoff was registered, so pages, states, checks and limitations are unknown. Review them directly or ask the agent to register again.' });
  if (o.handoff?.designHash && o.contractHash && o.handoff.designHash !== o.contractHash) out.push({ id: `handoff:contract:${o.handoff.designHash.slice(0, 12)}`, severity: 'warn', rule: 'handoff', message: `The handoff claims contract ${o.handoff.designHash.slice(0, 12)}, but the assignment froze ${o.contractHash.slice(0, 12)}.` });
  for (const p of o.handoff?.pages ?? []) if (!names.has(p.path)) out.push({ id: `handoff:page:${p.path}`, severity: 'warn', rule: 'handoff', message: `The handoff lists ${p.path}, which is not in this revision.` });
  for (const p of o.expectedPages) if (!names.has(p)) out.push({ id: `brief:page:${p}`, severity: 'warn', rule: 'brief-page', message: `${p} from the brief is missing.` });
  return out;
}

const GUARD = `<script>(()=>{const P=window.parent;const send=m=>{try{P.postMessage(Object.assign({source:'one-connect-mock'},m),'*')}catch(e){}};
const block=(reason,where)=>send({type:'blocked',reason,href:String(where||'').slice(0,200)});
window.open=(...a)=>{block('popup',a[0]);return null};
try{history.back=()=>send({type:'back'});history.go=n=>{if(Number(n)<0)send({type:'back'})}}catch(e){}
document.addEventListener('click',e=>{const a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;const h=(a.getAttribute('href')||'').replace(/^\\.\\//,'');if(h.startsWith('#'))return;e.preventDefault();if(/^[\\w./-]+\\.html(?:#.*)?$/.test(h)&&!h.startsWith('/')&&!h.includes('..'))send({type:'navigate',page:h.split('#')[0]});else block('external',h);},true);
document.addEventListener('submit',e=>{e.preventDefault();block('form','');},true);
})();</script>`;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

export interface CaptureOptions { title?: string; runId?: string | null; trigger?: 'auto' | 'human' | 'agent'; handoff?: unknown; authoredBy?: Actor; origin?: MockOrigin }

export class DesignMocks {
  private readonly captureTails=new Map<string,Promise<unknown>>();
  readonly d: Daemon;
  constructor(d: Daemon) { this.d = d; }

  private blobDir() { return path.join(this.d.paths.root, 'design-mocks', 'blobs'); }
  private all(): Record<string, MockArtifact> { return this.d.state.mocks ?? {}; }

  get(id: string): MockArtifact {
    const a = this.all()[id];
    if (!a) throw new CommandError('Unknown design mock', 404);
    return a;
  }
  rev(a: MockArtifact, rev: number | 'latest' = 'latest'): MockRevision {
    const r = rev === 'latest' ? a.revisions.at(-1) : a.revisions.find(x => x.rev === rev);
    if (!r) throw new CommandError('Unknown mock revision', 404);
    return r;
  }

  view(a: MockArtifact) {
    const cur = this.d.state.design?.hash ?? null;
    const item = this.d.state.workItems[a.workItemId];
    return { ...a, issue: item ? { id: item.id, key: item.key, title: item.title } : null, status: artifactStatus(a, cur), revisions: a.revisions.map(r => ({ ...r, gate: mockGate(r, cur) })) };
  }

  list(filter: { workItemId?: string; assignmentId?: string } = {}) {
    return Object.values(this.all())
      .filter(a => (!filter.workItemId || a.workItemId === filter.workItemId || a.revisions.some(r => r.workItemId === filter.workItemId)) && (!filter.assignmentId || a.assignmentId === filter.assignmentId || a.revisions.some(r => r.assignmentId === filter.assignmentId)))
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
      .map(a => this.view(a));
  }

  /** Linux resolves each component relative to a pinned directory
   * descriptor via procfs. Never fall back to check-then-open on unsupported hosts.
   */
  private openContained(root: string, rel: string, flags: number, mode = 0o600): number {
    const nofollow = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    if (process.platform === 'darwin') return fs.openSync(path.join(root, rel), flags | nofollow, mode); // directories only; bytes use the native openat helper
    if (process.platform !== 'linux') throw new CommandError('Safe mock file access is unavailable on this platform', 503);
    let parent = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const parts = path.join(root, rel).split('/').filter(Boolean);
      for (const part of parts.slice(0, -1)) {
        const next = fs.openSync(`/proc/self/fd/${parent}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | nofollow);
        fs.closeSync(parent); parent = next;
      }
      return fs.openSync(`/proc/self/fd/${parent}/${parts.at(-1)}`, flags | nofollow, mode);
    } finally { fs.closeSync(parent); }
  }

  /** Retain these exact, bounded bytes through secret checks, lint, hash and storage. */
  private readBounded(root: string, sourceRel: string, rel: string, max: number, expected: fs.Stats): Buffer {
    if (process.platform === 'darwin') return this.nativeFile('read', root, sourceRel, max);
    let fd: number;
    try { fd = this.openContained(root, sourceRel, fs.constants.O_RDONLY); }
    catch (e) {
      if (e instanceof CommandError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      throw new CommandError(`${rel}: ${['ELOOP', 'EPERM', 'ENOTDIR'].includes(code ?? '') ? 'path became a symlink during capture' : 'unreadable'}`, 400);
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new CommandError(`${rel}: not a regular file`, 400);
      if (st.dev !== expected.dev || st.ino !== expected.ino) throw new CommandError(`${rel} changed during capture`, 409);
      if (st.size > max) throw new CommandError(`${rel}: ${st.size} bytes is over the ${max} byte limit`, 400);
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      const after = fs.fstatSync(fd);
      if (off !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw new CommandError(`${rel} changed while reading; try again`, 409);
      return buf;
    } finally { fs.closeSync(fd); }
  }

  private nativeFile(operation: 'read' | 'write', root: string, rel: string, max: number, input?: Buffer): Buffer {
    const helper = process.env.ACC_NATIVE_FILE_HELPER;
    if (!helper || !path.isAbsolute(helper)) throw new CommandError('Safe mock capture needs the desktop native file helper (ACC_NATIVE_FILE_HELPER)', 503);
    const result = spawnSync(helper, [`--mock-file-${operation}`, root, rel, String(max)], { input, maxBuffer: max + 4096, timeout: 5000, windowsHide: true });
    if (result.error || result.status !== 0) throw new CommandError(`${rel}: ${result.stderr?.toString('utf8').trim().slice(0, 200) || 'native snapshot unavailable'}`, 409);
    return result.stdout;
  }

  private collect(worktree: string, dir: string): Collected[] {
    if (!MOCK_DIR_RE.test(dir)) throw new CommandError('Mocks live in design/<slug>/ (lowercase letters, digits and dashes).');
    const root = fs.realpathSync(worktree);
    let cur = root;
    for (const part of dir.split('/')) {
      cur = path.join(cur, part);
      let st: fs.Stats;
      try { st = fs.lstatSync(cur); } catch { throw new CommandError(`${dir} does not exist in the assignment worktree`, 404); }
      if (st.isSymbolicLink()) throw new CommandError(`${path.relative(root, cur)} is a symlink; mocks must be real files`, 400);
      if (!st.isDirectory()) throw new CommandError(`${path.relative(root, cur)} is not a folder`, 400);
    }
    const out: Collected[] = [];
    const problems: string[] = [];
    let capturedBytes = 0, visited = 0, exhausted = false;
    const walk = (abs: string, rel: string, depth: number) => {
      if (exhausted) return;
      if (depth > 6) { problems.push(`${rel}: nested too deeply`); return; }
      const dirRel = path.relative(root, abs);
      let dirFd: number;
      try { dirFd = this.openContained(root, dirRel, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); }
      catch { problems.push(`${rel}: directory changed or became a symlink during capture`); return; }
      try {
        const pinned = process.platform === 'linux' ? `/proc/self/fd/${dirFd}` : abs;
        for (const e of fs.readdirSync(pinned, { withFileTypes: true })) {
          if (exhausted) return;
          if (++visited > MOCK_LIMITS.files * 8) { exhausted = true; problems.push('Too many mock directory entries'); return; }
          if (IGNORED.has(e.name)) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          const p = path.join(pinned, e.name);
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink()) { problems.push(`${r}: symlinks are not allowed`); continue; }
          if (st.isDirectory()) { if (depth === 0 && e.name === EVIDENCE_DIR) continue; walk(path.join(root, dir, r), r, depth + 1); continue; }
          if (!st.isFile()) { problems.push(`${r}: not a regular file`); continue; }
          if (!/^[A-Za-z0-9._-]+$/.test(e.name) || e.name.startsWith('.')) { problems.push(`${r}: unsupported file name`); continue; }
          if (!MOCK_EXTENSIONS[path.extname(e.name).toLowerCase()]) { problems.push(`${r}: unrelated file type (allowed: ${Object.keys(MOCK_EXTENSIONS).join(' ')})`); continue; }
          if (st.size > MOCK_LIMITS.fileBytes) { problems.push(`${r}: ${st.size} bytes is over the ${MOCK_LIMITS.fileBytes} byte limit`); continue; }
          if (out.length >= MOCK_LIMITS.files) { exhausted = true; problems.push(`Over the ${MOCK_LIMITS.files} file limit`); return; }
          try {
            const content = this.readBounded(root, `${dir}/${r}`, r, Math.min(MOCK_LIMITS.fileBytes, MOCK_LIMITS.totalBytes - capturedBytes), st);
            capturedBytes += content.length;
            out.push({ rel: r, abs: path.join(root, dir, r), bytes: content.length, content });
          }
          catch (e) { problems.push(`${r}: ${e instanceof CommandError ? e.message.replace(`${r}: `, '') : 'unreadable'}`); }
        }
      } finally { fs.closeSync(dirFd); }
    };
    walk(cur, '', 0);
    if (out.length > MOCK_LIMITS.files) problems.push(`${out.length} files is over the ${MOCK_LIMITS.files} file limit`);
    const total = out.reduce((n, f) => n + f.bytes, 0);
    if (total > MOCK_LIMITS.totalBytes) problems.push(`${total} bytes is over the ${MOCK_LIMITS.totalBytes} byte limit`);
    if (!out.some(f => f.rel === 'index.html')) problems.push('index.html is required as the entry page');
    if (problems.length) throw new CommandError(`Mock rejected: ${problems.slice(0, 8).join('; ')}`, 400);
    for (const f of out) {
      const real = fs.realpathSync(f.abs);
      if (!real.startsWith(root + path.sep)) throw new CommandError(`${f.rel} resolves outside the worktree`, 400);
    }
    return out;
  }

  /** Internal trusted generator only; never exposed as an arbitrary file-write API. */
  storeStructuredBlob(content: string): string { return this.putBlob(Buffer.from(content)); }

  private putBlob(content: Buffer): string {
    const h = sha(content);
    const file = path.join(this.blobDir(), h);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.blobDir(), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    return h;
  }

  private blobBySha(h: string, label: string): Buffer {
    const file = path.join(this.blobDir(), h);
    if (!/^[a-f0-9]{64}$/.test(h) || !fs.existsSync(file)) throw new CommandError(`Stored content for ${label} is missing`, 410);
    const b = fs.readFileSync(file);
    if (sha(b) !== h) throw new CommandError(`Stored content for ${label} failed its integrity check`, 409);
    return b;
  }
  private blob(f: MockFile): Buffer { return this.blobBySha(f.sha256, f.path); }

  /**
   * Capture design/<slug>/ from an assignment worktree as a new immutable revision. Agents may only
   * capture their own assignment; unchanged content returns the existing revision. Every outcome,
   * including a rejection, is recorded so studio jobs never lose a failed capture.
   */
  async capture(assignmentId: string, dir: string, actor: Actor, o: CaptureOptions = {}) {
    const clean=String(dir??'').replace(/^\.\//,'').replace(/\/+$/,'');
    const continued=this.d.designer.studio.continuedArtifact(assignmentId,clean);
    const existing=Object.values(this.all()).find(m=>m.assignmentId===assignmentId&&m.dir===clean);
    const key=continued??existing?.id??`${assignmentId}:${clean}`;
    const previous=this.captureTails.get(key);
    const task=(previous??Promise.resolve()).catch(()=>undefined).then(()=>this.captureTracked(assignmentId,clean,actor,o));
    this.captureTails.set(key,task);
    try{return await task;}
    finally{if(this.captureTails.get(key)===task)this.captureTails.delete(key);}
  }

  private async captureTracked(assignmentId:string,dir:string,actor:Actor,o:CaptureOptions) {
    if(this.d.closed)throw new CommandError('The project engine is closed',503);
    const trigger = o.trigger ?? (actor.type === 'agent' ? 'agent' : actor.type === 'human' ? 'human' : 'auto');
    const clean = String(dir ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
    try {
      const result = await this.captureInner(assignmentId, clean, actor, o, trigger);
      this.d.designer.studio.recordCapture({ assignmentId, dir: clean, runId: o.runId ?? null, trigger, actor, ok: true, artifactId: result.artifact.id, rev: result.revision.rev, unchanged: result.unchanged });
      return result;
    } catch (e) {
      if (this.d.state.assignments[assignmentId] && MOCK_DIR_RE.test(clean)) this.d.designer.studio.recordCapture({ assignmentId, dir: clean, runId: o.runId ?? null, trigger, actor, ok: false, error: (e as Error).message });
      throw e;
    }
  }

  private async captureInner(assignmentId: string, dir: string, actor: Actor, o: CaptureOptions, trigger: string) {
    const a: Assignment | undefined = this.d.state.assignments[assignmentId];
    if (!a) throw new CommandError('Unknown assignment', 404);
    if (!a.worktree || !fs.existsSync(a.worktree)) throw new CommandError('The assignment has no worktree yet', 409);
    const collected = this.collect(a.worktree, dir);
    const rels = collected.map(f => `${dir}/${f.rel}`);
    const outside = rels.filter(r => !inScope(r, a.allowedPaths));
    if (outside.length) throw new CommandError(`Outside this assignment's allowed paths: ${outside.slice(0, 5).join(', ')}`, 403);
    const files: MockFile[] = [];
    const texts: { path: string; kind: MockFile['kind']; text: string | null }[] = [];
    for (const f of collected) {
      const content = f.content;
      const kind = MOCK_EXTENSIONS[path.extname(f.rel).toLowerCase()]!;
      const text = TEXT_KINDS.has(kind) ? content.toString('utf8') : null;
      if (text !== null && containsSecret(text, { denylist: this.d.denylist() }).length) throw new CommandError(`${f.rel} contains a credential; remove it before capture`, 400);
      files.push({ path: f.rel, sha256: sha(content), bytes: content.length, kind });
      texts.push({ path: f.rel, kind, text });
    }
    files.sort((x, y) => x.path.localeCompare(y.path));
    const hash = sha(files.map(f => `${f.path}\0${f.sha256}`).join('\n'));
    const continued = this.d.designer.studio.continuedArtifact(a.id, dir);
    const existing = (continued ? this.all()[continued] : undefined) ?? Object.values(this.all()).find(m => m.assignmentId === a.id && m.dir === dir);
    if (existing && existing.revisions.at(-1)?.hash === hash) return { artifact: this.view(existing), revision: existing.revisions.at(-1)!, unchanged: true };
    let handoff: DesignHandoff | null = null, invalid: string | null = null;
    if (o.handoff !== undefined && o.handoff !== null) {
      const h = DesignHandoffSchema.safeParse(o.handoff);
      if (!h.success) invalid = h.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      else if (containsSecret(JSON.stringify(h.data), { denylist: this.d.denylist() }).length) invalid = 'it contains a credential';
      else handoff = h.data;
    }
    for (const f of collected) this.putBlob(f.content);
    const design = a.designRevision ? this.d.designer.revision(a.designRevision) : null;
    const job = this.d.designer.studio.jobForAssignment(a.id);
    const origin: MockOrigin = o.origin ?? (trigger === 'agent' ? 'agent' : trigger === 'auto' ? 'auto' : 'capture');
    const now = this.d.nowIso();
    const revision: MockRevision = {
      rev: (existing?.revisions.at(-1)?.rev ?? 0) + 1, hash, entry: 'index.html', files,
      designRevision: design ? { hash: design.hash, version: design.version } : null,
      gitSha: await headSha(a.worktree).catch(() => null), runId: o.runId ?? null,
      findings: [...lintMock(texts, design, 'index.html'), ...handoffFindings({ handoff, invalid, files, contractHash: design?.hash ?? null, expectedPages: job?.kind === 'generate' && job.brief ? briefPages(job.brief).map(p => p.path) : [], studio: Boolean(job), origin })],
      exceptions: [], reviews: [], evidence: [], capturedAt: now, by: actor,
      authoredBy: o.authoredBy ?? (actor.type === 'agent' ? actor : agentActor(a.agentId)), origin,
      assignmentId: a.id, workItemId: a.workItemId, agentId: a.agentId, handoff, parentRev: existing?.revisions.at(-1)?.rev ?? null,
    };
    const title = (o.title ?? existing?.title ?? this.titleOf(texts.find(t => t.path === 'index.html')?.text ?? '') ?? dir).trim().slice(0, 120) || dir;
    const artifact = { id: existing?.id ?? newId('mock'), workItemId: existing?.workItemId ?? a.workItemId, assignmentId: existing?.assignmentId ?? a.id, agentId: existing?.agentId ?? a.agentId, dir, title, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.d.commit([{ type: 'design.mock_captured', actor, agentId: a.agentId, workItemId: a.workItemId, assignmentId: a.id, runId: o.runId ?? null, data: { artifact, revision } }]);
    return { artifact: this.view(this.get(artifact.id)), revision: this.get(artifact.id).revisions.at(-1)!, unchanged: false };
  }

  private titleOf(html: string): string | null {
    const m = /<title>([^<]{1,120})<\/title>/i.exec(html);
    return m ? m[1].trim() : null;
  }

  readSource(id: string, rev: number | 'latest', file: string) {
    const a = this.get(id), r = this.rev(a, rev);
    const f = r.files.find(x => x.path === file);
    if (!f) throw new CommandError('Not a file of this mock revision', 404);
    const b = this.blob(f);
    return { artifactId: a.id, rev: r.rev, path: f.path, kind: f.kind, sha256: f.sha256, bytes: f.bytes, encoding: TEXT_KINDS.has(f.kind) ? 'utf8' as const : 'base64' as const, content: TEXT_KINDS.has(f.kind) ? this.d.redactText(b.toString('utf8')) : b.toString('base64') };
  }

  private dataUri(f: MockFile): string {
    return `data:${MIME[path.extname(f.path).toLowerCase()] ?? 'application/octet-stream'};base64,${this.blob(f).toString('base64')}`;
  }

  /** One self-contained document for a page: local assets inlined, remote ones left for the CSP to block. */
  private assemble(r: MockRevision, page: string): string {
    const pageFile = r.files.find(f => f.path === page && f.kind === 'html');
    if (!pageFile) throw new CommandError('Unknown mock page', 404);
    const byPath = new Map(r.files.map(f => [f.path, f]));
    const resolve = (from: string, ref: string): MockFile | null => {
      const v = ref.trim().split(/[?#]/)[0];
      if (!v || REMOTE.test(v) || SCHEME.test(v) || v.startsWith('/')) return null;
      const t = path.posix.normalize(path.posix.join(path.posix.dirname(from), v));
      return t.startsWith('..') ? null : byPath.get(t) ?? null;
    };
    const inlineCss = (css: string, from: string) => css
      .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (m, x, y, z) => { const f = resolve(from, (x ?? y ?? z ?? '').trim()); return f && f.kind !== 'html' && f.kind !== 'js' ? `url("${this.dataUri(f)}")` : m; })
      .replace(/<\/style/gi, '<\\/style');
    let html = this.blob(pageFile).toString('utf8');
    html = html
      .replace(/<meta[^>]+http-equiv\s*=\s*["']?(?:refresh|content-security-policy)[^>]*>/gi, '')
      .replace(/<base\b[^>]*>/gi, '')
      .replace(/<link\b[^>]*>/gi, tag => {
        if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return /\brel\s*=\s*["']?(?:preload|prefetch|preconnect|dns-prefetch|modulepreload|icon|manifest)/i.test(tag) ? '' : tag;
        const f = resolve(page, attr(tag, 'href') ?? '');
        return f?.kind === 'css' ? `<style data-src="${f.path}">${inlineCss(this.blob(f).toString('utf8'), f.path)}</style>` : tag;
      })
      .replace(/<script\b([^>]*)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>\s*<\/script>/gi, (m, pre, x, y, z, post) => {
        const f = resolve(page, x ?? y ?? z ?? '');
        if (f?.kind !== 'js') return m;
        const type = /\btype\s*=\s*["']?module/i.test(`${pre} ${post}`) ? ' type="module"' : '';
        return `<script data-src="${f.path}"${type}>${this.blob(f).toString('utf8').replace(/<\/script/gi, '<\\/script')}</script>`;
      })
      .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => (/data-src=/.test(attrs) ? m : `<style${attrs}>${inlineCss(css, page)}</style>`))
      .replace(/\b(src|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, name, x, y) => {
        const f = resolve(page, x ?? y ?? '');
        return f && f.kind !== 'html' && f.kind !== 'js' && f.kind !== 'css' ? `${name}="${this.dataUri(f)}"` : m;
      })
      .replace(/\bstyle\s*=\s*"([^"]*)"/gi, (_m, css) => `style="${inlineCss(css, page).replace(/"/g, '&quot;')}"`);
    const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MOCK_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">${GUARD}`;
    // Always precede untrusted parser input, including malformed HTML or scripts before <head>.
    return `<!doctype html>${head}${html}`;
  }

  /**
   * The page document, a trusted native shell carrying every page of the revision (so local links
   * work inside the isolated window) and a script-free render for the browser dashboard.
   */
  preview(id: string, rev: number | 'latest' = 'latest', page = 'index.html') {
    const a = this.get(id), r = this.rev(a, rev);
    const html = this.assemble(r, page);
    const pageNames = r.files.filter(f => f.kind === 'html').map(f => f.path);
    const pages = Object.fromEntries(pageNames.map(p => [p, p === page ? html : this.assemble(r, p)]));
    const shell = mockPreviewShell(html, pages, { page, label: `${a.title} · rev ${r.rev}` });
    const fits = Buffer.byteLength(shell) <= MOCK_LIMITS.previewShellBytes;
    return {
      artifactId: a.id, rev: r.rev, hash: r.hash, page, pages: pageNames, html,
      shell: fits ? shell : null, shellError: fits ? null : 'All pages together are too large for one interactive preview window. Open fewer pages or reduce inlined images.',
      static: mockStaticDocument(html),
      execution: 'native-isolated' as const, csp: MOCK_PREVIEW_CSP, sandbox: MOCK_IFRAME_SANDBOX, viewports: VIEWPORTS,
      designRevision: r.designRevision,
    };
  }

  /** The assignment whose worktree holds the latest revision (a refinement may live on a new assignment). */
  private latestAssignment(a: MockArtifact): Assignment | undefined {
    const latest = a.revisions.at(-1)!;
    return this.d.state.assignments[latest.assignmentId ?? a.assignmentId];
  }

  /** Human edit through the scoped API: writes the worktree file, then captures a new revision. */
  async editSource(id: string, file: string, content: string, expectedSha: string | null) {
    const a = this.get(id);
    const asg = this.latestAssignment(a);
    if (!asg?.worktree || !fs.existsSync(asg.worktree)) throw new CommandError('The assignment worktree is gone; export this revision instead', 409);
    if (Object.values(this.d.state.runs).some(r => r.assignmentId === asg.id && isActiveRun(r))) throw new CommandError('Stop the active run before editing its mock', 409);
    if (typeof content !== 'string') throw new CommandError('content is required');
    if (!/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){0,5}[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(file) || file.split('/').some(p => p === '..' || p.startsWith('.'))) throw new CommandError('Invalid file path', 400);
    if (file.split('/')[0] === EVIDENCE_DIR) throw new CommandError('evidence/ holds check screenshots, not mock source', 400);
    const kind = MOCK_EXTENSIONS[path.extname(file).toLowerCase()];
    if (!kind || !TEXT_KINDS.has(kind)) throw new CommandError('Only text mock files (html, css, js, svg, json, md) can be edited here', 400);
    if (Buffer.byteLength(content) > MOCK_LIMITS.fileBytes) throw new CommandError('File is over the size limit', 413);
    if (containsSecret(content, { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from the mock', 400);
    const rel = `${a.dir}/${file}`;
    if (!inScope(rel, asg.allowedPaths)) throw new CommandError('Outside this assignment’s allowed paths', 403);
    const root = fs.realpathSync(asg.worktree);
    const edit = { authoredBy: HUMAN, origin: 'edit' as const };
    if (process.platform === 'darwin') {
      if (expectedSha === null) throw new CommandError('Choose an existing captured file to edit', 400);
      const current = this.nativeFile('read', root, rel, MOCK_LIMITS.fileBytes);
      if (sha(current) !== expectedSha) throw new CommandError('The file changed since you opened it. Reload before saving.', 409);
      const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(current.length));
      this.nativeFile('write', root, rel, MOCK_LIMITS.fileBytes, Buffer.concat([size, current, Buffer.from(content)]));
      return this.capture(asg.id, a.dir, HUMAN, edit);
    }
    // Use the same kernel ancestor protection as capture, and compare/write through one fd.
    // Parent folders must already exist; the UI edits captured files rather than creating trees.
    let fd: number;
    try { fd = this.openContained(root, rel, fs.constants.O_RDWR | (expectedSha === null ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0), 0o644); }
    catch { throw new CommandError('The mock path changed or became a symlink. Reload before saving.', 409); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MOCK_LIMITS.fileBytes) throw new CommandError('Not a bounded regular mock file', 409);
      const current = Buffer.alloc(st.size);
      let offset = 0;
      while (offset < current.length) {
        const n = fs.readSync(fd, current, offset, current.length - offset, offset);
        if (!n) break;
        offset += n;
      }
      const after = fs.fstatSync(fd);
      if (offset !== st.size || after.size !== st.size || after.ctimeMs !== st.ctimeMs || (expectedSha !== null && sha(current) !== expectedSha)) throw new CommandError('The file changed since you opened it. Reload before saving.', 409);
      fs.ftruncateSync(fd, 0);
      const bytes = Buffer.from(content);
      for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    } finally { fs.closeSync(fd); }
    return this.capture(asg.id, a.dir, HUMAN, edit);
  }

  /** File-level comparison of two revisions, plus a bounded line diff for one text file. */
  compare(id: string, from: number, to: number, file?: string) {
    const a = this.get(id), x = this.rev(a, from), y = this.rev(a, to);
    const files = compareRevisions(x, y);
    let diff: ReturnType<typeof lineDiff> | undefined;
    if (file) {
      const fx = x.files.find(f => f.path === file), fy = y.files.find(f => f.path === file);
      if (!fx && !fy) throw new CommandError('Not a file of either revision', 404);
      const kind = (fx ?? fy)!.kind;
      if (!TEXT_KINDS.has(kind)) diff = null;
      else diff = lineDiff(fx ? this.d.redactText(this.blob(fx).toString('utf8')) : '', fy ? this.d.redactText(this.blob(fy).toString('utf8')) : '');
    }
    return { artifactId: a.id, ...files, file: file ?? null, diff: diff === undefined ? undefined : diff, tooLarge: diff === null, gates: { from: mockGate(x, this.d.state.design?.hash ?? null).state, to: mockGate(y, this.d.state.design?.hash ?? null).state } };
  }

  /** Mock files plus the exact DESIGN.md, tokens and evidence of the contract it was built against. */
  export(id: string, rev: number | 'latest' = 'latest', o: { approvedOnly?: boolean } = {}) {
    const a = this.get(id), r = this.rev(a, rev);
    const design = r.designRevision ? this.d.designer.revision(r.designRevision.hash) : null;
    const gate = mockGate(r, this.d.state.design?.hash ?? null);
    if (o.approvedOnly && gate.state !== 'approved') throw new CommandError(`Revision ${r.rev} is ${gate.state.replace(/_/g, ' ')}. Only an approved revision can be exported as a handoff bundle.`, 409);
    const files = r.files.map(f => {
      const b = this.blob(f);
      return { path: f.path, sha256: f.sha256, bytes: f.bytes, encoding: TEXT_KINDS.has(f.kind) ? 'utf8' as const : 'base64' as const, content: TEXT_KINDS.has(f.kind) ? this.d.redactText(b.toString('utf8')) : b.toString('base64') };
    });
    const author = authorOf(r);
    const approval = gate.approval?.review ?? null;
    const manifest = {
      format: 'one-connect.design-handoff/1',
      artifact: a.id, title: a.title, dir: a.dir, issue: this.d.state.workItems[r.workItemId ?? a.workItemId]?.key ?? r.workItemId ?? a.workItemId, assignment: r.assignmentId ?? a.assignmentId,
      revision: r.rev, contentHash: r.hash, gitSha: r.gitSha, runId: r.runId, author: `${author.type}:${author.id}`, capturedAt: r.capturedAt,
      designContract: r.designRevision, currentContract: this.d.state.design ? { hash: this.d.state.design.hash, version: this.d.state.design.version } : null,
      gate: gate.state, openFindings: gate.open.map(f => f.id),
      approval: approval ? { by: `${approval.by.type}:${approval.by.id}`, at: approval.at, note: approval.note, checklist: approval.checklist ?? null, independent: gate.state === 'approved' } : null,
      reviews: r.reviews.map(v => ({ decision: v.decision, by: `${v.by.type}:${v.by.id}`, at: v.at, note: v.note, independent: v.independent ?? null, checklist: v.checklist ?? null })),
      exceptions: r.exceptions.map(e => ({ id: e.id, findingIds: e.findingIds, rationale: e.rationale, by: e.by.id, at: e.at })),
      evidence: r.evidence.map(e => ({ id: e.id, kind: e.kind, status: e.status, executed: e.executed, verified: e.verified, source: e.source, summary: e.summary, action: e.action ?? null, tool: e.tool ?? null, viewport: e.viewport ?? null, page: e.page ?? null, command: e.command ?? null, exitCode: e.exitCode ?? null, screenshot: e.screenshot ?? null, at: e.at, by: `${e.by.type}:${e.by.id}` })),
      staticFindings: r.findings.map(f => ({ id: f.id, severity: f.severity, rule: f.rule, message: f.message, file: f.file ?? null })),
      agentHandoff: r.handoff ?? null,
      note: 'Static checks do not prove visual compliance. Agent handoff entries are claims; evidence marked verified was observed by One Connect.',
      published: false,
    };
    const evidenceImages = r.evidence.filter(e => e.screenshot?.stored === 'evidence').map(e => ({ evidenceId: e.id, path: e.screenshot!.path, sha256: e.screenshot!.sha256, encoding: 'base64' as const, content: this.blobBySha(e.screenshot!.sha256, e.screenshot!.path).toString('base64') }));
    const handoffMd = this.handoffMarkdown(a, r, manifest, design);
    return { ...(r.document ? { structuredRelease: this.d.designer.documents.releaseBundle(id, r.rev) } : {}), manifest, files, preview: this.assemble(r, r.entry), designMarkdown: design ? designMarkdown(design) : null, tokensCss: design ? designCss(design.system) : null, tokensJson: design ? designTokensJson(design) : null, specimenHtml: design ? designSpecimenHtml(design) : null, evidenceImages, handoffMd, exportedAt: this.d.nowIso() };
  }

  private handoffMarkdown(a: MockArtifact, r: MockRevision, m: { gate: string; approval: unknown; issue: string }, design: DesignRevision | null): string {
    const ev = r.evidence.map(e => `- ${e.kind} · ${e.status}${e.verified ? ' (observed by One Connect)' : ` (reported by ${e.source})`}${e.viewport ? ` · ${e.viewport.name} ${e.viewport.width}×${e.viewport.height}` : ''}${e.tool ? ` · ${e.tool}` : ''}: ${e.action ?? e.summary}`).join('\n') || '- None attached.';
    return `# Design handoff: ${a.title}\n\nArtifact ${a.id} (${a.dir}/) revision ${r.rev}\nContent SHA-256 ${r.hash}${r.gitSha ? `\nGit ${r.gitSha}` : ''}\nDesign contract ${design ? `v${design.version} · SHA-256 ${design.hash}` : 'none'}\nIssue ${m.issue}\nGate: ${m.gate}\n\n## Evidence\n\n${ev}\n\n## Implementing it\n\n1. Read DESIGN.md and import tokens.css (or map tokens.json) from this bundle; they are the exact contract this revision was approved against.\n2. Rebuild each page with the application's components. The mock is a reference, not production code.\n3. Implement every empty, loading, error and success state the mock shows.\n4. Record keyboard, focus and phone/tablet/desktop evidence with the commands you actually ran.\n5. Record any deviation as a human-approved design exception.\n\nExported locally. Nothing was published, pushed or sent.\n`;
  }

  addException(id: string, rev: number, findingIds: string[], rationale: string, actor: Actor = HUMAN) {
    if (actor.type !== 'human') throw new CommandError('Only a human can record a design exception', 403);
    const a = this.get(id), r = this.rev(a, rev);
    const text = String(rationale ?? '').trim();
    if (text.length < 10) throw new CommandError('Explain the exception (10+ characters)');
    if (containsSecret(text, { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from the rationale');
    const gate = mockGate(r, this.d.state.design?.hash ?? null);
    const known = new Map([...r.findings, ...(gate.drift ? [gate.drift] : [])].map(f => [f.id, f]));
    const ids = [...new Set(findingIds ?? [])];
    if (!ids.length || ids.some(i => !known.has(i))) throw new CommandError('Choose findings from this revision');
    if (ids.some(i => known.get(i)!.severity === 'error')) throw new CommandError('Blocking findings (remote resources, navigation, outside paths) must be fixed, not excepted', 409);
    const exception = { id: newId('dex'), findingIds: ids, rationale: text.slice(0, 2000), by: actor, at: this.d.nowIso() };
    this.d.commit([{ type: 'design.mock_exception', actor, workItemId: a.workItemId, assignmentId: a.assignmentId, data: { artifactId: a.id, rev: r.rev, exception } }]);
    return this.view(this.get(id));
  }

  /**
   * Validates a checklist against this revision. Approval needs every item to pass, a rendered
   * (human or browser) basis for everything except measured contrast, and executed evidence for
   * any browser claim.
   */
  private checklist(r: MockRevision, input: unknown, approving: boolean, who: 'human' | 'agent'): ChecklistResult[] {
    const items = Array.isArray(input) ? input as Record<string, unknown>[] : [];
    const byId = new Map(items.filter(x => x && typeof x === 'object').map(x => [String(x.id), x]));
    const evidence = new Map(r.evidence.map(e => [e.id, e]));
    const out: ChecklistResult[] = REVIEW_CHECKLIST.map(c => {
      const x = byId.get(c.id) ?? {};
      const result = x.result === 'pass' || x.result === 'fail' ? x.result : 'not_checked';
      const bases = who === 'human' ? ['human', 'browser', 'static'] : ['static', 'browser'];
      const basis = bases.includes(String(x.basis)) ? x.basis as ChecklistResult['basis'] : (who === 'human' ? 'human' : 'static');
      const evidenceIds = (Array.isArray(x.evidenceIds) ? x.evidenceIds.map(String) : []).filter(id => evidence.has(id)).slice(0, 20);
      const note = typeof x.note === 'string' ? x.note.trim().slice(0, 500) : '';
      return { id: c.id, result, basis, evidenceIds, ...(note ? { note } : {}) };
    });
    if (out.some(c => c.note && containsSecret(c.note, { denylist: this.d.denylist() }).length)) throw new CommandError('Remove credentials from the checklist notes');
    if (!approving) return out;
    const unmet = out.filter(c => c.result !== 'pass');
    if (unmet.length) throw new CommandError(`Every checklist item must pass before approval: ${unmet.map(c => REVIEW_CHECKLIST.find(x => x.id === c.id)!.label).join(', ')}`, 409);
    const staticOnly = out.filter(c => c.id !== 'contrast' && c.basis === 'static');
    if (who === 'human' && staticOnly.length) throw new CommandError(`Static checks cannot pass ${staticOnly.map(c => REVIEW_CHECKLIST.find(x => x.id === c.id)!.label.toLowerCase()).join(', ')}. Look at the rendered mock or attach an executed browser check.`, 409);
    const unproven = out.filter(c => c.basis === 'browser' && !c.evidenceIds.some(id => { const e = evidence.get(id)!; return e.executed && e.status === 'passed' && (who === 'human' || e.verified); }));
    if (unproven.length) throw new CommandError(`A browser basis needs passed, executed evidence on this revision${who === 'agent' ? ' that One Connect observed in your run' : ''}: ${unproven.map(c => c.id).join(', ')}`, 409);
    return out;
  }

  review(id: string, rev: number, decision: 'approved' | 'changes_requested', note: string, actor: Actor = HUMAN, o: { checklist?: unknown } = {}) {
    if (actor.type !== 'human') throw new CommandError('Only a human can review a design mock', 403);
    if (decision !== 'approved' && decision !== 'changes_requested') throw new CommandError('Choose approved or changes_requested');
    const a = this.get(id), r = this.rev(a, rev);
    const gate = mockGate(r, this.d.state.design?.hash ?? null);
    if (decision === 'approved' && gate.open.length) throw new CommandError(`Resolve or except ${gate.open.length} open finding${gate.open.length === 1 ? '' : 's'} before approving`, 409);
    const text = String(note ?? '').slice(0, 2000);
    if (containsSecret(text, { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from the review note');
    const checklist = this.checklist(r, o.checklist, decision === 'approved', 'human');
    const author = authorOf(r);
    const review: MockReview = { decision, note: text, by: actor, at: this.d.nowIso(), hash: r.hash, designHash: r.designRevision?.hash ?? null, checklist, independent: !(author.type === actor.type && author.id === actor.id) };
    this.d.commit([{ type: 'design.mock_reviewed', actor, workItemId: a.workItemId, assignmentId: a.assignmentId, data: { artifactId: a.id, rev: r.rev, review } }]);
    return this.view(this.get(id));
  }

  /** Independent agent review from a review assignment. Advisory: a human still makes the approval. */
  agentReview(id: string, rev: number, input: Record<string, unknown>, actor: Actor, runId: string) {
    if (actor.type !== 'agent') throw new CommandError('Agent reviews come from an agent run', 403);
    const run = this.d.state.runs[runId];
    const a = this.get(id), r = this.rev(a, rev);
    if (!run || !this.d.designer.studio.reviewJobFor(run.assignmentId, a.id, r.rev)) throw new CommandError('This run was not asked to review that revision', 403);
    const author = authorOf(r);
    if (author.type === 'agent' && author.id === actor.id) throw new CommandError('The author cannot review their own revision', 409);
    const verdict = input.verdict === 'approve' ? 'approved' : input.verdict === 'request_changes' ? 'changes_requested' : null;
    if (!verdict) throw new CommandError('verdict must be approve or request_changes');
    const summary = String(input.summary ?? '').trim().slice(0, 2000);
    if (!summary) throw new CommandError('summary is required');
    if (containsSecret(summary, { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from the summary');
    const checklist = this.checklist(r, input.checklist, verdict === 'approved', 'agent');
    const review: MockReview = { decision: verdict, note: summary, by: actor, at: this.d.nowIso(), hash: r.hash, designHash: r.designRevision?.hash ?? null, checklist, independent: true, runId };
    this.d.commit([{ type: 'design.mock_reviewed', actor, agentId: actor.id, runId, workItemId: run.workItemId, assignmentId: run.assignmentId, data: { artifactId: a.id, rev: r.rev, review } }]);
    return review;
  }

  /** An agent may act on mocks its own assignment produced or continues. */
  assertAgentAccess(art: MockArtifact, assignmentId: string): void {
    if (art.assignmentId === assignmentId || art.revisions.some(r => r.assignmentId === assignmentId) || this.d.designer.studio.continuedArtifact(assignmentId, art.dir) === art.id) return;
    throw new CommandError('This mock belongs to another assignment', 403);
  }

  /** Bounded, redacted read of one revision's files for an agent with access or a review job. */
  agentRead(id: string, rev: number | 'latest', assignmentId: string, o: { path?: string; offset?: number; budget?: number } = {}) {
    const a = this.get(id), r = this.rev(a, rev);
    const binding = this.d.state.assignments[assignmentId]?.mockBinding;
    if (binding?.artifactId === id) {
      if (binding.rev !== r.rev || binding.hash !== r.hash) throw new CommandError('Read only the approved workflow design revision', 403);
    } else if (!this.d.designer.studio.reviewJobFor(assignmentId, a.id)) this.assertAgentAccess(a, assignmentId);
    const meta = { ...(r.document ? { document: r.document, sourceFiles: this.d.designer.documents.release(a.id, r.rev).manifest.files.map(f => `source/${f.path}`), note: 'Structured release: read the design with get_design_document (documentId above) and its React package under source/.' } : {}), artifactId: a.id, title: a.title, dir: a.dir, rev: r.rev, hash: r.hash, designRevision: r.designRevision, files: r.files.map(f => ({ path: f.path, kind: f.kind, bytes: f.bytes, sha256: f.sha256 })), findings: r.findings.filter(f => f.severity !== 'info').map(f => `${f.rule}: ${f.message}`).slice(0, 20), handoff: r.handoff ?? null };
    if (!o.path) return meta;
    if (r.document && o.path.startsWith('source/')) {
      const file = this.d.designer.documents.releaseFile(a.id, r.rev, o.path.slice(7));
      if (file.kind === 'binary') return { ...meta, path: o.path, content: null, note: 'Binary asset; its hash is in the release manifest.' };
      const text = this.d.redactText(file.data.toString('utf8'));
      const offset = Number.isSafeInteger(o.offset) ? Math.max(0, o.offset!) : 0, budget = Number.isFinite(o.budget) ? Math.min(12000, Math.max(1000, Math.floor(o.budget!))) : 6000;
      return { ...meta, path: o.path, content: text.slice(offset, offset + budget), nextOffset: Math.min(text.length, offset + budget), more: offset + budget < text.length };
    }
    const f = r.files.find(x => x.path === o.path);
    if (!f) throw new CommandError('Not a file of this mock revision', 404);
    if (!TEXT_KINDS.has(f.kind)) return { ...meta, path: f.path, content: null, note: 'Binary file; only its hash and size are available.' };
    const text = this.d.redactText(this.blob(f).toString('utf8'));
    const offset = Number.isSafeInteger(o.offset) ? Math.max(0, o.offset!) : 0, budget = Number.isFinite(o.budget) ? Math.min(12000, Math.max(1000, Math.floor(o.budget!))) : 6000;
    return { ...meta, path: f.path, content: text.slice(offset, offset + budget), nextOffset: Math.min(text.length, offset + budget), more: offset + budget < text.length };
  }

  /**
   * Evidence keeps what was claimed apart from what was observed: unexecuted checks are `not_run`,
   * and an agent's command is `verified` only if this run's transcript recorded it with that exit code.
   * Screenshots are images captured in the revision, uploaded by a human, or read from the agent's
   * design/<slug>/evidence/ folder; One Connect cannot tell what an image depicts.
   */
  addEvidence(id: string, rev: number | 'latest', input: Record<string, unknown>, actor: Actor, runId: string | null = null) {
    const a = this.get(id), r = this.rev(a, rev);
    const kind = input.kind;
    if (kind !== 'command' && kind !== 'screenshot' && kind !== 'viewport') throw new CommandError('kind must be command, screenshot or viewport');
    const summary = String(input.summary ?? '').trim().slice(0, 500);
    if (!summary) throw new CommandError('summary is required');
    const executed = input.executed === true;
    const ev: MockEvidence = { id: newId('mev'), kind, summary, status: 'not_run', executed, verified: false, source: actor.type === 'human' ? 'human' : 'agent', at: this.d.nowIso(), by: actor, ...(runId ? { runId } : {}), artifactHash: r.hash, designHash: r.designRevision?.hash ?? null };
    for (const [k, max] of [['action', 300], ['tool', 120]] as const) {
      const v = typeof input[k] === 'string' ? (input[k] as string).trim().slice(0, max) : '';
      if (v) ev[k] = v;
    }
    if (typeof input.page === 'string' && r.files.some(f => f.kind === 'html' && f.path === input.page)) ev.page = input.page;
    if (containsSecret(JSON.stringify([summary, ev.action, ev.tool, input.command]), { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from the evidence');
    if (input.viewport) {
      const v = input.viewport as { name?: unknown; width?: unknown; height?: unknown };
      const w = Number(v.width), h = Number(v.height);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 240 || w > 3840 || h < 240 || h > 3840) throw new CommandError('viewport needs integer width/height between 240 and 3840');
      ev.viewport = { name: String(v.name ?? `${w}x${h}`).slice(0, 40), width: w, height: h };
    } else if (kind === 'viewport') throw new CommandError('viewport evidence needs width and height');
    if (kind === 'command') {
      const command = String(input.command ?? '').trim();
      if (!command) throw new CommandError('command evidence needs the exact command');
      if(command.length>1000)throw new CommandError('command evidence is limited to 1000 characters; use an exact shorter recorded command');
      ev.command = command;
      ev.exitCode = input.exitCode === null || input.exitCode === undefined ? null : Number(input.exitCode);
    }
    let image: Buffer | null = null;
    if (typeof input.image === 'string') {
      if (actor.type !== 'human') throw new CommandError('Agents attach screenshots from design/<slug>/evidence/ in their worktree');
      const raw = input.image.replace(/^data:image\/[a-z]+;base64,/, '');
      if (raw.length > Math.ceil(MOCK_LIMITS.screenshotBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new CommandError('screenshot too large or not base64', 413);
      image = Buffer.from(raw, 'base64');
    } else if (input.screenshot !== undefined) {
      const p = String(input.screenshot);
      const f = r.files.find(x => x.path === p && x.kind === 'image');
      if (f) {
        if (f.bytes > MOCK_LIMITS.screenshotBytes) throw new CommandError('screenshot too large');
        ev.screenshot = { path: f.path, sha256: f.sha256, bytes: f.bytes, stored: 'revision' };
      } else if (actor.type === 'agent' && runId && new RegExp(`^${EVIDENCE_DIR}/[A-Za-z0-9_-][A-Za-z0-9._-]{0,80}\\.(?:png|jpe?g|webp)$`).test(p)) {
        image = this.readEvidenceFile(this.d.state.runs[runId]?.assignmentId, a.dir, p);
      } else throw new CommandError(`screenshot must be an image file captured in this revision, or (for agents) ${a.dir}/${EVIDENCE_DIR}/<name>.png in your worktree`);
    } else if (kind === 'screenshot') throw new CommandError('screenshot evidence needs an image');
    if (image) {
      const type = imageType(image);
      if (!type) throw new CommandError('screenshot must be a PNG, JPEG or WebP image');
      if (image.length > MOCK_LIMITS.screenshotBytes) throw new CommandError('screenshot too large', 413);
      const h = this.putBlob(image);
      ev.screenshot = { path: `${EVIDENCE_DIR}/${h.slice(0, 16)}.${type}`, sha256: h, bytes: image.length, stored: 'evidence' };
    }
    const claimed = input.status === 'passed' || input.status === 'failed' ? input.status : 'not_run';
    if (!executed) ev.status = 'not_run';
    else if (kind === 'command' && actor.type !== 'human') {
      const seen = runId ? this.d.store.list({ runId, types: ['t.command'], limit: 5000 }).some(e => e.type === 't.command' && e.data.command.trim()===ev.command && e.data.status !== 'started' && (e.data.exitCode ?? null) === ev.exitCode) : false;
      ev.verified = seen;
      ev.status = seen ? (ev.exitCode === 0 ? 'passed' : 'failed') : claimed === 'passed' ? 'not_run' : claimed;
    } else ev.status = claimed;
    this.d.commit([{ type: 'design.mock_evidence', actor, workItemId: a.workItemId, assignmentId: a.assignmentId, runId, data: { artifactId: a.id, rev: r.rev, evidence: ev } }]);
    return ev;
  }

  /** Reads design/<slug>/evidence/<file> from the run's own worktree with the capture read path. */
  private readEvidenceFile(assignmentId: string | undefined, dir: string, rel: string): Buffer {
    const asg = assignmentId ? this.d.state.assignments[assignmentId] : undefined;
    if (!asg?.worktree || !fs.existsSync(asg.worktree)) throw new CommandError('Your assignment has no worktree', 409);
    const full = `${dir}/${rel}`;
    if (!inScope(full, asg.allowedPaths)) throw new CommandError('That screenshot is outside your allowed paths', 403);
    const root = fs.realpathSync(asg.worktree);
    let cur = root;
    for (const part of full.split('/')) {
      cur = path.join(cur, part);
      let st: fs.Stats;
      try { st = fs.lstatSync(cur); } catch { throw new CommandError(`${full} does not exist in your worktree`, 404); }
      if (st.isSymbolicLink()) throw new CommandError(`${full}: symlinks are not allowed`, 400);
    }
    const st = fs.lstatSync(cur);
    if (!st.isFile()) throw new CommandError(`${full} is not a regular file`, 400);
    // The same bounded read as capture (the native helper's ceiling is the per-file mock limit).
    if (st.size > MOCK_LIMITS.fileBytes) throw new CommandError(`Worktree screenshots must be ${MOCK_LIMITS.fileBytes / 1024} KiB or smaller`, 413);
    return this.readBounded(root, full, rel, MOCK_LIMITS.fileBytes, st);
  }

  evidenceImage(id: string, evidenceId: string) {
    const a = this.get(id);
    for (const r of a.revisions) {
      const e = r.evidence.find(x => x.id === evidenceId);
      if (!e?.screenshot) continue;
      const b = this.blobBySha(e.screenshot.sha256, e.screenshot.path);
      const type = imageType(b);
      if (!type) throw new CommandError('Stored screenshot is not an image', 409);
      return { evidenceId, rev: r.rev, mime: type === 'jpg' ? 'image/jpeg' : `image/${type}`, sha256: e.screenshot.sha256, base64: b.toString('base64') };
    }
    throw new CommandError('Unknown screenshot evidence', 404);
  }

  /** Turns a review finding into a tracked issue with provenance, not just a comment. */
  findingToIssue(id: string, rev: number, findingId: string) {
    const a = this.get(id), r = this.rev(a, rev);
    const gate = mockGate(r, this.d.state.design?.hash ?? null);
    const f = [...r.findings, ...(gate.drift ? [gate.drift] : [])].find(x => x.id === findingId);
    if (!f) throw new CommandError('Unknown finding', 404);
    const parent = this.d.state.workItems[a.workItemId];
    return this.d.createIssue({
      title: `Design finding: ${f.message.slice(0, 90)}`,
      description: `Found in mock "${a.title}" (${a.dir}) revision ${r.rev}, content ${r.hash.slice(0, 12)}${r.designRevision ? `, contract v${r.designRevision.version}` : ''}${parent?.key ? `, from ${parent.key}` : ''}.\n\nRule: ${f.rule}${f.file ? `\nFile: ${f.file}${f.line ? `:${f.line}` : ''}` : ''}\n\n${f.message}`,
      acceptance: ['The finding is fixed in a new captured revision, or a human records an exception with rationale'],
      labels: ['finding', 'design'],
    }, HUMAN);
  }

  /** Vault note for Dictionary and team context. */
  contextNote(): string {
    const cur = this.d.state.design;
    const rows = Object.values(this.all()).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, 100).map(a => {
      const r = a.revisions.at(-1)!;
      const g = mockGate(r, cur?.hash ?? null);
      const key = this.d.state.workItems[a.workItemId]?.key ?? a.workItemId;
      return `## ${a.title}\n\n- Issue: ${key}; assignment ${a.assignmentId}; folder \`${a.dir}\`\n- Revision ${r.rev}, content SHA-256 \`${r.hash}\`${r.gitSha ? `, git ${r.gitSha.slice(0, 12)}` : ''}\n- Design contract: ${r.designRevision ? `v${r.designRevision.version} (\`${r.designRevision.hash.slice(0, 12)}\`)` : 'none'}\n- Review gate: ${g.state}${g.open.length ? ` (${g.open.length} open: ${g.open.slice(0, 4).map(f => f.rule).join(', ')})` : ''}\n- Pages: ${r.files.filter(f => f.kind === 'html').map(f => f.path).join(', ')}\n- Evidence: ${r.evidence.length ? r.evidence.map(e => `${e.kind} ${e.status}${e.verified ? ' (verified)' : ''}`).join('; ') : 'none attached'}\n${r.exceptions.map(e => `- Exception by ${e.by.id}: ${e.rationale}`).join('\n')}`;
    });
    return `# Design artifacts\n\nCurrent design contract: ${cur ? `v${cur.version} (\`${cur.hash.slice(0, 12)}\`)` : 'none saved'}. Mocks are self-contained local HTML captured from design agents' worktrees; static checks do not prove visual compliance.\n\n${rows.join('\n\n')}\n`;
  }
}
