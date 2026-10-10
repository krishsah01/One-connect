// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Private tunnel adapters for phone access. An adapter only plans and (after a recorded human
// Decision) starts a PRIVATE, authenticated path to the loopback daemon. Planning never executes
// anything that changes a network. Public listeners (for example Tailscale Funnel) are refused.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { whichAll } from '../adapters/agents/detect.ts';
import { run, type ExecResult } from '../exec.ts';

export type TunnelState = 'down' | 'starting' | 'up' | 'reconnecting' | 'error';

export interface TunnelPlan {
  adapter: string;
  title: string;
  port: number;
  /** Exact commands that will run after approval (argv arrays, never a shell string). */
  start: { command: string; args: string[] }[];
  /** Commands One Connect runs to remove exactly what it added. */
  teardown: { command: string; args: string[] }[];
  /** `null` until the adapter reports its name after approval; the daemon then accepts exactly that Host. */
  hostname: string | null;
  exposes: string;
  publicInternet: false;
  touchesTailnet: boolean;
  secureTransport: boolean;
  testOnly: boolean;
  warnings: string[];
  digest: string;
}

export interface TunnelProbe {
  state: 'running' | 'stopped' | 'unknown';
  hostname: string | null;
  detail: string;
}

export interface TunnelAdapter {
  readonly id: 'tailscale' | 'fixture';
  readonly title: string;
  /** TLS terminates before the daemon, so cookies may be `Secure`. */
  readonly secureTransport: boolean;
  /** Test doubles are refused unless the environment explicitly allows them. */
  readonly testOnly: boolean;
  /** Read-only: is the CLI installed? Never executes it. */
  detect(): { installed: boolean; path: string | null; note: string };
  /** Pure: no I/O that changes anything. */
  plan(input: { port: number; httpsPort: number }): TunnelPlan;
  start(plan: TunnelPlan): Promise<{ hostname: string }>;
  stop(plan: TunnelPlan): Promise<void>;
  probe(plan: TunnelPlan): Promise<TunnelProbe>;
}

export type Exec = (command: string, args: readonly string[], o?: { timeoutMs?: number }) => Promise<ExecResult>;

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** The only private-access shapes One Connect will ever run. Anything else, and any public listener, is refused. */
export function assertPrivatePlan(plan: Pick<TunnelPlan, 'start' | 'teardown' | 'port'>): void {
  for (const c of [...plan.start, ...plan.teardown]) {
    if (c.args.some(a => /funnel|--set-path|--tun|0\.0\.0\.0|\*:/i.test(a))) throw new Error('Public or wildcard exposure is never allowed for phone access.');
    for (const a of c.args) if (/^https?:\/\//.test(a) && !new RegExp(`^http://127\\.0\\.0\\.1:${plan.port}$`).test(a)) throw new Error('A tunnel may only forward to the loopback daemon.');
  }
}

const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export class TailscaleAdapter implements TunnelAdapter {
  readonly id = 'tailscale' as const;
  readonly title = 'Tailscale Serve (private to your tailnet)';
  readonly secureTransport = true;
  readonly testOnly = false;
  private exec: Exec;
  private envPath: string;
  constructor(o: { exec?: Exec; envPath?: string } = {}) {
    this.exec = o.exec ?? ((c, a, x) => run(c, a, { timeoutMs: 15_000, ...x }));
    this.envPath = o.envPath ?? process.env.PATH ?? '';
  }

  private binary(): string | null {
    const found = whichAll(['tailscale'], this.envPath)[0];
    if (found) return found;
    try { fs.accessSync(TAILSCALE_APP, fs.constants.X_OK); return TAILSCALE_APP; } catch { return null; }
  }

  detect() {
    const p = this.binary();
    return p ? { installed: true, path: p, note: 'Tailscale CLI found. It has not been run. Whether this Mac is signed in to a tailnet is only known after you approve a launch.' } : { installed: false, path: null, note: 'Tailscale CLI not found. Install Tailscale and sign in yourself; One Connect never installs or signs in for you.' };
  }

  plan({ port, httpsPort }: { port: number; httpsPort: number }): TunnelPlan {
    const bin = this.binary() ?? 'tailscale';
    const body = {
      adapter: this.id, title: this.title, port,
      start: [{ command: bin, args: ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${port}`] }],
      teardown: [{ command: bin, args: ['serve', `--https=${httpsPort}`, 'off'] }],
      hostname: null,
      exposes: `HTTPS port ${httpsPort} on this Mac’s tailnet name, forwarding to http://127.0.0.1:${port}. Reachable only by devices signed in to the same tailnet and allowed by its access rules. Not the public internet.`,
      publicInternet: false as const, touchesTailnet: true, secureTransport: true, testOnly: false,
      warnings: [
        'Starting Tailscale Serve changes this Mac’s Serve configuration for that HTTPS port. It does not change tailnet ACLs, keys or devices.',
        'Tailscale ACLs decide which of your devices can reach the port. Review them in Tailscale; One Connect cannot see or change them.',
        'Real-provider validation is pending: this plan has been tested against a loopback fixture, not a live tailnet.',
      ],
    };
    assertPrivatePlan(body);
    return { ...body, digest: digest(body) };
  }

  async start(plan: TunnelPlan): Promise<{ hostname: string }> {
    assertPrivatePlan(plan);
    const status = await this.exec(plan.start[0].command, ['status', '--json']);
    if (status.code !== 0) throw new Error('Tailscale is not running or not signed in; nothing was changed.');
    const name = parseDnsName(status.stdout);
    if (!name) throw new Error('Tailscale did not report a tailnet name for this Mac; nothing was changed.');
    const r = await this.exec(plan.start[0].command, plan.start[0].args);
    if (r.code !== 0) throw new Error(`tailscale serve failed (exit ${r.code ?? 'none'}).`);
    const httpsPort = plan.start[0].args.find(a => a.startsWith('--https='))?.slice(8) ?? '443';
    return { hostname: httpsPort === '443' ? name : `${name}:${httpsPort}` };
  }

  async stop(plan: TunnelPlan): Promise<void> {
    assertPrivatePlan(plan);
    const r = await this.exec(plan.teardown[0].command, plan.teardown[0].args);
    if (r.code !== 0) throw new Error(`tailscale serve teardown failed (exit ${r.code ?? 'none'}).`);
  }

  async probe(plan: TunnelPlan): Promise<TunnelProbe> {
    const r = await this.exec(plan.start[0].command, ['status', '--json']);
    if (r.code !== 0) return { state: 'stopped', hostname: null, detail: 'tailscale status failed; the tunnel is not confirmed.' };
    try {
      const j = JSON.parse(r.stdout) as { BackendState?: string };
      const name = parseDnsName(r.stdout);
      return j.BackendState === 'Running' ? { state: 'running', hostname: name, detail: 'Tailscale reports it is running. This does not prove your phone can reach the daemon.' } : { state: 'stopped', hostname: name, detail: `Tailscale backend state: ${j.BackendState ?? 'unknown'}.` };
    } catch {
      return { state: 'unknown', hostname: null, detail: 'Could not read tailscale status.' };
    }
  }
}

export function parseDnsName(stdout: string): string | null {
  try {
    const j = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    const n = j.Self?.DNSName?.replace(/\.$/, '');
    return n && /^[a-z0-9.-]+$/i.test(n) ? n.toLowerCase() : null;
  } catch { return null; }
}

/** Loopback test double. No process, no network; the "tunnel" is a Host name the test sends. */
export class FixtureAdapter implements TunnelAdapter {
  readonly id = 'fixture' as const;
  readonly title = 'Loopback fixture (tests only)';
  readonly secureTransport = false;
  readonly testOnly = true;
  running = false;
  hostname: string;
  failStart = false;
  constructor(hostname = 'phone.fixture.test') { this.hostname = hostname; }
  detect() { return { installed: true, path: null, note: 'Test double; it never opens a port or a tunnel.' }; }
  plan({ port }: { port: number; httpsPort: number }): TunnelPlan {
    const body = { adapter: this.id, title: this.title, port, start: [], teardown: [], hostname: this.hostname, exposes: `Nothing. A loopback test double for http://127.0.0.1:${port}.`, publicInternet: false as const, touchesTailnet: false, secureTransport: false, testOnly: true, warnings: ['Test double: no real access is created.'] };
    return { ...body, digest: digest(body) };
  }
  async start(): Promise<{ hostname: string }> {
    if (this.failStart) throw new Error('fixture failed to start');
    this.running = true;
    return { hostname: this.hostname };
  }
  async stop(): Promise<void> { this.running = false; }
  async probe(): Promise<TunnelProbe> { return this.running ? { state: 'running', hostname: this.hostname, detail: 'Fixture is up.' } : { state: 'stopped', hostname: this.hostname, detail: 'Fixture is down.' }; }
}
