// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, createDesignDocument, DEFAULT_DESIGN, emptyState, parseConfig, type Assignment, type ControlState, type DesignDocument, type EventEnvelope, type WorkItem } from '@acc/core';
import { Designer } from '../src/pages/Designer';
import { loadRemoteSession, setRemoteSession } from '../src/lib/remote';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setRemoteSession(null, 'checking'); });
let seq = 0;
const ev = (type: string, data: unknown, refs: Partial<EventEnvelope> = {}): EventEnvelope =>
  ({ seq: ++seq, id: `e${seq}`, ts: new Date().toISOString(), type, kind: 'control', actor: { type: 'human', id: 'owner' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data, ...refs }) as EventEnvelope;

function state(withContract = false): ControlState {
  const cfg = parseConfig({ project: { name: 'demo', repo: '/r' }, agents: [{ id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' }, { id: 'ag', name: 'Antigravity', role: 'engineer', adapter: 'relay' }] });
  let s = emptyState();
  const events = [ev('config.loaded', { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies }), ...cfg.agents.map(a => ev('agent.registered', { config: a }))];
  if (withContract) events.push(ev('design.system_saved', { revision: { version: 1, hash: 'a'.repeat(64), system: DEFAULT_DESIGN, createdAt: new Date().toISOString() } }));
  for (const e of events) s = applyEvent(s, e);
  return s;
}

const calls: { method: string; url: string; body: unknown }[] = [];
let doc: DesignDocument;
let jobs: { assignmentId: string; request: string; selection: string[]; files: string[]; kind: string; skills: never[]; createdAt: string }[] = [];
const record = () => ({ document: doc, proposals: [], jobs, assignments: jobs.map(j => j.assignmentId), authors: [{ type: 'human', id: 'owner' }], updatedAt: new Date().toISOString(), artifactId: null, undo: { count: 0, label: null }, redo: { count: 0, label: null } });
beforeEach(async () => {
  calls.length = 0; jobs = [];
  doc = createDesignDocument('doc-1', 'Release checks');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === '/api/remote/session') return json({ error: 'Not a phone session' }, 403);
    if (url === '/api/designer/documents' && init?.method === 'POST') return json(record());
    if (url === '/api/designer/documents') return json({ documents: [{ id: 'doc-1', name: 'Release checks', version: 1, updatedAt: new Date().toISOString(), artifactId: null, screens: 4, firstScreen: 'Overview' }] });
    if (url === '/api/designer/documents/doc-1') return json(record());
    if (url === '/api/designer/documents/doc-1/ai') return json({ assignment: { id: 'asg-1' }, preflight: { checks: [] }, skills: [] });
    if (url === '/api/assignments/asg-1/dispatch') return json({ started: true, queued: false });
    if (url === '/api/assignments/asg-1/preflight') return json({ preflight: { ok: true, checks: [] } });
    if (url === '/api/designer/documents/doc-1/operations') { const ops = body.operations; doc = { ...doc, version: doc.version + 1 }; return json({ id: 'doc-1', version: doc.version, updatedAt: new Date().toISOString(), patch: {}, undo: { count: 1, label: body.label }, redo: { count: 0, label: null }, ops }); }
    if (url === '/api/designer/documents/doc-1/release-readiness') return json({ blockers: ['Publish this design’s foundations as the project design system first.'], impact: {} });
    if (url.startsWith('/api/designer/assets/')) return json({ mime: 'image/png', base64: '' });
    if (url.startsWith('/api/designer/repository/files')) return json({ files: ['src/pages/Checks.tsx'] });
    return json({ error: `not found: ${url}` }, 404);
  }));
  await loadRemoteSession();
});

describe('Designer', () => {
  it('starts a design from one sentence, never offers relay agents, and hands the prompt to the agent', async () => {
    render(<MemoryRouter initialEntries={['/designer']}><Designer state={state(true)} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'What are you designing?' })).toBeTruthy();
    const agent = screen.getByRole('combobox', { name: 'Design agent' }) as HTMLSelectElement;
    expect(Array.from(agent.options).map(o => o.textContent)).toEqual(['Codex']);
    expect(screen.queryByRole('form', { name: 'Design brief' })).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    await screen.findByText('Release checks');
    const idea = screen.getByRole('textbox', { name: 'Describe the interface' });
    fireEvent.change(idea, { target: { value: 'A dashboard where engineers see which release checks failed and re-run one.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start designing' }));
    await waitFor(() => expect(calls.some(c => c.url === '/api/assignments/asg-1/dispatch')).toBe(true));
    const create = calls.find(c => c.method === 'POST' && c.url === '/api/designer/documents')!.body as { name: string; proposal: { prompt: string } };
    expect(create.name).toBe('Dashboard');
    expect(create.proposal.prompt).toMatch(/release checks/);
    const ai = calls.find(c => c.url === '/api/designer/documents/doc-1/ai')!.body as { agentId: string; kind: string };
    expect(ai).toMatchObject({ agentId: 'codex', kind: 'generate' });
    await screen.findByRole('main', { name: 'Canvas' });
  });

  it('shows screens on the canvas, opens the panel only on selection, and closes it with Escape', async () => {
    render(<MemoryRouter initialEntries={['/designer?document=doc-1']}><Designer state={state(true)} /></MemoryRouter>);
    const canvas = await screen.findByRole('main', { name: 'Canvas' });
    expect(within(canvas).getByRole('region', { name: 'Overview screen' })).toBeTruthy();
    expect(within(canvas).getByRole('region', { name: 'Projects screen' })).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Ask the design agent' })).toBeTruthy();
    fireEvent.click(within(canvas).getAllByRole('button', { name: 'View all projects' })[0]);
    const panel = await screen.findByRole('complementary', { name: /Selected: View all/ });
    expect(within(panel).getByRole('textbox', { name: 'Label' })).toBeTruthy();
    expect(within(panel).getByRole('group', { name: 'Style' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Scope: View all/ })).toBeTruthy();
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(screen.getByText('Whole design')).toBeTruthy();
  });

  it('opens Review and Design system as sheets from the top bar and reports release blockers', async () => {
    render(<MemoryRouter initialEntries={['/designer?document=doc-1']}><Designer state={state(true)} /></MemoryRouter>);
    await screen.findByRole('main', { name: 'Canvas' });
    fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    const review = await screen.findByRole('complementary', { name: 'Review' });
    await waitFor(() => expect(within(review).getByText(/Publish this design’s foundations/)).toBeTruthy());
    expect((within(review).getByRole('button', { name: 'Create a release for review' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Design system/ }));
    const system = await screen.findByRole('complementary', { name: 'Design system' });
    expect(within(system).getByRole('button', { name: /^accent:/ })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Review' })).toBeNull();
    fireEvent.click(within(system).getByRole('button', { name: 'Close design system' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
  });

  it('starts a prepared request by itself once the tracker confirms its issue', async () => {
    jobs = [{ assignmentId: 'asg-1', request: 'Add an empty state', selection: [], files: [], kind: 'edit', skills: [], createdAt: new Date().toISOString() }];
    const s = state(true);
    s.workItems['wi-1'] = { id: 'wi-1', key: 'DEMO-7', trackerId: 't', url: null, title: 'Design: Add an empty state', description: '', acceptance: [], labels: [], priority: 2, parentKey: null, blockedBy: [], state: 'todo', blockedOn: null, resumeTo: null, ownerAgentId: 'codex', assignmentIds: ['asg-1'], runIds: [], branches: [], evidence: [], requiresProductionVerification: false, trackerStatus: null, sync: { status: 'synced', lastError: null, at: new Date().toISOString() }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as WorkItem;
    s.assignments['asg-1'] = { id: 'asg-1', workItemId: 'wi-1', agentId: 'codex', position: 'draft', scope: '', allowedPaths: [], worktree: null, branch: null, baseRef: 'main', baseSha: null, requiredChecks: [], askHumanIf: [], handoffFormat: '', prompt: '', promptEdited: false, model: null, effort: null, preflight: { ok: false, checks: [{ id: 'issue', label: 'Issue exists', status: 'fail', message: 'issue is not confirmed in the tracker yet' }], model: null, at: new Date().toISOString() }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as Assignment;
    render(<MemoryRouter initialEntries={['/designer?document=doc-1']}><Designer state={s} /></MemoryRouter>);
    await screen.findByText('Add an empty state');
    expect(screen.getByText('Ready to start')).toBeTruthy();
    await waitFor(() => expect(calls.some(c => c.url === '/api/assignments/asg-1/dispatch')).toBe(true));
    const order = calls.filter(c => c.url.startsWith('/api/assignments/asg-1/')).map(c => c.url.split('/').at(-1));
    expect(order).toEqual(['preflight', 'dispatch']);
  });
});
