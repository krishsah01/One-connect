// SPDX-License-Identifier: Apache-2.0
// Classifies the failure modes that actually happen to headless agents.
import type { FailureKind } from '@acc/core';

export interface Failure {
  kind: FailureKind;
  message: string;
  resetsAt?: string | null;
}

const RULES: { kind: FailureKind; re: RegExp }[] = [
  { kind: 'usage_limit', re: /usage limit|rate[ _-]?limit(?:ed)?|limit reached|hit your (?:usage )?limit|quota (?:exceeded|exhausted)|too many requests|\b429\b|weekly limit|out of (?:usage|credits)/i },
  { kind: 'auth_expired', re: /not logged in|login required|please (?:log ?in|sign in|run .*login)|authenticat(?:e|ion) (?:failed|required|error)|unauthori[sz]ed|\b401\b|token (?:has )?expired|session expired|invalid api key|credentials? (?:expired|missing)/i },
  { kind: 'model_unsupported', re: /model[^\n]{0,60}(?:not (?:supported|available|found|allowed)|unsupported|does not exist|isn't available|is not enabled)|unknown model|invalid model|not available (?:on|for) your (?:plan|account)/i },
  { kind: 'network', re: /connection (?:timed out|timeout|refused|reset|closed)|timed out|timeout(?:error)?\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network (?:error|is unreachable)|stream (?:disconnected|error|closed)|fetch failed|getaddrinfo|routing (?:error|timeout)|upstream (?:error|connect)|\b50[234]\b/i },
  { kind: 'sandbox_denied', re: /operation not permitted|permission denied|sandbox(?:ed)?[^\n]{0,40}(?:denied|blocked|violation)|EPERM|EACCES|read-only file ?system|unable to (?:create|write)[^\n]{0,40}index\.lock|could not (?:lock|write)[^\n]{0,30}index/i },
];

export function classifyFailure(text: string): Failure | null {
  if (!text) return null;
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) return { kind: r.kind, message: firstLineAround(text, m.index), resetsAt: r.kind === 'usage_limit' ? parseResetTime(text) : undefined };
  }
  return null;
}

function firstLineAround(text: string, idx: number): string {
  const start = text.lastIndexOf('\n', idx) + 1;
  const end = text.indexOf('\n', idx);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 300);
}

/** Best effort: "resets at 3pm", "try again in 2h 5m", "|1791322922" (epoch seconds), ISO times. */
export function parseResetTime(text: string, now = new Date()): string | null {
  const iso = /\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)/.exec(text);
  if (iso) return new Date(iso[1]).toISOString();
  const epoch = /(?:\||resets?_?at["\s:=]+)(1[6-9]\d{8})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  for (const rel of text.matchAll(/\b(?:in|after)\s+(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\b)?/gi)) {
    if (rel[1] || rel[2]) return new Date(now.getTime() + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000).toISOString();
  }
  return null;
}

/** Vendor hosts used for the "is it us or the network" connectivity check. */
export const VENDOR_HOSTS: Record<string, string> = {
  'claude-headless': 'api.anthropic.com',
  'codex-cli': 'chatgpt.com',
  'cursor-agent-cli': 'api2.cursor.sh',
  'generic-cli': 'example.com',
  relay: 'example.com',
  'opencode-server': '127.0.0.1',
};
