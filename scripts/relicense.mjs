#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Relicense One Connect from Apache-2.0 to Apache-2.0 with the Commons Clause License Condition
// v1.0: anyone, companies included, may use, change and build with it, but nobody may sell it or a
// product or service whose value derives entirely or substantially from it. This makes the project
// source-available, not OSI open source.
//
// Rewrites only the project's own SPDX headers and license fields. Third-party files, vendored
// resources and fixtures keep their own licenses. Idempotent.
//   node scripts/relicense.mjs            apply
//   node scripts/relicense.mjs --dry-run  list what would change
//   node scripts/relicense.mjs --check    exit 1 if anything still uses the old identifier
//   node scripts/relicense.mjs --root DIR operate on another checkout (used by tests)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OLD = 'Apache-2.0';
export const NEW = 'Apache-2.0 AND LicenseRef-Commons-Clause-1.0';
const LICENSOR = 'The Agent Control Center Authors';

export const COMMONS_CLAUSE = `"Commons Clause" License Condition v1.0

The Software is provided to you by the Licensor under the License, as defined below, subject to
the following condition.

Without limiting other conditions in the License, the grant of rights under the License will not
include, and the License does not grant to you, the right to Sell the Software.

For purposes of the foregoing, "Sell" means practicing any or all of the rights granted to you
under the License to provide to third parties, for a fee or other consideration (including
without limitation fees for hosting or consulting/support services related to the Software), a
product or service whose value derives, entirely or substantially, from the functionality of the
Software. Any license notice or attribution required by the License must also include this
Commons Clause License Condition notice.

Software: One Connect
License: Apache License, Version 2.0
Licensor: ${LICENSOR}
`;

/** Paths whose files belong to someone else or are test data; never rewritten. */
export const EXCLUDE = [
  /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)target\//, /^\.desktop-cache\//,
  /^packages\/daemon\/resources\//,           // pinned upstream skills and resources (their own licenses)
  /^packages\/desktop\/src-tauri\/resources\//, // built engine and bundled model files
  /\/fixtures\/real\//,                         // recorded third-party data used as test fixtures
  /^THIRD_PARTY_NOTICES\.md$/, /^LICENSES?\//, /^LICENSE$/,
];
const SOURCE = /\.(ts|tsx|mts|mjs|js|cjs|css|sh|rs|html|swift|py)$/;
const HEADER = /SPDX-License-Identifier:[ \t]*Apache-2\.0(?=[ \t]*(\*\/|-->|$))/m;

function files(root) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter(f => !EXCLUDE.some(re => re.test(f)));
}

export function relicense(root, { write = true } = {}) {
  const changed = [];
  const touch = (rel, next) => { changed.push(rel); if (write) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), next); } };

  for (const f of files(root)) {
    const abs = path.join(root, f);
    if (!fs.existsSync(abs) || !(SOURCE.test(f) || (f.includes('/bin/') && !path.extname(f)))) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    const head = lines.slice(0, 4).join('\n');
    if (!HEADER.test(head)) continue;
    touch(f, [head.replace(HEADER, `SPDX-License-Identifier: ${NEW}`), ...lines.slice(4)].join('\n'));
  }
  for (const f of files(root).filter(x => x.endsWith('package.json'))) {
    const abs = path.join(root, f);
    const raw = fs.readFileSync(abs, 'utf8');
    if (!raw.includes(`"license": "${OLD}"`)) continue;
    touch(f, raw.replace(`"license": "${OLD}"`, `"license": "${NEW}"`));
  }
  for (const f of files(root).filter(x => x.endsWith('Cargo.toml'))) {
    const raw = fs.readFileSync(path.join(root, f), 'utf8');
    if (raw.includes(`license = "${OLD}"`)) touch(f, raw.replace(`license = "${OLD}"`, `license = "${NEW}"`));
  }

  const license = path.join(root, 'LICENSE');
  if (fs.existsSync(license)) {
    const text = fs.readFileSync(license, 'utf8');
    if (!text.startsWith('"Commons Clause"')) {
      touch('LICENSE', `${COMMONS_CLAUSE}\n${'-'.repeat(98)}\n\n${text}`);
      touch('LICENSES/Apache-2.0.txt', text);
    }
  }
  // Inbound dependency review is unchanged: the condition limits how One Connect is offered, not
  // what it may use. The reviewed allowlist for Apache-2.0 carries over to the new expression.
  const policyFile = path.join(root, 'license-policy.json');
  if (fs.existsSync(policyFile)) {
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    const lists = policy.compatible ?? policy;
    if (lists[OLD] && !lists[NEW]) { lists[NEW] = lists[OLD]; touch('license-policy.json', `${JSON.stringify(policy, null, 2)}\n`); }
  }
  const clause = path.join(root, 'LICENSES/LicenseRef-Commons-Clause-1.0.txt');
  if (!fs.existsSync(clause) || fs.readFileSync(clause, 'utf8') !== COMMONS_CLAUSE) touch('LICENSES/LicenseRef-Commons-Clause-1.0.txt', COMMONS_CLAUSE);

  const notice = path.join(root, 'NOTICE');
  if (fs.existsSync(notice)) {
    const text = fs.readFileSync(notice, 'utf8');
    const old = 'This product is licensed under the Apache License, Version 2.0 (see LICENSE).';
    if (text.includes(old)) touch('NOTICE', text.replace(old, 'This product is licensed under the Apache License, Version 2.0, subject to the Commons Clause\nLicense Condition v1.0 (see LICENSE). You may use, modify and build with it, including\ncommercially, but you may not sell it or a product or service whose value derives entirely or\nsubstantially from it. It is source-available, not OSI open source.'));
  }
  const readme = path.join(root, 'README.md');
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, 'utf8');
    const old = /\[Apache License 2\.0\]\(LICENSE\)\./;
    if (old.test(text)) touch('README.md', text.replace(old, 'Source-available under the [Apache License 2.0 with the Commons Clause](LICENSE): use it, change it and build with it, including at work, but don\'t sell it or a service whose value comes mainly from it. This is not an OSI open-source license.'));
  }
  return changed;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf('--root');
  const root = rootArg >= 0 ? path.resolve(args[rootArg + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const check = args.includes('--check');
  const dry = args.includes('--dry-run') || check;
  const changed = relicense(root, { write: !dry });
  const sources = changed.filter(f => SOURCE.test(f)).length;
  console.log(`${dry ? 'Would change' : 'Changed'} ${changed.length} files (${sources} source headers).`);
  if (dry) for (const f of changed.filter(f => !SOURCE.test(f))) console.log(`  ${f}`);
  if (check && changed.length) process.exitCode = 1;
}
