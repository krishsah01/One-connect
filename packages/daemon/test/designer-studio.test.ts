// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Designer studio end to end, with the repository's labelled fixture CLIs (no model, no network).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentActor, DEFAULT_DESIGN, designCss, HUMAN, jobStatus, mockGate, REVIEW_CHECKLIST, SYSTEM } from '@acc/core';
import { SKILL_SETS } from '../src/designer.ts';
import { ensureNativeMockHelper } from './mock-file-helper.ts';
import { git, makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

beforeAll(ensureNativeMockHelper);
let harnesses: Harness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.close(); });
const start = async (...args: Parameters<typeof startDaemon>) => { const h = await startDaemon(...args); harnesses.push(h); return h; };
const stop = async (h: Harness) => { harnesses = harnesses.filter(x => x !== h); await h.close(); };

const BRIEF = {
  title: 'Release checks',
  brief: 'Engineers need to see which release checks failed, why, and re-run one without leaving the page.',
  audience: 'Release engineers on laptops; on-call engineers on phones',
  screens: [{ name: 'Overview', purpose: 'Status summary' }, { name: 'Checks', purpose: 'Filterable list' }, { name: 'Check detail', purpose: 'Logs and re-run' }],
  states: ['empty', 'loading', 'error', 'success'],
  interactions: 'Filter by status; re-run from a dialog',
  fixtures: 'Six checks, one with a very long name',
  agentId: 'codex',
};
const PASS = REVIEW_CHECKLIST.map(c => ({ id: c.id, result: 'pass', basis: c.id === 'contrast' ? 'static' : 'human' }));
const phase = (d: Harness['d'], jobId: string) => jobStatus(d.state.designStudio!.jobs[jobId], d.state);
const page = (body: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock</title><link rel="stylesheet" href="tokens.css"></head><body style="color:var(--design-text)">${body}</body></html>`;

describe('Designer studio', () => {
  it('runs a brief through dispatch, a question, capture, review, refinement, drift, engineering handoff and restart', async () => {
    const cfg = makeConfig(makeRepo());
    let h = await start(cfg);
    let d = h.d;

    // 1. A versioned contract: validate without saving, drafts stay drafts, save is immutable and human.
    expect(() => d.designer.studio.createJob(BRIEF, HUMAN)).toThrow(/Save a project design system/);
    expect(d.designer.validate(DEFAULT_DESIGN)).toMatchObject({ ok: true, unchanged: false });
    expect(d.state.design).toBeNull();
    d.designer.saveDraft('system', { ...DEFAULT_DESIGN, radius: 10 });
    expect(d.designer.draft('system')?.value).toMatchObject({ radius: 10 });
    expect(() => d.designer.saveDraft('system', { ...DEFAULT_DESIGN, rules: `token ghp_${'a'.repeat(36)}` })).toThrow(/credentials/);
    const v1 = d.designer.save(DEFAULT_DESIGN, null, 'First contract');
    expect(v1).toMatchObject({ version: 1, by: HUMAN, parent: null, note: 'First contract' });
    expect(d.designer.draft('system')).toBeNull();

    // 2. Brief → issue + draft assignment, frozen to v1, with an exact and bounded prompt.
    const created = d.designer.studio.createJob(BRIEF, HUMAN);
    const job = created.job;
    expect(job).toMatchObject({ kind: 'generate', dir: 'design/release-checks', designRevision: { hash: v1.hash, version: 1 } });
    expect(created.status.phase).toBe('draft');
    const a0 = d.state.assignments[job.assignmentId];
    expect(a0).toMatchObject({ position: 'draft', allowedPaths: ['design/release-checks/**'], designRevision: v1.hash });
    expect(a0.prompt).toContain('## Design deliverable (Designer studio generate job');
    expect(a0.prompt).toContain('`index.html` (Overview), `checks.html` (Checks), `check-detail.html` (Check detail)');
    expect(a0.prompt).toContain(`contract v1, SHA-256 ${v1.hash}`);
    expect(a0.prompt).toContain('localStorage, sessionStorage, IndexedDB and cookies are unavailable');
    expect(a0.prompt).toContain('- responsive-mocks:');
    expect(a0.prompt).not.toContain('BRIEF INFERENCE');
    expect(a0.prompt.length).toBeLessThan(10_000);
    const item = d.state.workItems[job.workItemId];
    expect(item.labels).toEqual(['design', 'ui', 'mock']);
    expect(item.description).toContain('`checks.html` — Checks: Filterable list');

    // 3. Dispatch through the normal machinery; the agent's question is answered inside One Connect.
    await waitFor(() => d.state.workItems[item.id].key, 5000, 'issue key');
    await d.dispatch(a0.id);
    const ap = await waitFor(() => Object.values(d.state.approvals).find(x => !x.resolvedAt && x.workItemId === item.id), 30_000, 'agent question');
    expect(ap.title).toMatch(/list failures before passing items/);
    expect(phase(d, job.id).phase).toBe('waiting');
    d.resolveApproval(ap.id, 'yes', 'test');
    const done = await waitFor(() => { const s = phase(d, job.id); return s.phase === 'captured' && s; }, 45_000, 'captured mock');
    const run = done.run!;
    const said = d.store.list({ runId: run.id, types: ['t.message'], limit: 1000 }).map(e => (e.type === 't.message' ? e.data.text : ''));
    expect(said.some(t => t.includes('Loaded skill responsive-mocks'))).toBe(true);
    expect(said.some(t => t.includes('The owner answered: yes'))).toBe(true);
    expect(said.some(t => t.includes('Fixture design agent: no model is called'))).toBe(true);

    // 4. The captured revision: every page, identity, structured handoff and verified evidence.
    const id = done.artifactId!;
    const r1 = d.mocks.get(id).revisions[0];
    expect(r1.files.map(f => f.path)).toEqual(['app.js', 'check-detail.html', 'checks.html', 'data.js', 'index.html', 'styles.css', 'tokens.css']);
    expect(r1).toMatchObject({ rev: 1, runId: run.id, origin: 'agent', authoredBy: { type: 'agent', id: 'codex' }, assignmentId: a0.id, designRevision: { hash: v1.hash, version: 1 }, gitSha: git(a0.worktree ?? d.state.assignments[a0.id].worktree!, 'rev-parse', 'HEAD') });
    expect(r1.handoff).toMatchObject({ pages: [{ path: 'index.html' }, { path: 'checks.html' }, { path: 'check-detail.html' }], states: ['empty', 'loading', 'error', 'success'], designHash: v1.hash });
    expect(r1.findings.filter(f => f.severity !== 'info').map(f => `${f.id}: ${f.message}`)).toEqual([]);
    expect(r1.evidence[0]).toMatchObject({ kind: 'command', verified: true, status: 'passed', artifactHash: r1.hash, designHash: v1.hash, tool: 'node' });
    await new Promise(r => setTimeout(r, 400));
    expect(d.mocks.get(id).revisions).toHaveLength(1);
    const p = d.mocks.preview(id, 1, 'checks.html');
    expect(p.pages).toEqual(['check-detail.html', 'checks.html', 'index.html']);
    for (const name of p.pages) expect(p.shell).toContain(JSON.stringify(name));
    expect(p.static).not.toMatch(/<script/i);
    expect(p.static).toContain('data-href="index.html"');

    // 5. Independent human review with a checklist tied to this exact revision.
    const ev = d.mocks.addEvidence(id, 1, { kind: 'viewport', summary: 'Layouts hold at phone and desktop', action: 'Opened every page at phone and desktop widths', tool: 'One Connect native preview', page: 'checks.html', executed: true, status: 'passed', viewport: { name: 'phone', width: 390, height: 844 } }, HUMAN);
    expect(ev).toMatchObject({ status: 'passed', verified: false, source: 'human', page: 'checks.html', artifactHash: r1.hash });
    const approved = d.mocks.review(id, 1, 'approved', 'States complete', HUMAN, { checklist: PASS.map(c => (c.id === 'responsive' ? { ...c, basis: 'browser', evidenceIds: [ev.id] } : c)) });
    expect(approved.revisions[0].gate.state).toBe('approved');
    expect(approved.revisions[0].reviews[0]).toMatchObject({ independent: true, hash: r1.hash, designHash: v1.hash });

    // 6. Refine in the same session: a new immutable revision; the approval stays on revision 1.
    const refined = await d.designer.studio.refine(id, 1, 'checks.html: keep filters in the error state', {}, HUMAN);
    expect(refined.job).toMatchObject({ kind: 'refine', mode: 'follow-up', assignmentId: a0.id, fromRev: 1 });
    await waitFor(() => phase(d, refined.job.id).phase === 'captured', 45_000, 'revision 2 and its run finished');
    const r2 = d.mocks.get(id).revisions[1];
    expect(r2).toMatchObject({ rev: 2, parentRev: 1, assignmentId: a0.id, designRevision: { hash: v1.hash } });
    const cmp = d.mocks.compare(id, 1, 2, 'index.html');
    expect(cmp.changed).toContain('index.html');
    expect(cmp.diff!.some(l => l.op === '+' && l.text.includes('Refined: checks.html: keep filters'))).toBe(true);
    expect(d.mocks.view(d.mocks.get(id)).status).toMatchObject({ latestRev: 2, approvedRev: 1, approvedIsLatest: false });
    expect(d.mocks.readSource(id, 1, 'index.html').content).not.toContain('Refined:');
    await expect(d.designer.studio.refine(id, 1, 'too old', {}, HUMAN)).rejects.toThrow(/latest revision \(2\)/);

    // 7. A new contract: drift is explicit, the old approval is stale, engineering is refused.
    const v2 = d.designer.save({ ...DEFAULT_DESIGN, radius: 12 }, v1.hash);
    expect(d.designer.diff(v1.hash, v2.hash).changes).toEqual([{ field: 'radius', label: 'Corner radius', before: '8px', after: '12px' }]);
    expect(d.state.assignments[a0.id].designRevision).toBe(v1.hash);
    const view = d.mocks.view(d.mocks.get(id));
    expect(view.revisions[0].gate).toMatchObject({ state: 'needs_review', approval: { valid: false } });
    expect(view.status.staleApproval?.rev).toBe(1);
    expect(() => d.designer.studio.prepareEngineering(id, 1, { agentId: 'claude' })).toThrow(/needs review/);

    // 8. Refine onto v2 with a scoped child task; captures continue the same artifact.
    await waitFor(() => !Object.values(d.state.runs).some(r => r.assignmentId === a0.id && ['queued', 'starting', 'running'].includes(r.state)), 20_000, 'follow-up idle');
    const moved = await d.designer.studio.refine(id, 2, 'Adopt the v2 corner radius', { mode: 'new-assignment' }, HUMAN);
    const a1 = d.state.assignments[moved.job.assignmentId];
    expect(moved.job).toMatchObject({ mode: 'new-assignment', designRevision: { hash: v2.hash } });
    expect(a1).toMatchObject({ position: 'draft', allowedPaths: ['design/release-checks/**'], baseRef: d.state.assignments[a0.id].branch, designRevision: v2.hash });
    expect(d.state.workItems[moved.job.workItemId].parentKey).toBe(d.state.workItems[item.id].key);
    expect(a1.prompt).toContain('## Design deliverable (Designer studio refine job');
    await waitFor(() => d.state.workItems[moved.job.workItemId].key, 5000, 'child key');
    await d.dispatch(a1.id);
    await waitFor(() => phase(d, moved.job.id).phase === 'captured', 45_000, 'revision 3 and its run finished');
    const r3 = d.mocks.get(id).revisions[2];
    expect(r3).toMatchObject({ rev: 3, assignmentId: a1.id, designRevision: { hash: v2.hash, version: 2 } });
    expect(Object.keys(d.state.mocks!)).toEqual([id]);
    expect(d.mocks.view(d.mocks.get(id)).revisions[2].gate.state).toBe('clear');

    // 9. Approve the exact revision, export the bundle and prepare engineering bound to it.
    d.mocks.review(id, 3, 'approved', 'Ready for engineering', HUMAN, { checklist: PASS });
    expect(() => d.mocks.export(id, 2, { approvedOnly: true })).toThrow(/Only an approved revision/);
    const bundle = d.mocks.export(id, 3, { approvedOnly: true });
    expect(bundle.manifest).toMatchObject({ revision: 3, contentHash: r3.hash, gate: 'approved', designContract: { hash: v2.hash }, published: false, approval: { by: 'human:owner' } });
    expect(bundle.manifest.evidence.length).toBeGreaterThan(0);
    expect(bundle.designMarkdown).toContain(`Design contract v2 · SHA-256 ${v2.hash}`);
    expect(bundle.tokensCss).toBe(designCss(v2.system));
    expect(bundle.tokensJson).toMatchObject({ $extensions: { 'one-connect': { contract: { hash: v2.hash } } } });
    expect(bundle.handoffMd).toContain('Nothing was published');
    const eng = d.designer.studio.prepareEngineering(id, 3, { agentId: 'claude', allowedPaths: ['src/**'], notes: 'Use the existing table component' });
    const ea = d.state.assignments[eng.job.assignmentId], ei = d.state.workItems[eng.job.workItemId];
    expect(eng.job).toMatchObject({ kind: 'engineering', identity: { contentHash: r3.hash, designHash: v2.hash } });
    expect(eng.status.phase).toBe('prepared');
    expect(ea).toMatchObject({ position: 'draft', designRevision: v2.hash, allowedPaths: ['src/**'] });
    expect(ei.description).toContain(r3.hash);
    expect(ei.description).toContain(v2.hash);
    expect(ei.labels).toEqual(['design-implementation', 'frontend']);
    expect(ei.acceptance.join('\n')).toMatch(/tokens/);
    expect(ea.skills!.map(s => s.id).sort()).toEqual([...SKILL_SETS.implementation].sort());
    expect(ea.prompt).toContain('Implement only the approved design identity');

    // 10. Restart: revisions, previews, approvals, jobs and evidence are reproducible.
    const dataDir = h.dataDir;
    await stop(h);
    h = await start(cfg, { dataDir });
    d = h.d;
    const after = d.mocks.get(id);
    expect(after.revisions.map(r => r.hash)).toEqual([r1.hash, r2.hash, r3.hash]);
    expect(d.mocks.preview(id, 1).hash).toBe(r1.hash);
    expect(mockGate(after.revisions[2], d.state.design!.hash).state).toBe('approved');
    expect(Object.keys(d.state.designStudio!.jobs).sort()).toEqual([job.id, refined.job.id, moved.job.id, eng.job.id].sort());
    expect(after.revisions[0].evidence.find(e => e.id === ev.id)).toMatchObject({ action: 'Opened every page at phone and desktop widths' });
    expect(d.designer.history().map(r => r.version)).toEqual([1, 2]);
  }, 240_000);

  it('records a failed automatic capture when a run ends without a mock, and captures on request', async () => {
    const h = await start(makeConfig(makeRepo()));
    const d = h.d;
    d.designer.save(DEFAULT_DESIGN, null);
    const { job } = d.designer.studio.createJob({ ...BRIEF, title: 'Silent agent', brief: 'This fixture run finishes without writing a mock folder. [fake:success]', screens: BRIEF.screens.slice(0, 2) }, HUMAN);
    await waitFor(() => d.state.workItems[job.workItemId].key, 5000, 'key');
    await d.dispatch(job.assignmentId);
    const failed = await waitFor(() => { const s = phase(d, job.id); return s.phase === 'capture_failed' && s; }, 45_000, 'capture failure');
    expect(failed.capture).toMatchObject({ trigger: 'auto', ok: false, error: expect.stringMatching(/does not exist/) });
    expect(Object.keys(d.state.mocks ?? {})).toEqual([]);
    const wt = d.state.assignments[job.assignmentId].worktree!;
    const folder = path.join(wt, job.dir);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'tokens.css'), designCss(d.state.design!.system));
    fs.writeFileSync(path.join(folder, 'index.html'), page('<h1>Overview</h1>'));
    fs.symlinkSync(path.join(wt, 'package.json'), path.join(folder, 'linked.html'));
    await expect(d.designer.studio.captureJob(job.id, HUMAN)).rejects.toThrow(/symlinks are not allowed/);
    expect(phase(d, job.id)).toMatchObject({ phase: 'capture_failed', capture: { trigger: 'human', error: expect.stringMatching(/symlink/) } });
    fs.unlinkSync(path.join(folder, 'linked.html'));
    const r = await d.designer.studio.captureJob(job.id, HUMAN);
    expect(r.revision).toMatchObject({ rev: 1, origin: 'capture', by: HUMAN, authoredBy: { type: 'agent', id: 'codex' } });
    expect(r.revision.findings.map(f => f.id)).toEqual(expect.arrayContaining(['handoff:missing', 'brief:page:checks.html']));
    expect(phase(d, job.id).phase).toBe('captured');
    expect(Object.values(d.state.designStudio!.captures).filter(c => c.jobId === job.id).map(c => [c.trigger, c.ok])).toEqual([['auto', false], ['human', false], ['human', true]]);
  }, 120_000);

  it('keeps independent review independent: an author edit needs a non-author reviewer, done over MCP', async () => {
    const h = await start(makeConfig(makeRepo()));
    const d = h.d;
    d.designer.save(DEFAULT_DESIGN, null);
    const { job } = d.designer.studio.createJob({ ...BRIEF, title: 'Reviewed mock', screens: BRIEF.screens.slice(0, 1) }, HUMAN);
    await waitFor(() => d.state.workItems[job.workItemId].key, 5000, 'key');
    await d.dispatch(job.assignmentId);
    const ap = await waitFor(() => Object.values(d.state.approvals).find(x => !x.resolvedAt), 30_000, 'question');
    d.resolveApproval(ap.id, 'no', 'test');
    const done = await waitFor(() => { const s = phase(d, job.id); return s.phase === 'captured' && s; }, 45_000, 'captured');
    const id = done.artifactId!;
    await waitFor(() => !Object.values(d.state.runs).some(r => ['queued', 'starting', 'running'].includes(r.state)), 20_000, 'idle');
    const src = d.mocks.readSource(id, 1, 'index.html');
    const edited = await d.mocks.editSource(id, 'index.html', src.content.replace('</main>', '<p>Edited by the owner.</p></main>'), src.sha256);
    expect(edited.revision).toMatchObject({ rev: 2, origin: 'edit', authoredBy: HUMAN });
    expect(d.mocks.review(id, 2, 'approved', 'Mine', HUMAN, { checklist: PASS }).revisions[1].gate.state).toBe('needs_independent_review');
    expect(() => d.designer.studio.requestReview(id, 1, 'codex', HUMAN)).toThrow(/cannot review their own/);
    expect(() => d.mocks.agentRead(id, 2, 'nope')).toThrow(/another assignment/);
    const rv = d.designer.studio.requestReview(id, 2, 'claude', HUMAN);
    const ra = d.state.assignments[rv.job.assignmentId];
    expect(ra).toMatchObject({ allowedPaths: ['notes/design-reviews/**'], requiredChecks: [] });
    expect(ra.skills!.map(s => s.id).sort()).toEqual([...SKILL_SETS.review].sort());
    expect(ra.prompt).toContain('## Independent design review');
    expect(d.mocks.agentRead(id, 2, ra.id)).toMatchObject({ rev: 2, files: expect.any(Array) });
    expect(() => d.mocks.agentReview(id, 2, { verdict: 'approve', summary: 'x' }, agentActor('claude'), 'run_missing')).toThrow(/not asked to review/);
    await waitFor(() => d.state.workItems[rv.job.workItemId].key, 5000, 'review key');
    await d.dispatch(ra.id);
    await waitFor(() => d.mocks.get(id).revisions[1].reviews.some(v => v.by.type === 'agent'), 45_000, 'agent review');
    const r2 = d.mocks.view(d.mocks.get(id)).revisions[1];
    expect(r2.reviews.at(-1)).toMatchObject({ decision: 'approved', by: { type: 'agent', id: 'claude' }, independent: true, hash: r2.hash });
    expect(r2.reviews.at(-1)!.checklist!.every(c => c.basis === 'static' && c.result === 'pass')).toBe(true);
    expect(r2.gate.state).toBe('approved');
  }, 180_000);

  it('refuses hostile evidence, keeps evidence out of mock content and surfaces handoff claims that do not match', async () => {
    const h = await start(makeConfig(makeRepo()), { probe: false, server: false });
    const d = h.d;
    const v1 = d.designer.save(DEFAULT_DESIGN, null);
    const item = d.createIssue({ title: 'Hostile mock', labels: ['design'] });
    const a = d.createAssignment({ workItemId: item.id, agentId: 'codex', allowedPaths: ['design/hostile/**'] });
    const wt = makeRepo();
    d.commit([{ type: 'assignment.worktree_ready', actor: SYSTEM, assignmentId: a.id, agentId: a.agentId, workItemId: a.workItemId, data: { worktree: wt, branch: 'main', baseSha: git(wt, 'rev-parse', 'HEAD') } }]);
    const dir = path.join(wt, 'design', 'hostile');
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082', 'hex');
    fs.writeFileSync(path.join(dir, 'evidence', 'shot.png'), png);
    fs.writeFileSync(path.join(dir, 'evidence', 'source.png'), 'const notAnImage = true;');
    fs.symlinkSync(path.join(wt, 'package.json'), path.join(dir, 'evidence', 'link.png'));
    fs.writeFileSync(path.join(dir, 'tokens.css'), designCss(v1.system));
    fs.writeFileSync(path.join(dir, 'index.html'), page('<script>localStorage.setItem("x","1")</script>'));
    const cap = await d.mocks.capture(a.id, 'design/hostile', agentActor('codex'), { handoff: { pages: [{ path: 'missing.html' }], designHash: 'b'.repeat(64) } });
    expect(cap.revision.files.map(f => f.path)).toEqual(['index.html', 'tokens.css']);
    expect(cap.revision.findings.map(f => f.id)).toEqual(expect.arrayContaining(['storage:index.html:localStorage', 'handoff:page:missing.html', `handoff:contract:${'b'.repeat(12)}`]));
    fs.writeFileSync(path.join(dir, 'index.html'), page('<p>Second</p>'));
    const invalid = await d.mocks.capture(a.id, 'design/hostile', agentActor('codex'), { handoff: { pages: 'not a list' } });
    expect(invalid.revision.handoff).toBeNull();
    expect(invalid.revision.findings.map(f => f.id)).toContain('handoff:invalid');
    const id = cap.artifact.id;
    // Human uploads are images within the limit; agents cannot upload bytes directly.
    const shot = d.mocks.addEvidence(id, 1, { kind: 'screenshot', summary: 'desktop render', executed: true, status: 'passed', image: png.toString('base64'), viewport: { width: 1280, height: 800 } }, HUMAN);
    expect(shot.screenshot).toMatchObject({ stored: 'evidence', bytes: png.length });
    expect(d.mocks.evidenceImage(id, shot.id).mime).toBe('image/png');
    expect(() => d.mocks.addEvidence(id, 1, { kind: 'screenshot', summary: 'x', image: Buffer.from('<svg/>').toString('base64'), viewport: { width: 1280, height: 800 } }, HUMAN)).toThrow(/PNG, JPEG or WebP/);
    expect(() => d.mocks.addEvidence(id, 1, { kind: 'screenshot', summary: 'x', image: 'A'.repeat(8 * 1024 * 1024), viewport: { width: 1280, height: 800 } }, HUMAN)).toThrow(/too large/);
    expect(() => d.mocks.addEvidence(id, 2, { kind: 'screenshot', summary: 'x', image: png.toString('base64') }, agentActor('codex'), 'run_x')).toThrow(/Agents attach screenshots/);
    for (const bad of ['../package.json', 'evidence/../../x.png', '/etc/passwd', 'evidence/sub/../x.png']) expect(() => d.mocks.addEvidence(id, 1, { kind: 'screenshot', summary: 'x', screenshot: bad }, agentActor('codex'), 'run_x'), bad).toThrow(/screenshot must be/);
    // The worktree read path refuses symlinks and non-images, and accepts a real screenshot.
    const read = (rel: string) => (d.mocks as unknown as { readEvidenceFile: (a: string, dir: string, rel: string) => Buffer }).readEvidenceFile(a.id, 'design/hostile', rel);
    expect(() => read('evidence/link.png')).toThrow(/symlink/);
    expect(read('evidence/shot.png').equals(png)).toBe(true);
    expect(read('evidence/source.png').toString()).toContain('notAnImage');
    // Evidence images never change the revision identity.
    fs.writeFileSync(path.join(dir, 'evidence', 'shot2.png'), png);
    expect((await d.mocks.capture(a.id, 'design/hostile', HUMAN)).unchanged).toBe(true);
    // Drafts are scoped by key and refuse traversal-shaped keys.
    for (const key of ['../x', 'source:mock:../../etc', 'other']) expect(() => d.designer.saveDraft(key, 'x'), key).toThrow(/Unknown draft/);
  }, 60_000);

  it('keeps studio state per project and reads schema 1 contracts without rewriting them', async () => {
    const cfgA = makeConfig(makeRepo());
    const a = await start(cfgA, { probe: false, server: false });
    const b = await start(makeConfig(makeRepo()), { probe: false, server: false });
    const legacy = { name: 'Old system', direction: 'Kept from before the upgrade', colors: { background: '#f3f6f7', surface: '#ffffff', text: '#18343b', muted: '#526870', accent: '#087e8b', accentText: '#ffffff', border: '#c9d6da' }, typography: 'system', spacing: 'compact', radius: 6, motion: 'subtle', rules: '' };
    const old = { version: 1, hash: 'c'.repeat(64), system: legacy as never, createdAt: new Date().toISOString() };
    a.d.commit([{ type: 'design.system_saved', actor: HUMAN, data: { revision: old } }], [], () => a.d.store.kvSet(`design:revision:${old.hash}`, JSON.stringify(old)));
    expect(a.d.designer.exports()!.css).toBe(':root {\n  --design-background: #f3f6f7;\n  --design-surface: #ffffff;\n  --design-text: #18343b;\n  --design-muted: #526870;\n  --design-accent: #087e8b;\n  --design-accent-text: #ffffff;\n  --design-border: #c9d6da;\n  --design-radius: 6px;\n  --design-space: 4px;\n  --design-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\n}\n');
    expect(a.d.designer.fullExports()!.schema).toBe(1);
    const v2 = a.d.designer.save(legacy, old.hash);
    expect(v2).toMatchObject({ version: 2, parent: old.hash });
    expect(a.d.designer.revision(old.hash)!.system).toEqual(legacy);
    a.d.designer.saveDraft('brief', { title: 'Only in project A' });
    a.d.designer.studio.createJob({ ...BRIEF, agentId: 'codex', screens: BRIEF.screens.slice(0, 1) }, HUMAN);
    expect(Object.keys(a.d.state.designStudio!.jobs)).toHaveLength(1);
    expect(b.d.state.designStudio).toBeUndefined();
    expect(b.d.designer.draft('brief')).toBeNull();
    expect(b.d.state.design).toBeNull();
    const dataDir = a.dataDir;
    await stop(a);
    const again = await start(cfgA, { probe: false, server: false, dataDir });
    expect(again.d.designer.draft('brief')?.value).toEqual({ title: 'Only in project A' });
    expect(Object.keys(again.d.state.designStudio!.jobs)).toHaveLength(1);
  }, 60_000);

  it('pins the new original skills and selects built-ins by task label', async () => {
    const h = await start(makeConfig(makeRepo()), { probe: false, server: false });
    const s = h.d.designer;
    for (const id of ['product-ui-patterns', 'typography-content', 'design-system-implementation', 'visual-critique']) {
      const r = s.readSkill(id);
      expect(r.skill).toMatchObject({ license: 'Apache-2.0', source: 'One Connect' });
      expect(r.content).toMatch(/^---\nname: /);
    }
    expect(s.defaultSkillIds({ labels: ['design'] })).toHaveLength(s.skills().length);
    expect(s.defaultSkillIds({ labels: ['design-implementation', 'frontend'] })).toEqual([...SKILL_SETS.implementation]);
    expect(s.defaultSkillIds({ labels: ['design-review'] })).toEqual([...SKILL_SETS.review]);
    expect(s.defaultSkillIds({ labels: ['backend'] })).toEqual([]);
  });
});
