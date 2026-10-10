// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Onboarding / probe: which vendor binaries exist, which one is pinned, login state, billing
// mode, model inventory and (where exposed) included usage. Never touches credentials.
import type { AgentState, BinaryInfo, ControlEventData } from '@acc/core';
import { selectNewestModel, isManualRelay } from '@acc/core';
import { chooseBinary, detectBinaries, newerCandidate } from './adapters/agents/detect.ts';
import { meteredVarsPresent, sanitizeEnv } from './adapters/agents/env.ts';
import { adapterFor } from './adapters/agents/index.ts';
import { whichAll } from './adapters/agents/detect.ts';
import { probeProvider } from './adapters/agents/providers.ts';
import { checkVersion } from './adapters/agents/opencode/protocol.ts';
import type { Fetch } from './egress.ts';

export type ProbeResult = ControlEventData['agent.probed'] & { newerBinary: BinaryInfo | null; meteredVars: string[] };

export async function probeAgent(agent: AgentState, baseEnv: NodeJS.ProcessEnv, sessionIds: string[], fetchFn?: Fetch): Promise<ProbeResult> {
  const cfg = agent.config;
  const adapter = adapterFor(cfg.adapter);
  const meteredVars = meteredVarsPresent(cfg, baseEnv);
  if (isManualRelay(cfg)) {
    return {
      auth: await adapter.authStatus({ binary: '', agent: cfg, env: baseEnv }),
      billing: await adapter.billingMode({ binary: '', agent: cfg, env: baseEnv }),
      binary: null,
      binaryCandidates: [],
      models: await adapter.listModels({ binary: '', agent: cfg, env: baseEnv }),
      newest: null,
      newerBinary: null,
      meteredVars,
    };
  }
  let candidates: BinaryInfo[];
  if (cfg.adapter === 'generic-cli') {
    const cmd = cfg.binary ?? cfg.command ?? '';
    const found = cmd.includes('/') ? [cmd] : whichAll([cmd]);
    candidates = found.map((p) => ({ path: p, version: null, prerelease: false, source: cfg.binary ? 'config' : 'path' }) as BinaryInfo);
  } else candidates = await detectBinaries(adapter, cfg.binary);
  const binary = chooseBinary(candidates);
  if (!binary) {
    return {
      auth: { state: 'not_installed', detail: `${adapter.displayName} not found on PATH or in known app bundles`, fix: adapter.installUrl ? `Install it from ${adapter.installUrl}, then run its login command` : 'Install the CLI and put it on PATH' },
      billing: { mode: 'unknown', source: 'not installed', overage: 'unknown' },
      binary: null,
      binaryCandidates: candidates,
      models: [],
      newest: null,
      newerBinary: null,
      meteredVars,
    };
  }
  // Probe with the same sanitized env runs get, so billing reflects what an agent run would use.
  const { env } = sanitizeEnv(cfg, baseEnv);
  const p = { binary: binary.path, agent: cfg, env };
  // Bring-your-own-model connections: the provider answers login/billing/models, not the harness.
  const provider = fetchFn ? await probeProvider(cfg, fetchFn, baseEnv).catch(() => null) : null;
  let [auth, billing, models] = provider ? [provider.auth, provider.billing, provider.models] : await Promise.all([adapter.authStatus(p), adapter.billingMode(p), adapter.listModels(p).catch(() => [])]);
  if (cfg.adapter === 'opencode-server') {
    // The protocol is pinned: an unknown OpenCode release is reported here and blocks dispatch in pre-flight.
    const v = checkVersion(binary.version, baseEnv);
    if (!v.ok) auth = { ...auth, state: auth.state === 'logged_in' ? 'unknown' : auth.state, detail: `${auth.detail ? `${auth.detail}. ` : ''}${v.message}`, fix: 'Install a supported OpenCode release (see docs/harnesses.md)' };
  }
  const usage = provider ? provider.usage : await adapter.usage({ ...p, sessionIds }).catch(() => undefined);
  if (meteredVars.length && !cfg.metered_opt_in) {
    billing.notes = [...(billing.notes ?? []), `${meteredVars.join(', ')} set in your shell; stripped from agent runs so they stay on your subscription.`];
  }
  const newest = selectNewestModel(models, { family: cfg.model_family, effort: cfg.effort ?? null, allowed: cfg.allowed_models }).model?.id ?? null;
  return { auth, billing, binary, binaryCandidates: candidates, models, newest, usage, newerBinary: newerCandidate(binary, candidates), meteredVars };
}
