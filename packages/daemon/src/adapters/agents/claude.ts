// SPDX-License-Identifier: Apache-2.0
// Claude Code headless (`claude -p --output-format stream-json`), signed in with the user's
// Claude subscription. Tool-permission prompts route to the control center through the acc MCP
// server's permission_prompt tool, so a pending approval is visible (and stall-detected).
import os from 'node:os';
import path from 'node:path';
import type { AuthStatus, BillingInfo, ModelInfo, UsageInfo } from '@acc/core';
import { run } from '../../exec.ts';
import { commandCompleted, endWithoutResult, relPath, stderrLine, summarize, textOf, tryJson } from './common.ts';
import { classifyFailure } from './failures.ts';
import { unknownUsage, type LaunchContext, type LaunchSpec, type Parsed, type ProbeEnv, type StreamParser, type VendorAdapter } from './types.ts';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Aliases always resolve to the latest model of the line; the resolved id comes back in `init`. */
const ALIASES: ModelInfo[] = [
  { id: 'fable', label: 'Fable (latest)', priority: 1 },
  { id: 'opus', label: 'Opus (latest)', priority: 2 },
  { id: 'sonnet', label: 'Sonnet (latest)', priority: 3 },
  { id: 'haiku', label: 'Haiku (latest)', priority: 4 },
];

/** Claude Code's rate_limit_event → usage windows (utilization 0..1 → percent). */
export function claudeUsage(info: Record<string, unknown>): UsageInfo {
  const windows = Object.entries((info.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: number }>).map(([name, w]) => ({
    name: name.replace('five_hour', '5h window').replace('seven_day', '7d window').replace(/_/g, ' '),
    usedPercent: typeof w.utilization === 'number' ? Math.round(w.utilization * 100) : null,
    resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
  }));
  const max = Math.max(0, ...windows.map((w) => w.usedPercent ?? 0));
  return { windows, status: info.status === 'rejected' || max >= 100 ? 'limited' : max >= 85 ? 'near_limit' : windows.length ? 'ok' : 'unknown', checkedAt: new Date().toISOString(), source: 'Claude Code rate_limit_event' };
}

export const claudeAdapter: VendorAdapter = {
  type: 'claude-headless',
  displayName: 'Claude Code',
  installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  loginHint: 'Run `claude auth login` in a terminal and sign in with your Claude account',
  capabilities: { headless: true, streamingInput: true, resume: true, hostApprovals: true, mcp: true },
  binaryNames: ['claude'],
  vendorHost: 'api.anthropic.com',
  knownLocations: () => [path.join(os.homedir(), '.local', 'bin', 'claude'), path.join(os.homedir(), '.claude', 'local', 'claude')],

  async authStatus({ binary, env }): Promise<AuthStatus> {
    const r = await run(binary, ['auth', 'status'], { env, timeoutMs: 20_000 });
    if (r.error) return { state: 'not_installed', detail: r.error, fix: `Install Claude Code: ${this.installUrl}` };
    const j = tryJson(r.stdout);
    if (!j) return { state: 'unknown', detail: (r.stdout || r.stderr).trim().slice(0, 200) };
    if (j.loggedIn === true) return { state: 'logged_in', detail: `signed in via ${String(j.authMethod ?? 'unknown')}` };
    return { state: 'expired', detail: 'not signed in', fix: this.loginHint };
  },

  async billingMode({ binary, env }): Promise<BillingInfo> {
    const r = await run(binary, ['auth', 'status'], { env, timeoutMs: 20_000 });
    const j = tryJson(r.stdout);
    const notes = ['Claude plans can allow paid "extra usage" past the plan limit; confirm it is off in claude.ai settings.'];
    if (!j) return { mode: 'unknown', source: 'claude auth status (unreadable)', overage: 'unknown', notes };
    const method = String(j.authMethod ?? '');
    const provider = String(j.apiProvider ?? 'firstParty');
    if (provider !== 'firstParty') return { mode: 'metered', source: `claude auth status: provider ${provider}`, overage: 'unknown', notes };
    if (method === 'claude.ai') return { mode: 'subscription', source: 'claude auth status: claude.ai login', overage: 'unknown', notes };
    if (/api|console|key/i.test(method)) return { mode: 'metered', source: `claude auth status: ${method}`, overage: 'unknown', notes };
    return { mode: 'unknown', source: `claude auth status: ${method || 'unknown method'}`, overage: 'unknown', notes };
  },

  async listModels({ agent }): Promise<ModelInfo[]> {
    const extra = (agent.allowed_models ?? []).filter((m) => !m.includes('*') && !ALIASES.some((a) => a.id === m)).map((id) => ({ id }));
    return [...ALIASES, ...extra];
  },

  async usage() {
    return unknownUsage('reported by Claude Code during runs (rate_limit_event)');
  },

  encodeMessage(text: string): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  },

  buildLaunch(ctx: LaunchContext): LaunchSpec {
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.effort) args.push('--effort', ctx.effort);
    if (ctx.resume) args.push('--resume', ctx.resume.sessionId);
    const files: LaunchSpec['files'] = [];
    if (ctx.mcp) {
      const mcpFile = path.join(ctx.runDir, 'claude-mcp.json');
      files.push({ path: mcpFile, content: JSON.stringify({ mcpServers: { acc: { type: 'stdio', command: ctx.mcp.command, args: ctx.mcp.args } } }, null, 2) });
      args.push('--mcp-config', mcpFile, '--permission-prompt-tool', 'mcp__acc__permission_prompt');
    }
    if (ctx.policies.privacy.strict_mcp) args.push('--strict-mcp-config');
    args.push('--permission-mode', 'default');
    const allowed = [...ctx.allowedTools, ...(ctx.mcp ? ['get_assignment', 'post_handoff', 'submit_review', 'report_finding', 'ask_human', 'get_brief', 'get_team', 'read_messages', 'send_team_message', 'ack_team_message', 'get_design_system', 'get_design_skill', 'search_context', 'ask_project', 'read_note', 'query_graph', 'graph_path', 'explain_node', 'list_skills', 'get_skill', 'register_design_mock', 'record_mock_evidence', 'list_connector_tools'].map((t) => `mcp__acc__${t}`) : [])];
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    if (ctx.gitCommonDir) args.push('--add-dir', ctx.gitCommonDir);
    return {
      command: ctx.binary,
      args,
      cwd: ctx.cwd,
      // Long human answers must not time out the ask_human / permission tools.
      env: { MCP_TOOL_TIMEOUT: String(7 * 24 * 3600 * 1000) },
      stdin: { mode: 'stream', initial: this.encodeMessage!(ctx.resume ? ctx.resume.message : ctx.prompt), closeOnMatch: '"type":"result"' },
      files,
      // Token deltas stream to the live view only; the complete messages follow in stdout.
      ephemeralMatch: '"type":"stream_event"',
    };
  },

  createParser({ cwd }): StreamParser {
    const pending = new Map<string, { name: string; command?: string }>();
    let sessionModel: string | null = null;
    let servedModel: string | null = null;
    let sessionId: string | null = null;
    let lastText = '';
    let sawResult = false;
    let lastFailure: Parsed | null = null;
    let liveText = '';
    let liveThinking = '';
    return {
      line(stream, line) {
        if (stream === 'live') {
          const j = tryJson(line);
          const ev = (j?.event ?? {}) as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
          if (ev.type === 'message_start') {
            liveText = liveThinking = '';
            return [];
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            liveText += ev.delta.text;
            return [{ kind: 'live', role: 'assistant', text: liveText }];
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            liveThinking += ev.delta.thinking;
            return [{ kind: 'live', role: 'reasoning', text: liveThinking }];
          }
          return [];
        }
        if (stream === 'stderr') {
          const out = stderrLine(line);
          lastFailure = out.find((p) => p.kind === 'failure') ?? lastFailure;
          return out;
        }
        const j = tryJson(line);
        if (!j) return line.trim() ? [{ kind: 'event', type: 't.raw', data: { stream: 'stdout', line } }] : [];
        const out: Parsed[] = [];
        const msg = j.message as { content?: unknown } | undefined;
        switch (j.type) {
          case 'system':
            if (j.subtype === 'init') {
              sessionModel = (j.model as string) ?? null;
              sessionId = (j.session_id as string) ?? null;
              out.push({ kind: 'session', sessionId, model: sessionModel, apiKeySource: (j.apiKeySource as string) ?? null });
              out.push({ kind: 'event', type: 't.system', data: { text: `session started on ${String(j.model ?? 'unknown model')}` } });
            } else out.push({ kind: 'event', type: 't.system', data: { text: `system: ${String(j.subtype ?? 'event')}` } });
            break;
          case 'assistant': {
            // The model that actually served the turn can differ from the one the session started on.
            const served = typeof (msg as { model?: unknown } | undefined)?.model === 'string' ? String((msg as { model: string }).model) : null;
            if (served && served !== servedModel && served !== '<synthetic>') {
              if (sessionModel && served !== sessionModel) {
                out.push({ kind: 'event', type: 't.system', data: { text: `model mismatch: session requested ${sessionModel}, this turn was served by ${served}` } });
                out.push({ kind: 'session', sessionId, model: served, modelMismatch: { requested: sessionModel, served } });
              }
              servedModel = served;
            }
            // The complete message replaces whatever was streaming.
            if (liveText || liveThinking) {
              liveText = liveThinking = '';
              out.push({ kind: 'live', role: 'assistant', text: '' }, { kind: 'live', role: 'reasoning', text: '' });
            }
            for (const c of (Array.isArray(msg?.content) ? msg.content : []) as Record<string, unknown>[]) {
              if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
                lastText = c.text;
                out.push({ kind: 'event', type: 't.message', data: { role: 'assistant', text: c.text } });
              } else if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) {
                out.push({ kind: 'event', type: 't.reasoning', data: { text: c.thinking } });
              } else if (c.type === 'tool_use') {
                const name = String(c.name);
                const input = (c.input ?? {}) as Record<string, unknown>;
                const id = String(c.id);
                if (name === 'Bash') {
                  pending.set(id, { name, command: String(input.command ?? '') });
                  out.push({ kind: 'event', type: 't.command', data: { callId: id, command: String(input.command ?? ''), status: 'started' } });
                } else if (EDIT_TOOLS.has(name)) {
                  pending.set(id, { name });
                  const p = String(input.file_path ?? input.notebook_path ?? '');
                  out.push({ kind: 'event', type: 't.file_edit', data: { path: relPath(cwd, p), change: name === 'Write' ? 'add' : 'modify' } });
                } else {
                  pending.set(id, { name });
                  out.push({ kind: 'event', type: 't.tool_call', data: { callId: id, name, summary: summarize(input) } });
                }
              }
            }
            break;
          }
          case 'user':
            for (const c of (Array.isArray(msg?.content) ? msg.content : []) as Record<string, unknown>[]) {
              if (c.type !== 'tool_result') continue;
              const id = String(c.tool_use_id);
              const p = pending.get(id);
              pending.delete(id);
              const text = textOf(c.content);
              if (p?.name === 'Bash') out.push(...commandCompleted(p.command ?? '', c.is_error ? 1 : 0, text, id));
              else if (!p || !EDIT_TOOLS.has(p.name) || c.is_error) out.push({ kind: 'event', type: 't.tool_result', data: { callId: id, ok: !c.is_error, summary: summarize(text) } });
            }
            break;
          case 'result': {
            sawResult = true;
            const u = (j.usage ?? {}) as Record<string, number>;
            out.push({ kind: 'usage', inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined });
            const text = typeof j.result === 'string' ? j.result : lastText;
            if (text) out.push({ kind: 'final', text });
            const denials = Array.isArray(j.permission_denials) ? j.permission_denials.length : 0;
            if (denials) out.push({ kind: 'event', type: 't.system', data: { text: `${denials} tool use(s) were denied` } });
            const ok = j.is_error !== true && (j.subtype === 'success' || j.subtype === undefined);
            if (!ok) {
              const f = classifyFailure(String(j.result ?? j.subtype ?? ''));
              if (f) out.push({ kind: 'failure', failure: f });
              out.push({ kind: 'event', type: 't.error', data: { message: String(j.result ?? j.subtype ?? 'error'), failure: f?.kind } });
            }
            out.push({ kind: 'result', ok, text });
            break;
          }
          case 'rate_limit_event': {
            const info = (j.rate_limit_info ?? {}) as Record<string, unknown>;
            const usage = claudeUsage(info);
            const overage = { enabled: info.overageStatus === 'allowed', inUse: info.isUsingOverage === true || info.overageInUse === true };
            out.push({ kind: 'plan_usage', usage, overage });
            out.push({ kind: 'event', type: 't.system', data: { text: `plan usage: ${usage.windows.map((w) => `${w.name} ${w.usedPercent ?? '?'}%`).join(', ') || 'n/a'}${overage.inUse ? ' · PAID OVERAGE IN USE' : overage.enabled ? ' · paid overage enabled' : ''}` } });
            if (info.status === 'rejected' && !overage.inUse) out.push({ kind: 'failure', failure: { kind: 'usage_limit', message: `${String(info.rateLimitType ?? 'plan')} limit reached`, resetsAt: typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : null } });
            break;
          }
          default: {
            const type = String(j.type ?? 'unknown');
            out.push({ kind: 'event', type: 't.system', data: { text: `${type}: ${summarize(j, 200)}` } });
            if (/rate_limit|usage_limit/.test(type) && /limited|exceeded|rejected/i.test(JSON.stringify(j))) {
              const f = classifyFailure(`usage limit ${JSON.stringify(j)}`);
              if (f) out.push({ kind: 'failure', failure: f });
            }
          }
        }
        return out;
      },
      end(exit) {
        return endWithoutResult(sawResult, exit, lastFailure, lastText);
      },
    };
  },
};
