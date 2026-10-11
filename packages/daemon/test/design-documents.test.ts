// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN, REVIEW_CHECKLIST, agentActor, mockGate, newDesignNode, type DesignOperation } from '@acc/core';
import { applyWorkflowOptions } from '../src/workflowOptions.ts';
import { makeConfig, makeRepo, startDaemon, tmpDir, ROOT, type Harness } from './helpers.ts';

let h: Harness | null = null;
let library = '';
beforeEach(() => { library = tmpDir('design-library'); process.env.ACC_DESIGN_LIBRARY_DIR = library; });
afterEach(async () => { await h?.close(); h = null; delete process.env.ACC_DESIGN_LIBRARY_DIR; });
async function setup() { const cfg = makeConfig(makeRepo()); h = await startDaemon(cfg, { probe: false, server: false }); return { d: h.d, cfg }; }
const pass = REVIEW_CHECKLIST.map(c => ({ id: c.id, result: 'pass', basis: 'human', evidenceIds: [] }));

/** Publish foundations, release, and approve as an independent human (the draft is marked agent-authored). */
async function approvedRelease(d: Harness['d']) {
  const s = d.designer.documents;
  let r = s.create({ name: 'Studio', starter: 'dashboard' });
  const id = r.document.id;
  r = s.saveFoundations(id, r.document.version, null);
  const stored = s.get(id); stored.authors = [agentActor('codex')]; d.store.kvSet(`designer:document:${id}`, JSON.stringify(stored));
  const rel = s.publish(id, r.document.version, 'codex');
  const art = d.mocks.get(rel.artifactId), rev = d.mocks.rev(art, rel.rev);
  const warnings = rev.findings.filter(f => f.severity !== 'info').map(f => f.id);
  if (warnings.length) d.mocks.addException(art.id, rel.rev, warnings, 'Reviewed in Designer; accepted for this release.');
  d.mocks.review(art.id, rel.rev, 'approved', 'Looks right at every width.', HUMAN, { checklist: pass });
  return { id, ...rel };
}

describe('structured design persistence', () => {
  it('stores small history patches, survives restart, and refuses stale edits without losing them', async () => {
    const { d, cfg } = await setup();
    const s = d.designer.documents;
    const r = s.create({ name: 'Studio' });
    const id = r.document.id;
    const ack = s.edit(id, 1, [{ type: 'rename', name: 'My studio' }], HUMAN, 'Rename');
    expect(ack.version).toBe(2);
    expect(ack.patch).toEqual({ name: 'My studio' });
    expect(ack.undo).toEqual({ count: 1, label: 'Rename' });
    // A second tab still on version 1: refused, and the client can keep its change as a conflict.
    expect(() => s.edit(id, 1, [{ type: 'rename', name: 'Lost edit' }])).toThrow(/another tab/);
    const conflict = s.recordConflict(id, 1, [{ type: 'rename', name: 'Lost edit' }], 'Rename');
    expect(conflict.kind).toBe('conflict');
    expect(s.get(id).proposals.find(p => p.id === conflict.id)?.status).toBe('pending');
    // History holds patches, not snapshots.
    const entry = d.store.kvKeys(`designer:document:${id}:h:`).map(k => d.store.kvGet(k)!);
    expect(entry).toHaveLength(1);
    expect(entry[0].length).toBeLessThan(800);
    const dataDir = h!.dataDir;
    await h!.close();
    h = await startDaemon(cfg, { dataDir, probe: false, server: false });
    const restored = h.d.designer.documents;
    expect(restored.get(id).document.name).toBe('My studio');
    expect(restored.history(id, 2, 'undo').patch).toEqual({ name: 'Studio' });
    expect(restored.get(id).document.name).toBe('Studio');
    expect(restored.history(id, 3, 'redo').version).toBe(4);
    expect(restored.get(id).document.name).toBe('My studio');
    expect(restored.view(id).proposals.some(p => p.kind === 'conflict')).toBe(true);
  });

  it('keeps a 5,000-layer document editable with bounded records', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    const r = s.create({ name: 'Large' });
    const id = r.document.id;
    const ops: DesignOperation[] = [];
    for (let i = 0; i < 49; i++) {
      const root = newDesignNode(`big-root-${i}`, 'frame');
      const nodes = Array.from({ length: 99 }, (_, n) => ({ ...newDesignNode(`big-${i}-${n}`, 'text'), props: { text: `Row ${n}` } }));
      root.children = nodes.map(n => n.id);
      ops.push({ type: 'add-screen', screen: { id: `big-screen-${i}`, name: `Screen ${i}`, root: root.id, states: ['success'] }, root, nodes });
    }
    s.edit(id, 1, ops, HUMAN, 'Add screens');
    expect(Object.keys(s.get(id).document.nodes).length).toBeGreaterThan(4900);
    const t = performance.now();
    const ack = s.edit(id, 2, [{ type: 'update-node', id: 'big-3-5', patch: { props: { text: 'Edited' } } }]);
    expect(performance.now() - t).toBeLessThan(400);
    expect(Object.keys(ack.patch.nodes ?? {})).toEqual(['big-3-5']);
    for (let i = 0; i < 30; i++) s.edit(id, 3 + i, [{ type: 'update-node', id: 'big-3-5', patch: { props: { text: `Edit ${i}` } } }]);
    expect(d.store.kvGet(`designer:document:${id}`)!.length).toBeLessThan(3 * 1024 * 1024);
  });

  it('applies an agent proposal as one undoable step and makes stale proposals opt-in', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    const r = s.create({ name: 'Studio' });
    const id = r.document.id;
    const heading = Object.values(r.document.nodes).find(n => n.kind === 'text' && n.props.level === 1)!;
    const p = s.propose(id, 1, 'Sharper headline', [{ type: 'update-node', id: heading.id, patch: { props: { text: 'Everything at a glance' } } }, { type: 'rename', name: 'Studio 2' }], agentActor('codex'));
    expect(p.screens).toEqual(['overview']);
    expect(p.changes.join(' ')).toMatch(/1 layer changed/);
    s.edit(id, 1, [{ type: 'set-direction', value: 'Calm' }]);
    expect(() => s.decide(id, p.id, 'apply')).toThrow(/made on version 1/);
    const applied = s.decide(id, p.id, 'apply', { rebase: true });
    expect(applied.document.nodes[heading.id].props.text).toBe('Everything at a glance');
    expect(applied.history.undo).toHaveLength(2);
    s.history(id, applied.document.version, 'undo');
    expect(s.get(id).document.name).toBe('Studio');
    expect(s.get(id).document.direction).toBe('Calm');
  });

  it('validates image bytes and contains asset lookups', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    expect(() => s.upload('bad.svg', Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'))).toThrow(/PNG/);
    expect(() => s.upload('page.html', Buffer.from('<html><script>alert(1)</script>').toString('base64'))).toThrow(/PNG/);
    expect(() => s.asset('../secret')).toThrow(/Unknown/);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex');
    const a = s.upload('dot.png', png.toString('base64'), true);
    expect(a.mime).toBe('image/png');
    fs.writeFileSync(path.join(h!.dataDir, 'designer-assets', a.hash), Buffer.from('tampered'));
    expect(() => s.asset(a.hash)).toThrow(/integrity/);
  });
});

describe('releases, approval and workflow integrity', () => {
  it('freezes the document, system, runtime and source package, and detects tampering', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    let r = s.create({ name: 'Studio' });
    const id = r.document.id;
    expect(s.releaseBlockers(id).join(' ')).toMatch(/Publish this design/);
    r = s.saveFoundations(id, 1, null);
    expect(d.state.design?.system).toMatchObject({ schema: 3 });
    expect(s.releaseBlockers(id)).toEqual([]);
    const rel = s.publish(id, r.document.version, 'codex');
    const frozen = s.release(rel.artifactId, rel.rev);
    expect(frozen.manifest.files.map(f => f.path)).toEqual(expect.arrayContaining(['README.md', 'src/runtime/DocumentRenderer.tsx', 'src/types.ts', 'src/tokens.css', 'src/design.json']));
    expect(frozen.manifest.files.some(f => f.path.startsWith('src/components/'))).toBe(true);
    expect(s.releaseFile(rel.artifactId, rel.rev, 'README.md').data.toString()).toMatch(/\*\*Release:\*\*/);
    // Republishing an identical draft reuses the release.
    expect(s.publish(id, r.document.version, 'codex')).toMatchObject({ unchanged: true, rev: rel.rev });
    // Draft edits never change the frozen release.
    s.edit(id, r.document.version, [{ type: 'rename', name: 'Changed draft' }]);
    expect(s.release(rel.artifactId, rel.rev).document.name).toBe('Studio');
    // Approval is independent: the human author alone cannot approve.
    const open = d.mocks.rev(d.mocks.get(rel.artifactId), rel.rev).findings.map(f => f.id);
    if (open.length) d.mocks.addException(rel.artifactId, rel.rev, open, 'Accepted for this test release.');
    d.mocks.review(rel.artifactId, rel.rev, 'approved', 'Reviewed', HUMAN, { checklist: pass });
    expect(mockGate(d.mocks.rev(d.mocks.get(rel.artifactId), rel.rev), d.state.design!.hash).state).toBe('needs_independent_review');
    expect(() => s.handoff(rel.artifactId, rel.rev, { agentId: 'codex', reviewAgentId: 'claude' })).toThrow(/Approve/);
    // Tampering with any release file is detected.
    const file = frozen.manifest.files.find(f => f.path === 'src/design.json')!;
    fs.writeFileSync(path.join(h!.dataDir, 'designer-releases', file.hash), '{}');
    expect(() => s.release(rel.artifactId, rel.rev)).toThrow(/integrity/);
  });

  it('prepares workflows without starting them and re-checks the exact approval at dispatch', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    const rel = await approvedRelease(d);
    const art = d.mocks.get(rel.artifactId);
    expect(mockGate(d.mocks.rev(art, rel.rev), d.state.design!.hash).state).toBe('approved');
    const w = s.handoff(rel.artifactId, rel.rev, { agentId: 'codex', reviewAgentId: 'claude' });
    expect(w.status).toBe('draft');
    expect(w.definition.tasks.map(t => [t.id, t.design])).toEqual([['build', { artifactId: rel.artifactId, rev: rel.rev }], ['review', { artifactId: rel.artifactId, rev: rel.rev }]]);
    expect(w.definition.tasks[0].skills).toContain('react-design-export');
    expect(s.workflowUses(rel.artifactId)).toHaveLength(2);
    // Binding an assignment freezes the full release identity.
    const task = w.definition.tasks[0];
    const a = d.createAssignment({ workItemId: task.workItemId, agentId: 'codex', allowedPaths: [] });
    const bound = applyWorkflowOptions(d, a, task);
    expect(bound.mockBinding).toMatchObject({ artifactId: rel.artifactId, rev: rel.rev, releaseHash: d.mocks.rev(art, rel.rev).document!.releaseHash });
    expect(d.preflight(bound.id).checks.find(c => c.id === 'design_binding')).toMatchObject({ status: 'pass' });
    // A later change request makes the approval stale: dispatch is refused.
    d.mocks.review(rel.artifactId, rel.rev, 'changes_requested', 'Wait, the header is wrong.');
    expect(d.preflight(bound.id).checks.find(c => c.id === 'design_binding')).toMatchObject({ status: 'fail' });
    expect(d.preflight(bound.id).ok).toBe(false);
  });

  it('refuses dispatch when the contract changes, the release is altered or the artifact is from elsewhere', async () => {
    const { d } = await setup();
    const rel = await approvedRelease(d);
    const art = d.mocks.get(rel.artifactId), rev = d.mocks.rev(art, rel.rev);
    const item = d.createIssue({ title: 'Build it' });
    const a = d.createAssignment({ workItemId: item.id, agentId: 'codex' });
    const bound = applyWorkflowOptions(d, a, { id: 'build', title: 'Build', workItemId: item.id, agentId: 'codex', kind: 'code', dependsOn: [], reviewOf: null, allowedPaths: [], requiredChecks: null, design: { artifactId: art.id, rev: rev.rev } });
    const check = () => d.designer.documents.bindingCheck(d.state.assignments[bound.id])!;
    expect(check().status).toBe('pass');
    // Wrong project or missing artifact.
    expect(d.designer.documents.bindingCheck({ ...bound, mockBinding: { ...bound.mockBinding!, artifactId: 'mock_elsewhere' } })!.message).toMatch(/not in this project/);
    // A changed contract.
    const system = d.state.design!;
    d.designer.save({ ...(system.system as object), name: 'Changed system' }, system.hash, 'changed');
    expect(check()).toMatchObject({ status: 'fail', message: expect.stringMatching(/design system changed/) });
  });

  it('exports a portable React package that typechecks in a clean project', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    const r = s.create({ name: 'Studio', starter: 'settings' });
    const pkg = s.exportDraft(r.document.id);
    expect(pkg.status).toBe('draft');
    expect(pkg.files['README.md']).toMatch(/Draft export for exploration/);
    expect(Object.keys(pkg.files).some(p => p.startsWith('src/components/Sidebar'))).toBe(true);
    expect(pkg.files['src/runtime/DocumentRenderer.tsx']).toContain("from '../types'");
    expect(pkg.files['src/runtime/DocumentRenderer.tsx']).not.toMatch(/@acc\//);
    const dir = tmpDir('design-export');
    for (const [name, content] of Object.entries(pkg.files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), content); }
    fs.symlinkSync(path.join(ROOT, 'packages/web/node_modules'), path.join(dir, 'node_modules'), 'dir');
    expect(() => execFileSync(path.join(ROOT, 'node_modules/.bin/tsc'), ['-p', dir], { encoding: 'utf8' })).not.toThrow();
  }, 60_000);
});

describe('foundations, kits and agent access', () => {
  it('requires replacements before removing tokens other designs use, and applies them on rebase', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    const a = s.create({ name: 'System source' }), b = s.create({ name: 'Other design' });
    const pub = s.saveFoundations(a.document.id, 1, null);
    s.rebase(b.document.id, 1);
    // Remove a role the other design uses.
    s.edit(a.document.id, pub.document.version, [{ type: 'replace-token', from: 'text-muted', to: 'text', remove: true }]);
    const next = s.get(a.document.id).document;
    const impact = s.systemImpact(a.document.id);
    expect(impact.removed).toContain('text-muted');
    expect(impact.affected.find(x => x.tokenId === 'text-muted')!.designs.map(x => x.name)).toEqual(['Other design']);
    expect(() => s.saveFoundations(a.document.id, next.version, d.state.design!.hash)).toThrow(/Choose replacements for text-muted/);
    s.saveFoundations(a.document.id, next.version, d.state.design!.hash, { 'text-muted': 'text' });
    const other = s.get(b.document.id).document;
    s.rebase(b.document.id, other.version);
    const rebased = s.get(b.document.id).document;
    expect(rebased.tokens['text-muted']).toBeUndefined();
    expect(Object.values(rebased.nodes).some(n => n.props.color === 'text-muted')).toBe(false);
    expect(s.releaseBlockers(b.document.id)).toEqual([]);
  });

  it('saves kits to the local library and turns later kit versions into reviewable proposals', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    const source = s.create({ name: 'Brand kit', starter: 'dashboard' });
    const kit = s.saveKit(source.document.id, { name: 'Northwind kit' });
    expect(fs.existsSync(path.join(library, kit.id, 'v1.json'))).toBe(true);
    const copy = s.importKit(kit.id);
    expect(Object.keys(copy.document.components)).toEqual(Object.keys(source.document.components));
    expect(copy.document.libraries).toEqual([{ kitId: kit.id, version: 1, name: 'Northwind kit' }]);
    expect(s.kitUpdates(copy.document.id)).toEqual([]);
    // Change the shared metric card in the source and publish v2 of the kit.
    const latest = s.get(source.document.id).document;
    s.edit(source.document.id, latest.version, [{ type: 'update-node', id: 'c-metric-value', patch: { props: { fontSize: 'text-4xl' } } }]);
    s.saveKit(source.document.id);
    const updates = s.kitUpdates(copy.document.id);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ from: 1, to: 2 });
    expect(s.get(copy.document.id).document.nodes['c-metric-value'].props.fontSize).toBe('text-3xl');
    const p = s.proposeKit(copy.document.id, kit.id);
    expect(p.kind).toBe('library');
    s.decide(copy.document.id, p.id, 'apply');
    const updated = s.get(copy.document.id).document;
    expect(updated.nodes['c-metric-value'].props.fontSize).toBe('text-4xl');
    expect(updated.libraries[0].version).toBe(2);
    expect(s.kitUpdates(copy.document.id)).toEqual([]);
  });

  it('limits agents to their own requests and keeps reviewers read-only', async () => {
    const { d } = await setup();
    const s = d.designer.documents;
    const r = s.create({ name: 'Studio' });
    const id = r.document.id;
    const job = s.aiJob(id, { agentId: 'codex', request: 'Make the overview work better on mobile', selection: [] });
    expect(job.assignment.position).toBe('draft');
    expect(job.skills.map(x => x.id)).toEqual(expect.arrayContaining(['structured-design', 'responsive-layouts']));
    expect(job.assignment.skills?.map(x => x.id)).toEqual(expect.arrayContaining(['structured-design', 'responsive-layouts']));
    expect(job.assignment.allowedPaths).toEqual([]);
    const summary = JSON.parse(String(s.agentRead(id, job.assignment.id).content));
    expect(summary.screens.map((x: { id: string }) => x.id)).toEqual(['overview', 'projects', 'project', 'new-project']);
    expect(() => s.agentRead(id, 'as_unrelated')).toThrow(/access/);
    const p = s.agentPropose(id, job.assignment.id, 'run_x', 'codex', 1, 'Stack metrics on phones', [{ type: 'update-node', id: Object.values(r.document.nodes).find(n => n.name === 'Highlights')!.id, patch: { responsive: { phone: { columns: 1, gap: 12 } } } }]);
    expect(p.status).toBe('pending');
    expect(s.get(id).document.version).toBe(1);
    expect(() => s.agentPropose(id, 'as_unrelated', 'run_x', 'codex', 1, 'x', [{ type: 'rename', name: 'x' }])).toThrow(/access/);
    expect(() => s.aiJob(id, { agentId: 'ag', request: 'x' })).toThrow(/design agent/);
  });
});

