// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// HTTP for code-host and infra probes.
// Fixtures stay on loopback. A live call is https only, and only after the caller
// has already checked activation and the egress allowlist.
import type { Fetch } from '../../egress.ts';

export class ProviderRefused extends Error {}

export function assertLoopbackBase(base: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new ProviderRefused('fixture base is not a URL');
  }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.hash) {
    throw new ProviderRefused('Real-provider validation is pending until the connection is activated. This fixture accepts only an HTTP loopback URL.');
  }
  return base.replace(/\/$/, '');
}

export function assertHttpsBase(base: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new ProviderRefused('live host is not a URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) {
    throw new ProviderRefused('Live calls use https and never put credentials in the URL.');
  }
  return base.replace(/\/$/, '');
}

export function fixtureUrl(base: string, path: string): string {
  const root = assertLoopbackBase(base);
  return root + (path.startsWith('/') ? path : `/${path}`);
}

export function liveUrl(base: string, path: string): string {
  const root = assertHttpsBase(base);
  return root + (path.startsWith('/') ? path : `/${path}`);
}

export async function readJson(fetch: Fetch, url: string, init?: { headers?: Record<string, string>; live?: boolean }): Promise<{ status: number; json: unknown; headers: Headers }> {
  if (init?.live) assertHttpsBase(url);
  else assertLoopbackBase(url);
  // A redirect must not move a reviewed request or its credential to another host.
  const res = await fetch(url, { method: 'GET', headers: init?.headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, headers: res.headers };
}
