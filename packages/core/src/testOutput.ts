// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Extracts pass/fail/skip counts from common test runners' summary output.
import type { TestCounts } from './entities.ts';

// Strip ANSI escape sequences (ESC [ ... letter) so colored summaries still parse.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g');
const num = (s: string | undefined) => (s ? Number.parseInt(s, 10) : 0);

type Parser = (out: string) => TestCounts | null;

const parsers: Parser[] = [
  // vitest: "Tests  12 passed | 1 failed | 2 skipped (15)"
  (o) => {
    const m = /^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/m.exec(o);
    if (!m || !/passed|failed/.test(m[1])) return null;
    const get = (k: string) => num(new RegExp(`(\\d+)\\s+${k}`).exec(m[1])?.[1]);
    return { passed: get('passed'), failed: get('failed'), skipped: get('skipped') + get('todo'), framework: 'vitest' };
  },
  // jest: "Tests:       1 failed, 2 skipped, 12 passed, 15 total"
  (o) => {
    const m = /^\s*Tests:\s+(.+total)\s*$/m.exec(o);
    if (!m) return null;
    const get = (k: string) => num(new RegExp(`(\\d+)\\s+${k}`).exec(m[1])?.[1]);
    return { passed: get('passed'), failed: get('failed'), skipped: get('skipped') + get('todo'), framework: 'jest' };
  },
  // node:test (tap "# pass 3" or spec "ℹ pass 3")
  (o) => {
    const p = /^(?:#|ℹ)\s*pass\s+(\d+)\s*$/m.exec(o);
    const f = /^(?:#|ℹ)\s*fail\s+(\d+)\s*$/m.exec(o);
    if (!p && !f) return null;
    const s = /^(?:#|ℹ)\s*skipped\s+(\d+)\s*$/m.exec(o);
    const t = /^(?:#|ℹ)\s*todo\s+(\d+)\s*$/m.exec(o);
    return { passed: num(p?.[1]), failed: num(f?.[1]), skipped: num(s?.[1]) + num(t?.[1]), framework: 'node:test' };
  },
  // pytest: "==== 3 failed, 12 passed, 1 skipped in 0.52s ===="
  (o) => {
    const m = /^=+ (.*\b(?:passed|failed|error)\b.*) in [\d.]+s(?: \([^)]*\))? =+\s*$/m.exec(o);
    if (!m) return null;
    const get = (k: string) => num(new RegExp(`(\\d+)\\s+${k}`).exec(m[1])?.[1]);
    return { passed: get('passed'), failed: get('failed') + get('errors?'), skipped: get('skipped') + get('xfailed'), framework: 'pytest' };
  },
  // cargo: "test result: ok. 12 passed; 0 failed; 1 ignored"
  (o) => {
    const all = [...o.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
    if (all.length === 0) return null;
    return all.reduce<TestCounts>((acc, m) => ({ passed: acc.passed + num(m[1]), failed: acc.failed + num(m[2]), skipped: acc.skipped + num(m[3]), framework: 'cargo' }), { passed: 0, failed: 0, skipped: 0 });
  },
  // mocha: "12 passing", "1 failing", "2 pending"
  (o) => {
    const p = /^\s*(\d+) passing\b/m.exec(o);
    if (!p) return null;
    return { passed: num(p[1]), failed: num(/^\s*(\d+) failing\b/m.exec(o)?.[1]), skipped: num(/^\s*(\d+) pending\b/m.exec(o)?.[1]), framework: 'mocha' };
  },
  // go test: count "--- PASS"/"--- FAIL"/"--- SKIP" (with -v), else package ok/FAIL lines.
  (o) => {
    const pass = (o.match(/^\s*--- PASS:/gm) ?? []).length;
    const fail = (o.match(/^\s*--- FAIL:/gm) ?? []).length;
    const skip = (o.match(/^\s*--- SKIP:/gm) ?? []).length;
    if (pass + fail + skip > 0) return { passed: pass, failed: fail, skipped: skip, framework: 'go' };
    const okPk = (o.match(/^ok\s+\S+\s+[\d.]+s/gm) ?? []).length;
    const failPk = (o.match(/^FAIL\s+\S+\s+[\d.]+s/gm) ?? []).length;
    if (okPk + failPk === 0) return null;
    return { passed: okPk, failed: failPk, skipped: 0, framework: 'go (packages)' };
  },
];

export function parseTestOutput(output: string): TestCounts | null {
  const clean = output.replace(ANSI, '');
  for (const p of parsers) {
    const r = p(clean);
    if (r) return r;
  }
  return null;
}

const TEST_COMMAND = /\b(test|tests|vitest|jest|pytest|mocha|go test|cargo test|node --test|npm t\b|bun test|deno test)\b/i;
export function looksLikeTestCommand(cmd: string): boolean {
  return TEST_COMMAND.test(cmd);
}
