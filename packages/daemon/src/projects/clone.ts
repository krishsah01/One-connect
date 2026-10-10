// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Clone and initialize are planned first and executed only with the plan's digest, which the
// native shell hands over after a human approves that exact plan. Re-planning at execution time
// means a changed URL, destination or argument list cannot ride on an earlier approval.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '@acc/core';
import { run } from '../exec.ts';
import { assertProjectFolder, inspectProject, ProjectIntakeError, type ProjectInspection } from './inspect.ts';
import { SAFE_GIT_FLAGS, safeGitEnv } from './safe-git.ts';

export interface GitActionPlan { kind: 'clone' | 'git-init'; argv: string[]; target: string; network: boolean; summary: string; digest: string; url?: string }

const digest = (p: Omit<GitActionPlan, 'digest'>) => createHash('sha256').update(JSON.stringify([p.kind, p.argv, p.target])).digest('hex');

export function parseCloneUrl(input: string): { url: string; network: boolean; name: string } {
  const url = String(input ?? '').trim();
  if (!url || url.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(url) || url.startsWith('-')) throw new ProjectIntakeError('Enter a single Git URL without spaces.');
  if (/^[a-z][a-z0-9+.-]*::/i.test(url) || /^(ext|fd)::/i.test(url)) throw new ProjectIntakeError('Git remote helpers such as ext:: are not allowed.');
  let network = true;
  let pathname: string;
  if (/^https:\/\//i.test(url) || /^ssh:\/\//i.test(url)) {
    let u: URL;
    try { u = new URL(url); } catch { throw new ProjectIntakeError('That Git URL is not valid.'); }
    if (u.protocol === 'https:' && (u.username || u.password)) throw new ProjectIntakeError('Remove credentials from the URL. Use your Git credential manager or SSH keys instead.');
    if (u.protocol === 'ssh:' && u.password) throw new ProjectIntakeError('Remove the password from the URL.');
    if (u.search || u.hash) throw new ProjectIntakeError('Git URLs must not contain a query or fragment.');
    pathname = decodeURIComponent(u.pathname);
  } else if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^:]+$/.test(url)) {
    pathname = url.slice(url.indexOf(':') + 1);
  } else if (/^file:\/\//i.test(url) || path.isAbsolute(url)) {
    network = false;
    pathname = /^file:/i.test(url) ? decodeURIComponent(new URL(url).pathname) : url;
    if (!fs.existsSync(pathname)) throw new ProjectIntakeError('That local repository path does not exist.');
  } else throw new ProjectIntakeError('Use an https://, ssh://, git@host:path, file:// URL or an absolute local repository path. Plain http is refused.');
  const name = path.posix.basename(pathname.replace(/\/+$/, '')).replace(/\.git$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new ProjectIntakeError('Could not derive a safe folder name from the URL; enter one.');
  return { url, network, name };
}

export function planClone(input: string, parent: string, name?: string): GitActionPlan {
  const parsed = parseCloneUrl(input);
  const folder = name?.trim() || parsed.name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(folder)) throw new ProjectIntakeError('Folder name: letters, digits, dot, dash and underscore only.');
  const base = assertProjectFolder(parent);
  const target = path.join(base, folder);
  if (fs.existsSync(target)) throw new ProjectIntakeError(`${target} already exists. Choose another destination or add that folder as a local project.`);
  const argv = ['git', ...SAFE_GIT_FLAGS, 'clone', '--no-recurse-submodules', '--', parsed.url, target];
  const plan = { kind: 'clone' as const, argv, target, network: parsed.network, url: parsed.url, summary: parsed.network ? `Contacts the Git host for ${parsed.url} and downloads the repository into ${target}. Hooks and submodules are disabled.` : `Copies the local repository ${parsed.url} into ${target}. No network access. Hooks and submodules are disabled.` };
  return { ...plan, digest: digest(plan) };
}

export async function planGitInit(dir: string): Promise<GitActionPlan> {
  const inspection = await inspectProject(dir);
  if (inspection.git.state !== 'not_git') throw new ProjectIntakeError(inspection.git.state === 'not_root' ? inspection.intake.message : 'This folder is already a Git repository.');
  const argv = ['git', ...SAFE_GIT_FLAGS, 'init', '-b', 'main', '--', inspection.path];
  const plan = { kind: 'git-init' as const, argv, target: inspection.path, network: false, summary: `Creates an empty .git directory in ${inspection.path}. Adds or commits nothing.` };
  return { ...plan, digest: digest(plan) };
}

async function execute(plan: GitActionPlan, expected: string, timeoutMs: number): Promise<ProjectInspection> {
  if (!/^[a-f0-9]{64}$/.test(expected) || plan.digest !== expected) throw new ProjectIntakeError('The approved plan no longer matches this action. Review and approve it again.');
  // An approved clone may use the user's SSH agent; HTTPS credential helpers and prompts stay off.
  const sshAgent: Record<string, string> = plan.kind === 'clone' && process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {};
  const r = await run(plan.argv[0], plan.argv.slice(1), { env: safeGitEnv(sshAgent), timeoutMs, maxBytes: 64 * 1024 });
  if (r.code !== 0) {
    const detail = redact(`${r.stderr}${r.error ?? ''}`.trim()).text.split('\n').slice(-3).join(' ');
    throw new ProjectIntakeError(`${plan.kind === 'clone' ? 'Clone' : 'git init'} failed${r.timedOut ? ' (timed out)' : ''}: ${detail || `exit ${r.code}`}`);
  }
  return inspectProject(plan.target);
}

export async function executeClone(input: string, parent: string, name: string | undefined, approvedDigest: string): Promise<ProjectInspection> {
  return execute(planClone(input, parent, name), approvedDigest, 15 * 60_000);
}

export async function executeGitInit(dir: string, approvedDigest: string): Promise<ProjectInspection> {
  return execute(await planGitInit(dir), approvedDigest, 20_000);
}
