// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
// The service worker may cache only the static offline shell. These tests run the real sw.js in a sandbox.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = path.resolve(process.cwd(), 'packages', 'web', 'public');
const code = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

function boot() {
  const handlers: Record<string, (e: any) => void> = {};
  const puts: string[] = [];
  const added: string[][] = [];
  const store = new Map<string, string>();
  const cache = { addAll: async (l: string[]) => { added.push(l); l.forEach((u) => store.set(u, 'cached')); }, put: async (r: any) => { puts.push(String(r)); } };
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true, match: async (r: any) => { const u = typeof r === 'string' ? r : new URL(r.url).pathname; return store.has(u) ? { cached: u } : undefined; } };
  const fetched: string[] = [];
  const sandbox: any = {
    URL, Response: { error: () => ({ error: true }) }, caches,
    fetch: vi.fn(async (r: any) => { fetched.push(r.url); if (r.fail) throw new Error('offline'); return { network: r.url }; }),
    self: { location: { origin: 'https://mac.tail.ts.net' }, addEventListener: (t: string, h: any) => { handlers[t] = h; }, clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} } },
  };
  vm.runInNewContext(code, sandbox);
  const request = (url: string, o: { method?: string; mode?: string; fail?: boolean } = {}) => {
    let responded: Promise<unknown> | null = null;
    const e = { request: { url: `https://mac.tail.ts.net${url}`, method: o.method ?? 'GET', mode: o.mode ?? 'cors', fail: o.fail }, respondWith: (p: Promise<unknown>) => { responded = p; } };
    handlers.fetch(e);
    return { responded };
  };
  return { handlers, puts, added, request, fetched, sandbox, caches };
}

describe('service worker', () => {
  it('precaches only the static shell and never writes anything else to a cache', async () => {
    const sw = boot();
    let done: Promise<unknown> = Promise.resolve();
    sw.handlers.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect(sw.added[0]).toEqual(['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']);
    for (const u of ['/api/state', '/api/runs/r1/events', '/ws', '/auth?code=abc', '/pair', '/assets/index.js', '/decisions', '/api/decisions/d/answer'])
      expect(sw.request(u).responded, u).toBeNull(); // not handled: straight to the network
    expect(sw.request('/api/state', { method: 'POST' }).responded).toBeNull();
    expect(sw.request('/?token=abc', { mode: 'navigate' }).responded).toBeNull();
    expect(sw.puts).toEqual([]);
    expect(sw.fetched).toEqual([]);
  });

  it('ignores other origins and every mutation, and serves the offline page only when a navigation fails', async () => {
    const sw = boot();
    let done: Promise<unknown> = Promise.resolve();
    sw.handlers.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    let responded: Promise<unknown> | null = null;
    sw.handlers.fetch({ request: { url: 'https://other.example/icons/icon-192.png', method: 'GET', mode: 'cors' }, respondWith: (p: Promise<unknown>) => { responded = p; } });
    expect(responded).toBeNull();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(sw.request('/icons/icon-192.png', { method: m }).responded).toBeNull();
    expect(await sw.request('/phone', { mode: 'navigate' }).responded).toEqual({ network: 'https://mac.tail.ts.net/phone' });
    expect(await sw.request('/phone', { mode: 'navigate', fail: true }).responded).toEqual({ cached: '/offline.html' });
    expect(await sw.request('/icons/icon-192.png').responded).toEqual({ cached: '/icons/icon-192.png' });
    expect(sw.puts).toEqual([]);
  });

  it('declares no caching strategy for API, event, credential or source data', () => {
    expect(code).not.toMatch(/cache\.put|cache\.add\(|stale-while|background sync|sync\.register|indexedDB|localStorage/i);
    expect(code).toMatch(/NEVER = \/\^\\\/\(api\|ws\|auth\|pair\)/);
  });
});

describe('manifest and offline page', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  it('is an installable standalone app with real icon files', () => {
    expect(manifest).toMatchObject({ display: 'standalone', scope: '/', theme_color: '#087e8b', background_color: '#f3f6f7' });
    expect(manifest.start_url).not.toMatch(/[?#]/);
    const sizes = manifest.icons.map((i: any) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
    for (const i of manifest.icons) {
      const buf = fs.readFileSync(path.join(PUBLIC, i.src));
      expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(buf.readUInt32BE(16)).toBe(Number(i.sizes.split('x')[0]));
    }
  });
  it('the offline page says it is offline, stores nothing and queues nothing', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'offline.html'), 'utf8');
    expect(html).toMatch(/offline/i);
    expect(html).toMatch(/never stored on this device/);
    expect(html).toMatch(/Nothing you do is queued/);
    expect(html).not.toMatch(/<script src|fetch\(/);
  });
});
