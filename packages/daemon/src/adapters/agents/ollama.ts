// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Read-only Ollama probes. No pull, model load, chat, generate, signin, or inference requests.
// Docs: docs.ollama.com/api/{tags,authentication}, api-reference/show-model-details.
// /api/me and remote_model/remote_host are verified from ollama/ollama api/client.go and types.go.
import type { ModelInfo } from '@acc/core';
import { isOllamaCloudModel } from '@acc/core';
import type { Fetch } from '../../egress.ts';
import { getSecret } from '../../secrets.ts';
import { OLLAMA_CLOUD_URL, ollamaBase, ollamaTools, type OllamaRoute } from './ollama-cloud.ts';
export { OLLAMA_CLOUD_URL, type OllamaRoute } from './ollama-cloud.ts';
export const OLLAMA_LOCAL_URL = 'http://127.0.0.1:11434';
export type OllamaState = 'ready' | 'server_not_running' | 'not_signed_in' | 'key_missing' | 'key_rejected' | 'sign_in_unknown' | 'error';
export interface OllamaStatus {
  route: OllamaRoute;
  base: string;
  state: OllamaState;
  message: string;
  fix?: string;
  version?: string;
  signedInAs?: string | null;
  models: ModelInfo[];
  counts: { local: number; cloud: number };
}
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const json = async (f: Fetch, url: string, init: RequestInit = {}, timeoutMs = 4000) => {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* malformed metadata remains unknown */ }
  return { status: res.status, body: obj(body) };
};
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
export const ollamaRouteOf = (agent: { provider: string; ollama_route?: string }): OllamaRoute => agent.provider === 'ollama' ? 'local' : (agent.ollama_route ?? 'daemon') === 'api' ? 'api' : 'daemon';

export async function ollamaStatus(agent: { provider: string; base_url?: string; ollama_route?: string }, f: Fetch, env: NodeJS.ProcessEnv = process.env): Promise<OllamaStatus> {
  const route = ollamaRouteOf(agent);
  let base = route === 'api' ? OLLAMA_CLOUD_URL : OLLAMA_LOCAL_URL;
  const empty = { models: [] as ModelInfo[], counts: { local: 0, cloud: 0 } };
  try {
    if (!['ollama', 'ollama-cloud'].includes(agent.provider) || (agent.ollama_route && !['daemon', 'api'].includes(agent.ollama_route)) || (agent.provider === 'ollama' && agent.ollama_route)) throw new Error('Unsupported Ollama provider or route');
    base = ollamaBase(route, agent.base_url ?? base);
  } catch (e) {
    return { route, base, state: 'error', message: (e as Error).message, ...empty };
  }
  let headers: Record<string, string> = {};
  if (route === 'api') {
    const key = await getSecret('ollama-cloud', env);
    if (!key) return { route, base, state: 'key_missing', message: 'No Ollama API key is stored.', fix: 'Add your Ollama API key under Connections (macOS Keychain)', ...empty };
    headers = { authorization: `Bearer ${key}` };
  }
  let version: string | undefined;
  if (route !== 'api') {
    try {
      const v = await json(f, `${base}/api/version`);
      if (v.status !== 200 || typeof v.body.version !== 'string' || !v.body.version.trim()) throw new Error('No valid server version');
      version = v.body.version;
    } catch {
      return { route, base, state: 'server_not_running', message: `Ollama is not responding with a version at ${base}.`, fix: 'Start Ollama (open the app or run `ollama serve`)', ...empty };
    }
  }
  let signedInAs: string | undefined;
  if (route !== 'local') {
    try {
      // The official Go client's Whoami uses POST /api/me. A public /api/tags success
      // cannot validate a key. Unknown/older endpoints never become "signed in".
      const me = await json(f, `${base}/api/me`, post({}, headers));
      if (me.status === 401 || me.status === 403) return { route, base, state: route === 'api' ? 'key_rejected' : 'not_signed_in', message: route === 'api' ? 'Ollama rejected the stored API key.' : 'Ollama is running but not signed in.', fix: route === 'api' ? 'Replace the key under Connections' : 'Run `ollama signin`', version, ...empty };
      if (me.status === 200) {
        const identity = typeof me.body.name === 'string' && me.body.name.trim() ? me.body.name : typeof me.body.email === 'string' ? me.body.email : undefined;
        if (identity?.trim()) signedInAs = identity;
      }
    } catch { /* unknown authentication is not success */ }
  }
  let list: Record<string, unknown>[];
  try {
    // Cloud catalog is public in the official docs; do not send a key to list it.
    const tags = await json(f, `${base}/api/tags`, {}, 8000);
    if (tags.status !== 200 || !Array.isArray(tags.body.models) || tags.body.models.some((m) => typeof obj(m).name !== 'string' || !String(obj(m).name).trim())) throw new Error('Invalid model list');
    list = tags.body.models.slice(0, 60).map(obj);
  } catch {
    return { route, base, state: 'error', message: 'Could not read a valid Ollama model catalog.', version, ...empty };
  }
  const cloudOf = (m: Record<string, unknown>) => route === 'api' || isOllamaCloudModel(String(m.name)) || Boolean(m.remote_model || m.remote_host);
  const caps = new Map<string, boolean | undefined>();
  const queue = [...list];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const name = String(m.name);
      const listed = ollamaTools(m.capabilities);
      if (listed !== undefined) { caps.set(name, listed); continue; }
      if ((route === 'local' && cloudOf(m)) || (route !== 'local' && !signedInAs)) continue;
      try {
        const show = await json(f, `${base}/api/show`, post({ model: name }, headers));
        if (show.body.remote_model || show.body.remote_host) { m.remote_model = show.body.remote_model; m.remote_host = show.body.remote_host; }
        caps.set(name, show.status === 200 ? ollamaTools(show.body.capabilities) : undefined);
      } catch { /* no capability claim */ }
    }
  }));
  const models = list.map((m): ModelInfo => {
    const name = String(m.name), cloud = cloudOf(m), tools = caps.get(name);
    const wrongRoute = route === 'local' ? cloud : route === 'daemon' ? !cloud : false;
    const unsafeRemote = m.remote_host && m.remote_host !== OLLAMA_CLOUD_URL;
    const parameter = obj(m.details).parameter_size;
    return {
      id: name,
      label: `${name}${typeof parameter === 'string' ? ` (${parameter})` : ''}${cloud ? ' · Ollama cloud' : ''}${tools === false ? ' · no tool calling' : tools === undefined ? ' · tool support unverified' : ''}`,
      tools,
      // Cloud costs and quota are not proven to be zero by catalog metadata.
      ...(!cloud ? { pricing: { input: 0, output: 0 } } : {}),
      hidden: tools !== true || wrongRoute || Boolean(unsafeRemote) || (route !== 'local' && !signedInAs),
    };
  });
  const unknownAuth = route !== 'local' && !signedInAs;
  const none = !models.some((m) => !m.hidden);
  return {
    route, base, state: unknownAuth ? 'sign_in_unknown' : 'ready', version, signedInAs: signedInAs ?? null,
    message: `${route === 'api' ? 'Ollama cloud API' : `Ollama ${version} at ${base}`}: ${unknownAuth ? 'authentication is unverified; model listings do not prove a key or sign-in works' : route === 'local' ? 'local server' : `signed in as ${signedInAs}`}${none ? '. No verified tool-capable models are available for this route' : ''}.`,
    ...(none ? { fix: route === 'daemon' ? 'Sign in and make a cloud alias available in Ollama, then re-probe; One Connect never pulls models' : 'Choose an available model with verified tool support and re-probe' } : {}),
    models, counts: { local: list.filter((m) => !cloudOf(m)).length, cloud: list.filter(cloudOf).length },
  };
}
