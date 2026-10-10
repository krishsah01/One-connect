// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyState, parseConfig, type ControlState, type EventEnvelope } from '@acc/core';
import { Skills } from '../src/pages/Skills';
import { Mocks } from '../src/pages/Mocks';

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

describe('library pages', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/skills')) return new Response(JSON.stringify({ builtin: [{ id: 'taste-skill', name: 'Taste', description: 'Use when redesigning.', license: 'MIT', source: 'builtin', version: 'abc' }], project: [], exportDirs: { 'codex-cli': '.agents/skills' }, templates: [] }), { status: 200 });
      if (url.startsWith('/api/mocks')) return new Response(JSON.stringify({ mocks: [], design: null }), { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }));
  });

  it('Skills teaches concise, on-demand loading', async () => {
    render(<MemoryRouter><Skills state={state()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy());
    expect(screen.getByText(/Keep skills small/i)).toBeTruthy();
    expect(screen.getByText(/get_skill/i)).toBeTruthy();
    expect(screen.getByText(/Taste/)).toBeTruthy();
  });

  it('Mocks explains honest preview limits and lists empty state', async () => {
    render(<MemoryRouter initialEntries={['/mocks']}><Routes><Route path="/mocks" element={<Mocks state={state()} />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Design mocks' })).toBeTruthy());
    expect(screen.getByText(/No mocks captured/i)).toBeTruthy();
    expect(screen.getByText(/Capture a mock folder/i)).toBeTruthy();
  });
});
