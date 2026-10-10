// SPDX-License-Identifier: Apache-2.0
// Result shapes of the context-quality benchmark. Everything here is measured on a disposable
// fixture corpus with labelled questions. Token figures are bytes-derived ESTIMATES; provider-reported
// tokens are a separate field that stays null because the benchmark performs no inference.

export const BYTES_PER_TOKEN_ESTIMATE = 4;
export const estimateTokens = (bytes: number): number => Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);

export type BenchmarkQuestionKind = 'lookup' | 'multi' | 'version' | 'structure' | 'skill' | 'abstain' | 'scope' | 'dependency' | 'design' | 'deleted';
export type BenchmarkArmId = 'full_context' | 'dictionary' | 'keyword_only' | 'hybrid' | 'graphify' | 'skills_on_demand';

export interface BenchmarkQuestionResult {
  id: string;
  kind: BenchmarkQuestionKind;
  question: string;
  stage: 'v1' | 'v2';
  expected: string[];
  /** Source paths the stack cited (committed-source attribution when available). */
  cited: string[];
  correct: boolean;
  abstained: boolean;
  shouldAbstain: boolean;
  /** Excerpts that did not match the committed source at the cited lines. */
  integrityViolations: number;
  leaked: string[];
  staleHits: string[];
  contextBytes: number;
  latencyMs: number;
  note?: string;
  /** Arm that produced this row (rows without it belong to the Dictionary arm). */
  arm?: BenchmarkArmId;
  /** Share of expected sources cited (partial credit). */
  recall?: number;
  /** Dictionary's own evidence verdict for the cited excerpts. */
  support?: 'supported' | 'insufficient';
}

export interface BenchmarkArmSummary {
  id: BenchmarkArmId;
  label: string;
  /** `not_measured` when a dependency (for example Graphify) is not installed; `pending` when an
   * optional local tool was not supplied for this run (never downloaded to make the arm green). */
  status: 'measured' | 'not_measured' | 'pending';
  reason?: string;
  questions: number;
  contextBytes: number;
  contextBytesPerQuestion: number;
  /** bytes / 4. An estimate of prompt size, NOT provider-reported usage and NOT proven token savings. */
  estimatedTokensPerQuestion: number;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  /** Share of answerable labelled questions whose expected sources were all present in the context. */
  retrievalAccuracy: number | null;
  citationIntegrity: number | null;
  abstentionAccuracy: number | null;
  /** Mean share of expected sources cited on answerable questions. */
  recall?: number | null;
  /** Share of questions where Dictionary's evidence verdict (supported / insufficient) was right. */
  answerSupport?: number | null;
}

export interface BenchmarkInvalidation {
  chunksBefore: number;
  chunksAfter: number;
  chunksReused: number;
  chunksAdded: number;
  chunksRemoved: number;
  changedFiles: string[];
  staleChunkRemaining: number;
  notesRevisionBefore: string | null;
  notesRevisionAfter: string | null;
  revisionAligned: boolean;
}

export interface ContextBenchmarkResult {
  id: string;
  at: string;
  corpus: { name: string; version: string; files: number; bytes: number; questions: number; skills: number; disposable: true };
  method: string[];
  arms: BenchmarkArmSummary[];
  questions: BenchmarkQuestionResult[];
  invalidation: BenchmarkInvalidation | null;
  scope: { canaries: number; leaked: number };
  alignment: { notesRevision: string | null; embeddingsRevision: string | null; graphRevision: string | null; stale: string[] };
  tokens: { estimate: 'bytes/4'; providerReported: null; note: string };
  regressions: string[];
  checks: { name: string; ok: boolean; detail: string }[];
  limits: string[];
  /** Measured on this machine for this run. */
  resources?: { intakeMs: number; incrementalMs: number; rssMb: number; heapUsedMb: number; note: string };
  /** Observed trade-offs between arms, stated plainly (including where an arm is worse). */
  tradeoffs?: string[];
}

/** The fixed quality gate for this evaluation set. A non-empty result means a regression. */
export function benchmarkRegressions(r: ContextBenchmarkResult): string[] {
  const out: string[] = [];
  const stack = r.arms.find(a => a.id === 'dictionary');
  const base = r.arms.find(a => a.id === 'full_context');
  if (!stack || stack.status !== 'measured') return ['One Ask arm was not measured'];
  if ((stack.retrievalAccuracy ?? 0) < 1) out.push(`retrieval accuracy ${(100 * (stack.retrievalAccuracy ?? 0)).toFixed(0)}% < 100% on the labelled set`);
  if ((stack.citationIntegrity ?? 0) < 1) out.push('a citation did not match the committed source');
  if ((stack.abstentionAccuracy ?? 0) < 1) out.push('abstention accuracy < 100%');
  if (base && base.retrievalAccuracy !== null && (stack.retrievalAccuracy ?? 0) < base.retrievalAccuracy) out.push('retrieval accuracy regressed against the full-context baseline');
  if (r.scope.leaked > 0) out.push(`${r.scope.leaked} out-of-scope canary strings leaked`);
  if (r.invalidation && (r.invalidation.staleChunkRemaining > 0 || !r.invalidation.revisionAligned)) out.push('stale content survived an incremental update');
  for (const q of r.questions) if (q.staleHits.length) out.push(`${q.id}${q.arm ? ` (${q.arm})` : ''}: returned superseded text`);
  const keywords = r.arms.find(a => a.id === 'keyword_only');
  if (keywords?.status === 'measured' && keywords.recall != null && stack.recall != null && stack.recall < keywords.recall) out.push('graph-assisted recall fell below keyword-only recall');
  return [...new Set(out)];
}
