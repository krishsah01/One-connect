// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The one interface a new agent vendor implements. Process supervision, durable logs,
// redaction, approvals and rules are shared; a vendor adapter only knows how to talk to its CLI.
import type {
  AdapterType,
  AgentConfig,
  AuthStatus,
  BillingInfo,
  Effort,
  ModelInfo,
  Policy,
  TranscriptEventData,
  TranscriptEventType,
  UsageInfo,
} from '@acc/core';
import type { Failure } from './failures.ts';

export interface McpLaunch {
  command: string;
  args: string[];
}

export interface LaunchContext {
  agent: AgentConfig;
  binary: string;
  runId: string;
  attempt: number;
  model: string | null;
  effort: Effort | null;
  prompt: string;
  cwd: string;
  /** `git rev-parse --git-common-dir`: sandboxed agents need write access to commit from a worktree. */
  gitCommonDir: string | null;
  runDir: string;
  mcp: McpLaunch | null;
  /** Continue an existing vendor session (retry, follow-up message, resume after pause). */
  resume: { sessionId: string; message: string } | null;
  policies: Policy;
  /** Claude-style allowed tool patterns for things that never need a human. */
  allowedTools: string[];
  /** Private home for API-key / local-model connections (e.g. CODEX_HOME), so they never touch the user's own CLI config or login. */
  providerHome: string | null;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Extra, non-secret env vars for the child. */
  env?: Record<string, string>;
  stdin: {
    /** close: write `initial` then EOF. stream: keep open for send(); none: no stdin. */
    mode: 'close' | 'stream' | 'none';
    initial?: string;
    /** stream mode: close stdin once a stdout line matches (e.g. Claude's final result). */
    closeOnMatch?: string;
  };
  /** Files written before launch, e.g. a per-run MCP config. Paths are absolute. */
  files?: { path: string; content: string; mode?: number }[];
  /** Stdout lines containing this are token deltas: shown live, kept out of the evidence log. */
  ephemeralMatch?: string;
}

export type Parsed =
  | { [K in TranscriptEventType]: { kind: 'event'; type: K; data: TranscriptEventData[K] } }[TranscriptEventType]
  | { kind: 'session'; sessionId: string | null; model: string | null; apiKeySource?: string | null; modelMismatch?: { requested: string; served: string } }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  /** Plan usage windows reported by the vendor mid-run, plus whether paid overage is on / in use. */
  | { kind: 'plan_usage'; usage: UsageInfo; overage: { enabled: boolean; inUse: boolean } }
  /** The in-progress message so far (token streaming). Shown live, never persisted. '' clears it. */
  | { kind: 'live'; role: 'assistant' | 'reasoning'; text: string }
  | { kind: 'final'; text: string }
  /** A child session of the harness (OpenCode subagent), surfaced as a child run in the console. */
  | { kind: 'child'; sessionId: string; parentSessionId: string | null; title: string; state: 'running' | 'completed' | 'failed' | 'aborted'; error?: string }
  | { kind: 'failure'; failure: Failure }
  | { kind: 'result'; ok: boolean; text?: string };

export interface StreamParser {
  line(stream: 'stdout' | 'stderr' | 'live', line: string): Parsed[];
  end(exit: { code: number | null; signal: string | null }): Parsed[];
}

export interface ProbeEnv {
  binary: string;
  agent: AgentConfig;
  env: NodeJS.ProcessEnv;
}

export interface VendorAdapter {
  readonly type: AdapterType;
  readonly displayName: string;
  /** Vendor's install page; we never bundle vendor binaries. */
  readonly installUrl: string;
  /** The vendor's own login command/instruction. */
  readonly loginHint: string;
  readonly capabilities: {
    headless: boolean;
    /** send() reaches the running process; otherwise a follow-up turn resumes the session. */
    streamingInput: boolean;
    resume: boolean;
    /** Tool-permission prompts are routed to the control center (waiting-for-approval). */
    hostApprovals: boolean;
    mcp: boolean;
  };
  readonly binaryNames: string[];
  knownLocations(): string[];
  /** Hosts checked for connectivity before a network-failure retry. */
  readonly vendorHost: string;

  authStatus(p: ProbeEnv): Promise<AuthStatus>;
  billingMode(p: ProbeEnv): Promise<BillingInfo>;
  listModels(p: ProbeEnv): Promise<ModelInfo[]>;
  usage(p: ProbeEnv & { sessionIds: string[] }): Promise<UsageInfo>;
  buildLaunch(ctx: LaunchContext): LaunchSpec;
  createParser(ctx: { agent: AgentConfig; runId: string; cwd: string }): StreamParser;
  /** How a mid-run message is delivered on stdin (streaming adapters only). */
  encodeMessage?(text: string): string;
  /**
   * A line that asks a streaming harness to abort its in-flight turn cleanly (so the vendor records
   * the abort) before the process group is signalled. Only used for a plain stop or pause.
   */
  encodeAbort?(): string;
}

export const unknownUsage = (source: string): UsageInfo => ({ windows: [], status: 'unknown', checkedAt: new Date().toISOString(), source });

export { clip } from '@acc/core';
