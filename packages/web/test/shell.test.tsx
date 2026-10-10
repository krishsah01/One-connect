// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyState, parseConfig, type ControlState, type EventEnvelope } from '@acc/core';
import { Shell, surfaceFor } from '../src/shell/Shell';
import { loadRemoteSession } from '../src/lib/remote';

afterEach(cleanup);
let seq = 0;
const ev = (type: string, data: unknown): EventEnvelope => ({ seq: ++seq, id: `e${seq}`, ts: new Date().toISOString(), type, kind: 'control', actor: { type: 'human', id: 'owner' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data }) as EventEnvelope;

function state(): ControlState {
  const cfg = parseConfig({ project: { name: 'demo', repo: '/r' }, agents: [{ id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' }] });
  let s = emptyState();
  for (const e of [ev('config.loaded', { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies }), ...cfg.agents.map(a => ev('agent.registered', { config: a }))]) s = applyEvent(s, e);
  return s;
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/remote/session') return new Response(JSON.stringify({ error: 'Not a phone session' }), { status: 403 });
    if (url === '/api/canvas') return new Response(JSON.stringify({ layout: { version: 2, frames: {}, nodes: {}, sketches: {}, gates: {}, chains: {} }, rev: 0 }), { status: 200 });
    if (url.startsWith('/api/canvas/logs')) return new Response(JSON.stringify({ last: 7, events: [{ seq: 7, ts: '2026-10-10T00:00:00.000Z', kind: 'control', type: 'alert.raised', actor: 'system', agentId: 'codex', runId: null, workItemId: null, text: 'Codex is stalled' }] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  await loadRemoteSession();
});

describe('canvas shell routing', () => {
  it('keeps every old route reachable: settings in the dialog, tools in the drawer', () => {
    expect(surfaceFor('/')).toEqual({ kind: 'base' });
    expect(surfaceFor('/board')).toEqual({ kind: 'base' });
    for (const [path, tab] of [['/settings', 'settings'], ['/setup', 'agents'], ['/agents/new', 'agents'], ['/agents/codex/edit', 'agents'], ['/connectors', 'connectors'], ['/skills', 'skills'], ['/projects', 'projects'], ['/remote', 'phone'], ['/phone', 'phone']] as const) {
      expect(surfaceFor(path)).toEqual({ kind: 'settings', tab });
    }
    for (const [path, body] of [['/inbox', 'inbox'], ['/decisions', 'decisions'], ['/insights', 'insights'], ['/reports', 'insights'], ['/analytics', 'insights'], ['/release', 'insights'], ['/docs', 'docs'], ['/designer', 'designer'], ['/mocks', 'mocks'], ['/mocks/m1', 'mocks'], ['/agents/codex', 'agent'], ['/team', 'team'], ['/workspace', 'workspace'], ['/runs/r1', 'run'], ['/workflows', 'workflows']] as const) {
      expect(surfaceFor(path)).toMatchObject({ kind: 'drawer', body });
    }
  });
});

describe('canvas shell', () => {
  it('has one short top bar, opens settings as a dialog and closes it with Escape', async () => {
    render(<MemoryRouter initialEntries={['/settings']}><Shell state={state()} conn="live" meta={{ demo: false, tracker: null }} projectSwitcher={<b>demo</b>} /></MemoryRouter>);
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeTruthy();
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(screen.getByRole('navigation', { name: 'Settings sections' }).textContent).toMatch(/Project and policies.*Agents and sign-in.*Connectors.*Skills.*Projects.*Phone and alerts/);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
  });

  it('opens the command palette with Cmd+K and offers One Ask for free text', async () => {
    render(<MemoryRouter initialEntries={['/']}><Shell state={state()} conn="live" meta={{ demo: false, tracker: null }} projectSwitcher={<b>demo</b>} /></MemoryRouter>);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('combobox', { name: 'Ask or jump to' });
    fireEvent.change(input, { target: { value: 'connectors' } });
    expect(screen.getByRole('option', { name: /Settings: connectors/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /One Ask: “connectors”/ })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Ask or jump to' })).toBeNull());
  });
});

describe('theme and bottom panel', () => {
  it('cycles Day, Night and Machine, and opens the logs with Ctrl+`', async () => {
    try { localStorage.clear(); } catch { /* jsdom */ }
    render(<MemoryRouter initialEntries={['/']}><Shell state={state()} conn="live" meta={{ demo: false, tracker: null }} projectSwitcher={<b>demo</b>} /></MemoryRouter>);
    const theme = screen.getByRole('button', { name: /^Theme: Machine/ });
    fireEvent.click(theme);
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: /^Theme: Day/ }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: /^Theme: Night/ }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    expect(await screen.findByRole('log')).toBeTruthy();
    expect(await screen.findByText('Codex is stalled')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Problems' }));
    expect(screen.getByText('Codex is stalled')).toBeTruthy();
  });
});
