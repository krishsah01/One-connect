// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyState, parseConfig, type ControlState, type EventEnvelope } from '@acc/core';
import { api, ApiError } from '../src/lib/api';
import { setRemoteSession } from '../src/lib/remote';
import { KillSwitch, Phone } from '../src/pages/Phone';
import { Reports } from '../src/pages/Reports';
import { Remote } from '../src/pages/Remote';
import { redeemFromLocation } from '../src/pages/PairPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setRemoteSession(null, 'checking'); Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); });

let seq = 0;
const ev = (type: string, data: unknown, refs: Partial<EventEnvelope> = {}): EventEnvelope =>
  ({ seq: ++seq, id: `e${seq}`, ts: new Date().toISOString(), type, kind: 'control', actor: { type: 'system', id: 't' }, agentId: null, runId: null, workItemId: null, assignmentId: null, data, ...refs }) as EventEnvelope;
function state(): ControlState {
  const cfg = parseConfig({ project: { name: 'harbor', repo: '/r' }, agents: [{ id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli' }] });
  let s = emptyState();
  for (const e of [
    ev('config.loaded', { project: cfg.project, tracker: cfg.tracker, policies: cfg.policies }),
    ev('agent.registered', { config: cfg.agents[0] }),
    ev('decision.created', { decision: { id: 'dec1', question: 'Merge LOC-1 into integration?', options: ['merge', 'reject'], recommendation: null, evidenceLinks: [], urgency: 'high', irreversible: true, confirmOptions: ['merge'], answer: null, answeredAt: null, channel: null, createdAt: new Date().toISOString(), kind: 'merge', risk: 'medium' } }),
  ]) s = applyEvent(s, e);
  return s;
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

describe('offline and remote API behavior', () => {
  it('refuses changes while offline instead of queueing them, and still allows reads', async () => {
    const f = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', f);
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await expect(api('/api/kill-switch', { method: 'POST', body: { engaged: true } })).rejects.toThrow(/offline.*nothing is queued/i);
    expect(f).not.toHaveBeenCalled();
    await expect(api('/api/state')).resolves.toBeTruthy();
    f.mockRejectedValueOnce(new TypeError('network'));
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    await expect(api('/api/decisions/x/answer', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
  });

  it('sends the CSRF header on changes from a paired phone, never on reads', async () => {
    const calls: Record<string, string>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => { calls.push((init?.headers ?? {}) as Record<string, string>); return json({}); }));
    setRemoteSession({ id: 's', label: 'Phone 1', scopes: ['read'], expiresAt: '2099-01-01T00:00:00.000Z', csrf: 'csrf-value', project: 'p' });
    await api('/api/state');
    await api('/api/kill-switch', { method: 'POST', body: { engaged: true } });
    expect(calls[0]['x-acc-csrf']).toBeUndefined();
    expect(calls[1]['x-acc-csrf']).toBe('csrf-value');
  });
});

describe('phone page', () => {
  it('asks twice before the kill switch, and a paired phone cannot release it', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => { calls.push([u, init?.body]); return json({ ok: true }); }));
    setRemoteSession(null, 'local');
    const s = state();
    render(<KillSwitch state={s} online remote={false} allowed />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop all runs…' }));
    expect(calls).toEqual([]);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Stop all runs…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, stop everything' }));
    await waitFor(() => expect(calls).toEqual([['/api/kill-switch', JSON.stringify({ engaged: true })]]));
    cleanup();
    render(<KillSwitch state={{ ...s, killSwitch: { engaged: true, at: '', by: 'owner' } }} online remote allowed />);
    expect(screen.queryByRole('button', { name: /Release/ })).toBeNull();
    expect(screen.getByText(/Release it on the Mac/)).toBeTruthy();
  });

  it('disables the kill switch offline', () => {
    render(<KillSwitch state={state()} online={false} remote={false} allowed />);
    expect((screen.getByRole('button', { name: 'Stop all runs…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Offline: the kill switch cannot be used/)).toBeTruthy();
  });

  it('clears an armed kill switch across offline and scope-loss transitions', () => {
    const s = state();
    const view = render(<KillSwitch state={s} online remote allowed />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop all runs…' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    view.rerender(<KillSwitch state={s} online={false} remote allowed />);
    view.rerender(<KillSwitch state={s} online remote allowed />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop all runs…' }));
    view.rerender(<KillSwitch state={s} online remote allowed={false} />);
    view.rerender(<KillSwitch state={s} online remote allowed />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows decisions with a second confirmation before an irreversible answer is sent', async () => {
    setRemoteSession({ id: 's', label: 'Phone', scopes: ['read', 'decisions'], csrf: 'csrf', expiresAt: '2099-01-01T00:00:00.000Z', project: 'harbor' });
    const calls: [string, unknown][] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push([u, init?.body ? JSON.parse(String(init.body)) : undefined]);
      if (u === '/api/notifications') return json({ notifications: [] });
      if (u.endsWith('/prepare')) return json({ confirm: true, nonce: 'n1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return json({ decision: {}, merge: { merged: true, mergeSha: 'abcdef0123456789' } });
    }));
    render(<MemoryRouter><Phone state={state()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^merge/ }));
    await screen.findByRole('alertdialog');
    expect(calls.some(([u]) => u.endsWith('/answer'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, merge' }));
    await waitFor(() => expect(calls.some(([u]) => u.endsWith('/answer'))).toBe(true));
    expect(calls.find(([u]) => u.endsWith('/answer'))![1]).toMatchObject({ answer: 'merge', nonce: 'n1' });
  });
  it.each(['docker', 'environment', 'release', 'cost', 'settings', 'connector', 'notification'])('shows a granted %s Decision and preserves its confirmation step', async kind => {
    setRemoteSession({ id: 's', label: 'Phone', scopes: ['read', 'decisions'], csrf: 'csrf', expiresAt: '2099-01-01T00:00:00.000Z', project: 'harbor' });
    const s = state();
    s.decisions.dec1 = { ...s.decisions.dec1, kind: kind as never, question: `Exact ${kind} action?`, options: ['approve', 'deny'], confirmOptions: ['approve'], ...(kind === 'notification' ? { evidence: [{ label: 'Delivery ID', detail: 'n1' }] } : {}) };
    const calls: [string, unknown][] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push([u, init?.body ? JSON.parse(String(init.body)) : undefined]);
      if (u === '/api/notifications') return json({ notifications: [] });
      if (u.endsWith('/prepare')) return json({ confirm: true, nonce: 'exact-nonce', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return json({ decision: {} });
    }));
    render(<MemoryRouter><Phone state={s} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^approve/ }));
    await screen.findByRole('alertdialog');
    expect(calls.some(([url]) => url.endsWith('/answer'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(calls.find(([url]) => url.endsWith('/answer'))?.[1]).toMatchObject({ answer: 'approve', nonce: 'exact-nonce' }));
  });

  it('withholds answer buttons when the project or tunnel grant is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ notifications: [] })));
    setRemoteSession({ id: 's', label: 'Phone', scopes: ['read'], csrf: 'csrf', expiresAt: '2099-01-01T00:00:00.000Z', project: 'harbor' });
    render(<MemoryRouter><Phone state={state()} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /^merge/ })).toBeNull();
    expect(screen.getByText(/not granted project Decisions/)).toBeTruthy();
    cleanup();
    const s = state(); s.decisions.dec1.kind = 'remote';
    setRemoteSession({ id: 's', label: 'Phone', scopes: ['read', 'decisions'], csrf: 'csrf', expiresAt: '2099-01-01T00:00:00.000Z', project: 'harbor' });
    render(<MemoryRouter><Phone state={s} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /^merge/ })).toBeNull();
    expect(screen.getByText(/separate tunnel Decision scope/)).toBeTruthy();
  });

});

describe('pairing page', () => {
  it('reads the token from the fragment once, removes it from the address bar, and never posts it twice', async () => {
    const f = vi.fn(async () => json({ paired: true }));
    vi.stubGlobal('fetch', f);
    window.history.replaceState(null, '', '/pair#t=secret-token-value');
    const a = redeemFromLocation();
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('secret-token-value');
    const b = redeemFromLocation();
    expect(await a).toEqual({ ok: true, message: 'Paired.' });
    expect(await b).toEqual({ ok: true, message: 'Paired.' });
    expect(f).toHaveBeenCalledTimes(1);
    const init = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[0]).toBe('/api/remote/pair');
    expect(init[1].referrerPolicy).toBe('no-referrer');
    expect(init[0]).not.toContain('secret');
  });
});

describe('reports and remote settings', () => {
  it('Reports link claims to events and label agent-reported text as unverified', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.startsWith('/api/reports/brief')) return json({ generatedAt: '', seq: 1, project: 'harbor', filter: {}, now: [], next: [], pending: [], handoffs: [{ runId: 'r', seq: 12, eventId: 'e', at: new Date().toISOString(), agent: 'Codex', agentId: 'codex', issue: 'LOC-1', title: 't', done: 'Built login', next: null, blocked: null, commit: { sha: 'c0ffee1234567890', branch: 'x', verified: false }, evidence: [{ command: 'node --test', result: '12 passed', verified: false }], verdict: null, source: 'mcp', runState: 'finished' }], checks: [], merges: [], releases: [], notes: ['No check results have been recorded for this scope.'] });
      return json({});
    }));
    render(<MemoryRouter><Reports state={state()} /></MemoryRouter>);
    expect(await screen.findByText('Built login')).toBeTruthy();
    expect(screen.getByText(/event #12/)).toBeTruthy();
    expect(screen.getByText('unverified')).toBeTruthy();
    expect(screen.getByText(/not verified/)).toBeTruthy();
    expect(screen.getByText(/No check results have been recorded/)).toBeTruthy();
    expect(screen.getByText(/Absence|No release, deploy/)).toBeTruthy();
  });

  it('never mounts Mac management or unread inbox routes for a paired phone without read scope', () => {
    const f = vi.fn(async () => json({ notifications: [] })); vi.stubGlobal('fetch', f);
    setRemoteSession({ id: 's', label: 'Phone', scopes: ['decisions'], expiresAt: '2099-01-01T00:00:00.000Z', csrf: 'csrf', project: 'harbor' });
    render(<MemoryRouter><Remote state={state()} /></MemoryRouter>);
    expect(screen.getByText(/settings are managed on the Mac/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request tunnel launch' })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('Remote access is disabled by default and the dry run says nothing was executed', async () => {
    setRemoteSession(null, 'local');
    const status = { config: { enabled: false, adapter: 'tailscale', httpsPort: 8443, scopes: ['read', 'transcript', 'decisions', 'kill_switch'], pairingTtlSeconds: 300, sessionTtlHours: 12, idleTimeoutMinutes: 120, maxSessions: 2 }, scopes: [{ scope: 'read', title: 'Status and reports', detail: 'd', granted: true }, { scope: 'transcript', title: 'Run transcripts', detail: 'd', granted: true }, { scope: 'decisions', title: 'Answer', detail: 'd', granted: true }, { scope: 'kill_switch', title: 'Kill', detail: 'd', granted: true }], adapter: { id: 'tailscale', title: 'Tailscale Serve', installed: true, note: '', testOnly: false }, tunnel: { state: 'down', hostname: null, detail: 'Remote access is off.', since: null }, localDaemon: { ready: true, note: 'Local daemon readiness says nothing about whether the internet can reach it.' }, reachability: { state: 'not_running', note: 'No tunnel is running' }, sessions: [], pendingPairings: [], locks: { pairing: null }, pendingDecision: null, validation: 'Real Tailscale and phone validation are pending.' };
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u === '/api/remote/status') return json(status);
      if (u === '/api/remote/review') return json({ dryRun: true, executed: false, plan: { adapter: 'tailscale', title: 'T', port: 7317, start: [{ command: 'tailscale', args: ['serve', '--bg', '--https=8443', 'http://127.0.0.1:7317'] }], teardown: [{ command: 'tailscale', args: ['serve', '--https=8443', 'off'] }], exposes: 'HTTPS port 8443 on this Mac’s tailnet name', touchesTailnet: true, warnings: ['w1'], digest: 'a'.repeat(64), publicInternet: false }, adapter: { title: 'T', installed: true, note: '' }, scopes: [], limits: {}, controls: ['c1'], blockedBy: ['Remote access is disabled. Enable it first; nothing starts without a Decision.'] });
      if (u === '/api/notifications') return json({ notifications: [], status: { config: { channels: { native: { enabled: false }, browser: { enabled: false }, webpush: { enabled: false, endpoint: null }, chat: { enabled: false, endpoint: null } }, kinds: { stalled_run: true, aged_approval: true, usage_limit: true, ci_infra_failure: true, finished_work: true }, quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'local' }, agedApprovalMinutes: 30, cooldownMinutes: 60 }, quietNow: false, channels: { native: { enabled: false, note: 'n', last: null }, browser: { enabled: false, note: 'b' }, webpush: { enabled: false, endpoint: null, authorized: false, problem: null, expiresAt: null, note: 'p', last: null }, chat: { enabled: false, endpoint: null, authorized: false, problem: null, expiresAt: null, note: 'c', last: null } } } });
      return json({});
    }));
    render(<MemoryRouter><Remote state={state()} /></MemoryRouter>);
    expect(await screen.findByText('disabled')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Request tunnel launch' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/does not open anything/)).toBeTruthy();
    expect(screen.getByText(/whether the internet can reach it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Review exact plan/ }));
    expect(await screen.findByText('Dry run: nothing has been executed')).toBeTruthy();
    expect(screen.getByText(/--https=8443 http:\/\/127\.0\.0\.1:7317/)).toBeTruthy();
    expect(screen.getByText('Never. Public listeners are refused.')).toBeTruthy();
    expect(screen.getByText(/permission unknown/)).toBeTruthy();
  });
});
