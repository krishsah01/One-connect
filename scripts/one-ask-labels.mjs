#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The owner named the project-knowledge feature "One Ask". Earlier work called it "One Answer" and
// later "Dictionary". This renames only what people see: page titles, navigation, buttons, notices
// and messages. Code identifiers, file names, routes, stored folders and data paths stay as they
// are, so existing vaults and indexes keep working. Idempotent; `--check` lists what would change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const OLD_NAMES = ['Dictionary', 'One Answer'];

// Web UI and its tests: a visible word, never an identifier, import path or file name. "Dictionary"
// preceded by "/" or a word character, or followed by a word character, "." or "(", is left alone.
const WEB_DIRS = ['packages/web/src', 'packages/web/test'];
const visible = (name) => new RegExp(`(?<![/\\w])${name}(?![\\w.(])`, 'g');

// Engine messages people read, listed one by one so stored names are never touched.
const ENGINE_STRINGS = [
  ['packages/daemon/src/projects/inspect.ts', ['Dictionary indexes committed', 'One Ask indexes committed'], ['; Dictionary ', '; One Ask '], ['One Answer indexes committed', 'One Ask indexes committed']],
  ['packages/daemon/src/context/packet.ts', ['`Dictionary ', '`One Ask '], ["'Dictionary ", "'One Ask "]],
  ['packages/daemon/src/context/dictionary.ts', ['indexing it. Dictionary reads', 'indexing it. One Ask reads']],
  ['packages/daemon/src/connectors.ts', ['for Dictionary', 'for One Ask'], ['for One Answer', 'for One Ask']],
  ['packages/daemon/src/mcp/server.ts', ['Ask Dictionary about', 'Ask One Ask about'], ['Ask One Answer about', 'Ask One Ask about']],
  ['packages/daemon/src/benchmark/contextBenchmark.ts', ["'Dictionary: ", "'One Ask: "], ["'Dictionary runs", "'One Ask runs"]],
  ['packages/core/src/skills.ts', ['Cited Dictionary research', 'Cited One Ask research'], ['Cited One Answer research', 'Cited One Ask research']],
  ['packages/core/src/connectors.ts', ['folders for Dictionary', 'folders for One Ask'], ['folders for One Answer', 'folders for One Ask']],
  ['packages/core/src/benchmark.ts', ["'Dictionary arm", "'One Ask arm"]],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const changes = [];
for (const d of WEB_DIRS) {
  const abs = path.join(root, d);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    let text = fs.readFileSync(file, 'utf8');
    let n = 0;
    const lines = text.split('\n').map(line => {
      if (/^\s*import\b|from ['"]/.test(line)) return line; // import lines name files, not features
      let l = line;
      for (const name of OLD_NAMES) {
        l = l.replace(visible(name), () => { n++; return 'One Ask'; });
        // Text matchers in tests are regex literals: getByText(/Dictionary ready/).
        l = l.replace(new RegExp(`(?<=\\(/)${name}(?=[ /])`, 'g'), () => { n++; return 'One Ask'; });
      }
      return l;
    });
    if (n) { changes.push([path.relative(root, file), n]); if (!check) fs.writeFileSync(file, lines.join('\n')); }
  }
}
for (const [rel, ...pairs] of ENGINE_STRINGS) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  let text = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const [from, to] of pairs) { const parts = text.split(from); n += parts.length - 1; text = parts.join(to); }
  if (n) { changes.push([rel, n]); if (!check) fs.writeFileSync(file, text); }
}
for (const [file, n] of changes) console.log(`${check ? 'would change' : 'changed'} ${n} × ${file}`);
if (!changes.length) console.log('All visible labels already say One Ask.');
if (check && changes.length) process.exitCode = 1;
