// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { isDesktop, desktopRequest } from './desktop';
import { isOnline, OFFLINE_MESSAGE } from './offline';
import { hasMutationAuthority, refreshIdentityFromApi, remoteCsrf } from './remote';

const UNCERTAIN_RECEIPT = 'Could not confirm the result. Receipt is unknown and nothing is queued. Reload Decisions before trying again.';

/** Only redeeming the single-use link is available before identity; creating links is owner-only. */
const pairingPath = (path: string, method: string) => method === 'POST' && path.split('?')[0] === '/api/remote/pair';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; project?: string } = {}): Promise<T> {
  const method = (init.method ?? (init.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (isDesktop) {
    if (mutating && !hasMutationAuthority()) throw new ApiError('This browser is not authorized to make changes right now.', 403);
    try { return await desktopRequest(path, init) as T; }
    catch (e) {
      if (mutating) throw new ApiError(UNCERTAIN_RECEIPT, 0);
      throw new ApiError(String(e), 500);
    }
  }
  // Offline mode never queues a change: a stale approval must not be replayed later.
  if (mutating && !isOnline()) throw new ApiError(OFFLINE_MESSAGE, 0);
  if (mutating && !pairingPath(path, method) && !hasMutationAuthority()) {
    throw new ApiError('This browser is not authorized to make changes right now.', 403);
  }
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const csrf = remoteCsrf();
  if (mutating && csrf) headers['x-acc-csrf'] = csrf;
  let res: Response;
  try {
    res = await fetch(path, { method, headers: Object.keys(headers).length ? headers : undefined, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, credentials: 'same-origin' });
  } catch (e) {
    if (mutating) throw new ApiError(UNCERTAIN_RECEIPT, 0);
    throw e;
  }
  let text: string;
  try { text = await res.text(); }
  catch (e) {
    if (mutating) throw new ApiError(UNCERTAIN_RECEIPT, 0);
    throw e;
  }
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    refreshIdentityFromApi(res.status);
    throw new ApiError((body as { error?: string })?.error ?? res.statusText, res.status, body);
  }
  return body as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
