// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Any vendor CLI that takes a prompt and prints an answer (Gemini CLI, Grok, …), configured with
// a command + argument template. Detection is limited, so billing is "declared in config".
import type { AuthStatus, BillingInfo, ModelInfo } from '@acc/core';
import { commandCompleted, endWithoutResult, stderrLine, tryJson } from './common.ts';
import { unknownUsage, type LaunchContext, type LaunchSpec, type Parsed, type StreamParser, type VendorAdapter } from './types.ts';

export function fillTemplate(args: readonly string[], vars: Record<string, string | null>): string[] {
  const out: string[] = [];
  for (const a of args) {
    // Drop "--model {model}" style pairs when the value is unset.
    const keys = [...a.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (keys.some((k) => vars[k] === null || vars[k] === undefined || vars[k] === '')) {
      if (out.length && /^-/.test(out[out.length - 1]) && a.startsWith('{')) out.pop();
      continue;
    }
    out.push(a.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k])));
  }
  return out;
}

export const genericAdapter: VendorAdapter = {
  type: 'generic-cli',
  displayName: 'Generic CLI',
  installUrl: '',
  loginHint: "Sign in with the tool's own login command",
  capabilities: { headless: true, streamingInput: false, resume: false, hostApprovals: false, mcp: false },
  binaryNames: [],
  vendorHost: 'example.com',
  knownLocations: () => [],

  async authStatus(): Promise<AuthStatus> {
    return { state: 'unknown', detail: 'generic CLIs do not report login state; check the tool itself' };
  },

  async billingMode({ agent }): Promise<BillingInfo> {
    return { mode: 'unknown', source: `declared ${agent.billing} in config (not detectable)`, overage: 'unknown', notes: ["Confirm the tool runs on your plan's included usage, not an API key."] };
  },

  async listModels({ agent }): Promise<ModelInfo[]> {
    return (agent.allowed_models ?? []).filter((m) => !m.includes('*')).map((id) => ({ id }));
  },

  async usage() {
    return unknownUsage('generic CLI');
  },

  buildLaunch(ctx: LaunchContext): LaunchSpec {
    const template = ctx.agent.args ?? (ctx.agent.stdin === 'prompt' ? [] : ['{prompt}']);
    const args = fillTemplate(template, { prompt: ctx.prompt, model: ctx.model, cwd: ctx.cwd, effort: ctx.effort });
    const usesPromptArg = template.some((a) => a.includes('{prompt}'));
    return {
      command: ctx.binary,
      args,
      cwd: ctx.cwd,
      stdin: usesPromptArg || ctx.agent.stdin === 'none' ? { mode: 'none' } : { mode: 'close', initial: ctx.prompt },
    };
  },

  createParser(): StreamParser {
    const lines: string[] = [];
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
        if (j && typeof j.command === 'string' && 'exit_code' in j) return commandCompleted(j.command, Number(j.exit_code), String(j.output ?? ''));
        lines.push(line);
        return line.trim() ? [{ kind: 'event', type: 't.message', data: { role: 'assistant', text: line } }] : [];
      },
      end(exit) {
        return endWithoutResult(false, exit, lastFailure, lines.join('\n').trim());
      },
    };
  },
};
