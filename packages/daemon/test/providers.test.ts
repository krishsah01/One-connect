// SPDX-License-Identifier: Apache-2.0
// Bring-your-own-model connections and the egress guard (nothing leaves except to chosen providers).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@acc/core';
import { estimateCost, probeProvider } from '../src/adapters/agents/providers.ts';
import { allowedHosts, createEgress, EgressDenied } from '../src/egress.ts';
import { FAKE_BIN, makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

const KEY = 'sk-or-v1-test0000000000000000000000000000';

/** A fake network: local Ollama + OpenRouter, and nothing else. */
function fakeNet(calls: string[] = []) {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === '127.0.0.1:11434') {
      if (u.pathname === '/api/version') return ok({ version: '0.34.1' });
      if (u.pathname === '/api/tags') return ok({ models: [{ name: 'qwen3-coder:30b', details: { parameter_size: '30B' } }, { name: 'dolphin-mistral:latest', details: { parameter_size: '7B' } }, { name: 'gpt-oss:120b-cloud' }] });
      if (u.pathname === '/api/show') {
        const m = JSON.parse(String(init?.body)).model as string;
        return ok({ capabilities: m.startsWith('dolphin') ? ['completion'] : ['completion', 'tools'] });
      }
    }
    if (u.host === 'openrouter.ai') {
      if (u.pathname === '/api/v1/models') return ok({ data: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', pricing: { prompt: '0.001', completion: '0.001' }, supported_parameters: ['tools'] }, { id: 'some/no-tools', supported_parameters: [] }, { id: 'meta/llama-free:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] });
      if (u.pathname === '/api/v1/key') return ok({ data: { usage: 3.2, limit: 10, usage_daily: 0.4 } });
    }
    return new Response('not found', { status: 404 });
  };
}

const base = (agents: unknown[], extra: Record<string, unknown> = {}) => parseConfig({ project: { name: 'p', repo: '/r' }, agents, ...extra });

describe('config', () => {
  it('derives billing from the provider and gates paid providers behind an explicit opt-in', () => {
    const c = base([{ id: 'local', name: 'L', role: 'engineer', adapter: 'codex-cli', provider: 'ollama', model: 'qwen3-coder:30b' }]);
    expect(c.agents[0].billing).toBe('local');
    expect(() => base([{ id: 'r', name: 'R', role: 'engineer', adapter: 'codex-cli', provider: 'openrouter' }])).toThrow(/bills per token/);
    expect(() => base([{ id: 'a', name: 'A', role: 'engineer', adapter: 'cursor-agent-cli', provider: 'anthropic-api', metered_opt_in: true }])).toThrow(/runs through opencode-server or claude-headless/);
    expect(base([{ id: 'a', name: 'A', role: 'engineer', adapter: 'claude-headless', provider: 'anthropic-api', metered_opt_in: true, budget_usd_per_day: 5 }]).agents[0].billing).toBe('metered');
  });
});

describe('egress guard', () => {
  it('only allows hosts of configured connections', async () => {
    const cfg = base(
      [
        { id: 'local', name: 'L', role: 'engineer', adapter: 'codex-cli', provider: 'ollama' },
        { id: 'r', name: 'R', role: 'engineer', adapter: 'codex-cli', provider: 'openrouter', metered_opt_in: true },
      ],
      { tracker: { type: 'linear', team: 'ENG' } },
    );
    expect(allowedHosts(cfg).sort()).toEqual(['127.0.0.1', '127.0.0.1:11434', 'api.linear.app', 'localhost', 'openrouter.ai']);
    const eg = createEgress(cfg, fakeNet());
    await expect(eg.fetch('https://telemetry.example.com/collect')).rejects.toBeInstanceOf(EgressDenied);
    await expect(eg.fetch('https://api.openai.com/v1/models')).rejects.toBeInstanceOf(EgressDenied); // not configured
    expect((await eg.fetch('http://127.0.0.1:11434/api/version')).ok).toBe(true);
    expect(eg.log.map((l) => [l.host, l.allowed])).toEqual([
      ['telemetry.example.com', false],
      ['api.openai.com', false],
      ['127.0.0.1:11434', true],
    ]);
  });

  it('a subscription-only setup can reach nothing but itself', () => {
    expect(allowedHosts(base([{ id: 'c', name: 'C', role: 'engineer', adapter: 'claude-headless' }])).sort()).toEqual(['127.0.0.1', 'localhost']);
  });
});

describe('provider probes', () => {
  it('ollama: local, free, flags models that cannot call tools, marks cloud models', async () => {
    const c = base([{ id: 'l', name: 'L', role: 'engineer', adapter: 'codex-cli', provider: 'ollama' }]);
    const p = (await probeProvider(c.agents[0], fakeNet()))!;
    expect(p.auth).toMatchObject({ state: 'logged_in', detail: expect.stringContaining('Ollama 0.34.1') });
    expect(p.billing).toMatchObject({ mode: 'local', overage: 'off' });
    expect(p.models.find((m) => m.id === 'dolphin-mistral:latest')).toMatchObject({ tools: false, hidden: true });
    expect(p.models.find((m) => m.id === 'qwen3-coder:30b')).toMatchObject({ tools: true, pricing: { input: 0, output: 0 } });
    expect(p.models.find((m) => m.id === 'gpt-oss:120b-cloud')?.label).toContain('Ollama cloud');
  });

  it('ollama not running → actionable fix', async () => {
    const c = base([{ id: 'l', name: 'L', role: 'engineer', adapter: 'codex-cli', provider: 'ollama', base_url: 'http://127.0.0.1:9' }]);
    const p = (await probeProvider(c.agents[0], async () => {
      throw new Error('ECONNREFUSED');
    }))!;
    expect(p.auth).toMatchObject({ state: 'expired', fix: expect.stringContaining('Start Ollama') });
  });

  it('openrouter: needs a key; lists only tool-capable models with prices; reads key usage', async () => {
    const c = base([{ id: 'r', name: 'R', role: 'engineer', adapter: 'codex-cli', provider: 'openrouter', metered_opt_in: true }]);
    expect((await probeProvider(c.agents[0], fakeNet(), {}))!.auth.state).toBe('expired');
    const p = (await probeProvider(c.agents[0], fakeNet(), { ACC_SECRET_OPENROUTER: KEY }))!;
    expect(p.billing.mode).toBe('metered');
    expect(p.models.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4.5', 'meta/llama-free:free']);
    expect(p.models[0].pricing).toEqual({ input: 1000, output: 1000 });
    expect(p.models[1].label).toContain('free');
    expect(p.usage.windows[0]).toMatchObject({ usedPercent: 32 });
    expect(p.usage.source).toContain('$0.40 today');
  });

  it('estimates cost only for metered connections', () => {
    const c = base([
      { id: 'r', name: 'R', role: 'engineer', adapter: 'codex-cli', provider: 'openrouter', metered_opt_in: true },
      { id: 'l', name: 'L', role: 'engineer', adapter: 'codex-cli', provider: 'ollama' },
    ]);
    const inv = [{ id: 'm', pricing: { input: 3, output: 15 } }];
    expect(estimateCost(c.agents[0], 'm', { inputTokens: 1_000_000, outputTokens: 100_000 }, inv)).toBeCloseTo(4.5);
    expect(estimateCost(c.agents[0], 'm', { inputTokens: 1, outputTokens: 1 }, inv, 0.25)).toBe(0.25);
    expect(estimateCost(c.agents[1], 'm', { inputTokens: 1_000_000, outputTokens: 0 }, inv)).toBeUndefined();
  });
});

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('BYO-model runs end to end', () => {
  it('local Ollama and OpenRouter agents: isolated homes, right flags, cost tracked, budget enforced, key never logged', async () => {
    const repo = makeRepo();
    const cfg = makeConfig(repo);
    cfg.agents.push(
      ...parseConfig({
        project: { name: 'x', repo },
        agents: [
          { id: 'local', name: 'Qwen local', role: 'engineer', adapter: 'codex-cli', provider: 'ollama', binary: path.join(FAKE_BIN, 'codex'), model: 'qwen3-coder:30b' },
          { id: 'router', name: 'Sonnet via OpenRouter', role: 'engineer', adapter: 'codex-cli', provider: 'openrouter', metered_opt_in: true, budget_usd_per_day: 1, binary: path.join(FAKE_BIN, 'codex'), model: 'anthropic/claude-sonnet-4.5' },
        ],
      }).agents,
    );
    h = await startDaemon(cfg, { fetch: fakeNet(), baseEnv: { ...process.env, ACC_SECRET_OPENROUTER: KEY } });
    const { d } = h;
    const job = async (agentId: string, title: string) => {
      const item = d.createIssue({ title });
      await waitFor(() => d.state.workItems[item.id].key, 5000);
      return { item, a: d.createAssignment({ workItemId: item.id, agentId, allowedPaths: ['notes/**'] }) };
    };

    const l = await job('local', 'Local model task');
    const r1 = await d.dispatch(l.a.id);
    expect(r1.preflight.checks.find((c) => c.id === 'billing')).toMatchObject({ status: 'pass', message: expect.stringContaining('no cost') });
    await waitFor(() => d.state.workItems[l.item.id].state === 'handoff_received', 20_000, 'local done');
    const lr = d.state.runs[r1.runId!];
    const spec = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'runs', lr.id, 'spec.json'), 'utf8')) as { args: string[] };
    expect(spec.args).toEqual(expect.arrayContaining(['--oss', '--local-provider', 'ollama', '-m', 'qwen3-coder:30b']));
    expect(d.store.list({ runId: lr.id, types: ['t.message'] }).some((e) => e.type === 't.message' && e.data.text === 'connection: local (ollama); CODEX_HOME=isolated')).toBe(true);
    expect(lr.usage.costUsd).toBeUndefined();

    const o = await job('router', 'Paid model task');
    const r2 = await d.dispatch(o.a.id);
    expect(r2.preflight.checks.find((c) => c.id === 'billing')).toMatchObject({ status: 'warn', message: expect.stringContaining('$0.00 of $1.00') });
    await waitFor(() => d.state.runs[r2.runId!].endedAt, 20_000, 'router done');
    const rr = d.state.runs[r2.runId!];
    const spec2 = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'runs', rr.id, 'spec.json'), 'utf8')) as { args: string[] };
    expect(spec2.args).toEqual(expect.arrayContaining(['model_provider="openrouter"', 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"']));
    expect(d.store.list({ runId: rr.id, types: ['t.message'] }).some((e) => e.type === 't.message' && e.data.text.startsWith('connection: OPENROUTER_API_KEY; CODEX_HOME=isolated'))).toBe(true);
    expect(rr.usage.costUsd).toBeCloseTo((1200 * 1000 + 340 * 1000) / 1_000_000); // fake usage × OpenRouter price
    expect(d.spentToday('router')).toBeGreaterThan(1);

    // Over the cap: the next dispatch is blocked by pre-flight.
    const o2 = await job('router', 'Another paid task');
    await expect(d.dispatch(o2.a.id)).rejects.toThrow(/Daily budget/);

    // The API key never reaches the event log or the run's durable logs.
    const all = JSON.stringify(d.store.list({ limit: 10_000 }));
    expect(all).not.toContain(KEY);
    expect(fs.readFileSync(path.join(h.dataDir, 'runs', rr.id, 'stdout.jsonl'), 'utf8')).not.toContain(KEY);
    // And the only network the daemon used was the configured providers.
    expect(d.egress.log.every((x) => x.allowed)).toBe(true);
  }, 90_000);
});
