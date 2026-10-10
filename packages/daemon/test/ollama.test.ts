// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Ollama both ways (local models; paid cloud models through a signed-in daemon or the cloud API with a
// Keychain key), honest states, billing/safety rules, egress and the harness catalog. Fixtures only.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultHarnessFor, isOllamaCloudModel, newAgentState, parseConfig, runPreflight, subscriptionGroup, type AgentState } from '@acc/core';
import { ollamaStatus } from '../src/adapters/agents/ollama.ts';
import { probeProvider } from '../src/adapters/agents/providers.ts';
import { allowedHosts, createEgress, EgressDenied } from '../src/egress.ts';
import { FAKE_BIN, makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
type Net = { signedIn?: boolean | 'unsupported'; down?: boolean; tags?: { name: string; details?: { parameter_size?: string } }[]; cloudKey?: string };
function net(o: Net = {}, calls: { url: string; auth?: string | null }[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url, auth });
    if (u.host === '127.0.0.1:11434') {
      if (o.down) throw new Error('ECONNREFUSED');
      if (u.pathname === '/api/version') return ok({ version: '0.34.1' });
      if (u.pathname === '/api/me') return o.signedIn === 'unsupported' ? ok({}, 404) : o.signedIn === false ? ok({ error: 'unauthorized', signin_url: 'https://ollama.com/connect' }, 401) : ok({ name: 'owner' });
      if (u.pathname === '/api/tags') return ok({ models: o.tags ?? [{ name: 'qwen3-coder:30b', details: { parameter_size: '30B' } }, { name: 'dolphin-mistral:latest' }, { name: 'gpt-oss:120b-cloud' }] });
      if (u.pathname === '/api/show') return ok({ capabilities: String(init?.body).includes('dolphin') ? ['completion'] : ['completion', 'tools'] });
    }
    if (u.host === 'ollama.com') {
      if (u.pathname === '/api/tags') return ok({ models: [{ name: 'gpt-oss:120b', capabilities: ['completion', 'tools'] }, { name: 'qwen3-coder:480b', capabilities: ['completion', 'tools'] }] });
      if (auth !== `Bearer ${o.cloudKey ?? 'ollama-key-0000000000'}`) return ok({ error: 'unauthorized' }, 401);
      if (u.pathname === '/api/me') return o.signedIn === 'unsupported' ? ok({}, 404) : ok({ name: 'owner' });
      if (u.pathname === '/api/show') return ok({ capabilities: ['completion', 'tools'] });
    }
    return new Response('nope', { status: 404 });
  };
}
const cfg = (agents: unknown[]) => parseConfig({ project: { name: 'p', repo: '/r' }, agents });
const local = { id: 'l', name: 'L', role: 'engineer', adapter: 'opencode-server', provider: 'ollama', model: 'qwen3-coder:30b' };
const cloud = { id: 'c', name: 'C', role: 'engineer', adapter: 'opencode-server', provider: 'ollama-cloud', model: 'gpt-oss:120b-cloud' };
const cloudApi = { ...cloud, id: 'k', ollama_route: 'api', model: 'gpt-oss:120b' };

describe('configuration', () => {
  it('OpenCode is the default harness for API and local providers; billing follows the provider', () => {
    for (const p of ['anthropic-api', 'openai-api', 'openrouter', 'ollama', 'ollama-cloud', 'lmstudio'] as const) expect(defaultHarnessFor(p)).toBe('opencode-server');
    const c = cfg([local, cloud, { ...local, id: 'oss', adapter: 'codex-cli' }]);
    expect(c.agents.map((a) => a.billing)).toEqual(['local', 'subscription', 'local']); // codex --oss stays available as an alternative
    expect(c.agents[1].metered_opt_in).toBe(false); // an Ollama plan is not per-token metering
  });

  it('keeps the local and cloud sides apart and refuses nonsense', () => {
    expect(isOllamaCloudModel('gpt-oss:120b-cloud')).toBe(true);
    expect(isOllamaCloudModel('qwen3-coder:30b')).toBe(false);
    expect(() => cfg([{ ...local, model: 'gpt-oss:120b-cloud' }])).toThrow(/use provider ollama-cloud/);
    expect(() => cfg([{ ...cloud, billing: 'local' }])).toThrow(/billed through your Ollama plan/);
    expect(() => cfg([{ ...local, ollama_route: 'api' }])).toThrow(/only applies to provider ollama-cloud/);
    expect(() => cfg([{ ...local, adapter: 'claude-headless' }])).toThrow(/runs through/);
    // Local servers are explicit loopback endpoints only; the cloud API route only accepts ollama.com.
    expect(cfg([{ ...local, base_url: 'http://localhost:11434' }]).agents).toHaveLength(1);
    expect(() => cfg([{ ...local, base_url: 'http://192.168.1.9:11434' }])).toThrow(/loopback/);
    expect(() => cfg([{ ...local, base_url: 'https://evil.example.com' }])).toThrow(/loopback/);
    expect(() => cfg([{ ...cloud, base_url: 'http://10.0.0.5:11434' }])).toThrow(/loopback/);
    expect(() => cfg([{ ...cloudApi, base_url: 'https://evil.example.com' }])).toThrow(/only accepts https:\/\/ollama.com/);
  });

  it('all Ollama cloud agents share one subscription capacity group', () => {
    const [a, b] = cfg([cloud, { ...cloudApi, id: 'k2' }]).agents;
    expect(subscriptionGroup(a)).toBe('ollama');
    expect(subscriptionGroup(b)).toBe('ollama');
    expect(subscriptionGroup(cfg([local]).agents[0])).toBeNull();
  });

  it('only the configured Ollama hosts are reachable (daemon route stays on loopback)', async () => {
    expect(allowedHosts(cfg([cloud])).sort()).toEqual(['127.0.0.1', '127.0.0.1:11434', 'localhost']);
    expect(allowedHosts(cfg([cloudApi])).sort()).toEqual(['127.0.0.1', 'localhost', 'ollama.com']);
    const eg = createEgress(cfg([local]), net());
    await expect(eg.fetch('https://ollama.com/api/tags')).rejects.toBeInstanceOf(EgressDenied);
  });
});

describe('Ollama states', () => {
  it('server not running', async () => {
    const st = await ollamaStatus(cfg([local]).agents[0], net({ down: true }));
    expect(st).toMatchObject({ route: 'local', state: 'server_not_running', fix: expect.stringContaining('Start Ollama'), models: [] });
    const p = (await probeProvider(cfg([local]).agents[0], net({ down: true })))!;
    expect(p.auth).toMatchObject({ state: 'expired' });
  });

  it('local models: free, tool support honest, cloud models set aside', async () => {
    const st = await ollamaStatus(cfg([local]).agents[0], net());
    expect(st.state).toBe('ready');
    expect(st.counts).toEqual({ local: 2, cloud: 1 });
    expect(st.models.find((m) => m.id === 'qwen3-coder:30b')).toMatchObject({ tools: true, hidden: false, pricing: { input: 0, output: 0 } });
    expect(st.models.find((m) => m.id === 'dolphin-mistral:latest')).toMatchObject({ tools: false, hidden: true, label: expect.stringContaining('no tool calling') });
    expect(st.models.find((m) => m.id === 'gpt-oss:120b-cloud')).toMatchObject({ hidden: true, label: expect.stringContaining('Ollama cloud') });
    const p = (await probeProvider(cfg([local]).agents[0], net()))!;
    expect(p.billing).toMatchObject({ mode: 'local', overage: 'off' });
    expect(p.auth.state).toBe('logged_in');
  });

  it('cloud through the daemon: not signed in → actionable; signed in → subscription with unknown usage', async () => {
    const agent = cfg([cloud]).agents[0];
    const out = await ollamaStatus(agent, net({ signedIn: false }));
    expect(out).toMatchObject({ state: 'not_signed_in', fix: expect.stringContaining('ollama signin'), models: [] });
    const pOut = (await probeProvider(agent, net({ signedIn: false })))!;
    expect(pOut.auth).toMatchObject({ state: 'expired', fix: expect.stringContaining('ollama signin') });
    const down = await ollamaStatus(agent, net({ down: true }));
    expect(down.state).toBe('server_not_running');

    const st = await ollamaStatus(agent, net());
    expect(st).toMatchObject({ state: 'ready', signedInAs: 'owner' });
    expect(st.models.filter((m) => !m.hidden).map((m) => m.id)).toEqual(['gpt-oss:120b-cloud']);
    const p = (await probeProvider(agent, net()))!;
    expect(p.billing).toMatchObject({ mode: 'subscription', overage: 'unknown', source: expect.stringContaining('signed-in local Ollama') });
    expect(p.usage).toMatchObject({ status: 'unknown', windows: [] });
    expect(p.auth.state).toBe('logged_in');
  });

  it('cloud through the daemon: an Ollama without sign-in introspection is "unknown", never "signed in"', async () => {
    const st = await ollamaStatus(cfg([cloud]).agents[0], net({ signedIn: 'unsupported' }));
    expect(st.state).toBe('sign_in_unknown');
    expect((await probeProvider(cfg([cloud]).agents[0], net({ signedIn: 'unsupported' })))!.auth.state).toBe('unknown');
  });

  it('no verified cloud models remain unselectable without pulling anything', async () => {
    const st = await ollamaStatus(cfg([cloud]).agents[0], net({ tags: [{ name: 'qwen3-coder:30b' }] }));
    expect(st).toMatchObject({ state: 'ready', fix: expect.stringContaining('never pulls models'), message: expect.stringContaining('No verified tool-capable models') });
  });

  it('public cloud catalogs cannot validate a key; unknown tools or auth stay hidden', async () => {
    const st = await ollamaStatus(cfg([cloudApi]).agents[0], net({ signedIn: 'unsupported' }), { ACC_SECRET_OLLAMA_CLOUD: 'ollama-key-0000000000' });
    expect(st.state).toBe('sign_in_unknown');
    expect(st.models.every((m) => m.hidden)).toBe(true);
    expect(st.models.every((m) => m.pricing === undefined)).toBe(true);
    const unknown = await ollamaStatus(cfg([local]).agents[0], async (url, init) => url.endsWith('/api/show') ? ok({}) : net()(url, init));
    expect(unknown.models.every((m) => m.hidden)).toBe(true);
    expect(unknown.models.find((m) => m.id === 'qwen3-coder:30b')?.tools).toBeUndefined();
  });

  it('validates origins before reading credentials or making a request, and refuses redirects', async () => {
    const calls: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => { calls.push(url); expect(init?.redirect).toBe('error'); return ok({ version: '0.34.1', models: [] }); };
    expect((await ollamaStatus({ provider: 'ollama-cloud', ollama_route: 'api', base_url: 'https://attacker.test' }, fetcher, { ACC_SECRET_OLLAMA_CLOUD: 'fixture-secret' })).state).toBe('error');
    expect((await ollamaStatus({ provider: 'ollama', base_url: 'http://192.168.1.5' }, fetcher)).state).toBe('error');
    expect(calls).toEqual([]);
    await ollamaStatus(cfg([local]).agents[0], fetcher);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('recognizes cloud metadata even on a renamed alias', async () => {
    const st = await ollamaStatus(cfg([local]).agents[0], async (url, init) => url.endsWith('/api/tags') ? ok({ models: [{ name: 'my-alias', remote_host: 'https://ollama.com', remote_model: 'gpt-oss:120b', capabilities: ['tools'] }] }) : net()(url, init));
    expect(st.models[0]).toMatchObject({ id: 'my-alias', hidden: true });
    expect(st.counts).toEqual({ local: 0, cloud: 1 });
  });

  it('cloud API: needs the Keychain key, rejects a bad one, lists models with the key', async () => {
    const agent = cfg([cloudApi]).agents[0];
    expect(await ollamaStatus(agent, net(), {})).toMatchObject({ route: 'api', state: 'key_missing', fix: expect.stringContaining('Connections') });
    expect(await ollamaStatus(agent, net(), { ACC_SECRET_OLLAMA_CLOUD: 'wrong-key-000000' })).toMatchObject({ state: 'key_rejected' });
    const calls: { url: string; auth?: string | null }[] = [];
    const st = await ollamaStatus(agent, net({}, calls), { ACC_SECRET_OLLAMA_CLOUD: 'ollama-key-0000000000' });
    expect(st).toMatchObject({ state: 'ready', route: 'api', base: 'https://ollama.com' });
    expect(st.models.map((m) => m.id)).toEqual(['gpt-oss:120b', 'qwen3-coder:480b']);
    expect(calls.every((c) => c.url.startsWith('https://ollama.com/'))).toBe(true);
    expect(calls.find((c) => c.url.endsWith('/api/tags'))?.auth).toBeNull(); // no local daemon involved
    expect(st.message).not.toContain('ollama-key');
    const p = (await probeProvider(agent, net(), { ACC_SECRET_OLLAMA_CLOUD: 'ollama-key-0000000000' }))!;
    expect(p.billing.mode).toBe('subscription');
  });
});

describe('pre-flight', () => {
  it('blocks a model that cannot call tools', () => {
    const c = cfg([local]);
    const agent: AgentState = { ...newAgentState(c.agents[0]), auth: { state: 'logged_in' }, billing: { mode: 'local', source: 'x', overage: 'off' }, models: { available: [{ id: 'qwen3-coder:30b', tools: false }], current: null, newest: null, checkedAt: null } };
    const assignment = { id: 'as', workItemId: 'wi', agentId: 'l', position: 'now', scope: '', allowedPaths: [], worktree: null, branch: null, baseSha: null, baseRef: 'integration', requiredChecks: [], askHumanIf: [], handoffFormat: '', prompt: 'x', promptEdited: false, model: null, effort: null, preflight: null, createdAt: '', dispatchedAt: null } as never;
    const r = runPreflight({ now: '', item: undefined, assignment, agent, project: c.project, policies: parseConfig({ project: { name: 'p', repo: '/r' }, agents: [local] }).policies, killSwitch: false, activeAssignments: [] });
    expect(r.checks.filter((x) => x.id === 'tools')).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'fail', message: expect.stringContaining('unverified; re-probe') }),
      expect.objectContaining({ status: 'fail', message: expect.stringContaining('cannot call tools') }),
    ]));
  });
});

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('daemon routes', () => {
  it('Ollama agents can be saved as drafts through the builder (not paid); API-key agents still need cost approval', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, fetch: net() });
    const { d } = h;
    d.saveAgent({ ...local, id: 'oll', name: 'Local', enabled: false, billing: undefined });
    d.saveAgent({ ...cloud, id: 'olc', name: 'Cloud', enabled: false });
    expect(d.state.agents.olc.config).toMatchObject({ provider: 'ollama-cloud', billing: 'subscription', adapter: 'opencode-server' });
    expect(() => d.saveAgent({ ...local, id: 'or', name: 'R', provider: 'openrouter', metered_opt_in: true, model: 'x' })).toThrow(/cost.*Decision/i);
    expect(d.egress.log).toEqual([]); // saving contacts nothing
  });

  it('reports the harness catalog with pinned-version and interaction limits, and live Ollama state', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, fetch: net({ signedIn: false }), baseEnv: { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, ACC_SECRET_OLLAMA_CLOUD: 'ollama-key-0000000000' } });
    const token = fs.readFileSync(path.join(h.d.paths.secrets, 'install-token'), 'utf8').trim();
    const get = async (p: string) => (await fetch(h!.url + p, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cat = await get('/api/harnesses');
    const oc = cat.harnesses.find((x: { adapter: string }) => x.adapter === 'opencode-server');
    expect(oc).toMatchObject({ license: 'MIT', supportedSeries: ['1.18'], supportedVersions: ['1.18.35'], capabilities: { hostApprovals: true } });
    expect(oc.limitations.join(' ')).toContain('Decisions inbox');
    expect(cat.harnesses.find((x: { adapter: string }) => x.adapter === 'codex-cli').limitations.join(' ')).toContain('not routed');
    expect(cat.providers.find((x: { id: string }) => x.id === 'ollama-cloud')).toMatchObject({ billing: 'subscription', defaultHarness: 'opencode-server' });
    expect(cat.providers.find((x: { id: string }) => x.id === 'openrouter')).toMatchObject({ needsOptIn: true, billing: 'metered' });
    const st = await get('/api/ollama/status?provider=ollama-cloud&route=daemon');
    expect(st).toMatchObject({ state: 'not_signed_in' });
    const api = await get('/api/ollama/status?provider=ollama-cloud&route=api'); // ollama.com is not configured yet
    expect(api).toMatchObject({ state: 'error', message: expect.stringContaining('valid Ollama model catalog') });
  });
});
