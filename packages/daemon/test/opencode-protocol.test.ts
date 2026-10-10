// SPDX-License-Identifier: Apache-2.0
// OpenCode protocol contract, pure: version pin, provider mapping (no key ever in config), the
// SSE-event mapper, the adapter's parser and its launch spec. Fixtures only; no OpenCode involved.
import { describe, expect, it } from 'vitest';
import { parseConfig, PolicySchema } from '@acc/core';
import { opencodeAdapter } from '../src/adapters/agents/opencode.ts';
import { EventMapper, SseParser, type OcEvent } from '../src/adapters/agents/opencode/events.ts';
import { buildOpencodeConfig, checkVersion, opencodeEnv, permissionToTool, providerSetup, SUPPORTED_SERIES, SUPPORTED_VERSIONS, permissionReply, serverEnvironment, assertServerContract } from '../src/adapters/agents/opencode/protocol.ts';
import type { LaunchContext, Parsed } from '../src/adapters/agents/types.ts';

const agent = (over: Record<string, unknown>) => parseConfig({ project: { name: 'p', repo: '/r' }, agents: [{ id: 'a', name: 'A', role: 'engineer', adapter: 'opencode-server', ...over }] }).agents[0];

describe('version pin', () => {
  it('accepts only the pinned release series and fails visibly otherwise', () => {
    expect(SUPPORTED_SERIES.length).toBeGreaterThan(0);
    expect(SUPPORTED_VERSIONS).toEqual(['1.18.35']);
    expect(checkVersion('1.18.35')).toMatchObject({ ok: true, series: '1.18' });
    for (const version of [null, '1.0.7', '1.18.34', '1.18.36', '1.18.35-dev', '1.18.35+custom', '9.9.9']) expect(checkVersion(version).ok).toBe(false);
    expect(checkVersion('9.9.9', { ACC_OPENCODE_SUPPORTED: '9.9' }).ok).toBe(false);
  });
});

describe('provider mapping and per-run config', () => {
  it('maps supported API/Ollama providers and never inlines a key', () => {
    const or = providerSetup(agent({ provider: 'openrouter', metered_opt_in: true }), 'anthropic/claude-sonnet-4.5');
    expect(or).toMatchObject({ providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4.5', envKey: 'OPENROUTER_API_KEY' });
    expect(JSON.stringify(or.provider)).toContain('{env:OPENROUTER_API_KEY}');
    expect(providerSetup(agent({ provider: 'anthropic-api', metered_opt_in: true }), 'm').envKey).toBe('ANTHROPIC_API_KEY');
    expect(providerSetup(agent({ provider: 'openai-api', metered_opt_in: true }), 'm').envKey).toBe('OPENAI_API_KEY');
    const local = providerSetup(agent({ provider: 'ollama' }), 'qwen3-coder:30b');
    expect(local).toMatchObject({ providerID: 'ollama', envKey: null, endpoint: 'http://127.0.0.1:11434' });
    expect(JSON.stringify(local.provider)).toContain('http://127.0.0.1:11434/v1');
    const daemon = providerSetup(agent({ provider: 'ollama-cloud' }), 'gpt-oss:120b-cloud');
    expect(daemon).toMatchObject({ providerID: 'ollama-cloud', envKey: null, endpoint: 'http://127.0.0.1:11434' });
    const api = providerSetup(agent({ provider: 'ollama-cloud', ollama_route: 'api' }), 'gpt-oss:120b');
    expect(api).toMatchObject({ envKey: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com' });
    expect(JSON.stringify(api.provider)).toContain('{env:OLLAMA_API_KEY}');
    expect(() => providerSetup(agent({ provider: 'ollama' }), 'newest')).toThrow(/concrete model/);
    expect(() => providerSetup(agent({ provider: 'lmstudio' }), 'unverified-model')).toThrow(/tool capabilities have not been verified/);
  });

  it('builds an isolated, ask-first config; credentials and storage never come from the user profile', () => {
    const { config } = buildOpencodeConfig({ agent: agent({ provider: 'ollama' }), model: 'qwen3-coder:30b', runDir: '/data/runs/r1', mcp: { command: '/usr/bin/node', args: ['mcp.ts', '/data/runs/r1'] } });
    expect(config).toMatchObject({ autoupdate: false, share: 'disabled', model: 'ollama/qwen3-coder:30b', enabled_providers: ['ollama'], permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' } });
    expect((config.mcp as Record<string, unknown>).acc).toMatchObject({ type: 'local', command: ['/usr/bin/node', 'mcp.ts', '/data/runs/r1'] });
    const env = opencodeEnv({ runDir: '/data/runs/r1', providerHome: '/data/providers/a/home', password: 'p'.repeat(48), offline: true });
    expect(env).toMatchObject({ XDG_DATA_HOME: '/data/providers/a/home/xdg-data', OPENCODE_CONFIG: '/data/runs/r1/opencode/opencode.json', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' });
  });

  it('routes permission requests through the existing tool policy vocabulary; unknown kinds always need a human', () => {
    expect(permissionToTool({ permission: 'bash', patterns: ['git *'], always: [], metadata: { command: 'git push origin main' } })).toMatchObject({ tool_name: 'Bash', input: { command: 'git push origin main' } });
    expect(permissionToTool({ permission: 'edit', metadata: { filepath: 'src/a.ts' } })).toMatchObject({ tool_name: 'Edit', input: { file_path: 'src/a.ts' } });
    expect(permissionToTool({ permission: 'webfetch', title: 'GET https://x' }).tool_name).toBe('OpenCode:webfetch');
    expect(permissionToTool({ permission: 'external_directory', pattern: '/etc/*' }).tool_name).toBe('OpenCode:external_directory');
  });
});

const ev = (type: string, properties: Record<string, unknown>): OcEvent => ({ type, properties });

describe('event mapper', () => {
  it('streams assistant text, keeps user and child prose out, records tools and usage, and finishes on idle', () => {
    const m = new EventMapper();
    m.setRoot('ses_root');
    const lines = (e: OcEvent) => m.handle(e);
    expect(lines(ev('message.part.updated', { part: { id: 'p0', sessionID: 'ses_root', messageID: 'u1', type: 'text', text: 'the prompt' } })).lines).toEqual([]); // role unknown: held
    lines(ev('message.updated', { info: { id: 'u1', sessionID: 'ses_root', role: 'user' } }));
    lines(ev('message.updated', { info: { id: 'a1', sessionID: 'ses_root', role: 'assistant' } }));
    expect(lines(ev('message.part.updated', { part: { id: 'p1', sessionID: 'ses_root', messageID: 'a1', type: 'text', text: 'Hel', time: { start: 1 } } })).lines).toEqual([{ t: 'delta', role: 'assistant', partId: 'p1', text: 'Hel' }]);
    expect(lines(ev('message.part.updated', { part: { id: 'p1', sessionID: 'ses_root', messageID: 'a1', type: 'text', text: 'Hello', time: { start: 1, end: 2 } } })).lines).toEqual([{ t: 'message', role: 'assistant', partId: 'p1', text: 'Hello' }]);
    // A repeated final update does not duplicate the message.
    expect(lines(ev('message.part.updated', { part: { id: 'p1', sessionID: 'ses_root', messageID: 'a1', type: 'text', text: 'Hello', time: { start: 1, end: 2 } } })).lines).toEqual([]);
    const tool = (status: string, extra: Record<string, unknown> = {}) => ev('message.part.updated', { part: { id: 't1', sessionID: 'ses_root', messageID: 'a1', type: 'tool', tool: 'bash', callID: 'c1', state: { status, input: { command: 'ls' }, ...extra } } });
    expect(lines(tool('pending')).lines).toEqual([]);
    expect(lines(tool('running')).lines).toMatchObject([{ t: 'tool', status: 'running', tool: 'bash', input: { command: 'ls' } }]);
    expect(lines(tool('completed', { output: 'a\n', metadata: { exit: 0 } })).lines).toMatchObject([{ t: 'tool', status: 'completed', output: 'a\n', exit: 0 }]);
    expect(lines(tool('completed', { output: 'a\n', metadata: { exit: 0 } })).lines).toEqual([]);
    // Child sessions: surfaced as children; prose ignored; their tool calls are still evidence.
    expect(lines(ev('session.created', { info: { id: 'ses_kid', parentID: 'ses_root', title: 'Explore' } })).lines).toEqual([{ t: 'child', sessionId: 'ses_kid', parentSessionId: 'ses_root', title: 'Explore', state: 'running' }]);
    lines(ev('message.updated', { info: { id: 'k1', sessionID: 'ses_kid', role: 'assistant' } }));
    expect(lines(ev('message.part.updated', { part: { id: 'kp', sessionID: 'ses_kid', messageID: 'k1', type: 'text', text: 'child prose', time: { end: 1 } } })).lines).toEqual([]);
    expect(lines(ev('session.idle', { sessionID: 'ses_kid' })).lines).toMatchObject([{ t: 'child', sessionId: 'ses_kid', state: 'completed' }]);
    expect(lines(ev('message.part.updated', { part: { id: 's1', sessionID: 'ses_root', messageID: 'a1', type: 'step-finish', tokens: { input: 10, output: 4, reasoning: 1 }, cost: 0.002 } })).lines).toEqual([{ t: 'usage', partId: 's1', input: 10, output: 5, costUsd: 0.002 }]);
    const fin = lines(ev('session.idle', { sessionID: 'ses_root' }));
    expect(fin.finished).toEqual({ ok: true });
    expect(lines(ev('session.idle', { sessionID: 'ses_root' })).finished).toBeUndefined();
  });

  it('turns permission and question requests into one action each, ignoring replays and foreign sessions', () => {
    const m = new EventMapper();
    m.setRoot('ses_root');
    const p = m.handle(ev('permission.asked', { id: 'per1', sessionID: 'ses_root', permission: 'bash', patterns: ['git *'], always: [], metadata: { command: 'rm -rf x' } }));
    expect(p.permission).toMatchObject({ id: 'per1', sessionID: 'ses_root' });
    expect(m.handle(ev('permission.updated', { id: 'per1', sessionID: 'ses_root', permission: 'bash', patterns: ['git *'], always: [] })).permission).toBeUndefined();
    expect(m.handle(ev('permission.asked', { id: 'per2', sessionID: 'someone_else', permission: 'bash', patterns: ['git *'], always: [] })).permission).toBeUndefined();
    const q = m.handle(ev('question.asked', { id: 'q1', sessionID: 'ses_root', questions: [{ question: 'Which?', header: 'DB', options: [{ label: 'a' }, { label: 'b' }] }] }));
    expect(q.question).toEqual({ id: 'q1', sessionID: 'ses_root', questions: [{ question: 'Which?', header: 'DB', options: ['a', 'b'] }] });
  });

  it('reports provider errors and aborts truthfully', () => {
    const m = new EventMapper();
    m.setRoot('r');
    const e = m.handle(ev('session.error', { sessionID: 'r', error: { name: 'ProviderAuthError', data: { message: 'bad key', statusCode: 401 } } }));
    expect(e.lines).toEqual([{ t: 'error', name: 'ProviderAuthError', message: 'bad key', status: 401 }]);
    expect(e.finished).toEqual({ ok: false, error: 'bad key' });
    const m2 = new EventMapper();
    m2.setRoot('r');
    m2.abortRequested = true;
    expect(m2.handle(ev('session.idle', { sessionID: 'r' })).finished).toMatchObject({ ok: false, aborted: true });
  });

  it('flushes a text part that never reported an end time as a complete message', () => {
    const m = new EventMapper();
    m.setRoot('r');
    m.handle(ev('message.updated', { info: { id: 'a', sessionID: 'r', role: 'assistant' } }));
    m.handle(ev('message.part.updated', { part: { id: 'p', sessionID: 'r', messageID: 'a', type: 'text', text: 'whole answer' } }));
    const done = m.handle(ev('session.idle', { sessionID: 'r' }));
    expect(done.lines).toEqual([{ t: 'message', role: 'assistant', partId: 'p', text: 'whole answer' }]);
    expect(done.finished).toEqual({ ok: true });
  });
});

describe('tagged SDK contract additions', () => {
  it('uses the documented permission body and refuses to auto-approve ambiguous scopes', () => {
    expect(permissionReply('per/test', true)).toEqual({ path: '/permission/per%2Ftest/reply', body: { reply: 'once' } });
    expect(permissionReply('per_test', false).body).toEqual({ reply: 'reject' });
    expect(permissionToTool({ permission: 'bash', patterns: ['git *'], metadata: {} }).tool_name).toBe('OpenCode:bash');
    expect(permissionToTool({ permission: 'edit', patterns: ['a.ts', 'b.ts'], metadata: { filePath: 'a.ts' } }).tool_name).toBe('OpenCode:edit');
  });

  it('reconstructs real message.part.delta events and de-duplicates their event IDs', () => {
    const m = new EventMapper(); m.setRoot('ses_root');
    m.handle({ id: 'evt_a', type: 'message.updated', properties: { info: { id: 'msg_a', sessionID: 'ses_root', role: 'assistant' } } });
    m.handle({ id: 'evt_p', type: 'message.part.updated', properties: { sessionID: 'ses_root', time: 1, part: { id: 'prt_a', sessionID: 'ses_root', messageID: 'msg_a', type: 'text', text: '', time: { start: 1 } } } });
    const delta: OcEvent = { id: 'evt_delta', type: 'message.part.delta', properties: { sessionID: 'ses_root', messageID: 'msg_a', partID: 'prt_a', field: 'text', delta: 'Hello' } };
    expect(m.handle(delta).lines).toEqual([{ t: 'delta', role: 'assistant', partId: 'prt_a', text: 'Hello' }]);
    expect(m.handle(delta).lines).toEqual([]);
    expect(m.handle({ ...delta, id: 'evt_more', properties: { ...delta.properties, delta: ' world' } }).lines[0]).toMatchObject({ text: 'Hello world' });
    expect(m.handle({ type: 'session.status', properties: { sessionID: 'ses_root', status: { type: 'idle' } } }).lines).toContainEqual({ t: 'message', role: 'assistant', partId: 'prt_a', text: 'Hello world' });
  });

  it('fails unknown deltas and model mismatch without a success result', () => {
    const m = new EventMapper(); m.setRoot('s');
    expect(m.handle({ type: 'message.part.delta', properties: { sessionID: 's', messageID: 'm', partID: 'p', field: 'text', delta: 'lost' } }).finished?.ok).toBe(false);
    const mismatch = new EventMapper(); mismatch.setRoot('s'); mismatch.expected = { providerID: 'ollama', modelID: 'chosen' };
    expect(mismatch.handle({ type: 'message.updated', properties: { info: { id: 'm', sessionID: 's', role: 'assistant', providerID: 'ollama', modelID: 'wrong' } } }).finished?.ok).toBe(false);
    expect(() => new SseParser().push('data: ' + 'x'.repeat(4 * 1024 * 1024))).toThrow(/exceeds/);
  });

  it('forwards one selected secret and pins offline/isolation controls against inherited overrides', () => {
    const isolated = opencodeEnv({ runDir: '/runs/r', providerHome: '/providers/a', password: 'p'.repeat(48), offline: true });
    const env = serverEnvironment({ PATH: '/bin', ...isolated, OPENROUTER_API_KEY: 'selected', ANTHROPIC_API_KEY: 'other', ACC_SECRET_JEV: 'jev', HTTP_PROXY: 'https://proxy.invalid', NODE_OPTIONS: '--require bad.js', OPENCODE_CONFIG_CONTENT: '{"plugin":["bad"]}', npm_config_offline: 'false', npm_config_registry: 'https://registry.npmjs.org' }, 'OPENROUTER_API_KEY');
    expect(env.OPENROUTER_API_KEY).toBe('selected');
    for (const key of ['ANTHROPIC_API_KEY', 'ACC_SECRET_JEV', 'HTTP_PROXY', 'NODE_OPTIONS', 'OPENCODE_CONFIG_CONTENT']) expect(env[key]).toBeUndefined();
    expect(env).toMatchObject({ OPENCODE_PURE: '1', OPENCODE_DISABLE_FFF: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9', HOME: '/runs/r/opencode/home', XDG_DATA_HOME: '/providers/a/xdg-data' });
    expect(() => serverEnvironment(isolated, 'UNVERIFIED_API_KEY')).toThrow(/Unsupported/);
    expect(() => assertServerContract({ openapi: '3.1.0', paths: {} })).toThrow(/capabilities/);
  });

  it('does not fabricate missing command exits or usage reports', () => {
    const p = opencodeAdapter.createParser({ agent: agent({ provider: 'ollama' }), runId: 'r', cwd: '/work' });
    expect(p.line('stdout', JSON.stringify({ t: 'tool', tool: 'bash', status: 'completed', input: { command: 'node --test' }, output: 'all okay' })).some((x) => x.kind === 'event' && x.type === 't.test_result')).toBe(false);
    expect(p.line('stdout', JSON.stringify({ t: 'usage' }))).toEqual([]);
    expect(p.line('stdout', JSON.stringify({ t: 'result', ok: false, error: 'Lost or invalid OpenCode event stream' }))).toContainEqual({ kind: 'failure', failure: { kind: 'crash', message: 'Lost or invalid OpenCode event stream' } });
  });
});

describe('SSE transport and replay', () => {
  it('reassembles frames split at any byte, multi-line data and CRLF', () => {
    const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const text = `: keep-alive\n\n${frame({ type: 'a', n: 1 })}event: x\r\ndata: {"type":\r\ndata: "b"}\r\n\r\n${frame({ type: 'c' })}`;
    for (const size of [1, 2, 3, 7, 1000]) {
      const p = new SseParser();
      const got: string[] = [];
      for (let i = 0; i < text.length; i += size) got.push(...p.push(text.slice(i, i + size)));
      expect(got.map((g) => (JSON.parse(g.replace(/\n/g, '')) as { type: string }).type), `chunk size ${size}`).toEqual(['a', 'b', 'c']);
    }
  });

  it('recorded event replay does not duplicate messages, tools, usage, permissions or children', () => {
    const m = new EventMapper();
    m.setRoot('r');
    const seq = [
      ev('message.updated', { info: { id: 'a', sessionID: 'r', role: 'assistant' } }),
      ev('message.part.updated', { part: { id: 'p', sessionID: 'r', messageID: 'a', type: 'text', text: 'done', time: { end: 1 } } }),
      ev('message.part.updated', { part: { id: 't', sessionID: 'r', messageID: 'a', type: 'tool', tool: 'bash', callID: 'c', state: { status: 'completed', input: { command: 'ls' }, output: 'x', metadata: { exit: 0 } } } }),
      ev('message.part.updated', { part: { id: 's', sessionID: 'r', messageID: 'a', type: 'step-finish', tokens: { input: 1, output: 1, reasoning: 0 } } }),
      ev('session.created', { info: { id: 'k', parentID: 'r', title: 'kid' } }),
      ev('permission.asked', { id: 'per', sessionID: 'r', permission: 'bash', patterns: ['git *'], always: [] }),
    ];
    const first = seq.flatMap((e) => m.handle(e).lines);
    const second = seq.flatMap((e) => { const x = m.handle(e); return [...x.lines, ...(x.permission ? [x.permission] : [])]; });
    expect(first.length).toBe(4);
    expect(second).toEqual([]);
  });

  it('reports a model other than the requested one, once, and never switches silently', () => {
    const m = new EventMapper();
    m.setRoot('r');
    m.expected = { providerID: 'ollama', modelID: 'qwen3-coder:30b' };
    const a = m.handle(ev('message.updated', { info: { id: 'a', sessionID: 'r', role: 'assistant', providerID: 'ollama', modelID: 'llama3' } }));
    expect(a.lines).toEqual([{ t: 'model_mismatch', requested: 'ollama/qwen3-coder:30b', served: 'ollama/llama3' }]);
    expect(m.handle(ev('message.updated', { info: { id: 'b', sessionID: 'r', role: 'assistant', providerID: 'ollama', modelID: 'llama3' } })).lines).toEqual([]);
    const m2 = new EventMapper();
    m2.setRoot('r');
    m2.expected = { providerID: 'ollama', modelID: 'x' };
    expect(m2.handle(ev('message.updated', { info: { id: 'a', sessionID: 'r', role: 'assistant', providerID: 'ollama', modelID: 'x' } })).lines).toEqual([]);
  });
});

describe('adapter', () => {
  const cfg = agent({ provider: 'ollama', model: 'qwen3-coder:30b' });
  const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({ agent: cfg, binary: '/bin/opencode', runId: 'run_1', attempt: 1, model: 'qwen3-coder:30b', effort: null, prompt: 'do it', cwd: '/work/tree', gitCommonDir: null, runDir: '/data/runs/run_1', mcp: { command: '/usr/bin/node', args: ['mcp.ts', '/data/runs/run_1'] }, resume: null, policies: PolicySchema.parse({}), allowedTools: [], providerHome: '/data/providers/a/home', ...over });
  const parse = (lines: object[], stream: 'stdout' | 'live' = 'stdout'): Parsed[] => {
    const p = opencodeAdapter.createParser({ agent: cfg, runId: 'r', cwd: '/work/tree' });
    return lines.flatMap((l) => p.line(stream, JSON.stringify(l)));
  };

  it('declares honest capabilities and builds a launch with the password only in the environment', () => {
    expect(opencodeAdapter.capabilities).toEqual({ headless: true, streamingInput: true, resume: true, hostApprovals: true, mcp: true });
    const spec = opencodeAdapter.buildLaunch(ctx());
    expect(spec.args.join(' ')).not.toMatch(/PASSWORD|[0-9a-f]{48}/);
    expect(spec.env!.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(opencodeAdapter.buildLaunch(ctx()).env!.OPENCODE_SERVER_PASSWORD).not.toBe(spec.env!.OPENCODE_SERVER_PASSWORD); // random per run
    expect(JSON.stringify(spec.files)).not.toContain(spec.env!.OPENCODE_SERVER_PASSWORD);
    const start = JSON.parse(spec.stdin.initial!) as { model: unknown; resume: unknown; binary: string };
    expect(start).toMatchObject({ binary: '/bin/opencode', model: { providerID: 'ollama', modelID: 'qwen3-coder:30b' }, resume: null });
    expect(spec.stdin).toMatchObject({ mode: 'stream', closeOnMatch: '"t":"result"' });
    expect(spec.files![0]).toMatchObject({ mode: 0o600 });
    expect(JSON.parse(opencodeAdapter.buildLaunch(ctx({ resume: { sessionId: 'ses_x', message: 'go on' } })).stdin.initial!)).toMatchObject({ resume: { sessionId: 'ses_x', message: 'go on' } });
    expect(JSON.parse(opencodeAdapter.encodeMessage!('hello'))).toEqual({ type: 'user', text: 'hello' });
  });

  it('parses the bridge stream into the same typed transcript events', () => {
    const out = parse([
      { t: 'ready', version: '1.18.35', protocol: 'opencode-server/2', port: 1 },
      { t: 'session', sessionId: 'ses_1', model: 'ollama/qwen3-coder:30b', resumed: false },
      { t: 'tool', callId: 'c1', tool: 'bash', status: 'running', input: { command: 'node --test' } },
      { t: 'tool', callId: 'c1', tool: 'bash', status: 'completed', input: { command: 'node --test' }, output: '# tests 2\n# pass 2\n# fail 0\n', exit: 0 },
      { t: 'tool', callId: 'c2', tool: 'edit', status: 'completed', input: { filePath: '/work/tree/src/a.ts' } },
      { t: 'tool', callId: 'c3', tool: 'task', status: 'running', input: { description: 'explore' } },
      { t: 'usage', partId: 's', input: 12, output: 5 },
      { t: 'child', sessionId: 'ses_k', parentSessionId: 'ses_1', title: 'Explore', state: 'running' },
      { t: 'permission', id: 'p', state: 'asked', tool: 'Bash', summary: 'bash git push' },
      { t: 'message', role: 'assistant', partId: 'p1', text: 'done\n### Handoff\nDone: x' },
      { t: 'result', ok: true },
    ]);
    expect(out).toContainEqual({ kind: 'session', sessionId: 'ses_1', model: 'ollama/qwen3-coder:30b' });
    expect(out).toContainEqual({ kind: 'event', type: 't.command', data: { callId: 'c1', command: 'node --test', status: 'started' } });
    expect(out.some((p) => p.kind === 'event' && p.type === 't.test_result' && p.data.counts.passed === 2)).toBe(true);
    expect(out).toContainEqual({ kind: 'event', type: 't.file_edit', data: { path: 'src/a.ts', change: 'modify' } });
    expect(out).toContainEqual({ kind: 'usage', inputTokens: 12, outputTokens: 5 });
    expect(out).toContainEqual({ kind: 'child', sessionId: 'ses_k', parentSessionId: 'ses_1', title: 'Explore', state: 'running', error: undefined });
    expect(out.find((p) => p.kind === 'final')).toMatchObject({ text: expect.stringContaining('### Handoff') });
    expect(out.at(-1)).toEqual({ kind: 'result', ok: true, text: 'done\n### Handoff\nDone: x' });
  });

  it('live deltas carry the whole message so far and are cleared when the full message lands', () => {
    const p = opencodeAdapter.createParser({ agent: cfg, runId: 'r', cwd: '/w' });
    expect(p.line('live', JSON.stringify({ t: 'delta', role: 'assistant', partId: 'p', text: 'Hello wor' }))).toEqual([{ kind: 'live', role: 'assistant', text: 'Hello wor' }]);
    const done = p.line('stdout', JSON.stringify({ t: 'message', role: 'assistant', partId: 'p', text: 'Hello world' }));
    expect(done).toContainEqual({ kind: 'live', role: 'assistant', text: '' });
  });

  it('classifies provider and version failures', () => {
    expect(parse([{ t: 'error', name: 'ProviderAuthError', message: 'bad key', status: 401 }, { t: 'result', ok: false }])).toContainEqual({ kind: 'failure', failure: { kind: 'auth_expired', message: 'bad key' } });
    expect(parse([{ t: 'error', name: 'APIError', message: 'slow down', status: 429 }])).toContainEqual({ kind: 'failure', failure: { kind: 'usage_limit', message: 'slow down' } });
    expect(parse([{ t: 'error', name: 'UnsupportedVersion', message: 'OpenCode 9.9 is not a supported protocol version' }])).toContainEqual({ kind: 'failure', failure: { kind: 'crash', message: expect.stringContaining('supported protocol version') } });
    const p = opencodeAdapter.createParser({ agent: cfg, runId: 'r', cwd: '/w' });
    expect(p.end({ code: 1, signal: null })).toContainEqual({ kind: 'result', ok: false, text: '' }); // died without a result line
  });
});
