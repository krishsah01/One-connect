// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  agentActor, artifactStatus, blockingFailures, briefPages, compareRevisions, DARK_PALETTE, DEFAULT_DESIGN, designAgentEligibility, DesignBriefSchema, designChecks,
  designCss, designDiff, designJobPrompt, designMarkdown, designPalette, designSpecimenHtml, designTokens, designTokensJson, DesignSystemSchema, emptyState, HUMAN,
  isLegacyDesign, jobStatus, lineDiff, mockGate, mockPreviewShell, mockStaticDocument, normalizeDesign, REVIEW_CHECKLIST, upgradeDesignInput,
  type AgentState, type DesignJob, type DesignRevision, type LegacyDesignSystem, type MockArtifact, type MockRevision, type Run,
} from '../src/index.ts';

const legacy: LegacyDesignSystem = { name: 'Old', direction: 'd', colors: { background: '#f3f6f7', surface: '#ffffff', text: '#18343b', muted: '#526870', accent: '#087e8b', accentText: '#ffffff', border: '#c9d6da' }, typography: 'system', spacing: 'compact', radius: 6, motion: 'subtle', rules: 'r' };
const rev = (system = DEFAULT_DESIGN, version = 1, hash = 'a'.repeat(64)): DesignRevision => ({ version, hash, system, createdAt: '2026-10-07T00:00:00.000Z' });

describe('design contract v2', () => {
  it('defaults pass every blocking pair in both modes and generate one consistent token set', () => {
    expect(blockingFailures(DEFAULT_DESIGN)).toEqual([]);
    const checks = designChecks(DEFAULT_DESIGN);
    expect(checks.filter(c => c.mode === 'dark').length).toBeGreaterThan(10);
    expect(checks.find(c => c.name.startsWith('Divider'))?.blocking).toBe(false);
    const css = designCss(DEFAULT_DESIGN);
    for (const t of designTokens(DEFAULT_DESIGN)) expect(css).toContain(`${t.css}: ${t.value};`);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('prefers-reduced-motion');
    const json = designTokensJson(rev()) as Record<string, Record<string, { $value: string }>>;
    expect(json['color-light'].accent.$value).toBe(DEFAULT_DESIGN.colors.accent);
    expect(json['color-dark'].accent.$value).toBe(DARK_PALETTE.accent);
    expect((json.$extensions as unknown as Record<string, { contract: { hash: string } }>)['one-connect'].contract.hash).toBe('a'.repeat(64));
    const md = designMarkdown(rev());
    expect(md).toContain('Design contract v1 · SHA-256 ' + 'a'.repeat(64));
    for (const section of ['## Color roles', '## Typography', '## Spacing and density', '## Shape, borders and elevation', '## Layout', '## Motion', '## Accessibility and interaction rules', '## Component recipes', '## Measured contrast', '## Engineering handoff']) expect(md).toContain(section);
    expect(md).toContain('does not prove accessibility');
    const spec = designSpecimenHtml(rev());
    expect(spec).not.toMatch(/<script|https?:\/\//);
    expect(spec).toContain(css.trim().split('\n')[1]);
  });

  it('light-only systems emit one palette; failing dark colors block saving only when dark is active', () => {
    const lightOnly = DesignSystemSchema.parse({ ...DEFAULT_DESIGN, appearance: 'light', dark: { ...DARK_PALETTE, text: '#151d20' } });
    expect(designCss(lightOnly)).not.toContain('prefers-color-scheme: dark');
    expect(blockingFailures(lightOnly)).toEqual([]);
    const both = DesignSystemSchema.parse({ ...lightOnly, appearance: 'system' });
    expect(blockingFailures(both).map(c => c.name)).toContain('Body on surface (dark)');
    expect(designPalette(lightOnly)).not.toContain('#151d20');
  });

  it('keeps schema 1 revisions byte-stable and upgrades only when a human saves', () => {
    expect(isLegacyDesign(legacy)).toBe(true);
    expect(designCss(legacy)).toBe(':root {\n  --design-background: #f3f6f7;\n  --design-surface: #ffffff;\n  --design-text: #18343b;\n  --design-muted: #526870;\n  --design-accent: #087e8b;\n  --design-accent-text: #ffffff;\n  --design-border: #c9d6da;\n  --design-radius: 6px;\n  --design-space: 4px;\n  --design-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\n}\n');
    expect(designChecks(legacy)).toHaveLength(4);
    expect(designMarkdown(rev(legacy as never))).toContain('## Tokens');
    expect(designPalette(legacy)).toHaveLength(7);
    const up = DesignSystemSchema.parse(upgradeDesignInput(legacy));
    expect(up).toMatchObject({ schema: 2, appearance: 'light', density: 'compact', radius: 6, colors: { accent: '#087e8b' } });
    expect(normalizeDesign(legacy).typography.pairing).toBe('system');
    // Diffs view a legacy revision through the same upgrade a save would apply.
    expect(designDiff(legacy, up)).toEqual([]);
  });

  it('describes changes field by field', () => {
    const next = DesignSystemSchema.parse({ ...DEFAULT_DESIGN, radius: 12, colors: { ...DEFAULT_DESIGN.colors, accent: '#0A6F7A' } });
    expect(next.colors.accent).toBe('#0a6f7a');
    expect(designDiff(DEFAULT_DESIGN, next)).toEqual([
      { field: 'radius', label: 'Corner radius', before: '8px', after: '12px' },
      { field: 'colors.accent', label: 'Accent (light)', before: '#087e8b', after: '#0a6f7a' },
    ]);
    expect(designDiff(null, DEFAULT_DESIGN).every(c => c.before === null)).toBe(true);
  });
});

const revision = (o: Partial<MockRevision> = {}): MockRevision => ({ rev: 1, hash: 'h1', entry: 'index.html', files: [{ path: 'index.html', sha256: 's1', bytes: 1, kind: 'html' }], designRevision: { hash: 'c1', version: 1 }, gitSha: null, runId: null, findings: [], exceptions: [], reviews: [], evidence: [], capturedAt: '2026-10-07T00:00:01.000Z', by: agentActor('codex'), ...o });
const pass = REVIEW_CHECKLIST.map(c => ({ id: c.id, result: 'pass' as const, basis: 'human' as const, evidenceIds: [] }));

describe('mock gate', () => {
  it('approves an agent-authored revision on an independent human review, and invalidates it on drift', () => {
    const r = revision({ reviews: [{ decision: 'approved', note: '', by: HUMAN, at: 'x', checklist: pass }] });
    expect(mockGate(r, 'c1').state).toBe('approved');
    const drifted = mockGate(r, 'c2');
    expect(drifted.state).toBe('needs_review');
    expect(drifted.approval).toMatchObject({ valid: false });
    expect(drifted.approval?.reason).toMatch(/contract changed/);
  });

  it('never lets the author be the only approver', () => {
    const own = revision({ authoredBy: HUMAN, by: HUMAN, reviews: [{ decision: 'approved', note: '', by: HUMAN, at: 'x' }] });
    expect(mockGate(own, 'c1').state).toBe('needs_independent_review');
    const agentOnly = revision({ authoredBy: HUMAN, reviews: [{ decision: 'approved', note: '', by: agentActor('claude'), at: 'x' }] });
    expect(mockGate(agentOnly, 'c1').state).toBe('clear');
    const both = revision({ authoredBy: HUMAN, reviews: [{ decision: 'approved', note: '', by: HUMAN, at: 'x' }, { decision: 'approved', note: '', by: agentActor('claude'), at: 'y' }] });
    expect(mockGate(both, 'c1').state).toBe('approved');
    const thenChanges = revision({ reviews: [{ decision: 'approved', note: '', by: HUMAN, at: 'x' }, { decision: 'changes_requested', note: '', by: agentActor('claude'), at: 'y' }] });
    expect(mockGate(thenChanges, 'c1').state).toBe('changes_requested');
  });

  it('reports the approved revision separately from the latest one', () => {
    const art: MockArtifact = { id: 'm', workItemId: 'w', assignmentId: 'a', agentId: 'codex', dir: 'design/x', title: 't', createdAt: 'x', updatedAt: 'x', revisions: [revision({ reviews: [{ decision: 'approved', note: '', by: HUMAN, at: 'x' }] }), revision({ rev: 2, hash: 'h2' })] };
    expect(artifactStatus(art, 'c1')).toMatchObject({ latestRev: 2, approvedRev: 1, approvedIsLatest: false, staleApproval: null, oldContract: false });
    expect(artifactStatus(art, 'c9')).toMatchObject({ approvedRev: null, staleApproval: { rev: 1 }, oldContract: true });
  });

  it('compares revisions and produces bounded line diffs', () => {
    const a = revision({ files: [{ path: 'index.html', sha256: 'x', bytes: 1, kind: 'html' }, { path: 'old.css', sha256: 'o', bytes: 1, kind: 'css' }] });
    const b = revision({ rev: 2, files: [{ path: 'index.html', sha256: 'y', bytes: 1, kind: 'html' }, { path: 'new.js', sha256: 'n', bytes: 1, kind: 'js' }], designRevision: { hash: 'c2', version: 2 } });
    expect(compareRevisions(a, b)).toMatchObject({ added: ['new.js'], removed: ['old.css'], changed: ['index.html'], unchanged: [], contract: { changed: true } });
    const d = lineDiff(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n'), ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i'].join('\n'), { context: 1 })!;
    expect(d).toEqual([{ op: '…', count: 3 }, { op: '=', text: 'd' }, { op: '-', text: 'e' }, { op: '+', text: 'E' }, { op: '=', text: 'f' }, { op: '…', count: 3 }]);
    expect(lineDiff('x\n'.repeat(2000), 'y')).toBeNull();
  });

  it('renders browser previews without scripts, handlers or live links, and routes only known pages natively', () => {
    const doc = mockStaticDocument('<!doctype html><script>alert(1)</script><a href="page2.html" target="_blank" onclick="x()">Next</a><button onmouseover="y()">B</button><iframe src="https://evil.example"></iframe><p>Click on=here</p>');
    expect(doc).not.toMatch(/<script|onclick|onmouseover|<iframe|\shref=/);
    expect(doc).toContain('data-href="page2.html"');
    expect(doc).toContain('<p>Click on=here</p>');
    const shell = mockPreviewShell('<p>one</p>', { 'index.html': '<p>one</p>', 'two.html': '<p>two</p>' }, { page: 'index.html', label: '</script><script>alert(1)</script>' });
    expect(shell).toContain('sandbox="allow-scripts"');
    expect(shell).toContain("frame-src 'none'");
    expect(shell).not.toContain('</script><script>alert(1)');
    expect(shell).toContain('Object.hasOwn(pages,m.page)');
    expect(shell.match(/<iframe/g)).toHaveLength(1);
    expect(shell).toContain('<script>\n');
    // The mock frame gets the window's real width, including under mobile emulation.
    expect(shell).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
  });
});

const agent = (o: Partial<AgentState['config']> = {}, s: Partial<AgentState> = {}): AgentState => ({ id: 'a', config: { id: 'a', name: 'A', role: 'engineer', adapter: 'codex-cli', enabled: true, mode: 'normal', metered_opt_in: false, billing: 'subscription', ...o } as AgentState['config'], status: 'idle', auth: { state: 'logged_in' }, billing: { mode: 'subscription', source: 'login', overage: 'off' }, ...s } as AgentState);

describe('designer studio', () => {
  const brief = { title: 'Release checks', brief: 'Engineers need to see which checks failed and re-run them.', audience: 'Release engineers', screens: [{ name: 'Overview' }, { name: 'Checks' }, { name: 'Check detail' }, { name: 'Checks' }], agentId: 'a' };
  it('validates briefs and maps screens to unique page files', () => {
    expect(DesignBriefSchema.safeParse(brief).success).toBe(false);
    const ok = DesignBriefSchema.parse({ ...brief, screens: brief.screens.slice(0, 3) });
    expect(ok.states).toEqual(['empty', 'loading', 'error', 'success']);
    expect(briefPages(ok).map(p => p.path)).toEqual(['index.html', 'checks.html', 'check-detail.html']);
    expect(DesignBriefSchema.safeParse({ ...ok, mode: 'revise' }).success).toBe(false);
    expect(DesignBriefSchema.safeParse({ ...ok, existingPaths: ['../secrets'] }).success).toBe(false);
  });

  it('marks a job captured only when a revision exists, not when its run exits', () => {
    const job: DesignJob = { id: 'j', kind: 'generate', title: 't', brief: null, slug: 'x', dir: 'design/x', workItemId: 'w', assignmentId: 'as', artifactId: null, fromRev: null, identity: null, request: null, mode: 'new-assignment', runId: null, designRevision: null, createdAt: '2026-10-07T00:00:00.000Z', by: HUMAN };
    const s = emptyState();
    s.assignments.as = { id: 'as', position: 'draft' } as never;
    expect(jobStatus(job, s).phase).toBe('draft');
    const run = { id: 'r', assignmentId: 'as', createdAt: '2026-10-07T00:00:01.000Z', endedAt: '2026-10-07T00:00:05.000Z', state: 'finished', exit: { kind: 'completed', message: 'finished' } } as Run;
    s.runs.r = { ...run, state: 'running', exit: null };
    expect(jobStatus(job, s).phase).toBe('running');
    s.approvals.ap = { id: 'ap', runId: 'r', title: 'Which audience?', resolvedAt: null } as never;
    expect(jobStatus(job, s)).toMatchObject({ phase: 'waiting', detail: 'The agent asked: Which audience?' });
    delete s.approvals.ap;
    s.runs.r = run;
    expect(jobStatus(job, s).phase).toBe('no_capture');
    s.designStudio = { jobs: {}, captures: { c: { id: 'c', jobId: 'j', assignmentId: 'as', runId: 'r', dir: 'design/x', trigger: 'auto', ok: false, error: 'design/x does not exist in the assignment worktree', artifactId: null, rev: null, at: '2026-10-07T00:00:06.000Z', by: HUMAN } } };
    expect(jobStatus(job, s)).toMatchObject({ phase: 'capture_failed', detail: expect.stringMatching(/does not exist/) });
    s.mocks = { m: { id: 'm', workItemId: 'w', assignmentId: 'as', agentId: 'a', dir: 'design/x', title: 't', createdAt: 'x', updatedAt: 'x', revisions: [revision({ capturedAt: '2026-10-07T00:00:07.000Z' })] } };
    expect(jobStatus(job, s)).toMatchObject({ phase: 'captured', artifactId: 'm' });
    s.runs.r = { ...run, state: 'failed', exit: { kind: 'crash', message: 'boom' } };
    s.mocks = {}; s.designStudio = { jobs: {}, captures: {} };
    expect(jobStatus(job, s).phase).toBe('failed');
    s.runs.r = { ...run, state: 'orphaned', exit: { kind: 'orphaned', message: 'runner disappeared' } };
    expect(jobStatus(job, s).phase).toBe('interrupted');
  });

  it('scopes each job to its own window when a same-session refinement follows it', () => {
    const base = { kind: 'generate', title: 't', brief: null, slug: 'x', dir: 'design/x', workItemId: 'w', assignmentId: 'as', artifactId: null, fromRev: null, identity: null, request: null, mode: 'new-assignment', runId: null, designRevision: null, by: HUMAN } as const;
    const gen: DesignJob = { ...base, id: 'g', createdAt: '2026-10-07T00:00:00.000Z' };
    const ref: DesignJob = { ...base, id: 'r', kind: 'refine', mode: 'follow-up', artifactId: 'm', fromRev: 1, createdAt: '2026-10-07T00:10:00.000Z' };
    const s = emptyState();
    s.assignments.as = { id: 'as', position: 'done' } as never;
    s.runs.r1 = { id: 'r1', assignmentId: 'as', createdAt: '2026-10-07T00:00:01.000Z', state: 'finished', exit: { kind: 'completed', message: '' } } as Run;
    s.runs.r2 = { id: 'r2', assignmentId: 'as', createdAt: '2026-10-07T00:10:01.000Z', state: 'running', exit: null } as Run;
    s.mocks = { m: { id: 'm', workItemId: 'w', assignmentId: 'as', agentId: 'a', dir: 'design/x', title: 't', createdAt: 'x', updatedAt: 'x', revisions: [revision({ capturedAt: '2026-10-07T00:00:05.000Z', assignmentId: 'as' }), revision({ rev: 2, hash: 'h2', capturedAt: '2026-10-07T00:10:05.000Z', assignmentId: 'as' })] } };
    s.designStudio = { jobs: { g: gen, r: ref }, captures: {} };
    expect(jobStatus(gen, s)).toMatchObject({ phase: 'captured', revision: { rev: 1 }, run: { id: 'r1' } });
    expect(jobStatus(ref, s)).toMatchObject({ phase: 'running', run: { id: 'r2' } });
    s.runs.r2 = { ...s.runs.r2, state: 'finished', exit: { kind: 'completed', message: '' } };
    expect(jobStatus(ref, s)).toMatchObject({ phase: 'captured', revision: { rev: 2 } });
  });

  it('keeps paid generation off unless an agent is explicitly configured for it, and never uses relay', () => {
    expect(designAgentEligibility(agent())).toMatchObject({ ok: true, paid: false, label: 'included plan' });
    expect(designAgentEligibility(agent({ adapter: 'relay' })).ok).toBe(false);
    expect(designAgentEligibility(agent({}, { billing: { mode: 'metered', source: 'api key', overage: 'unknown' } } as never))).toMatchObject({ ok: false, paid: true });
    expect(designAgentEligibility(agent({ metered_opt_in: true, budget_usd_per_day: 3 } as never))).toMatchObject({ ok: true, paid: true, label: 'metered (approved)' });
    expect(designAgentEligibility(agent({ mode: 'coordinator-only' })).ok).toBe(false);
    expect(designAgentEligibility(agent({ billing: 'local' })).label).toBe('local model');
  });

  it('gives agents an exact, bounded deliverable with the preview limits', () => {
    const b = DesignBriefSchema.parse({ ...brief, screens: brief.screens.slice(0, 3), states: ['empty', 'loading', 'error', 'success', 'offline'] });
    const job = { id: 'dj_1', kind: 'generate', brief: b, dir: 'design/release-checks' } as DesignJob;
    const p = designJobPrompt(job, { contract: { version: 3, hash: 'f'.repeat(64) } });
    expect(p).toContain('`design/release-checks/`');
    expect(p).toContain('`index.html` (Overview), `checks.html` (Checks), `check-detail.html` (Check detail)');
    expect(p).toContain('empty, loading, error, success, offline');
    expect(p).toContain(`contract v3, SHA-256 ${'f'.repeat(64)}`);
    expect(p).toMatch(/localStorage, sessionStorage, IndexedDB and cookies are unavailable/);
    expect(p).toContain('register_design_mock');
    expect(p.length).toBeLessThan(3500);
  });
});
