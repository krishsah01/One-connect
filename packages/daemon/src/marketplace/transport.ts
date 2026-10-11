// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { CommandError } from '../errors.ts';
export type MarketplaceFetch = (url: string, init?: RequestInit) => Promise<Response>;
export async function readBounded(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.ok) { await res.body?.cancel(); throw new CommandError(`Marketplace returned HTTP ${res.status}`, 502); }
  if (!res.body) throw new CommandError('Marketplace returned no content', 502);
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) return Buffer.concat(chunks);
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new CommandError('Marketplace response exceeds its byte limit', 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
}
export async function jsonResponse(fetcher: MarketplaceFetch, url: string, limit = 1024 * 1024): Promise<unknown> {
  const raw = await readBounded(await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } }), limit);
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new CommandError('Marketplace returned invalid JSON', 502); }
}
export const shaPattern = /^[a-f0-9]{40}$/;
