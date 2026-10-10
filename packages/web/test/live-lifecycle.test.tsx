// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Protocol fixtures exercise the actual client, HTTP identity check and socket callbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '@acc/core';
import { api } from '../src/lib/api';
import { LiveStore } from '../src/lib/store';
import { canMutate, clearPhoneAuthority, displaySession, hasMutationAuthority, identityRevision, loadRemoteSession, remoteMode, setRemoteSession } from '../src/lib/remote';

vi.mock('../src/lib/desktop', () => ({
  isDesktop: false, desktopRequest: vi.fn(), ProjectSwitched: class extends Error {},
  restartActiveEngine: vi.fn(async () => {}), switchProject: vi.fn(), websocketUrl: vi.fn(async () => 'ws://fixture/ws'),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const local = () => json({ error: 'Not a phone session' }, 403);
const phone = { id: 'phone1', label: 'Phone', scopes: ['read', 'decisions', 'transcript'], csrf: 'one-csrf', project: 'harbor', expiresAt: '2099-01-01T00:00:00.000Z' };
const snapshot = (seq: number) => json({ state: { ...emptyState(), seq }, demo: true, tracker: null, outbox: null });
class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: unknown[] = [];
  url: string;
  constructor(url: string) { this.url = url; Socket.instances.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onopen?.(); }
  disconnect(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  receive(body: unknown) { this.onmessage?.({ data: JSON.stringify(body) }); }
}
let client: LiveStore;
beforeEach(() => {
  vi.useFakeTimers();
  clearPhoneAuthority('checking');
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  client = new LiveStore();
});
afterEach(() => { client.dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); clearPhoneAuthority('checking'); });
async function openLatest() {
  Socket.instances.at(-1)!.open();
  await vi.waitFor(() => expect(client.conn).toBe('live'));
}

describe('dashboard connection lifecycle', () => {
  it('awaits pending startup identity, then loads state and opens exactly one socket', async () => {
    let identify!: (r: Response) => void;
    const f = vi.fn((path: string) => path === '/api/state' ? Promise.resolve(snapshot(17)) : new Promise<Response>(r => { identify = r; }));
    vi.stubGlobal('fetch', f);
    const startup = loadRemoteSession();
    client.start();
    expect(f).toHaveBeenCalledTimes(1);
    expect(Socket.instances).toHaveLength(0);
    identify(local());
    await startup;
    await client.load();
    expect(client.state?.seq).toBe(17);
    expect(Socket.instances).toHaveLength(1);
    f.mockImplementation(async path => path === '/api/state' ? snapshot(17) : local());
    await openLatest();
    expect(Socket.instances[0].sent[0]).toEqual({ type: 'hello', since: 17 });
    expect(f.mock.calls.filter(([path]) => path === '/api/state')).toHaveLength(1);
  });

  it('reauthenticates after ordinary socket loss and reconnects from a fresh snapshot', async () => {
    let seq = 21;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/state' ? snapshot(seq) : local()));
    client.start(); await client.load(); await openLatest();
    const old = Socket.instances[0];
    old.disconnect();
    expect(remoteMode()).toBe('offline');
    expect(hasMutationAuthority()).toBe(false);
    expect(client.state).toBeNull();
    seq = 33;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
    await openLatest();
    expect(Socket.instances[1].sent[0]).toEqual({ type: 'hello', since: 33 });
    old.receive({ type: 'snapshot', state: { ...emptyState(), seq: 99 } });
    expect(client.state?.seq).toBe(33);
  });

  it('closes a stale socket and discards caches when scopes narrow while connected', async () => {
    let identity = phone, seq = 100;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/state' ? snapshot(seq) : json(identity)));
    client.start(); await client.load(); await openLatest();
    const old = Socket.instances[0];
    old.receive({ type: 'live', runId: 'r1', role: 'assistant', text: 'private old output' });
    identity = { ...phone, scopes: ['read'] }; seq = 4;
    await loadRemoteSession();
    expect(old.readyState).toBe(3);
    expect(client.liveFor('r1')).toBeNull();
    expect(canMutate(displaySession(), 'decisions')).toBe(false);
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
    await openLatest();
    expect(Socket.instances[1].sent[0]).toEqual({ type: 'hello', since: 4 });
    old.receive({ type: 'live', runId: 'r1', role: 'assistant', text: 'late output' });
    expect(client.liveFor('r1')).toBeNull();
  });

  it('clears authority on project switch and discards a delayed old state response', async () => {
    let oldState!: (r: Response) => void;
    let requests = 0;
    const f = vi.fn((path: string) => {
      if (path !== '/api/state') return Promise.resolve(local());
      requests++;
      return requests === 1 ? new Promise<Response>(r => { oldState = r; }) : Promise.resolve(snapshot(2));
    });
    vi.stubGlobal('fetch', f);
    client.start();
    await vi.waitFor(() => expect(requests).toBe(1));
    const previous = client.load();
    const binding = identityRevision();
    client.switchProject();
    expect(identityRevision()).toBeGreaterThan(binding);
    expect(remoteMode()).toBe('checking');
    await client.load();
    oldState(snapshot(300));
    await previous;
    expect(client.state?.seq).toBe(2);
    expect(Socket.instances).toHaveLength(1);
  });

  it('4001 revocation drops state immediately and cannot reuse an old socket or mutation grant', async () => {
    let revoked = false;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/state' ? snapshot(10) : revoked ? json({ error: 'revoked' }, 401) : json(phone)));
    client.start(); await client.load(); await openLatest();
    const old = Socket.instances[0]; revoked = true;
    old.disconnect(4001);
    expect(client.state).toBeNull();
    expect(hasMutationAuthority()).toBe(false);
    await vi.waitFor(() => expect(client.conn).toBe('unauthorized'));
    old.receive({ type: 'snapshot', state: { ...emptyState(), seq: 555 } });
    expect(client.state).toBeNull();
    await expect(api('/api/kill-switch', { body: { engaged: true } })).rejects.toMatchObject({ status: 403 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(1);
  });
});

describe('paired identity validation', () => {
  it.each([
    { ...phone, csrf: '' }, { ...phone, csrf: '   ' }, { ...phone, expiresAt: 'invalid' },
    { ...phone, expiresAt: '2000-01-01T00:00:00.000Z' }, { ...phone, scopes: ['read', 'root'] },
    { ...phone, scopes: ['read', 'read'] }, { ...phone, scopes: [123] },
  ])('rejects a malformed or expired session without granting mutations %#', async identity => {
    vi.stubGlobal('fetch', vi.fn(async () => json(identity)));
    await loadRemoteSession();
    expect(remoteMode()).toBe('unauthorized');
    expect(hasMutationAuthority()).toBe(false);
    expect(displaySession()).toBeNull();
  });

  it('refuses an expired grant at send time even without another identity response', async () => {
    const soon = { ...phone, expiresAt: new Date(Date.now() + 1000).toISOString() };
    setRemoteSession(soon);
    expect(canMutate(soon, 'decisions')).toBe(true);
    await vi.advanceTimersByTimeAsync(1001);
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect(canMutate(soon, 'decisions')).toBe(false);
    await expect(api('/api/decisions/x/answer', { body: {} })).rejects.toMatchObject({ status: 403 });
    expect(f).not.toHaveBeenCalled();
  });

  it('drops an offline identity cache when a subsequent refresh is unauthorized', async () => {
    setRemoteSession(phone, 'offline');
    const binding = identityRevision();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'revoked' }, 401)));
    await loadRemoteSession();
    expect(displaySession()).toBeNull();
    expect(identityRevision()).toBeGreaterThan(binding);
  });
});
