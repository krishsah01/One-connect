// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// OpenCode end to end through the real detached runner, bridge and daemon, against the loopback
// protocol fixture fixtures/opencode-current.mjs (not a real OpenCode, no model calls).
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@acc/core';
import { Daemon } from '../src/daemon.ts';
import { FAKE_BIN, makeConfig, makeRepo, startDaemon, tmpDir, waitFor, type Harness } from './helpers.ts';

const OC_FIXTURE = fileURLToPath(new URL('./fixtures/opencode-current.mjs', import.meta.url));
const metadataServers: http.Server[] = [];
const KEY = 'sk-or-v1-opencodefixturekey000000000000000';
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

/** Fake network: a local Ollama (signed in) and OpenRouter; nothing else exists. */
function net() {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname === '127.0.0.1') {
      if (u.pathname === '/api/version') return ok({ version: '0.34.1' });
      if (u.pathname === '/api/me') return ok({ name: 'owner' });
      if (u.pathname === '/api/tags') return ok({ models: [{ name: 'qwen3-coder:30b' }, { name: 'gpt-oss:120b-cloud' }] });
      if (u.pathname === '/api/show') return ok({ capabilities: ['completion', 'tools'] });
    }
    if (u.host === 'openrouter.ai' && u.pathname === '/api/v1/models') return ok({ data: [{ id: 'meta/llama-free:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] });
    if (u.host === 'openrouter.ai' && u.pathname === '/api/v1/key') return ok({ data: { usage: 0, limit: 10 } });
    void init;
    return new Response('nope', { status: 404 });
  };
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  await Promise.all(metadataServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const agents = (repo: string) => parseConfig({
  project: { name: 'x', repo },
  agents: [
    { id: 'oc', name: 'OpenCode local', role: 'engineer', adapter: 'opencode-server', provider: 'ollama', binary: '/fixture/opencode', model: 'qwen3-coder:30b' },
    { id: 'ocr', name: 'OpenCode OpenRouter', role: 'engineer', adapter: 'opencode-server', provider: 'openrouter', metered_opt_in: true, budget_usd_per_day: 5, binary: '/fixture/opencode', model: 'meta/llama-free:free' },
    { id: 'occ', name: 'OpenCode Ollama cloud', role: 'engineer', adapter: 'opencode-server', provider: 'ollama-cloud', binary: '/fixture/opencode', model: 'gpt-oss:120b-cloud' },
  ],
}).agents;

async function boot(env: Record<string, string> = {}, o: { confirmFixtureSubscriptions?: boolean } = {}) {
  const repo = makeRepo();
  const cfg = makeConfig(repo);

  const log = path.join(tmpDir('oclog'), 'fake.jsonl');
  const fixtureDir = tmpDir('ocbin');
  const binary = path.join(fixtureDir, 'opencode');
  const controls = Object.fromEntries(Object.entries({ ...process.env, FAKE_OPENCODE_LOG: log, FAKE_OPENCODE_TOKEN_MS: '2', ...env }).filter(([key]) => key.startsWith('FAKE_OPENCODE_')));
  fs.writeFileSync(binary, `#!/usr/bin/env node\n// SPDX-License-Identifier: Apache-2.0\nObject.assign(process.env, ${JSON.stringify(controls)});\nawait import(${JSON.stringify(pathToFileURL(OC_FIXTURE).href)});\n`, { mode: 0o700 });
  const metadata = http.createServer(async (req, res) => {
    const response = await net()(`http://127.0.0.1${req.url}`);
    res.writeHead(response.status, { 'content-type': 'application/json' }).end(await response.text());
  });
  await new Promise<void>((resolve) => metadata.listen(0, '127.0.0.1', resolve));
  metadataServers.push(metadata);
  const base_url = `http://127.0.0.1:${(metadata.address() as import('node:net').AddressInfo).port}`;
  cfg.agents.push(...agents(repo).map((a) => ({ ...a, binary, ...(a.provider === 'ollama' || a.provider === 'ollama-cloud' ? { base_url } : {}) })));
  h = await startDaemon(cfg, { fetch: net(), baseEnv: { ...process.env, FAKE_OPENCODE_LOG: log, ACC_SECRET_OPENROUTER: KEY, ...env }, ...o });
  const { d } = h;
  await waitFor(() => ['oc', 'ocr', 'occ'].every((id) => d.state.agents[id].probedAt), 20_000, 'probes');
  const requests = (): { kind: string; method?: string; path?: string; body?: Record<string, unknown>; [k: string]: unknown }[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const job = async (agentId: string, title: string, description = '') => {
    const item = d.createIssue({ title, description });
    await waitFor(() => d.state.workItems[item.id].key, 5000, 'tracker key');
    return { item, a: d.createAssignment({ workItemId: item.id, agentId, allowedPaths: ['notes/**', 'src/**'] }) };
  };
  return { d, repo, requests, job, log };
}

describe('OpenCode harness (loopback protocol fixture)', () => {
  it('runs a normal turn: typed events, live text, usage, handoff, isolated config, password and keys never leak', async () => {
    const { d, requests, job } = await boot({ FAKE_OPENCODE_TOKEN_MS: '250' });
    const live: string[] = [];
    d.bus.on('live', (m: { role: string; text: string }) => m.role === 'assistant' && live.push(m.text));
    expect(d.state.agents.oc.billing.mode).toBe('local');
    expect(d.state.agents.oc.models.available.find((m) => m.id === 'qwen3-coder:30b')).toMatchObject({ tools: true });
    const { item, a } = await job('oc', 'Local OpenCode task');
    const r = await d.dispatch(a.id);
    expect(r.preflight.ok).toBe(true);
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 30_000, 'handoff');
    const run = d.state.runs[r.runId!];
    expect(run).toMatchObject({ adapter: 'opencode-server', state: 'finished', resolvedModel: 'ollama/qwen3-coder:30b' });
    expect(run.sessionId).toMatch(/^ses_/);
    expect(run.usage).toMatchObject({ inputTokens: 120, outputTokens: 35 });
    expect(run.handoff).toMatchObject({ done: 'fixture basic complete', source: 'final_message' });
    const events = d.store.list({ runId: run.id });
    expect(events.some((e) => e.type === 't.command' && e.data.command === 'node --test' && e.data.exitCode === 0)).toBe(true);
    expect(events.some((e) => e.type === 't.test_result' && e.data.counts.passed === 2)).toBe(true);
    expect(events.filter((e) => e.type === 't.message' && e.data.role === 'assistant' && e.data.text.includes('### Handoff'))).toHaveLength(1);
    // Full live text streamed through the existing live path, then cleared.
    const finalText = events.find((e) => e.type === 't.message' && e.data.role === 'assistant' && e.data.text.includes('### Handoff'))!.data as { text: string };
    expect(live.some((t) => t && t !== finalText.text && finalText.text.startsWith(t))).toBe(true); // a growing prefix of the final message
    expect(live.at(-1)).toBe('');
    expect(fs.existsSync(path.join(h!.dataDir, 'runs', run.id, 'live.jsonl'))).toBe(false);

    const rq = requests();
    const start = rq.find((x) => x.kind === 'start')!;
    expect(start).toMatchObject({ passwordInArgv: false, projectConfigDisabled: true });
    expect(String(start.xdgData)).toContain(path.join('providers', 'oc', 'home', 'xdg-data'));
    expect(rq.find((x) => x.path?.endsWith('/prompt_async'))!.body).toMatchObject({ model: { providerID: 'ollama', modelID: 'qwen3-coder:30b' } });
    expect(rq.some((x) => x.kind === 'unauthorized')).toBe(false);
    // The per-run config holds no secret; the spec on disk holds no password.
    const runDir = path.join(h!.dataDir, 'runs', run.id);
    const cfgFile = path.join(runDir, 'opencode', 'opencode.json');
    expect(fs.statSync(cfgFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))).toMatchObject({ model: 'ollama/qwen3-coder:30b', enabled_providers: ['ollama'] });
    // The per-run server password (visible to the fixture only for this assertion) exists nowhere on disk.
    const password = String(start.password);
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of walk(runDir)) expect(fs.readFileSync(f, 'utf8'), f).not.toContain(password);
    expect(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8')).not.toContain('PASSWORD');
    expect(d.egress.log.every((x) => x.allowed)).toBe(true);
  }, 60_000);

  it('API key providers: the Keychain/env key reaches only the OpenCode process, never config, events or logs', async () => {
    const { d, requests, job } = await boot();
    expect(d.state.agents.ocr.billing.mode).toBe('metered');
    const { item, a } = await job('ocr', 'Router task');
    const r = await d.dispatch(a.id);
    expect(r.preflight.checks.find((c) => c.id === 'billing')).toMatchObject({ status: 'warn' });
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 30_000, 'handoff');
    expect(requests().find((x) => x.kind === 'start')!.keys).toMatchObject({ OPENROUTER_API_KEY: KEY, ANTHROPIC_API_KEY: null });
    const run = d.state.runs[r.runId!];
    const cfgText = fs.readFileSync(path.join(h!.dataDir, 'runs', run.id, 'opencode', 'opencode.json'), 'utf8');
    expect(cfgText).toContain('{env:OPENROUTER_API_KEY}');
    expect(cfgText).not.toContain(KEY);
    expect(JSON.stringify(d.store.list({ limit: 10_000 }))).not.toContain(KEY);
    expect(fs.readFileSync(path.join(h!.dataDir, 'runs', run.id, 'stdout.jsonl'), 'utf8')).not.toContain(KEY);
    expect(fs.readFileSync(path.join(h!.dataDir, 'runs', run.id, 'spec.json'), 'utf8')).not.toContain(KEY);
  }, 60_000);

  it('permission requests reach approvals before the action runs: policy auto-allows in-scope edits, a human decides the push', async () => {
    const { d, requests, job } = await boot();
    const { item, a } = await job('oc', 'Needs approval', '[fake:permission]');
    const r = await d.dispatch(a.id);
    const ap = await waitFor(() => Object.values(d.state.approvals).find((x) => x.runId === r.runId && !x.resolvedAt && x.kind === 'tool_permission'), 30_000, 'push approval');
    expect(ap.title).toContain('git push origin main');
    expect(d.state.runs[r.runId!].state).toBe('waiting-for-approval');
    // The push has not happened yet, and the in-scope edit was already allowed by policy.
    expect(requests().some((x) => x.kind === 'permission-decision' && x.permission === 'push')).toBe(false);
    expect(requests().find((x) => x.kind === 'permission-decision' && x.permission === 'edit')).toMatchObject({ response: 'once' });
    d.resolveApproval(ap.id, 'approve', 'web');
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 30_000, 'handoff');
    expect(requests().find((x) => x.kind === 'permission-decision' && x.permission === 'push')).toMatchObject({ response: 'once' }); // never "always"
    const events = d.store.list({ runId: r.runId! });
    expect(events.some((e) => e.type === 't.file_edit' && e.data.path === 'notes/oc.md')).toBe(true);
    expect(events.some((e) => e.type === 't.system' && e.data.text.includes('OpenCode approved'))).toBe(true);
  }, 60_000);

  it('a denied permission is relayed as a rejection', async () => {
    const { d, requests, job } = await boot();
    const { a } = await job('oc', 'Denied', '[fake:permission]');
    const r = await d.dispatch(a.id);
    const ap = await waitFor(() => Object.values(d.state.approvals).find((x) => x.runId === r.runId && !x.resolvedAt && x.kind === 'tool_permission'), 30_000, 'push approval');
    d.resolveApproval(ap.id, 'deny', 'web');
    await waitFor(() => requests().find((x) => x.kind === 'permission-decision' && x.permission === 'push'), 30_000, 'push decision');
    expect(requests().find((x) => x.kind === 'permission-decision' && x.permission === 'push')).toMatchObject({ response: 'reject' });
    await waitFor(() => d.state.runs[r.runId!].endedAt, 30_000, 'run ended');
  }, 60_000);

  it('a human question becomes an ask_human approval and the answer reaches the agent', async () => {
    const { d, requests, job } = await boot();
    const { item, a } = await job('oc', 'Needs an answer', '[fake:question]');
    const r = await d.dispatch(a.id);
    const ap = await waitFor(() => Object.values(d.state.approvals).find((x) => x.runId === r.runId && !x.resolvedAt && x.kind === 'ask_human'), 30_000, 'question');
    expect(ap.title).toContain('Which database should the service use?');
    expect(ap.options).toEqual(['sqlite', 'postgres']);
    d.resolveApproval(ap.id, 'postgres', 'web');
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 30_000, 'handoff');
    expect(requests().find((x) => x.kind === 'question-decision')).toMatchObject({ answer: 'postgres' });
    expect(d.store.list({ runId: r.runId!, types: ['t.message'] }).some((e) => e.type === 't.message' && e.data.text.includes('"postgres"'))).toBe(true);
  }, 60_000);

  it('a failed question reply fails the run without claiming the answer was delivered', async () => {
    const { d, requests, job } = await boot({ FAKE_OPENCODE_QUESTION_STATUS: '502' });
    const { a } = await job('oc', 'Failed answer delivery', '[fake:question]');
    const r = await d.dispatch(a.id);
    const ap = await waitFor(() => Object.values(d.state.approvals).find((x) => x.runId === r.runId && !x.resolvedAt && x.kind === 'ask_human'), 30_000, 'question');
    d.resolveApproval(ap.id, 'postgres', 'web');
    await waitFor(() => d.state.runs[r.runId!].endedAt, 30_000, 'failed run ended');
    expect(d.state.runs[r.runId!].state).toBe('failed');
    expect(requests().some((x) => x.path?.match(/^\/question\/[^/]+\/reply$/))).toBe(true);
    const transcript = JSON.stringify(d.store.list({ runId: r.runId! }));
    expect(transcript).toContain('OpenCode question reply failed (502)');
    expect(transcript).not.toContain('OpenCode question answered');
  }, 60_000);

  it('child sessions appear as child runs; their prose stays out of the transcript but their commands are recorded', async () => {
    const { d, job } = await boot();
    const { item, a } = await job('oc', 'Delegates', '[fake:child]');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 30_000, 'handoff');
    const run = d.state.runs[r.runId!];
    expect(run.children).toHaveLength(1);
    expect(run.children![0]).toMatchObject({ title: 'Explore the repository', state: 'completed', parentSessionId: run.sessionId });
    const events = d.store.list({ runId: run.id });
    expect(JSON.stringify(events)).not.toContain('CHILD PROSE');
    expect(events.some((e) => e.type === 't.command' && e.data.command === 'echo child-ran')).toBe(true);
    expect(run.usage.inputTokens).toBe(127); // 120 root + 7 child
  }, 60_000);

  it('stop aborts the OpenCode session truthfully; pause keeps it and resume continues the same session', async () => {
    const { d, requests, job } = await boot();
    const { a } = await job('oc', 'Long task', '[fake:hang]');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.runs[r.runId!].sessionId && d.state.runs[r.runId!].state === 'running', 30_000, 'running');
    const sid = d.state.runs[r.runId!].sessionId!;
    await d.runs.pause(r.runId!);
    await waitFor(() => d.state.runs[r.runId!].endedAt, 30_000, 'paused run recorded');
    const paused = d.state.runs[r.runId!];
    expect(paused.state).toBe('paused');
    expect(paused.exit).toMatchObject({ kind: 'stopped' });
    expect(requests().some((x) => x.method === 'POST' && x.path === `/session/${sid}/abort`)).toBe(true);
    const resumed = await d.runs.resume(r.runId!);
    await waitFor(() => d.state.runs[resumed].endedAt, 30_000, 'resumed run done');
    expect(d.state.runs[resumed]).toMatchObject({ sessionId: sid, state: 'finished' });
    expect(requests().some((x) => x.method === 'GET' && x.path === `/session/${sid}`)).toBe(true);
    expect(requests().filter((x) => x.path === `/session/${sid}/prompt_async`)).toHaveLength(2);
  }, 90_000);

  it('a plain stop ends the run as stopped and aborts the session', async () => {
    const { d, requests, job } = await boot();
    const { a } = await job('oc', 'Stop me', '[fake:hang]');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.runs[r.runId!].sessionId && d.state.runs[r.runId!].state === 'running', 30_000, 'running');
    await d.runs.stop(r.runId!, 'owner stop');
    await waitFor(() => d.state.runs[r.runId!].endedAt, 30_000, 'ended');
    expect(d.state.runs[r.runId!].exit).toMatchObject({ kind: 'stopped', message: 'owner stop' });
    expect(requests().some((x) => x.path?.endsWith('/abort'))).toBe(true);
  }, 60_000);

  it('a provider auth error from OpenCode fails the run as auth_expired', async () => {
    const { d, job } = await boot();
    const { a } = await job('oc', 'Bad key', '[fake:error]');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.runs[r.runId!].endedAt, 30_000, 'ended');
    expect(d.state.runs[r.runId!].exit).toMatchObject({ kind: 'auth_expired', message: expect.stringContaining('invalid api key') });
  }, 60_000);

  it('a network timeout fails the run, is retried once by resuming the same session, and then succeeds', async () => {
    const { d, job } = await boot();
    const { item, a } = await job('oc', 'Flaky network', '[fake:network]');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 40_000, 'handoff after retry');
    const runs = Object.values(d.state.runs).filter((x) => x.assignmentId === a.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ id: r.runId, exit: { kind: 'network' } });
    expect(runs[1]).toMatchObject({ attempt: 2, retryOf: runs[0].id, sessionId: runs[0].sessionId, state: 'finished' });
  }, 90_000);

  it('a served model that differs from the requested one raises a model alert', async () => {
    const { d, job } = await boot({ FAKE_OPENCODE_SERVED_MODEL: 'some-other-model' });
    const { a } = await job('oc', 'Mismatch');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.runs[r.runId!].endedAt, 30_000, 'ended');
    expect(Object.values(d.state.alerts).find((x) => x.kind === 'model' && x.message.includes('some-other-model'))).toBeTruthy();
    expect(d.state.runs[r.runId!].resolvedModel).toBe('ollama/some-other-model');
    expect(d.state.runs[r.runId!].state).toBe('failed');
  }, 60_000);

  it('secrets echoed by a tool are redacted before they reach any log or event', async () => {
    const { d, job } = await boot({ FAKE_OPENCODE_ECHO_KEY: '1' });
    const { item, a } = await job('ocr', 'Echo key');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 30_000, 'handoff');
    const dir = path.join(h!.dataDir, 'runs', r.runId!);
    expect(fs.readFileSync(path.join(dir, 'stdout.jsonl'), 'utf8')).not.toContain(KEY);
    expect(fs.readFileSync(path.join(dir, 'stdout.jsonl'), 'utf8')).toContain('REDACTED');
    expect(JSON.stringify(d.store.list({ limit: 10_000 }))).not.toContain(KEY);
  }, 60_000);

  it('daemon restart mid-run: reattaches to the live OpenCode run and stop still works', async () => {
    const { d, repo, job } = await boot();
    const dataDir = h!.dataDir;
    const cfg = d.config;
    const { a } = await job('oc', 'Survives restart', '[fake:hang]');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.runs[r.runId!].sessionId && d.state.runs[r.runId!].state === 'running', 30_000, 'running');
    const env = d.baseEnv();
    await d.shutdown();
    h = null;
    void repo;
    const d2 = new Daemon({ config: cfg, dataDir, allowTempDataDir: true, rulesTickMs: 3_600_000, outboxTickMs: 100, supervisorPollMs: 50, probe: false, baseEnv: env, fetch: net() });
    await d2.start();
    h = { d: d2, url: '', dataDir, close: async () => { await d2.setKillSwitch(true); await d2.shutdown(); } };
    const sys = d2.store.list({ runId: r.runId!, types: ['t.system'] }).map((e) => (e.data as { text: string }).text);
    expect(sys).toContain('daemon restarted: reattached to the live run');
    expect(d2.state.runs[r.runId!].sessionId).toMatch(/^ses_/);
    await d2.runs.stop(r.runId!, 'stop after restart');
    await waitFor(() => d2.state.runs[r.runId!].endedAt, 30_000, 'ended');
    expect(d2.state.runs[r.runId!].exit).toMatchObject({ kind: 'stopped' });
  }, 90_000);

  it('an unsupported OpenCode release is refused in pre-flight, before any run starts', async () => {
    process.env.FAKE_OPENCODE_VERSION = '9.9.9'; // read by the fixture's `--version` during the daemon's own probe
    try {
      const { d, job } = await boot();
      expect(d.state.agents.oc.auth.detail).toContain('not a supported protocol version');
      const { a } = await job('oc', 'Wrong release');
      await expect(d.dispatch(a.id)).rejects.toThrow(/not a supported protocol version/);
      expect(Object.values(d.state.runs).filter((x) => x.assignmentId === a.id)).toHaveLength(0);
    } finally {
      delete process.env.FAKE_OPENCODE_VERSION;
    }
  }, 60_000);

  it('a server that reports an unknown version at runtime fails visibly with a crash, never a guess', async () => {
    const { d, job } = await boot({ FAKE_OPENCODE_HEALTH_VERSION: '9.9.9' });
    const { a } = await job('oc', 'Server drift');
    const r = await d.dispatch(a.id);
    await waitFor(() => d.state.runs[r.runId!].endedAt, 30_000, 'ended');
    expect(d.state.runs[r.runId!].exit).toMatchObject({ kind: 'crash', message: expect.stringContaining('supported protocol version') });
  }, 60_000);

  it('Ollama cloud through a signed-in daemon is a subscription: owner overage confirmation gates dispatch', async () => {
    const { d, job } = await boot({}, { confirmFixtureSubscriptions: false });
    expect(d.state.agents.occ.billing).toMatchObject({ mode: 'subscription', overage: 'unknown' });
    expect(d.state.agents.occ.usage.status).toBe('unknown');
    expect(d.state.agents.occ.models.available.find((m) => m.id === 'gpt-oss:120b-cloud')).toMatchObject({ hidden: false });
    expect(d.state.agents.occ.models.available.find((m) => m.id === 'qwen3-coder:30b')).toMatchObject({ hidden: true }); // local model: wrong route
    const { item, a } = await job('occ', 'Cloud task');
    await expect(d.dispatch(a.id)).rejects.toThrow(/overage|paid/i);
    d.subscriptionSafety.confirm('occ', true);
    const r = await d.dispatch(a.id);
    expect(r.preflight.checks.find((c) => c.id === 'billing')).toMatchObject({ status: 'pass' });
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 30_000, 'handoff');
    expect(d.state.runs[r.runId!].usage.costUsd).toBeUndefined(); // never presented as metered spend
  }, 60_000);
});
