// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { containsSecret } from '@acc/core';
import { CommandError } from '../errors.ts';
import type { Daemon } from '../daemon.ts';
import { githubPreview, githubSource, type GitHubPreview } from '../marketplace/github.ts';
import { sha256 } from '../util/hash.ts';
import { fetchRegistryVersion, registryConnectorDraft, searchRegistry, type RegistryEntry } from '../marketplace/mcp.ts';
import type { MarketplaceFetch } from '../marketplace/transport.ts';
type R<B = unknown, Q = Record<string, string | undefined>> = FastifyRequest<{ Body: B; Querystring: Q }>;
const githubKey = (url: string, commit: string) => `marketplace:github:${sha256(url + '@' + commit)}`;
const registryKey = (name: string, version: string) => `marketplace:mcp:${sha256(name + '@' + version)}`;
export function registerMarketplaceRoutes(app: FastifyInstance, d: Daemon): void {
  // Exact one-shot GET permits. No marketplace host is added to general agent/provider egress.
  const permits = new Map<string, string>();
  d.egress.authorizeMarketplace = (token, url, init) => {
    const match = permits.get(token); permits.delete(token);
    return match === url && (init?.method ?? 'GET') === 'GET' && !init?.body;
  };
  const fetcher: MarketplaceFetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'codeload.github.com', 'registry.modelcontextprotocol.io'].includes(parsed.host) || parsed.username || parsed.password || parsed.hash) throw new CommandError('Invalid marketplace outbound URL');
    const token = randomBytes(24).toString('hex'); permits.set(token, url);
    try { return await d.egress.fetch(url, { ...init, marketplacePermit: token }); }
    finally { permits.delete(token); }
  };
  const remember = (preview: GitHubPreview) => { d.store.kvSet(githubKey(preview.url, preview.commit), JSON.stringify(preview)); return preview; };
  app.post('/api/marketplace/github/preview', async (req: R<{ url: unknown }>) => remember(await githubPreview(req.body?.url, fetcher, d.denylist())));
  app.get('/api/marketplace/anthropic-skills', async () => {
    const pinned = d.store.kvGet('marketplace:anthropic:commit') ?? undefined;
    const preview = remember(await githubPreview('https://github.com/anthropics/skills', fetcher, d.denylist(), pinned));
    if (!pinned) d.store.kvSet('marketplace:anthropic:commit', preview.commit);
    return { ...preview, note: 'Pinned on the first explicit catalog request; no background refresh or import.' };
  });
  app.post('/api/marketplace/github/import', async (req: R<{ url: unknown; commit: string; paths: string[] }>) => {
    const input = req.body;
    const source = githubSource(input?.url);
    if (!input || !/^[a-f0-9]{40}$/.test(input.commit) || !Array.isArray(input.paths) || !input.paths.length || input.paths.length > 64 || input.paths.some(p => typeof p !== 'string') || new Set(input.paths).size !== input.paths.length) throw new CommandError('Choose 1–64 previewed skill paths at a full commit SHA');
    const saved = d.store.kvGet(githubKey(source.url, input.commit));
    if (!saved) throw new CommandError('Preview this repository and commit before importing', 428);
    const preview = JSON.parse(saved) as GitHubPreview;
    const fresh = await githubPreview(source.url, fetcher, d.denylist(), input.commit);
    const selected = input.paths.map(path => {
      const before = preview.skills.find(s => s.path === path), after = fresh.skills.find(s => s.path === path);
      if (!before?.draft || !after?.draft || !isDeepStrictEqual(before.files, after.files) || !isDeepStrictEqual(before.draft, after.draft) || preview.licenseSha256 !== fresh.licenseSha256) throw new CommandError('A selected skill is unavailable or differs from the pinned preview', 409);
      const existing = d.skillLib.draft(after.draft.id);
      if (existing && !isDeepStrictEqual(existing, after.draft)) throw new CommandError('An existing skill draft was edited; import will not overwrite it', 409);
      if (containsSecret(JSON.stringify(after), { denylist: d.denylist() }).length) throw new CommandError('Skill contains credentials');
      return after;
    });
    // Validate all selections before writing any draft.
    const skills = selected.map(s => {
      const id = s.draft!.id;
      const result = d.skillLib.saveDraft(s.draft, d.state.skills?.[id]?.draft?.hash ?? null);
      d.store.kvSet(`marketplace:skill:${id}`, JSON.stringify({ repo: fresh.repo, commit: fresh.commit, license: fresh.license, licenseSha256: fresh.licenseSha256, path: s.path, files: s.files, omittedMetadata: s.omittedMetadata }));
      return { ...result, path: s.path, commit: fresh.commit, files: s.files };
    });
    return { skills, draft: true, note: 'Imported as drafts only. Review and publish before attaching to an agent.' };
  });
  app.get('/api/marketplace/mcp', async (req: R<unknown, { q?: string }>) => {
    const result = await searchRegistry(req.query.q ?? '', fetcher, d.denylist());
    for (const entry of result.servers) d.store.kvSet(registryKey(entry.name, entry.version), JSON.stringify(entry));
    return result;
  });
  app.post('/api/marketplace/mcp/draft', async (req: R<{ name: string; version: string }>) => {
    const { name, version } = req.body ?? {};
    if (typeof name !== 'string' || typeof version !== 'string' || name.length > 180 || version.length > 64) throw new CommandError('Choose a previewed registry server and exact version');
    const saved = d.store.kvGet(registryKey(name, version));
    if (!saved) throw new CommandError('Preview the registry server before adding a connector draft', 428);
    const previous = JSON.parse(saved) as RegistryEntry;
    const entry = await fetchRegistryVersion(name, version, fetcher, d.denylist());
    if (previous.sha256 !== entry.sha256) throw new CommandError('Registry version changed since preview', 409);
    const { draft, setupRequired, note } = registryConnectorDraft(entry, d.baseEnv().PATH);
    const current = d.state.connectors?.[draft.id];
    if (current) {
      const provenance = d.store.kvGet(`marketplace:connector:${draft.id}`);
      if (provenance && JSON.parse(provenance).sha256 === entry.sha256) return { connection: d.connectors.list().connections.find(c => c.id === draft.id), provenance: entry, setupRequired, note: 'Already imported; current owner configuration preserved.' };
      throw new CommandError('A connector with this id already exists', 409);
    }
    d.connectors.save(draft, null);
    const connection = d.connectors.setDisabled(draft.id, true);
    d.store.kvSet(`marketplace:connector:${draft.id}`, JSON.stringify(entry));
    return { connection, provenance: entry, setupRequired, note };
  });
}
