// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyState, parseConfig, type ControlState, type EventEnvelope, type NotificationRecord } from '@acc/core';
import { api, ApiError } from '../src/lib/api';
import { NotificationInbox, notificationDestination } from '../src/components/NotificationInbox';
import {
  can,
  canMutate,
  clearPhoneAuthority,
  displaySession,
  identityRevision,
  loadRemoteSession,
  remoteMode,
  setRemoteSession,
} from '../src/lib/remote';
import { live, testIngestEvents, testLivePreview, testWatchRun } from '../src/lib/store';
import { DecisionCard, isOpenDecision } from '../src/pages/Decisions';
import { Phone } from '../src/pages/Phone';
import { Remote } from '../src/pages/Remote';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const session = { id: 's1', label: 'Phone', scopes: ['read', 'decisions', 'transcript'], expiresAt: '2099-01-01T00:00:00.000Z', csrf: 'csrf', project: 'harbor' };

const { desktopRequest } = vi.hoisted(() => ({ desktopRequest: vi.fn() }));

vi.mock('../src/lib/desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/desktop')>();
  return {
    ...actual,
    isDesktop: false,
    desktopRequest,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearPhoneAuthority('checking');
  live.state = null;
  live.liveText.clear();
  live.dropRunCaches();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('remote identity', () => {
  it('starts checking then becomes local on exact 403', async () => {
    expect(remoteMode()).toBe('checking');
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Not a phone session' }, 403)));
    await loadRemoteSession();
    expect(remoteMode()).toBe('local');
    expect(displaySession()).toBeNull();
    expect(can(null, 'decisions')).toBe(true);
    expect(canMutate(null, 'decisions')).toBe(true);
  });

  it('becomes paired on ok session with validated shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(session)));
    await loadRemoteSession();
    expect(remoteMode()).toBe('paired');
    expect(displaySession()?.label).toBe('Phone');
    expect(can(session, 'decisions')).toBe(true);
    expect(can(session, 'kill_switch')).toBe(false);
  });

  it('rejects malformed paired 200 as unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'x' })));
    await loadRemoteSession();
    expect(remoteMode()).toBe('unauthorized');
    expect(canMutate(null, 'decisions')).toBe(false);
  });

  it('setRemoteSession(null) defaults to unauthorized, not local', () => {
    setRemoteSession(null);
    expect(remoteMode()).toBe('unauthorized');
    expect(canMutate(null, 'decisions')).toBe(false);
  });

  it('keeps confirmation binding stable on an unchanged identity refresh', async () => {
    const rev0 = identityRevision();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Not a phone session' }, 403)));
    await loadRemoteSession();
    const verified = identityRevision();
    await loadRemoteSession();
    expect(identityRevision()).toBeGreaterThan(rev0);
    expect(identityRevision()).toBe(verified);
    expect(remoteMode()).toBe('local');
  });

  it('preserves last paired identity offline without mutation authority', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(session)));
    await loadRemoteSession();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    await loadRemoteSession();
    expect(remoteMode()).toBe('offline');
    expect(displaySession()?.scopes).toContain('decisions');
    expect(can(displaySession(), 'decisions')).toBe(true);
    expect(canMutate(displaySession(), 'decisions')).toBe(false);
  });

  it('clears cached grants on unauthorized after pairing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(session)));
    await loadRemoteSession();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'revoked' }, 401)));
    await loadRemoteSession();
    expect(remoteMode()).toBe('unauthorized');
    expect(displaySession()).toBeNull();
    expect(can(null, 'decisions')).toBe(false);
  });

  it('classifies non-403 failures as unauthorized, not local', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'expired' }, 401)));
    await loadRemoteSession();
    expect(remoteMode()).toBe('unauthorized');
    expect(canMutate(null, 'decisions')).toBe(false);
  });

  it('discards stale identity responses after clear while pending', async () => {
    let resolve!: (v: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const pending = loadRemoteSession();
    clearPhoneAuthority('unauthorized');
    resolve(json(session));
    await pending;
    expect(remoteMode()).toBe('unauthorized');
    expect(displaySession()).toBeNull();
  });

  it('discards older paired response after newer unauthorized', async () => {
    let slow!: () => void;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((r) => { slow = () => r(json(session)); }))
      .mockImplementationOnce(async () => json({ error: 'revoked' }, 401)));
    const slowLoad = loadRemoteSession();
    clearPhoneAuthority('checking');
    await loadRemoteSession();
    expect(remoteMode()).toBe('unauthorized');
    slow();
    await slowLoad;
    expect(remoteMode()).toBe('unauthorized');
  });

  it('invalidates authority when paired scopes narrow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(session)));
    await loadRemoteSession();
    const rev = identityRevision();
    setRemoteSession({ ...session, scopes: ['read'] });
    expect(identityRevision()).toBeGreaterThan(rev);
    expect(canMutate({ ...session, scopes: ['read'] }, 'decisions')).toBe(false);
  });
});

describe('native desktop identity', () => {
  const loadNativeRemote = async () => {
    vi.resetModules();
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    vi.doMock('../src/lib/desktop', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/lib/desktop')>();
      return { ...actual, isDesktop: true, desktopRequest };
    });
    const remote = await import('../src/lib/remote');
    remote.clearPhoneAuthority('checking');
    return remote;
  };

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    desktopRequest.mockReset();
    vi.doUnmock('../src/lib/desktop');
    vi.resetModules();
  });

  it('proves local mode via /api/auth/identity on native Mac', async () => {
    desktopRequest.mockResolvedValue({ mode: 'local', project: 'harbor' });
    const remote = await loadNativeRemote();
    await remote.loadRemoteSession();
    expect(desktopRequest).toHaveBeenCalledWith('/api/auth/identity', {});
    expect(remote.remoteMode()).toBe('local');
    expect(remote.canMutate(null, 'decisions')).toBe(true);
  });

  it('treats malformed native identity as unauthorized', async () => {
    desktopRequest.mockResolvedValue({ mode: 'paired' });
    const remote = await loadNativeRemote();
    await remote.loadRemoteSession();
    expect(remote.remoteMode()).toBe('unauthorized');
  });

  it('treats failed native bridge as offline without granting local authority', async () => {
    desktopRequest.mockRejectedValue(new Error('bridge down'));
    const remote = await loadNativeRemote();
    await remote.loadRemoteSession();
    expect(remote.remoteMode()).toBe('offline');
    expect(remote.canMutate(null, 'decisions')).toBe(false);
  });
});

describe('api mutation receipt', () => {
  it('reports uncertain receipt on transport failure after a mutating request', async () => {
    setRemoteSession(session);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('lost'); }));
    await expect(api('/api/decisions/x/answer', { method: 'POST', body: {} })).rejects.toMatchObject({
      message: /Receipt is unknown/i,
      status: 0,
    });
  });

  it('blocks mutation before transport without authority', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    clearPhoneAuthority('unauthorized');
    await expect(api('/api/decisions/x/answer', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403 });
    expect(f).not.toHaveBeenCalled();
  });

  it('allows pairing endpoint without general mutation authority', async () => {
    clearPhoneAuthority('unauthorized');
    vi.stubGlobal('fetch', vi.fn(async () => json({ url: 'https://x', expiresAt: '2099' })));
    await expect(api('/api/remote/pair', { method: 'POST', body: {} })).resolves.toBeTruthy();
  });

  it('blocks creation of a pairing link before verified owner identity', async () => {
    clearPhoneAuthority('unauthorized');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(api('/api/remote/pairings', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403 });
    expect(f).not.toHaveBeenCalled();
  });

  it('refreshes identity on 401 without retrying the mutation', async () => {
    setRemoteSession(session);
    const f = vi.fn()
      .mockResolvedValueOnce(json({ error: 'gone' }, 401))
      .mockResolvedValueOnce(json(session));
    vi.stubGlobal('fetch', f);
    await expect(api('/api/decisions/x/answer', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(f.mock.calls[1][0]).toBe('/api/remote/session');
  });
});

describe('notification destinations', () => {
  const n = (refs: Partial<NotificationRecord['refs']>): NotificationRecord => ({
    id: 'n1', at: new Date().toISOString(), kind: 'stalled_run', severity: 'warn', title: 't', detail: 'd', dedupeKey: 'k1', routed: [], refs: { decisionId: null, approvalId: null, runId: null, agentId: null, ...refs }, held: [], ackedAt: null,
  });

  it('hides management links for paired phones without scope', () => {
    const s = { ...session, scopes: ['read'] };
    expect(notificationDestination(n({ decisionId: 'd1' }), s, 'paired')).toBeNull();
    expect(notificationDestination(n({ runId: 'r1' }), s, 'paired')).toBeNull();
    expect(notificationDestination(n({ agentId: 'a1' }), s, 'paired')).toBeNull();
  });

  it('allows scoped destinations and local agent consoles only on local mode', () => {
    expect(notificationDestination(n({ decisionId: 'd1' }), session, 'paired')).toBe('/decisions');
    expect(notificationDestination(n({ runId: 'r1' }), session, 'paired')).toBe('/runs/r1');
    expect(notificationDestination(n({ agentId: 'a1' }), null, 'local')).toBe('/agents/a1');
    expect(notificationDestination(n({ agentId: 'a1' }), session, 'paired')).toBeNull();
    expect(notificationDestination(n({ decisionId: 'd1' }), session, 'offline')).toBe('/decisions');
    expect(notificationDestination(n({ decisionId: 'd1' }), null, 'checking')).toBeNull();
  });

  it('disables mark read while checking', async () => {
    clearPhoneAuthority('checking');
    vi.stubGlobal('fetch', vi.fn(async () => json({ notifications: [{ ...n({ decisionId: 'd1' }), ackedAt: null }] })));
    render(<NotificationInbox limit={4} />);
    await screen.findByText('t');
    expect((screen.getByRole('button', { name: 'Mark read' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('live transcript cache', () => {
  beforeEach(() => {
    setRemoteSession(session);
    const cfg = parseConfig({ project: { name: 'harbor', repo: '/r' }, agents: [{ id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' }] });
    let s = emptyState();
    s = applyEvent(s, { seq: 1, id: 'e1', ts: new Date().toISOString(), type: 'config.loaded', kind: 'control', actor: { type: 'system', id: 't' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data: { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies } });
    live.state = s;
    testWatchRun('run1');
  });

  it('retires assistant preview when a newer final message lands', () => {
    testLivePreview('run1', 'assistant', 'streaming text', '2026-10-07T12:00:00.000Z');
    expect(live.liveFor('run1')?.assistant).toBe('streaming text');
    testIngestEvents([{
      seq: 2, id: 'e2', ts: '2026-10-07T12:00:01.000Z', type: 't.message', kind: 'transcript',
      actor: { type: 'agent', id: 'codex' }, agentId: 'codex', runId: 'run1', workItemId: null, assignmentId: null,
      data: { role: 'assistant', text: 'final answer' },
    }]);
    expect(live.liveFor('run1')).toBeNull();
  });

  it('keeps a newer preview when older history replays', () => {
    testLivePreview('run1', 'assistant', 'newer live', '2026-10-07T12:00:05.000Z');
    testIngestEvents([{
      seq: 3, id: 'e3', ts: '2026-10-07T12:00:01.000Z', type: 't.message', kind: 'transcript',
      actor: { type: 'agent', id: 'codex' }, agentId: 'codex', runId: 'run1', workItemId: null, assignmentId: null,
      data: { role: 'assistant', text: 'older final' },
    }]);
    expect(live.liveFor('run1')?.assistant).toBe('newer live');
  });

  it('clears preview and project state on phone authority loss', async () => {
    testLivePreview('run1', 'assistant', 'live', new Date().toISOString());
    clearPhoneAuthority('unauthorized');
    expect(live.liveFor('run1')).toBeNull();
    expect(live.state).toBeNull();
  });

  it('ignores live tokens after authority loss', () => {
    clearPhoneAuthority('unauthorized');
    testLivePreview('run1', 'assistant', 'should not stick', new Date().toISOString());
    expect(live.liveFor('run1')).toBeNull();
  });
});

describe('Decision confirmation invalidation', () => {
  const baseState = () => {
    const cfg = parseConfig({ project: { name: 'harbor', repo: '/r' }, agents: [{ id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' }] });
    let s = emptyState();
    s = applyEvent(s, { seq: 1, id: 'e1', ts: new Date().toISOString(), type: 'config.loaded', kind: 'control', actor: { type: 'system', id: 't' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data: { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies } });
    s.decisions.d1 = { id: 'd1', question: 'Approve?', options: ['approve', 'deny'], recommendation: null, evidenceLinks: [], urgency: 'normal', irreversible: true, confirmOptions: ['approve'], answer: null, answeredAt: null, channel: null, createdAt: new Date().toISOString(), kind: 'question', action: { kind: 'settings', repo: '/r', hash: 'h1' } };
    return s;
  };

  it('clears prepared confirmation on offline transition', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.endsWith('/prepare')) return json({ confirm: true, nonce: 'n1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return json({});
    }));
    setRemoteSession(session);
    const s = baseState();
    const view = render(<DecisionCard d={s.decisions.d1} state={s} now={Date.now()} />);
    fireEvent.click(screen.getByRole('button', { name: /^approve/ }));
    await screen.findByRole('alertdialog');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    view.rerender(<DecisionCard d={s.decisions.d1} state={s} now={Date.now()} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('drops deferred prepare when scope narrows before response', async () => {
    let resolve!: (v: Response) => void;
    vi.stubGlobal('fetch', vi.fn((u: string) => {
      if (u.endsWith('/prepare')) return new Promise<Response>((r) => { resolve = r; });
      return json({});
    }));
    setRemoteSession(session);
    const s = baseState();
    render(<DecisionCard d={s.decisions.d1} state={s} now={Date.now()} />);
    fireEvent.click(screen.getByRole('button', { name: /^approve/ }));
    setRemoteSession({ ...session, scopes: ['read'] });
    resolve(json({ confirm: true, nonce: 'n1', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await waitFor(() => expect(resolve).toBeTruthy());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('clears confirmation when action hash changes under paired mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.endsWith('/prepare')) return json({ confirm: true, nonce: 'n1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return json({});
    }));
    setRemoteSession(session);
    const s = baseState();
    const view = render(<DecisionCard d={s.decisions.d1} state={s} now={Date.now()} />);
    fireEvent.click(screen.getByRole('button', { name: /^approve/ }));
    await screen.findByRole('alertdialog');
    s.decisions.d1 = { ...s.decisions.d1, action: { kind: 'settings', repo: '/r', hash: 'h2' } };
    view.rerender(<DecisionCard d={s.decisions.d1} state={s} now={Date.now()} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('phone and remote pages', () => {
  const state = () => {
    const cfg = parseConfig({ project: { name: 'harbor', repo: '/r' }, agents: [{ id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' }] });
    let s = emptyState();
    s = applyEvent(s, { seq: 1, id: 'e1', ts: new Date().toISOString(), type: 'config.loaded', kind: 'control', actor: { type: 'system', id: 't' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data: { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies } });
    s = applyEvent(s, { seq: 2, id: 'e2', ts: new Date().toISOString(), type: 'agent.registered', kind: 'control', actor: { type: 'system', id: 't' }, agentId: 'codex', runId: null, workItemId: null, assignmentId: null, data: { config: cfg.agents[0] } });
    return s;
  };

  it('shows offline banner with preserved paired label', () => {
    setRemoteSession(session, 'offline');
    vi.stubGlobal('fetch', vi.fn(async () => json({ notifications: [] })));
    render(<MemoryRouter><Phone state={state()} /></MemoryRouter>);
    expect(screen.getByText(/last paired as Phone/i)).toBeTruthy();
    expect(screen.getByText(/Approvals and changes are disabled/)).toBeTruthy();
  });

  it('mounts Mac management only for local identity', async () => {
    setRemoteSession(null, 'local');
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u === '/api/remote/status') return json({ config: { enabled: false, adapter: 'tailscale', httpsPort: 8443, scopes: ['read'], pairingTtlSeconds: 300, sessionTtlHours: 12, idleTimeoutMinutes: 120, maxSessions: 2 }, scopes: [], adapter: { id: 'tailscale', title: 'T', installed: true, note: '', testOnly: false }, tunnel: { state: 'down', hostname: null, detail: '', since: null }, localDaemon: { ready: true, note: '' }, reachability: { state: 'not_running', note: '' }, sessions: [], pendingPairings: [], locks: { pairing: null }, pendingDecision: null, validation: '' });
      if (u === '/api/notifications') return json({ notifications: [], status: { config: { channels: { native: { enabled: false }, browser: { enabled: false }, webpush: { enabled: false, endpoint: null }, chat: { enabled: false, endpoint: null } }, kinds: { stalled_run: true, aged_approval: true, usage_limit: true, ci_infra_failure: true, finished_work: true }, quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'local' }, agedApprovalMinutes: 30, cooldownMinutes: 60 }, quietNow: false, channels: { native: { enabled: false, note: '', last: null }, browser: { enabled: false, note: '' }, webpush: { enabled: false, endpoint: null, authorized: false, problem: null, expiresAt: null, note: '', last: null }, chat: { enabled: false, endpoint: null, authorized: false, problem: null, expiresAt: null, note: '', last: null } } } });
      return json({});
    }));
    render(<MemoryRouter><Remote state={state()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Request tunnel launch' })).toBeTruthy();
  });

  it('does not mount Mac management while checking', () => {
    clearPhoneAuthority('checking');
    render(<MemoryRouter><Remote state={state()} /></MemoryRouter>);
    expect(screen.getByText(/Checking this browser/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request tunnel launch' })).toBeNull();
  });

  it('does not mount Mac management when unauthorized', () => {
    clearPhoneAuthority('unauthorized');
    render(<MemoryRouter><Remote state={state()} /></MemoryRouter>);
    expect(screen.getByText(/not authorized to manage phone settings/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request tunnel launch' })).toBeNull();
  });
});
