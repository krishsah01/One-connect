// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Git adapter: one worktree per assignment, diffs against the recorded base, path-scope hooks,
// protected-branch push guard and early conflict detection between active worktrees.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecResult } from '../../exec.ts';
import { isolatedGit } from './git-policy.ts';

export class GitError extends Error {}

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean; input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  const r = await isolatedGit(cwd, args, opts);
  if (!opts.allowFail && r.code !== 0) throw new GitError(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout || r.error || '').trim()}`);
  return r;
}

const out = async (cwd: string, args: string[]) => (await git(cwd, args)).stdout.trim();

export async function repoRoot(dir: string): Promise<string> {
  return out(dir, ['rev-parse', '--show-toplevel']);
}

export async function gitCommonDir(dir: string): Promise<string> {
  const p = await out(dir, ['rev-parse', '--git-common-dir']);
  return fs.realpathSync(path.resolve(dir, p));
}

export async function revParse(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  return (await git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
}

/** Create the integration branch from the first protected branch if it doesn't exist yet. */
export async function ensureBranch(repo: string, branch: string, from: string): Promise<void> {
  if (await branchExists(repo, branch)) return;
  const base = (await revParse(repo, from)) ?? (await revParse(repo, 'HEAD'));
  if (!base) throw new GitError(`cannot create ${branch}: ${from} does not exist`);
  await git(repo, ['branch', branch, base]);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
}

export async function createWorktree(o: { repo: string; dir: string; branch: string; baseRef: string }): Promise<WorktreeInfo> {
  const baseSha = await revParse(o.repo, o.baseRef);
  if (!baseSha) throw new GitError(`base ref ${o.baseRef} not found in ${o.repo}`);
  fs.mkdirSync(path.dirname(o.dir), { recursive: true });
  if (fs.existsSync(o.dir) && fs.existsSync(path.join(o.dir, '.git'))) {
    // Reused (retry / follow-up): keep the existing work.
    return { path: o.dir, branch: o.branch, baseSha: (await revParse(o.repo, `refs/acc/base/${sanitizeRef(o.branch)}`)) ?? baseSha };
  }
  await git(o.repo, ['worktree', 'prune'], { allowFail: true });
  if (await branchExists(o.repo, o.branch)) await git(o.repo, ['worktree', 'add', o.dir, o.branch]);
  else await git(o.repo, ['worktree', 'add', '-b', o.branch, o.dir, baseSha]);
  // Remember the base so later diffs and retries use the same reference point.
  await git(o.repo, ['update-ref', `refs/acc/base/${sanitizeRef(o.branch)}`, baseSha]);
  return { path: o.dir, branch: o.branch, baseSha };
}

const sanitizeRef = (b: string) => b.replace(/[^\w./-]/g, '_');

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  added: number | null;
  removed: number | null;
}

/** Working tree (committed + uncommitted + untracked) vs. base. */
export async function changedFiles(wt: string, baseSha: string): Promise<ChangedFile[]> {
  const files = new Map<string, ChangedFile>();
  const ns = await git(wt, ['diff', '--numstat', '-M', baseSha, '--'], { allowFail: true });
  const st = await git(wt, ['diff', '--name-status', '-M', baseSha, '--'], { allowFail: true });
  const stat = new Map<string, [number | null, number | null]>();
  for (const l of ns.stdout.split('\n').filter(Boolean)) {
    const [a, r, ...p] = l.split('\t');
    stat.set(p.at(-1) ?? '', [a === '-' ? null : Number(a), r === '-' ? null : Number(r)]);
  }
  for (const l of st.stdout.split('\n').filter(Boolean)) {
    const [code, ...p] = l.split('\t');
    const file = p.at(-1) ?? '';
    const s = code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : code[0] === 'R' ? 'renamed' : 'modified';
    const [added, removed] = stat.get(file) ?? [null, null];
    files.set(file, { path: file, status: s, added, removed });
  }
  const un = await git(wt, ['ls-files', '--others', '--exclude-standard'], { allowFail: true });
  for (const f of un.stdout.split('\n').filter(Boolean)) if (!files.has(f)) files.set(f, { path: f, status: 'untracked', added: null, removed: null });
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function diffPatch(wt: string, baseSha: string, maxBytes = 400_000): Promise<{ patch: string; truncated: boolean }> {
  const r = await git(wt, ['diff', '-M', '--no-color', baseSha, '--'], { allowFail: true });
  let patch = r.stdout;
  const un = await git(wt, ['ls-files', '--others', '--exclude-standard'], { allowFail: true });
  for (const f of un.stdout.split('\n').filter(Boolean).slice(0, 50)) {
    const d = await git(wt, ['diff', '--no-color', '--no-index', '/dev/null', f], { allowFail: true });
    patch += d.stdout;
  }
  return patch.length > maxBytes ? { patch: patch.slice(0, maxBytes), truncated: true } : { patch, truncated: false };
}

export async function headSha(wt: string): Promise<string | null> {
  return revParse(wt, 'HEAD');
}

export async function commitsSince(wt: string, baseSha: string): Promise<{ sha: string; subject: string; body: string }[]> {
  const r = await git(wt, ['log', '--format=%H%x1f%s%x1f%b%x1e', `${baseSha}..HEAD`], { allowFail: true });
  return r.stdout
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [sha, subject, body] = s.split('\x1f');
      return { sha, subject, body: body ?? '' };
    });
}

/** Does `sha` exist and is it reachable from `branch`? */
export async function commitOnBranch(repo: string, sha: string, branch: string): Promise<boolean> {
  const full = await revParse(repo, sha);
  if (!full) return false;
  return (await git(repo, ['merge-base', '--is-ancestor', full, `refs/heads/${branch}`], { allowFail: true })).code === 0;
}

/** Real conflicts between two branches without touching any worktree (git ≥ 2.38). */
export async function mergeConflicts(repo: string, a: string, b: string): Promise<string[] | null> {
  const r = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { allowFail: true });
  if (r.code === 0) return [];
  if (r.code === 1) return r.stdout.split('\n').slice(1).filter(Boolean);
  return null; // unsupported / error
}

// ---- hooks ---------------------------------------------------------------------------------

export const HOOK_ENTRY = fileURLToPath(new URL('./hook.ts', import.meta.url));
const HOOK_NAMES = ['applypatch-msg', 'commit-msg', 'post-checkout', 'post-commit', 'post-merge', 'post-rewrite', 'pre-applypatch', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'prepare-commit-msg', 'reference-transaction'];

export interface ScopeFile {
  allowedPaths: string[];
  ignore: string[];
  protectedBranches: string[];
  /** Legacy field retained for scope-file readers; user hooks are never chained. */
  chainHooksDir: string | null;
}

/** Agent-initiated commits/pushes retain only the app's guards, never repository hooks. */
export async function installWorktreeHooks(o: { repo: string; worktree: string; hooksDir: string; scope: Omit<ScopeFile, 'chainHooksDir'> }): Promise<void> {
  fs.mkdirSync(o.hooksDir, { recursive: true, mode: 0o700 });
  const scope: ScopeFile = { ...o.scope, chainHooksDir: null };
  fs.writeFileSync(path.join(o.hooksDir, 'scope.json'), JSON.stringify(scope, null, 2), { mode: 0o600 });
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  for (const name of HOOK_NAMES) {
    const ours = name === 'pre-commit' || name === 'pre-push';
    const body = '#!/bin/sh\n# One Connect guard only; no repository hook execution.\n' +
      (ours ? `exec ${quote(process.execPath)} --disable-warning=ExperimentalWarning ${quote(HOOK_ENTRY)} ${name} ${quote(path.join(o.hooksDir, 'scope.json'))} "$@"\n` : 'exit 0\n');
    fs.writeFileSync(path.join(o.hooksDir, name), body, { mode: 0o755 });
  }
  await git(o.repo, ['config', 'extensions.worktreeConfig', 'true']);
  await git(o.worktree, ['config', '--worktree', 'core.hooksPath', o.hooksDir]);
}

/** Add a pattern to the repo's info/exclude (used for the per-worktree Cursor MCP config). */
export async function ensureExcluded(repo: string, pattern: string): Promise<void> {
  const file = path.join(await gitCommonDir(repo), 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (cur.split('\n').some((l) => l.trim() === pattern)) return;
  fs.appendFileSync(file, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}# added by agent-control-center\n${pattern}\n`);
}

export async function isTracked(repo: string, file: string): Promise<boolean> {
  return (await git(repo, ['ls-files', '--error-unmatch', file], { allowFail: true })).code === 0;
}
