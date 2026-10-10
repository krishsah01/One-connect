// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyState, parseConfig, type ControlState, type EventEnvelope } from '@acc/core';
import { Transcript } from '../src/components/Transcript';
import { MissionControl } from '../src/pages/MissionControl';
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
const ev = (type: string, data: unknown, refs: Partial<EventEnvelope> = {}): EventEnvelope =>
  ({ seq: ++seq, id: `e${seq}`, ts: new Date().toISOString(), type, kind: type.startsWith('t.') ? 'transcript' : 'control', actor: { type: 'system', id: 't' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data, ...refs }) as EventEnvelope;

function state(): ControlState {
  const cfg = parseConfig({
    project: { name: 'demo', repo: '/r' },
    agents: [
      { id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' },
      { id: 'lead', name: 'Claude Code', role: 'lead', adapter: 'claude-headless', mode: 'coordinator-only' },
    ],
  });
  let s = emptyState();
  for (const e of [
    ev('config.loaded', { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies }),
    ev('agent.registered', { config: cfg.agents[0] }),
    ev('agent.registered', { config: cfg.agents[1] }),
    ev('agent.probed', { auth: { state: 'logged_in' }, billing: { mode: 'subscription', source: 'codex login status', overage: 'unknown' }, binary: null, binaryCandidates: [], models: [{ id: 'gpt-6-astra' }], newest: 'gpt-6-astra', usage: { windows: [{ name: '5h window', usedPercent: 45, resetsAt: null }], status: 'ok', checkedAt: '', source: 'test' } }, { agentId: 'codex' }),
    ev('approval.requested', { approval: { id: 'ap1', runId: 'r1', agentId: 'codex', workItemId: null, kind: 'ask_human', title: 'Keep the old flag?', detail: '', options: ['yes', 'no'], createdAt: new Date().toISOString(), resolvedAt: null, decision: null, by: null, channel: null } }),
    ev('alert.raised', { alert: { id: 'al1', kind: 'stall', severity: 'critical', message: 'Codex has produced no events for 12 min', dedupeKey: 'x', createdAt: new Date().toISOString(), resolvedAt: null, resolution: null, suggestion: { kind: 'reassign', agentIds: ['lead'] } } }),
  ])
    s = applyEvent(s, e);
  return s;
}

describe('Mission Control', () => {
  it('shows agent cards, the approval inbox, alerts with suggestions and honest placeholders', () => {
    render(
      <MemoryRouter>
        <MissionControl state={state()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Codex' })).toBeTruthy();
    expect(screen.getByText('lead · coordinator')).toBeTruthy();
    expect(screen.getByText('Keep the old flag?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'yes' })).toBeTruthy();
    expect(screen.getByText('Codex has produced no events for 12 min')).toBeTruthy();
    expect(screen.getByText(/Reassign to: Claude Code/)).toBeTruthy();
    expect(screen.getByText('5h window')).toBeTruthy();
    expect(screen.getAllByText('included plan').length).toBeGreaterThan(0);
    expect(screen.getByText(/Nothing here is reported as healthy until an adapter actually checks it/)).toBeTruthy();
    expect(screen.getByText(/openai subscription/)).toBeTruthy();
  });
});

describe('Decisions', () => {
  it('shows evidence, risk and a second confirmation for irreversible merge decisions; Jev is advice only', async () => {
    let s = state();
    s = applyEvent(s, ev('decision.created', {
      decision: {
        id: 'dec-merge',
        question: 'Merge LOC-1 into integration?',
        options: ['merge', 'reject'],
        recommendation: 'merge',
        evidenceLinks: [],
        urgency: 'high',
        irreversible: true,
        answer: null,
        answeredAt: null,
        channel: null,
        createdAt: new Date().toISOString(),
        kind: 'merge',
        workItemId: 'wi1',
        risk: 'medium',
        confirmOptions: ['merge'],
        action: { kind: 'merge', workItemId: 'wi1', sourceBranch: 'claude/LOC-1', sourceSha: 'a'.repeat(40), target: 'integration', targetSha: 'b'.repeat(40), reviewId: 'rev1', hash: 'h1' },
        evidence: [{ label: 'Review', detail: 'Codex approved', ok: true }, { label: 'Scope', detail: 'local merge only; nothing is pushed', ok: null }],
        recommendedBy: null,
        rationale: null,
        answeredBy: null,
        confirmedAt: null,
        consumedAt: null,
        outcome: null,
        expiresAt: null,
      },
    }));
    s = applyEvent(s, ev('decision.recommended', { decisionId: 'dec-merge', recommendation: 'merge', rationale: 'checks are green' }, { actor: { type: 'agent', id: 'jev' } }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ confirm: true, nonce: 'test-nonce', expiresAt: new Date(Date.now() + 60_000).toISOString() }) }));
    render(<MemoryRouter><Decisions state={s} /></MemoryRouter>);
    expect(screen.getByText('Merge LOC-1 into integration?')).toBeTruthy();
    expect(screen.getByText(/Codex approved/)).toBeTruthy();
    expect(screen.getByText(/recommendation, not an approval/)).toBeTruthy();
    expect(screen.getByText('irreversible')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'merge…' }));
    await waitFor(() => expect(screen.getByRole('alertdialog', { name: 'Confirm' })).toBeTruthy());
    expect(screen.getByText(/Local merge only/)).toBeTruthy();
  });
});

describe('Transcript', () => {
  it('renders structured events and filters them', () => {
    const events = [
      ev('t.message', { role: 'assistant', text: 'Working on it' }, { runId: 'r1' }),
      ev('t.command', { command: 'npm test', status: 'failed', exitCode: 1, output: 'boom' }, { runId: 'r1' }),
      ev('t.file_edit', { path: 'src/a.ts', change: 'modify' }, { runId: 'r1' }),
      ev('t.error', { message: 'connection timed out', failure: 'network' }, { runId: 'r1' }),
    ];
    render(<Transcript events={events} />);
    expect(screen.getByText('Working on it')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'errors' }));
    expect(screen.queryByText('Working on it')).toBeNull();
    expect(screen.getByText(/connection timed out/)).toBeTruthy();
    expect(screen.getByText(/npm test/)).toBeTruthy();
  });
});
