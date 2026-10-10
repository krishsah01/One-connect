// SPDX-License-Identifier: Apache-2.0
// Official Cursor CLI, existing account login, scoped snapshot and durable redacted logs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLineRedactor } from '../packages/core/src/redact.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const records = path.join(root, 'docs/verification/delegation');
const workspace = '/private/tmp/one-connect-parallel-20261007/connectors';
const binary = '/Users/krishkumarsah/.local/bin/cursor-agent';
const model = 'composer-2.5';
const promptPath = path.join(records, 'CURSOR-connectors-completion.md');
const statusPath = path.join(records, 'cursor-connectors-worker.status.json');
if (!fs.existsSync(path.join(workspace, 'CURRENT_SOURCE_SNAPSHOT.json'))) throw new Error('Prepared current-source checkout missing');
if (fs.existsSync(statusPath)) {
  const old = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  if (old.state === 'running') throw new Error('Worker already recorded running: inspect the existing handle before restarting');
}
const allowed = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'PNPM_HOME'];
const env = Object.fromEntries(allowed.filter(k => process.env[k]).map(k => [k, process.env[k]]));
env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
env.CARGO_NET_OFFLINE = 'true';
// Provider API keys, MCP/plugin auto-approval and sandbox disabling are deliberately absent.
const child = spawn(binary, ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--sandbox', 'enabled', '--auto-review', '--trust', '--workspace', workspace, '--model', model, fs.readFileSync(promptPath, 'utf8')], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
const status = { task: 'connectors-and-issue-import', pid: child.pid, binary, model, workspace, state: 'running', startedAt: new Date().toISOString(), lastOutputAt: null, sessionId: null, onDemandOff: 'Owner confirmed in this conversation; CLI cannot independently verify the account toggle.', auth: 'Official vendor-owned login; no API key supplied', exitCode: null, reason: null };
const save = () => fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
const log = fs.createWriteStream(path.join(records, 'cursor-connectors-worker.jsonl'), { flags: 'a', mode: 0o600 });
const errorLog = fs.createWriteStream(path.join(records, 'cursor-connectors-worker.stderr.log'), { flags: 'a', mode: 0o600 });
save();
console.log(JSON.stringify({ state: status.state, pid: child.pid, model, workspace }));
function capture(stream, target, stderr = false) {
  const clean = createLineRedactor();
  let pending = '', lastNotice = 0;
  stream.setEncoding('utf8');
  const line = raw => {
    const redacted = clean(raw).text;
    target.write(redacted + '\n');
    status.lastOutputAt = new Date().toISOString();
    try {
      const event = JSON.parse(redacted);
      if (event.type === 'system' && event.session_id) { status.sessionId = event.session_id; console.log(JSON.stringify({ event: 'session', sessionId: status.sessionId, model: event.model ?? model })); }
      if (event.type === 'result') console.log(JSON.stringify({ event: 'result', isError: event.is_error ?? null, result: String(event.result ?? '').slice(-1400) }));
    } catch { if (stderr && /limit|auth|error|denied|approval|timeout/i.test(redacted)) console.log(JSON.stringify({ diagnostic: redacted.slice(0, 500) })); }
    if (Date.now() - lastNotice > 60_000) { console.log(JSON.stringify({ event: 'output', at: status.lastOutputAt })); lastNotice = Date.now(); }
    save();
  };
  stream.on('data', chunk => { pending += chunk; const rows = pending.split('\n'); pending = rows.pop(); for (const row of rows) line(row); });
  stream.on('end', () => { if (pending) line(pending); });
}
capture(child.stdout, log);
capture(child.stderr, errorLog, true);
child.on('error', e => { status.state = 'failed'; status.reason = createLineRedactor()(e.message).text; save(); console.log(JSON.stringify({ state: status.state, reason: status.reason })); });
child.on('close', (code, signal) => {
  status.state = code === 0 ? 'finished' : 'failed'; status.exitCode = code; status.reason ??= signal; status.endedAt = new Date().toISOString(); save();
  log.end(); errorLog.end();
  console.log(JSON.stringify({ state: status.state, code, signal, handoff: fs.existsSync(path.join(workspace, 'CURSOR_CONNECTORS_HANDOFF.md')) }));
  process.exitCode = code ?? 1;
});
