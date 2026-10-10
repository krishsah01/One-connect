// SPDX-License-Identifier: Apache-2.0
// A bounded redacted log view. Redact before paging so a secret crossing pages cannot escape.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CommandError, type Daemon } from '../daemon.ts';

const MAX_LOG_BYTES = 16 * 1024 * 1024;
export function phoneLog(d: Daemon, runId: string, stream: string | undefined): Buffer {
  const run = d.state.runs[runId];
  if (!run) throw new CommandError('Unknown run', 404);
  const file = path.join(d.runs.supervisor.runDir(runId), stream === 'stderr' ? 'stderr.log' : 'stdout.jsonl');
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_LOG_BYTES) throw new CommandError('This log exceeds the 16 MiB phone view limit. Use the structured transcript or read it on the Mac.', 413);
    const buf = Buffer.alloc(size), n = fs.readSync(fd, buf, 0, size, 0);
    // In-progress raw lines may contain a partial credential. Wait for the complete line.
    const end = run.endedAt ? n : buf.subarray(0, n).lastIndexOf(10) + 1;
    return Buffer.from(d.redactText(buf.subarray(0, end).toString('utf8')));
  } finally { fs.closeSync(fd); }
}

export function phoneLogPage(d: Daemon, runId: string, stream: string | undefined, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CommandError('Invalid log offset');
  const safe = phoneLog(d, runId, stream), start = Math.min(offset, safe.length);
  const decoder = new StringDecoder('utf8'), end = Math.min(safe.length, start + 128 * 1024);
  const text = decoder.write(safe.subarray(start, end)) + (end === safe.length ? decoder.end() : '');
  return { text, offset: start, nextOffset: Math.min(safe.length, start + Buffer.byteLength(text)), totalBytes: safe.length };
}
