// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_DESCRIPTORS, emptyState } from '@acc/core';
import { Connectors, type Listing, type View } from '../src/pages/Connectors';
import { setRemoteSession } from '../src/lib/remote';

beforeEach(() => setRemoteSession(null, 'local'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setRemoteSession(null, 'checking'); });

function mcpConnection(patch: Partial<View> = {}): View {
  const config = { kind: 'mcp' as const, command: '/usr/bin/fake-mcp', args: [], tools: ['echo'], read_roots: ['/tmp/project'] };
  return {
    id: 'tools', name: 'Local tools', kind: 'mcp', config, configHash: 'cfg', disabled: false,
    approvals: { execute: { action: 'execute', decisionId: 'inv-1', configHash: 'cfg', approvedAt: '2026-10-07T00:00:00Z' } },
    pending: {}, availability: { status: 'not_checked', checkedAt: null, detail: 'Executable locally.' },
    createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    state: 'active', bindingCurrent: true, descriptor: CONNECTOR_DESCRIPTORS.mcp,
    actions: CONNECTOR_DESCRIPTORS.mcp.actions.map(a => ({ ...a, allowed: a.id === 'execute', pending: false })),
    ...patch,
  };
}

describe('MCP connector UI', () => {
  it('requests a per-call action, links to Decisions and polls bounded results without overwriting on late responses', async () => {
    const listing: Listing = { descriptors: Object.values(CONNECTOR_DESCRIPTORS), connections: [mcpConnection()], decisions: [] };
    let requestId = 'toolreq-1';
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(url), method });
      if (method === 'POST' && String(url).includes('/tools/echo')) {
        return new Response(JSON.stringify({ request: { id: requestId, connectorId: 'tools', tool: 'echo', status: 'pending', decisionId: 'dec-tool-1', configHash: 'cfg', argumentsHash: 'h1', runId: null, workItemId: null, requesterId: 'owner', createdAt: '2026-10-07T00:00:00Z', startedAt: null, endedAt: null, result: null, error: null }, decision: { id: 'dec-tool-1' } }));
      }
      if (method === 'GET' && String(url).includes('/api/connectors/tool-requests/')) {
        if (String(url).endsWith('/unknown')) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ request: { id: requestId, connectorId: 'tools', tool: 'echo', status: 'succeeded', decisionId: 'dec-tool-1', configHash: 'cfg', argumentsHash: 'h1', runId: null, workItemId: null, requesterId: 'owner', createdAt: '2026-10-07T00:00:00Z', startedAt: '2026-10-07T00:00:01Z', endedAt: '2026-10-07T00:00:02Z', result: { text: '{"text":"hi"}', isError: false, truncated: false }, error: null } }));
      }
      if (String(url).includes('/api/connectors')) return new Response(JSON.stringify(listing));
      return new Response('{}', { status: 404 });
    }));
    render(<MemoryRouter><Connectors state={emptyState()} /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Local tools' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments (JSON)' }), { target: { value: '{"text":"hi"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request action' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.includes('/tools/echo'))).toBe(true));
    await screen.findByRole('link', { name: 'Review in Decisions' });
    expect(screen.getByText('pending')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Tool output').textContent).toContain('hi'), { timeout: 4000 });
    requestId = 'unknown';
    await waitFor(() => expect(screen.getByLabelText('Tool output').textContent).toContain('hi'));
  });

  it('does not show a succeeded result under newly edited arguments', async () => {
    const listing: Listing = { descriptors: Object.values(CONNECTOR_DESCRIPTORS), connections: [mcpConnection()], decisions: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && String(url).includes('/tools/echo')) {
        return new Response(JSON.stringify({ request: { id: 'toolreq-a', connectorId: 'tools', tool: 'echo', status: 'pending', decisionId: 'dec-a', configHash: 'cfg', argumentsHash: 'h1', runId: null, workItemId: null, requesterId: 'owner', createdAt: '2026-10-07T00:00:00Z', startedAt: null, endedAt: null, result: null, error: null }, decision: { id: 'dec-a' } }));
      }
      if (method === 'GET' && String(url).includes('/api/connectors/tool-requests/toolreq-a')) {
        return new Response(JSON.stringify({ request: { id: 'toolreq-a', connectorId: 'tools', tool: 'echo', status: 'succeeded', decisionId: 'dec-a', configHash: 'cfg', argumentsHash: 'h1', runId: null, workItemId: null, requesterId: 'owner', createdAt: '2026-10-07T00:00:00Z', startedAt: '2026-10-07T00:00:01Z', endedAt: '2026-10-07T00:00:02Z', result: { text: 'old-output', isError: false, truncated: false }, error: null } }));
      }
      if (String(url).includes('/api/connectors')) return new Response(JSON.stringify(listing));
      return new Response('{}', { status: 404 });
    }));
    render(<MemoryRouter><Connectors state={emptyState()} /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Local tools' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments (JSON)' }), { target: { value: '{"text":"first"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request action' }));
    await waitFor(() => expect(screen.getByLabelText('Tool output').textContent).toContain('old-output'), { timeout: 4000 });
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments (JSON)' }), { target: { value: '{"text":"second"}' } });
    expect(screen.queryByLabelText('Tool output')).toBeNull();
    expect(screen.getByText(/Arguments changed since this request/)).toBeTruthy();
  });

  it('rejects a poll response carrying a different request id', async () => {
    const listing: Listing = { descriptors: Object.values(CONNECTOR_DESCRIPTORS), connections: [mcpConnection()], decisions: [] };
    const receipt = (id: string, status = 'pending') => ({ id, connectorId: 'tools', configHash: 'cfg', tool: 'echo', status, decisionId: 'dec-current', result: status === 'succeeded' ? { text: 'foreign-output', isError: false, truncated: false } : null, error: null });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ request: receipt('toolreq-current'), decision: { id: 'dec-current' } }));
      if (String(url).includes('/tool-requests/')) return new Response(JSON.stringify({ request: receipt('toolreq-foreign', 'succeeded') }));
      return new Response(JSON.stringify(listing));
    }));
    render(<MemoryRouter><Connectors state={emptyState()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Request action' }));
    await screen.findByText('pending');
    await screen.findByText(/Poll response does not match/, {}, { timeout: 4000 });
    expect(screen.queryByText('foreign-output')).toBeNull();
    expect(screen.getByText('pending')).toBeTruthy();
  });

  it('discards a request arriving after its arguments were edited', async () => {
    const listing: Listing = { descriptors: Object.values(CONNECTOR_DESCRIPTORS), connections: [mcpConnection()], decisions: [] };
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    let requested = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { requested = true; return pending; }
      return new Response(JSON.stringify(listing));
    }));
    render(<MemoryRouter><Connectors state={emptyState()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Request action' }));
    await waitFor(() => expect(requested).toBe(true));
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments (JSON)' }), { target: { value: '{"text":"newly edited"}' } });
    finish(new Response(JSON.stringify({ request: { id: 'old-request', connectorId: 'tools', configHash: 'cfg', tool: 'echo', status: 'pending', decisionId: 'old-decision', result: null, error: null } })));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Request action' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('link', { name: 'Review in Decisions' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Arguments (JSON)' }) as HTMLInputElement).value).toBe('{"text":"newly edited"}');
  });

  it('resets receipts on config change and ignores the old pending request', async () => {
    let listing: Listing = { descriptors: Object.values(CONNECTOR_DESCRIPTORS), connections: [mcpConnection()], decisions: [] };
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    let requested = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { requested = true; return pending; }
      return new Response(JSON.stringify(listing));
    }));
    const app = render(<MemoryRouter><Connectors state={emptyState()} /></MemoryRouter>);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Arguments (JSON)' }), { target: { value: '{"text":"old config"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request action' }));
    await waitFor(() => expect(requested).toBe(true));
    listing = { ...listing, connections: [mcpConnection({ configHash: 'cfg-next', name: 'Changed tools' })] };
    app.rerender(<MemoryRouter><Connectors state={{ ...emptyState(), seq: 1 }} /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Changed tools' });
    expect((screen.getByRole('textbox', { name: 'Arguments (JSON)' }) as HTMLInputElement).value).toBe('{}');
    finish(new Response(JSON.stringify({ request: { id: 'old-request', connectorId: 'tools', configHash: 'cfg', tool: 'echo', status: 'pending', decisionId: 'old-decision', result: null, error: null } })));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Request action' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('link', { name: 'Review in Decisions' })).toBeNull();
  });

  it('serializes polls and ignores a delayed result after a newer request', async () => {
    const listing: Listing = { descriptors: Object.values(CONNECTOR_DESCRIPTORS), connections: [mcpConnection()], decisions: [] };
    const receipt = (id: string, status = 'pending') => ({ id, connectorId: 'tools', configHash: 'cfg', tool: 'echo', status, decisionId: `decision-${id}`, result: status === 'succeeded' ? { text: 'stale-output', isError: false, truncated: false } : null, error: null });
    let finishOldPoll!: (value: Response) => void;
    const oldPoll = new Promise<Response>(resolve => { finishOldPoll = resolve; });
    let posts = 0, oldPolls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ request: receipt(++posts === 1 ? 'old' : 'new') }));
      if (String(url).endsWith('/tool-requests/old')) { oldPolls += 1; return oldPoll; }
      if (String(url).endsWith('/tool-requests/new')) return new Response(JSON.stringify({ request: receipt('new') }));
      return new Response(JSON.stringify(listing));
    }));
    render(<MemoryRouter><Connectors state={emptyState()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Request action' }));
    await waitFor(() => expect(oldPolls).toBe(1), { timeout: 4000 });
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(oldPolls).toBe(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments (JSON)' }), { target: { value: '{"text":"new"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request action' }));
    await waitFor(() => expect(posts).toBe(2));
    await screen.findByText('request new');
    finishOldPoll(new Response(JSON.stringify({ request: receipt('old', 'succeeded') })));
    await waitFor(() => expect(screen.getByText('request new')).toBeTruthy());
    expect(screen.queryByText('stale-output')).toBeNull();
  }, 10_000);
});
