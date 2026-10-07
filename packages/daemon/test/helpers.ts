// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type ControlCenterConfig } from '@acc/core';
import { HOST_FIXTURE_MARKER, HOST_FIXTURE_NOTICE } from '../src/checks.ts';
import { Daemon, type DaemonOptions } from '../src/daemon.ts';
import { createServer } from '../src/server/http.ts';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const FAKE_BIN = path.join(ROOT, 'examples', 'fake-agent', 'bin');

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `acc-${prefix}-`));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
}

/** A fresh git repo seeded from examples/sample-repo with main + integration branches. */
export function makeRepo(): string {
  const dir = tmpDir('repo');
  fs.cpSync(path.join(ROOT, 'examples', 'sample-repo'), dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  git(dir, 'branch', 'integration');
  fs.writeFileSync(path.join(dir, '.git', HOST_FIXTURE_MARKER), HOST_FIXTURE_NOTICE + '\n');
  return dir;
}

export function makeConfig(repo: string, over: Record<string, unknown> = {}): ControlCenterConfig {
  return parseConfig({
    project: { name: 'sample', repo, integration_branch: 'integration', protected_branches: ['main'], checks: { test: 'node --test' }, check_runtime: { mode: 'host-fixture', fixture_repo: repo } },
    tracker: { type: 'local' },
    policies: { stall: { no_event_minutes: 10, approval_pending_minutes: 15 }, quality_floor: {} },
    graphify:{enabled:false},
    agents: [
      { id: 'claude', name: 'Claude Code', role: 'engineer', adapter: 'claude-headless', binary: path.join(FAKE_BIN, 'claude'), model: 'newest', model_family: 'opus', effort: 'high' },
      { id: 'codex', name: 'Codex', role: 'engineer', adapter: 'codex-cli', binary: path.join(FAKE_BIN, 'codex'), model: 'newest', effort: 'high' },
      { id: 'cursor', name: 'Cursor', role: 'engineer', adapter: 'cursor-agent-cli', binary: path.join(FAKE_BIN, 'cursor-agent'), model: 'newest', model_family: 'claude-opus', effort: 'high' },
      { id: 'ag', name: 'Antigravity', role: 'engineer', adapter: 'relay' },
    ],
    ...over,
  });
}

export interface Harness {
  d: Daemon;
  url: string;
  dataDir: string;
  close(): Promise<void>;
}

export async function startDaemon(config: ControlCenterConfig, o: Partial<DaemonOptions> & { dataDir?: string; server?: boolean; confirmFixtureSubscriptions?: boolean } = {}): Promise<Harness> {
  const dataDir = o.dataDir ?? tmpDir('data');
  const d = new Daemon({ config, allowTempDataDir: true, rulesTickMs: 3_600_000, outboxTickMs: 100, supervisorPollMs: 50, ...o, dataDir });
  // Only these repository-owned fake CLIs are zero-cost protocol fixtures. Tests explicitly
  // attest their settings after each probe; real vendor binaries never inherit this permission.
  if (o.confirmFixtureSubscriptions !== false) {
    const probe = d.probe.bind(d);
    d.probe = async id => {
      await probe(id);
      const a = d.state.agents[id];
      if (a?.config.binary && path.dirname(a.config.binary) === FAKE_BIN && a.billing.mode === 'subscription' && a.billing.overage === 'unknown' && a.auth.state === 'logged_in') d.subscriptionSafety.confirm(id, true);
    };
  }
  d.rules.retryDelayMs = 0;
  d.rules.connectivity = async () => true;
  let close = async () => {};
  let url = '';
  if (o.server !== false) {
    const srv = await createServer(d, { port: 0 });
    url = srv.url;
    close = async () => {
      await srv.app.close();
    };
  }
  await d.start();
  // A restart invalidates subscription confirmations (by design); re-attest only the scripted fixtures.
  if (o.confirmFixtureSubscriptions !== false) {
    for (const a of Object.values(d.state.agents)) {
      if (a.config.binary && path.dirname(a.config.binary) === FAKE_BIN && a.billing.mode === 'subscription' && a.billing.overage === 'unknown' && a.auth.state === 'logged_in') d.subscriptionSafety.confirm(a.id, true);
    }
  }
  await d.context.answer.refresh(false);
  return {
    d,
    url,
    dataDir,
    async close() {
      await d.setKillSwitch(true).catch(() => undefined);
      await close();
      await d.shutdown();
    },
  };
}

export async function waitFor<T>(fn: () => T | null | undefined | false, ms = 20_000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
