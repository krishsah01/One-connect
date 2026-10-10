// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type Decision } from '@acc/core';
import { DecisionCard } from '../src/pages/Decisions';
import { clearPhoneAuthority, setRemoteSession } from '../src/lib/remote';

const json = (value: unknown) => new Response(JSON.stringify(value));
const decision = (): Decision => ({
  id: 'call-decision', question: 'Run fixture echo?', options: ['approve', 'deny'],
  recommendation: null, evidenceLinks: [], urgency: 'normal', irreversible: true,
  confirmOptions: ['approve'], answer: null, answeredAt: null, channel: null,
  createdAt: new Date().toISOString(), kind: 'question',
  action: { kind: 'connector_tool', connectorId: 'fixture', tool: 'echo', hash: 'bound-action' },
  evidence: [
    { label: 'Command', detail: '/fixture/bin/server --stdio', ok: null },
    { label: 'Arguments', detail: '{"items":[{"text":"review these bytes"}]}', ok: null },
    { label: 'Boundary', detail: 'Program filesystem and network access are not mediated.', ok: null },
  ],
});

beforeEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  setRemoteSession({ id: 'phone', label: 'Phone', scopes: ['read', 'decisions'], expiresAt: '2099-01-01T00:00:00Z', csrf: 'fixture', project: 'fixture-project' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearPhoneAuthority('checking'); });

function fixture(status: string, override: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
    if (String(url).endsWith('/prepare')) return json({ confirm: true, nonce: 'fresh-nonce', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (String(url).endsWith('/answer')) return json({ tool: { request: { connectorId: 'fixture', tool: 'echo', decisionId: 'call-decision', status, ...override }, executed: status !== 'denied' } });
    return json({});
  }));
  const d = decision();
  const state = emptyState(); state.decisions[d.id] = d;
  render(<MemoryRouter><DecisionCard d={d} state={state} now={Date.now()} /></MemoryRouter>);
  return calls;
}

describe('exact plugin Decision confirmation', () => {
  it('keeps command, exact arguments and program boundary visible at the final confirmation', async () => {
    const calls = fixture('succeeded');
    fireEvent.click(screen.getByRole('button', { name: /^approve/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('/fixture/bin/server --stdio', { exact: false })).toBeTruthy();
    expect(within(dialog).getByText('{"items":[{"text":"review these bytes"}]}', { exact: false })).toBeTruthy();
    expect(within(dialog).getByText(/filesystem and network access are not mediated/)).toBeTruthy();
    expect(calls.filter(c => c.url.endsWith('/answer'))).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, approve' }));
    await screen.findByText('Plugin tool finished. View its recorded output in Connectors.');
    expect(calls.filter(c => c.url.endsWith('/answer')).map(c => c.body)).toEqual([{ answer: 'approve', nonce: 'fresh-nonce', channel: 'web' }]);
  });

  it.each([
    ['uncertain', 'Plugin action may have run. Inspect its result before requesting anything again.'],
    ['error', 'Plugin action reported an error. Inspect its result in Connectors.'],
    ['denied', 'Plugin action denied. Nothing was invoked.'],
    ['expired', 'Plugin request expired. Nothing was invoked.'],
    ['invalidated', 'Plugin request is no longer valid. Nothing was invoked.'],
    ['__proto__', 'Plugin action returned an unknown status. Inspect its result in Connectors.'],
  ])('reports %s without implying completion or retrying', async (status, message) => {
    const calls = fixture(status);
    fireEvent.click(screen.getByRole('button', { name: /^approve/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, approve' }));
    await screen.findByText(message);
    expect(calls.filter(c => c.url.endsWith('/answer'))).toHaveLength(1);
    expect(screen.queryByText('Plugin tool finished. View its recorded output in Connectors.')).toBeNull();
  });

  it('rejects an outcome from another Decision instead of showing success', async () => {
    fixture('succeeded', { decisionId: 'different-decision' });
    fireEvent.click(screen.getByRole('button', { name: /^approve/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(screen.getByText('Plugin response does not match this Decision. Inspect its audit history.')).toBeTruthy());
    expect(screen.queryByText('Plugin tool finished. View its recorded output in Connectors.')).toBeNull();
  });
});
