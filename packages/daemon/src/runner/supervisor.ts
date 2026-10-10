// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Launches detached runners, tails their durable logs into events, reattaches after a daemon
// restart (verifying PID identity so a reused PID is never mistaken for our run), and kills
// process groups for stop / kill switch.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchSpec } from '../adapters/agents/types.ts';

export const RUNNER_PATH = fileURLToPath(new URL('./runner.ts', import.meta.url));

export interface RunnerInfo {
  runnerPid: number;
  childPid: number | null;
  runDir: string;
  startedAt: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  error?: string;
  endedAt?: string;
  orphaned?: boolean;
}

export interface TailOffsets {
  stdout: number;
  stderr: number;
}

export interface SupervisorHooks {
  /** Process new complete lines; must persist `offsets` atomically with the resulting events. */
  onLines(runId: string, lines: { stream: 'stdout' | 'stderr'; line: string }[], offsets: TailOffsets): void;
  /** Token-delta lines for the live view (not persisted; may be skipped after a restart). */
  onLive?(runId: string, lines: string[]): void;
  onExit(runId: string, exit: ExitInfo): void;
  getOffsets(runId: string): TailOffsets;
}

const readJson = <T>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
};

export class Supervisor {
  private tails = new Map<string, { runDir: string; offsets: TailOffsets; liveOffset: number }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  private runsRoot: string;
  private hooks: SupervisorHooks;
  private pollMs: number;

  constructor(runsRoot: string, hooks: SupervisorHooks, pollMs = 200) {
    this.runsRoot = runsRoot;
    this.hooks = hooks;
    this.pollMs = pollMs;
  }

  runDir(runId: string): string {
    return path.join(this.runsRoot, runId);
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async launch(runId: string, spec: LaunchSpec, opts: { env: NodeJS.ProcessEnv; denylist: string[] }): Promise<RunnerInfo> {
    const dir = this.runDir(runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of spec.files ?? []) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.content, { mode: f.mode ?? 0o600 });
    }
    // spec.json holds command/args/cwd only. Env and redaction values never touch disk.
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd, stdin: spec.stdin, ephemeralMatch: spec.ephemeralMatch }), { mode: 0o600 });
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', RUNNER_PATH, dir], {
      detached: true,
      cwd: dir,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...opts.env, ...(spec.env ?? {}) },
    });
    child.stdin!.end(JSON.stringify({ denylist: opts.denylist }));
    child.unref();
    const info = await waitFor(() => readJson<RunnerInfo>(path.join(dir, 'runner.json')) ?? (fs.existsSync(path.join(dir, 'exit.json')) ? ({ runnerPid: child.pid ?? 0, childPid: null, runDir: dir, startedAt: new Date().toISOString() } as RunnerInfo) : null), 15_000);
    if (!info) throw new Error(`runner for ${runId} did not start`);
    this.attach(runId, true);
    return info;
  }

  /** Start (or resume) tailing a run directory from the stored offsets. */
  attach(runId: string, fresh = false): void {
    const runDir = this.runDir(runId);
    // A fresh launch replays live deltas from the start; a reattach skips what was missed.
    let liveOffset = 0;
    if (!fresh) {
      try {
        liveOffset = fs.statSync(path.join(runDir, 'live.jsonl')).size;
      } catch {
        liveOffset = 0;
      }
    }
    this.tails.set(runId, { runDir, offsets: this.hooks.getOffsets(runId), liveOffset });
    this.start();
  }

  isTailing(runId: string): boolean {
    return this.tails.has(runId);
  }

  info(runId: string): RunnerInfo | null {
    return readJson<RunnerInfo>(path.join(this.runDir(runId), 'runner.json'));
  }

  exitInfo(runId: string): ExitInfo | null {
    return readJson<ExitInfo>(path.join(this.runDir(runId), 'exit.json'));
  }

  /** True only if the runner PID is alive AND its command line is this run's runner. */
  isAlive(runId: string): boolean {
    const info = this.info(runId);
    if (!info) return false;
    return processMatches(info.runnerPid, info.runDir);
  }

  /** After a restart: reattach live runs; report dead ones as exited or orphaned. */
  recover(runId: string): 'reattached' | 'exited' | 'orphaned' | 'missing' {
    const dir = this.runDir(runId);
    if (!fs.existsSync(dir)) return 'missing';
    if (this.isAlive(runId)) {
      this.attach(runId);
      return 'reattached';
    }
    if (fs.existsSync(path.join(dir, 'exit.json'))) {
      this.attach(runId); // drain remaining lines, then onExit fires from poll()
      return 'exited';
    }
    this.attach(runId);
    this.drain(runId);
    this.tails.delete(runId);
    this.hooks.onExit(runId, { code: null, signal: null, orphaned: true, error: 'runner died without recording an exit (machine restart or kill -9)' });
    return 'orphaned';
  }

  send(runId: string, line: string): void {
    fs.appendFileSync(path.join(this.runDir(runId), 'inbox.jsonl'), line.replace(/\n/g, ' ') + '\n', { mode: 0o600 });
  }

  undelivered(runId: string): string[] {
    const f = path.join(this.runDir(runId), 'inbox.undelivered.jsonl');
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    fs.rmSync(f);
    return lines;
  }

  /** Signal the whole process group (runner is the group leader). */
  signal(runId: string, sig: NodeJS.Signals = 'SIGTERM'): boolean {
    const info = this.info(runId);
    if (!info || !processMatches(info.runnerPid, info.runDir)) return false;
    try {
      process.kill(-info.runnerPid, sig);
      return true;
    } catch {
      try {
        process.kill(info.runnerPid, sig);
        return true;
      } catch {
        return false;
      }
    }
  }

  async stop(runId: string, graceMs = 6000): Promise<void> {
    if (!this.signal(runId, 'SIGTERM')) return;
    const gone = await waitFor(() => (this.isAlive(runId) ? null : true), graceMs);
    if (!gone) this.signal(runId, 'SIGKILL');
  }

  poll(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const runId of [...this.tails.keys()]) {
        const exited = fs.existsSync(path.join(this.runDir(runId), 'exit.json'));
        this.drain(runId);
        if (exited) {
          this.drain(runId);
          this.tails.delete(runId);
          fs.rmSync(path.join(this.runDir(runId), 'live.jsonl'), { force: true });
          this.hooks.onExit(runId, this.exitInfo(runId) ?? { code: null, signal: null });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Read complete new lines from both logs and hand them to the daemon. */
  drain(runId: string): void {
    const t = this.tails.get(runId);
    if (!t) return;
    if (this.hooks.onLive) {
      const live = readNewLines(path.join(t.runDir, 'live.jsonl'), t.liveOffset);
      t.liveOffset = live.offset;
      if (live.lines.length) this.hooks.onLive(runId, live.lines);
    }
    const next = { ...t.offsets };
    const lines: { stream: 'stdout' | 'stderr'; line: string }[] = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      const f = path.join(t.runDir, stream === 'stdout' ? 'stdout.jsonl' : 'stderr.log');
      const r = readNewLines(f, next[stream]);
      next[stream] = r.offset;
      for (const line of r.lines) lines.push({ stream, line });
    }
    if (lines.length === 0) return;
    this.hooks.onLines(runId, lines, next);
    t.offsets = next;
  }
}

export function readNewLines(file: string, offset: number): { lines: string[]; offset: number } {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { lines: [], offset };
  }
  if (st.size <= offset) return { lines: [], offset };
  const len = Math.min(st.size - offset, 4 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, offset);
  } finally {
    fs.closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { lines: [], offset };
  const text = buf.subarray(0, end).toString('utf8');
  return { lines: text.split('\n'), offset: offset + end + 1 };
}

export function processMatches(pid: number, runDir: string): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes(runDir);
}

async function waitFor<T>(fn: () => T | null, timeoutMs: number, stepMs = 50): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Used by `acc kill-all` when the daemon is down: stop every live runner under runsRoot. */
export function killAllRunners(runsRoot: string): number {
  let n = 0;
  if (!fs.existsSync(runsRoot)) return 0;
  for (const id of fs.readdirSync(runsRoot)) {
    const dir = path.join(runsRoot, id);
    const info = readJson<RunnerInfo>(path.join(dir, 'runner.json'));
    if (!info || fs.existsSync(path.join(dir, 'exit.json'))) continue;
    if (!processMatches(info.runnerPid, info.runDir)) continue;
    try {
      process.kill(-info.runnerPid, 'SIGKILL');
      n++;
    } catch {
      /* gone */
    }
  }
  return n;
}
