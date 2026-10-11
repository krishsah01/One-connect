// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Network egress guard. The control center itself contacts ONLY the hosts of connections the user
// configured (their tracker, their model providers, their local model servers). There is no
// telemetry, no update check and no project server: nothing about your work leaves your machine
// except to the providers you chose. Every outbound request from the daemon goes through here.
//
// (Vendor CLIs the user runs, e.g. `claude` or `codex`, talk to their own vendor; that is the
// connection the user chose.)
import type { ControlCenterConfig } from '@acc/core';

export class EgressDenied extends Error {}

export const PROVIDER_HOSTS: Record<string, (base?: string) => string[]> = {
  'anthropic-api': () => ['api.anthropic.com'],
  'openai-api': () => ['api.openai.com'],
  // The Cursor CLI talks to Cursor itself; the daemon never calls Cursor with the key.
  'cursor-api': () => [],
  openrouter: () => ['openrouter.ai'],
  ollama: (base) => [hostOf(base ?? 'http://127.0.0.1:11434')],
  lmstudio: (base) => [hostOf(base ?? 'http://127.0.0.1:1234')],
  // Ollama's paid cloud models: through the signed-in local daemon, or the cloud API (ollama_route: api).
  'ollama-cloud': (base) => [hostOf(base ?? 'http://127.0.0.1:11434')],
};

function hostOf(url: string): string {
  return new URL(url).host;
}

/** Hosts the daemon may contact, derived only from configuration. */
export function allowedHosts(cfg: ControlCenterConfig): string[] {
  const hosts = new Set<string>(['127.0.0.1', 'localhost']); // its own server / MCP bridge
  if (cfg.tracker.type === 'linear') hosts.add(hostOf(cfg.tracker.api_url));
  for (const a of cfg.agents) {
    const h = PROVIDER_HOSTS[a.provider];
    const base = a.provider === 'ollama-cloud' ? (a.base_url ?? ((a.ollama_route ?? 'daemon') === 'api' ? 'https://ollama.com' : undefined)) : a.base_url;
    if (h) for (const x of h(base)) hosts.add(x);
  }
  if (cfg.import_sources.some(s => s.type === 'linear' && s.enabled)) hosts.add('api.linear.app');
  // Code-host and infrastructure hosts come only from matching recorded Connector Decisions.
  return [...hosts];
}

export type Fetch = (url: string, init?: RequestInit & { notificationPermit?: string; marketplacePermit?: string }) => Promise<Response>;

export interface Egress {
  fetch: Fetch;
  allowed: string[];
  /** Redeems one exact message authorization without granting its entire host. */
  authorizeNotification?: (token: string, url: string, init?: RequestInit) => boolean;
  /** Exact one-shot public catalog GETs minted only inside marketplace HTTP routes. */
  authorizeMarketplace?: (token: string, url: string, init?: RequestInit) => boolean;
  /** Every request made, for the audit view and tests. */
  log: { at: string; host: string; method: string; purpose: string; allowed: boolean }[];
}

export function createEgress(cfg: ControlCenterConfig, underlying: Fetch = globalThis.fetch): Egress {
  const allowed = allowedHosts(cfg);
  const log: Egress['log'] = [];
  const isAllowed = (u: URL) => allowed.includes(u.host) || allowed.includes(u.hostname);
  const guarded = (async (url: string, init?: RequestInit & { purpose?: string; notificationPermit?: string; marketplacePermit?: string }) => {
    const u = new URL(url);
    const token = init?.notificationPermit;
    const market = init?.marketplacePermit;
    const ok = market !== undefined ? Boolean(egress.authorizeMarketplace?.(market, url, init)) : token !== undefined ? Boolean(egress.authorizeNotification?.(token, url, init)) : isAllowed(u);
    log.push({ at: new Date().toISOString(), host: u.host, method: init?.method ?? 'GET', purpose: market !== undefined ? 'marketplace preview/import' : token !== undefined ? 'notification delivery' : init?.purpose ?? '', allowed: ok });
    if (log.length > 500) log.splice(0, log.length - 500);
    if (!ok) throw new EgressDenied(`blocked outbound request to ${u.host}: not a configured connection`);
    // A configured host cannot redirect a request (or credentials) to another host.
    const { notificationPermit: _permit, marketplacePermit: _market, purpose: _purpose, ...request } = init ?? {};
    return underlying(url, { ...request, redirect: 'error' });
  }) as Fetch;
  const egress: Egress = { fetch: guarded, allowed, log };
  return egress;
}
