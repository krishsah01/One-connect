// SPDX-License-Identifier: Apache-2.0
// Git hook entry for agent worktrees:
//   pre-commit: reject staged files outside the assignment's allowed paths
//   pre-push:   reject pushes to protected branches
import { isolatedGit } from './git-policy.ts';
import fs from 'node:fs';
import { outOfScope } from '@acc/core';
import type { ScopeFile } from './git.ts';

const [, , hook, scopePath] = process.argv;
const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8')) as ScopeFile;

if (hook === 'pre-commit') {
  const result = await isolatedGit(process.cwd(), ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD']);
  if (result.code !== 0) { process.stderr.write('One Connect could not inspect staged paths\n'); process.exit(1); }
  const staged = result.stdout.split('\0')
    .filter(Boolean);
  const blockedInternal = staged.filter((f) => scope.ignore.includes(f));
  const bad = [...outOfScope(staged, scope.allowedPaths, scope.ignore), ...blockedInternal];
  if (bad.length) {
    process.stderr.write(
      `\n[agent-control-center] commit rejected: these files are outside this assignment's allowed paths\n${bad.map((f) => `  - ${f}`).join('\n')}\nAllowed: ${scope.allowedPaths.join(', ') || '(whole repo)'}\nUnstage them (git restore --staged <file>) or ask the human to widen the scope.\n\n`,
    );
    process.exit(1);
  }
} else if (hook === 'pre-push') {
  const input = fs.readFileSync(0, 'utf8');
  for (const line of input.split('\n').filter(Boolean)) {
    const remoteRef = line.split(' ')[2] ?? '';
    const branch = remoteRef.replace(/^refs\/heads\//, '');
    if (scope.protectedBranches.includes(branch)) {
      process.stderr.write(`\n[agent-control-center] push to protected branch "${branch}" rejected. Pushes to protected or production branches need a recorded human approval.\n\n`);
      process.exit(1);
    }
  }
}
process.exit(0);
