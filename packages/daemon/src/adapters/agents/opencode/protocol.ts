// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// OpenCode v1.18.35 (MIT), inspected against the official tagged SDK/source on 2026-10-07.
// Docs/provenance: docs/adapter-protocols.md. No vendor binary or live model was run.
import path from 'node:path';
import type { AgentConfig } from '@acc/core';
import { ollamaBase } from '../ollama-cloud.ts';

export const OPENCODE_PROTOCOL = 'opencode-server/2';
export const SUPPORTED_VERSIONS: readonly string[] = ['1.18.35'];
/** Catalog compatibility only; acceptance below is an exact release allowlist. */
export const SUPPORTED_SERIES: readonly string[] = ['1.18'];
export function supportedSeries(_env: NodeJS.ProcessEnv = process.env): string[] { return [...SUPPORTED_SERIES]; }
export function seriesOf(version: string | null | undefined): string | null {
  const m = /^v?(\d+)\.(\d+)\.\d+$/.exec((version ?? '').trim());
  return m ? `${m[1]}.${m[2]}` : null;
}
export interface VersionVerdict { ok: boolean; series: string | null; message: string }
export function checkVersion(version: string | null | undefined, _env: NodeJS.ProcessEnv = process.env): VersionVerdict {
  const v = (version ?? '').trim().replace(/^v/, '');
  const series = seriesOf(v);
  if (!v) return { ok: false, series, message: `could not read the OpenCode version; supported release: ${SUPPORTED_VERSIONS.join(', ')}` };
  if (!SUPPORTED_VERSIONS.includes(v)) return { ok: false, series, message: `OpenCode ${v} is not a supported protocol version (supported release: ${SUPPORTED_VERSIONS.join(', ')}). Unverified patches, development builds and environment overrides are refused.` };
  return { ok: true, series, message: `OpenCode ${v} matches the source-verified protocol ${OPENCODE_PROTOCOL}; live verification pending` };
}

/** Documented v1 API from the pinned generated SDK; no legacy-route fallback. */
export function permissionReply(id: string, allow: boolean) {
  return { path: `/permission/${encodeURIComponent(id)}/reply`, body: { reply: allow ? 'once' : 'reject' } };
}
export function assertServerContract(value: unknown): void {
  const spec = value as { openapi?: string; paths?: Record<string, Record<string, unknown>> } | null;
  const required: [string, string][] = [['/global/health', 'get'], ['/event', 'get'], ['/session', 'post'], ['/session/{sessionID}', 'get'], ['/session/{sessionID}/prompt_async', 'post'], ['/session/{sessionID}/abort', 'post'], ['/permission/{requestID}/reply', 'post'], ['/question/{requestID}/reply', 'post'], ['/question/{requestID}/reject', 'post']];
  if (!spec || !spec.openapi?.startsWith('3.') || required.some(([p, method]) => !spec.paths?.[p]?.[method])) throw new Error('OpenCode /doc does not expose the required pinned HTTP capabilities; refusing to send a prompt');
}

// ---- provider mapping ----------------------------------------------------------------------

export const OLLAMA_LOCAL = 'http://127.0.0.1:11434';
export const OLLAMA_CLOUD_API = 'https://ollama.com';
export const LMSTUDIO_LOCAL = 'http://127.0.0.1:1234';

export interface ProviderSetup {
  providerID: string;
  modelID: string;
  /** `provider` section of the per-run opencode.json. Keys are referenced as {env:NAME}, never inlined. */
  provider: Record<string, unknown>;
  /** Name of the environment variable that carries the key, when one is needed. */
  envKey: string | null;
  /** The run defines its own model list (custom provider), so no models.dev metadata fetch is needed. */
  offline: boolean;
  /** Where the model's requests go, for disclosure. */
  endpoint: string;
}

const trim = (u: string) => u.replace(/\/+$/, '');

export function providerSetup(agent: AgentConfig, model: string): ProviderSetup {
  if (!model || model === 'newest') throw new Error('no concrete model selected; probe the agent so the newest model can be resolved');
  const compat = (id: string, name: string, base: string, key: string | null): ProviderSetup => ({
    providerID: id,
    modelID: model,
    provider: { [id]: { npm: '@ai-sdk/openai-compatible', name, options: { baseURL: `${trim(base)}/v1`, ...(key ? { apiKey: `{env:${key}}` } : {}) }, models: { [model]: { name: model, tool_call: true } } } },
    envKey: key,
    offline: true,
    endpoint: trim(base),
  });
  switch (agent.provider) {
    case 'anthropic-api':
      return { providerID: 'anthropic', modelID: model, provider: { anthropic: { npm: '@ai-sdk/anthropic', options: { apiKey: '{env:ANTHROPIC_API_KEY}' } } }, envKey: 'ANTHROPIC_API_KEY', offline: true, endpoint: 'https://api.anthropic.com' };
    case 'openai-api':
      return { providerID: 'openai', modelID: model, provider: { openai: { npm: '@ai-sdk/openai', options: { apiKey: '{env:OPENAI_API_KEY}' } } }, envKey: 'OPENAI_API_KEY', offline: true, endpoint: 'https://api.openai.com' };
    case 'openrouter': {
      const base = agent.base_url ?? 'https://openrouter.ai/api/v1';
      return { providerID: 'openrouter', modelID: model, provider: { openrouter: { npm: '@openrouter/ai-sdk-provider', options: { apiKey: '{env:OPENROUTER_API_KEY}', ...(agent.base_url ? { baseURL: trim(base) } : {}) } } }, envKey: 'OPENROUTER_API_KEY', offline: true, endpoint: new URL(base).origin };
    }
    case 'ollama':
      return compat('ollama', 'Ollama (local)', ollamaBase('local', agent.base_url ?? OLLAMA_LOCAL), null);
    case 'lmstudio':
      throw new Error('LM Studio tool capabilities have not been verified for this OpenCode adapter; no coding prompt was sent');
    case 'ollama-cloud':
      // The daemon owns cloud aliases/sign-in; direct API IDs are used verbatim with the stored key.
      return (agent.ollama_route ?? 'daemon') === 'api'
        ? compat('ollama-cloud', 'Ollama cloud', ollamaBase('api', agent.base_url ?? OLLAMA_CLOUD_API), 'OLLAMA_API_KEY')
        : compat('ollama-cloud', 'Ollama cloud (via local Ollama)', ollamaBase('daemon', agent.base_url ?? OLLAMA_LOCAL), null);
    default:
      throw new Error(`OpenCode serves API-key and local-model providers; ${agent.provider} agents keep their official CLI`);
  }
}

export interface OpencodeConfigInput {
  agent: AgentConfig;
  model: string;
  runDir: string;
  /** Command that starts the acc MCP server for this run (null when the daemon has no URL). */
  mcp: { command: string; args: string[] } | null;
}

/**
 * Per-run opencode.json. It never contains a key or password (keys arrive as environment variables
 * and are referenced as {env:NAME}). Every action that changes anything asks first; the bridge
 * routes each ask into One Connect's approvals using the same policy as Claude's permission prompts.
 */
export function buildOpencodeConfig(i: OpencodeConfigInput): { config: Record<string, unknown>; setup: ProviderSetup } {
  const setup = providerSetup(i.agent, i.model);
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    model: `${setup.providerID}/${setup.modelID}`,
    enabled_providers: [setup.providerID],
    provider: setup.provider,
    permission: { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask', doom_loop: 'ask', question: 'allow' },
    plugin: [],
    lsp: false,
    formatter: false,
    ...(i.mcp ? { mcp: { acc: { type: 'local', command: [i.mcp.command, ...i.mcp.args], enabled: true } } } : {}),
  };
  return { config, setup };
}

/** Isolation and download controls verified from the pinned source, not guessed flags. */
export function opencodeEnv(o: { runDir: string; providerHome: string; password: string; offline: boolean }): Record<string, string> {
  const local = path.join(o.runDir, 'opencode');
  return {
    HOME: path.join(local, 'home'),
    OPENCODE_TEST_HOME: path.join(local, 'home'),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(local, 'managed-empty'),
    OPENCODE_SERVER_USERNAME: 'acc',
    OPENCODE_SERVER_PASSWORD: o.password,
    OPENCODE_CONFIG: path.join(local, 'opencode.json'),
    XDG_CONFIG_HOME: path.join(local, 'xdg-config'),
    XDG_DATA_HOME: path.join(o.providerHome, 'xdg-data'),
    XDG_CACHE_HOME: path.join(local, 'xdg-cache'),
    XDG_STATE_HOME: path.join(local, 'xdg-state'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_FFF: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_ENABLE_QUESTION_TOOL: '1',
    OPENCODE_PURE: '1',
    // Config.load still calls Npm.install even with plugins disabled. In this release it
    // uses @npmcli/config -> Arborist, which honors npm_config_offline. Empty cache is
    // intentional: missing optional dependencies fail locally, never fetch packages.
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_cache: path.join(local, 'npm-cache'),
    npm_config_userconfig: path.join(local, 'empty.npmrc'),
    npm_config_globalconfig: path.join(local, 'empty-global.npmrc'),
    npm_config_registry: 'http://127.0.0.1:9',
  };
}

/** Runner environments are merged upstream; explicitly whitelist the child environment here. */
export function serverEnvironment(env: NodeJS.ProcessEnv, key: string | null): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC'];
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) if (env[name]) result[name] = env[name];
  if (!env.OPENCODE_CONFIG || !env.HOME) throw new Error('Missing isolated OpenCode config or home');
  const runDir = path.dirname(path.dirname(env.OPENCODE_CONFIG));
  Object.assign(result, opencodeEnv({ runDir, providerHome: path.dirname(env.XDG_DATA_HOME ?? ''), password: env.OPENCODE_SERVER_PASSWORD ?? '', offline: true }));
  if (key) {
    if (!['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_API_KEY'].includes(key)) throw new Error('Unsupported provider credential');
    if (!env[key]) throw new Error('Missing selected provider credential');
    result[key] = env[key];
  }
  return result;
}

// ---- bridge wire format --------------------------------------------------------------------
// The bridge writes one JSON object per line. Lines carrying "t":"delta" go to the ephemeral
// live log; everything else is evidence.

export const DELTA_MATCH = '"t":"delta"';
export const RESULT_MATCH = '"t":"result"';

export type BridgeLine =
  | { t: 'ready'; version: string; protocol: string; port: number }
  | { t: 'session'; sessionId: string; model: string; resumed: boolean }
  | { t: 'delta'; role: 'assistant' | 'reasoning'; partId: string; text: string }
  | { t: 'message'; role: 'assistant'; partId: string; text: string }
  | { t: 'reasoning'; partId: string; text: string }
  | { t: 'tool'; callId: string; tool: string; status: 'running' | 'completed' | 'error'; input: unknown; output?: string; title?: string; exit?: number | null }
  | { t: 'usage'; partId: string; input: number; output: number; costUsd?: number }
  | { t: 'child'; sessionId: string; parentSessionId: string | null; title: string; state: 'running' | 'completed' | 'failed' | 'aborted'; error?: string }
  | { t: 'permission'; id: string; state: 'asked' | 'allowed' | 'denied' | 'pending'; tool: string; summary: string }
  | { t: 'question'; id: string; state: 'asked' | 'answered' | 'rejected'; question: string }
  | { t: 'retry'; message: string; attempt: number }
  | { t: 'error'; name: string; message: string; status?: number | null }
  | { t: 'model_mismatch'; requested: string; served: string }
  | { t: 'aborted'; reason: string }
  | { t: 'result'; ok: boolean; error?: string };

/** OpenCode permission request → the tool vocabulary of One Connect's permission policy. */
export function permissionToTool(ev: { type?: string; permission?: string; pattern?: unknown; patterns?: unknown; always?: unknown; title?: string; metadata?: Record<string, unknown> }): { tool_name: string; input: Record<string, unknown>; summary: string } {
  const kind = String(ev.permission ?? ev.type ?? 'unknown').toLowerCase();
  const meta = ev.metadata ?? {};
  const pat = Array.isArray(ev.patterns) ? ev.patterns.map(String).join(' ') : Array.isArray(ev.pattern) ? ev.pattern.map(String).join(' ') : typeof ev.pattern === 'string' ? ev.pattern : '';
  if (kind === 'bash' && typeof meta.command === 'string' && meta.command.trim()) {
    return { tool_name: 'Bash', input: { command: meta.command }, summary: `bash ${meta.command}`.slice(0, 300) };
  }
  const file = meta.filepath ?? meta.filePath ?? meta.file ?? meta.path;
  if (['edit', 'write', 'patch', 'multiedit'].includes(kind) && typeof file === 'string' && file.trim() && (!Array.isArray(ev.patterns) || ev.patterns.length <= 1)) {
    return { tool_name: 'Edit', input: { file_path: file }, summary: `${kind} ${file}`.slice(0, 300) };
  }
  // webfetch, external_directory, doom_loop, task, anything new: always a human decision.
  return { tool_name: `OpenCode:${kind}`, input: { patterns: ev.patterns ?? ev.pattern ?? [], metadata: meta, title: ev.title ?? '' }, summary: `${kind} ${ev.title ?? pat}`.trim().slice(0, 300) };
}
