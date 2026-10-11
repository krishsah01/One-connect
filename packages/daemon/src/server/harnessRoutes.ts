// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// HTTP routes for the harness/provider catalog (agent builder), Ollama status (both ways) and the
// advisory-only Jev connection. Registered on the main app, so they inherit its Host/Origin checks
// and session/install-token authentication.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { defaultHarnessFor, HUMAN, PAID_PROVIDERS, PROVIDER_HARNESS, PROVIDERS, type Provider } from '@acc/core';
import { detectBinaries } from '../adapters/agents/detect.ts';
import { VENDOR_ADAPTERS } from '../adapters/agents/index.ts';
import { ollamaStatus } from '../adapters/agents/ollama.ts';
import { checkVersion, OPENCODE_PROTOCOL, supportedSeries, SUPPORTED_VERSIONS } from '../adapters/agents/opencode/protocol.ts';
import { CommandError, type Daemon } from '../daemon.ts';
import { EgressDenied } from '../egress.ts';
import type { JevConfirm } from '../jev.ts';
import { hasSecret, providerSecretFor } from '../secrets.ts';

type R<P = Record<string, string>, B = unknown, Q = Record<string, string | undefined>> = FastifyRequest<{ Params: P; Body: B; Querystring: Q }>;

const PROVIDER_LABEL: Record<Provider, string> = {
  subscription: 'Subscription (official CLI login)',
  'anthropic-api': 'Anthropic API key (pay per token)',
  'openai-api': 'OpenAI API key (pay per token)',
  'cursor-api': 'Cursor API key (Cursor CLI, billed by Cursor)',
  openrouter: 'OpenRouter API key (pay per token)',
  ollama: 'Ollama, local models (free)',
  'ollama-cloud': 'Ollama cloud models (Ollama subscription)',
  lmstudio: 'LM Studio, local models (free)',
};

/** What each harness can and cannot do inside One Connect, shown before an agent is created. */
const LIMITATIONS: Record<string, string[]> = {
  'opencode-server': [
    'Tool permission requests and OpenCode questions arrive in your Decisions inbox before the action runs.',
    'Messages you send while it works are queued into its session and handled at its next turn.',
    'Pause aborts the current turn and keeps the session so Resume can continue it.',
    'Only the pinned OpenCode patch release is supported; other releases are refused before any model call.',
    'LM Studio is blocked until its tool capability contract is verified.',
  ],
  'codex-cli': [
    'Runs with approvals disabled inside a workspace-write sandbox: tool approvals are not routed into One Connect.',
    'It cannot receive live messages; a follow-up resumes the session as a new turn.',
    'Local models use codex --oss. Keep this for models OpenCode cannot serve.',
  ],
  'claude-headless': ['Tool approvals are routed to One Connect; live messages are supported.'],
};

export async function harnessCatalog(d: Daemon) {
  const oc = VENDOR_ADAPTERS['opencode-server'];
  const candidates = await detectBinaries(oc, d.config.agents.find((a) => a.adapter === 'opencode-server')?.binary).catch(() => []);
  const bin = candidates[0] ?? null;
  const env = d.baseEnv();
  const providers = await Promise.all(PROVIDERS.filter((p) => p !== 'subscription').map(async (p) => {
    const secret = providerSecretFor({ provider: p, ollama_route: p === 'ollama-cloud' ? 'api' : undefined });
    return {
      id: p,
      label: PROVIDER_LABEL[p],
      harnesses: PROVIDER_HARNESS[p],
      defaultHarness: defaultHarnessFor(p),
      billing: p === 'ollama' || p === 'lmstudio' ? 'local' : p === 'ollama-cloud' ? 'subscription' : 'metered',
      secret: secret?.secret ?? null,
      keyStored: secret ? await hasSecret(secret.secret, env) : null,
      needsOptIn: PAID_PROVIDERS.includes(p),
    };
  }));
  return {
    harnesses: Object.values(VENDOR_ADAPTERS)
      .filter((a) => ['opencode-server', 'codex-cli', 'claude-headless'].includes(a.type))
      .map((a) => ({
        adapter: a.type,
        displayName: a.displayName,
        capabilities: a.capabilities,
        limitations: LIMITATIONS[a.type] ?? [],
        installUrl: a.installUrl,
        ...(a.type === 'opencode-server'
          ? { license: 'MIT', binary: bin, version: checkVersion(bin?.version, env), supportedSeries: supportedSeries(env), supportedVersions: [...SUPPORTED_VERSIONS], protocol: OPENCODE_PROTOCOL, verification: 'Contract fixtures only. A live, approved provider check is pending.' }
          : {}),
      })),
    providers,
  };
}

export function registerHarnessRoutes(app: FastifyInstance, d: Daemon): void {
  app.get('/api/harnesses', async () => harnessCatalog(d));

  // Draft-agent checks for the builder. Defaults only: the daemon contacts nothing but configured hosts.
  app.get('/api/ollama/status', async (req: R<Record<string, string>, unknown, { provider?: string; route?: string }>) => {
    const provider = req.query.provider === 'ollama-cloud' ? 'ollama-cloud' : 'ollama';
    const route = req.query.route === 'api' ? 'api' : 'daemon';
    try {
      return await ollamaStatus({ provider, ollama_route: provider === 'ollama-cloud' ? route : undefined }, d.egress.fetch, d.baseEnv());
    } catch (e) {
      if (e instanceof EgressDenied) return { route: provider === 'ollama' ? 'local' : route, state: 'error', message: 'ollama.com is not a configured connection yet. Save the agent (it can stay a draft), then check again.', models: [], counts: { local: 0, cloud: 0 } };
      throw e;
    }
  });

  // ---- Jev: disabled by default, advisory only -------------------------------------------------
  app.get('/api/jev', async () => d.jev.status());
  app.post('/api/jev/configure', async (req: R<Record<string, string>, { enabled?: boolean; endpoint?: string; confirm?: JevConfirm }>) => {
    d.jev.configure({ enabled: req.body?.enabled === true, endpoint: req.body?.endpoint, confirm: req.body?.confirm }, HUMAN);
    return d.jev.status();
  });
  app.get('/api/decisions/:id/advisory/preview', async (req: R) => d.jev.preview(req.params.id));
  app.post('/api/decisions/:id/advisory/cancel', async (req: R<{ id: string }, { inputHash?: string }>) => {
    d.jev.cancel(req.params.id, String(req.body?.inputHash ?? ''), HUMAN);
    return { ok: true };
  });
  app.post('/api/decisions/:id/advisory', async (req: R<{ id: string }, { inputHash?: string; confirm?: JevConfirm }>) => {
    if (!req.body) throw new CommandError('confirmation required', 428);
    return { decision: await d.jev.request(req.params.id, req.body, HUMAN) };
  });
}
