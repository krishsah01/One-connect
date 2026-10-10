// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Official contracts: docs.ollama.com/cloud and api/openai-compatibility (2026-10-07).
// Native API: https://ollama.com/api; OpenAI chat: https://ollama.com/v1.
// Direct API IDs come from /api/tags; local :cloud / -cloud aliases are not rewritten.
export const OLLAMA_CLOUD_URL = 'https://ollama.com';
export type OllamaRoute = 'local' | 'daemon' | 'api';

/** Validate before loading a key or sending any request, including a model-list probe. */
export function ollamaBase(route: OllamaRoute, raw: string): string {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Ollama requires an origin URL without credentials, path, query or fragment');
  if (route === 'api') {
    if (u.origin !== OLLAMA_CLOUD_URL) throw new Error('Ollama cloud API only accepts https://ollama.com');
  } else if (!['http:', 'https:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error('The Ollama daemon must be on a loopback origin');
  }
  return u.origin;
}

/** Missing/malformed capability metadata stays unknown. It must never enable a coding run. */
export function ollamaTools(capabilities: unknown): boolean | undefined {
  if (!Array.isArray(capabilities) || capabilities.length === 0 || !capabilities.every((c) => typeof c === 'string')) return undefined;
  return capabilities.includes('tools');
}
