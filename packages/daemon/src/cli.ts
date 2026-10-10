#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// acc: the One Connect command line.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEvent, emptyState, LIFECYCLE_LABELS } from '@acc/core';
import { ConfigError, findConfig, loadConfig } from './config.ts';
import { Daemon } from './daemon.ts';
import { runChecks } from './checks.ts';
import { git, revParse } from './adapters/vcs/git.ts';
import { detectVendors } from './onboarding.ts';
import { defaultDataDir, isUnderTemp, resolveDataPaths, TempDataDirError } from './paths.ts';
import { killAllRunners } from './runner/supervisor.ts';
import { createServer } from './server/http.ts';
import { EventStore } from './store/eventStore.ts';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

/** Data dirs to look for a running daemon in: --data-dir, ACC_DATA_DIR / default, then the demo's. */
function candidateDataDirs(): string[] {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.local', 'state');
  const demo = path.join(process.env.ACC_DEMO_DIR ?? path.join(base, 'AgentControlCenter-demo'), 'state');
  return [...new Set([flag('data-dir'), defaultDataDir(), demo].filter((d): d is string => Boolean(d)).map((d) => path.resolve(d)))];
}

interface DaemonInfo {
  url: string;
  pid: number;
  dataDir: string;
}

let found: DaemonInfo | null | undefined;
/** The first data dir whose daemon.json points at a daemon that answers. */
async function daemonInfo(): Promise<DaemonInfo | null> {
  if (found !== undefined) return found;
  for (const dataDir of candidateDataDirs()) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as { url: string; pid: number };
      const ok = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
      if (ok) return (found = { ...info, dataDir });
    } catch {
      /* not this one */
    }
  }
  return (found = null);
}

async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  const info = await daemonInfo();
  if (!info) throw new Error(`no running daemon found (looked in ${candidateDataDirs().join(', ')}). Start it with \`acc daemon\` or \`pnpm demo\`.`);
  const token = fs.readFileSync(path.join(info.dataDir, 'secrets', 'install-token'), 'utf8').trim();
  return fetch(`${info.url}${pathname}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

function openBrowser(url: string) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
}

async function main() {
  switch (cmd) {
    case 'daemon': {
      const cfgPath = findConfig(flag('config'));
      const config = loadConfig(cfgPath);
      const d = new Daemon({ config, probe: !has('no-probe') });
      const port = Number(flag('port') ?? process.env.ACC_PORT ?? config.server.port);
      const devOrigins = process.env.ACC_DEV_ORIGIN ? process.env.ACC_DEV_ORIGIN.split(',') : ['http://localhost:5173', 'http://127.0.0.1:5173'];
      const srv = await createServer(d, { port, devOrigins });
      await d.start();
      fs.writeFileSync(path.join(d.paths.root, 'daemon.json'), JSON.stringify({ url: srv.url, pid: process.pid, startedAt: new Date().toISOString(), config: cfgPath }));
      console.log(`One Connect ${srv.url}`);
      console.log(`  config   ${cfgPath}`);
      console.log(`  data     ${d.paths.root}`);
      console.log(`  tracker  ${d.tracker.target}${d.tracker.live ? '' : ' (dry run: not live)'}`);
      if (process.env.ACC_DESKTOP !== '1') console.log(`  sign in  ${srv.url}/auth?code=${srv.issueCode()}   (one-time link; later: acc open)`);
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        console.log('\nshutting down (agent runs keep going and are reattached on next start)…');
        try {
          await srv.app.close();
          await d.shutdown();
          fs.rmSync(path.join(d.paths.root, 'daemon.json'), { force: true });
        } catch (e) {
          console.error(`shutdown: ${(e as Error).message}`);
        }
        process.exit(0);
      };
      d.bus.on('shutdown', stop);
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'check': {
      const config = loadConfig(findConfig(flag('config')));
      const repo = config.project.repo;
      const cwd = flag('worktree') ? path.resolve(flag('worktree')!) : repo;
      const sha = await revParse(cwd, flag('sha') ?? 'HEAD');
      const names = flag('only') ? flag('only')!.split(',') : config.project.required_checks ?? Object.keys(config.project.checks);
      if (!names.length) throw new Error('no required checks configured');
      const logDir = path.resolve(flag('log-dir') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'one-connect-check-logs-')));
      const denylist = config.policies.redact_env.map(name => process.env[name]).filter((s): s is string => Boolean(s));
      const results = await runChecks({ cwd, repo, sha, runtime: config.project.check_runtime, checks: names.map(name => ({ name, command: config.project.checks[name] ?? '' })), logDir, env: { PATH: process.env.PATH }, denylist });
      console.log(JSON.stringify({ sha, results }, null, 2));
      if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
      return;
    }
    case 'open': {
      const r = await api('/api/auth/code', { method: 'POST', body: '{}' });
      if (!r.ok) throw new Error(`daemon refused: ${r.status} ${await r.text()}`);
      const { code } = (await r.json()) as { code: string };
      const url = `${(await daemonInfo())!.url}/auth?code=${code}`;
      console.log(`${url}\n(one-time link, valid for 2 minutes)`);
      if (!has('print')) openBrowser(url);
      return;
    }
    case 'onboard': {
      let configured: { adapter: string; id: string }[] = [];
      try {
        configured = loadConfig(findConfig(flag('config'))).agents.map((a) => ({ adapter: a.adapter, id: a.id }));
      } catch {
        /* no config yet */
      }
      const vendors = await detectVendors(configured);
      console.log('Vendor CLIs on this machine (the control center never bundles or proxies them):\n');
      for (const v of vendors) {
        console.log(`${v.displayName}`);
        if (v.candidates.length === 0) console.log(`  not installed: ${v.installUrl}`);
        for (const c of v.candidates) console.log(`  ${c === v.pinned ? '*' : ' '} ${c.path}  ${c.version ?? '?'}${c.prerelease ? ' (prerelease)' : ''}  [${c.source}]`);
        if (v.newer) console.log(`  ! newer build available: ${v.newer.path} ${v.newer.version}; pin it with \`binary:\` to use it`);
        console.log(`  login: ${v.loginHint}`);
        console.log(`  configured agents: ${v.configuredAgents.join(', ') || 'none'}\n`);
      }
      console.log('Check your own plan terms for automated use. Turn paid overage / on-demand / auto-recharge off in each vendor account.');
      return;
    }
    case 'doctor': {
      const root = defaultDataDir();
      console.log(`data dir   ${root} ${isUnderTemp(root) ? '✗ inside a temp dir (logs would be lost)' : '✓ durable'}`);
      let cfgPath: string;
      try {
        cfgPath = findConfig(flag('config'));
        const c = loadConfig(cfgPath);
        console.log(`config     ${cfgPath} ✓`);
        const repo = await git(c.project.repo, ['rev-parse', '--show-toplevel'], { allowFail: true });
        console.log(`repo       ${c.project.repo} ${repo.code === 0 ? '✓' : '✗ not a git repo'}`);
        for (const b of [c.project.integration_branch, ...c.project.protected_branches]) {
          const r = await git(c.project.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true });
          console.log(`  branch   ${b} ${r.code === 0 ? '✓' : '– not created yet'}`);
        }
        console.log(`tracker    ${c.tracker.type}${'live' in c.tracker ? (c.tracker.live ? ' (live)' : ' (dry run)') : ''}`);
        console.log(`agents     ${c.agents.map((a) => `${a.id}:${a.adapter}`).join(', ')}`);
      } catch (e) {
        console.log(`config     ✗ ${(e as Error).message}`);
      }
      const info = await daemonInfo();
      console.log(`daemon     ${info ? `${info.url} (pid ${info.pid}, data ${info.dataDir})` : 'not running'}`);
      return;
    }
    case 'status': {
      const r = await api('/api/state');
      const { state } = (await r.json()) as { state: ReturnType<typeof emptyState> };
      for (const a of Object.values(state.agents)) {
        const now = a.queue.now ? state.assignments[a.queue.now] : null;
        const item = now ? state.workItems[now.workItemId] : null;
        console.log(`${a.config.name.padEnd(14)} ${a.status.padEnd(9)} ${item ? `${item.key} ${item.title}` : '-'}   next: ${a.queue.next.length}`);
      }
      const open = Object.values(state.alerts).filter((x) => !x.resolvedAt);
      if (open.length) console.log(`\n${open.length} open alert(s):\n${open.map((x) => `  [${x.severity}] ${x.message}`).join('\n')}`);
      void LIFECYCLE_LABELS;
      return;
    }
    case 'kill-all': {
      try {
        const r = await api('/api/kill-switch', { method: 'POST', body: JSON.stringify({ engaged: true }) });
        const j = (await r.json()) as { stopped: number };
        console.log(`kill switch engaged: ${j.stopped} run(s) stopped. Release it in the UI or with \`acc release\`.`);
      } catch (e) {
        const n = killAllRunners(resolveDataPaths().runs);
        console.log(`daemon unreachable (${(e as Error).message}); killed ${n} runner process group(s) directly.`);
      }
      return;
    }
    case 'release': {
      await api('/api/kill-switch', { method: 'POST', body: JSON.stringify({ engaged: false }) });
      console.log('kill switch released');
      return;
    }
    case 'context': {
      const sub = argv[1];
      if (sub === 'sync') {
        const r = await api('/api/context/sync', { method: 'POST', body: '{}' });
        const g = await api('/api/context/graph/rebuild', { method: 'POST', body: '{}' });
        console.log(`notes written: ${((await r.json()) as { written: number }).written}`);
        console.log(`graph: ${JSON.stringify(((await g.json()) as { graph: unknown }).graph)}`);
      } else if (sub === 'query') {
        const r = await api('/api/context/query', { method: 'POST', body: JSON.stringify({ query: argv.slice(2).join(' ') }) });
        const j = (await r.json()) as { notes: { backend: string; hits: { path: string; snippet: string }[] } | null; graph: string | null; error?: string };
        if (j.error) throw new Error(j.error);
        if (j.notes) for (const h of j.notes.hits) console.log(`note  ${h.path}\n      ${h.snippet}`);
        if (j.graph) console.log(`\n${j.graph}`);
      } else {
        const r = await api('/api/context');
        const j = (await r.json()) as { vault: unknown; graph: unknown };
        console.log(JSON.stringify({ vault: j.vault, graph: j.graph }, null, 2));
      }
      return;
    }
    case 'project': {
      // Machine interface for the native project registry: one JSON object on stdout.
      const { projectCommand } = await import('./projects/command.ts');
      const result = await projectCommand(argv[1] ?? '', flag);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'bench': {
      // acc bench context [--graphify <bin>] [--embedding-model <name>] [--json]
      if (argv[1] !== 'context') { console.error('usage: acc bench context [--graphify bin] [--embedding-model name] [--json]'); process.exit(2); }
      const { runContextBenchmark } = await import('./benchmark/contextBenchmark.ts');
      const r = await runContextBenchmark({ graphifyBinary: flag('graphify'), embeddingModel: flag('embedding-model') });
      if (has('json')) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`Context benchmark on the disposable ${r.corpus.name} corpus (${r.corpus.files} files, ${r.corpus.bytes} bytes, ${r.corpus.questions} labelled questions)`);
        for (const a of r.arms) console.log(`  ${a.status === 'measured' ? '' : '[not measured] '}${a.label}: ${a.status === 'measured' ? `${a.contextBytesPerQuestion} B/question (~${a.estimatedTokensPerQuestion} est. tokens), p50 ${a.latencyMsP50} ms, accuracy ${a.retrievalAccuracy === null ? 'n/a' : `${Math.round(100 * a.retrievalAccuracy)}%`}, citations ${a.citationIntegrity === null ? 'n/a' : `${Math.round(100 * a.citationIntegrity)}%`}, abstention ${a.abstentionAccuracy === null ? 'n/a' : `${Math.round(100 * a.abstentionAccuracy)}%`}` : a.reason}`);
        console.log('  Token figures are bytes/4 estimates, not provider-reported usage.');
        for (const c of r.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
        console.log(r.regressions.length ? `REGRESSIONS:\n  ${r.regressions.join('\n  ')}` : 'No regressions on this evaluation set.');
      }
      process.exit(r.regressions.length ? 1 : 0);
      return;
    }
    case 'rebuild': {
      const p = resolveDataPaths();
      const store = new EventStore(p.db);
      store.clearSnapshots();
      let s = emptyState();
      let n = 0;
      for (const e of store.iterate()) {
        s = applyEvent(s, e);
        n++;
      }
      store.saveSnapshot(s);
      store.close();
      console.log(`replayed ${n} events → ${Object.keys(s.workItems).length} work items, ${Object.keys(s.runs).length} runs`);
      return;
    }
    default:
      console.log(`acc: One Connect

  acc daemon [--config f] [--port n]   start the supervisor + UI (127.0.0.1 only)
  acc open [--print] [--data-dir d]    sign the browser in (one-time link; finds the demo too)
  acc onboard                          detect vendor CLIs, versions, login commands
  acc doctor                           check data dir, config, repo, tracker
  acc check --config f [--sha ref] [--worktree d] [--only test,lint] [--log-dir d]
                                       run committed-source checks in configured Docker
  acc status                           agents, Now/Next, open alerts
  acc kill-all | acc release           stop every run instantly / release the kill switch
  acc context [sync | query <text>]    shared context: Obsidian notes + graphify code graph
  acc bench context [--graphify bin]   context-quality benchmark on a disposable fixture corpus
  acc rebuild                          rebuild state by replaying the event log
  acc project inspect --dir d          describe a repository for onboarding (JSON; runs no scripts)
  acc project prepare --dir d --config-dir c   bind a repository and write its generated config`);
  }
}

main().catch((e) => {
  if (e instanceof ConfigError || e instanceof TempDataDirError) console.error(e.message);
  else console.error(e);
  process.exit(1);
});
