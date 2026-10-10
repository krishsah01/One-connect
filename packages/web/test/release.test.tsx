// SPDX-License-Identifier: Apache-2.0
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEvent, emptyState, type EventEnvelope, type ReleasePlan } from '@acc/core';
import { MissionControl } from '../src/pages/MissionControl';
import { ReleaseCockpit } from '../src/pages/ReleaseCockpit';

afterEach(() => cleanup());

let seq = 0;
const ev = (type: string, data: unknown): EventEnvelope =>
  ({ seq: ++seq, id: `e${seq}`, ts: '2026-10-07T00:00:00.000Z', type, kind: 'control', actor: { type: 'human', id: 'owner' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data }) as EventEnvelope;

const plan: ReleasePlan = {
  id: 'plan_1',
  name: 'Wednesday',
  status: 'active',
  productionBranch: 'main',
  sha: null,
  workItemId: null,
  mergeId: null,
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
  steps: [
    { id: 'step_push', order: 0, kind: 'push', title: 'Push', owner: 'owner', target: 'main', environment: 'unconfigured', command: 'git push origin main', check: 'main is protected', rollback: 'Do not force-push.', decisionId: null, approval: 'pending', status: 'pending', evidence: null, checkedAt: null },
    { id: 'step_ci', order: 1, kind: 'ci', title: 'CI green', owner: 'owner', target: 'sha', environment: 'unconfigured', command: 'required checks', check: 'checks passed', rollback: 'Do not deploy.', decisionId: null, approval: 'pending', status: 'pending', evidence: null, checkedAt: null },
  ],
};

function state() {
  let s = emptyState();
  s = applyEvent(s, ev('release.saved', { plan }));
  s = applyEvent(s, ev('code_host.checked', { snapshot: { provider: 'github', checkedAt: '2026-10-07T00:00:00.000Z', source: 'fixture', productionBranch: 'main', protected: false, protectionDetail: 'main is not protected.', pulls: [], checks: [], error: null, delivery: { registered: false, pollSeconds: 60, webhook: 'off', lastDeliveryAt: null } } }));
  s = applyEvent(s, ev('infra.checked', { health: {
    checkedAt: '2026-10-07T00:00:00.000Z',
    docker: { state: 'degraded', detail: 'A project service is unhealthy or paused.' },
    postgres: { state: 'paused', service: 'db', detail: 'Database service db is paused.' },
    vercel: { state: 'unchecked', detail: 'Vercel is not configured. Real-provider validation is pending.', source: 'unconfigured' },
    migrations: { state: 'unchecked', source: 'none', repo: [], applied: [], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: 'Migration history was not read, so drift is unchecked.' },
  } }));
  return s;
}

describe('Release cockpit', () => {
  it('shows ordered steps and does not offer a way to skip ahead', () => {
    render(<MemoryRouter><ReleaseCockpit state={state()} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Release cockpit' })).toBeTruthy();
    expect(screen.getByText('1. Push')).toBeTruthy();
    expect(screen.getByText('2. CI green')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Approve this step' })).toHaveLength(1);
    expect(screen.getByText(/cannot be skipped/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
    expect(screen.getByText('main is not protected.')).toBeTruthy();
  });

  it('shows unprotected branch and a paused database as attention, not healthy', () => {
    render(<MemoryRouter><MissionControl state={state()} /></MemoryRouter>);
    expect(screen.getByText('unprotected')).toBeTruthy();
    expect(screen.getByText('database paused')).toBeTruthy();
    expect(screen.queryByText('database ready')).toBeNull();
    expect(screen.getByText(/Database service db is paused/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Cockpit' })).toBeTruthy();
  });
});
