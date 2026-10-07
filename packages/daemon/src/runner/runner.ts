// SPDX-License-Identifier: Apache-2.0
// Per-run wrapper process, started detached so agent runs survive daemon restarts.
//
//   node runner.ts <runDir>     (redaction config arrives on stdin, never on disk or argv)
//
// It spawns the vendor CLI, redacts every output line BEFORE it touches disk, appends to
// stdout.jsonl / stderr.log in the durable run dir, forwards inbox.jsonl lines to the child's
// stdin (streaming adapters), and records exit.json when the child ends.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLineRedactor } from '@acc/core';

interface RunnerSpec {
  command: string;
  args: string[];
  cwd: string;
  stdin: { mode: 'close' | 'stream' | 'none'; initial?: string; closeOnMatch?: string };
  /** Stdout lines containing this go to live.jsonl (token deltas for the live view), not the evidence log. */
  ephemeralMatch?: string;
}

const runDir = process.argv[2];
if (!runDir) {
  process.stderr.write('usage: runner.ts <runDir>\n');
  process.exit(2);
}

const file = (n: string) => path.join(runDir, n);

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

function writeJson(name: string, v: unknown) {
  const tmp = file(`${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, file(name));
}

async function main() {
  const cfgRaw = await readStdin();
  let denylist: string[] = [];
  try {
    denylist = (JSON.parse(cfgRaw || '{}') as { denylist?: string[] }).denylist ?? [];
  } catch {
    /* no redaction extras */
  }
  const spec = JSON.parse(fs.readFileSync(file('spec.json'), 'utf8')) as RunnerSpec;
  const outFd = fs.openSync(file('stdout.jsonl'), 'a', 0o600);
  const liveFd = spec.ephemeralMatch ? fs.openSync(file('live.jsonl'), 'a', 0o600) : null;
  const redactLive = createLineRedactor({ denylist });
  const errFd = fs.openSync(file('stderr.log'), 'a', 0o600);
  const redactOut = createLineRedactor({ denylist });
  const redactErr = createLineRedactor({ denylist });

  const write = (fd: number, red: ReturnType<typeof createLineRedactor>, line: string) => {
    fs.writeSync(fd, red(line).text + '\n');
  };

  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      stdio: [spec.stdin.mode === 'none' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    write(errFd, redactErr, `runner: failed to start ${spec.command}: ${(e as Error).message}`);
    writeJson('exit.json', { code: null, signal: null, error: (e as Error).message, endedAt: new Date().toISOString() });
    process.exit(0);
  }

  writeJson('runner.json', { runnerPid: process.pid, childPid: child.pid ?? null, runDir, startedAt: new Date().toISOString(), command: spec.command });

  let stdinOpen = spec.stdin.mode !== 'none' && Boolean(child.stdin);
  const closeStdin = () => {
    if (stdinOpen && child.stdin) {
      stdinOpen = false;
      child.stdin.end();
    }
  };
  child.stdin?.on('error', () => {
    stdinOpen = false;
  });

  if (spec.stdin.mode === 'close') {
    child.stdin?.end(spec.stdin.initial ?? '');
    stdinOpen = false;
  } else if (spec.stdin.mode === 'stream') {
    child.stdin?.write((spec.stdin.initial ?? '') + '\n');
  }

  // inbox.jsonl → child stdin (stream mode). Lines that arrive after stdin closed are kept for a follow-up.
  let inboxOffset = 0;
  let resultSeen = false;
  const pumpInbox = (): number => {
    let delivered = 0;
    let st: fs.Stats;
    try {
      st = fs.statSync(file('inbox.jsonl'));
    } catch {
      return 0;
    }
    if (st.size <= inboxOffset) return 0;
    const fd = fs.openSync(file('inbox.jsonl'), 'r');
    const buf = Buffer.alloc(st.size - inboxOffset);
    fs.readSync(fd, buf, 0, buf.length, inboxOffset);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return 0;
    inboxOffset += Buffer.byteLength(text.slice(0, end + 1));
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.trim()) continue;
      if (stdinOpen && child.stdin) {
        child.stdin.write(line + '\n');
        delivered++;
        resultSeen = false;
      } else fs.appendFileSync(file('inbox.undelivered.jsonl'), line + '\n');
    }
    return delivered;
  };
  const inboxTimer = spec.stdin.mode === 'stream' ? setInterval(() => {
    pumpInbox();
    if (resultSeen) closeStdin();
  }, 300) : null;

  const ephemeral = spec.ephemeralMatch;
  const route = (fd: number, red: ReturnType<typeof createLineRedactor>, line: string) => {
    if (liveFd !== null && ephemeral && fd === outFd && line.includes(ephemeral)) write(liveFd, redactLive, line);
    else write(fd, red, line);
  };
  const splitter = (fd: number, red: ReturnType<typeof createLineRedactor>, onLine?: (l: string) => void) => {
    let rest = '';
    return {
      data(b: Buffer) {
        rest += b.toString('utf8');
        let i: number;
        while ((i = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, i).replace(/\r$/, '');
          rest = rest.slice(i + 1);
          route(fd, red, line);
          onLine?.(line);
        }
      },
      flush() {
        if (rest) {
          route(fd, red, rest);
          onLine?.(rest);
          rest = '';
        }
      },
    };
  };
  const matchClose = spec.stdin.closeOnMatch;
  const out = splitter(outFd, redactOut, matchClose ? (l) => {
    if (l.includes(matchClose)) {
      resultSeen = true;
      // Give a just-written inbox line one chance to be delivered before closing.
      if (pumpInbox() === 0) closeStdin();
    }
  } : undefined);
  const err = splitter(errFd, redactErr);
  child.stdout?.on('data', (b: Buffer) => out.data(b));
  child.stderr?.on('data', (b: Buffer) => err.data(b));

  let killTimer: NodeJS.Timeout | null = null;
  const forward = (sig: NodeJS.Signals) => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
    if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGHUP', () => {});

  child.on('error', (e) => {
    write(errFd, redactErr, `runner: ${spec.command}: ${e.message}`);
  });
  child.on('close', (code, signal) => {
    out.flush();
    err.flush();
    if (inboxTimer) clearInterval(inboxTimer);
    if (killTimer) clearTimeout(killTimer);
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    // Token deltas only matter while the run is live; the full messages are in stdout.jsonl.
    if (liveFd !== null) fs.closeSync(liveFd);
    writeJson('exit.json', { code, signal, endedAt: new Date().toISOString() });
    process.exit(0);
  });
}

main().catch((e) => {
  try {
    fs.appendFileSync(file('stderr.log'), `runner: ${(e as Error).stack ?? String(e)}\n`);
    writeJson('exit.json', { code: null, signal: null, error: String(e), endedAt: new Date().toISOString() });
  } finally {
    process.exit(1);
  }
});
