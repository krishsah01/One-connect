// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, DEFAULT_DESIGN, emptyState, parseConfig, REVIEW_CHECKLIST, type ControlState, type EventEnvelope } from '@acc/core';
import { Designer } from '../src/pages/Designer';
import { loadRemoteSession, setRemoteSession } from '../src/lib/remote';

afterEach(()=>{cleanup();vi.unstubAllGlobals();setRemoteSession(null,'checking');});
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

const calls: string[] = [];
beforeEach(async () => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    // Explicit verified local-owner identity, matching the current signed-in dashboard.
    if (url === '/api/remote/session') return new Response(JSON.stringify({error:'Not a phone session'}),{status:403});
    if (url.startsWith('/api/designer/drafts/')) return json(init?.method === 'PUT' ? { draft: { key: 'brief', value: JSON.parse(String(init.body)).value, savedAt: new Date().toISOString(), base: null } } : { draft: null });
    if (url === '/api/designer/studio') return json({ tooling: { playwright: { found: false, path: null, note: 'Nothing is installed automatically.' } } });
    if (url === '/api/designer/contract') return json({ current: null, history: [], draft: null, skills: [{ id: 'visual-critique', name: 'Visual critique', description: 'd', license: 'Apache-2.0', source: 'One Connect', version: '1', purpose: 'Independent review.' }], skillSets: { design: ['visual-critique'], implementation: [], review: ['visual-critique'] }, checklist: REVIEW_CHECKLIST });
    if (url === '/api/designer/validate') return json({ ok: true, errors: [], hash: 'b'.repeat(64), unchanged: false, warnings: [], diff: [{ field: 'name', label: 'Name', before: null, after: 'Connected clarity' }], current: null });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }));
  await loadRemoteSession();
});

describe('Designer studio', () => {
  it('explains the flow, gates creation on a saved contract and never offers relay agents', async () => {
    render(<MemoryRouter initialEntries={['/designer']}><Designer state={state()} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Designer' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Studio workflow' }).textContent).toMatch(/Save a design system.*Brief a reviewable task.*Run and capture.*Review and hand off/);
    await waitFor(() => expect(screen.getByRole('form', { name: 'Design brief' })).toBeTruthy());
    expect(screen.getByText(/Design jobs freeze the saved project contract/)).toBeTruthy();
    const relay = screen.getByRole('radio', { name: /Antigravity/ }) as HTMLInputElement;
    expect(relay.disabled).toBe(true);
    expect(screen.getByText(/Relay agents need you to work in another app/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create reviewable task' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/What the isolated preview cannot do/)).toBeTruthy();
  });

  it('autosaves the brief as a server draft and maps screens to page files', async () => {
    render(<MemoryRouter initialEntries={['/designer']}><Designer state={state(true)} /></MemoryRouter>);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Release checks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add screen' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Screen 2 name' }), { target: { value: 'Check detail' } });
    expect(screen.getByText('check-detail.html')).toBeTruthy();
    await waitFor(() => expect(calls.some(c => c.startsWith('PUT /api/designer/drafts/brief'))).toBe(true), { timeout: 3000 });
    expect(screen.getByText(/Brief saved .* not approved/)).toBeTruthy();
  });

  it('switches sections with the keyboard and shows the contract as an unapproved draft until validated', async () => {
    render(<MemoryRouter initialEntries={['/designer']}><Designer state={state()} /></MemoryRouter>);
    const studio = screen.getByRole('tab', { name: 'Studio' });
    expect(studio.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(studio, { key: 'ArrowRight' });
    const system = screen.getByRole('tab', { name: 'Design system' });
    expect(system.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(system);
    await waitFor(() => expect(screen.getByText('unsaved draft · not approved')).toBeTruthy());
    expect(screen.getByRole('region', { name: /Component specimen: Draft preview · not the approved contract/ })).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save as v1' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Validate draft' }));
    await waitFor(() => expect(screen.getByText(/Validated on the daemon/)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Save as v1' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('list', { name: 'Contract changes' })).toBeTruthy();
    fireEvent.keyDown(system, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Skills and sources' }).getAttribute('aria-selected')).toBe('true');
  });
});
