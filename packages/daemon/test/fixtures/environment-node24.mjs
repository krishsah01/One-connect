// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Run directly with Node >=24, without Vitest/TypeScript transpilation or a real Docker engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { Daemon } from '../../src/daemon.ts';
import { ProjectEnvironment } from '../../src/environment/workbench.ts';
import { makeConfig } from '../helpers.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-node24-environment-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'compose.yaml'), 'services: { app: { build: . } }\n');
fs.writeFileSync(path.join(repo, 'Dockerfile'), 'FROM scratch\nCOPY source.txt /source.txt\n');
fs.writeFileSync(path.join(repo, 'source.txt'), 'approved');
const d = new Daemon({ config: makeConfig(repo), dataDir: path.join(root, 'state'), allowTempDataDir: true, probe: false });
let snapshot;
const env = new ProjectEnvironment(d, { exec: async args => {
  let stdout = '';
  if (args[0] === 'version') stdout = JSON.stringify({ Client: { Version: 'fixture' }, Server: { Version: 'fixture' } });
  else if (args[0] === 'context') stdout = JSON.stringify('unix:///fixture.sock');
  else if (args[0] === 'compose' && args[1] === 'version') stdout = 'fixture';
  else {
    const compose = args[args.indexOf('-f') + 1];
    snapshot = path.dirname(compose);
    fs.writeFileSync(path.join(repo, 'source.txt'), 'harmless race');
    fs.writeFileSync(path.join(repo, 'Dockerfile'), 'FROM scratch\nRUN echo harmless-race\n');
    const doc = YAML.parse(fs.readFileSync(compose, 'utf8'));
    assert.equal(fs.readFileSync(path.join(doc.services.app.build.context, 'source.txt'), 'utf8'), 'approved');
    assert.equal(fs.readFileSync(path.join(doc.services.app.build.context, 'Dockerfile'), 'utf8'), 'FROM scratch\nCOPY source.txt /source.txt\n');
  }
  return { code: 0, stdout, stderr: '', timedOut: false };
}, portProbe: async () => false });
try {
  const req = await env.request('build', ['app']);
  const { job } = await env.resolve(req.decision.id, 'approve', req.digest);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(job.state, 'succeeded');
  assert.equal(fs.existsSync(snapshot), false);
  console.log(`${process.version}: strip-only environment approval/build race/cleanup passed (Docker protocol fixture)`);
} finally {
  await env.close();
  await d.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}
