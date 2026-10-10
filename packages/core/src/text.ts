// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Small, dependency-free text and value helpers shared by the daemon and the web client.

/** Shorten to at most `max` characters, ending in an ellipsis when cut. */
export function ellipsize(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Keep the first `max` characters and say how much was cut (for logs and transcripts). */
export function clip(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

/** The value as a plain object, or null for arrays, primitives and null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** POSIX single-quoted shell word: safe for any input, including quotes and newlines. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Deterministic JSON for hashing: object keys sorted by UTF-16 code unit at every level, so the
 * same value always produces the same text whatever the process locale. `undefined` object values
 * serialize as `null` (they are part of the bound value, not dropped).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A command line for display or pasting: words are quoted only when they need it. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : shellQuote(word))).join(' ');
}
