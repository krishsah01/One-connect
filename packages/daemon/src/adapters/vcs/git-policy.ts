// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Suppress executable Git configuration for app-owned local operations. Repository identity
// and structural config remain readable; custom merge drivers are refused rather than invoked.
import { run, type ExecResult } from '../../exec.ts';

export const SAFE_GIT_FLAGS = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'credential.helper=',
  '-c', 'protocol.ext.allow=never',
  '-c', 'core.pager=cat', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
  '-c', 'merge.verifySignatures=false', '-c', 'merge.autostash=false',
  '-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'fetch.recurseSubmodules=false',
];

export function safeGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_PAGER: 'cat', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', ...extra,
  };
}

export async function isolatedGit(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<ExecResult> {
  const env = safeGitEnv();
  const flags = [...SAFE_GIT_FLAGS, '-c', 'protocol.allow=never'];
  const verb = args.findIndex((a, i) => !a.startsWith('-') && args[i - 1] !== '-c');
  const protectedArgs = [...args];
  if (verb >= 0 && ['diff', 'show', 'log'].includes(args[verb])) protectedArgs.splice(verb + 1, 0, '--no-ext-diff', '--no-textconv');
  // Object/ref/config reads cannot use worktree filters; avoid an extra config process per blob.
  // This keeps bounded project indexing from doubling thousands of subprocesses.
  if (verb >= 0 && ['cat-file', 'ls-tree', 'rev-parse', 'show-ref', 'for-each-ref', 'config', 'merge-base', 'rev-list', 'log', 'show'].includes(args[verb])) {
    return run('git', [...flags, ...protectedArgs], { cwd, env, input: opts.input, timeoutMs: opts.timeoutMs ?? 60_000, maxBytes: opts.maxBytes });
  }
  // Config includes are data reads. Reading effective local/worktree/includes config lets us
  // override every named filter; enumerating only .git/config would miss included drivers.
  const cfg = await run('git', [...SAFE_GIT_FLAGS, 'config', '--null', '--list'], { cwd, env, timeoutMs: 10_000, maxBytes: 1024 * 1024 });
  if (cfg.code !== 0 || cfg.stdout.length >= 1024 * 1024) return { ...cfg, code: null, error: 'cannot inspect Git configuration safely' };
  let customMerge = false;
  for (const entry of cfg.stdout.split('\0')) {
    const key = entry.split('\n')[0];
    const filter = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
    if (filter) for (const setting of ['clean=', 'smudge=', 'process=', 'required=false']) flags.push('-c', `filter.${filter[1]}.${setting}`);
    if (/^merge\..+\.driver$/i.test(key)) customMerge = true;
  }
  // A repo can name a custom driver through .gitattributes in either side of a merge.
  // Refuse the operation before merge-tree or merge can run it (including conflict previews).
  if (customMerge && (args.includes('merge') || args.includes('merge-tree'))) {
    return { code: null, stdout: '', stderr: 'custom Git merge drivers require separate approval and are unsupported by app-owned merges', timedOut: false };
  }
  return run('git', [...flags, ...protectedArgs], { cwd, env, input: opts.input, timeoutMs: opts.timeoutMs ?? 60_000, maxBytes: opts.maxBytes });
}
