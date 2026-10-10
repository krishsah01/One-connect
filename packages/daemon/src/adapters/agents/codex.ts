// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// OpenAI Codex CLI (`codex exec --json`), signed in with ChatGPT. Models come from the CLI's own
// catalog (`codex debug models`); plan usage comes from the rate_limits Codex records in the
// session files of runs this control center started (never other sessions).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthStatus, BillingInfo, Effort, ModelInfo, UsageInfo, UsageWindow } from '@acc/core';
import { EFFORTS } from '@acc/core';
import { run } from '../../exec.ts';
import { commandCompleted, endWithoutResult, relPath, stderrLine, summarize, tryJson } from './common.ts';
import { classifyFailure } from './failures.ts';
import { unknownUsage, type LaunchContext, type LaunchSpec, type Parsed, type StreamParser, type VendorAdapter } from './types.ts';

const toml = (s: string) => JSON.stringify(s); // JSON string escapes are valid TOML basic strings

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

function findRollout(dir: string, threadId: string, depth = 0): string | null {
  if (depth > 4) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Newest date folders first.
  for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(threadId)) return p;
    if (e.isDirectory()) {
      const f = findRollout(p, threadId, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

function findRateLimits(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.rate_limits && typeof o.rate_limits === 'object') return o.rate_limits as Record<string, unknown>;
  for (const x of Object.values(o)) {
    const r = findRateLimits(x);
    if (r) return r;
  }
  return null;
}

export function usageFromRateLimits(rl: Record<string, unknown>, source: string): UsageInfo {
  const windows: UsageWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = rl[key] as { used_percent?: number; window_minutes?: number; resets_at?: number; resets_in_seconds?: number } | undefined;
    if (!w) continue;
    const resets = w.resets_at ? new Date(w.resets_at * 1000).toISOString() : w.resets_in_seconds ? new Date(Date.now() + w.resets_in_seconds * 1000).toISOString() : null;
    const mins = w.window_minutes;
    windows.push({ name: mins ? (mins <= 600 ? `${Math.round(mins / 60)}h window` : `${Math.round(mins / 1440)}d window`) : key, usedPercent: w.used_percent ?? null, resetsAt: resets, windowMinutes: mins });
  }
  const max = Math.max(...windows.map((w) => w.usedPercent ?? 0), 0);
  return { windows, status: windows.length === 0 ? 'unknown' : max >= 100 ? 'limited' : max >= 85 ? 'near_limit' : 'ok', checkedAt: new Date().toISOString(), source };
}

export const codexAdapter: VendorAdapter = {
  type: 'codex-cli',
  displayName: 'Codex CLI',
  installUrl: 'https://developers.openai.com/codex/cli',
  loginHint: 'Run `codex login` in a terminal and choose "Sign in with ChatGPT"',
  capabilities: { headless: true, streamingInput: false, resume: true, hostApprovals: false, mcp: true },
  binaryNames: ['codex'],
  vendorHost: 'chatgpt.com',
  knownLocations: () => [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
    path.join(os.homedir(), '.local', 'bin', 'codex'),
  ],

  async authStatus({ binary, env }): Promise<AuthStatus> {
    const r = await run(binary, ['login', 'status'], { env, timeoutMs: 20_000 });
    if (r.error) return { state: 'not_installed', detail: r.error, fix: `Install Codex CLI: ${this.installUrl}` };
    const out = `${r.stdout}\n${r.stderr}`;
    if (/logged in using chatgpt/i.test(out)) return { state: 'logged_in', detail: 'signed in with ChatGPT' };
    if (/logged in using an api key|api key/i.test(out) && /logged in/i.test(out)) return { state: 'logged_in', detail: 'signed in with an API key' };
    if (/not logged in/i.test(out)) return { state: 'expired', detail: 'not signed in', fix: this.loginHint };
    return { state: 'unknown', detail: out.trim().slice(0, 200) };
  },

  async billingMode({ binary, env }): Promise<BillingInfo> {
    const r = await run(binary, ['login', 'status'], { env, timeoutMs: 20_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    const notes = ['ChatGPT plans can draw on purchased Codex credits past the plan limit; confirm auto-recharge is off.'];
    if (/logged in using chatgpt/i.test(out)) return { mode: 'subscription', source: 'codex login status: ChatGPT', overage: 'unknown', notes };
    if (/api key/i.test(out)) return { mode: 'metered', source: 'codex login status: API key', overage: 'unknown', notes };
    return { mode: 'unknown', source: 'codex login status', overage: 'unknown', notes };
  },

  async listModels({ binary, env }): Promise<ModelInfo[]> {
    const r = await run(binary, ['debug', 'models'], { env, timeoutMs: 30_000 });
    const j = tryJson(r.stdout);
    const list = (j?.models ?? []) as Record<string, unknown>[];
    return list.map((m) => {
      const up = m.upgrade as unknown;
      const levels = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []) as { effort?: string }[];
      return {
        id: String(m.slug),
        label: typeof m.display_name === 'string' ? m.display_name : undefined,
        priority: typeof m.priority === 'number' ? m.priority : undefined,
        hidden: m.visibility !== 'list',
        efforts: levels.map((l) => l.effort).filter((e): e is Effort => (EFFORTS as readonly string[]).includes(String(e))),
        upgrade: typeof up === 'string' ? up : up && typeof up === 'object' ? String((up as Record<string, unknown>).model ?? (up as Record<string, unknown>).slug ?? '') || undefined : undefined,
      };
    });
  },

  async usage({ env, sessionIds }): Promise<UsageInfo> {
    const dir = path.join(codexHome(env), 'sessions');
    for (const id of [...sessionIds].reverse()) {
      const f = findRollout(dir, id);
      if (!f) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"rate_limits"'));
      for (const l of lines.reverse()) {
        const rl = findRateLimits(tryJson(l));
        if (rl) return usageFromRateLimits(rl, `Codex session ${id.slice(0, 8)} rate limits`);
      }
    }
    return unknownUsage('no Codex run recorded rate limits yet');
  },

  buildLaunch(ctx: LaunchContext): LaunchSpec {
    const common: string[] = ['--json'];
    const provider = ctx.agent.provider;
    const env: Record<string, string> = {};
    if (provider !== 'subscription' && ctx.providerHome) env.CODEX_HOME = ctx.providerHome;
    if (provider === 'ollama' || provider === 'lmstudio') {
      common.push('--oss', '--local-provider', provider);
      if (ctx.agent.base_url) env.CODEX_OSS_BASE_URL = `${ctx.agent.base_url.replace(/\/$/, '')}/v1`;
    } else if (provider === 'openrouter') {
      const base = ctx.agent.base_url ?? 'https://openrouter.ai/api/v1';
      common.push(
        '-c', 'model_provider="openrouter"',
        '-c', 'model_providers.openrouter.name="OpenRouter"',
        '-c', `model_providers.openrouter.base_url=${toml(base)}`,
        '-c', 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
        '-c', `model_providers.openrouter.wire_api=${toml(ctx.agent.wire_api)}`,
      );
    } else if (provider === 'openai-api') {
      common.push('-c', 'forced_login_method="api"');
    }
    if (ctx.model) common.push('-m', ctx.model);
    if (ctx.effort) common.push('-c', `model_reasoning_effort=${toml(ctx.effort)}`);
    common.push('-c', 'approval_policy="never"');
    if (ctx.policies.privacy.strict_mcp) common.push('--ignore-user-config');
    if (ctx.mcp) {
      common.push(
        '-c', `mcp_servers.acc.command=${toml(ctx.mcp.command)}`,
        '-c', `mcp_servers.acc.args=[${ctx.mcp.args.map(toml).join(',')}]`,
        '-c', 'mcp_servers.acc.tool_timeout_sec=604800',
        '-c', 'mcp_servers.acc.startup_timeout_sec=30',
      );
    }
    let args: string[];
    if (ctx.resume) {
      args = ['exec', 'resume', ...common, '-c', 'sandbox_mode="workspace-write"'];
      if (ctx.gitCommonDir) args.push('-c', `sandbox_workspace_write.writable_roots=[${toml(ctx.gitCommonDir)}]`);
      args.push(ctx.resume.sessionId, '-');
    } else {
      args = ['exec', ...common, '-s', 'workspace-write', '-C', ctx.cwd, '--color', 'never'];
      if (ctx.gitCommonDir) args.push('--add-dir', ctx.gitCommonDir);
      args.push('-');
    }
    return { command: ctx.binary, args, cwd: ctx.cwd, env, stdin: { mode: 'close', initial: ctx.resume ? ctx.resume.message : ctx.prompt } };
  },

  createParser({ cwd }): StreamParser {
    let lastText = '';
    let sawResult = false;
    let lastFailure: Parsed | null = null;
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
        const item = (j.item ?? {}) as Record<string, unknown>;
        switch (j.type) {
          case 'thread.started':
            out.push({ kind: 'session', sessionId: (j.thread_id as string) ?? null, model: null });
            break;
          case 'item.started':
            if (item.type === 'command_execution') out.push({ kind: 'event', type: 't.command', data: { callId: String(item.id ?? ''), command: String(item.command ?? ''), status: 'started' } });
            else if (item.type === 'mcp_tool_call') out.push({ kind: 'event', type: 't.tool_call', data: { callId: String(item.id ?? ''), name: `${String(item.server ?? 'mcp')}.${String(item.tool ?? '?')}`, summary: summarize(item.arguments ?? '') } });
            break;
          case 'item.completed':
            switch (item.type) {
              case 'agent_message':
                lastText = String(item.text ?? '');
                if (lastText.trim()) out.push({ kind: 'event', type: 't.message', data: { role: 'assistant', text: lastText } });
                break;
              case 'reasoning':
                if (String(item.text ?? '').trim()) out.push({ kind: 'event', type: 't.reasoning', data: { text: String(item.text) } });
                break;
              case 'command_execution':
                out.push(...commandCompleted(String(item.command ?? ''), typeof item.exit_code === 'number' ? item.exit_code : null, String(item.aggregated_output ?? ''), String(item.id ?? '')));
                break;
              case 'file_change':
                for (const c of (Array.isArray(item.changes) ? item.changes : []) as { path?: string; kind?: string }[]) {
                  out.push({ kind: 'event', type: 't.file_edit', data: { path: relPath(cwd, String(c.path ?? '')), change: c.kind === 'add' ? 'add' : c.kind === 'delete' ? 'delete' : 'modify' } });
                }
                break;
              case 'mcp_tool_call':
                out.push({ kind: 'event', type: 't.tool_result', data: { callId: String(item.id ?? ''), ok: item.status !== 'failed', summary: `${String(item.server ?? 'mcp')}.${String(item.tool ?? '?')} ${String(item.status ?? '')}` } });
                break;
              case 'web_search':
                out.push({ kind: 'event', type: 't.tool_call', data: { name: 'web_search', summary: String(item.query ?? '') } });
                break;
              case 'error': {
                const f = classifyFailure(String(item.message ?? ''));
                out.push({ kind: 'event', type: 't.error', data: { message: String(item.message ?? 'error'), failure: f?.kind } });
                break;
              }
            }
            break;
          case 'turn.completed': {
            sawResult = true;
            const u = (j.usage ?? {}) as Record<string, number>;
            out.push({ kind: 'usage', inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 });
            if (lastText) out.push({ kind: 'final', text: lastText });
            out.push({ kind: 'result', ok: true, text: lastText });
            break;
          }
          case 'turn.failed': {
            sawResult = true;
            const message = String((j.error as { message?: string } | undefined)?.message ?? 'turn failed');
            const f = classifyFailure(message);
            out.push({ kind: 'event', type: 't.error', data: { message, failure: f?.kind } });
            if (f) out.push({ kind: 'failure', failure: f });
            if (lastText) out.push({ kind: 'final', text: lastText });
            out.push({ kind: 'result', ok: false, text: lastText });
            break;
          }
          case 'error': {
            const message = String(j.message ?? 'error');
            const f = classifyFailure(message);
            out.push({ kind: 'event', type: 't.error', data: { message, failure: f?.kind } });
            if (f) lastFailure = { kind: 'failure', failure: f };
            break;
          }
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
