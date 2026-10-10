#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Stand-in for the official Obsidian CLI: `obsidian vault=<name> search query=… path=… format=json`.
import fs from 'node:fs';
import path from 'node:path';
const params = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const cmd = process.argv.slice(2).find((a) => !a.includes('='));
const root = process.env.FAKE_VAULT_ROOT;
if (cmd !== 'search' || !root) process.exit(2);
const hits = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md') && fs.readFileSync(p, 'utf8').toLowerCase().includes(params.query.toLowerCase())) hits.push(path.relative(root, p)); } };
walk(path.join(root, params.path ?? ''));
console.log(JSON.stringify(hits.slice(0, Number(params.limit ?? 10)).map((p) => ({ path: p }))));
