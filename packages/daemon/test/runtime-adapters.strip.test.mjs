// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Run with Node 24 --test. Every import gets a fresh process, no transpiler or provider access.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

assert.match(process.version, /^v24\./, 'Run this contract with the installed Node 24 runtime');
const modules = [
  'adapters/agents/opencode.ts', 'adapters/agents/opencode/protocol.ts',
  'adapters/agents/opencode/events.ts', 'adapters/agents/ollama.ts',
  'adapters/agents/ollama-cloud.ts', 'jev.ts',
];
const guardedImport = `
  import child from 'node:child_process';
  import http from 'node:http';
  import https from 'node:https';
  import net from 'node:net';
  import { syncBuiltinESMExports } from 'node:module';
  const forbidden = () => { throw new Error('Import attempted external IO'); };
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[k] = forbidden;
  http.request = http.get = https.request = https.get = net.connect = net.createConnection = forbidden;
  globalThis.fetch = forbidden;
  syncBuiltinESMExports();
  await import(process.argv[1]);
  if (process.argv[2] !== 'entrypoint') console.log('loaded:' + process.argv[1]);
`;

function isolated(check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-runtime-strip-'));
  const env = { PATH: path.dirname(process.execPath), HOME: root, TMPDIR: root,
    XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_STATE_HOME: root };
  try { check(root, env); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const file of modules) test(`Node24 isolated strip-only import: ${file}`, () => isolated((root, env) => {
  const url = new URL(`../src/${file}`, import.meta.url).href;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', guardedImport, url],
    { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'loaded:' + url);
}));

test('Node24 bridge entrypoint rejects an unknown wire protocol before server startup', () => isolated((root, env) => {
  const bridge = new URL('../src/adapters/agents/opencode/bridge.ts', import.meta.url).href;
  // Executable entrypoint: import with stdin, expect an honest failure before any vendor IO.
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', guardedImport, bridge, 'entrypoint'],
    { cwd: root, env, encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ protocol: 'unsupported', model: { providerID: 'ollama', modelID: 'fixture' } }) + '\n' });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.some(line => line.t === 'error' && /bridge protocol mismatch/.test(line.message)));
  assert.ok(lines.some(line => line.t === 'result' && line.ok === false));
  assert.ok(!lines.some(line => line.t === 'ready'));
}));
