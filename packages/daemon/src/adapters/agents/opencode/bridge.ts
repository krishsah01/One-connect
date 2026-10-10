// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Per-run OpenCode bridge. Started by the detached runner like any vendor CLI:
//
//   node bridge.ts <runDir>      (first stdin line = start payload; later lines = user messages)
//
// It owns one loopback OpenCode server for this run: random port on 127.0.0.1, a random
// per-run password (from the environment, never argv or disk), isolated config/storage. It
// follows the server's event stream and prints one JSON line per event on stdout (the runner
// redacts and persists them; token deltas go to the live log). Permission requests and human
// questions are sent to One Connect's approvals through the per-run token in <runDir>/mcp.json,
// using the same policy as Claude's permission prompts; the answer is relayed back to OpenCode.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { ollamaStatus } from '../ollama.ts';
import readline from 'node:readline';
import { EventMapper, SseParser, type OcEvent, type PermissionRequest, type QuestionRequest } from './events.ts';
import { assertServerContract, checkVersion, OPENCODE_PROTOCOL, permissionReply, permissionToTool, serverEnvironment, supportedSeries, type BridgeLine } from './protocol.ts';

interface StartPayload {
  binary: string;
  cwd: string;
  model: { providerID: string; modelID: string };
  prompt: string;
  resume: { sessionId: string; message: string } | null;
  title: string;
  protocol: string;
  envKey: string | null;
  provider: { provider: string; base_url?: string; ollama_route?: string };
}

const runDir = process.argv[2] ?? '';
const out = (l: BridgeLine) => process.stdout.write(`${JSON.stringify(l)}\n`);
const log = (s: string) => process.stderr.write(`bridge: ${s}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const username = process.env.OPENCODE_SERVER_USERNAME ?? 'acc';
const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

let base = '';
let server: ChildProcess | null = null;
let finished = false;
const mapper = new EventMapper();
const queued: string[] = [];
let ready = false;
let model: StartPayload['model'];

// ---- delta coalescing: at most ~12 live updates a second per part, final text always wins ---
const pendingDelta = new Map<string, BridgeLine>();
let deltaTimer: NodeJS.Timeout | null = null;
function flushDeltas() {
  if (deltaTimer) clearTimeout(deltaTimer);
  deltaTimer = null;
  for (const l of pendingDelta.values()) out(l);
  pendingDelta.clear();
}
function emit(l: BridgeLine) {
  if (l.t === 'delta') {
    pendingDelta.set(l.partId, l);
    if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 80);
    return;
  }
  if (l.t === 'message' || l.t === 'reasoning') pendingDelta.delete(l.partId);
  flushDeltas();
  out(l);
}

async function api(method: string, p: string, body?: unknown, timeoutMs = 15_000): Promise<Response> {
  return fetch(`${base}${p}`, {
    method,
    headers: { authorization: authHeader, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    // A redirect could carry the per-run credentials to another host.
    redirect: 'error',
  });
}

// ---- daemon bridge (same token + endpoints as the acc MCP server) ----------------------------
function daemonConfig(): { url: string; token: string } {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'mcp.json'), 'utf8')) as { url: string; token: string };
}
async function daemonCall(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { url, token } = daemonConfig();
      const res = await fetch(`${url}/api/mcp/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acc-run-token': token }, body: JSON.stringify(args), redirect: 'error', signal: AbortSignal.timeout(35_000) });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(body.error ?? res.statusText));
      return body;
    } catch (e) {
      if (attempt >= 60 || finished) throw e;
      await sleep(2000);
    }
  }
}
async function untilAnswered(first: Record<string, unknown>): Promise<Record<string, unknown>> {
  let r = first;
  while (r.pending && r.approvalId && !finished) r = await daemonCall('wait_approval', { approvalId: r.approvalId });
  return r;
}

async function handlePermission(req: PermissionRequest) {
  const m = permissionToTool(req.raw);
  emit({ t: 'permission', id: req.id, state: 'asked', tool: m.tool_name, summary: m.summary });
  let allow = false;
  try {
    const r = await untilAnswered(await daemonCall('permission_prompt', { tool_name: m.tool_name, input: m.input }));
    allow = r.behavior === 'allow';
  } catch (e) {
    log(`permission routing failed, denying: ${(e as Error).message}`);
  }
  if (finished) return;
  // Never "always": every later action is judged again by One Connect's policy.
  const reply = permissionReply(req.id, allow);
  const res = await api('POST', reply.path, reply.body).catch((e: Error) => {
    log(`permission reply failed: ${e.message}`);
    return null;
  });
  if (!res?.ok) { await finish({ ok: false, error: `OpenCode permission reply failed (${res?.status ?? 'unreachable'})` }); return; }
  emit({ t: 'permission', id: req.id, state: allow ? 'allowed' : 'denied', tool: m.tool_name, summary: m.summary });
}

async function handleQuestion(req: QuestionRequest) {
  emit({ t: 'question', id: req.id, state: 'asked', question: req.questions.map((q) => q.question).join(' / ').slice(0, 500) });
  const answers: string[][] = [];
  try {
    for (const q of req.questions) {
      if (q.multiple) throw new Error('Multiple-choice question answers are not supported by the human inbox yet');
      const r = await untilAnswered(await daemonCall('ask_human', { question: q.header ? `${q.header}: ${q.question}` : q.question, options: q.options, context: 'Asked by the OpenCode agent' }));
      if (!r.answered) throw new Error('unanswered');
      answers.push([String(r.answer ?? '')]);
    }
  } catch (e) {
    log(`question not answered: ${(e as Error).message}`);
    if (!finished) {
      const res = await api('POST', `/question/${encodeURIComponent(req.id)}/reject`, {}).catch(() => null);
      if (!res?.ok) { await finish({ ok: false, error: `OpenCode question rejection failed (${res?.status ?? 'unreachable'})` }); return; }
      emit({ t: 'question', id: req.id, state: 'rejected', question: '' });
    }
    return;
  }
  if (finished) return;
  const res = await api('POST', `/question/${encodeURIComponent(req.id)}/reply`, { answers }).catch(() => null);
  if (!res?.ok) { await finish({ ok: false, error: `OpenCode question reply failed (${res?.status ?? 'unreachable'})` }); return; }
  emit({ t: 'question', id: req.id, state: 'answered', question: '' });
}

// ---- server lifecycle -------------------------------------------------------------------------
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function pipeLines(stream: NodeJS.ReadableStream | null, prefix: string) {
  if (!stream) return;
  readline.createInterface({ input: stream }).on('line', (line) => process.stderr.write(`${prefix}${line}\n`));
}

/** Fail before starting a binary that could initialize config, SDKs or model downloads. */
async function preflightServer(start: StartPayload, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform === 'darwin') {
    const user = os.userInfo().username;
    if ([path.join('/Library/Managed Preferences', user, 'ai.opencode.managed.plist'), '/Library/Managed Preferences/ai.opencode.managed.plist'].some((p) => fs.existsSync(p))) throw new Error('Managed OpenCode preferences are present; isolated configuration cannot be guaranteed');
  }
  // Pinned RipgrepBinary.filepath downloads rg if neither PATH nor cache has it.
  // Require an existing executable on PATH; do not seed a fake cache or install anything.
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const hasRg = (env.PATH ?? '').split(path.delimiter).some((dir) => {
    try { const p = path.join(dir, name); fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (!hasRg) throw new Error('OpenCode needs an existing rg executable on PATH; automatic binary downloads are disabled');
  const version = await new Promise<string>((resolve, reject) => {
    const child = spawn(start.binary, ['--version'], { cwd: start.cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let value = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('OpenCode --version timed out')); }, 5000);
    child.stdout.on('data', (s: Buffer) => { value += s.toString(); if (value.length > 4096) child.kill('SIGKILL'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(value.trim()) : reject(new Error('Could not read OpenCode --version')); });
  });
  const verdict = checkVersion(version);
  if (!verdict.ok) throw new Error(verdict.message);
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) fs.mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  if (start.provider.provider === 'ollama' || start.provider.provider === 'ollama-cloud') {
    const status = await ollamaStatus(start.provider, async (url, init) => fetch(url, init), { ACC_SECRET_OLLAMA_CLOUD: env.OLLAMA_API_KEY });
    const selected = status.models.find((m) => m.id === start.model.modelID);
    if (status.state !== 'ready' || selected?.tools !== true || selected.hidden) throw new Error(`Ollama cannot verify the selected model, route, authentication and tool support: ${status.message}`);
  }
}

async function startServer(start: StartPayload): Promise<{ version: string; port: number }> {
  if (!password || password.length < 24) throw new Error('missing per-run server password');
  const env = serverEnvironment(process.env, start.envKey);
  await preflightServer(start, env);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(start.binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: start.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  pipeLines(server.stdout, 'opencode: ');
  pipeLines(server.stderr, 'opencode: ');
  let exited: number | null | undefined;
  server.on('exit', (code) => {
    exited = code ?? -1;
    if (!finished && ready) void finish({ ok: false, error: `the OpenCode server exited unexpectedly (code ${code})` });
  });
  server.on('error', (e) => log(`could not start ${start.binary}: ${e.message}`));
  const end = Date.now() + 40_000;
  for (;;) {
    if (exited !== undefined) throw new Error(`the OpenCode server exited during startup (code ${exited})`);
    try {
      const res = await api('GET', '/global/health', undefined, 2000);
      if (res.status === 401) throw new Error('OpenCode rejected the per-run credentials');
      if (res.ok) {
        const j = (await res.json()) as { healthy?: boolean; version?: string };
        if (j.healthy === true) return { version: String(j.version ?? ''), port };
      }
    } catch (e) {
      if (/credentials/.test((e as Error).message)) throw e;
    }
    if (Date.now() > end) throw new Error('the OpenCode server did not become healthy within 40s');
    await sleep(150);
  }
}

async function stopServer() {
  const s = server;
  if (!s || s.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        s.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve();
    }, 2500);
    s.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      s.kill('SIGTERM');
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

let resolveDone: () => void = () => undefined;
const donePromise = new Promise<void>((r) => (resolveDone = r));
let exitCode = 0;
async function finish(f: { ok: boolean; error?: string; aborted?: boolean }) {
  if (finished) return;
  finished = true;
  eventAbort.abort();
  if (f.aborted) emit({ t: 'aborted', reason: 'abort requested by One Connect' });
  emit({ t: 'result', ok: f.ok, ...(f.error && !f.aborted ? { error: f.error } : {}) });
  flushDeltas();
  exitCode = f.aborted ? 130 : f.ok ? 0 : 1;
  resolveDone();
}

function dispatchMapped(m: ReturnType<EventMapper['handle']>) {
  for (const l of m.lines) emit(l);
  if (m.permission) void handlePermission(m.permission);
  if (m.question) void handleQuestion(m.question);
  if (m.finished) void finish(m.finished);
}

// ---- event stream --------------------------------------------------------------------------
// The v1 bus has no replay cursor. Losing it can lose an approval or completion, so fail closed.
let eventAbort = new AbortController();
async function followEvents(): Promise<void> {
  const res = await fetch(`${base}/event`, { headers: { authorization: authHeader, accept: 'text/event-stream' }, redirect: 'error', signal: eventAbort.signal });
  if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`event stream answered ${res.status} without SSE`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const sse = new SseParser();
  // Returning now guarantees the subscription is open before sending any prompt.
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { if (!finished) throw new Error('OpenCode event stream ended before a result'); break; }
        for (const data of sse.push(dec.decode(value, { stream: true }))) dispatchMapped(mapper.handle(JSON.parse(data) as OcEvent));
      }
    } catch (e) {
      if (!finished) await finish({ ok: false, error: `Lost or invalid OpenCode event stream: ${(e as Error).message}` });
    } finally { reader.releaseLock(); }
  })();
}

async function sendText(sessionId: string, text: string) {
  const res = await api('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, { model, parts: [{ type: 'text', text }] });
  if (!res.ok) throw new Error(`prompt was refused (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

async function abort(reason: string) {
  mapper.abortRequested = true;
  log(`abort: ${reason}`);
  if (mapper.rootId && base) await api('POST', `/session/${encodeURIComponent(mapper.rootId)}/abort`, {}, 2000).catch(() => null);
  await sleep(300);
  await finish({ ok: false, error: 'aborted', aborted: true });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  let startResolve: (s: StartPayload) => void = () => undefined;
  const startLine = new Promise<StartPayload>((r) => (startResolve = r));
  let gotStart = false;
  rl.on('line', (line) => {
    if (!line.trim()) return;
    if (!gotStart) {
      gotStart = true;
      startResolve(JSON.parse(line) as StartPayload);
      return;
    }
    try {
      const m = JSON.parse(line) as { type?: string; text?: string };
      if (m.type === 'abort') void abort('stop requested by One Connect');
      else if (m.type === 'user' && m.text) {
        if (mapper.rootId && ready) void sendText(mapper.rootId, m.text).catch((e: Error) => log(e.message));
        else queued.push(m.text);
      }
    } catch {
      log('ignored a non-JSON message line');
    }
  });
  process.on('SIGTERM', () => void abort('SIGTERM'));
  process.on('SIGINT', () => void abort('SIGINT'));
  process.on('SIGHUP', () => undefined);

  const start = await startLine;
  model = start.model;
  mapper.expected = start.model;
  if (start.protocol !== OPENCODE_PROTOCOL) throw new Error(`bridge protocol mismatch: ${start.protocol} != ${OPENCODE_PROTOCOL}`);
  const { version, port } = await startServer(start);
  const verdict = checkVersion(version, process.env);
  if (!verdict.ok) {
    emit({ t: 'error', name: 'UnsupportedVersion', message: `${verdict.message} (running server reported ${version || 'no version'}; supported: ${supportedSeries(process.env).join(', ')})` });
    await finish({ ok: false, error: verdict.message });
    return;
  }
  emit({ t: 'ready', version, protocol: OPENCODE_PROTOCOL, port });

  const doc = await api('GET', '/doc');
  if (!doc.ok) throw new Error(`OpenCode contract discovery failed (${doc.status})`);
  assertServerContract(await doc.json());
  await followEvents();
  let sessionId: string;
  if (start.resume) {
    const res = await api('GET', `/session/${encodeURIComponent(start.resume.sessionId)}`);
    if (!res.ok) throw new Error(`session ${start.resume.sessionId} is not in this agent's OpenCode storage (${res.status}); it cannot be resumed`);
    sessionId = start.resume.sessionId;
  } else {
    const res = await api('POST', '/session', { title: start.title });
    if (!res.ok) throw new Error(`could not create a session (${res.status})`);
    sessionId = String(((await res.json()) as { id?: string }).id ?? '');
    if (!sessionId) throw new Error('OpenCode returned a session without an id');
  }
  mapper.setRoot(sessionId);
  emit({ t: 'session', sessionId, model: `${start.model.providerID}/${start.model.modelID}`, resumed: Boolean(start.resume) });
  ready = true;
  await sendText(sessionId, start.resume ? start.resume.message : start.prompt);
  if (finished) return;
  for (const q of queued.splice(0)) await sendText(sessionId, q).catch((e: Error) => log(e.message));
  await donePromise;
}

main()
  .catch(async (e: Error) => {
    log(e.message);
    emit({ t: 'error', name: 'BridgeError', message: e.message });
    await finish({ ok: false, error: e.message });
  })
  .finally(async () => {
    await donePromise;
    flushDeltas();
    await stopServer();
    process.exit(exitCode);
  });
