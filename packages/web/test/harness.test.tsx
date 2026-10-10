// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Agent builder (OpenCode default, honest Ollama states), console child sessions and Jev advice.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyState, parseConfig, type ControlState, type EventEnvelope } from '@acc/core';
import { AgentBuilder } from '../src/pages/AgentBuilder';
import { Decisions } from '../src/pages/Decisions';

import { setRemoteSession } from '../src/lib/remote';

// These isolated management fixtures explicitly model a verified local owner.
beforeEach(() => setRemoteSession(null, 'local'));
afterEach(() => setRemoteSession(null, 'checking'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let seq = 0;
const ev = (type: string, data: unknown): EventEnvelope =>
  ({ seq: ++seq, id: `e${seq}`, ts: new Date().toISOString(), type, kind: 'control', actor: { type: 'system', id: 't' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data }) as EventEnvelope;

function base(): ControlState {
  const cfg = parseConfig({ project: { name: 'demo', repo: '/r' }, agents: [{ id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' }] });
  let s = emptyState();
  for (const e of [ev('config.loaded', { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies }), ev('agent.registered', { config: cfg.agents[0] })]) s = applyEvent(s, e);
  return s;
}
const json = (b: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, statusText: '', text: async () => JSON.stringify(b) });

const catalog = {
  harnesses: [
    { adapter: 'opencode-server', displayName: 'OpenCode (API keys & local models)', license: 'MIT', capabilities: { hostApprovals: true, streamingInput: true, resume: true }, limitations: ['Tool permission requests and OpenCode questions arrive in your Decisions inbox before the action runs.'], version: { ok: false, message: 'OpenCode 9.9.9 is not a supported protocol version' }, binary: { path: '/x/opencode', version: '9.9.9' }, supportedSeries: ['1.0'], verification: 'Contract fixtures only. A live, approved provider check is pending.' },
    { adapter: 'codex-cli', displayName: 'Codex CLI', capabilities: {}, limitations: [] },
  ],
  providers: [{ id: 'ollama-cloud', secret: 'ollama-cloud', keyStored: false, needsOptIn: false }],
};

function builder(fetchImpl: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => fetchImpl(url)));
  return render(<MemoryRouter initialEntries={['/agents/new']}><Routes><Route path="/agents/new" element={<AgentBuilder state={base()} />} /></Routes></MemoryRouter>);
}
const route = (url: string) => {
  if (url.startsWith('/api/harnesses')) return json(catalog);
  if (url.startsWith('/api/ollama/status')) return json({ route: 'daemon', state: 'not_signed_in', message: 'Ollama is running but not signed in, so cloud models cannot be used.', fix: 'Run `ollama signin` (or sign in from the Ollama app)', models: [] });
  return json({ skills: [], project: [] });
};

describe('agent builder', () => {
  it('offers Ollama local and cloud, defaults API/local sources to OpenCode, and shows honest state and limits', async () => {
    builder(route);
    const source = await screen.findByLabelText(/Model source/);
    expect([...(source as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Ollama local models'), expect.stringContaining('Ollama cloud models')]));
    fireEvent.change(source, { target: { value: 'ollama-cloud' } });
    expect((screen.getByLabelText('Runtime') as HTMLSelectElement).value).toBe('opencode-server');
    expect([...(screen.getByLabelText('Runtime') as HTMLSelectElement).options]).toHaveLength(1);
    await waitFor(() => expect(screen.getByText('not signed in')).toBeTruthy());
    expect(screen.getByText(/ollama signin/)).toBeTruthy();
    expect(screen.getAllByText(/Ollama subscription/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/usage (is )?unknown|usage shows as unknown/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/arrive in your Decisions inbox/)).toBeTruthy();
    expect(screen.getByText(/not a supported protocol version/)).toBeTruthy();
    expect(screen.getByText(/live, approved provider check is pending/)).toBeTruthy();
  });

  it('local Ollama is free; pay-per-token sources require reviewed cost approval', async () => {
    builder(route);
    const source = await screen.findByLabelText(/Model source/);
    fireEvent.change(source, { target: { value: 'ollama' } });
    expect(screen.getByText(/Local model · free/)).toBeTruthy();
    fireEvent.change(source, { target: { value: 'openrouter' } });
    expect(screen.getByText(/Pay per token/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review cost approval' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save agent draft' })).toBeNull();
    expect(screen.getByText(/Nothing is enabled before that approval/)).toBeTruthy();
    expect((screen.getByLabelText('Daily stop threshold (USD)') as HTMLInputElement).required).toBe(true);
    fireEvent.change(source, { target: { value: 'subscription' } });
    expect(screen.getByText(/Included plan only/)).toBeTruthy();
    expect([...(screen.getByLabelText('Runtime') as HTMLSelectElement).options].some((o) => o.value === 'opencode-server')).toBe(false);
  });
});

describe('Jev advice in the Decisions inbox', () => {
  function withDecision(extra: object = {}): ControlState {
    return applyEvent(base(), ev('decision.created', { decision: { id: 'dec1', question: 'Ship it?', options: ['yes', 'no'], recommendation: null, evidenceLinks: [], urgency: 'normal', irreversible: false, answer: null, answeredAt: null, channel: null, createdAt: new Date().toISOString(), kind: 'question', evidence: [], ...extra } }));
  }
  const advisory = { provider: 'jev', inputHash: 'a'.repeat(64), model: 'system-one-1', usage: { input_tokens: 10 }, requestedAt: new Date().toISOString(), recommendation: 'yes', rationale: 'Tests pass.', evidenceItems: 2, evidenceChars: 100, evidenceIds: [], confidence: null, host: 'api.typesafe.ai', stale: false, staleReason: null, staleAt: null };

  it('sends nothing on its own: a preview with the exact evidence and three confirmations comes first', async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      if (url === '/api/jev') return json({ enabled: true, keyStored: true, ready: true, host: 'api.typesafe.ai', endpoint: 'https://api.typesafe.ai', disclosure: {}, protocol: '' });
      if (url.endsWith('/advisory/preview')) return json({ host: 'api.typesafe.ai', url: 'x', inputHash: 'h'.repeat(64), payload: { question: 'Ship it?' }, requestBody: { model: 'system-one', state: { question: 'Ship it?', options: ['yes', 'no'] }, questions: { decision: { type: 'choice', criteria: { option_0: 'yes', option_1: 'no' } } } }, items: 0, chars: 40, truncated: false, blocked: null, canRequest: true });
      if (url.endsWith('/advisory')) return json({ decision: {} });
      return json({});
    }));
    render(<MemoryRouter><Decisions state={withDecision()} /></MemoryRouter>);
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Ask Jev for a recommendation' }));
    await waitFor(() => expect(screen.getByText(/api\.typesafe\.ai/, { selector: 'b' })).toBeTruthy());
    expect(screen.getByText(/Ship it\?/, { selector: 'pre' })).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send to Jev' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    expect(send.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/advisory/cancel'))).toBe(true));
    expect(calls.some((c) => c.url.endsWith('/advisory') && c.method === 'POST')).toBe(false);
  });

  it('shows a recorded advisory as advice with its model and usage, and marks a stale one out of date', () => {
    const { unmount } = render(<MemoryRouter><Decisions state={withDecision({ advisory })} /></MemoryRouter>);
    expect(screen.getByRole('note', { name: 'Jev advisory' }).textContent).toContain('suggests yes');
    expect(screen.getByRole('note', { name: 'Jev advisory' }).textContent).toContain('Advice only, never your answer or an approval');
    expect(screen.getByRole('note', { name: 'Jev advisory' }).textContent).toContain('system-one-1');
    expect(screen.getByRole('button', { name: 'yes' })).toBeTruthy(); // the human's own buttons are separate
    unmount();
    render(<MemoryRouter><Decisions state={withDecision({ advisory: { ...advisory, stale: true, staleReason: 'the decision evidence changed after Jev reviewed it' } })} /></MemoryRouter>);
    expect(screen.getByRole('note', { name: 'Jev advisory' }).textContent).toContain('out of date');
    expect(screen.getByRole('note', { name: 'Jev advisory' }).textContent).not.toContain('suggests');
    expect(screen.getByRole('button', { name: 'Ask Jev again' })).toBeTruthy();
  });
});
