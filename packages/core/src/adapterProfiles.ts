// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// What every part of One Connect needs to know about an agent runtime, without its code. The
// daemon's vendor adapters add behavior (probing, launch, stream parsing) on top of these facts;
// the web reads them directly. Adding a runtime is one profile here plus one daemon adapter.
import type { AdapterType } from './config.ts';

export interface AdapterCapabilities {
  /** Runs without a UI, driven by the control center. */
  headless: boolean;
  /** Mid-run messages reach the running process; otherwise a follow-up turn resumes the session. */
  streamingInput: boolean;
  resume: boolean;
  /** Tool-permission prompts are routed to the control center (waiting-for-approval). */
  hostApprovals: boolean;
  mcp: boolean;
}

export interface AdapterProfile {
  readonly displayName: string;
  /** Vendor's install page; vendor binaries are never bundled. */
  readonly installUrl: string;
  /** The vendor's own login command or instruction. */
  readonly loginHint: string;
  /** Official login argv after the binary, or null when the runtime has no login of its own. */
  readonly loginArgs: readonly string[] | null;
  /**
   * False for manual relay: the owner carries prompts to another app. Nothing is launched,
   * no binary is pinned and no sign-in is checked here.
   */
  readonly runsHere: boolean;
  readonly capabilities: AdapterCapabilities;
}

export const ADAPTER_PROFILES: Readonly<Record<AdapterType, AdapterProfile>> = {
  'claude-headless': {
    displayName: 'Claude Code',
    installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    loginHint: 'Run `claude auth login` in a terminal and sign in with your Claude account',
    loginArgs: ['auth', 'login'],
    runsHere: true,
    capabilities: { headless: true, streamingInput: true, resume: true, hostApprovals: true, mcp: true },
  },
  'codex-cli': {
    displayName: 'Codex CLI',
    installUrl: 'https://developers.openai.com/codex/cli',
    loginHint: 'Run `codex login` in a terminal and choose "Sign in with ChatGPT"',
    loginArgs: ['login'],
    runsHere: true,
    capabilities: { headless: true, streamingInput: false, resume: true, hostApprovals: false, mcp: true },
  },
  'cursor-agent-cli': {
    displayName: 'Cursor Agent CLI',
    installUrl: 'https://cursor.com/cli',
    loginHint: 'Run `cursor-agent login` in a terminal and sign in with your Cursor account',
    loginArgs: ['login'],
    runsHere: true,
    capabilities: { headless: true, streamingInput: false, resume: true, hostApprovals: false, mcp: true },
  },
  'generic-cli': {
    displayName: 'Generic CLI',
    installUrl: '',
    loginHint: "Sign in with the tool's own login command",
    loginArgs: null,
    runsHere: true,
    capabilities: { headless: true, streamingInput: false, resume: false, hostApprovals: false, mcp: false },
  },
  relay: {
    displayName: 'Relay (copy/paste)',
    installUrl: '',
    loginHint: 'Open the app and sign in',
    loginArgs: null,
    runsHere: false,
    capabilities: { headless: false, streamingInput: false, resume: false, hostApprovals: false, mcp: false },
  },
  'opencode-server': {
    displayName: 'OpenCode (API keys & local models)',
    installUrl: 'https://opencode.ai/docs/',
    loginHint: 'OpenCode has no login of its own here: add the provider key under Connections (Keychain), or start Ollama',
    loginArgs: null,
    runsHere: true,
    capabilities: { headless: true, streamingInput: true, resume: true, hostApprovals: true, mcp: true },
  },
};

export const adapterProfile = (type: AdapterType): AdapterProfile => ADAPTER_PROFILES[type];

/** The owner relays prompts by hand: no process, no pinned binary, no sign-in to check here. */
export const isManualRelay = (agent: { adapter: AdapterType }): boolean => !ADAPTER_PROFILES[agent.adapter].runsHere;
