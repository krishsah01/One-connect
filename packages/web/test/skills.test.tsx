// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyState, parseConfig, skillMarkdown, type ControlState, type EventEnvelope, type SkillDraft, type SkillImportPreview } from '@acc/core';
import { draftHash } from '@acc/core/skillHash';
import { Skills } from '../src/pages/Skills';

vi.mock('../src/lib/remote', () => ({
  hasMutationAuthority: () => true,
  refreshIdentityFromApi: () => {},
  remoteCsrf: () => null,
}));

afterEach(cleanup);

let seq = 0;
const ev = (type: string, data: unknown, refs: Partial<EventEnvelope> = {}): EventEnvelope =>
  ({ seq: ++seq, id: `e${seq}`, ts: new Date().toISOString(), type, kind: 'control', actor: { type: 'human', id: 'owner' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data, ...refs }) as EventEnvelope;

function state(): ControlState {
  const cfg = parseConfig({ project: { name: 'demo', repo: '/r' }, agents: [{ id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' }] });
  let s = emptyState();
  for (const e of [ev('config.loaded', { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies }), ev('agent.registered', { config: cfg.agents[0] })]) s = applyEvent(s, e);
  return s;
}

const baseDraft: SkillDraft = {
  id: 'review-checklist', name: 'Review checklist',
  description: 'Use when reviewing UI changes for complete states and keyboard focus.',
  instructions: 'Check empty, error and loading states.',
  references: [],
  source: null, license: null,
};

describe('Skills page', () => {
  let hash = draftHash(baseDraft);
  let detailCalls = 0;
  let saveCalls = 0;
  let lastExpected: string | null = null;
  let publishCalls = 0;
  let importPreviewCalls = 0;
  let contentCalls = 0;
  let exportCalls = 0;
  let disableCalls = 0;
  let published = false;
  let versionContent = skillMarkdown(baseDraft);
  let storedDraft: SkillDraft = baseDraft;

  beforeEach(() => {
    storedDraft = structuredClone(baseDraft);
    detailCalls = 0; saveCalls = 0; publishCalls = 0; importPreviewCalls = 0;
    contentCalls = 0; exportCalls = 0; disableCalls = 0; published = false;
    hash = draftHash(baseDraft);
    lastExpected = hash;
    versionContent = skillMarkdown(baseDraft);

    vi.stubGlobal('fetch', vi.fn(async (url: string | Request | URL, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/skills' && method === 'GET') {
        return new Response(JSON.stringify({
          builtin: [{ id: 'taste-skill', name: 'Taste', description: 'Use when redesigning.', license: 'MIT', source: 'builtin', version: 'abc', references: [] }],
          project: [{ id: 'review-checklist', name: baseDraft.name, description: baseDraft.description, latest: published ? 1 : null, versions: published ? [{ id: 'review-checklist', version: 1, hash: 'versionhash', name: baseDraft.name, description: baseDraft.description, files: [], createdAt: new Date().toISOString(), by: { type: 'human' } }] : [], draft: { hash, name: baseDraft.name, description: baseDraft.description, updatedAt: 'now' }, disabled: false, createdAt: 'now', updatedAt: 'now' }],
          exportDirs: { 'codex-cli': '.agents/skills' },
          templates: [{ id: 'evidence-review', title: 'Evidence-first review', description: 'Independent review.', license: 'Apache-2.0' }],
        }), { status: 200 });
      }
      if (path.startsWith('/api/skills/review-checklist/content') && method === 'GET') {
        contentCalls += 1;
        const file = new URL(path, 'http://localhost').searchParams.get('file') ?? 'SKILL.md';
        return new Response(JSON.stringify({ file, content: file === 'SKILL.md' ? versionContent : '# ref', files: ['SKILL.md', 'references/states.md'] }), { status: 200 });
      }
      if (path.startsWith('/api/skills/review-checklist') && method === 'GET' && !path.includes('/content') && !path.includes('/export')) {
        detailCalls += 1;
        return new Response(JSON.stringify({
          skill: { id: 'review-checklist', name: baseDraft.name, description: baseDraft.description, latest: published ? 1 : null, versions: published ? [{ id: 'review-checklist', version: 1, hash: 'versionhash', name: baseDraft.name, description: baseDraft.description, files: [{ path: 'SKILL.md', sha256: 'abc', bytes: 1 }], createdAt: new Date().toISOString(), by: { type: 'human' } }] : [], draft: { hash, name: baseDraft.name, description: baseDraft.description, updatedAt: 'now' }, disabled: false, createdAt: 'now', updatedAt: 'now' },
          draft: { ...storedDraft, hash },
          editable: storedDraft,
          advice: [],
          usedBy: [],
        }), { status: 200 });
      }
      if (path === '/api/skills/review-checklist/draft' && method === 'POST') {
        saveCalls += 1;
        const body = JSON.parse(String(init?.body)) as { draft: SkillDraft; expected: string | null };
        lastExpected = body.expected;
        if (body.expected !== hash) return new Response(JSON.stringify({ error: 'This skill changed. Reload before saving.' }), { status: 409 });
        storedDraft = body.draft;
        hash = draftHash(body.draft);
        return new Response(JSON.stringify({ skill: { id: body.draft.id, name: body.draft.name, description: body.draft.description, latest: published ? 1 : null, versions: [], draft: { hash, name: body.draft.name, description: body.draft.description, updatedAt: 'now' }, disabled: false, createdAt: 'now', updatedAt: 'now' }, advice: [] }), { status: 200 });
      }
      if (path === '/api/skills/review-checklist/publish' && method === 'POST') {
        publishCalls += 1;
        const body = JSON.parse(String(init?.body)) as { expectedDraftHash: string };
        if (body.expectedDraftHash !== hash) return new Response(JSON.stringify({ error: 'The draft changed since you last saved.' }), { status: 409 });
        published = true;
        return new Response(JSON.stringify({ version: { version: 1 } }), { status: 200 });
      }
      if (path === '/api/skills/review-checklist/disable' && method === 'POST') {
        disableCalls += 1;
        return new Response(JSON.stringify({ skill: { id: 'review-checklist', disabled: true } }), { status: 200 });
      }
      if (path === '/api/skills/review-checklist/versions/1/export' && method === 'GET') {
        exportCalls += 1;
        return new Response(JSON.stringify({ format: 'one-connect-skill-bundle', bundleVersion: 1, skill: { id: 'review-checklist', name: baseDraft.name, version: 1, hash: 'versionhash' }, files: [{ path: 'SKILL.md', content: versionContent, sha256: 'abc' }], attribution: {}, note: 'test' }), { status: 200 });
      }
      if (path === '/api/skills/import/preview' && method === 'POST') {
        importPreviewCalls += 1;
        const body = JSON.parse(String(init?.body)) as { files?: { skillMd: string }; bundle?: unknown };
        const preview: SkillImportPreview = {
          draft: { ...baseDraft, id: 'imported-skill', name: 'Imported Name', instructions: 'Imported body', references: [{ path: 'references/a.md', content: 'ref text' }] },
          advice: [],
          attribution: { source: 'unknown', license: 'unknown' },
          files: [{ path: 'SKILL.md', sha256: 'abc', bytes: 10 }],
          untrusted: true,
          note: 'untrusted',
        };
        if (body.bundle) return new Response(JSON.stringify({ error: 'bad bundle' }), { status: 400 });
        return new Response(JSON.stringify(preview), { status: 200 });
      }
      if (path === '/api/skills/templates/evidence-review') {
        return new Response(JSON.stringify({ template: { id: 'evidence-review', title: 'Evidence-first review', description: 'x', license: 'Apache-2.0', draft: { ...baseDraft, id: 'evidence-review', name: 'Evidence-first review' } }, advice: [], note: 'template' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }));
  });

  it('keeps save notice after reload and saves two successive drafts with expected hashes', async () => {
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /review checklist/i }));
    await waitFor(() => expect(detailCalls).toBeGreaterThan(0));
    const textarea = screen.getByLabelText(/Instructions/i);
    fireEvent.change(textarea, { target: { value: 'First save edit.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByText(/Draft saved/i)).toBeTruthy());
    expect(saveCalls).toBe(1);
    expect(lastExpected).toBe(draftHash(baseDraft));
    fireEvent.change(textarea, { target: { value: 'Second save edit.' } });
    const firstHash = hash;
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saveCalls).toBe(2));
    expect(lastExpected).toBe(firstHash);
  });

  it('refuses publish with stale hash and publishes after save with exact reviewed hash', async () => {
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /review checklist/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /review checklist/i }));
    await waitFor(() => expect(detailCalls).toBeGreaterThan(0));
    const textarea = screen.getByLabelText(/Instructions/i);
    fireEvent.change(textarea, { target: { value: 'Publish test edit.' } });
    expect((screen.getByRole('button', { name: /Publish/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saveCalls).toBe(1));
    const publish = screen.getByRole('button', { name: /Publish/ });
    hash = 'stale-hash';
    fireEvent.click(publish);
    await waitFor(() => expect(screen.getAllByText(/draft changed|changed/i).length).toBeGreaterThan(0));
    expect(publishCalls).toBe(1);
    hash = draftHash({ ...baseDraft, instructions: 'Publish test edit.' });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saveCalls).toBe(2));
    fireEvent.click(publish);
    await waitFor(() => expect(publishCalls).toBe(2));
    expect(screen.getByText(/Published v1/i)).toBeTruthy();
  });

  it('preserves local edits when conflict reload is clicked', async () => {
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /review checklist/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /review checklist/i }));
    await waitFor(() => expect(detailCalls).toBeGreaterThan(0));
    const textarea = screen.getByLabelText(/Instructions/i);
    fireEvent.change(textarea, { target: { value: 'Local unsaved edit.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saveCalls).toBe(1));
    hash = 'stale';
    fireEvent.change(textarea, { target: { value: 'Local unsaved edit plus more.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getAllByText(/changed/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Reload server copy' }));
    await waitFor(() => expect(detailCalls).toBeGreaterThan(1));
    expect((screen.getByLabelText(/Instructions/i) as HTMLTextAreaElement).value).toBe('Local unsaved edit plus more.');
  });

  it('loads a template into a new draft without publishing', async () => {
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Evidence-first review/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Evidence-first review/i }));
    await waitFor(() => expect(screen.getByText(/Loaded template/i)).toBeTruthy());
    expect(screen.getByDisplayValue('evidence-review')).toBeTruthy();
  });

  it('saves a new template, loads its saved details and publishes the exact reviewed draft', async () => {
    const baseFetch = vi.mocked(fetch).getMockImplementation()!;
    let draft: SkillDraft | null = null;
    let draftVersionHash: string | null = null;
    let frozen: SkillDraft | null = null;
    const metadata = () => ({ id: 'evidence-review', name: draft?.name ?? frozen?.name, description: draft?.description ?? frozen?.description,
      latest: frozen ? 1 : null, versions: [], draft: draft ? { hash: draftVersionHash, name: draft.name, description: draft.description, updatedAt: 'now' } : null,
      disabled: false, createdAt: 'now', updatedAt: 'now' });
    vi.mocked(fetch).mockImplementation(async (url: string | Request | URL, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const method = init?.method ?? 'GET';
      if (path === '/api/skills/evidence-review/draft' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body.expected).toBe(null);
        draft = body.draft;
        draftVersionHash = draftHash(draft!);
        return new Response(JSON.stringify({ skill: metadata(), advice: [] }));
      }
      if (path === '/api/skills/evidence-review' && method === 'GET') {
        return new Response(JSON.stringify({ skill: metadata(), draft: draft ? { ...draft, hash: draftVersionHash } : null, editable: draft ?? frozen, advice: [], usedBy: [] }));
      }
      if (path === '/api/skills/evidence-review/publish' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ expectedVersion: null, expectedDraftHash: draftVersionHash });
        frozen = draft;
        draft = null;
        return new Response(JSON.stringify({ version: { version: 1 } }));
      }
      return baseFetch(url, init);
    });
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Evidence-first review/i }));
    await screen.findByDisplayValue('evidence-review');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Publish v1' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Publish v1' }));
    await screen.findByText(/Published v1/);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Publish v2' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByText('unsaved edits')).toBeNull();
    expect(screen.getByText('published v1')).toBeTruthy();
    expect(frozen).toMatchObject({ id: 'evidence-review', name: 'Evidence-first review' });
  });

  it('keeps conflict-preserved edits unsaved until they replace the refreshed remote draft', async () => {
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /review checklist/i }));
    await screen.findByDisplayValue(baseDraft.instructions);
    fireEvent.change(screen.getByLabelText(/Instructions/i), { target: { value: 'My reviewed local instructions.' } });
    storedDraft = { ...baseDraft, instructions: 'Remote instructions I have not reviewed.' };
    hash = draftHash(storedDraft);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('button', { name: 'Reload server copy' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload server copy' }));
    await waitFor(() => expect(detailCalls).toBe(2));
    expect((screen.getByLabelText(/Instructions/i) as HTMLTextAreaElement).value).toBe('My reviewed local instructions.');
    expect((screen.getByRole('button', { name: 'Publish v1' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Publish v1' }) as HTMLButtonElement).disabled).toBe(false));
    expect(storedDraft.instructions).toBe('My reviewed local instructions.');
  });

  it('previews import without persisting and shows reference contents', async () => {
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.change(screen.getByPlaceholderText(/Paste SKILL.md/), { target: { value: skillMarkdown(baseDraft) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview files' }));
    await waitFor(() => expect(importPreviewCalls).toBe(1));
    expect(screen.getByText(/ref text/)).toBeTruthy();
    expect(screen.getByText(/unknown/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }));
    await waitFor(() => expect(screen.getByDisplayValue('imported-skill')).toBeTruthy());
    expect(saveCalls).toBe(0);
    expect(publishCalls).toBe(0);
  });

  it('invalidates stale import preview when input changes', async () => {
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const ta = screen.getByPlaceholderText(/Paste SKILL.md/);
    fireEvent.change(ta, { target: { value: skillMarkdown(baseDraft) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview files' }));
    await waitFor(() => expect(screen.getByText(/Imported body/)).toBeTruthy());
    fireEvent.change(ta, { target: { value: skillMarkdown({ ...baseDraft, instructions: 'Changed after preview.' }) } });
    await waitFor(() => expect(screen.queryByText(/Imported body/)).toBeNull());
  });

  it('discards an import response arriving after its input was edited', async () => {
    const baseFetch = vi.mocked(fetch).getMockImplementation()!;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let requested = false;
    vi.mocked(fetch).mockImplementation(async (url: string | Request | URL, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (path === '/api/skills/import/preview') { requested = true; await pending; }
      return baseFetch(url, init);
    });
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
    fireEvent.change(screen.getByPlaceholderText(/Paste SKILL.md/), { target: { value: skillMarkdown(baseDraft) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview files' }));
    await waitFor(() => expect(requested).toBe(true));
    fireEvent.change(screen.getByPlaceholderText(/Paste SKILL.md/), { target: { value: 'New input while preview was pending' } });
    finish();
    await waitFor(() => expect(importPreviewCalls).toBe(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Preview files' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/Imported body/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load into editor' })).toBeNull();
  });

  it('reads version content and downloads export bytes', async () => {
    published = true;
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = createElement(tag);
      if (tag === 'a') Object.defineProperty(el, 'click', { value: vi.fn() });
      return el;
    });
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /review checklist/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /review checklist/i }));
    await waitFor(() => expect(detailCalls).toBeGreaterThan(0));
    const readButtons = screen.getAllByRole('button', { name: 'Read' });
    fireEvent.click(readButtons[readButtons.length - 1]);
    await waitFor(() => expect(contentCalls).toBe(1));
    await waitFor(() => expect(screen.getByLabelText('Skill content')).toBeTruthy());
    expect(screen.getByLabelText('Skill content').textContent).toMatch(/Check empty/);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(exportCalls).toBe(1));
  });

  it('isolates late detail responses after starting a new skill', async () => {
    const baseFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url: string | Request | URL, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const method = init?.method ?? 'GET';
      if (path.startsWith('/api/skills/review-checklist') && method === 'GET' && !path.includes('/content') && !path.includes('/export')) {
        detailCalls += 1;
        await new Promise(r => setTimeout(r, 50));
        return new Response(JSON.stringify({
          skill: { id: 'review-checklist', name: 'Late response', description: baseDraft.description, latest: null, versions: [], draft: { hash, name: 'Late response', description: baseDraft.description, updatedAt: 'now' }, disabled: false, createdAt: 'now', updatedAt: 'now' },
          draft: { ...baseDraft, name: 'Late response', hash },
          editable: { ...baseDraft, name: 'Late response' },
          advice: [],
          usedBy: [],
        }), { status: 200 });
      }
      return baseFetch(url, init);
    });
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /review checklist/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /review checklist/i }));
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    await waitFor(() => expect(detailCalls).toBe(1), { timeout: 2000 });
    expect(screen.getByRole('heading', { name: /Draft a new skill/i })).toBeTruthy();
    expect(screen.queryByDisplayValue('Late response')).toBeNull();
  });
});
