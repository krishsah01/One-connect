// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Secret redaction for the event pipeline. Runs before anything touches disk, a prompt,
// a log, a tracker comment or the UI. Patterns plus a runtime denylist of exact values.

export interface RedactionPattern {
  kind: string;
  re: RegExp;
  /** Replace only this capture group (keeps e.g. `password=` visible). */
  group?: number;
}

export const DEFAULT_PATTERNS: RedactionPattern[] = [
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'linear-key', re: /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer', re: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, group: 2 },
  { kind: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi, group: 2 },
  {
    kind: 'assignment',
    re: /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[=:]\s*["']?)([^\s"'`]{8,})/gi,
    group: 2,
  },
];

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export interface RedactOptions {
  patterns?: RedactionPattern[];
  /** Exact secret values (e.g. values of configured env vars). Ignored if shorter than 6 chars. */
  denylist?: readonly string[];
}

export interface RedactResult {
  text: string;
  hits: string[];
}

const mark = (kind: string) => `[REDACTED:${kind}]`;

export function redact(input: string, opts: RedactOptions = {}): RedactResult {
  let text = input;
  const hits: string[] = [];
  for (const v of opts.denylist ?? []) {
    if (!v || v.length < 6) continue;
    if (text.includes(v)) {
      text = text.split(v).join(mark('denylist'));
      hits.push('denylist');
    }
  }
  for (const p of opts.patterns ?? DEFAULT_PATTERNS) {
    p.re.lastIndex = 0;
    text = text.replace(p.re, (...m: string[]) => {
      if (m[0].includes('[REDACTED:')) return m[0];
      hits.push(p.kind);
      if (p.group === undefined) return mark(p.kind);
      const groups = m.slice(1, -2);
      return groups.map((g, i) => (i + 1 === p.group ? mark(p.kind) : (g ?? ''))).join('');
    });
  }
  if (PEM_BEGIN.test(text)) {
    text = text.replace(/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => {
      hits.push('private-key');
      return mark('private-key');
    });
  }
  return { text, hits };
}

/** Stateful line redactor: also swallows every line inside a multi-line PEM private key block. */
export function createLineRedactor(opts: RedactOptions = {}) {
  let inPem = false;
  return (line: string): RedactResult => {
    if (inPem) {
      if (PEM_END.test(line)) inPem = false;
      return { text: mark('private-key'), hits: ['private-key'] };
    }
    if (PEM_BEGIN.test(line) && !PEM_END.test(line)) {
      inPem = true;
      return { text: mark('private-key'), hits: ['private-key'] };
    }
    return redact(line, opts);
  };
}

/** Redact every string inside a JSON-like value. */
export function redactDeep<T>(value: T, opts: RedactOptions = {}): T {
  if (typeof value === 'string') return redact(value, opts).text as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, opts);
    return out as T;
  }
  return value;
}

export function containsSecret(text: string, opts: RedactOptions = {}): string[] {
  return [...new Set(redact(text, opts).hits)];
}
