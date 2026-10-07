#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Switch the project license in one step before the first public release:
//   node scripts/set-license.mjs MIT
//   node scripts/set-license.mjs AGPL-3.0-only --text path/to/agpl-3.0.txt
// Rewrites the root package.json (the single source of truth), every package manifest,
// every SPDX header and NOTICE, and replaces LICENSE. Apache-2.0 and MIT texts are built in
// (Apache via the LICENSE already in git history); other licenses need --text.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const textArg = process.argv.indexOf('--text');
const SUPPORTED = ['Apache-2.0', 'MIT', 'AGPL-3.0-only'];
if (!SUPPORTED.includes(target)) {
  console.error(`usage: set-license.mjs <${SUPPORTED.join('|')}> [--text file]`);
  process.exit(2);
}
const rootPkgPath = path.join(ROOT, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
const from = rootPkg.license;
const year = new Date().getFullYear();

const MIT = `MIT License

Copyright (c) ${year} The Agent Control Center Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

let licenseText;
if (textArg >= 0) licenseText = fs.readFileSync(process.argv[textArg + 1], 'utf8');
else if (target === 'MIT') licenseText = MIT;
else if (target === 'Apache-2.0') {
  try {
    licenseText = execFileSync('git', ['log', '--diff-filter=A', '--format=%H', '--', 'LICENSE'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop();
    licenseText = execFileSync('git', ['show', `${licenseText}:LICENSE`], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    licenseText = null;
  }
}
if (!licenseText) {
  console.error(`Provide the full ${target} text with --text <file> (e.g. from https://www.gnu.org/licenses/agpl-3.0.txt).`);
  process.exit(2);
}

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
let headers = 0;
for (const f of files) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs) || f.includes('node_modules/')) continue;
  if (f.endsWith('package.json')) {
    const pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
    pkg.license = target;
    fs.writeFileSync(abs, JSON.stringify(pkg, null, 2) + '\n');
    continue;
  }
  if (f.endsWith('Cargo.toml')) {
    const src = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, src.replace(`license = "${from}"`, `license = "${target}"`));
    continue;
  }
  if (!/\.(ts|tsx|mjs|js|css|sh|rs)$/.test(f) && !(f.includes('/bin/') && !path.extname(f))) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const next = src.replace(`SPDX-License-Identifier: ${from}`, `SPDX-License-Identifier: ${target}`);
  if (next !== src) {
    fs.writeFileSync(abs, next);
    headers++;
  }
}
fs.writeFileSync(path.join(ROOT, 'LICENSE'), licenseText);
const notice = path.join(ROOT, 'NOTICE');
if (fs.existsSync(notice)) fs.writeFileSync(notice, fs.readFileSync(notice, 'utf8').replace(from, target));
console.log(`license ${from} → ${target}: LICENSE replaced, ${headers} SPDX headers and all manifests updated.`);
console.log('Next: pnpm license:notices && pnpm license:check && pnpm spdx:check, and update docs/licensing.md + README.');
