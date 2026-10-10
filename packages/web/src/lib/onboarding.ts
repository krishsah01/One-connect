// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Shared onboarding guidance for Agents setup and the project terminal. Keeps login argv and
// connection copy in one place so the UI never executes vendor auth.fix strings automatically.
import type { AdapterProfile, AgentState, AuthStatus, BinaryInfo } from '@acc/core';
import { ADAPTER_PROFILES, compareVersions, isManualRelay } from '@acc/core';

/**
 * Official vendor login argv only (from the shared adapter profile), or null. Never route
 * arbitrary auth.fix text into a terminal.
 */
export function loginArgs(adapter: string): readonly string[] | null {
  const profiles: Readonly<Record<string, AdapterProfile>> = ADAPTER_PROFILES;
  return Object.hasOwn(profiles, adapter) ? profiles[adapter].loginArgs : null;
}

/** Enabled agents are missing, or a subscription agent that runs here is not signed in. */
export function needsAgentConnection(agents: readonly AgentState[]): boolean {
  const enabled = agents.filter((a) => a.config.enabled !== false);
  return enabled.length === 0 || enabled.some((a) => a.config.provider === 'subscription' && !isManualRelay(a.config) && a.auth.state !== 'logged_in');
}

export const AUTH_TONE: Record<AuthStatus['state'], 'ok' | 'crit' | 'warn'> = {
  logged_in: 'ok',
  expired: 'crit',
  not_installed: 'crit',
  unknown: 'warn',
};

export const AUTH_LABEL: Record<AuthStatus['state'], string> = {
  logged_in: 'Login detected',
  expired: 'Sign-in needed',
  not_installed: 'Tool not found',
  unknown: 'Not verified',
};

function versionParts(v: string | null): number[] {
  return v ? v.split('-')[0].split('.').map(Number) : [];
}

/** A newer installed copy exists than the one this agent last probed or pinned. */
export function findNewerBinary(pinned: BinaryInfo | null, candidates: BinaryInfo[]): BinaryInfo | null {
  if (!pinned) return null;
  const better = candidates.filter(
    (c) => c.path !== pinned.path && compareVersions(versionParts(c.version), versionParts(pinned.version)) > 0,
  );
  return better.sort((a, b) => compareVersions(versionParts(b.version), versionParts(a.version)))[0] ?? null;
}

export function agentNewerBinary(agent: AgentState): BinaryInfo | null {
  return findNewerBinary(agent.binary, agent.binaryCandidates);
}

export function connectionGuidance(agent: AgentState): string {
  const newer = agentNewerBinary(agent);
  if (agent.config.enabled === false) {
    return 'Saved draft. Finish configuration in Edit agent and enable the runtime when you are ready. Official sign-in preparation unlocks after enabling.';
  }
  if (agent.auth.state === 'not_installed') {
    return 'Install the official runtime using its vendor guide below, scan installed tools again, then re-check this agent.';
  }
  if (newer) {
    return `A newer CLI is installed at ${newer.path}${newer.version ? ` (${newer.version})` : ''}. Re-check this agent or pin that binary in Edit agent before signing in or dispatching.`;
  }
  if (isManualRelay(agent.config)) {
    return 'Manual relay uses another app. Choose an official CLI in Edit agent to keep supported runs and output inside One Connect.';
  }
  if (agent.config.provider !== 'subscription') {
    return 'Check the configured model source and optional keys below. Official subscription sign-in applies only to subscription agents.';
  }
  if (agent.auth.state === 'expired') {
    return 'Prepare the official sign-in command below. Complete the vendor login, then re-check this agent.';
  }
  if (agent.auth.state === 'unknown') {
    return 'The connection has not been verified. Re-check the installed runtime; sign in with the official tool if it reports that your login is missing.';
  }
  if (agent.billing.mode === 'metered' && !agent.config.metered_opt_in) {
    return 'This connection reports metered billing and is blocked. Review the account and model source before assigning work.';
  }
  if (!agent.models.available.some((model) => !model.hidden)) {
    return 'Login detected, but no usable models have been discovered. Re-check the runtime and review its model policy in Edit agent.';
  }
  return 'Vendor login detected. Review billing, included usage and any account confirmation below before dispatching from the work board.';
}

/** Why an installed-tool login action is unavailable before agent setup. */
export function vendorLoginBlockedReason(vendor: { adapter: string; candidates: BinaryInfo[]; configuredAgents: string[] }): string | null {
  if (!loginArgs(vendor.adapter)) return 'This adapter has no native login command.';
  if (!vendor.candidates.length) return 'Install this runtime using the official vendor guide, then scan installed tools again.';
  if (!vendor.configuredAgents.length) {
    return 'No agent uses this runtime yet. Create an agent and select its binary in Edit agent before preparing sign-in.';
  }
  return null;
}

/** Why the configured login binary is unavailable until a fresh probe refreshes the binding. */
export function loginBinaryStaleReason(agent: AgentState): string | null {
  const pinned = agent.config.binary ?? null;
  const probed = agent.binary?.path ?? null;
  if (pinned && probed && pinned !== probed) {
    return 'This agent was pinned to a different binary. Re-check the connection to refresh its CLI binding before preparing sign-in.';
  }
  return null;
}

export function loginBinaryPath(agent: AgentState, vendorPinned?: string | null): string | null {
  if (loginBinaryStaleReason(agent)) return null;
  const pinned = agent.config.binary ?? null;
  const probed = agent.binary?.path ?? null;
  const path = pinned ?? probed ?? vendorPinned ?? null;
  if (!path || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path)) return null;
  return path;
}
