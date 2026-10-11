// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesignDocument, emptyState, type ControlState, type MockArtifact, type MockRevision } from '@acc/core';
import { DesignPicker } from '../src/components/designer/DesignPicker';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const HASH = 'a'.repeat(64);
const human = { type: 'human', id: 'owner' } as const, agent = { type: 'agent', id: 'codex' } as const;
const now = new Date().toISOString();
const rev = (n: number, extra: Partial<MockRevision>): MockRevision => ({
  rev: n, hash: `h${n}`, entry: 'index.html', files: [{ path: 'index.html', sha256: 's', bytes: 10, kind: 'html' }, { path: 'checks.html', sha256: 't', bytes: 10, kind: 'html' }],
  designRevision: { hash: HASH, version: 1 }, gitSha: null, runId: null, findings: [], exceptions: [], reviews: [], evidence: [], capturedAt: now, by: human, authoredBy: human, origin: 'edit',
  assignmentId: 'asg', workItemId: 'wi', agentId: 'codex', parentRev: null, ...extra,
} as unknown as MockRevision);
const artifact = (id: string, title: string, revisions: MockRevision[]): MockArtifact => ({ id, workItemId: 'wi', assignmentId: 'asg', agentId: 'codex', dir: `design/${id}`, title, revisions, createdAt: now, updatedAt: now });

function state(): ControlState {
  const s = emptyState();
  s.design = { hash: HASH, version: 1, system: {} as never, createdAt: now } as never;
  s.mocks = {
    checks: artifact('checks', 'Release checks', [rev(1, { document: { id: 'doc-1', version: 3, hash: 'd', releaseHash: 'r' }, reviews: [{ decision: 'approved', by: human, at: now, note: '', checklist: [] }, { decision: 'approved', by: agent, at: now, note: '', checklist: [] }] as never })]),
    legacy: artifact('legacy', 'Onboarding mock', [rev(2, { reviews: [{ decision: 'approved', by: human, at: now, note: '', checklist: [] }] as never })]),
  };
  return s;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/designer/releases/checks/1') return new Response(JSON.stringify({ document: createDesignDocument('doc-1', 'Release checks'), source: {} }), { status: 200 });
    if (url.startsWith('/api/mocks/legacy/revisions/2/preview')) return new Response(JSON.stringify({ html: '', shell: null, shellError: null, static: '<p>legacy page</p>', execution: '', pages: ['index.html', 'checks.html'], hash: 'h2', rev: 2, page: 'index.html' }), { status: 200 });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }));
});

describe('Design node picker', () => {
  it('lists finalized mocks apart from unfinished ones and attaches on Use', () => {
    const onPick = vi.fn();
    render(<MemoryRouter><DesignPicker state={state()} value={null} onPick={onPick} onDesign={() => undefined} /></MemoryRouter>);
    const done = screen.getByRole('list', { name: 'Finalized mocks' });
    expect(within(done).getByText('Release checks')).toBeTruthy();
    const pending = screen.getByRole('list', { name: 'Mocks not yet finalized' });
    expect(within(pending).getByText('Onboarding mock')).toBeTruthy();
    expect(within(pending).getByText('Needs independent review')).toBeTruthy();
    fireEvent.click(within(done).getByRole('button', { name: 'Use' }));
    expect(onPick).toHaveBeenCalledWith({ artifactId: 'checks', rev: 1 });
  });

  it('shows a miniature of the attached design release with its screens', async () => {
    render(<MemoryRouter><DesignPicker state={state()} value={{ artifactId: 'checks', rev: 1 }} onPick={() => undefined} onDesign={() => undefined} /></MemoryRouter>);
    const attached = screen.getByLabelText('Attached mock');
    expect(within(attached).getByText('Release checks')).toBeTruthy();
    await waitFor(() => expect(within(attached).getByRole('group', { name: 'Screens' })).toBeTruthy());
    expect(within(attached).getByRole('button', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attached' })).toBeTruthy();
  });

  it('shows a sandboxed static miniature for an HTML mock and warns when its approval does not hold', async () => {
    render(<MemoryRouter><DesignPicker state={state()} value={{ artifactId: 'legacy', rev: 2 }} onPick={() => undefined} onDesign={() => undefined} /></MemoryRouter>);
    const attached = screen.getByLabelText('Attached mock');
    await waitFor(() => expect(within(attached).getByTitle(/miniature/)).toBeTruthy());
    const frame = within(attached).getByTitle(/miniature/) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(within(attached).getByText(/another agent must review|You authored/)).toBeTruthy();
    expect(within(attached).getByRole('group', { name: 'Pages' })).toBeTruthy();
  });
});
