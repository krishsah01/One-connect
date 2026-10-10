// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Brief & Reports, Timeline, morning report and standup are derived only from recorded events:
// every claim links to events and SHAs, filters work, and gaps stay visible.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });
const SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';
const MERGE = 'abcdef0123456789abcdef0123456789abcdef01';

async function seeded() {
  h = await startDaemon(makeConfig(makeRepo()), { probe: false });
  const d = h.d;
  const item = d.createIssue({ title: 'Add login', acceptance: ['works'] });
  const other = d.createIssue({ title: 'Other work', acceptance: ['x'] });
  const ref = { agentId: 'claude', runId: 'run_1', workItemId: item.id };
  d.commit([
    { type: 'run.ended', ...ref, data: { exit: { kind: 'completed', message: 'done' } } },
    { type: 'run.handoff', ...ref, data: { handoff: { done: 'Implemented the login form', evidence: [{ command: 'node --test', result: '12 passed', verified: false }], commit: { sha: SHA, branch: 'claude/LOC-1', verified: true }, blocked: null, next: 'Review it', source: 'mcp', raw: '' } } },
    { type: 'work_item.evidence_added', workItemId: item.id, data: { evidence: { id: 'e1', kind: 'test', summary: 'node --test', command: 'node --test', exitCode: 0, counts: { passed: 12, failed: 0, skipped: 0 }, sha: SHA, verified: true, at: '' } } },
    { type: 'work_item.evidence_added', workItemId: item.id, data: { evidence: { id: 'e2', kind: 'command', summary: 'lint', command: 'npm run lint', exitCode: 0, verified: false, at: '' } } },
    { type: 'merge.completed', workItemId: item.id, data: { merge: { id: 'm1', workItemId: item.id, decisionId: 'd', reviewId: 'r', sourceBranch: 'claude/LOC-1', sourceSha: SHA, target: 'integration', targetShaBefore: 't'.repeat(40), mergeSha: MERGE, method: 'ref', at: '', postChecks: { status: 'pending', evidenceIds: [], at: null } } } },
    { type: 'merge.post_checks', workItemId: item.id, data: { mergeId: 'm1', status: 'failed', evidenceIds: [] } },
    { type: 'run.ended', agentId: 'codex', runId: 'run_2', workItemId: other.id, data: { exit: { kind: 'crash', message: 'segfault' } } },
    { type: 'release.saved' as never, data: { plan: { id: 'p1', name: 'v1', status: 'active', sha: MERGE, steps: [{ status: 'passed' }, { status: 'failed' }, { status: 'todo' }] } } as never },
    { type: 'infra.checked' as never, data: { health: { docker: { state: 'ready', detail: '' }, postgres: { state: 'unhealthy', service: 'db', detail: '' } } } as never },
  ]);
  return { d, item, other };
}

describe('Brief, Timeline, morning report and standup', () => {
  it('links every claim to the events and SHAs that back it, and separates agent claims from recorded facts', async () => {
    const { d, item } = await seeded();
    const r = d.reports.morning({});
    const seqs = new Set(r.evidenceIndex.map((e) => e.seq));
    for (const s of r.sections) for (const c of s.claims) if (c.basis !== 'derived' || c.evidence.length) for (const e of c.evidence) expect(seqs.has(e.seq)).toBe(true);
    const all = r.sections.flatMap((s) => s.claims);
    const handoff = all.find((c) => c.text.startsWith('Handoff from'))!;
    expect(handoff.basis).toBe('agent_reported');
    expect(handoff.evidence[0].sha).toBe(SHA);
    expect(all.find((c) => c.text.includes('finished') && c.basis === 'recorded')!.evidence[0].type).toBe('run.ended');
    const merged = r.sections.find((s) => s.id === 'merged')!.claims[0];
    expect(merged.text).toContain(MERGE.slice(0, 10));
    expect(merged.text).toContain('Nothing was pushed');
    expect(merged.text).toContain('Post-merge checks: failed');
    const checks = r.sections.find((s) => s.id === 'checks')!.claims;
    expect(checks.find((c) => c.text.includes('node --test'))!.verified).toBe(true);
    expect(checks.find((c) => c.text.includes('npm run lint'))!.verified).toBe(false);
    expect(checks.find((c) => c.text.includes('npm run lint'))!.text).toMatch(/not verified/);
    expect(r.sections.find((s) => s.id === 'trouble')!.claims.some((c) => c.text.includes('segfault'))).toBe(true);
    // Release and infrastructure events are consumed by shape: a failed step and an unhealthy component are not hidden.
    const rel = r.sections.find((s) => s.id === 'release')!.claims.map((c) => c.text).join('\n');
    expect(rel).toMatch(/Release plan “v1”.*1 failed/);
    expect(rel).toMatch(/postgres unhealthy/);
    expect(rel).not.toMatch(/healthy release/);
    const md = d.reports.standup({}).markdown;
    expect(md).toContain(`[#`);
    expect(md).toContain(MERGE.slice(0, 10));
    expect(md).toMatch(/agent-reported, unverified/);
    expect(md).toContain('## Evidence index');
    void item;
  });

  it('filters by issue, agent and date, and builds handoff cards, Now/Next and pending decisions', async () => {
    const { d, item, other } = await seeded();
    const q = d.createIssue({ title: 'Needs a call', acceptance: ['y'] });
    d.decisions.create({ question: 'Ship it?', options: ['yes', 'no'], workItemId: q.id, urgency: 'high' });
    const tl = d.reports.timeline({ issue: item.id });
    expect(tl.entries.length).toBeGreaterThan(3);
    expect(tl.entries.every((e) => e.workItemId === item.id)).toBe(true);
    expect(d.reports.timeline({ agent: 'codex' }).entries.every((e) => e.agentId === 'codex')).toBe(true);
    expect(d.reports.timeline({ to: '2000-01-01' }).entries).toEqual([]);
    expect(d.reports.timeline({ from: '2000-01-01' }).entries.length).toBeGreaterThan(5);
    expect(() => d.reports.filter({ from: 'yesterday-ish' })).toThrow(/ISO/);
    const brief = d.reports.brief({});
    expect(brief.handoffs).toHaveLength(1);
    expect(brief.handoffs[0]).toMatchObject({ done: 'Implemented the login form', commit: { sha: SHA, verified: true }, next: 'Review it' });
    expect(brief.pending.some((p) => p.kind === 'decision' && p.title === 'Ship it?')).toBe(true);
    expect(brief.merges[0].mergeSha).toBe(MERGE);
    expect(brief.releases.length).toBe(2);
    expect(d.reports.brief({ issue: other.id }).handoffs).toEqual([]);
    expect(Array.isArray(brief.now)).toBe(true);
  });

  it('never invents green: an empty project reports gaps, not success', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const r = h.d.reports.morning({});
    expect(r.sections.every((s) => s.claims.length === 0 || s.id === 'needs')).toBe(true);
    expect(r.sections.find((s) => s.id === 'checks')!.empty).toMatch(/Nothing here implies that tests passed/);
    expect(r.sections.find((s) => s.id === 'release')!.empty).toMatch(/no claim about release health/);
    expect(r.caveats.join(' ')).toMatch(/do not read this report as “tests passed”/);
    const brief = h.d.reports.brief({});
    expect(brief.notes.join(' ')).toMatch(/No check results/);
    expect(brief.notes.join(' ')).toMatch(/Absence is not evidence of a healthy release/);
    expect(h.d.reports.standup({}).markdown).not.toMatch(/\d+ passed|all checks|green|is healthy/i);
  });

  it('serves the reports over the authenticated API, including the Markdown export', async () => {
    const { d } = await seeded();
    const token = fs.readFileSync(path.join(d.paths.secrets, 'install-token'), 'utf8').trim();
    const get = (p: string) => fetch(h!.url + p, { headers: { authorization: `Bearer ${token}` } });
    expect((await get('/api/reports/brief')).status).toBe(200);
    expect((await get('/api/reports/timeline?limit=3')).status).toBe(200);
    const md = await get('/api/reports/standup?format=md');
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(await md.text()).toContain('# Standup');
    expect((await fetch(h!.url + '/api/reports/brief')).status).toBe(401);
    expect((await get('/api/reports/timeline?from=nonsense')).status).toBe(400);
  });
});
