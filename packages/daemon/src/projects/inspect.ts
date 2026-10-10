// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// New-project onboarding: bind a folder to exactly one Git repository root and describe what it
// declares (frameworks, checks, Compose services) by reading manifests. Scripts are never run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { findComposeFile, parseCompose, readBounded, type ComposeFile } from '../environment/compose.ts';
import { safeGit } from './safe-git.ts';

export class ProjectIntakeError extends Error {}

export type GitState = 'not_git' | 'not_root' | 'no_commits' | 'dirty' | 'clean';
export interface OnboardingStep { id: string; title: string; detail: string; commands: string[][]; runIn: 'project-terminal' | 'approved-action' }
export interface DeclaredCheck { name: string; command: string; source: string }
export interface ProjectInspection {
  path: string;
  name: string;
  git: { state: GitState; root: string | null; head: string | null; branch: string | null; integrationBranch: string | null; integrationHead: string | null; dirtyFiles: number; untrackedFiles: number };
  intake: { indexable: boolean; revision: string | null; ref: string | null; message: string; steps: OnboardingStep[] };
  frameworks: string[];
  packageManager: string | null;
  checks: DeclaredCheck[];
  compose: ComposeFile | null;
  dockerfiles: string[];
  config: { existing: string | null; bound: boolean | null; error: string | null };
  warnings: string[];
}

const SYSTEM_ROOTS = ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/private/var/db', '/private/var/root', '/opt/homebrew', '/dev', '/cores'];

function real(p: string): string {
  return fs.realpathSync.native(p);
}

/** Refuse folders that cannot be a single project: roots, home itself, app data and system trees. */
export function assertProjectFolder(dir: string): string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || /[\u0000-\u001f]/.test(dir)) throw new ProjectIntakeError('Choose an absolute local folder path.');
  let resolved: string;
  try {
    resolved = real(dir);
  } catch {
    throw new ProjectIntakeError('That folder does not exist.');
  }
  if (!fs.statSync(resolved).isDirectory()) throw new ProjectIntakeError('Choose a folder, not a file.');
  const home = real(os.homedir());
  const inside = (root: string) => resolved === root || resolved.startsWith(root + path.sep);
  if (resolved === path.parse(resolved).root || resolved === home) throw new ProjectIntakeError('Choose a specific project folder, not a disk or your whole home folder.');
  for (const name of ['Library', '.ssh', '.aws', '.config', '.cursor', '.codex', '.claude', '.docker', '.gnupg']) if (inside(path.join(home, name))) throw new ProjectIntakeError('That folder holds app or credential data. Choose a project repository.');
  for (const root of SYSTEM_ROOTS) {
    let r = root;
    try { r = real(root); } catch { /* absent on this OS */ }
    if (inside(r) && !inside(home)) throw new ProjectIntakeError('System folders cannot be added as projects.');
  }
  return resolved;
}

const FRAMEWORKS: [RegExp, string][] = [
  [/^next$/, 'Next.js'], [/^react$/, 'React'], [/^vue$/, 'Vue'], [/^svelte$/, 'Svelte'], [/^@sveltejs\/kit$/, 'SvelteKit'], [/^astro$/, 'Astro'], [/^@remix-run\//, 'Remix'],
  [/^express$/, 'Express'], [/^fastify$/, 'Fastify'], [/^@nestjs\/core$/, 'NestJS'], [/^vite$/, 'Vite'], [/^electron$/, 'Electron'], [/^@tauri-apps\/api$/, 'Tauri'],
  [/^prisma$|^@prisma\/client$/, 'Prisma'], [/^drizzle-orm$/, 'Drizzle'], [/^pg$|^postgres$/, 'PostgreSQL client'], [/^vitest$/, 'Vitest'], [/^jest$/, 'Jest'], [/^@playwright\/test$/, 'Playwright'],
];
const CHECK_SCRIPTS = ['test', 'lint', 'typecheck', 'check', 'build', 'e2e'];

function packageManager(dir: string, pkg: Record<string, unknown> | null): string | null {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (declared && /^(npm|pnpm|yarn|bun)$/.test(declared)) return declared;
  for (const [file, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm']] as const) if (fs.existsSync(path.join(dir, file))) return pm;
  return pkg ? 'npm' : null;
}

function detect(dir: string) {
  const frameworks = new Set<string>();
  const checks: DeclaredCheck[] = [];
  const warnings: string[] = [];
  const add = (name: string, command: string, source: string) => { if (!checks.some(c => c.name === name)) checks.push({ name, command, source }); };
  let pkg: Record<string, unknown> | null = null;
  const pkgText = readBounded(path.join(dir, 'package.json'));
  if (pkgText !== null) {
    try { pkg = JSON.parse(pkgText); } catch { warnings.push('package.json is not valid JSON; its scripts were not read.'); }
  }
  const pm = packageManager(dir, pkg);
  if (pkg) {
    frameworks.add('Node.js');
    const deps = [...Object.keys((pkg.dependencies ?? {}) as object), ...Object.keys((pkg.devDependencies ?? {}) as object)];
    for (const dep of deps) for (const [re, label] of FRAMEWORKS) if (re.test(dep)) frameworks.add(label);
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    for (const name of CHECK_SCRIPTS) if (typeof scripts[name] === 'string') add(name, name === 'test' && pm === 'npm' ? 'npm test' : `${pm} run ${name}`, 'package.json scripts');
  }
  const cargo = readBounded(path.join(dir, 'Cargo.toml'));
  if (cargo !== null) {
    frameworks.add('Rust');
    for (const [re, label] of [[/^\s*axum\s*=/m, 'Axum'], [/^\s*actix-web\s*=/m, 'Actix Web'], [/^\s*tauri\s*=/m, 'Tauri'], [/^\s*rocket\s*=/m, 'Rocket']] as const) if (re.test(cargo)) frameworks.add(label);
    add('test', 'cargo test', 'Cargo.toml');
  }
  const pyproject = readBounded(path.join(dir, 'pyproject.toml'));
  const requirements = readBounded(path.join(dir, 'requirements.txt'));
  if (pyproject !== null || requirements !== null) {
    frameworks.add('Python');
    const py = `${pyproject ?? ''}\n${requirements ?? ''}`.toLowerCase();
    for (const [re, label] of [[/\bdjango\b/, 'Django'], [/\bfastapi\b/, 'FastAPI'], [/\bflask\b/, 'Flask']] as const) if (re.test(py)) frameworks.add(label);
    if (/\bpytest\b/.test(py)) add('test', 'pytest', pyproject !== null ? 'pyproject.toml' : 'requirements.txt');
  }
  if (readBounded(path.join(dir, 'go.mod')) !== null) { frameworks.add('Go'); add('test', 'go test ./...', 'go.mod'); }
  const gemfile = readBounded(path.join(dir, 'Gemfile'));
  if (gemfile !== null) {
    frameworks.add('Ruby');
    if (/['"]rails['"]/.test(gemfile)) frameworks.add('Rails');
    if (/['"]rspec(-rails)?['"]/.test(gemfile)) add('test', 'bundle exec rspec', 'Gemfile');
  }
  const makefile = readBounded(path.join(dir, 'Makefile'));
  if (makefile !== null) for (const m of makefile.matchAll(/^(test|lint|check|build):/gm)) add(m[1], `make ${m[1]}`, 'Makefile');
  const dockerfiles = fs.readdirSync(dir).filter(n => /^Dockerfile(\..+)?$|\.Dockerfile$/.test(n) && fs.lstatSync(path.join(dir, n)).isFile());
  return { frameworks: [...frameworks], checks, warnings, pm: pm, pkgName: typeof pkg?.name === 'string' ? pkg.name : null, dockerfiles };
}

export function suggestName(dir: string, pkgName: string | null): string {
  const base = (pkgName?.split('/').pop() ?? path.basename(dir)).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '');
  return base.slice(0, 64) || 'project';
}

async function gitInfo(dir: string): Promise<ProjectInspection['git']> {
  const empty = { root: null, head: null, branch: null, integrationBranch: null, integrationHead: null, dirtyFiles: 0, untrackedFiles: 0 };
  const top = await safeGit(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { state: 'not_git', ...empty };
  const root = real(top.stdout.trim());
  if (root !== dir) return { state: 'not_root', ...empty, root };
  const head = await safeGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const branch = (await safeGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null;
  if (head.code !== 0) return { state: 'no_commits', ...empty, root, branch };
  const integration = await safeGit(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/integration^{commit}']);
  const status = await safeGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], { maxBytes: 4 * 1024 * 1024 });
  const rows = status.stdout.split('\0').filter(Boolean);
  const untrackedFiles = rows.filter(r => r.startsWith('??')).length;
  const dirtyFiles = rows.filter(r => !r.startsWith('??') && /^[ MADRCU?!]{2} /.test(r)).length;
  return { state: dirtyFiles + untrackedFiles ? 'dirty' : 'clean', root, head: head.stdout.trim(), branch, integrationBranch: integration.code === 0 ? 'integration' : null, integrationHead: integration.code === 0 ? integration.stdout.trim() : null, dirtyFiles, untrackedFiles };
}

function intake(g: ProjectInspection['git'], dir: string): ProjectInspection['intake'] {
  const commitStep: OnboardingStep = { id: 'first-commit', title: 'Create a first commit', detail: 'Review the files first. Dictionary indexes exact committed revisions only, so nothing is indexed until this commit exists.', commands: [['git', 'status'], ['git', 'add', '-A'], ['git', 'commit', '-m', 'Initial commit']], runIn: 'project-terminal' };
  if (g.state === 'not_git') return { indexable: false, revision: null, ref: null, message: 'This folder is not a Git repository. One Connect binds each project to one repository root.', steps: [{ id: 'git-init', title: 'Initialize Git in this exact folder', detail: `Runs git init in ${dir} after you approve it. It creates .git only; no files are added or committed.`, commands: [['git', 'init', '-b', 'main', dir]], runIn: 'approved-action' }, commitStep] };
  if (g.state === 'not_root') return { indexable: false, revision: null, ref: null, message: `This folder is inside the repository at ${g.root}. Choose the repository root so the project binding is exact.`, steps: [] };
  if (g.state === 'no_commits') return { indexable: false, revision: null, ref: null, message: 'The repository has no commits. Dictionary reports “needs first commit” rather than indexing uncommitted files.', steps: [commitStep] };
  // Mirrors Dictionary: the integration branch when it exists, otherwise HEAD.
  const ref = g.integrationBranch ?? 'HEAD';
  const sha = g.integrationHead ?? g.head!;
  if (g.state === 'dirty') return { indexable: true, revision: sha, ref, message: `One Ask indexes committed ${ref} at ${sha.slice(0, 12)}. ${g.dirtyFiles} changed and ${g.untrackedFiles} untracked files are excluded until committed.`, steps: [{ ...commitStep, id: 'commit-changes', title: 'Commit local changes to include them', commands: [['git', 'status'], ['git', 'add', '-A'], ['git', 'commit', '-m', 'Work in progress']] }] };
  return { indexable: true, revision: sha, ref, message: `One Ask indexes committed ${ref} at ${sha.slice(0, 12)}.`, steps: [] };
}

function existingConfig(root: string): ProjectInspection['config'] {
  for (const name of ['control-center.yaml', 'control-center.yml']) {
    const file = path.join(root, name);
    const text = readBounded(file);
    if (text === null) continue;
    try {
      const raw = YAML.parse(text) as { project?: { repo?: string } };
      const repo = raw?.project?.repo;
      if (typeof repo !== 'string') return { existing: file, bound: false, error: `${name} has no project.repo` };
      const expanded = repo === '~' ? os.homedir() : repo.startsWith('~/') ? path.join(os.homedir(), repo.slice(2)) : repo;
      let target: string;
      try { target = real(path.resolve(root, expanded)); } catch { return { existing: file, bound: false, error: `${name} points at a folder that does not exist` }; }
      return target === root ? { existing: file, bound: true, error: null } : { existing: file, bound: false, error: `${name} points at ${target}, not this repository` };
    } catch (e) {
      return { existing: file, bound: false, error: `${name} is not valid YAML: ${(e as Error).message.split('\n')[0]}` };
    }
  }
  return { existing: null, bound: null, error: null };
}

export async function inspectProject(dir: string): Promise<ProjectInspection> {
  const resolved = assertProjectFolder(dir);
  const git = await gitInfo(resolved);
  const found = detect(resolved);
  const name = suggestName(resolved, found.pkgName);
  let compose: ComposeFile | null = null;
  const warnings = [...found.warnings];
  const composeFile = findComposeFile(resolved);
  if (composeFile) {
    try { compose = parseCompose(composeFile, path.basename(resolved)); warnings.push(...compose.warnings); }
    catch (e) { warnings.push((e as Error).message); }
  }
  if (git.state === 'dirty' && git.integrationBranch === null) warnings.push('No integration branch yet; One Ask will index HEAD and agent worktrees will create integration from the protected branch.');
  return {
    path: resolved,
    name,
    git,
    intake: intake(git, resolved),
    frameworks: found.frameworks,
    packageManager: found.pm,
    checks: found.checks,
    compose,
    dockerfiles: found.dockerfiles,
    config: git.state === 'not_git' || git.state === 'not_root' ? { existing: null, bound: null, error: null } : existingConfig(resolved),
    warnings,
  };
}
