#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Developer Certificate of Origin: every non-merge commit in the range needs a
// "Signed-off-by: Name <email>" trailer matching its author (use `git commit -s`).
//   node scripts/check-dco.mjs [<base>..<head>]     default: origin/main..HEAD
import { execFileSync } from 'node:child_process';

const range = process.argv[2] ?? process.env.DCO_RANGE ?? 'origin/main..HEAD';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });

let shas = [];
try {
  shas = git('rev-list', '--no-merges', range).split('\n').filter(Boolean);
} catch {
  console.error(`✗ cannot list commits for range ${range}`);
  process.exit(1);
}

const bad = [];
for (const sha of shas) {
  const [author, email, ...body] = git('show', '-s', '--format=%an%n%ae%n%B', sha).split('\n');
  const trailers = body.filter((l) => /^Signed-off-by:/i.test(l));
  const ok = trailers.some((l) => l.toLowerCase().includes(`<${email.toLowerCase()}>`));
  if (!ok) bad.push(`${sha.slice(0, 10)} ${author} <${email}>${trailers.length ? ` (sign-off doesn't match author: ${trailers.join('; ')})` : ' (no Signed-off-by)'}`);
}

if (bad.length) {
  console.error(`✗ ${bad.length} commit(s) without a matching DCO sign-off:\n${bad.map((b) => `  - ${b}`).join('\n')}\nFix with: git rebase --signoff ${range.split('..')[0]}`);
  process.exit(1);
}
console.log(`✓ ${shas.length} commit(s) signed off (DCO)`);
