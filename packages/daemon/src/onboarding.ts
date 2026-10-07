// SPDX-License-Identifier: Apache-2.0
// Onboarding wizard data: installed vendor CLIs (configured or not), their versions and pinning,
// plus each configured agent's login state, billing mode and models.
import type { BinaryInfo } from '@acc/core';
import { chooseBinary, detectBinaries, newerCandidate } from './adapters/agents/detect.ts';
import { VENDOR_ADAPTERS } from './adapters/agents/index.ts';
import type { Daemon } from './daemon.ts';

export interface DetectedVendor {
  adapter: string;
  displayName: string;
  installUrl: string;
  loginHint: string;
  candidates: BinaryInfo[];
  pinned: BinaryInfo | null;
  newer: BinaryInfo | null;
  configuredAgents: string[];
}

export async function detectVendors(configured: { adapter: string; id: string }[]): Promise<DetectedVendor[]> {
  const out: DetectedVendor[] = [];
  for (const a of Object.values(VENDOR_ADAPTERS)) {
    if (a.binaryNames.length === 0) continue;
    const candidates = await detectBinaries(a);
    const pinned = chooseBinary(candidates);
    out.push({
      adapter: a.type,
      displayName: a.displayName,
      installUrl: a.installUrl,
      loginHint: a.loginHint,
      candidates,
      pinned,
      newer: newerCandidate(pinned, candidates),
      configuredAgents: configured.filter((c) => c.adapter === a.type).map((c) => c.id),
    });
  }
  return out;
}

export async function onboardingReport(d: Daemon) {
  const vendors = await detectVendors(Object.values(d.state.agents).map((a) => ({ adapter: a.config.adapter, id: a.id })));
  const agents = Object.values(d.state.agents).map((a) => {
    const adapter = VENDOR_ADAPTERS[a.config.adapter];
    return {
      id: a.id,
      name: a.config.name,
      subscription: a.config.subscription ?? null,
      role: a.config.role,
      mode: a.config.mode,
      adapter: a.config.adapter,
      displayName: adapter.displayName,
      installUrl: adapter.installUrl,
      loginHint: adapter.loginHint,
      capabilities: adapter.capabilities,
      auth: a.auth,
      billing: a.billing,
      meteredOptIn: a.config.metered_opt_in,
      binary: a.binary,
      binaryCandidates: a.binaryCandidates,
      models: a.models,
      usage: a.usage,
      probedAt: a.probedAt,
    };
  });
  return { vendors, agents, tracker: { type: d.tracker.type, target: d.tracker.target, live: d.tracker.live } };
}
