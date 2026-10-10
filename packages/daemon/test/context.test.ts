// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Shared context: Obsidian vault notes (fs + official CLI) and the graphify code graph.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeConfigSchema } from '@acc/core';
import { Vault, parseCliPaths } from '../src/context/vault.ts';
import { makeConfig, makeRepo, startDaemon, tmpDir, waitFor, type Harness } from './helpers.ts';

const FIX = path.join(import.meta.dirname, 'fixtures');
const hasGraphify = process.env.ONE_CONNECT_LIVE_GRAPHIFY==='1' && (() => {
  try {
    execFileSync('graphify', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function makeVault(): string {
  const v = tmpDir('vault');
  fs.mkdirSync(path.join(v, 'Projects', 'sample'), { recursive: true });
  fs.mkdirSync(path.join(v, 'Personal'), { recursive: true });
  fs.writeFileSync(path.join(v, 'Projects', 'sample', 'Auth design.md'), '# Auth design\nTokens rotate every hour. The login service owns sessions.\n');
  fs.writeFileSync(path.join(v, 'Personal', 'Diary.md'), '# Diary\nprivate thoughts about login\n');
  return v;
}

describe('Vault', () => {
  const cfg = (over: Record<string, unknown> = {}) => KnowledgeConfigSchema.parse({ vault: 'x', folder: 'ACC/sample', context_folders: ['Projects/sample'], ...over });

  it('writes only inside its folder and skips unchanged content', () => {
    const root = makeVault();
    const v = new Vault(cfg(), root);
    expect(v.write('ACC/sample/Brief.md', '# hi')).toBe(true);
    expect(v.write('ACC/sample/Brief.md', '# hi')).toBe(false);
    expect(fs.readFileSync(path.join(root, 'ACC/sample/Brief.md'), 'utf8')).toBe('# hi');
    expect(() => v.write('Personal/Diary.md', 'x')).toThrow(/outside/);
    expect(() => v.write('ACC/sample/../../Personal/x.md', 'x')).toThrow(/outside/);
  });

  it('reads only allowed folders: never unrelated notes, traversal or symlink escapes', () => {
    const root = makeVault();
    const v = new Vault(cfg(), root);
    expect(v.read('Projects/sample/Auth design')).toContain('Tokens rotate');
    expect(() => v.read('Personal/Diary.md')).toThrow(/outside the folders agents may read/);
    expect(() => v.read('Projects/sample/../../Personal/Diary.md')).toThrow(/outside/);
    fs.symlinkSync(path.join(root, 'Personal', 'Diary.md'), path.join(root, 'Projects', 'sample', 'sneaky.md'));
    expect(() => v.read('Projects/sample/sneaky.md')).toThrow(/outside/);
  });

  it('local search covers allowed folders only', async () => {
    const root = makeVault();
    const v = new Vault(cfg(), root);
    v.isObsidianRunning = () => false;
    const r = await v.search('login sessions');
    expect(r.backend).toBe('fs');
    expect(r.hits.map((h) => h.path)).toEqual(['Projects/sample/Auth design.md']);
    expect(r.hits[0].snippet).toContain('login service');
  });

  it('rejects a selected symlink folder and symlinks in not-yet-created write paths', () => {
    const root=makeVault(),outside=tmpDir('private');
    fs.writeFileSync(path.join(outside,'private.md'),'private outside vault');
    fs.symlinkSync(outside,path.join(root,'Shared'));
    const v=new Vault(cfg({context_folders:['Shared']}),root);
    expect([...v.documents()]).toEqual([]);
    expect(()=>v.read('Shared/private.md')).toThrow(/outside/);
    fs.mkdirSync(path.join(root,'ACC'),{recursive:true});
    fs.symlinkSync(outside,path.join(root,'ACC','sample'));
    expect(()=>v.write('ACC/sample/new/Brief.md','secret')).toThrow(/outside/);
    expect(fs.existsSync(path.join(outside,'new'))).toBe(false);
    expect(()=>cfg({context_folders:['../Private']})).toThrow(/traversal/);
  });

  it('uses the official Obsidian CLI only when installed and Obsidian is running', async () => {
    const root = makeVault();
    const bin = path.join(FIX, 'fake-obsidian.mjs');
    process.env.FAKE_VAULT_ROOT = root;
    const v = new Vault(cfg({ obsidian_binary: bin }), root);
    v.isObsidianRunning = () => false;
    expect(v.cliUsable()).toMatchObject({ usable: false, note: expect.stringContaining('not running') });
    expect((await v.search('tokens')).backend).toBe('fs');
    v.isObsidianRunning = () => true;
    const r = await v.search('tokens');
    expect(r.backend).toBe('obsidian-cli');
    expect(r.hits.map((h) => h.path)).toEqual(['Projects/sample/Auth design.md']);
    expect(new Vault(cfg({ obsidian_cli: 'off', obsidian_binary: bin }), root).cliUsable().usable).toBe(false);
    expect(v.openUrl('ACC/sample/Brief.md')).toBe(`obsidian://open?vault=${encodeURIComponent(path.basename(root))}&file=ACC%2Fsample%2FBrief`);
  });

  it('handoff note names stay unique when two handoffs land in the same minute', async () => {
    const { noteLinks } = await import('../src/context/notes.ts');
    const L = noteLinks('ACC/p', (r) => r);
    const run = (id: string, key: string) => ({ id, agentId: 'cursor', endedAt: '2026-10-06T23:33:10.000Z', workItemKey: key }) as never;
    expect(L.handoff(run('run_aaaa1111', 'DEMO-2'))).not.toBe(L.handoff(run('run_bbbb2222', 'DEMO-3')));
    expect(L.handoff(run('run_aaaa1111', 'DEMO-2'))).toBe('ACC/p/Handoffs/2026-10-06-23-33 DEMO-2 cursor 1111.md');
  });

  it('parses CLI search output shapes', () => {
    expect(parseCliPaths('["a.md","b.md"]')).toEqual(['a.md', 'b.md']);
    expect(parseCliPaths('[{"path":"a.md"},{"file":"b.md"}]')).toEqual(['a.md', 'b.md']);
    expect(parseCliPaths('a.md\nnot a note\nb.md')).toEqual(['a.md', 'b.md']);
  });
});

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function contextHarness(graphBinary?: string) {
  const vault = makeVault();
  const repo = makeRepo();
  const cfg = makeConfig(repo, {
    knowledge: { vault, folder: 'Agent Control Center', context_folders: ['Projects/sample'], obsidian_cli: 'off' },
    graphify: { enabled: true, ...(graphBinary ? { binary: graphBinary } : {}) },
  });
  h = await startDaemon(cfg);
  return { vault, d: h.d };
}

describe('shared context in the daemon', () => {
  it('writes contract, brief, issue, handoff and decision notes from real state; agents get them via MCP', async () => {
    const { vault, d } = await contextHarness(path.join(FIX, 'fake-graphify.mjs'));
    const base = path.join(vault, d.context.vault!.folder);
    await waitFor(() => fs.existsSync(path.join(base, 'Team Contract.md')), 5000, 'contract');
    const contract = fs.readFileSync(path.join(base, 'Team Contract.md'), 'utf8');
    expect(contract).toContain('No issue, no dispatch');
    expect(contract).toContain('| Codex |');
    expect(contract).toContain('query_graph');

    const item = d.createIssue({ title: 'Decide and note', description: '[fake:ask-human]', acceptance: ['notes exist'] });
    await waitFor(() => d.state.workItems[item.id].key, 5000);
    const a = d.createAssignment({ workItemId: item.id, agentId: 'cursor', allowedPaths: ['notes/**'] });
    expect(d.state.assignments[a.id].prompt).toContain('## Shared context');
    expect(d.state.assignments[a.id].prompt).toContain(path.join(base, 'Team Contract.md'));
    await d.dispatch(a.id);
    const ap = await waitFor(() => Object.values(d.state.approvals).find((x) => !x.resolvedAt), 20_000, 'approval');
    d.context.flush();
    expect(fs.readFileSync(path.join(base, 'Brief.md'), 'utf8')).toContain(`**Cursor** asks: ${ap.title}`);
    // Context is accessible during this authenticated live run; its token expires at exit.
    const run = Object.values(d.state.runs)[0];
    const token = [...(d.runs as unknown as { tokens: Map<string, string> }).tokens.entries()].find(([, id]) => id === run.id)![0];
    const found = (await d.mcp.call(token, 'search_context', { query: 'tokens rotate' })) as { notes: { hits: { path: string }[] } };
    expect(found.notes.hits.map((x) => x.path)).toContain('Projects/sample/Auth design.md');
    expect(await d.mcp.call(token, 'read_note', { path: 'Personal/Diary.md' })).toMatchObject({ ok: false, error: expect.stringContaining('outside') });
    expect(((await d.mcp.call(token, 'get_brief', {})) as { brief: string }).brief).toContain('## Agents');
    const g = await waitFor(() => d.state.context.graph?.state === 'ready' && d.state.context.graph, 15_000, 'graph');
    expect(g.nodes).toBeGreaterThan(0);
    expect(g.sha).toBe(execFileSync('git', ['rev-parse', 'integration'], { cwd: d.config.project.repo, encoding: 'utf8' }).trim());
    const q = (await d.mcp.call(token, 'query_graph', { question: 'how is math tested' })) as { ok: boolean; result: string };
    expect(q.ok).toBe(true);
    expect(q.result).toContain('math.js');
    expect(fs.readFileSync(path.join(base, 'Graph Report.md'), 'utf8')).toContain('graphify report for `integration`');
    d.resolveApproval(ap.id, 'no', 'test');
    await waitFor(() => d.state.workItems[item.id].evidence.some((e) => e.kind === 'test' && e.verified), 20_000, 'checks');
    d.context.flush();
    const key = d.state.workItems[item.id].key!;
    const issue = fs.readFileSync(path.join(base, 'Issues', `${key}.md`), 'utf8');
    expect(issue).toContain('✅ verified · test');
    expect(issue).toContain('state: "handoff_received"');
    const handoffs = fs.readdirSync(path.join(base, 'Handoffs'));
    expect(handoffs).toHaveLength(1);
    expect(fs.readFileSync(path.join(base, 'Handoffs', handoffs[0]), 'utf8')).toContain('## Verified by the control center');
    const decisions = fs.readdirSync(path.join(base, 'Decisions'));
    expect(fs.readFileSync(path.join(base, 'Decisions', decisions[0]), 'utf8')).toContain('**Answer:** no');
    const brief = fs.readFileSync(path.join(base, 'Brief.md'), 'utf8');
    expect(brief).toContain(`[[${d.context.vault!.folder}/Issues/${key}|${key}]]`);
    expect(brief).toContain('(verified)');

    await expect(d.mcp.call(token, 'get_brief', {})).rejects.toThrow(/expired run token/);
  }, 90_000);

  it.skipIf(!hasGraphify)('real graphify: builds the integration graph locally (no LLM) and answers queries', async () => {
    const { d } = await contextHarness();
    const g = await waitFor(() => (d.state.context.graph?.state === 'ready' || d.state.context.graph?.state === 'error') && d.state.context.graph, 60_000, 'graph');
    expect(g.error).toBeNull();
    expect(g.nodes).toBeGreaterThan(0);
    const out = await d.context.graph!.query('mul');
    expect(out).toContain('mul()');
    expect(await d.context.graph!.explain('mul()')).toContain('src/math.js');
  }, 90_000);
});
