// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CONNECTOR_DESCRIPTORS, RELEASE_CONNECTOR_DEFAULTS, defaultReleaseSteps, emptyState, type ControlState, type ReleasePlan } from '@acc/core';
import { ReleaseCockpit } from '../src/pages/ReleaseCockpit';

import { setRemoteSession } from '../src/lib/remote';

// These isolated management fixtures explicitly model a verified local owner.
beforeEach(() => setRemoteSession(null, 'local'));
afterEach(() => setRemoteSession(null, 'checking'));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const state = emptyState();
  const sha = 'a'.repeat(40);
  const plan: ReleasePlan = { id: 'release', name: 'Release', status: 'active', sha, productionBranch: 'main', workItemId: 'work', mergeId: 'merge', createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', steps: defaultReleaseSteps('main', sha, 'fixture').map(s => ({ ...s, id: s.kind, decisionId: null, approval: 'pending', status: 'pending', evidence: null, checkedAt: null })) };
  state.releases[plan.id] = plan;
  return { state, plan };
}
function mock() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const result = url.endsWith('/decision') ? { decision: { id: 'fresh' } } : url.endsWith('/prepare') ? { confirm: true, nonce: 'one-use' } : url === '/api/release/plans' ? { plan: { id: 'new-plan' } } : {};
      return new Response(JSON.stringify(result));
    }
    return new Response(JSON.stringify({ connections: [], decisions: [], descriptors: Object.values(CONNECTOR_DESCRIPTORS) }));
  }));
  return calls;
}
const show = (state: ControlState) => render(<MemoryRouter><ReleaseCockpit state={state} /></MemoryRouter>);

it('binds new plans to a selectable recorded merge through the actual creation route', async () => {
  const { state, plan } = fixture();
  // Minimal read-only display fixture for the work item; the daemon validates the binding.
  state.workItems.work = { id: 'work', title: 'Ship fixture', key: 'LOC-1', state: 'merged', labels: [], sync: { status: 'synced' } } as unknown as ControlState['workItems'][string];
  state.merges.merge = { id: 'merge', workItemId: 'work', mergeSha: plan.sha!, postChecks: { status: 'passed' } } as ControlState['merges'][string];
  const calls = mock(); show(state);
  expect((screen.getByRole('button', { name: 'New release plan' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox', { name: 'Release work item' }), { target: { value: 'work' } });
  fireEvent.click(screen.getByRole('button', { name: 'New release plan' }));
  await waitFor(() => expect(calls).toEqual([{ url: '/api/release/plans', body: { name: 'Release', workItemId: 'work' } }]));
});
it('blocks approval of unsaved edits, saves the rollback verifier, and opens a fresh bound Decision rather than reusing an answered one', async () => {
  const { state, plan } = fixture();
  plan.steps = [{ ...plan.steps[4], order: 0, decisionId: 'already-used', status: 'failed', evidence: { ok: false, summary: 'fixture failed' } }];
  const calls = mock(); show(state);
  fireEvent.change(screen.getByRole('textbox', { name: 'Backup rollback check' }), { target: { value: 'check:restore_probe' } });
  expect((screen.getByRole('button', { name: 'Approve this step' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Save these edits/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect((calls[0].body.steps as Record<string, unknown>[])[0].rollbackCheck).toBe('check:restore_probe');
  cleanup(); mock(); show(state);
  fireEvent.click(screen.getByRole('button', { name: 'Approve this step' }));
  await screen.findByRole('button', { name: 'Confirm approve' });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm approve' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/decisions/fresh/answer', expect.any(Object)));
  const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url);
  expect(urls).toContain('/api/release/plans/release/steps/backup/decision');
  expect(urls.some(url => String(url).includes('already-used'))).toBe(false);
});
it('freezes the whole uncertain plan and keeps a verified rollback visibly failed', async () => {
  const { state, plan } = fixture();
  plan.steps[0] = { ...plan.steps[0], status: 'uncertain', evidence: { ok: null, summary: 'interrupted' } };
  mock(); show(state);
  expect((screen.getByRole('button', { name: 'Save plan' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('textbox', { name: 'CI green command' }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Approve this step' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Review inspection in Decisions' })).toBeTruthy();
  cleanup();
  plan.steps = [{ ...plan.steps[4], order: 0, status: 'failed', evidence: { ok: true, summary: 'Rollback ran and restored fixture' } }];
  show(state);
  expect(screen.getByText('failed')).toBeTruthy();
  expect(screen.queryByText('verified')).toBeNull();
});
it('does not label configured device command acceptance as human attestation', () => {
  const { state, plan } = fixture();
  plan.steps = [{ ...plan.steps.at(-1)!, order: 0 }];
  mock(); show(state);
  expect(screen.queryByText('human attestation')).toBeNull();
  expect(screen.getByText(/Human attestation cannot pass device QA/)).toBeTruthy();
});
it('retained live branch protection cannot borrow approval of checks-only reads', async () => {
  const { state } = fixture();
  state.codeHost = { source: 'live', provider: 'github', checkedAt: '2026-10-07T00:00:00Z', productionBranch: 'main', protected: false, protectionDetail: 'stale branch failure', checks: [{ name: 'unit', sha: 'a'.repeat(40), status: 'failed', detail: 'fixture failure' }], pulls: [], error: null, delivery: { registered: false, pollSeconds: 60, webhook: 'off', lastDeliveryAt: null } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ connections: [{ id: 'checks', name: 'Checks only', kind: 'github', config: { ...RELEASE_CONNECTOR_DEFAULTS.github, capabilities: ['checks:read'] }, state: 'active', availability: { status: 'available', detail: 'injected fixture' }, readCurrent: true, actions: [{ id: 'read', allowed: true }] }] }))));
  show(state);
  await screen.findByText('Checks only');
  expect(screen.getByRole('button', { name: 'Create issue for failing CI' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create issue for unprotected branch' })).toBeNull();
  expect(screen.queryByText('stale branch failure')).toBeNull();
});
