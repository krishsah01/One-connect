// SPDX-License-Identifier: Apache-2.0
// The phone session, when this page was opened through the private tunnel. On the Mac the call
// is refused (403) and the dashboard behaves normally. The CSRF value is derived server-side from
// the HttpOnly cookie, so a cross-site page cannot learn it.
import { useSyncExternalStore } from 'react';
import { REMOTE_SCOPES } from '@acc/core';
import { desktopRequest, isDesktop, ProjectSwitched } from './desktop';

export interface RemoteSession { id: string; label: string; scopes: string[]; expiresAt: string; csrf: string; project: string | null }

export type RemoteMode = 'checking' | 'local' | 'paired' | 'unauthorized' | 'offline';

let session: RemoteSession | null = null;
/** Last paired identity kept for factual display when the daemon is unreachable. Never grants access. */
let displaySessionCache: RemoteSession | null = null;
let checked = false;
let mode: RemoteMode = 'checking';
let revision = 0;
let authorityRevision = 0;
/** Bumped when identity is cleared or replaced; stale async results must be discarded. */
let identityGen = 0;
let loadInFlight: Promise<RemoteSession | null> | null = null;
let loadInFlightGen = -1;
const listeners = new Set<() => void>();
const authorityListeners = new Set<() => void>();

const emit = () => { revision++; for (const l of listeners) l(); };

const notifyAuthorityCleared = () => { for (const fn of authorityListeners) fn(); };

const bindingKey = () => {
  const identity = session ?? displaySessionCache;
  return JSON.stringify([mode, identity ? [identity.id, identity.project, [...identity.scopes].sort(), identity.csrf, identity.expiresAt] : null]);
};
const changedAuthority = (before: string) => {
  if (before === bindingKey()) return;
  authorityRevision++;
  notifyAuthorityCleared();
};

const isPairedSession = (body: unknown): body is RemoteSession => {
  if (!body || typeof body !== 'object') return false;
  const s = body as RemoteSession;
  return typeof s.id === 'string' && s.id.length > 0 && typeof s.label === 'string' && Array.isArray(s.scopes)
    && s.scopes.length > 0 && new Set(s.scopes).size === s.scopes.length
    && s.scopes.every(scope => (REMOTE_SCOPES as readonly unknown[]).includes(scope))
    && typeof s.expiresAt === 'string' && Date.parse(s.expiresAt) > Date.now()
    && typeof s.csrf === 'string' && s.csrf.trim().length > 0
    && (s.project === null || typeof s.project === 'string');
};

const isLocalIdentity = (body: unknown): body is { mode: 'local'; project: string } =>
  Boolean(body && typeof body === 'object' && (body as { mode?: string }).mode === 'local'
    && typeof (body as { project?: string }).project === 'string');

export const remoteMode = (): RemoteMode => mode;

/** Monotonic identity revision for binding prepared confirmations and store guards. */
export const identityRevision = (): number => authorityRevision;

/** Session for UI labels and scope display; may be preserved while offline. */
export const displaySession = (): RemoteSession | null => {
  if (mode === 'paired' && session) return session;
  if (mode === 'offline' && displaySessionCache) return displaySessionCache;
  return session;
};

export const remoteCsrf = (): string | null => (mode === 'paired' && isPairedSession(session) ? session.csrf : null);

/** Register a callback when phone authority is discarded (socket 4001, revocation, etc.). */
export const onPhoneAuthorityCleared = (fn: () => void) => {
  authorityListeners.add(fn);
  return () => { authorityListeners.delete(fn); };
};

/** Discard cached phone grants before reauthentication. Does not persist credentials. */
export const clearPhoneAuthority = (next: RemoteMode = 'checking') => {
  identityGen++;
  session = null;
  displaySessionCache = null;
  mode = next;
  checked = next !== 'checking';
  authorityRevision++;
  emit();
  notifyAuthorityCleared();
};

export const setRemoteSession = (s: RemoteSession | null, m?: RemoteMode) => {
  const before = bindingKey();
  identityGen++;
  if (s && !isPairedSession(s)) { s = null; m = 'unauthorized'; }
  session = s;
  if (s) {
    displaySessionCache = s;
    mode = m ?? 'paired';
  } else {
    displaySessionCache = null;
    mode = m ?? 'unauthorized';
  }
  checked = true;
  changedAuthority(before);
  emit();
};

const classifyBrowser = (res: Response, body: { error?: string } | RemoteSession): RemoteMode => {
  if (res.ok) return 'paired';
  if (res.status === 403 && (body as { error?: string }).error === 'Not a phone session') return 'local';
  if (res.status >= 500) return 'offline';
  return 'unauthorized';
};

const applyIdentity = (gen: number, next: RemoteMode, nextSession: RemoteSession | null) => {
  if (gen !== identityGen) return;
  const before = bindingKey();
  session = nextSession;
  if (next === 'paired' && nextSession) {
    displaySessionCache = nextSession;
    mode = 'paired';
  } else if (next === 'local') {
    displaySessionCache = null;
    mode = 'local';
  } else if (next === 'offline') {
    mode = 'offline';
    // displaySessionCache preserved for factual display only.
  } else {
    displaySessionCache = null;
    mode = 'unauthorized';
  }
  checked = true;
  changedAuthority(before);
  emit();
};

async function loadBrowserIdentity(gen: number): Promise<RemoteSession | null> {
  const res = await fetch('/api/remote/session', { credentials: 'same-origin' });
  const body = (await res.json().catch(() => ({}))) as { error?: string } | RemoteSession;
  const classified = classifyBrowser(res, body);
  if (classified === 'paired') {
    if (!isPairedSession(body)) {
      applyIdentity(gen, 'unauthorized', null);
      return null;
    }
    applyIdentity(gen, 'paired', body);
    return body;
  }
  if (classified === 'local') {
    applyIdentity(gen, 'local', null);
    return null;
  }
  applyIdentity(gen, classified, null);
  return null;
}

async function loadDesktopIdentity(gen: number): Promise<RemoteSession | null> {
  try {
    const body = await desktopRequest('/api/auth/identity', {});
    if (gen !== identityGen) return null;
    if (isLocalIdentity(body)) {
      applyIdentity(gen, 'local', null);
      return null;
    }
    applyIdentity(gen, 'unauthorized', null);
    return null;
  } catch (e) {
    if (gen !== identityGen) return null;
    // The new project starts its own identity request. Awaiting the currently active request
    // here would await this very promise and leave startup permanently unresolved.
    if (e instanceof ProjectSwitched) return null;
    applyIdentity(gen, 'offline', null);
    return null;
  }
}

/** Asks the daemon whether this browser is a paired phone. Never throws. */
export async function loadRemoteSession(): Promise<RemoteSession | null> {
  const gen = identityGen;
  if (loadInFlight && loadInFlightGen === identityGen) return loadInFlight;
  const pending = (async (): Promise<RemoteSession | null> => {
    try {
      if (isDesktop) return await loadDesktopIdentity(gen);
      return await loadBrowserIdentity(gen);
    } catch {
      if (gen !== identityGen) return null;
      applyIdentity(gen, 'offline', null);
      return null;
    }
  })();
  loadInFlight = pending;
  loadInFlightGen = identityGen;
  void pending.finally(() => {
    if (loadInFlight === pending) {
      loadInFlight = null;
      loadInFlightGen = -1;
    }
  });
  return pending;
}

/** Refresh identity after auth-related API responses without retrying the original request. */
export function refreshIdentityFromApi(status: number) {
  if (status === 401 || status === 403 || status === 429) void loadRemoteSession();
}

/** A dropped transport cannot keep granting mutations while reauthentication is pending. */
export function markConnectionOffline() { applyIdentity(identityGen, 'offline', null); }

/** True when mutating API calls may proceed (local dashboard or paired session with CSRF). */
export const hasMutationAuthority = (): boolean => {
  if (mode === 'checking' || mode === 'offline' || mode === 'unauthorized') return false;
  if (mode === 'local') return true;
  return isPairedSession(session);
};

/** Scope/navigation check. Offline preserves last-known grants for display routing only. */
export const can = (s: RemoteSession | null, scope: string): boolean => {
  if (mode === 'local') return true;
  const active = s ?? (mode === 'offline' ? displaySessionCache : null);
  if (mode === 'offline' && active) return active.scopes.includes(scope);
  if (mode === 'paired' && isPairedSession(session) && active?.id === session.id && active.project === session.project) return session.scopes.includes(scope) && active.scopes.includes(scope);
  return false;
};

/** Mutation authority: blocked while checking, offline, or unauthorized. */
export const canMutate = (s: RemoteSession | null, scope: string): boolean => {
  if (mode === 'checking' || mode === 'offline' || mode === 'unauthorized') return false;
  if (mode === 'local') return true;
  return Boolean(isPairedSession(session) && s?.id === session.id && s.project === session.project && session.scopes.includes(scope) && s.scopes.includes(scope));
};

export function useRemoteSession(): { session: RemoteSession | null; checked: boolean; mode: RemoteMode } {
  useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => revision,
  );
  return { session: displaySession(), checked, mode };
}
