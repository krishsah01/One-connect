// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Cursor agent CLI (`cursor-agent -p --output-format stream-json`), signed in with Cursor.
// On-demand (usage-based) billing is an account setting the CLI can't report, so it is shown as
// unknown with a banner rather than assumed off.
import os from 'node:os';
import path from 'node:path';
import type { AuthStatus, BillingInfo, ModelInfo } from '@acc/core';
import { ADAPTER_PROFILES } from '@acc/core';
import { run } from '../../exec.ts';
import { accountFingerprint, commandCompleted, endWithoutResult, maskEmail, relPath, stderrLine, summarize, textOf, tryJson } from './common.ts';
import { classifyFailure } from './failures.ts';
import { unknownUsage, type LaunchContext, type LaunchSpec, type Parsed, type StreamParser, type VendorAdapter } from './types.ts';

const SHELL = ['shellToolCall', 'terminalToolCall', 'runTerminalCommandToolCall'];
const EDIT = { writeToolCall: 'add', editToolCall: 'modify', strReplaceToolCall: 'modify', deleteToolCall: 'delete' } as const;

/** The `.cursor/mcp.json` written into worktrees; scope checks and hooks ignore it. */
export const CURSOR_MCP_FILE = '.cursor/mcp.json';

export const cursorAdapter: VendorAdapter = {
  type: 'cursor-agent-cli',
  ...ADAPTER_PROFILES['cursor-agent-cli'],
  binaryNames: ['cursor-agent'],
  vendorHost: 'api2.cursor.sh',
  knownLocations: () => [path.join(os.homedir(), '.local', 'bin', 'cursor-agent')],

  async authStatus({ binary, env }): Promise<AuthStatus> {
    const r = await run(binary, ['status'], { env, timeoutMs: 20_000 });
    if (r.error) return { state: 'not_installed', detail: r.error, fix: `Install the Cursor CLI: ${this.installUrl}` };
    const out = `${r.stdout}\n${r.stderr}`;
    if (/logged in/i.test(out) && !/not logged in/i.test(out)) {
      const about = await run(binary, ['about'], { env, timeoutMs: 20_000 });
      const tier = /Subscription Tier\s+(.+)/i.exec(about.stdout)?.[1]?.trim();
      const email = /logged in as\s+(\S+@\S+)/i.exec(out)?.[1] ?? null;
      const account = accountFingerprint('cursor', email);
      if (env.CURSOR_API_KEY) return { state: 'logged_in', detail: 'Cursor API key accepted', ...(tier ? { tier } : {}) };
      return { state: 'logged_in', detail: 'signed in to Cursor', tier, ...(account ? { account } : {}), ...(maskEmail(email) ? { accountLabel: maskEmail(email) } : {}) };
    }
    if (/not logged in|login/i.test(out)) return { state: 'expired', detail: 'not signed in', fix: this.loginHint };
    return { state: 'unknown', detail: out.trim().slice(0, 200) };
  },

  async billingMode({ binary, env }): Promise<BillingInfo> {
    const notes = ['Cursor on-demand usage is an account setting the CLI cannot report: confirm it is off at cursor.com/dashboard.'];
    if (env.CURSOR_API_KEY) return { mode: 'metered', source: 'CURSOR_API_KEY is set', overage: 'unknown', notes };
    const about = await run(binary, ['about'], { env, timeoutMs: 20_000 });
    const tier = /Subscription Tier\s+(.+)/i.exec(about.stdout)?.[1]?.trim();
    if (tier && !/free|none/i.test(tier)) return { mode: 'subscription', source: `cursor-agent about: ${tier} plan`, overage: 'unknown', notes };
    return { mode: 'unknown', source: `cursor-agent about${tier ? `: ${tier}` : ''}`, overage: 'unknown', notes };
  },

  async listModels({ binary, env }): Promise<ModelInfo[]> {
    const r = await run(binary, ['models'], { env, timeoutMs: 30_000 });
    const out: ModelInfo[] = [];
    for (const l of r.stdout.split('\n')) {
      const m = /^\s*([A-Za-z0-9][\w.:\-[\]=,]*)\s+-\s+(.+?)\s*$/.exec(l.replace(/[​-‍]/g, ''));
      if (m) out.push({ id: m[1], label: m[2].replace(/\s*\((?:default|current)\)\s*$/i, '') });
    }
    return out;
  },

  async usage() {
    return unknownUsage('Cursor CLI does not expose included-usage counters');
  },

  buildLaunch(ctx: LaunchContext): LaunchSpec {
    const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--workspace', ctx.cwd];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.resume) args.push('--resume', ctx.resume.sessionId);
    if (ctx.agent.allow_shell) args.push('--force');
    const files: LaunchSpec['files'] = [];
    if (ctx.mcp) {
      args.push('--approve-mcps');
      files.push({ path: path.join(ctx.cwd, CURSOR_MCP_FILE), content: JSON.stringify({ mcpServers: { acc: { command: ctx.mcp.command, args: ctx.mcp.args } } }, null, 2) });
    }
    args.push(ctx.resume ? ctx.resume.message : ctx.prompt);
    return { command: ctx.binary, args, cwd: ctx.cwd, stdin: { mode: 'none' }, files };
  },

  createParser({ cwd }): StreamParser {
    const started = new Map<string, string>();
    let lastText = '';
    let sawResult = false;
    let lastFailure: Parsed | null = null;
    // With --stream-partial-output assistant events are deltas: build the message up live and
    // record it once something else happens (tool call, result, end).
    let buffer = '';
    const flush = (): Parsed[] => {
      if (!buffer.trim()) {
        buffer = '';
        return [];
      }
      const text = buffer;
      buffer = '';
      lastText = text;
      return [{ kind: 'event', type: 't.message', data: { role: 'assistant', text } }, { kind: 'live', role: 'assistant', text: '' }];
    };
    return {
      line(stream, line) {
        if (stream === 'live') return [];
        if (stream === 'stderr') {
          const out = stderrLine(line);
          lastFailure = out.find((p) => p.kind === 'failure') ?? lastFailure;
          return out;
        }
        const j = tryJson(line);
        if (!j) return line.trim() ? [{ kind: 'event', type: 't.raw', data: { stream: 'stdout', line } }] : [];
        const out: Parsed[] = [];
        switch (j.type) {
          case 'system':
            if (j.subtype === 'init') {
              out.push({ kind: 'session', sessionId: (j.session_id as string) ?? null, model: (j.model as string) ?? null, apiKeySource: (j.apiKeySource as string) ?? null });
              out.push({ kind: 'event', type: 't.system', data: { text: `session started on ${String(j.model ?? 'unknown model')}` } });
            }
            break;
          case 'assistant': {
            const text = textOf((j.message as { content?: unknown } | undefined)?.content);
            if (!text) break;
            // Cumulative (or a final full copy) replaces; otherwise it's a delta.
            buffer = buffer && text.startsWith(buffer) ? text : buffer + text;
            out.push({ kind: 'live', role: 'assistant', text: buffer });
            break;
          }
          case 'tool_call': {
            out.push(...flush());
            const id = String(j.call_id ?? '');
            const tc = (j.tool_call ?? {}) as Record<string, Record<string, unknown>>;
            const [kind, body] = Object.entries(tc)[0] ?? ['unknown', {}];
            const a = (body?.args ?? {}) as Record<string, unknown>;
            const res = (body?.result ?? {}) as Record<string, Record<string, unknown> | undefined>;
            if (SHELL.includes(kind)) {
              const command = String(a.command ?? a.cmd ?? started.get(id) ?? '');
              if (j.subtype === 'started') {
                started.set(id, command);
                out.push({ kind: 'event', type: 't.command', data: { callId: id, command, status: 'started' } });
              } else {
                const ok = res.success;
                const fail = res.failure ?? res.rejected ?? res.error;
                const output = `${String(ok?.stdout ?? ok?.output ?? fail?.stdout ?? '')}${String(ok?.stderr ?? fail?.stderr ?? fail?.message ?? '')}`;
                const exitCode = typeof ok?.exitCode === 'number' ? ok.exitCode : typeof fail?.exitCode === 'number' ? fail.exitCode : ok ? 0 : 1;
                out.push(...commandCompleted(command, exitCode, output, id));
              }
            } else if (kind in EDIT) {
              if (j.subtype === 'completed' && !res.failure && !res.rejected) {
                const p = String(a.path ?? (res.success as Record<string, unknown> | undefined)?.path ?? '');
                out.push({ kind: 'event', type: 't.file_edit', data: { path: relPath(cwd, p), change: EDIT[kind as keyof typeof EDIT] } });
              }
            } else if (j.subtype === 'started') {
              out.push({ kind: 'event', type: 't.tool_call', data: { callId: id, name: kind.replace(/ToolCall$/, ''), summary: summarize(a) } });
            } else {
              out.push({ kind: 'event', type: 't.tool_result', data: { callId: id, ok: !res.failure && !res.rejected && !res.error, summary: kind.replace(/ToolCall$/, '') } });
            }
            break;
          }
          case 'result': {
            out.push(...flush());
            sawResult = true;
            const u = (j.usage ?? {}) as Record<string, number>;
            if (u.inputTokens !== undefined || u.outputTokens !== undefined) out.push({ kind: 'usage', inputTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0), outputTokens: u.outputTokens ?? 0 });
            const text = typeof j.result === 'string' ? j.result : lastText;
            if (text) out.push({ kind: 'final', text });
            const ok = j.is_error !== true && j.subtype !== 'error';
            if (!ok) {
              const f = classifyFailure(String(j.result ?? j.error ?? ''));
              if (f) out.push({ kind: 'failure', failure: f });
              out.push({ kind: 'event', type: 't.error', data: { message: String(j.result ?? 'error'), failure: f?.kind } });
            }
            out.push({ kind: 'result', ok, text });
            break;
          }
          case 'error': {
            const message = String(j.message ?? j.error ?? 'error');
            const f = classifyFailure(message);
            out.push({ kind: 'event', type: 't.error', data: { message, failure: f?.kind } });
            if (f) lastFailure = { kind: 'failure', failure: f };
            break;
          }
        }
        return out;
      },
      end(exit) {
        const pending = flush();
        return [...pending, ...endWithoutResult(sawResult, exit, lastFailure, lastText)];
      },
    };
  },
};
