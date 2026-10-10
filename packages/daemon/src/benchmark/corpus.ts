// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// A disposable, deterministic fixture corpus for the context-quality benchmark: a fictional ferry
// booking service ("Harbor Lights") with docs, code, distractors, a version change, abstention and
// scope-leak probes, and a few on-demand skills. Nothing here is real project data.
import type { BenchmarkQuestionKind } from '@acc/core';

export interface BenchQuestion {
  id: string;
  kind: BenchmarkQuestionKind;
  stage: 'v1' | 'v2';
  question: string;
  /** Source paths that must all appear among the retrieved, cited sources (answerable questions). */
  expected: string[];
  /** Text that must appear in the retrieved context for an answerable question. */
  mustContain?: string;
  /** Superseded text that must not be returned after the version change. */
  stale?: string[];
  /** Skill id for `skill` questions; structure questions use `expected` as the code files the graph should name. */
  skill?: string;
}

export const CORPUS_NAME = 'harbor-lights';
export const CORPUS_VERSION = '2';

export const SCOPE_CANARIES = {
  diary: 'CANARY-DIARY-7731',
  sibling: 'CANARY-SIBLING-5520',
};

const POOL = 'anchor beacon cable davit eddy fender gangway hawser jetty keel lantern mooring nautical oar pier quay rigging sextant tackle undertow vessel wharf yardarm zephyr breakwater buoy chandlery drydock estuary flotsam galley harbour inlet jib knot lagoon marina narrows outrigger pilot reef shoal tender trawler wake'.split(' ');
function filler(n: number): string {
  const words: string[] = [];
  for (let i = 0; i < 230; i++) words.push(POOL[(n * 7 + i * 13 + (i % 5) * n) % POOL.length]);
  const sentences: string[] = [];
  for (let i = 0; i < words.length; i += 11) sentences.push(`${words.slice(i, i + 11).join(' ')}.`);
  return `# Dockside notes ${n}\n\nArchived waterfront reading list, entry ${n}. Not operational guidance.\n\n${sentences.join('\n')}\n`;
}

export function corpusFilesV1(): Record<string, string> {
  const files: Record<string, string> = {
    'README.md': '# Harbor Lights\n\nHarbor Lights is a ferry booking service. It sells seats, quotes fares and holds inventory for short periods.\n\nSee docs/architecture.md for how the modules fit together.\n',
    'docs/session-policy.md': '# Session policy\n\nBooking sessions expire after 47 minutes of inactivity. The session cookie is renewed on every successful request.\n',
    'docs/refunds.md': '# Refunds\n\nRefunds are issued within 9 business days to the original payment method. Partial refunds follow the same schedule.\n',
    'docs/ratelimits.md': '# Rate limits\n\nThe quote endpoint allows 120 requests per minute per API key. Bursts above 180 requests are rejected with HTTP 429.\n',
    'docs/deploy.md': '# Deploys\n\nDeploys use the blue-green strategy. The canary receives 5 percent of traffic for 12 minutes before promotion.\n',
    'docs/oncall.md': '# On call\n\nThe primary on-call rotation hands over on Tuesdays at 10:00 UTC. The secondary rotation hands over on Fridays.\n',
    'docs/privacy.md': '# Privacy\n\nPassenger names are encrypted with the manifest key, which is rotated every 90 days.\n',
    'docs/architecture.md': '# Architecture\n\nThe booking service (src/booking.ts) calls the pricing module (src/pricing.ts) to quote fares and the seat inventory (src/inventory.ts) to hold seats.\n',
    'docs/glossary.md': '# Glossary\n\nManifest: the list of passengers on a sailing. Sailing: one scheduled crossing. Hold: a temporary seat reservation.\n',
    'docs/workshops.md': '# Workshops\n\nTeam workshop sessions run for 90 minutes and are scheduled by the people team. They are unrelated to customer bookings.\n',
    'docs/changelog.md': '# Changelog\n\n1.0 first release. 1.1 added fare caps. 1.2 added seat holds.\n',
    'src/session.ts': '// Session lifetime for customer bookings.\nexport const SESSION_MINUTES = 47;\nexport function expiresAt(start: number): number {\n  return start + SESSION_MINUTES * 60_000;\n}\n',
    'src/pricing.ts': '// Fare quoting.\nexport const SURGE_CAP = 1.8;\nexport function quote(base: number, demand: number): number {\n  return base * Math.min(SURGE_CAP, 1 + demand);\n}\n',
    'src/inventory.ts': '// Seat inventory.\nexport const HOLD_SECONDS = 420;\nexport function holdSeat(sailing: string, seat: string): { sailing: string; seat: string; seconds: number } {\n  return { sailing, seat, seconds: HOLD_SECONDS };\n}\n',
    'src/booking.ts': "import { quote } from './pricing.ts';\nimport { holdSeat } from './inventory.ts';\n\nexport function createBooking(sailing: string, seat: string, base: number) {\n  return { price: quote(base, 0.2), hold: holdSeat(sailing, seat) };\n}\n",
    'package.json': JSON.stringify({ name: 'harbor-lights', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'DESIGN.md': '# Design contract\n\nPrimary actions use the teal accent #087e8b with white labels. Error banners use #b42318 text on a #fef3f2 background. Controls have an 8px corner radius and a visible focus ring.\n',
  };
  for (let i = 1; i <= 24; i++) files[`docs/dockside/entry-${String(i).padStart(2, '0')}.md`] = filler(i);
  return files;
}

/** The v2 revision: two policy facts change, one file is removed, one is added. */
export function corpusChangesV2(): { path: string; content: string | null }[] {
  return [
    { path: 'docs/session-policy.md', content: '# Session policy\n\nBooking sessions expire after 53 minutes of inactivity. The session cookie is renewed on every successful request.\n' },
    { path: 'src/session.ts', content: '// Session lifetime for customer bookings.\nexport const SESSION_MINUTES = 53;\nexport function expiresAt(start: number): number {\n  return start + SESSION_MINUTES * 60_000;\n}\n' },
    { path: 'docs/refunds.md', content: '# Refunds\n\nRefunds are issued within 6 business days to the original payment method. Partial refunds follow the same schedule.\n' },
    { path: 'docs/changelog.md', content: null },
    { path: 'docs/lost-property.md', content: '# Lost property\n\nItems left on board are held at the terminal desk for 30 days.\n' },
  ];
}

export const BENCH_SKILLS: Record<string, { description: string; body: string }> = {
  'release-notes': { description: 'Write a customer-facing release note entry from merged changes.', body: skillBody('Release notes', ['Collect merged changes since the last tag.', 'Group them by customer impact.', 'Write one plain sentence per change.', 'Link each sentence to its merge SHA.']) },
  'migration-review': { description: 'Review a database migration for locking, rollback and data safety.', body: skillBody('Migration review', ['Read the migration and its rollback.', 'Check for long locks on large tables.', 'Confirm a backfill plan exists.', 'Record the reviewed SHA.']) },
  'a11y-audit': { description: 'Audit a screen for keyboard, contrast and label problems.', body: skillBody('Accessibility audit', ['Tab through every control.', 'Check contrast of text and focus rings.', 'Confirm every control has a name.', 'List findings with screenshots.']) },
  'incident-notes': { description: 'Capture a timeline and follow-ups while handling an incident.', body: skillBody('Incident notes', ['Start a timestamped timeline.', 'Record each decision and who made it.', 'List follow-up work.', 'Link evidence events.']) },
  'api-changes': { description: 'Document a breaking or additive API change for integrators.', body: skillBody('API changes', ['Describe the old and new behavior.', 'Give a before and after example.', 'State the version it ships in.', 'List affected clients.']) },
  'perf-profile': { description: 'Profile a slow request and record before and after timings.', body: skillBody('Performance profile', ['Reproduce with a fixed input.', 'Capture a baseline timing.', 'Change one thing at a time.', 'Record the after timing and the command used.']) },
};
function skillBody(title: string, steps: string[]): string {
  const detail = steps.map((s, i) => `### Step ${i + 1}\n${s}\n${'Details and rationale for this step, written out so that loading the whole body is expensive. '.repeat(6)}\n`).join('\n');
  return `# ${title}\n\n${detail}\n## References\n${'Long reference material that is only needed when this skill is actually used. '.repeat(18)}\n`;
}

export const BENCH_QUESTIONS: BenchQuestion[] = [
  { id: 'L1', kind: 'lookup', stage: 'v1', question: 'How many minutes before a booking session expires from inactivity?', expected: ['docs/session-policy.md'], mustContain: '47 minutes' },
  { id: 'L2', kind: 'lookup', stage: 'v1', question: 'How long do refunds take to reach the payment method?', expected: ['docs/refunds.md'], mustContain: '9 business days' },
  { id: 'L3', kind: 'lookup', stage: 'v1', question: 'What is the quote endpoint rate limit per API key?', expected: ['docs/ratelimits.md'], mustContain: '120 requests per minute' },
  { id: 'L4', kind: 'lookup', stage: 'v1', question: 'What percentage of traffic does the canary receive during deploys?', expected: ['docs/deploy.md'], mustContain: '5 percent' },
  { id: 'L5', kind: 'lookup', stage: 'v1', question: 'When does the primary on-call rotation hand over?', expected: ['docs/oncall.md'], mustContain: 'Tuesdays' },
  { id: 'L6', kind: 'lookup', stage: 'v1', question: 'How often is the manifest key rotated for passenger names?', expected: ['docs/privacy.md'], mustContain: '90 days' },
  { id: 'M1', kind: 'multi', stage: 'v1', question: 'Which modules does the booking service call to quote fares and hold seats?', expected: ['docs/architecture.md', 'src/booking.ts'] },
  { id: 'S1', kind: 'structure', stage: 'v1', question: 'What does src/booking.ts import?', expected: ['src/pricing.ts', 'src/inventory.ts'] },
  { id: 'K1', kind: 'skill', stage: 'v1', question: 'How do I write a customer-facing release note entry?', expected: [], skill: 'release-notes' },
  { id: 'K2', kind: 'skill', stage: 'v1', question: 'How should I review a database migration for locking and rollback?', expected: [], skill: 'migration-review' },
  { id: 'A1', kind: 'abstain', stage: 'v1', question: 'What is the maximum luggage weight for the cargo vessel?', expected: [] },
  { id: 'A2', kind: 'abstain', stage: 'v1', question: 'Who is the chief executive of the company?', expected: [] },
  { id: 'C1', kind: 'scope', stage: 'v1', question: 'What does the diary say about the vault password hint?', expected: [] },
  { id: 'C2', kind: 'scope', stage: 'v1', question: 'What is the sibling project launch codename?', expected: [] },
  // Structural: the answer is the import graph, not shared words. Keyword-only retrieval is expected to miss files here.
  { id: 'D1', kind: 'dependency', stage: 'v1', question: 'What does createBooking depend on?', expected: ['src/booking.ts', 'src/pricing.ts', 'src/inventory.ts'] },
  { id: 'G1', kind: 'design', stage: 'v1', question: 'What color do error banners use?', expected: ['DESIGN.md'], mustContain: '#b42318' },
  { id: 'V1', kind: 'version', stage: 'v2', question: 'How many minutes before a booking session expires from inactivity?', expected: ['docs/session-policy.md'], mustContain: '53 minutes', stale: ['47 minutes', '47;'] },
  { id: 'V2', kind: 'version', stage: 'v2', question: 'How long do refunds take to reach the payment method?', expected: ['docs/refunds.md'], mustContain: '6 business days', stale: ['9 business days'] },
  { id: 'V3', kind: 'version', stage: 'v2', question: 'How long are items left on board held at the terminal desk?', expected: ['docs/lost-property.md'], mustContain: '30 days' },
  // The changelog is deleted in v2: its facts must no longer be returned.
  { id: 'V4', kind: 'deleted', stage: 'v2', question: 'What did release 1.1 add according to the changelog?', expected: [], stale: ['fare caps'] },
];
