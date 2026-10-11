// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Shared helpers for vendor stream parsers.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeTestCommand, parseTestOutput } from '@acc/core';
import { classifyFailure } from './failures.ts';
import { clip, type Parsed } from './types.ts';

const realCache = new Map<string, string>();
function real(p: string): string {
  let r = realCache.get(p);
  if (r === undefined) {
    try {
      r = fs.realpathSync(p);
    } catch {
      r = p;
    }
    realCache.set(p, r);
  }
  return r;
}

/** Path relative to the worktree; agents may report symlinked or realpath'd absolute paths. */
export function relPath(cwd: string, p: string): string {
  if (!p) return p;
  if (!path.isAbsolute(p)) return path.normalize(p);
  for (const base of [cwd, real(cwd)]) {
    const rel = path.relative(base, p);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return p;
}

/** A finished command, plus a test-result event when the output is a test summary. */
export function commandCompleted(command: string, exitCode: number | null, output: string, callId?: string): Parsed[] {
  const out: Parsed[] = [{ kind: 'event', type: 't.command', data: { callId, command, status: exitCode === 0 ? 'completed' : 'failed', exitCode, output: clip(output, 64_000) } }];
  if (looksLikeTestCommand(command)) {
    const counts = parseTestOutput(output);
    if (counts) out.push({ kind: 'event', type: 't.test_result', data: { counts, command } });
  }
  return out;
}

export function stderrLine(line: string): Parsed[] {
  const out: Parsed[] = [{ kind: 'event', type: 't.raw', data: { stream: 'stderr', line: clip(line, 2000) } }];
  const f = classifyFailure(line);
  if (f) out.push({ kind: 'failure', failure: f });
  return out;
}

export function tryJson(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('');
  return '';
}

export function summarize(v: unknown, n = 160): string {
  try {
    return clip(typeof v === 'string' ? v : JSON.stringify(v), n);
  } catch {
    return '';
  }
}

/** Generic end-of-run handling when the vendor never sent a result line. */
export function endWithoutResult(sawResult: boolean, exit: { code: number | null; signal: string | null }, lastFailure: Parsed | null, lastText: string): Parsed[] {
  if (sawResult) return [];
  const out: Parsed[] = [];
  if (lastText) out.push({ kind: 'final', text: lastText });
  if (exit.code === 0 && !exit.signal) out.push({ kind: 'result', ok: true, text: lastText });
  else {
    if (lastFailure) out.push(lastFailure);
    out.push({ kind: 'result', ok: false, text: lastText });
  }
  return out;
}

/** Opaque fingerprint of a signed-in identity: binds confirmations to one login without storing it. */
export function accountFingerprint(vendor: string, ...parts: (string | null | undefined)[]): string | undefined {
  const id = parts.filter((p): p is string => Boolean(p && p.trim())).map((p) => p.trim().toLowerCase());
  return id.length ? createHash('sha256').update(JSON.stringify([vendor, ...id])).digest('hex').slice(0, 24) : undefined;
}

/** "krish@example.com" → "kr…@example.com"; display only. */
export function maskEmail(email: string | null | undefined): string | undefined {
  const m = /^([^@\s]{1,2})[^@\s]*(@[^@\s]+)$/.exec((email ?? '').trim());
  return m ? `${m[1]}…${m[2]}` : undefined;
}
