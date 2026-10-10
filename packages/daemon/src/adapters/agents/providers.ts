// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Bring-your-own-model connections: local servers (Ollama, LM Studio) and API keys (Anthropic
// Console, OpenAI, OpenRouter). The harness is still an official agent CLI (Claude Code / Codex);
// these probes answer "is it reachable, what does it cost, which models can call tools".
import type { AgentConfig, AuthStatus, BillingInfo, ModelInfo, UsageInfo } from '@acc/core';
import type { Fetch } from '../../egress.ts';
import { getSecret, PROVIDER_SECRET } from '../../secrets.ts';
import { ollamaStatus } from './ollama.ts';
import { unknownUsage } from './types.ts';

export interface ProviderProbe {
  auth: AuthStatus;
  billing: BillingInfo;
  models: ModelInfo[];
  usage: UsageInfo;
}

const json = async (f: Fetch, url: string, init: RequestInit = {}, timeoutMs = 4000): Promise<unknown> => {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
};

export { OLLAMA_LOCAL_URL as OLLAMA_DEFAULT } from './ollama.ts';
export const LMSTUDIO_DEFAULT = 'http://127.0.0.1:1234';

/** USD per token (OpenRouter strings) → USD per million tokens. */
const perM = (v: unknown) => Math.round(Number(v ?? 0) * 1_000_000 * 1000) / 1000;

export async function probeProvider(agent: AgentConfig, f: Fetch, env: NodeJS.ProcessEnv = process.env): Promise<ProviderProbe | null> {
  const p = agent.provider;
  if (p === 'subscription') return null;

  if (p === 'ollama' || p === 'ollama-cloud') {
    const st = await ollamaStatus(agent, f, env);
    const sub = p === 'ollama-cloud';
    const billing: BillingInfo = sub
      ? { mode: 'subscription', source: `Ollama subscription (cloud models via ${st.route === 'api' ? 'the Ollama cloud API' : 'the signed-in local Ollama'})`, overage: 'unknown', notes: ['Ollama plans have usage limits and may offer paid extras; Ollama does not report remaining usage to this app, so confirm your plan settings.'] }
      : { mode: 'local', source: 'Ollama on this machine', overage: 'off', notes: ["Models ending in -cloud run on Ollama's servers under your Ollama plan: use the Ollama cloud provider for those."] };
    const usage = unknownUsage(sub ? 'Ollama does not report subscription usage; see your Ollama account' : 'local model: no usage limits beyond your hardware');
    if (st.state === 'ready' || st.state === 'sign_in_unknown') {
      return { auth: { state: st.state === 'ready' ? 'logged_in' : 'unknown', detail: st.message, ...(st.fix ? { fix: st.fix } : {}) }, billing, models: st.models, usage };
    }
    return { auth: { state: st.state === 'error' ? 'unknown' : 'expired', detail: st.message, ...(st.fix ? { fix: st.fix } : {}) }, billing, models: [], usage };
  }

  if (p === 'lmstudio') {
    const base = agent.base_url ?? LMSTUDIO_DEFAULT;
    const billing: BillingInfo = { mode: 'local', source: 'LM Studio on this machine', overage: 'off', notes: [] };
    try {
      const list = (await json(f, `${base}/v1/models`)) as { data?: { id: string }[] };
      return { auth: { state: 'logged_in', detail: `LM Studio server at ${base}` }, billing, models: (list.data ?? []).map((m) => ({ id: m.id, pricing: { input: 0, output: 0 } })), usage: unknownUsage('local model') };
    } catch (e) {
      return { auth: { state: 'expired', detail: `LM Studio not reachable at ${base}: ${(e as Error).message}`, fix: 'Start the LM Studio local server' }, billing, models: [], usage: unknownUsage('local model') };
    }
  }

  // API-key providers.
  const spec = PROVIDER_SECRET[p]!;
  const key = await getSecret(spec.secret, env);
  const billing: BillingInfo = { mode: 'metered', source: `${p} API key (pay per token)`, overage: 'on', notes: [agent.budget_usd_per_day ? `Daily cap: $${agent.budget_usd_per_day.toFixed(2)}` : 'No daily cap set: add budget_usd_per_day.'] };
  if (!key) {
    return { auth: { state: 'expired', detail: 'no API key stored', fix: `Add your ${p} key under Agents → Connections (stored in the macOS Keychain)` }, billing, models: [], usage: unknownUsage(p) };
  }
  try {
    if (p === 'openrouter') {
      const list = (await json(f, 'https://openrouter.ai/api/v1/models', {}, 8000)) as { data?: { id: string; name?: string; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[]; created?: number }[] };
      const models = (list.data ?? [])
        .filter((m) => (m.supported_parameters ?? []).includes('tools'))
        .map((m) => {
          const pricing = { input: perM(m.pricing?.prompt), output: perM(m.pricing?.completion) };
          return { id: m.id, label: `${m.name ?? m.id} · ${pricing.input === 0 && pricing.output === 0 ? 'free' : `$${pricing.input}/$${pricing.output} per Mtok`}`, pricing, tools: true } as ModelInfo;
        });
      let usage = unknownUsage('OpenRouter');
      try {
        const k = (await json(f, 'https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } })) as { data?: { usage?: number; limit?: number | null; usage_daily?: number } };
        const d = k.data ?? {};
        usage = {
          windows: [{ name: d.limit ? `credit limit $${d.limit}` : 'credits used (no limit set)', usedPercent: d.limit ? Math.round(((d.usage ?? 0) / d.limit) * 100) : null, resetsAt: null }],
          status: d.limit && (d.usage ?? 0) >= d.limit ? 'limited' : 'ok',
          checkedAt: new Date().toISOString(),
          source: `OpenRouter key: $${(d.usage ?? 0).toFixed(2)} used${d.usage_daily !== undefined ? `, $${d.usage_daily.toFixed(2)} today` : ''}`,
        };
      } catch {
        /* usage is optional */
      }
      return { auth: { state: 'logged_in', detail: 'OpenRouter key in Keychain' }, billing, models, usage };
    }
    if (p === 'openai-api') {
      const list = (await json(f, 'https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } })) as { data?: { id: string }[] };
      return { auth: { state: 'logged_in', detail: 'OpenAI key in Keychain' }, billing, models: (list.data ?? []).filter((m) => /^(gpt|o\d|codex)/.test(m.id)).map((m) => ({ id: m.id })), usage: unknownUsage('OpenAI API: spend is estimated from tokens × pricing') };
    }
    const list = (await json(f, 'https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } })) as { data?: { id: string; display_name?: string }[] };
    return { auth: { state: 'logged_in', detail: 'Anthropic Console key in Keychain' }, billing, models: (list.data ?? []).map((m) => ({ id: m.id, label: m.display_name })), usage: unknownUsage('Anthropic API: per-run cost reported by Claude Code') };
  } catch (e) {
    return { auth: { state: 'unknown', detail: `key stored, but the provider check failed: ${(e as Error).message}` }, billing, models: [], usage: unknownUsage(p) };
  }
}

/** Cost of a usage report: the provider's own figure when given, else tokens × price. */
export function estimateCost(agent: AgentConfig, model: string | null, tokens: { inputTokens: number; outputTokens: number }, inventory: ModelInfo[], reported?: number): number | undefined {
  if (agent.billing !== 'metered') return undefined;
  if (reported !== undefined) return reported;
  const price = agent.pricing ? { input: agent.pricing.input_per_mtok, output: agent.pricing.output_per_mtok } : inventory.find((m) => m.id === model)?.pricing;
  if (!price) return undefined;
  return (tokens.inputTokens * price.input + tokens.outputTokens * price.output) / 1_000_000;
}
