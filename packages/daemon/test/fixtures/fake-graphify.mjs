#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Minimal stand-in for the graphify CLI (update / query / path / explain) used in tests.
import fs from 'node:fs';
import path from 'node:path';
const [cmd, ...rest] = process.argv.slice(2);
const graphArg = rest.indexOf('--graph');
const graphFile = graphArg >= 0 ? rest[graphArg + 1] : 'graphify-out/graph.json';
if (cmd === 'update') {
  const root = path.resolve(rest[0] ?? '.');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name === 'graphify-out' || e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|ts)$/.test(e.name)) files.push(path.relative(root, p)); } };
  walk(root);
  const nodes = files.map((f) => ({ id: f, label: path.basename(f), source_file: f }));
  const links = files.slice(1).map((f) => ({ source: files[0], target: f, relation: 'imports' }));
  fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify({ nodes, links }));
  fs.writeFileSync(path.join(root, 'graphify-out', 'GRAPH_REPORT.md'), `# Graph Report\n\n${nodes.length} nodes, ${links.length} edges\n`);
  console.log(`Rebuilt: ${nodes.length} nodes, ${links.length} edges`);
} else if (cmd === 'query' || cmd === 'path' || cmd === 'explain') {
  const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  console.log(`${cmd.toUpperCase()} ${rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--graph' && rest[i - 1] !== '--budget').join(' | ')}\n${g.nodes.map((n) => `NODE ${n.label} [src=${n.source_file}]`).join('\n')}`);
} else {
  console.error(`fake graphify: unsupported ${cmd}`);
  process.exit(2);
}
