// SPDX-License-Identifier: Apache-2.0
// Agent adapter contract. Parsers run against REAL vendor streams captured from the installed
// CLIs (sanitized, test/fixtures/real) plus the probe commands against the fake CLIs. A new
// vendor = implement VendorAdapter, add a fixture, add a case here.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, PolicySchema } from '@acc/core';
import { claudeAdapter } from '../src/adapters/agents/claude.ts';
import { codexAdapter } from '../src/adapters/agents/codex.ts';
import { cursorAdapter } from '../src/adapters/agents/cursor.ts';
import { genericAdapter, fillTemplate } from '../src/adapters/agents/generic.ts';
import type { LaunchContext, Parsed, VendorAdapter } from '../src/adapters/agents/types.ts';
import { FAKE_BIN } from './helpers.ts';

const REAL = path.join(import.meta.dirname, 'fixtures', 'real');
const cfg = parseConfig({
  project: { name: 'p', repo: '/r' },
  agents: [
    { id: 'claude', name: 'Claude', role: 'engineer', adapter: 'claude-headless' },
    { id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' },
    { id: 'cursor', name: 'Cursor', role: 'engineer', adapter: 'cursor-agent-cli', allow_shell: false },
    { id: 'gem', name: 'Gemini', role: 'researcher', adapter: 'generic-cli', command: 'gemini', args: ['-p', '{prompt}', '-m', '{model}', '-o', 'text'] },
  ],
});

function parseFixture(adapter: VendorAdapter, file: string, cwd = '/work/smoke'): Parsed[] {
  const p = adapter.createParser({ agent: cfg.agents[0], runId: 'r', cwd });
  const out: Parsed[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) out.push(...p.line('stdout', line));
  out.push(...p.end({ code: 0, signal: null }));
  return out;
}

const kinds = (ps: Parsed[], k: Parsed['kind']) => ps.filter((p) => p.kind === k);

describe.each([
  { name: 'claude-headless', adapter: claudeAdapter, file: 'claude.jsonl', session: '00000000-0000-4000-8000-00000000c1a0' },
  { name: 'codex-cli', adapter: codexAdapter, file: 'codex.jsonl', session: '00000000-0000-4000-8000-00000000c0de' },
  { name: 'cursor-agent-cli', adapter: cursorAdapter, file: 'cursor.jsonl', session: '00000000-0000-4000-8000-0000000c0450' },
])('adapter contract on a real $name stream', ({ adapter, file, session }) => {
  const parsed = parseFixture(adapter, path.join(REAL, file));

  it('reports the session, the final answer and success', () => {
    expect(kinds(parsed, 'session')[0]).toMatchObject({ sessionId: session });
    expect(kinds(parsed, 'final').at(-1)).toMatchObject({ text: 'OK' });
    expect(kinds(parsed, 'result')).toEqual([{ kind: 'result', ok: true, text: 'OK' }]);
    expect(kinds(parsed, 'failure')).toEqual([]);
  });

  it('reports token usage', () => {
    const u = kinds(parsed, 'usage') as Extract<Parsed, { kind: 'usage' }>[];
    expect(u.length).toBeGreaterThan(0);
    expect(u[0].outputTokens).toBeGreaterThan(0);
  });

  it('emits an assistant message event', () => {
    expect(parsed.some((p) => p.kind === 'event' && p.type === 't.message' && p.data.text === 'OK')).toBe(true);
  });
});

describe('vendor specifics from real streams', () => {
  it('claude: subscription session, plan usage windows, served-model mismatch', () => {
    const parsed = parseFixture(claudeAdapter, path.join(REAL, 'claude.jsonl'));
    expect(kinds(parsed, 'session')[0]).toMatchObject({ apiKeySource: 'none', model: 'claude-haiku-4-5-20251001' });
    const plan = kinds(parsed, 'plan_usage')[0] as Extract<Parsed, { kind: 'plan_usage' }>;
    expect(plan.usage.windows.map((w) => [w.name, w.usedPercent])).toEqual([['5h window', 50], ['7d window', 50]]);
    expect(plan.overage).toEqual({ enabled: false, inUse: false });
    expect(kinds(parsed, 'session')[1]).toMatchObject({ modelMismatch: { requested: 'claude-haiku-4-5-20251001', served: 'claude-sonnet-5-5' } });
  });

  it('claude: overage in use and a hard limit are both detected', () => {
    const line = fs.readFileSync(path.join(REAL, 'claude.jsonl'), 'utf8').split('\n').find((l) => l.includes('rate_limit_event'))!;
    const ev = JSON.parse(line);
    const p = claudeAdapter.createParser({ agent: cfg.agents[0], runId: 'r', cwd: '/' });
    ev.rate_limit_info = { ...ev.rate_limit_info, status: 'rejected', overageStatus: 'allowed', isUsingOverage: true };
    expect(p.line('stdout', JSON.stringify(ev)).find((x) => x.kind === 'plan_usage')).toMatchObject({ overage: { enabled: true, inUse: true } });
    ev.rate_limit_info = { ...ev.rate_limit_info, status: 'rejected', overageStatus: 'disabled', isUsingOverage: false, overageInUse: false };
    expect(p.line('stdout', JSON.stringify(ev)).find((x) => x.kind === 'failure')).toMatchObject({ failure: { kind: 'usage_limit' } });
  });

  it('codex: a non-fatal error item is shown but does not fail the run', () => {
    const parsed = parseFixture(codexAdapter, path.join(REAL, 'codex.jsonl'));
    expect(parsed.some((p) => p.kind === 'event' && p.type === 't.error')).toBe(true);
    expect(kinds(parsed, 'result')).toEqual([{ kind: 'result', ok: true, text: 'OK' }]);
  });

  it('cursor: login-based session', () => {
    expect(kinds(parseFixture(cursorAdapter, path.join(REAL, 'cursor.jsonl')), 'session')[0]).toMatchObject({ apiKeySource: 'login' });
  });
});

const ctx = (agent: (typeof cfg.agents)[number], over: Partial<LaunchContext> = {}): LaunchContext => ({
  agent,
  binary: '/bin/x',
  runId: 'r',
  attempt: 1,
  model: 'm1',
  effort: 'high',
  prompt: 'do it',
  cwd: '/wt',
  gitCommonDir: '/repo/.git',
  runDir: '/runs/r',
  mcp: { command: 'node', args: ['mcp.ts', '/runs/r'] },
  resume: null,
  policies: PolicySchema.parse({}),
  allowedTools: ['Read', 'Bash(git status:*)'],
  providerHome: null,
  ...over,
});

describe('launch specs', () => {
  it('claude: headless stream-json, approvals routed to us, isolated MCP, git dir writable', () => {
    const s = claudeAdapter.buildLaunch(ctx(cfg.agents[0]));
    expect(s.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--strict-mcp-config', '--permission-prompt-tool', 'mcp__acc__permission_prompt', '--add-dir', '/repo/.git', '--model', 'm1', '--effort', 'high']));
    expect(s.stdin).toMatchObject({ mode: 'stream', closeOnMatch: '"type":"result"' });
    const tools=s.args[s.args.indexOf('--allowedTools')+1].split(',');
    expect(tools).toEqual(expect.arrayContaining(['get_project_context','get_design_mock','submit_design_review','call_connector_tool','get_connector_tool_result'].map(t=>`mcp__acc__${t}`)));
    expect(tools).not.toContain('mcp__acc__*');
    expect(JSON.parse(s.stdin.initial!).message.content[0].text).toBe('do it');
    expect(claudeAdapter.buildLaunch(ctx(cfg.agents[0], { resume: { sessionId: 's1', message: 'go on' } })).args).toEqual(expect.arrayContaining(['--resume', 's1']));
  });

  it('codex: exec --json, workspace-write sandbox, user config ignored, approvals never, git dir writable', () => {
    const s = codexAdapter.buildLaunch(ctx(cfg.agents[1]));
    expect(s.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(s.args).toEqual(expect.arrayContaining(['-s', 'workspace-write', '-C', '/wt', '--add-dir', '/repo/.git', '--ignore-user-config', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="high"', '-c', 'mcp_servers.acc.command="node"']));
    expect(s.args.at(-1)).toBe('-');
    expect(s.stdin).toEqual({ mode: 'close', initial: 'do it' });
    const r = codexAdapter.buildLaunch(ctx(cfg.agents[1], { resume: { sessionId: 'thread-1', message: 'continue' } }));
    expect(r.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(r.args.slice(-2)).toEqual(['thread-1', '-']);
    expect(r.args).toContain('sandbox_workspace_write.writable_roots=["/repo/.git"]');
  });

  it('cursor: print mode in the worktree, no --force when shell is not allowed, MCP config file', () => {
    const s = cursorAdapter.buildLaunch(ctx(cfg.agents[2]));
    expect(s.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--trust', '--workspace', '/wt', '--approve-mcps', '--model', 'm1']));
    expect(s.args).not.toContain('--force');
    expect(s.args.at(-1)).toBe('do it');
    expect(s.files?.[0].path).toBe('/wt/.cursor/mcp.json');
  });

  it('generic: template filling drops unset flag pairs', () => {
    expect(fillTemplate(['-p', '{prompt}', '-m', '{model}'], { prompt: 'hi', model: null })).toEqual(['-p', 'hi']);
    expect(genericAdapter.buildLaunch(ctx(cfg.agents[3], { model: 'gemini-pro' })).args).toEqual(['-p', 'do it', '-m', 'gemini-pro', '-o', 'text']);
  });
});

describe('probes against the vendor CLIs (fake binaries)', () => {
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, ...extra });
  it('auth, billing and models', async () => {
    const claude = { binary: path.join(FAKE_BIN, 'claude'), agent: cfg.agents[0], env: env() };
    expect(await claudeAdapter.authStatus(claude)).toMatchObject({ state: 'logged_in' });
    expect(await claudeAdapter.billingMode(claude)).toMatchObject({ mode: 'subscription', overage: 'unknown' });
    expect(await claudeAdapter.authStatus({ ...claude, env: env({ FAKE_LOGGED_OUT: '1' }) })).toMatchObject({ state: 'expired', fix: expect.stringContaining('claude auth login') });
    const codex = { binary: path.join(FAKE_BIN, 'codex'), agent: cfg.agents[1], env: env() };
    expect(await codexAdapter.billingMode(codex)).toMatchObject({ mode: 'subscription' });
    expect(await codexAdapter.billingMode({ ...codex, env: env({ FAKE_AUTH_METHOD: 'api' }) })).toMatchObject({ mode: 'metered' });
    expect((await codexAdapter.listModels(codex)).filter((m) => !m.hidden).map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']);
    const cursor = { binary: path.join(FAKE_BIN, 'cursor-agent'), agent: cfg.agents[2], env: env() };
    expect(await cursorAdapter.authStatus(cursor)).toMatchObject({ state: 'logged_in', tier: 'Pro' });
    expect(await cursorAdapter.billingMode(cursor)).toMatchObject({ mode: 'subscription', overage: 'unknown' });
    expect(await cursorAdapter.billingMode({ ...cursor, env: env({ CURSOR_API_KEY: 'k' }) })).toMatchObject({ mode: 'metered' });
    expect((await cursorAdapter.listModels(cursor)).map((m) => m.id)).toContain('claude-opus-5-thinking-high');
  });
});
