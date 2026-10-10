#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Source-verified v1.18.35 contract subset from the tagged packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts.
// This is a synthetic test server, never a live protocol capture. No model/provider is called.
// A controlled loopback stand-in for `opencode serve`, used by tests. It implements only the
// pinned subset of the OpenCode server protocol that One Connect's bridge uses (see
// packages/daemon/src/adapters/agents/opencode/protocol.ts): basic auth with a per-run password,
// /global/health, the /event SSE stream, sessions (persisted under XDG_DATA_HOME so resume works),
// prompt_async, abort, permission and question replies. It makes no network calls and no model
// calls. It is NOT OpenCode: live validation against a real release is still pending.
//
// Scenario comes from a marker in the prompt: [fake:permission] [fake:question] [fake:child]
// [fake:hang] [fake:error] (default: a normal turn). Every request is appended to
// FAKE_OPENCODE_LOG as JSON lines so tests can assert what the bridge did.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const VERSION = process.env.FAKE_OPENCODE_VERSION ?? '1.18.35';
if (args[0] === '--version' || args[0] === '-v') {
  console.log(VERSION);
  process.exit(0);
}
if (args[0] !== 'serve') {
  console.error('fake opencode: only `serve` is implemented');
  process.exit(2);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt('--port'));
const hostname = opt('--hostname') ?? '127.0.0.1';
if (hostname !== '127.0.0.1') {
  console.error('fake opencode: refuses to bind anything but 127.0.0.1');
  process.exit(2);
}
const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const username = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const logFile = process.env.FAKE_OPENCODE_LOG;
const log = (o) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...o })}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

const dataDir = path.join(process.env.XDG_DATA_HOME ?? '/tmp', 'fake-opencode');
fs.mkdirSync(dataDir, { recursive: true });
const sessionsFile = path.join(dataDir, 'sessions.json');
const sessions = new Map(Object.entries(fs.existsSync(sessionsFile) ? JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) : {}));
const saveSessions = () => fs.writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)));

log({ kind: 'start', password, argv: args, cwd: process.cwd(), passwordInArgv: Boolean(password) && args.join(' ').includes(password), config: process.env.OPENCODE_CONFIG ?? null, xdgData: process.env.XDG_DATA_HOME ?? null, projectConfigDisabled: process.env.OPENCODE_DISABLE_PROJECT_CONFIG === '1', keys: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? null, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, OLLAMA_API_KEY: process.env.OLLAMA_API_KEY ?? null } });

const clients = new Set();
const send = (type, properties) => {
  const frame = `data: ${JSON.stringify({ id: id('evt'), type, properties })}\n\n`;
  for (const c of clients) c.write(frame);
};

const waiting = new Map(); // permission/question id → resolve
const waitFor = (key, ms = 90_000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  waiting.set(key, (v) => {
    clearTimeout(t);
    resolve(v);
  });
});

const abortFlags = new Set();

async function textStream(sessionID, messageID, partID, full, ms = Number(process.env.FAKE_OPENCODE_TOKEN_MS ?? 25)) {
  send('message.part.updated', { sessionID, time: 1, part: { id: partID, sessionID, messageID, type: 'text', text: '', time: { start: 1 } } });
  for (let offset = 0; offset < full.length; offset += 12) {
    send('message.part.delta', { sessionID, messageID, partID, field: 'text', delta: full.slice(offset, offset + 12) });
    await sleep(ms);
  }
  send('message.part.updated', { sessionID, time: 2, part: { id: partID, sessionID, messageID, type: 'text', text: full, time: { start: 1, end: 2 } } });
}

async function tool(sessionID, messageID, tool, input, run) {
  const partID = id('prt');
  const callID = id('call');
  send('message.part.updated', { part: { id: partID, sessionID, messageID, type: 'tool', tool, callID, state: { status: 'pending', input } } });
  send('message.part.updated', { part: { id: partID, sessionID, messageID, type: 'tool', tool, callID, state: { status: 'running', input, time: { start: 1 } } } });
  const r = await run();
  send('message.part.updated', { part: { id: partID, sessionID, messageID, type: 'tool', tool, callID, state: { status: r.error ? 'error' : 'completed', input, output: r.output ?? '', error: r.error, title: r.title ?? tool, metadata: r.metadata ?? {}, time: { start: 1, end: 2 } } } });
}

async function turn(sessionID, promptText, model = {}) {
  const marker = /\[fake:([a-z-]+)\]/.exec(promptText)?.[1] ?? 'basic';
  const cwd = process.cwd();
  send('session.status', { sessionID, status: { type: 'busy' } });
  const userMsg = id('msg');
  send('message.updated', { info: { id: userMsg, sessionID, role: 'user' } });
  send('message.part.updated', { part: { id: id('prt'), sessionID, messageID: userMsg, type: 'text', text: promptText, time: { start: 1, end: 1 } } });
  const mid = id('msg');
  send('message.updated', { info: { id: mid, sessionID, role: 'assistant', providerID: model.providerID ?? 'fixture', modelID: process.env.FAKE_OPENCODE_SERVED_MODEL ?? model.modelID ?? 'fixture' } });

  if (marker === 'error') {
    send('session.error', { sessionID, error: { name: 'ProviderAuthError', data: { message: 'invalid api key (fixture)', providerID: 'fixture' } } });
    return;
  }
  if (marker === 'network') {
    send('session.error', { sessionID, error: { name: 'APIError', data: { message: 'connection timed out (ETIMEDOUT)' } } });
    return;
  }
  if (marker === 'hang') {
    await textStream(sessionID, mid, id('prt'), 'Working on it…');
    while (!abortFlags.has(sessionID)) await sleep(100);
    send('session.error', { sessionID, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    send('session.idle', { sessionID });
    return;
  }
  if (marker === 'child') {
    const child = id('ses');
    send('session.created', { info: { id: child, parentID: sessionID, title: 'Explore the repository' } });
    const cm = id('msg');
    send('message.updated', { info: { id: cm, sessionID: child, role: 'assistant' } });
    await tool(child, cm, 'bash', { command: 'echo child-ran' }, async () => ({ output: 'child-ran\n', metadata: { exit: 0 } }));
    send('message.part.updated', { part: { id: id('prt'), sessionID: child, messageID: cm, type: 'text', text: 'CHILD PROSE MUST NOT APPEAR IN THE ROOT TRANSCRIPT', time: { start: 1, end: 2 } } });
    send('message.part.updated', { part: { id: id('prt'), sessionID: child, messageID: cm, type: 'step-finish', tokens: { input: 7, output: 3, reasoning: 0 }, cost: 0 } });
    send('session.idle', { sessionID: child });
  }
  if (marker === 'permission') {
    await textStream(sessionID, mid, id('prt'), 'I will edit a note, then push.');
    const edit = { id: id('per'), sessionID, permission: 'edit', always: [], patterns: ['notes/oc.md'], metadata: { filepath: 'notes/oc.md' } };
    send('permission.asked', edit);
    const r1 = waitFor(edit.id);
    const a1 = await r1;
    log({ kind: 'permission-decision', permission: 'edit', response: a1 });
    if (a1 === 'once') {
      fs.mkdirSync(path.join(cwd, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'notes', 'oc.md'), 'written by the fixture\n');
      await tool(sessionID, mid, 'edit', { filePath: 'notes/oc.md' }, async () => ({ output: 'ok', title: 'notes/oc.md' }));
    }
    const push = { id: id('per'), sessionID, permission: 'bash', always: ['git push *'], patterns: ['git push origin main'], metadata: { command: 'git push origin main' } };
    send('permission.asked', push);
    const a2 = await waitFor(push.id);
    log({ kind: 'permission-decision', permission: 'push', response: a2 });
    if (a2 === 'once') await tool(sessionID, mid, 'bash', { command: 'git push origin main' }, async () => ({ output: 'pushed (fixture)\n', metadata: { exit: 0 } }));
  } else if (marker === 'question') {
    const q = { id: id('que'), sessionID, questions: [{ question: 'Which database should the service use?', header: 'Database', options: [{ label: 'sqlite', description: 'file' }, { label: 'postgres', description: 'server' }] }] };
    send('question.asked', q);
    const answer = await waitFor(q.id);
    log({ kind: 'question-decision', answer });
    await textStream(sessionID, mid, id('prt'), `Using ${JSON.stringify(answer)}.`);
  } else {
    await tool(sessionID, mid, 'bash', { command: 'echo hi' }, async () => ({ output: process.env.FAKE_OPENCODE_ECHO_KEY ? `key is ${process.env.OPENROUTER_API_KEY}\n` : 'hi\n', metadata: { exit: 0 } }));
    await tool(sessionID, mid, 'bash', { command: 'node --test' }, async () => ({ output: '# tests 2\n# pass 2\n# fail 0\n', metadata: { exit: 0 } }));
  }
  const done = `Finished the ${marker} scenario.\n\n### Handoff\nDone: fixture ${marker} complete\nEvidence: none\nNext: nothing`;
  await textStream(sessionID, mid, id('prt'), done);
  send('message.part.updated', { part: { id: id('prt'), sessionID, messageID: mid, type: 'step-finish', tokens: { input: 120, output: 30, reasoning: 5 }, cost: 0 } });
  send('session.idle', { sessionID });
}

const body = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => {
    try {
      resolve(s ? JSON.parse(s) : {});
    } catch {
      resolve({});
    }
  });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.headers.authorization !== expected) {
    log({ kind: 'unauthorized', path: url.pathname });
    res.writeHead(401).end('unauthorized');
    return;
  }
  const b = req.method === 'POST' ? await body(req) : {};
  if (url.pathname !== '/event') log({ kind: 'request', method: req.method, path: url.pathname, body: b });
  const json = (code, v) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  if (req.method === 'GET' && url.pathname === '/global/health') return json(200, { healthy: true, version: process.env.FAKE_OPENCODE_HEALTH_VERSION ?? VERSION });
  if (req.method === 'GET' && url.pathname === '/doc') return json(200, { openapi: '3.1.0', paths: Object.fromEntries([['/global/health', 'get'], ['/event', 'get'], ['/session', 'post'], ['/session/{sessionID}', 'get'], ['/session/{sessionID}/prompt_async', 'post'], ['/session/{sessionID}/abort', 'post'], ['/permission/{requestID}/reply', 'post'], ['/question/{requestID}/reply', 'post'], ['/question/{requestID}/reject', 'post']].map(([route, method]) => [route, { [method]: { responses: {} } }])) });
  if (req.method === 'GET' && url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/session') {
    const s = { id: id('ses'), title: b.title ?? '', parentID: null };
    sessions.set(s.id, s);
    saveSessions();
    return json(200, s);
  }
  let m = /^\/session\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === 'GET') return sessions.has(m[1]) ? json(200, sessions.get(m[1])) : json(404, { error: 'not found' });
  m = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    if (!sessions.has(m[1])) return json(404, { error: 'no such session' });
    if (!b.model?.providerID || !b.model?.modelID || !Array.isArray(b.parts) || b.parts.some((p) => p.type !== 'text' || typeof p.text !== 'string')) return json(422, { error: 'Expected SessionPromptAsyncData model and text parts' });
    res.writeHead(204).end();
    const text = (b.parts ?? []).map((p) => p.text ?? '').join('\n');
    abortFlags.delete(m[1]);
    void turn(m[1], text, b.model);
    return;
  }
  m = /^\/session\/([^/]+)\/abort$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    abortFlags.add(m[1]);
    return json(200, true);
  }
  m = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    if (!['once', 'always', 'reject'].includes(b.reply) || 'response' in b) return json(422, { error: 'Expected PermissionReplyData.reply' });
    waiting.get(m[1])?.(b.reply);
    return json(200, true);
  }
  m = /^\/question\/([^/]+)\/(reply|reject)$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    if (process.env.FAKE_OPENCODE_QUESTION_STATUS) return json(Number(process.env.FAKE_OPENCODE_QUESTION_STATUS), { error: 'synthetic delivery failure' });
    waiting.get(m[1])?.(m[2] === 'reply' ? (b.answers ?? [[]])[0]?.[0] : null);
    return json(200, true);
  }
  json(404, { error: 'not implemented in the fixture', path: url.pathname });
});

server.listen(port, '127.0.0.1', () => console.log(`fake opencode listening on http://127.0.0.1:${port}`));
const bye = () => {
  for (const c of clients) c.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
