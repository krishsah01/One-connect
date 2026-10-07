// SPDX-License-Identifier: Apache-2.0
// Parses the structured handoff block agents end their work with:
//
//   ### Handoff
//   Done: <one line>
//   Evidence:
//   - `npm test` → 42 passed, 0 failed
//   Commit: 1a2b3c4 on codex/ENG-12-fix-login
//   Blocked: none
//   Next: <suggested next step>
//
// Tolerates bold labels, list bullets, "->"/"=>"/":" separators and missing optional fields.
import type { Handoff, HandoffEvidenceItem } from './entities.ts';

const FIELD = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*(done|evidence|commit|blocked|next|verdict|findings)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
const HEADING = /^\s*(?:#{1,6}\s*|\*\*\s*|__\s*)?handoff\b\s*:?\s*(?:\*\*|__)?\s*:?\s*$/im;

export const HANDOFF_TEMPLATE = [
  '### Handoff',
  'Done: <one line: what is finished>',
  'Evidence:',
  '- `<exact command>` → <actual result, e.g. 42 passed, 0 failed>',
  'Commit: <full or short SHA> on <branch>',
  'Blocked: none | <what> (on <whom: human / issue KEY / agent id>)',
  'Next: <the next step you recommend>',
].join('\n');

function lastHeadingIndex(text: string): number {
  const re = new RegExp(HEADING.source, 'gim');
  let idx = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) idx = m.index;
  return idx;
}

export function parseEvidenceLine(line: string): HandoffEvidenceItem | null {
  const t = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim();
  if (!t) return null;
  const code = /^`([^`]+)`\s*(?:→|->|=>|:|—|–|-)?\s*(.*)$/.exec(t);
  if (code) return { command: code[1].trim(), result: code[2].trim() };
  const arrow = /^(.+?)\s*(?:→|->|=>)\s*(.+)$/.exec(t);
  if (arrow) return { command: arrow[1].trim(), result: arrow[2].trim() };
  const colon = /^(.+?):\s+(.+)$/.exec(t);
  if (colon) return { command: colon[1].trim(), result: colon[2].trim() };
  return { command: t, result: '' };
}

function parseCommit(v: string): Handoff['commit'] {
  const sha = /\b([0-9a-f]{7,40})\b/i.exec(v);
  if (!sha) return null;
  const branch = /\b(?:on|branch)\s+`?([\w./-]+)`?/i.exec(v) ?? /\(([\w./-]+)\)/.exec(v);
  return { sha: sha[1].toLowerCase(), branch: branch ? branch[1] : null };
}

function parseBlocked(v: string): Handoff['blocked'] {
  const t = v.trim();
  if (!t || /^(none|no|n\/a|nothing|-|—|not blocked)\.?$/i.test(t)) return null;
  const on = /\((?:on\s+)?([^)]+)\)\s*$/i.exec(t) ?? /\bon\s+([\w@./-]+)\s*$/i.exec(t);
  return { what: on ? t.slice(0, on.index).trim().replace(/[,;:]$/, '') : t, on: on ? on[1].trim() : null };
}

/** Returns null when there is no handoff block with at least a Done line. */
export function parseHandoff(text: string, source: Handoff['source'] = 'final_message'): Handoff | null {
  if (!text) return null;
  const start = lastHeadingIndex(text);
  const body = start >= 0 ? text.slice(start).split('\n').slice(1) : text.split('\n');
  const fields: Record<string, string[]> = {};
  let current: string | null = null;
  for (const raw of body) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*```/.test(line)) continue;
    if (start >= 0 && /^\s*#{1,6}\s+\S/.test(line) && current) break; // next section ends the block
    const m = FIELD.exec(line);
    if (m) {
      current = m[1].toLowerCase();
      fields[current] = m[2].trim() ? [m[2].trim()] : [];
      continue;
    }
    if (current && line.trim()) fields[current].push(line);
  }
  const done = (fields.done ?? []).join(' ').trim();
  if (!done) return null;
  const evidence = (fields.evidence ?? [])
    .flatMap((l) => (/^\s*(?:[-*+]\s*)?(none|n\/a|none recorded)\.?\s*$/i.test(l) ? [] : [parseEvidenceLine(l)]))
    .filter((x): x is HandoffEvidenceItem => x !== null);
  const commitRaw = (fields.commit ?? []).join(' ');
  const next = (fields.next ?? []).join(' ').trim();
  const v = (fields.verdict ?? []).join(' ').toLowerCase();
  const verdict = !v ? null : /request|change|reject|block/.test(v) ? 'request_changes' : /approve|lgtm|accept|pass/.test(v) ? 'approve' : null;
  const findings = (fields.findings ?? []).map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim()).filter((l) => l && !/^(none|n\/a)\.?$/i.test(l));
  return {
    done,
    evidence,
    commit: commitRaw ? parseCommit(commitRaw) : null,
    blocked: parseBlocked((fields.blocked ?? []).join(' ')),
    next: next && !/^(none|n\/a|-)$/i.test(next) ? next : null,
    source,
    raw: start >= 0 ? text.slice(start).trim() : text.trim(),
    ...(fields.verdict ? { verdict, findings } : fields.findings ? { findings } : {}),
  };
}

export function formatHandoff(h: Handoff): string {
  const lines = ['### Handoff', `Done: ${h.done}`, 'Evidence:'];
  if (h.evidence.length === 0) lines.push('- none recorded');
  for (const e of h.evidence) lines.push(`- \`${e.command}\` → ${e.result || '(no result given)'}${e.verified === false ? ' [unverified]' : ''}`);
  lines.push(`Commit: ${h.commit ? `${h.commit.sha}${h.commit.branch ? ` on ${h.commit.branch}` : ''}` : 'none'}`);
  lines.push(`Blocked: ${h.blocked ? `${h.blocked.what}${h.blocked.on ? ` (on ${h.blocked.on})` : ''}` : 'none'}`);
  lines.push(`Next: ${h.next ?? 'none'}`);
  if (h.verdict) lines.push(`Verdict: ${h.verdict === 'approve' ? 'approve' : 'request changes'}`);
  if (h.findings?.length) lines.push('Findings:', ...h.findings.map((f) => `- ${f}`));
  return lines.join('\n');
}
