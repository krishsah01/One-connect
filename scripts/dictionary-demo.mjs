// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// End-to-end Dictionary demonstration on a DISPOSABLE multi-language repository:
//   onboard → committed-source intake → notes / structure / keywords (+ vectors, Graphify when
//   given an already-installed tool) → cited queries → a commit that edits, deletes and renames
//   files → incremental update with old content gone → restart → same citations and state.
// Never downloads a model or tool, never reads your projects or vault, never contacts a remote host.
//
//   node scripts/dictionary-demo.mjs [--graphify <bin>] [--embedding-model <installed model>] [--keep] [--out <file.json>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../packages/core/src/index.ts';
import { Daemon } from '../packages/daemon/src/daemon.ts';

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const graphify = arg('--graphify'), model = arg('--embedding-model'), out = arg('--out'), keep = process.argv.includes('--keep');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictionary-demo-'));
const repo = path.join(root, 'shop'), vault = path.join(root, 'vault'), data = path.join(root, 'data');
const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' } }).trim();
const write = (files) => { for (const [rel, c] of Object.entries(files)) { const p = path.join(repo, rel); if (c === null) fs.rmSync(p, { force: true }); else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); } } };
const commit = (m) => { git('add', '-A'); git('commit', '-qm', m); const sha = git('rev-parse', 'HEAD'); git('branch', '-f', 'integration', sha); return sha; };

fs.mkdirSync(repo, { recursive: true });
write({
  'README.md': '# Shop\n\nA small storefront: a TypeScript web API, a Python pricing worker, a Rust inventory service and a Go gateway. See docs/architecture.md.\n',
  'docs/architecture.md': '# Architecture\n\nThe checkout handler (api/src/checkout.ts) prices carts with the pricing worker (worker/pricing.py) and reserves stock through the inventory service (inventory/src/lib.rs). The gateway (gateway/main.go) terminates TLS.\n',
  'DESIGN.md': '# Design contract\n\nPrimary buttons use #087e8b. Error banners use #b42318 on #fef3f2. Corner radius 8px.\n',
  'package.json': JSON.stringify({ name: 'shop-api', private: true, workspaces: ['api'], scripts: { test: 'node --test' } }, null, 2) + '\n',
  'api/package.json': JSON.stringify({ name: '@shop/api', dependencies: { zod: '^4.0.0' } }, null, 2) + '\n',
  'api/src/checkout.ts': "import { cartTotal } from './cart.ts';\nimport { reserve } from './inventory.ts';\n\nexport async function checkout(cart: { sku: string; qty: number; cents: number }[]) {\n  const total = cartTotal(cart);\n  await reserve(cart);\n  return { total, currency: 'EUR' };\n}\n",
  'api/src/cart.ts': 'export const FREE_SHIPPING_CENTS = 5000;\nexport function cartTotal(lines: { qty: number; cents: number }[]): number {\n  return lines.reduce((n, l) => n + l.qty * l.cents, 0);\n}\n',
  'api/src/inventory.ts': "export async function reserve(lines: { sku: string; qty: number }[]) {\n  return fetch('http://inventory.internal/reserve', { method: 'POST', body: JSON.stringify(lines) });\n}\n",
  'worker/pyproject.toml': '[project]\nname = "pricing-worker"\ndependencies = ["pydantic>=2", "httpx"]\n',
  'worker/pricing.py': 'from .rules import VAT_RATE\n\ndef price_with_vat(cents: int) -> int:\n    return round(cents * (1 + VAT_RATE))\n',
  'worker/rules.py': 'VAT_RATE = 0.21\n',
  'worker/__init__.py': '',
  'inventory/Cargo.toml': '[package]\nname = "inventory"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1", features = ["full"] }\n',
  'inventory/src/lib.rs': 'mod stock;\npub use crate::stock::Stock;\n\npub fn reserve(stock: &mut Stock, sku: &str, qty: u32) -> bool {\n    stock.take(sku, qty)\n}\n',
  'inventory/src/stock.rs': 'pub const HOLD_MINUTES: u32 = 15;\npub struct Stock;\nimpl Stock {\n    pub fn take(&mut self, _sku: &str, _qty: u32) -> bool { true }\n}\n',
  'gateway/go.mod': 'module example.invalid/shop/gateway\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.1.0\n',
  'gateway/main.go': 'package main\n\nimport (\n\t"net/http"\n\t"example.invalid/shop/gateway/routes"\n)\n\nfunc main() {\n\thttp.ListenAndServe(":8443", routes.Router())\n}\n',
  'gateway/routes/routes.go': 'package routes\n\nimport "net/http"\n\nfunc Router() http.Handler { return http.NewServeMux() }\n',
  'Dockerfile': 'FROM node:22-alpine\nEXPOSE 3000\n',
  'compose.yaml': 'services:\n  api:\n    build: .\n  db:\n    image: postgres:16-alpine\n',
  'docs/legacy-refunds.md': '# Refunds (legacy)\n\nLegacy refunds take 14 business days.\n',
});
git('init', '-q', '-b', 'main');
const v1 = commit('shop v1');

const config = parseConfig({
  project: { name: 'shop-demo', repo, integration_branch: 'integration', protected_branches: ['main'], checks: {} },
  agents: [{ id: 'relay', name: 'Relay', role: 'engineer', adapter: 'relay' }],
  knowledge: { vault, folder: 'One Connect', context_folders: ['One Connect'], obsidian_cli: 'off', search: { semantic: Boolean(model), ...(model ? { embedding_model: model } : {}) } },
  graphify: graphify ? { enabled: true, binary: graphify } : { enabled: false },
});
const report = { at: new Date().toISOString(), repo: 'disposable', tools: { graphify: graphify ?? null, embeddingModel: model ?? null }, steps: [] };
const step = (name, detail) => { report.steps.push({ name, ...detail }); console.error(`✓ ${name}`); };
const citationsFor = async (d, q) => d.context.answer.cite(await d.context.docs.search(q)).citations.filter((c) => c.projectSource).map((c) => ({ source: c.projectSource.path, lines: `${c.projectSource.line}-${c.projectSource.endLine}`, revision: c.projectSource.revision, via: c.via ?? null, excerpt: c.excerpt.slice(0, 160) }));
const status = (d) => { const s = d.context.answer.status; return { state: s.state, revision: s.revision, notes: s.notesRevision, vectors: s.embeddingsRevision, graph: s.graphRevision, files: s.files, stages: Object.fromEntries(Object.entries(s.stages ?? {}).map(([k, v]) => [k, `${v.state}${v.revision ? `@${v.revision.slice(0, 8)}` : ''}`])), changes: s.changes ? { mode: s.changes.mode, added: s.changes.added, modified: s.changes.modified, deleted: s.changes.deleted, renamed: s.changes.renamed, reread: s.changes.reread } : null, error: s.error }; };

let d = new Daemon({ config, dataDir: data, allowTempDataDir: true, probe: false, rulesTickMs: 3_600_000 });
try {
  await d.start(); await d.context.answer.refresh(false);
  step('Intake at v1', { revision: v1, status: status(d), structure: d.context.answer.status.structure });
  const q1 = await citationsFor(d, 'What does the checkout handler depend on?');
  const q2 = await citationsFor(d, 'What VAT rate does the pricing worker apply?');
  const q3 = await citationsFor(d, 'How long do legacy refunds take?');
  step('Cited queries at v1', { checkoutDependsOn: q1, vat: q2, legacyRefunds: q3 });

  write({ 'worker/rules.py': 'VAT_RATE = 0.19\n', 'docs/legacy-refunds.md': null, 'inventory/src/stock.rs': null, 'inventory/src/reservations.rs': 'pub const HOLD_MINUTES: u32 = 15;\npub struct Stock;\nimpl Stock {\n    pub fn take(&mut self, _sku: &str, _qty: u32) -> bool { true }\n}\n', 'inventory/src/lib.rs': 'mod reservations;\npub use crate::reservations::Stock;\n\npub fn reserve(stock: &mut Stock, sku: &str, qty: u32) -> bool {\n    stock.take(sku, qty)\n}\n' });
  const v2 = commit('shop v2: VAT change, refunds doc removed, stock module renamed');
  await d.context.answer.refresh(false);
  const gone = Number(d.context.docs.db.prepare("SELECT count(*) AS n FROM chunks WHERE content LIKE '%14 business days%' OR content LIKE '%VAT_RATE = 0.21%'").get().n);
  const goneBlobs = Number(d.context.answer.manifest.db.prepare("SELECT count(*) AS n FROM blobs WHERE content LIKE '%14 business days%' OR content LIKE '%VAT_RATE = 0.21%'").get().n);
  const vatAfter = await citationsFor(d, 'What VAT rate does the pricing worker apply?');
  const refundsAfter = await d.context.docs.ask('How long do legacy refunds take?');
  step('Incremental update to v2', { revision: v2, status: status(d), staleChunks: gone, staleBlobs: goneBlobs, vat: vatAfter, legacyRefunds: { evidence: refundsAfter.evidence, citesDeletedFile: refundsAfter.citations.some((c) => c.excerpt.includes('14 business days')) } });
  const before = JSON.stringify(vatAfter);
  await d.shutdown();
  d = new Daemon({ config, dataDir: data, allowTempDataDir: true, probe: false, rulesTickMs: 3_600_000 });
  const restored = d.context.answer.status.state;
  await d.start(); await d.context.answer.refresh(false);
  const vatRestarted = await citationsFor(d, 'What VAT rate does the pricing worker apply?');
  step('Restart', { statusBeforeStart: restored, status: status(d), sameCitations: JSON.stringify(vatRestarted) === before, reread: d.context.answer.status.job?.total ?? null });
  const packet = await d.context.packets.build({ query: 'How does checkout reserve stock?' });
  step('Agent packet (dashboard preview)', { chars: packet.budget.used, entryPoints: packet.architecture.entryPoints, central: packet.architecture.central, citations: packet.context?.citations.map((c) => `${c.source}:${c.lines}${c.via ? ` (${c.via})` : ''}`) });
  report.egress = { requests: d.egress.log.length, offMachine: d.egress.log.filter((e) => !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(e.host)).length };
} finally {
  await d.shutdown().catch(() => undefined);
  if (!keep) fs.rmSync(root, { recursive: true, force: true }); else report.dir = root;
}
const json = JSON.stringify(report, null, 2);
if (out) fs.writeFileSync(out, json + '\n'); else console.log(json);
