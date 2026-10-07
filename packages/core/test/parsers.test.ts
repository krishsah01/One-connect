// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createLineRedactor, formatHandoff, parseHandoff, parseTestOutput, redact, redactDeep } from '../src/index.ts';

describe('parseHandoff', () => {
  it('parses the canonical block', () => {
    const h = parseHandoff(`I fixed it.\n\n### Handoff\nDone: Login no longer double-submits\nEvidence:\n- \`npm test\` → 42 passed, 0 failed\n- \`npx tsc --noEmit\` -> no errors\nCommit: 1a2b3c4d on codex/ENG-12-fix-login\nBlocked: none\nNext: add a regression test for the retry path`);
    expect(h).not.toBeNull();
    expect(h!.done).toBe('Login no longer double-submits');
    expect(h!.evidence).toEqual([
      { command: 'npm test', result: '42 passed, 0 failed' },
      { command: 'npx tsc --noEmit', result: 'no errors' },
    ]);
    expect(h!.commit).toEqual({ sha: '1a2b3c4d', branch: 'codex/ENG-12-fix-login' });
    expect(h!.blocked).toBeNull();
    expect(h!.next).toBe('add a regression test for the retry path');
  });

  it('tolerates bold labels, bullets and a blocked-on clause', () => {
    const h = parseHandoff(`**Handoff**\n- **Done:** migrated the schema\n- **Evidence:**\n  - npm run migrate:dry => ok, 3 statements\n- **Commit:** \`deadbeefcafe\` (cursor/ENG-9-schema)\n- **Blocked:** need prod credentials approval (on human)\n- **Next:** none`);
    expect(h!.done).toBe('migrated the schema');
    expect(h!.evidence[0]).toEqual({ command: 'npm run migrate:dry', result: 'ok, 3 statements' });
    expect(h!.commit).toEqual({ sha: 'deadbeefcafe', branch: 'cursor/ENG-9-schema' });
    expect(h!.blocked).toEqual({ what: 'need prod credentials approval', on: 'human' });
    expect(h!.next).toBeNull();
  });

  it('uses the last handoff block and returns null without Done', () => {
    expect(parseHandoff('no block here')).toBeNull();
    const h = parseHandoff('### Handoff\nDone: first\n\nlater...\n### Handoff\nDone: second\nEvidence:\n- none');
    expect(h!.done).toBe('second');
    expect(h!.evidence).toEqual([]);
  });

  it('round-trips through formatHandoff', () => {
    const h = parseHandoff('### Handoff\nDone: x\nEvidence:\n- `a` → b\nCommit: abcdef1 on b/1\nBlocked: none\nNext: y')!;
    const again = parseHandoff(formatHandoff(h))!;
    expect(again.done).toBe('x');
    expect(again.commit?.sha).toBe('abcdef1');
  });
});

describe('redact', () => {
  it('redacts known token shapes and keeps assignment keys visible', () => {
    const gh = 'ghp_' + 'a'.repeat(36);
    const r = redact(`token ${gh} and password=hunter2hunter2 and sk-ant-${'x'.repeat(30)} https://u:p4ssw0rd@db.example.com/x`);
    expect(r.text).not.toContain(gh);
    expect(r.text).toContain('password=[REDACTED:assignment]');
    expect(r.text).not.toContain('hunter2');
    expect(r.text).toContain('https://u:[REDACTED:url-credentials]@db.example.com');
    expect(r.hits).toEqual(expect.arrayContaining(['github-token', 'anthropic-key', 'assignment', 'url-credentials']));
  });

  it('redacts denylisted exact values', () => {
    expect(redact('DATABASE_URL is s3cr3t-value!', { denylist: ['s3cr3t-value!'] }).text).toBe('DATABASE_URL is [REDACTED:denylist]');
  });

  it('keeps JSON lines valid', () => {
    const line = JSON.stringify({ text: `use Bearer ${'abc123'.repeat(5)} now` });
    const out = redact(line).text;
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).text).toBe('use Bearer [REDACTED:bearer] now');
  });

  it('swallows multi-line PEM keys line by line', () => {
    const r = createLineRedactor();
    const lines = ['before', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEow...', '-----END RSA PRIVATE KEY-----', 'after'].map((l) => r(l).text);
    expect(lines).toEqual(['before', '[REDACTED:private-key]', '[REDACTED:private-key]', '[REDACTED:private-key]', 'after']);
  });

  it('redacts deeply', () => {
    expect(redactDeep({ a: ['x', { b: 'AKIAABCDEFGHIJKLMNOP' }] })).toEqual({ a: ['x', { b: '[REDACTED:aws-access-key]' }] });
  });
});

describe('parseTestOutput', () => {
  it.each([
    [' Tests  12 passed | 1 failed (13)', { passed: 12, failed: 1, skipped: 0 }],
    ['Tests:       1 failed, 2 skipped, 12 passed, 15 total', { passed: 12, failed: 1, skipped: 2 }],
    ['# tests 4\n# pass 3\n# fail 1\n# skipped 0', { passed: 3, failed: 1, skipped: 0 }],
    ['ℹ tests 5\nℹ pass 5\nℹ fail 0', { passed: 5, failed: 0, skipped: 0 }],
    ['===== 3 failed, 12 passed, 1 skipped in 0.52s =====', { passed: 12, failed: 3, skipped: 1 }],
    ['test result: ok. 7 passed; 0 failed; 1 ignored; 0 measured', { passed: 7, failed: 0, skipped: 1 }],
    ['  9 passing (20ms)\n  2 failing', { passed: 9, failed: 2, skipped: 0 }],
    ['--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)', { passed: 1, failed: 1, skipped: 0 }],
  ])('parses %j', (out, want) => {
    expect(parseTestOutput(out)).toMatchObject(want);
  });

  it('strips ANSI colors and returns null for non-test output', () => {
    expect(parseTestOutput('\u001b[32m Tests \u001b[0m 3 passed (3)')).toMatchObject({ passed: 3 });
    expect(parseTestOutput('hello world')).toBeNull();
  });
});
