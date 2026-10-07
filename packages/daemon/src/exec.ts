// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?:AbortSignal;
}

/** Run a command without a shell. Never throws; inspect `code` / `error`. */
export function run(cmd: string, args: readonly string[], o: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const max = o.maxBytes ?? 8 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: ExecResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, signal:o.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      done({ code: null, stdout: '', stderr: '', timedOut: false, error: (e as Error).message });
      return;
    }
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, o.timeoutMs)
      : null;
    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length < max) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < max) stderr += b.toString('utf8');
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      done({ code: null, stdout, stderr, timedOut, error: e.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    if (o.input !== undefined) child.stdin.end(o.input);
    else child.stdin.end();
  });
}

/** Run through `sh -c` (for configured check commands like "npm test && npm run lint"). */
export function runShell(command: string, o: ExecOptions = {}): Promise<ExecResult> {
  return run('/bin/sh', ['-c', command], o);
}
