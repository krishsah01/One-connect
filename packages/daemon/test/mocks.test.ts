// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { agentActor, DEFAULT_DESIGN, designCss, HUMAN, mockGate, MOCK_PREVIEW_CSP, REVIEW_CHECKLIST, SYSTEM } from '@acc/core';
import { git, makeConfig, makeRepo, startDaemon, tmpDir, waitFor, type Harness } from './helpers.ts';

import { ensureNativeMockHelper } from './mock-file-helper.ts';
beforeAll(ensureNativeMockHelper);
let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const skill = {
  id: 'mock-review', name: 'Mock review',
  description: 'Use when building or reviewing a design mock for complete states.',
  instructions: 'Cover empty, error and loading states. Load references/states.md for examples.',
  references: [{ path: 'references/states.md', content: '# States\n\nLoading: keep the layout stable.' }],
};
const tokenOf = (d: Harness['d'], runId: string) => [...(d.runs as unknown as { tokens: Map<string, string> }).tokens.entries()].find(([, id]) => id === runId)?.[0];

describe('design mock artifacts', () => {
  it('a design agent run exports frozen skills, writes a mock, registers it and gets honest evidence', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const d = h.d;
    const v1 = d.designer.save(DEFAULT_DESIGN, null);
    d.skillLib.saveDraft(skill, null);
    const published = d.skillLib.publish('mock-review', null, d.state.skills!['mock-review'].draft!.hash);
    const codex = d.state.agents.codex.config;
    d.saveAgent({ ...codex, skills: ['mock-review'] }, codex);
    const item = d.createIssue({ title: 'Settings mock', description: '[fake:design-mock]', acceptance: ['phone and desktop layouts'], labels: ['design'] });
    await waitFor(() => d.state.workItems[item.id].key, 5000, 'key');
    const a = d.createAssignment({ workItemId: item.id, agentId: 'codex', allowedPaths: ['design/**', 'notes/**'] });
    expect(a.prompt).toContain('register_design_mock');
    expect(a.prompt).toContain('mock-review: Use when building');
    await d.dispatch(a.id);
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 30_000, 'handoff');

    const run = Object.values(d.state.runs).find(r => r.assignmentId === a.id)!;
    const wt = d.state.assignments[a.id].worktree!;
    const exported = path.join(wt, '.agents', 'skills', 'mock-review', 'SKILL.md');
    expect(sha(fs.readFileSync(exported))).toBe(published.files.find(f => f.path === 'SKILL.md')!.sha256);
    expect(git(wt, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('.agents/');
    expect(d.store.list({ runId: run.id, types: ['t.message'] }).some(e => e.type === 't.message' && e.data.text.includes('Loaded skill mock-review@1'))).toBe(true);

    const [art] = d.mocks.list({ assignmentId: a.id });
    const key = d.state.workItems[item.id].key!;
    expect(art).toMatchObject({ workItemId: item.id, agentId: 'codex', dir: `design/${key.toLowerCase()}`, issue: { key } });
    const rev = art.revisions[0];
    expect(rev.files.map(f => f.path)).toEqual(['app.js', 'index.html', 'styles.css', 'tokens.css']);
    expect(rev).toMatchObject({ rev: 1, runId: run.id, by: { type: 'agent', id: 'codex' }, designRevision: { hash: v1.hash, version: 1 }, gitSha: git(wt, 'rev-parse', 'HEAD') });
    expect(rev.findings.filter(f => f.severity !== 'info')).toEqual([]);
    expect(rev.gate.state).toBe('clear');
    expect(rev.evidence).toHaveLength(2);
    expect(rev.evidence[0]).toMatchObject({ kind: 'command', command: 'node --test', exitCode: 0, executed: true, verified: true, status: 'passed', source: 'agent', runId: run.id });
    expect(rev.evidence[1]).toMatchObject({ kind: 'viewport', executed: false, verified: false, status: 'not_run', viewport: { width: 390 } });

    const p = d.mocks.preview(art.id, 1);
    expect(p.sandbox).toBe('allow-scripts');
    expect(p.sandbox).not.toContain('allow-same-origin');
    expect(p.html).toContain(`content="${MOCK_PREVIEW_CSP}"`);
    expect(p.html).toContain('<style data-src="styles.css">');
    expect(p.html).toContain('<script data-src="app.js">');
    expect(p.html).not.toMatch(/href="styles\.css"|(?<!data-)src="app\.js"/);

    // HTTP: authenticated, scoped to the install, and refused cross-origin.
    const token = fs.readFileSync(d.paths.installToken, 'utf8').trim();
    const auth = { authorization: `Bearer ${token}` };
    expect((await fetch(`${h.url}/api/mocks/${art.id}/revisions/1/preview`)).status).toBe(401);
    expect((await fetch(`${h.url}/api/mocks/${art.id}/revisions/1/preview`, { headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403);
    const res = await fetch(`${h.url}/api/mocks/${art.id}/revisions/1/preview`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { hash: string }).hash).toBe(rev.hash);
    expect((await fetch(`${h.url}/api/mocks/${art.id}/revisions/1/source?path=..%2F..%2Fpackage.json`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${h.url}/api/mcp/register_design_mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const stale = JSON.parse(fs.readFileSync(path.join(d.paths.runs, run.id, 'mcp.json'), 'utf8')).token;
    await expect(d.mcp.call(stale, 'register_design_mock', { dir: art.dir })).rejects.toThrow(/expired run token/);
  }, 60_000);

  it('live run tokens cannot touch another assignment’s mock, and connector tools stay unapproved', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const d = h.d;
    const other = d.createIssue({ title: 'Other mock', labels: ['design'] });
    const oa = d.createAssignment({ workItemId: other.id, agentId: 'claude', allowedPaths: ['design/**'] });
    const owt = makeRepo();
    fs.mkdirSync(path.join(owt, 'design', 'other'), { recursive: true });
    fs.writeFileSync(path.join(owt, 'design', 'other', 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"></head><body>Other</body></html>');
    d.commit([{ type: 'assignment.worktree_ready', actor: SYSTEM, assignmentId: oa.id, agentId: oa.agentId, workItemId: oa.workItemId, data: { worktree: owt, branch: 'main', baseSha: git(owt, 'rev-parse', 'HEAD') } }]);
    const foreign = await d.mocks.capture(oa.id, 'design/other', HUMAN);

    const item = d.createIssue({ title: 'Ask first', description: '[fake:ask-human]', acceptance: ['notes exist'] });
    await waitFor(() => d.state.workItems[item.id].key, 5000, 'key');
    const a = d.createAssignment({ workItemId: item.id, agentId: 'cursor', allowedPaths: ['notes/**'] });
    await d.dispatch(a.id);
    const ap = await waitFor(() => Object.values(d.state.approvals).find(x => !x.resolvedAt), 20_000, 'approval');
    const run = Object.values(d.state.runs).find(r => r.assignmentId === a.id)!;
    const token = tokenOf(d, run.id)!;
    await expect(d.mcp.call(token, 'record_mock_evidence', { artifactId: foreign.artifact.id, kind: 'command', summary: 'x', command: 'node --test', executed: true, exitCode: 0 })).rejects.toThrow(/another assignment/);
    await expect(d.mcp.call(token, 'register_design_mock', { dir: 'design/other' })).rejects.toThrow(/no worktree|does not exist/);
    await expect(d.mcp.call(token, 'get_skill', { id: 'mock-review' })).rejects.toThrow(/not part of your assignment/);
    expect(await d.mcp.call(token, 'list_connector_tools', {})).toEqual({ connectors: [] });
    await expect(d.mcp.call(token, 'call_connector_tool', { connector: 'nope', tool: 'echo' })).rejects.toThrow(/Unknown connection/);
    expect(d.state.mocks![foreign.artifact.id].revisions[0].evidence).toEqual([]);
    d.resolveApproval(ap.id, 'yes', 'test');
    await waitFor(() => d.state.workItems[item.id].state === 'handoff_received', 20_000, 'handoff');
  }, 60_000);

  it('validates capture, blocks unsafe previews, gates drift with human exceptions and survives restart', async () => {
    const cfg = makeConfig(makeRepo());
    h = await startDaemon(cfg, { probe: false, server: false });
    const d = h.d;
    const v1 = d.designer.save(DEFAULT_DESIGN, null);
    const item = d.createIssue({ title: 'Settings page', labels: ['design'] });
    const a = d.createAssignment({ workItemId: item.id, agentId: 'codex', allowedPaths: ['design/settings/**', 'design/bad-*/**', 'notes/**'] });
    await expect(d.mocks.capture(a.id, 'design/settings', HUMAN)).rejects.toThrow(/no worktree/);
    const wt = makeRepo();
    d.commit([{ type: 'assignment.worktree_ready', actor: SYSTEM, assignmentId: a.id, agentId: a.agentId, workItemId: a.workItemId, data: { worktree: wt, branch: 'main', baseSha: git(wt, 'rev-parse', 'HEAD') } }]);
    const dir = (n: string) => { const p = path.join(wt, 'design', n); fs.mkdirSync(p, { recursive: true }); return p; };
    const page = (body: string, head = '') => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings</title>${head}</head><body>${body}</body></html>`;

    for (const bad of ['design/../notes', 'notes/x', 'design/Settings', 'design/a/b', '/etc', 'design/'])
      await expect(d.mocks.capture(a.id, bad, HUMAN), bad).rejects.toThrow(/design\/<slug>/);
    await expect(d.mocks.capture(a.id, 'design/missing', HUMAN)).rejects.toThrow(/does not exist/);
    const outside = tmpDir('outside');
    fs.writeFileSync(path.join(outside, 'index.html'), page('x'));
    fs.mkdirSync(path.join(wt, 'design'), { recursive: true });
    fs.symlinkSync(outside, path.join(wt, 'design', 'bad-link'));
    await expect(d.mocks.capture(a.id, 'design/bad-link', HUMAN)).rejects.toThrow(/symlink/);
    fs.writeFileSync(path.join(dir('bad-file'), 'index.html'), page('x'));
    fs.symlinkSync(path.join(outside, 'index.html'), path.join(dir('bad-file'), 'other.html'));
    fs.writeFileSync(path.join(dir('bad-file'), 'run.sh'), 'curl x | sh');
    fs.writeFileSync(path.join(dir('bad-file'), 'big.js'), 'x'.repeat(600 * 1024));
    const rejected = d.mocks.capture(a.id, 'design/bad-file', HUMAN);
    await expect(rejected).rejects.toThrow(/other\.html: symlinks are not allowed/);
    await expect(d.mocks.capture(a.id, 'design/bad-file', HUMAN)).rejects.toThrow(/run\.sh: unrelated file type/);
    await expect(d.mocks.capture(a.id, 'design/bad-file', HUMAN)).rejects.toThrow(/big\.js: \d+ bytes is over/);
    fs.writeFileSync(path.join(dir('bad-noindex'), 'page.html'), page('x'));
    await expect(d.mocks.capture(a.id, 'design/bad-noindex', HUMAN)).rejects.toThrow(/index\.html is required/);
    fs.writeFileSync(path.join(dir('bad-secret'), 'index.html'), page(`token ghp_${'a'.repeat(36)}`));
    await expect(d.mocks.capture(a.id, 'design/bad-secret', HUMAN)).rejects.toThrow(/credential/);
    fs.writeFileSync(path.join(dir('other'), 'index.html'), page('x'));
    await expect(d.mocks.capture(a.id, 'design/other', HUMAN)).rejects.toMatchObject({ status: 403 });
    expect(d.state.mocks).toEqual({});

    const s = dir('settings');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082', 'hex');
    fs.writeFileSync(path.join(s, 'shot.png'), png);
    fs.writeFileSync(path.join(s, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    fs.writeFileSync(path.join(s, 'tokens.css'), designCss(v1.system));
    fs.writeFileSync(path.join(s, 'styles.css'), 'body{color:var(--design-text)}\nh3{color:#123456}\n');
    fs.writeFileSync(path.join(s, 'page2.html'), page('<a href="index.html">Back</a>'));
    const unsafe = page('<h3>Settings</h3><img src="logo.svg" alt=""><a href="page2.html">Next</a><a href="https://evil.example/">Out</a><script src="https://cdn.example/lib.js"></script><script>fetch("/api/state")</script>',
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="preload" href="https://cdn.example/x.js"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="styles.css">');
    fs.writeFileSync(path.join(s, 'index.html'), unsafe);
    fs.writeFileSync(path.join(s, '.DS_Store'), 'ignored');
    const r1 = await d.mocks.capture(a.id, 'design/settings/', HUMAN, { title: 'Settings mock' });
    expect(r1.unchanged).toBe(false);
    const rev1 = r1.revision;
    expect(rev1.files.map(f => f.path)).toEqual(['index.html', 'logo.svg', 'page2.html', 'shot.png', 'styles.css', 'tokens.css']);
    const rules = (r: typeof rev1) => r.findings.map(f => `${f.severity}:${f.rule}`).sort();
    expect(rules(rev1)).toEqual(expect.arrayContaining(['error:navigation', 'error:remote-resource', 'warn:network-api', 'warn:off-token-color', 'info:scope']));
    expect(rev1.findings.filter(f => f.rule === 'remote-resource').map(f => f.message.split(' ')[4]).sort()).toEqual(['https://cdn.example/lib.js.', 'https://cdn.example/x.js.', 'https://evil.example/.']);
    expect(new Set(rev1.findings.map(f => f.id)).size).toBe(rev1.findings.length);
    expect(r1.artifact.revisions[0].gate.state).toBe('needs_review');
    expect((await d.mocks.capture(a.id, 'design/settings', HUMAN)).unchanged).toBe(true);

    const swapDir = dir('bad-swap');
    const htmlPath = path.join(swapDir, 'index.html');
    fs.writeFileSync(htmlPath, page('safe capture'));
    fs.writeFileSync(path.join(swapDir, 'tokens.css'), designCss(v1.system));
    const origRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = ((...args: Parameters<typeof origRead>) => {
      if (String(args[0]).startsWith(swapDir)) reads++;
      return origRead(...args);
    }) as typeof fs.readFileSync;
    const buffered = await d.mocks.capture(a.id, 'design/bad-swap', HUMAN);
    fs.writeFileSync(htmlPath, page(`mutated ghp_${'z'.repeat(36)}`));
    fs.readFileSync = origRead;
    expect(reads).toBe(0);
    expect(d.mocks.readSource(buffered.artifact.id, buffered.revision.rev, 'index.html').content).toContain('safe capture');

    const p = d.mocks.preview(r1.artifact.id, 1);
    expect(p.pages).toEqual(['index.html', 'page2.html']);
    expect(p.html).not.toMatch(/http-equiv="refresh"|<base|rel="preload"/);
    expect(p.html.indexOf('Content-Security-Policy')).toBeLessThan(p.html.indexOf('<h3>'));
    expect(p.html).toContain('src="data:image/svg+xml;base64,');
    expect(p.html).toContain('<style data-src="tokens.css">');
    // window.open still returns null; the guard now also tells the preview shell why nothing opened.
    expect(p.html).toContain("window.open=(...a)=>{block('popup',a[0]);return null}");
    expect(p.html).not.toMatch(/loc\.assign=loc\.replace|Object\.defineProperty\(loc/);
    expect(p.shell).toContain("frame-src 'none'");
    expect(p.execution).toBe('native-isolated');
    expect(d.mocks.preview(r1.artifact.id, 1, 'page2.html').html).toContain('Back');
    expect(() => d.mocks.preview(r1.artifact.id, 1, '../index.html')).toThrow(/Unknown mock page/);
    expect(() => d.mocks.preview(r1.artifact.id, 1, 'styles.css')).toThrow(/Unknown mock page/);
    expect(d.mocks.readSource(r1.artifact.id, 1, 'index.html').content).toBe(unsafe);
    expect(d.mocks.readSource(r1.artifact.id, 1, 'shot.png')).toMatchObject({ encoding: 'base64', content: png.toString('base64') });

    const errorIds = rev1.findings.filter(f => f.severity === 'error').map(f => f.id);
    const offToken = rev1.findings.find(f => f.rule === 'off-token-color')!.id;
    expect(() => d.mocks.addException(r1.artifact.id, 1, errorIds.slice(0, 1), 'We accept the CDN for now')).toThrow(/must be fixed/);
    expect(() => d.mocks.addException(r1.artifact.id, 1, [offToken], 'agent wants it', agentActor('codex'))).toThrow(/Only a human/);
    expect(() => d.mocks.addException(r1.artifact.id, 1, [offToken], 'short')).toThrow(/10\+/);
    expect(() => d.mocks.review(r1.artifact.id, 1, 'approved', 'ok')).toThrow(/open finding/);
    expect(() => d.mocks.review(r1.artifact.id, 1, 'approved', 'ok', agentActor('codex'))).toThrow(/Only a human/);

    // A human fixes the page through the scoped edit API: a new revision, rev 1 unchanged.
    const fixed = page('<h3>Settings</h3><img src="logo.svg" alt=""><a href="page2.html">Next</a><script>document.body.dataset.ready="1"</script>', '<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="styles.css">');
    await expect(d.mocks.editSource(r1.artifact.id, 'index.html', fixed, 'stale')).rejects.toThrow(/changed since you opened/);
    await expect(d.mocks.editSource(r1.artifact.id, '../../notes/x.md', 'x', null)).rejects.toThrow(/Invalid file path/);
    await expect(d.mocks.editSource(r1.artifact.id, 'shot.png', 'x', null)).rejects.toThrow(/Only text/);
    const r2 = await d.mocks.editSource(r1.artifact.id, 'index.html', fixed, d.mocks.readSource(r1.artifact.id, 1, 'index.html').sha256);
    expect(r2.revision.rev).toBe(2);
    expect(r2.revision.by).toEqual(HUMAN);
    expect(fs.readFileSync(path.join(s, 'index.html'), 'utf8')).toBe(fixed);
    expect(d.mocks.readSource(r1.artifact.id, 1, 'index.html').content).toBe(unsafe);
    expect(d.state.mocks![r1.artifact.id].revisions[0].hash).toBe(rev1.hash);
    expect(rules(r2.revision)).toEqual(['info:scope', 'warn:off-token-color']);

    const id = r1.artifact.id;
    const off2 = r2.revision.findings.find(f => f.rule === 'off-token-color')!.id;
    // Finding ids survive event-log redaction unchanged.
    expect(d.state.mocks![id].revisions.map(r => r.findings)).toEqual([rev1.findings, r2.revision.findings]);
    expect(d.mocks.addException(id, 2, [off2], 'Heading accent approved by design lead').revisions[1].gate.state).toBe('excepted');
    // Approval needs a passing checklist with a rendered basis, and the author cannot be the only approver.
    const passAll = REVIEW_CHECKLIST.map(c => ({ id: c.id, result: 'pass' as const, basis: c.id === 'contrast' ? 'static' as const : 'human' as const }));
    expect(() => d.mocks.review(id, 2, 'approved', 'ok')).toThrow(/checklist item must pass/);
    expect(() => d.mocks.review(id, 2, 'approved', 'ok', HUMAN, { checklist: passAll.map(c => ({ ...c, basis: 'static' })) })).toThrow(/Static checks cannot pass/);
    expect(() => d.mocks.review(id, 2, 'approved', 'ok', HUMAN, { checklist: passAll.map(c => c.id === 'keyboard' ? { ...c, basis: 'browser' } : c) })).toThrow(/browser basis needs passed, executed evidence/);
    expect(r2.revision.authoredBy).toEqual(HUMAN);
    const selfApproved = d.mocks.review(id, 2, 'approved', 'Looks right at phone and desktop', HUMAN, { checklist: passAll }).revisions[1];
    expect(selfApproved.gate.state).toBe('needs_independent_review');
    expect(selfApproved.reviews.at(-1)).toMatchObject({ independent: false, hash: r2.revision.hash, designHash: v1.hash });
    // An independent agent review (recorded by submit_design_review in a review run) completes it.
    d.commit([{ type: 'design.mock_reviewed', actor: agentActor('claude'), agentId: 'claude', data: { artifactId: id, rev: 2, review: { decision: 'approved', note: 'Independent static review', by: agentActor('claude'), at: new Date().toISOString(), hash: r2.revision.hash, designHash: v1.hash, independent: true, checklist: passAll.map(c => ({ ...c, basis: 'static', evidenceIds: [] })) } } }]);
    expect(d.mocks.view(d.mocks.get(id)).revisions[1].gate.state).toBe('approved');

    // A newer contract is drift: a visible review gate until a human records an exception.
    const v2 = d.designer.save({ ...DEFAULT_DESIGN, radius: 12 }, v1.hash);
    const drifted = d.mocks.view(d.mocks.get(id)).revisions[1].gate;
    expect(drifted.state).toBe('needs_review');
    expect(drifted.drift?.id).toBe(`contract-drift:${v2.hash.slice(0, 12)}`);
    expect(() => d.mocks.review(id, 2, 'approved', 'again')).toThrow(/open finding/);
    const issue = d.mocks.findingToIssue(id, 2, drifted.drift!.id);
    expect(issue.labels).toEqual(['finding', 'design']);
    expect(issue.description).toContain(`revision 2, content ${r2.revision.hash.slice(0, 12)}, contract v1`);
    d.mocks.addException(id, 2, [drifted.drift!.id], 'v2 only changes radius; mock stays on v1 for this review');
    expect(d.mocks.view(d.mocks.get(id)).revisions[1].gate.state).toBe('approved');

    const ex = d.mocks.export(id, 2);
    expect(ex.manifest).toMatchObject({ revision: 2, contentHash: r2.revision.hash, designContract: { hash: v1.hash, version: 1 }, gate: 'approved', openFindings: [] });
    expect(ex.manifest.note).toMatch(/do not prove visual compliance/);
    expect(ex.tokensCss).toBe(designCss(v1.system));
    expect(ex.designMarkdown).toContain(`Design contract v1 · SHA-256 ${v1.hash}`);
    expect(ex.files.find(f => f.path === 'index.html')!.content).toBe(fixed);

    // Evidence: unexecuted or unverifiable claims are never shown as passed.
    expect(d.mocks.addEvidence(id, 2, { kind: 'viewport', summary: 'phone', executed: false, status: 'passed', viewport: { width: 390, height: 844 } }, HUMAN).status).toBe('not_run');
    expect(d.mocks.addEvidence(id, 2, { kind: 'command', summary: 'tests', command: 'pnpm test', exitCode: 0, executed: true, status: 'passed' }, agentActor('codex'))).toMatchObject({ status: 'not_run', verified: false, source: 'agent' });
    expect(d.mocks.addEvidence(id, 2, { kind: 'screenshot', summary: 'desktop', executed: true, status: 'passed', screenshot: 'shot.png', viewport: { width: 1280, height: 800 } }, HUMAN)).toMatchObject({ status: 'passed', executed: true, verified: false, source: 'human', screenshot: { sha256: sha(png) } });
    expect(() => d.mocks.addEvidence(id, 2, { kind: 'screenshot', summary: 'x', executed: true, screenshot: 'index.html' }, HUMAN)).toThrow(/image file captured/);
    expect(() => d.mocks.addEvidence(id, 2, { kind: 'viewport', summary: 'x', viewport: { width: 1, height: 1 } }, HUMAN)).toThrow(/between 240/);

    const note = d.mocks.contextNote();
    expect(note).toContain('## Settings mock');
    expect(note).toContain(`Revision 2, content SHA-256 \`${r2.revision.hash}\``);
    expect(note).toContain('Review gate: approved');
    expect(note).toContain('static checks do not prove visual compliance');

    const dataDir = h.dataDir;
    await h.close(); h = null;
    h = await startDaemon(cfg, { probe: false, server: false, dataDir });
    const after = h.d.mocks.get(id);
    expect(after.revisions.map(r => r.hash)).toEqual([rev1.hash, r2.revision.hash]);
    expect(mockGate(after.revisions[1], h.d.state.design!.hash).state).toBe('approved');
    expect(h.d.mocks.preview(id, 2).hash).toBe(r2.revision.hash);
    const blob = path.join(dataDir, 'design-mocks', 'blobs', r2.revision.files.find(f => f.path === 'styles.css')!.sha256);
    fs.writeFileSync(blob, 'h3{color:red}');
    expect(() => h!.d.mocks.preview(id, 2)).toThrow(/integrity/);

    const vault = tmpDir('vault');
    await h.d.connectKnowledge({ vault, context_folders: [], obsidian_cli: 'off' });
    h.d.context.flush();
    const notePath = await waitFor(() => {
      const hits: string[] = [];
      const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) e.isDirectory() ? walk(path.join(p, e.name)) : e.name === 'Design artifacts.md' && hits.push(path.join(p, e.name)); };
      walk(vault);
      return hits[0];
    }, 5000, 'design artifacts note');
    expect(fs.readFileSync(notePath, 'utf8')).toContain(r2.revision.hash);
  }, 60_000);
});
