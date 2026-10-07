// SPDX-License-Identifier: Apache-2.0
import { isDesktop, desktopRequest } from './desktop';
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (isDesktop) {
    try { return await desktopRequest(path, init) as T; }
    catch (e) { throw new ApiError(String(e), 500); }
  }
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* plain text */
  }
  if (!res.ok) throw new ApiError((body as { error?: string })?.error ?? res.statusText, res.status, body);
  return body as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
