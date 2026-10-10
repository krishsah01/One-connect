// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubPreview, githubSource } from '../src/marketplace/github.ts';
import { readTarGzip } from '../src/marketplace/archive.ts';
import { readBounded } from '../src/marketplace/transport.ts';
import { registryConnectorDraft, registryEntry } from '../src/marketplace/mcp.ts';
import { makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/marketplace/catalog.json', import.meta.url), 'utf8'));
const SOURCE_URL = 'https://github.com/example/skills';
let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });
function tar(files: Record<string,string>, type = '0'): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, text] of Object.entries(files)) {
    const name = 'repository/' + path, body = Buffer.from(text), block = Buffer.alloc(512);
    block.write(name, 0, 100); block.write('0000644\0',100); block.write('0000000\0',108); block.write('0000000\0',116);
    block.write(body.length.toString(8).padStart(11,'0') + '\0',124); block.write('00000000000\0',136); block.fill(32,148,156); block.write(type,156); block.write('ustar\0',257);
    const checksum = block.reduce((n,b) => n+b,0); block.write(checksum.toString(8).padStart(6,'0') + '\0 ',148);
    blocks.push(block,body,Buffer.alloc((512-body.length%512)%512));
  }
  return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
function transport() {
  let files = { ...fixture.files };
  let server = structuredClone(fixture.registry.servers[0]);
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith('https://api.github.com/repos/') && !url.includes('/commits/')) return Response.json(fixture.repo);
    if (url.startsWith('https://api.github.com/repos/') && url.includes('/commits/')) return Response.json(fixture.commit);
    if (url.startsWith('https://codeload.github.com/')) return new Response(tar(files));
    if (url.includes('registry.modelcontextprotocol.io/v0.1/servers?')) return Response.json({ ...fixture.registry, servers: [server] });
    if (url.includes('registry.modelcontextprotocol.io/v0.1/servers/')) return Response.json(server);
    throw new Error('Unexpected outbound fixture URL: ' + url);
  });
  return { fetcher, changeFiles: (next: Record<string,string>) => { files = next; }, changeServer: (next: object) => { server = next; } };
}
async function api(method: string, route: string, body?: unknown) {
  const token = fs.readFileSync(h!.d.paths.installToken,'utf8').trim();
  const r = await fetch(h!.url + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() as any };
}
async function boot() { const t = transport(); h = await startDaemon(makeConfig(makeRepo()), { probe: false, fetch: t.fetcher }); return t; }

describe('bounded marketplace parsing', () => {
  it('pins a branch, previews files and licenses, and accepts scoped GitHub URLs', async () => {
    const t = transport();
    const preview = await githubPreview(SOURCE_URL, t.fetcher);
    expect(preview.commit).toBe(fixture.commit.sha); expect(preview.license).toBe('MIT');
    expect(preview.skills).toHaveLength(2);
    expect(preview.skills[0]).toMatchObject({ name: 'planning', path: 'skills/planning/SKILL.md', omittedMetadata: ['license'] });
    expect(preview.skills[0].files).toHaveLength(2); expect(preview.skills[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.skills[0].draft!.references[0].path).toBe('references/guide.md');
    expect((await githubPreview(SOURCE_URL + '/tree/main/skills/review', t.fetcher)).skills).toHaveLength(1);
    expect(githubSource(SOURCE_URL + '/blob/main/skills/review/SKILL.md').path).toBe('skills/review');
  });
  it('refuses unsafe URLs, tar paths, links, oversized replies and credentials', async () => {
    for (const bad of ['http://github.com/a/b', 'https://github.com.evil/a/b', 'https://user:pass@github.com/a/b', SOURCE_URL + '?token=secret', SOURCE_URL + '/tree/main/%2Fetc']) expect(() => githubSource(bad)).toThrow();
    expect(() => readTarGzip(tar({ '../outside': 'unsafe' }))).toThrow('unsafe');
    expect(() => readTarGzip(tar({ 'link': '' }, '2'))).toThrow('links');
    expect(() => readTarGzip(tar({ 'big': 'x'.repeat(512*1024+1) }))).toThrow('bounds');
    await expect(readBounded(new Response('x'.repeat(101)),100)).rejects.toThrow('byte limit');
    const t = transport(); t.changeFiles({ 'SKILL.md': '---\nname: secret\ndescription: Use this secret skill safely.\n---\nAuthorization: Bearer ghp_' + 'a'.repeat(36) });
    await expect(githubPreview(SOURCE_URL, t.fetcher)).rejects.toThrow('credentials');
  });
  it('shows unsupported assets before import and preserves root skill references', async () => {
    const t = transport(); t.changeFiles({ 'SKILL.md': fixture.files['skills/planning/SKILL.md'], 'references/guide.md': 'Root guide' });
    expect((await githubPreview(SOURCE_URL,t.fetcher)).skills[0].draft!.references).toHaveLength(1);
    t.changeFiles({ ...fixture.files, 'skills/planning/scripts/run.py': 'print(1)' });
    const preview = await githubPreview(SOURCE_URL,t.fetcher);
    expect(preview.skills[0].draft).toBeNull(); expect(preview.skills[0].problems[0]).toContain('Unsupported');
  });
});

describe('owner-triggered marketplace routes', () => {
  it('requires preview, imports exact draft snapshots and does not widen general egress', async () => {
    const t = await boot(); expect(t.fetcher).not.toHaveBeenCalled();
    const input = { url: SOURCE_URL, commit: fixture.commit.sha, paths: ['skills/planning/SKILL.md'] };
    expect((await api('POST','/api/marketplace/github/import',input)).status).toBe(428);
    const preview = await api('POST','/api/marketplace/github/preview',{ url: SOURCE_URL }); expect(preview.status).toBe(200);
    const imported = await api('POST','/api/marketplace/github/import',input); expect(imported.status).toBe(200);
    const skill = imported.body.skills[0].skill; expect(skill.latest).toBeNull(); expect(skill.draft).toBeTruthy();
    expect(h!.d.skillLib.draft(skill.id)!.source).toContain('/' + fixture.commit.sha + '/');
    expect((await api('POST','/api/marketplace/github/import',input)).status).toBe(200);
    await expect(h!.d.egress.fetch('https://api.github.com/repos/example/skills')).rejects.toThrow('blocked outbound');
    expect(h!.d.egress.allowed).not.toContain('api.github.com');
    expect(h!.d.egress.log.some(r => r.purpose === 'marketplace preview/import' && r.allowed)).toBe(true);
    t.changeFiles({ ...fixture.files, 'skills/planning/references/guide.md': 'Different pinned content' });
    expect((await api('POST','/api/marketplace/github/import',input)).status).toBe(409);
    expect(h!.d.skillLib.draft(skill.id)!.references[0].content).toContain('every approval');
  });
  it('pins Anthropic on explicit first request and reuses the commit', async () => {
    const t = await boot();
    const first = await api('GET','/api/marketplace/anthropic-skills'); expect(first.status).toBe(200);
    const count = t.fetcher.mock.calls.filter(c => c[0].includes('api.github.com')).length;
    expect((await api('GET','/api/marketplace/anthropic-skills')).body.commit).toBe(first.body.commit);
    expect(t.fetcher.mock.calls.filter(c => c[0].includes('api.github.com'))).toHaveLength(count);
  });
  it('creates pinned disabled MCP drafts and requires actual tool configuration and ordinary approval', async () => {
    await boot();
    const input = { name: 'io.example/notes', version: '1.2.3' };
    expect((await api('POST','/api/marketplace/mcp/draft',input)).status).toBe(428);
    const search = await api('GET','/api/marketplace/mcp?q=notes'); expect(search.status).toBe(200);
    expect(search.body.servers[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    const draft = await api('POST','/api/marketplace/mcp/draft',input); expect(draft.status).toBe(200);
    const c = h!.d.state.connectors![draft.body.connection.id];
    expect(c.disabled).toBe(true); expect(c.approvals).toEqual({}); expect(c.config.kind).toBe('mcp');
    expect(() => h!.d.connectors.requestActivation(c.id,'execute')).toThrow('actual tool names');
    expect((await api('POST','/api/marketplace/mcp/draft',input)).status).toBe(200);
    const entry = registryEntry({ server: { name: 'io.example/remote', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }] } });
    expect(registryConnectorDraft(entry,'').setupRequired).toBe(true);
  });
  it('rejects registry version drift and anonymous writes', async () => {
    const t = await boot();
    await api('GET','/api/marketplace/mcp?q=notes');
    t.changeServer({ server: { ...fixture.registry.servers[0].server, description: 'Changed metadata' } });
    expect((await api('POST','/api/marketplace/mcp/draft',{ name: 'io.example/notes', version: '1.2.3' })).status).toBe(409);
    const unauth = await fetch(h!.url + '/api/marketplace/github/preview',{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:SOURCE_URL}) });
    expect(unauth.status).toBe(401);
  });
});
