// SPDX-License-Identifier: Apache-2.0
// Relay mode for app-bound agents with no CLI (desktop IDE agents, chat apps): the control center
// produces a self-contained prompt, the human pastes it into the app, then pastes the reply back.
// There is no process; the run waits for input until the reply arrives.
import type { AuthStatus, BillingInfo, ModelInfo } from '@acc/core';
import { unknownUsage, type LaunchSpec, type StreamParser, type VendorAdapter } from './types.ts';

export const relayAdapter: VendorAdapter = {
  type: 'relay',
  displayName: 'Relay (copy/paste)',
  installUrl: '',
  loginHint: 'Open the app and sign in',
  capabilities: { headless: false, streamingInput: false, resume: false, hostApprovals: false, mcp: false },
  binaryNames: [],
  vendorHost: 'example.com',
  knownLocations: () => [],
  async authStatus(): Promise<AuthStatus> {
    return { state: 'unknown', detail: 'relay agents run in their own app; sign-in is checked there' };
  },
  async billingMode({ agent }): Promise<BillingInfo> {
    return { mode: 'unknown', source: `declared ${agent.billing} in config`, overage: 'unknown' };
  },
  async listModels({ agent }): Promise<ModelInfo[]> {
    return (agent.allowed_models ?? []).map((id) => ({ id }));
  },
  async usage() {
    return unknownUsage('relay agent');
  },
  buildLaunch(): LaunchSpec {
    throw new Error('relay agents are not launched as processes');
  },
  createParser(): StreamParser {
    return { line: () => [], end: () => [] };
  },
};
