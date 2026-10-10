// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// OpenCode (MIT) adapter: the default open-source harness for API-key and local-model providers
// (Anthropic/OpenAI/OpenRouter keys, Ollama local + cloud). LM Studio stays blocked until its
// tool capabilities are verified. Subscription agents keep
// their official vendor CLIs. OpenCode is not bundled; see opencode/protocol.ts for the pinned
// protocol and what is verified. The detached runner starts opencode/bridge.ts, which owns the
// loopback OpenCode server and prints one JSON line per event; this file maps those lines to the
// same typed transcript events every other adapter produces.
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AuthStatus, BillingInfo, ModelInfo } from '@acc/core';
import { commandCompleted, endWithoutResult, relPath, stderrLine, summarize, tryJson } from './common.ts';
import { classifyFailure, type Failure } from './failures.ts';
import { buildOpencodeConfig, DELTA_MATCH, OPENCODE_PROTOCOL, opencodeEnv, RESULT_MATCH } from './opencode/protocol.ts';
import { unknownUsage, type LaunchContext, type LaunchSpec, type Parsed, type StreamParser, type VendorAdapter } from './types.ts';

export const OPENCODE_BRIDGE_PATH = fileURLToPath(new URL('./opencode/bridge.ts', import.meta.url));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v: unknown) => (typeof v === 'string' ? v : '');

export const opencodeAdapter: VendorAdapter = {
  type: 'opencode-server',
  displayName: 'OpenCode (API keys & local models)',
  installUrl: 'https://opencode.ai/docs/',
  loginHint: 'OpenCode has no login of its own here: add the provider key under Connections (Keychain), or start Ollama',
  capabilities: { headless: true, streamingInput: true, resume: true, hostApprovals: true, mcp: true },
  binaryNames: ['opencode'],
  vendorHost: '127.0.0.1',
  knownLocations: () => [path.join(os.homedir(), '.opencode', 'bin', 'opencode'), path.join(os.homedir(), '.local', 'bin', 'opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'],

  async authStatus(): Promise<AuthStatus> {
    return { state: 'unknown', detail: 'sign-in is the provider connection (key in Keychain or a local server); probe through the daemon' };
  },

  async billingMode({ agent }): Promise<BillingInfo> {
    const mode = agent.billing === 'local' ? 'local' : agent.billing === 'metered' ? 'metered' : 'subscription';
    return { mode, source: `declared ${agent.billing} (${agent.provider})`, overage: mode === 'local' ? 'off' : 'unknown' };
  },

  async listModels({ agent }): Promise<ModelInfo[]> {
    return (agent.allowed_models ?? []).filter((m) => !m.includes('*')).map((id) => ({ id }));
  },

  async usage() {
    return unknownUsage('OpenCode does not report plan usage; provider usage is shown on the connection');
  },

  encodeMessage(t: string): string {
    return JSON.stringify({ type: 'user', text: t });
  },

  encodeAbort(): string {
    return JSON.stringify({ type: 'abort' });
  },

  buildLaunch(ctx: LaunchContext): LaunchSpec {
    if (!ctx.model) throw new Error('no concrete model selected; probe the agent so the newest model can be resolved');
    const { config, setup } = buildOpencodeConfig({ agent: ctx.agent, model: ctx.model, runDir: ctx.runDir, mcp: ctx.mcp });
    // Per-run random password: environment only, never argv, never written to disk or an event.
    const password = randomBytes(24).toString('hex');
    const env = opencodeEnv({ runDir: ctx.runDir, providerHome: ctx.providerHome ?? path.join(ctx.runDir, 'provider-home'), password, offline: setup.offline });
    const start = {
      binary: ctx.binary,
      cwd: ctx.cwd,
      model: { providerID: setup.providerID, modelID: setup.modelID },
      prompt: ctx.prompt,
      resume: ctx.resume,
      title: `One Connect ${ctx.agent.id} run ${ctx.runId}`,
      protocol: OPENCODE_PROTOCOL,
      envKey: setup.envKey,
      provider: { provider: ctx.agent.provider, base_url: ctx.agent.base_url, ollama_route: ctx.agent.ollama_route },
    };
    return {
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', OPENCODE_BRIDGE_PATH, ctx.runDir],
      cwd: ctx.cwd,
      env,
      stdin: { mode: 'stream', initial: JSON.stringify(start), closeOnMatch: RESULT_MATCH },
      files: [{ path: env.OPENCODE_CONFIG, content: JSON.stringify(config, null, 2), mode: 0o600 }],
      ephemeralMatch: DELTA_MATCH,
    };
  },

  createParser({ cwd }): StreamParser {
    let lastText = '';
    let sawResult = false;
    let lastFailure: Parsed | null = null;
    let liveAssistant = '';
    const failure = (f: Failure | null): Parsed[] => {
      if (!f) return [];
      lastFailure = { kind: 'failure', failure: f };
      return [lastFailure];
    };
    return {
      line(stream, line) {
        if (stream === 'stderr') {
          const out = stderrLine(line);
          lastFailure = out.find((p) => p.kind === 'failure') ?? lastFailure;
          return out;
        }
        const j = tryJson(line);
        if (stream === 'live') {
          if (!j || j.t !== 'delta') return [];
          const role = j.role === 'reasoning' ? 'reasoning' : 'assistant';
          if (role === 'assistant') liveAssistant = text(j.text);
          return [{ kind: 'live', role, text: text(j.text) }];
        }
        if (!j) return line.trim() ? [{ kind: 'event', type: 't.raw', data: { stream: 'stdout', line } }] : [];
        const out: Parsed[] = [];
        switch (j.t) {
          case 'ready':
            out.push({ kind: 'event', type: 't.system', data: { text: `OpenCode ${text(j.version)} ready on a loopback server (protocol ${text(j.protocol)}); per-run credentials, isolated config and storage` } });
            break;
          case 'session':
            out.push({ kind: 'session', sessionId: text(j.sessionId) || null, model: text(j.model) || null });
            break;
          case 'message':
            lastText = text(j.text);
            if (lastText.trim()) out.push({ kind: 'event', type: 't.message', data: { role: 'assistant', text: lastText } });
            if (liveAssistant) {
              liveAssistant = '';
              out.push({ kind: 'live', role: 'assistant', text: '' });
            }
            break;
          case 'reasoning':
            if (text(j.text).trim()) out.push({ kind: 'event', type: 't.reasoning', data: { text: text(j.text) } }, { kind: 'live', role: 'reasoning', text: '' });
            break;
          case 'tool': {
            const tool = text(j.tool);
            const input = (j.input ?? {}) as Record<string, unknown>;
            const callId = text(j.callId);
            const status = text(j.status);
            const output = text(j.output);
            if (tool === 'bash') {
              const command = text(input.command);
              if (status === 'running') out.push({ kind: 'event', type: 't.command', data: { callId, command, status: 'started' } });
              else if (typeof j.exit === 'number' && Number.isSafeInteger(j.exit)) out.push(...commandCompleted(command, j.exit, output, callId));
              else out.push({ kind: 'event', type: 't.system', data: { text: `OpenCode bash ${status}; exit status was not reported: ${command}` } });
            } else if (['edit', 'write', 'patch', 'multiedit'].includes(tool)) {
              if (status === 'completed') out.push({ kind: 'event', type: 't.file_edit', data: { path: relPath(cwd, text(input.filePath)), change: 'modify' } });
              else if (status === 'error') out.push({ kind: 'event', type: 't.tool_result', data: { callId, ok: false, summary: `${tool} failed: ${summarize(output, 140)}` } });
            } else if (status === 'running') out.push({ kind: 'event', type: 't.tool_call', data: { callId, name: tool, summary: summarize(input, 160) } });
            else out.push({ kind: 'event', type: 't.tool_result', data: { callId, ok: status === 'completed', summary: summarize(text(j.title) || output, 160) } });
            break;
          }
          case 'usage':
            if (typeof j.input === 'number' && Number.isSafeInteger(j.input) && j.input >= 0 && typeof j.output === 'number' && Number.isSafeInteger(j.output) && j.output >= 0) out.push({ kind: 'usage', inputTokens: j.input, outputTokens: j.output, ...(typeof j.costUsd === 'number' && Number.isFinite(j.costUsd) && j.costUsd >= 0 ? { costUsd: j.costUsd } : {}) });
            break;
          case 'child':
            out.push({ kind: 'child', sessionId: text(j.sessionId), parentSessionId: typeof j.parentSessionId === 'string' ? j.parentSessionId : null, title: text(j.title), state: (['running', 'completed', 'failed', 'aborted'].includes(text(j.state)) ? text(j.state) : 'running') as 'running', error: text(j.error) || undefined });
            break;
          case 'permission': {
            const verb = ({ asked: 'asked to approve', allowed: 'approved', denied: 'denied', pending: 'waiting for approval of' } as Record<string, string>)[text(j.state)] ?? text(j.state);
            out.push({ kind: 'event', type: 't.system', data: { text: `OpenCode ${verb}: ${text(j.summary)}` } });
            break;
          }
          case 'question':
            if (j.state === 'asked') out.push({ kind: 'event', type: 't.system', data: { text: `OpenCode asked a question: ${text(j.question)}` } });
            else out.push({ kind: 'event', type: 't.system', data: { text: `OpenCode question ${text(j.state)}` } });
            break;
          case 'retry':
            out.push({ kind: 'event', type: 't.system', data: { text: `OpenCode is retrying (attempt ${num(j.attempt)}): ${text(j.message)}` } });
            break;
          case 'error': {
            const message = text(j.message) || 'error';
            const name = text(j.name);
            const status = typeof j.status === 'number' ? j.status : null;
            const f: Failure | null = name === 'ProviderAuthError' || status === 401 || status === 403 ? { kind: 'auth_expired', message }
              : status === 429 ? { kind: 'usage_limit', message }
              : name === 'UnsupportedVersion' || name === 'BridgeError' ? { kind: 'crash', message }
              : classifyFailure(message);
            out.push({ kind: 'event', type: 't.error', data: { message, failure: f?.kind } }, ...failure(f));
            break;
          }
          case 'model_mismatch':
            out.push({ kind: 'session', sessionId: null, model: text(j.served) || null, modelMismatch: { requested: text(j.requested), served: text(j.served) } });
            break;
          case 'aborted':
            out.push({ kind: 'event', type: 't.system', data: { text: 'OpenCode session aborted' } });
            break;
          case 'result':
            sawResult = true;
            if (j.ok !== true && text(j.error) && !lastFailure) {
              // A lost stream or failed approval/question delivery cannot be replayed safely.
              // Preserve the cause without turning the bridge failure into an automatic retry.
              out.push({ kind: 'event', type: 't.error', data: { message: text(j.error), failure: 'crash' } },
                ...failure({ kind: 'crash', message: text(j.error) }));
            }
            if (lastText) out.push({ kind: 'final', text: lastText });
            out.push({ kind: 'result', ok: j.ok === true, text: lastText });
            break;
          default:
            break;
        }
        return out;
      },
      end(exit) {
        return endWithoutResult(sawResult, exit, lastFailure, lastText);
      },
    };
  },
};
