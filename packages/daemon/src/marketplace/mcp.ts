// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { z } from 'zod';
import { ConnectorDraftSchema, containsSecret, type ConnectorDraft, canonicalJson } from '@acc/core';
import { CommandError } from '../errors.ts';
import { whichAll } from '../adapters/agents/detect.ts';
import { sha256 } from '../util/hash.ts';
import { jsonResponse, type MarketplaceFetch } from './transport.ts';
const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,179}$/);
const Version = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/).refine(v => !['latest', 'next', 'stable'].includes(v), 'Choose an exact version');
const Server = z.object({ name: Name, version: Version, description: z.string().max(2000).optional(), packages: z.array(z.unknown()).max(16).optional(), remotes: z.array(z.unknown()).max(16).optional() }).passthrough();
export interface RegistryEntry { name: string; version: string; description: string; sha256: string; server: z.infer<typeof Server>; untrusted: true }
export function registryEntry(raw: unknown, denylist: string[] = []): RegistryEntry {
  const wrapper = raw as { server?: unknown };
  const parsed = Server.safeParse(wrapper?.server ?? raw);
  if (!parsed.success) throw new CommandError('Registry server metadata is invalid', 502);
  if (containsSecret(JSON.stringify(parsed.data), { denylist }).length) throw new CommandError('Registry metadata contains credentials');
  return { name: parsed.data.name, version: parsed.data.version, description: parsed.data.description ?? '', sha256: sha256(canonicalJson(parsed.data)), server: parsed.data, untrusted: true };
}
export async function searchRegistry(q: unknown, fetcher: MarketplaceFetch, denylist: string[] = []): Promise<{ servers: RegistryEntry[]; nextCursor: string | null }> {
  if (typeof q !== 'string' || q.length > 200 || containsSecret(q, { denylist }).length) throw new CommandError('Use a bounded search query without credentials');
  const raw = await jsonResponse(fetcher, `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(q)}&limit=50`) as { servers?: unknown[]; metadata?: { nextCursor?: unknown } };
  if (!Array.isArray(raw?.servers) || raw.servers.length > 50) throw new CommandError('Registry catalog exceeds its count limit', 413);
  return { servers: raw.servers.map(row => registryEntry(row, denylist)), nextCursor: typeof raw.metadata?.nextCursor === 'string' ? raw.metadata.nextCursor.slice(0,500) : null };
}
export async function fetchRegistryVersion(name: unknown, version: unknown, fetcher: MarketplaceFetch, denylist: string[] = []): Promise<RegistryEntry> {
  if (!Name.safeParse(name).success || !Version.safeParse(version).success) throw new CommandError('Use a registry name and exact version');
  const entry = registryEntry(await jsonResponse(fetcher, `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(String(name))}/versions/${encodeURIComponent(String(version))}`), denylist);
  if (entry.name !== name || entry.version !== version) throw new CommandError('Registry returned a different server or version', 409);
  return entry;
}
export function registryConnectorDraft(entry: RegistryEntry, envPath?: string): { draft: ConnectorDraft; setupRequired: boolean; note: string } {
  let command = process.execPath;
  let args = ['-e', 'throw new Error("Configure this registry draft in Connectors before activation.")'];
  let setupRequired = true;
  for (const raw of entry.server.packages ?? []) {
    const p = raw as { registryType?: unknown; identifier?: unknown; version?: unknown; transport?: { type?: unknown } };
    if (p.registryType !== 'npm' || p.transport?.type !== 'stdio' || typeof p.identifier !== 'string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i.test(p.identifier) || typeof p.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(p.version)) continue;
    const npx = whichAll(['npx'], envPath)[0];
    if (!npx) break;
    command = npx; args = ['--yes', `${p.identifier}@${p.version}`]; setupRequired = false; break;
  }
  const draft = ConnectorDraftSchema.parse({ id: 'mcp-' + sha256(entry.name + '@' + entry.version).slice(0,16), name: entry.name.slice(0,100), config: { kind: 'mcp', command, args, tools: [], read_roots: [] } });
  return { draft, setupRequired, note: setupRequired ? 'Saved disabled. This registry transport needs a local stdio command. Configure it and review actual tool names before approval.' : 'Saved disabled with an exact npm package version. Review the command, required inputs and actual tool names before enabling. No package was downloaded or run.' };
}
