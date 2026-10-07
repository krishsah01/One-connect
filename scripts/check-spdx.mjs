#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Every source file carries `SPDX-License-Identifier: <project license>` near the top, and every
// package manifest's "license" matches the root package.json (the single source of truth).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const license = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).license;
const SOURCE = /\.(ts|tsx|mts|mjs|js|cjs|css|sh|rs)$/;
const SKIP = [/(^|\/)node_modules\//, /(^|\/)dist\//, /\/fixtures\/real\//, /^THIRD_PARTY_NOTICES\.md$/];

function files() {
  // Tracked + untracked-but-not-ignored, so it works before the first commit too.
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));
}

const problems = [];
let checked = 0;
for (const f of files()) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) continue;
  const isBin = f.includes('/bin/') && !path.extname(f);
  if (!SOURCE.test(f) && !isBin) continue;
  checked++;
  const head = fs.readFileSync(abs, 'utf8').split('\n').slice(0, 4).join('\n');
  const m = /SPDX-License-Identifier:\s*([^\s*]+)/.exec(head);
  if (!m) problems.push(`${f}: missing SPDX-License-Identifier header`);
  else if (m[1] !== license) problems.push(`${f}: SPDX ${m[1]} != project license ${license}`);
}
for (const f of files().filter((x) => x.endsWith('package.json'))) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  if (pkg.license !== license) problems.push(`${f}: "license": ${JSON.stringify(pkg.license)} != ${license}`);
}
for (const f of files().filter(x => x.endsWith('Cargo.toml'))) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (!src.includes(`license = "${license}"`)) problems.push(`${f}: Cargo license must match ${license}`);
}

if (problems.length) {
  console.error(`✗ ${problems.length} license header problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`✓ ${checked} source files carry SPDX-License-Identifier: ${license}`);
