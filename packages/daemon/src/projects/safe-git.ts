// SPDX-License-Identifier: Apache-2.0
// Shared policy for intake and app-owned local Git operations.
import type { ExecResult } from '../exec.ts';
import { isolatedGit } from '../adapters/vcs/git-policy.ts';
export { SAFE_GIT_FLAGS, safeGitEnv } from '../adapters/vcs/git-policy.ts';

export function safeGit(cwd: string, args: string[], o: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ExecResult> {
  return isolatedGit(cwd, args, { timeoutMs: o.timeoutMs ?? 20_000, maxBytes: o.maxBytes ?? 1024 * 1024 });
}
