// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_DESCRIPTORS, RELEASE_CONNECTOR_DEFAULTS, emptyState } from '@acc/core';
import { Connectors, type Listing, type View } from '../src/pages/Connectors';
import { ReleaseCockpit } from '../src/pages/ReleaseCockpit';

import { setRemoteSession } from '../src/lib/remote';

// These isolated management fixtures explicitly model a verified local owner.
beforeEach(() => setRemoteSession(null, 'local'));
afterEach(() => setRemoteSession(null, 'checking'));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function connection(patch: Partial<View> = {}): View {
  return { id: 'github-read', name: 'GitHub read', kind: 'github', config: { ...RELEASE_CONNECTOR_DEFAULTS.github, repo: 'owner/repo', scopes: ['repo:read'], binding: { projectRepo: '/fixture/repo', projectName: 'fixture', productionBranch: 'main', configuredHash: 'settings-hash' } }, configHash: 'config-hash', disabled: false,
    approvals: {}, pending: {}, availability: { status: 'not_checked', checkedAt: null, detail: 'Reachability and permissions unknown.' }, createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    state: 'draft', bindingCurrent: true, readCurrent: false, descriptor: CONNECTOR_DESCRIPTORS.github,
    actions: CONNECTOR_DESCRIPTORS.github.actions.map(a => ({ ...a, allowed: false, pending: false })), ...patch };
}
function mock(listing: Listing, mutate?: (url: string, body: Record<string, unknown>) => void) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body ?? '{}')); calls.push({ url, body }); mutate?.(url, body); return new Response('{}'); }
    if (url === '/api/connectors') return new Response(JSON.stringify(listing));
    return new Response('{}', { status: 404 });
  }));
  return calls;
}
const descriptors = Object.values(CONNECTOR_DESCRIPTORS);

describe('release connector UI', () => {
  it('offers all provider drafts, primary capability links and Settings target editing', async () => {
    const calls = mock({ descriptors, connections: [], decisions: [], defaults: { github: { ...RELEASE_CONNECTOR_DEFAULTS.github, repo: 'owner/repo', scopes: ['repo:read'] } } });
    render(<MemoryRouter><Connectors state={emptyState()} /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Add GitHub release reads' });
    expect(screen.getByRole('button', { name: 'Add GitLab release reads' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Vercel deployment reads' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Supabase migration reads' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Settings & policies' }).every(a => a.getAttribute('href') === '/settings')).toBe(true);
    expect(screen.getByRole('link', { name: 'Branch protection permissions' }).getAttribute('href')).toContain('docs.github.com');
    fireEvent.click(screen.getByRole('button', { name: 'Add GitHub release reads' }));
    expect((screen.getByRole('textbox', { name: 'API host' }) as HTMLInputElement).value).toBe('api.github.com');
    expect((screen.getByRole('textbox', { name: 'Reviewed token scopes' }) as HTMLInputElement).value).toBe('repo:read');
    fireEvent.change(screen.getByRole('textbox', { name: 'Connection ID' }), { target: { value: 'github-read' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Release GitHub' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: '/api/connectors/github-read', body: { expected: null, connection: { config: { kind: 'github', repo: 'owner/repo', host: 'api.github.com', scopes: ['repo:read'] } } } });
    expect(calls.some(c => c.url.endsWith('/read') || c.url.endsWith('/activate'))).toBe(false);
  });

  it('requests a read Decision from the cockpit without approving or probing it', async () => {
    const listing: Listing = { descriptors, connections: [connection()], decisions: [] };
    const calls = mock(listing, url => { if (url.endsWith('/activate')) listing.connections[0] = connection({ state: 'pending', actions: CONNECTOR_DESCRIPTORS.github.actions.map(a => ({ ...a, allowed: false, pending: true })) }); });
    render(<MemoryRouter><ReleaseCockpit state={emptyState()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Request github read Decision' }));
    await screen.findByRole('link', { name: 'Review read Decision' });
    expect(calls).toEqual([{ url: '/api/connectors/github-read/activate', body: { action: 'read' } }]);
    expect(screen.getByRole('link', { name: 'Settings & policies' }).getAttribute('href')).toBe('/settings');
    expect(screen.getAllByText(/unknown until explicitly read/)).toHaveLength(1);
  });

  it('shows stale live evidence as unknown and disables stale connector reads', async () => {
    const c = connection({ state: 'draft', bindingCurrent: false });
    mock({ descriptors, connections: [c], decisions: [] });
    const state = emptyState();
    state.codeHost = { provider: 'github', source: 'live', checkedAt: '2026-10-07T00:00:00Z', productionBranch: 'main', protected: true, protectionDetail: 'old green protection', checks: [{ name: 'old green CI', status: 'passed', sha: 'old-sha', detail: 'old' }], pulls: [], error: null, delivery: { registered: false, pollSeconds: 60, webhook: 'off', lastDeliveryAt: null } };
    render(<MemoryRouter><ReleaseCockpit state={state} /></MemoryRouter>);
    await screen.findByText('settings changed');
    expect((screen.getByRole('button', { name: 'Request github read Decision' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('old green protection')).toBeNull();
    expect(screen.getByText(/Live code-host evidence needs a fresh approved read/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Read github now' })).toBeNull();
  });

  it('uses the canonical DecisionCard prepare+answer flow and leaves a provider probe explicit', async () => {
    const c = connection({ state: 'pending' });
    const listing: Listing = { descriptors, connections: [c], decisions: [{ id: 'read-decision', question: 'Read exact host and scopes?', options: ['approve', 'deny'], confirmOptions: ['approve'], recommendation: null, evidenceLinks: [], urgency: 'normal', irreversible: false, answer: null, answeredAt: null, channel: null, createdAt: '2026-10-07T00:00:00Z', kind: 'connector' }] };
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      if (url === '/api/connectors') return new Response(JSON.stringify(listing));
      if (url.endsWith('/prepare')) return new Response(JSON.stringify({ confirm: true, nonce: 'one-use', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      if (url.endsWith('/answer')) return new Response(JSON.stringify({ connection: { state: 'active' } }));
      return new Response('{}', { status: 404 });
    }));
    render(<MemoryRouter><Connectors state={emptyState()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'approve…' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Yes, approve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(calls.some(x => x.url.endsWith('/prepare'))).toBe(true));
    expect(calls.find(x => x.url.endsWith('/answer'))).toMatchObject({ body: { channel: 'web', answer: 'approve', nonce: 'one-use' } });
    expect(calls.some(x => x.url.endsWith('/read'))).toBe(false);
  });
});
