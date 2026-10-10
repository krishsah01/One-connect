// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Child environment for agent runs. API-key variables would silently switch a vendor CLI from
// the user's subscription to metered billing, so they are stripped unless the agent opted in.
import type { AgentConfig } from '@acc/core';

export const METERED_ENV_VARS: Record<string, string[]> = {
  'claude-headless': [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'AWS_BEARER_TOKEN_BEDROCK',
  ],
  'codex-cli': ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY'],
  'cursor-agent-cli': ['CURSOR_API_KEY'],
  'generic-cli': ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'XAI_API_KEY', 'GROK_API_KEY', 'OPENROUTER_API_KEY'],
  relay: [],
  'opencode-server': [],
};

const ALL_METERED = [...new Set(Object.values(METERED_ENV_VARS).flat())];

/** Our own variables that must never leak into an agent process. */
const INTERNAL = /^ACC_(?!RUN_DIR$)/;

export function sanitizeEnv(agent: AgentConfig, base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; stripped: string[] } {
  const env: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];
  // Opting in keeps only this harness's own variables; other vendors' keys never leak across.
  const keep = agent.metered_opt_in && agent.provider === 'subscription' ? new Set(METERED_ENV_VARS[agent.adapter] ?? []) : new Set<string>();
  const strip = new Set(ALL_METERED.filter((k) => !keep.has(k)));
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (strip.has(k)) {
      stripped.push(k);
      continue;
    }
    if (INTERNAL.test(k)) continue;
    env[k] = v;
  }
  return { env: { ...env, ...extra }, stripped };
}

export function meteredVarsPresent(agent: AgentConfig, base: NodeJS.ProcessEnv = process.env): string[] {
  return (METERED_ENV_VARS[agent.adapter] ?? []).filter((k) => base[k]);
}
