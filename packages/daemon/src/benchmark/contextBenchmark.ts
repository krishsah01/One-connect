// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Context-quality benchmark. Builds a disposable git repo + vault from a fixed fixture corpus,
// runs the REAL Dictionary intake (and Graphify, if installed) in an isolated temporary daemon, and
// compares retrieval against a full-context baseline on labelled questions. No inference, no
// network and no model download: token figures are bytes/4 estimates and provider tokens stay null.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BenchmarkArmSummary, BenchmarkInvalidation, BenchmarkQuestionResult, ContextBenchmarkResult } from '@acc/core';
import { benchmarkRegressions, estimateTokens, newId, parseConfig } from '@acc/core';
import { run } from '../exec.ts';
import { Daemon } from '../daemon.ts';
import { BENCH_QUESTIONS, BENCH_SKILLS, corpusChangesV2, corpusFilesV1, CORPUS_NAME, CORPUS_VERSION, SCOPE_CANARIES, type BenchQuestion } from './corpus.ts';
import { evidence } from '../context/retrieval.ts';
import { sha256 } from '../util/hash.ts';

type RetrievalArm = 'dictionary' | 'keyword_only' | 'hybrid';
const ARM_OPTIONS: Record<RetrievalArm, { semantic: boolean; expand: boolean }> = { dictionary: { semantic: false, expand: true }, keyword_only: { semantic: false, expand: false }, hybrid: { semantic: true, expand: true } };

export interface BenchmarkOptions {
  /** Graphify CLI to exercise. Without it the Graphify arm is reported as not measured. */
  graphifyBinary?: string;
  /** Only when explicitly given: an ALREADY INSTALLED local embedding model on 127.0.0.1. Never downloaded. */
  embeddingModel?: string;
  keepDir?: boolean;
}

const GENERIC = new Set('how what when where which who whom whose why does do did can could should would will many much long often most maximum minimum about from with that this have has for the and are was were its our your their there them then than into over under each per any'.split(' '));
const stem = (w: string) => w.slice(0, 5);
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
const compact = (s: string) => s.replace(/\s+/g, '');
const bytes = (s: string) => Buffer.byteLength(s);

/** Terms of a question that carry meaning (generic question words removed), reduced to 5-letter stems. */
export function supportTerms(question: string): string[] {
  return [...new Set(words(question).filter(w => !GENERIC.has(w)).map(stem))];
}

/** Share of the question's terms found in the top cited excerpts. The benchmark's abstention rule. */
export function evidenceSupport(question: string, excerpts: string[]): number {
  const terms = supportTerms(question);
  if (!terms.length) return 0;
  const have = new Set(excerpts.flatMap(e => words(e).map(stem)));
  return terms.filter(t => have.has(t)).length / terms.length;
}
export const ABSTAIN_BELOW = 0.6;

const pct = (v: number | null | undefined) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
const percentile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 100) / 100;
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.invalid', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error || '').slice(0, 200)}`);
  return r.stdout.trim();
}

function writeFiles(dir: string, files: Record<string, string | null>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) { fs.rmSync(abs, { force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

interface Citation { path: string; line: number; endLine: number; excerpt: string; projectSource?: { path: string; revision: string; hash: string; line: number; endLine: number } }

/** True when the excerpt is verbatim committed text within the cited lines, and the file hash matches. */
async function citationMatchesCommit(repo: string, c: Citation): Promise<boolean> {
  const ps = c.projectSource;
  if (!ps) return true;
  let src: string;
  try { src = await git(repo, 'show', `${ps.revision}:${ps.path}`); } catch { return false; }
  // `git show` drops one trailing newline; the committed blob hash covers the original bytes.
  if (sha256(src) !== ps.hash && sha256(src + '\n') !== ps.hash) return false;
  const slice = src.split('\n').slice(ps.line - 1, ps.endLine).join('\n');
  return c.excerpt.length > 0 && slice.includes(c.excerpt);
}

export async function runContextBenchmark(opts: BenchmarkOptions = {}): Promise<ContextBenchmarkResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-connect-bench-'));
  const repo = path.join(root, 'repo'), vault = path.join(root, 'vault'), dataDir = path.join(root, 'data');
  fs.mkdirSync(repo, { recursive: true });
  const v1 = corpusFilesV1();
  writeFiles(repo, v1);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'corpus v1');
  await git(repo, 'branch', 'integration');
  const v1Sha = await git(repo, 'rev-parse', 'HEAD');
  // Out-of-scope canaries: a personal note outside every configured folder, and a sibling project's notes.
  fs.mkdirSync(path.join(vault, 'Personal'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Personal', 'Diary.md'), `# Diary\n\n${SCOPE_CANARIES.diary}: the vault password hint is the name of the first ferry.\n`);
  const sibling = path.join(vault, 'One Connect', `project-${'b'.repeat(64)}`);
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, '.one-connect-project'), JSON.stringify({ version: 1, owner: 'b'.repeat(64) }) + '\n');
  fs.writeFileSync(path.join(sibling, 'Secret plan.md'), `# Secret plan\n\n${SCOPE_CANARIES.sibling}: the sibling project launch codename is Nightjar.\n`);

  const semantic = Boolean(opts.embeddingModel);
  const config = parseConfig({
    project: { name: 'bench-fixture', repo, integration_branch: 'integration', protected_branches: ['main'], checks: {} },
    agents: [{ id: 'relay', name: 'Relay', role: 'engineer', adapter: 'relay' }],
    // The managed parent folder is listed as a context folder on purpose: sibling projects must stay invisible.
    knowledge: { vault, folder: 'One Connect', context_folders: ['One Connect'], obsidian_cli: 'off', search: { semantic, ...(opts.embeddingModel ? { embedding_model: opts.embeddingModel } : {}) } },
    graphify: opts.graphifyBinary ? { enabled: true, binary: opts.graphifyBinary } : { enabled: false },
  });
  const blocked = async (): Promise<Response> => { throw new Error('The benchmark performs no outbound requests.'); };
  const d = new Daemon({ config, dataDir, allowTempDataDir: true, probe: false, rulesTickMs: 3_600_000, outboxTickMs: 3_600_000, fetch: semantic ? undefined : blocked });
  try {
    const intakeStart = performance.now();
    await d.start();
    await d.context.answer.refresh(false);
    const intakeMs = Math.round(performance.now() - intakeStart);
    const docs = d.context.docs!;
    const results: BenchmarkQuestionResult[] = [];
    const canaryValues = Object.values(SCOPE_CANARIES);
    let leaked = 0;
    const baselineContext = (files: Record<string, string>) => Object.values(files).reduce((n, c) => n + bytes(c), 0);
    let current: Record<string, string> = { ...v1 };

    const evaluate = async (q: BenchQuestion, arm: RetrievalArm = 'dictionary'): Promise<BenchmarkQuestionResult> => {
      const t0 = performance.now();
      const r = d.context.answer.cite(await docs.search(q.question, { limit: 6, ...ARM_OPTIONS[arm] }));
      const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
      const cites = r.citations as Citation[];
      const cited = [...new Set(cites.map(c => c.projectSource?.path ?? c.path))];
      const text = cites.map(c => c.excerpt).join('\n');
      const contextBytes = bytes(JSON.stringify(cites.map(c => ({ path: c.projectSource?.path ?? c.path, line: c.projectSource?.line ?? c.line, endLine: c.projectSource?.endLine ?? c.endLine, excerpt: c.excerpt }))));
      let integrityViolations = 0;
      for (const c of cites) if (!(await citationMatchesCommit(repo, c))) integrityViolations++;
      const found = canaryValues.filter(v => JSON.stringify(r).includes(v));
      leaked += found.length;
      const stale = (q.stale ?? []).filter(s => text.includes(s));
      const shouldAbstain = q.kind === 'abstain' || q.kind === 'scope' || q.kind === 'deleted';
      const support = evidenceSupport(q.question, cites.slice(0, 3).map(c => c.excerpt));
      // Structural questions are answered by the import graph, not by shared words.
      const abstained = cites.length === 0 || (q.kind !== 'dependency' && support < ABSTAIN_BELOW);
      const expectedPresent = q.expected.every(e => cited.includes(e)) && (!q.mustContain || compact(text).includes(compact(q.mustContain)));
      const correct = shouldAbstain ? abstained && !found.length && !stale.length : !abstained && expectedPresent && !found.length && !stale.length;
      const recall = q.expected.length ? q.expected.filter(e => cited.includes(e)).length / q.expected.length : 1;
      const verdict = evidence(q.question, cites.slice(0, 4).map(c => c.excerpt)).support;
      return { id: q.id, kind: q.kind, question: q.question, stage: q.stage, expected: q.expected, cited, correct, abstained, shouldAbstain, integrityViolations, leaked: found, staleHits: stale, contextBytes, latencyMs, recall, support: verdict, ...(arm === 'dictionary' ? {} : { arm }), note: shouldAbstain ? `support ${support.toFixed(2)} (abstain below ${ABSTAIN_BELOW})` : q.kind === 'dependency' ? 'structural: abstains only with no citation' : undefined };
    };
    const retrievalArms: RetrievalArm[] = semantic ? ['dictionary', 'keyword_only', 'hybrid'] : ['dictionary', 'keyword_only'];
    const evaluateAll = async (qs: BenchQuestion[]) => { for (const arm of retrievalArms) for (const q of qs) results.push(await evaluate(q, arm)); };

    const retrieval = BENCH_QUESTIONS.filter(q => ['lookup', 'multi', 'abstain', 'scope', 'dependency', 'design'].includes(q.kind));
    await evaluateAll(retrieval);
    const baselineBytesV1 = baselineContext(current);

    // ---- on-demand skills ------------------------------------------------------------------
    const skillIndex = Object.entries(BENCH_SKILLS).map(([id, s]) => `${id}: ${s.description}`).join('\n');
    const eagerSkillBytes = Object.entries(BENCH_SKILLS).reduce((n, [id, s]) => n + bytes(`${id}: ${s.description}`) + bytes(s.body), 0);
    const skillRows: { ok: boolean; bytes: number; latency: number }[] = [];
    for (const q of BENCH_QUESTIONS.filter(x => x.kind === 'skill')) {
      const t0 = performance.now();
      const qs = new Set(supportTerms(q.question));
      const ranked = Object.entries(BENCH_SKILLS).map(([id, s]) => ({ id, score: supportTerms(`${id} ${s.description}`).filter(t => qs.has(t)).length })).sort((a, b) => b.score - a.score);
      const pick = ranked[0] && ranked[0].score >= 2 ? ranked[0].id : null;
      const latency = Math.round((performance.now() - t0) * 100) / 100;
      const b = bytes(skillIndex) + (pick ? bytes(BENCH_SKILLS[pick].body) : 0);
      const ok = pick === q.skill;
      skillRows.push({ ok, bytes: b, latency });
      results.push({ id: q.id, kind: q.kind, question: q.question, stage: q.stage, expected: q.skill ? [q.skill] : [], cited: pick ? [pick] : [], correct: ok, abstained: pick === null, shouldAbstain: false, integrityViolations: 0, leaked: [], staleHits: [], contextBytes: b, latencyMs: latency });
    }

    // ---- Graphify (only when installed) ---------------------------------------------------------
    const graph = d.context.graph;
    const graphRows: { ok: boolean; bytes: number; latency: number }[] = [];
    const graphReady = graph?.status.state === 'ready' && graph.status.sha === v1Sha;
    if (graphReady) {
      for (const q of BENCH_QUESTIONS.filter(x => x.kind === 'structure')) {
        const t0 = performance.now();
        let out = '';
        try { out = await graph!.query(q.question, { budget: 800 }); } catch (e) { out = (e as Error).message; }
        const latency = Math.round((performance.now() - t0) * 100) / 100;
        const ok = q.expected.every(e => out.toLowerCase().includes(path.basename(e).toLowerCase()));
        graphRows.push({ ok, bytes: bytes(out), latency });
        results.push({ id: q.id, kind: q.kind, question: q.question, stage: q.stage, expected: q.expected, cited: ok ? q.expected : [], correct: ok, abstained: false, shouldAbstain: false, integrityViolations: 0, leaked: [], staleHits: [], contextBytes: bytes(out), latencyMs: latency, note: 'Graphify output checked for the expected file names only.' });
      }
    }

    // ---- version change: incremental invalidation ---------------------------------------------------
    const ids = () => new Set((docs.db.prepare('SELECT id FROM chunks').all() as { id: string }[]).map(r => r.id));
    const before = ids();
    const notesRevisionBefore = d.context.answer.status.notesRevision;
    const changes = corpusChangesV2();
    writeFiles(repo, Object.fromEntries(changes.map(c => [c.path, c.content])));
    for (const c of changes) { if (c.content === null) delete current[c.path]; else current[c.path] = c.content; }
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'corpus v2');
    await git(repo, 'branch', '-f', 'integration', 'HEAD');
    const v2Sha = await git(repo, 'rev-parse', 'HEAD');
    const incrementalStart = performance.now();
    await d.context.answer.refresh(false);
    const after = ids();
    const staleRemaining = Number((docs.db.prepare("SELECT count(*) AS n FROM chunks WHERE content LIKE '%47 minutes%' OR content LIKE '%9 business days%' OR content LIKE '%SESSION_MINUTES = 47%'").get() as { n: number }).n);
    const status = d.context.answer.status;
    const invalidation: BenchmarkInvalidation = {
      chunksBefore: before.size, chunksAfter: after.size, chunksReused: [...after].filter(x => before.has(x)).length, chunksAdded: [...after].filter(x => !before.has(x)).length, chunksRemoved: [...before].filter(x => !after.has(x)).length,
      changedFiles: changes.map(c => c.path), staleChunkRemaining: staleRemaining, notesRevisionBefore, notesRevisionAfter: status.notesRevision,
      revisionAligned: status.revision === v2Sha && status.notesRevision === v2Sha && (!graph || graph.status.state !== 'ready' || status.graphRevision === v2Sha),
    };
    const baselineBytesV2 = baselineContext(current);
    const incrementalMs = Math.round(performance.now() - incrementalStart);
    await evaluateAll(BENCH_QUESTIONS.filter(x => x.kind === 'version' || x.kind === 'deleted'));

    // ---- scope and alignment checks -------------------------------------------------------------------
    const mustThrow = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
    const offMachine = d.egress.log.filter(e => !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(e.host));
    const checks = [
      { name: 'Personal note outside the selected folders is unreadable', ok: mustThrow(() => d.context.vault!.read('Personal/Diary.md')), detail: 'Vault.read refuses paths outside the readable folders.' },
      { name: 'A sibling project’s notes stay unreadable although the managed parent folder is listed', ok: mustThrow(() => d.context.vault!.read(`One Connect/project-${'b'.repeat(64)}/Secret plan.md`)), detail: 'The managed parent is excluded from the readable folders when a project namespace is set.' },
      { name: 'No request left this machine', ok: offMachine.length === 0, detail: `${d.egress.log.length - offMachine.length} loopback request(s) to the local model service; ${offMachine.length} to any other host${offMachine.length ? ` (${[...new Set(offMachine.map(e => e.host))].join(', ')})` : ''}.` },
      { name: 'Without a local model, no request was made at all', ok: semantic || d.egress.log.length === 0, detail: semantic ? 'A local embedding model was configured for this run.' : `${d.egress.log.length} egress log entries.` },
      { name: 'Semantic embeddings stay off unless configured for this run', ok: semantic ? true : !docs.status().semantic && status.embeddingsRevision === null, detail: semantic ? `Explicitly configured: ${opts.embeddingModel}.` : 'No embedding model was configured.' },
      { name: 'Unchanged files kept their chunk IDs across the commit (incremental invalidation)', ok: invalidation.chunksReused >= Math.floor(invalidation.chunksBefore * 0.8), detail: `${invalidation.chunksReused} of ${invalidation.chunksBefore} chunk IDs reused; ${invalidation.chunksAdded} added; ${invalidation.chunksRemoved} removed.` },
      { name: 'Notes, embeddings and graph revisions align with the committed revision, or are visibly stale', ok: invalidation.revisionAligned, detail: `notes ${status.notesRevision?.slice(0, 8) ?? 'none'}, embeddings ${status.embeddingsRevision?.slice(0, 8) ?? 'off'}, graph ${status.graphRevision?.slice(0, 8) ?? 'off'}, commit ${v2Sha.slice(0, 8)}.` },
    ];
    const staleLabels: string[] = [];
    if (!status.embeddingsRevision) staleLabels.push('embeddings: not built (semantic search off or incomplete)');
    if (!status.graphRevision) staleLabels.push('graph: not built for this revision (Graphify missing or failed)');

    // ---- summaries --------------------------------------------------------------------------------------
    const arm = (id: BenchmarkArmSummary['id'], label: string, rows: BenchmarkQuestionResult[], extra: Partial<BenchmarkArmSummary> = {}): BenchmarkArmSummary => {
      const n = rows.length;
      const total = rows.reduce((s, r) => s + r.contextBytes, 0);
      const answerable = rows.filter(r => !r.shouldAbstain);
      const abst = rows.filter(r => r.shouldAbstain);
      const cites = rows.filter(r => r.cited.length);
      const judged = rows.filter(r => r.kind !== 'dependency' && r.support);
      return {
        id, label, status: 'measured', questions: n, contextBytes: total, contextBytesPerQuestion: n ? Math.round(total / n) : 0, estimatedTokensPerQuestion: n ? estimateTokens(total / n) : 0,
        latencyMsP50: percentile(rows.map(r => r.latencyMs), 50), latencyMsP95: percentile(rows.map(r => r.latencyMs), 95),
        retrievalAccuracy: answerable.length ? answerable.filter(r => r.correct).length / answerable.length : null,
        citationIntegrity: cites.length ? cites.filter(r => r.integrityViolations === 0).length / cites.length : null,
        abstentionAccuracy: abst.length ? abst.filter(r => r.correct).length / abst.length : null,
        recall: answerable.length ? Math.round((answerable.reduce((n, r) => n + (r.recall ?? 0), 0) / answerable.length) * 1000) / 1000 : null,
        answerSupport: judged.length ? Math.round((judged.filter(r => (r.shouldAbstain ? r.support === 'insufficient' : r.support === 'supported')).length / judged.length) * 1000) / 1000 : null, ...extra,
      };
    };
    const RETRIEVAL_KINDS = ['lookup', 'multi', 'abstain', 'scope', 'version', 'dependency', 'design', 'deleted'];
    const stackRows = results.filter(r => RETRIEVAL_KINDS.includes(r.kind) && !r.arm);
    const armRows = (arm: RetrievalArm) => results.filter(r => RETRIEVAL_KINDS.includes(r.kind) && r.arm === arm);
    // Baseline: every included file is placed in context, so every answerable fact is "present" by construction.
    const readStart = performance.now();
    const baselineRead = Object.keys(current).reduce((n, f) => n + (fs.existsSync(path.join(repo, f)) ? fs.readFileSync(path.join(repo, f)).length : 0), 0);
    const readMs = Math.round((performance.now() - readStart) * 100) / 100;
    void baselineRead;
    const baselineRows: BenchmarkQuestionResult[] = stackRows.map(r => ({ ...r, cited: [], correct: !r.shouldAbstain, abstained: false, integrityViolations: 0, leaked: [], staleHits: [], contextBytes: r.stage === 'v1' ? baselineBytesV1 : baselineBytesV2, latencyMs: readMs }));
    const arms: BenchmarkArmSummary[] = [
      { ...arm('full_context', 'Full-context baseline (every included file in the prompt)', baselineRows), citationIntegrity: null, abstentionAccuracy: null, reason: 'No retrieval step: every fact is present by construction, so this arm measures size and read time only. It cannot abstain or cite lines.' },
      arm('dictionary', 'One Ask: keywords + import-graph expansion (cited passages)', stackRows),
      arm('keyword_only', 'Keyword-only retrieval (no graph expansion)', armRows('keyword_only')),
      semantic
        ? arm('hybrid', `Hybrid: keywords + local embeddings (${opts.embeddingModel}) + graph expansion`, armRows('hybrid'))
        : { id: 'hybrid', label: 'Hybrid: keywords + local embeddings + graph expansion', status: 'pending', reason: 'No already-installed local embedding model was supplied for this run. Nothing is downloaded; run `acc bench context --embedding-model <installed model>` to measure it.', questions: 0, contextBytes: 0, contextBytesPerQuestion: 0, estimatedTokensPerQuestion: 0, latencyMsP50: null, latencyMsP95: null, retrievalAccuracy: null, citationIntegrity: null, abstentionAccuracy: null, recall: null, answerSupport: null },
      graphRows.length
        ? { id: 'graphify', label: 'Graphify code graph query', status: 'measured', questions: graphRows.length, contextBytes: graphRows.reduce((n, r) => n + r.bytes, 0), contextBytesPerQuestion: Math.round(graphRows.reduce((n, r) => n + r.bytes, 0) / graphRows.length), estimatedTokensPerQuestion: estimateTokens(graphRows.reduce((n, r) => n + r.bytes, 0) / graphRows.length), latencyMsP50: percentile(graphRows.map(r => r.latency), 50), latencyMsP95: percentile(graphRows.map(r => r.latency), 95), retrievalAccuracy: graphRows.filter(r => r.ok).length / graphRows.length, citationIntegrity: null, abstentionAccuracy: null }
        : { id: 'graphify', label: 'Graphify code graph query', status: 'not_measured', reason: graph ? `Graph is ${graph.status.state}${graph.status.error ? `: ${graph.status.error}` : ''}.` : 'Graphify was not configured for this run (no binary given).', questions: 0, contextBytes: 0, contextBytesPerQuestion: 0, estimatedTokensPerQuestion: 0, latencyMsP50: null, latencyMsP95: null, retrievalAccuracy: null, citationIntegrity: null, abstentionAccuracy: null },
      { id: 'skills_on_demand', label: 'On-demand skills (descriptions first, body when chosen)', status: 'measured', questions: skillRows.length, contextBytes: skillRows.reduce((n, r) => n + r.bytes, 0), contextBytesPerQuestion: Math.round(skillRows.reduce((n, r) => n + r.bytes, 0) / Math.max(1, skillRows.length)), estimatedTokensPerQuestion: estimateTokens(skillRows.reduce((n, r) => n + r.bytes, 0) / Math.max(1, skillRows.length)), latencyMsP50: percentile(skillRows.map(r => r.latency), 50), latencyMsP95: percentile(skillRows.map(r => r.latency), 95), retrievalAccuracy: skillRows.filter(r => r.ok).length / Math.max(1, skillRows.length), citationIntegrity: null, abstentionAccuracy: null, reason: `Compared with loading every skill up front (${eagerSkillBytes} bytes per question).` },
    ];
    const files = Object.keys(current).length;
    const result: ContextBenchmarkResult = {
      id: newId('bench'), at: new Date().toISOString(),
      corpus: { name: CORPUS_NAME, version: CORPUS_VERSION, files, bytes: baselineBytesV2, questions: BENCH_QUESTIONS.length, skills: Object.keys(BENCH_SKILLS).length, disposable: true },
      method: [
        'A disposable git repository and vault are generated from a fixed corpus and deleted afterwards; no project data is read.',
        'One Ask runs its real intake on the committed revision, then again after a second commit (version change).',
        'Retrieval accuracy: every expected source path is cited and the expected fact appears in the cited excerpts. Abstention: the question’s terms must be supported by the top cited excerpts (threshold 0.6).',
        'Citation integrity: each excerpt must be verbatim committed text within the cited lines and carry the committed file hash.',
        'Arms: dictionary = keywords + import-graph expansion; keyword_only = the same index without expansion; hybrid = + local embeddings (only with an installed model).',
        'Recall: share of expected source files cited per answerable question. Evidence verdict: Dictionary\'s own lexical coverage check of the cited excerpts.',
        'Context bytes are UTF-8 bytes of what the arm would put in a prompt. Estimated tokens are bytes divided by 4.',
      ],
      arms, questions: results, invalidation,
      scope: { canaries: canaryValues.length, leaked },
      alignment: { notesRevision: status.notesRevision, embeddingsRevision: status.embeddingsRevision, graphRevision: status.graphRevision, stale: staleLabels },
      tokens: { estimate: 'bytes/4', providerReported: null, note: 'No model was called, so there are no provider-reported tokens. The estimates are not proof of token savings or of answer quality outside this labelled set.' },
      regressions: [], checks,
      resources: { intakeMs, incrementalMs, rssMb: Math.round(process.memoryUsage().rss / 1048576), heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576), note: 'Wall-clock time and process memory of this daemon process on this machine, including the test harness. Not a capacity guarantee.' },
      tradeoffs: [],
      limits: [
        'This is a small, synthetic English corpus. It guards against regressions in this pipeline; it does not show general answer quality.',
        'The baseline cannot fail retrieval by construction; its value here is byte size and read time.',
        'Graphify results exist only when a Graphify binary was supplied and built a graph for the committed revision.',
        'Latency is measured on this machine for local keyword retrieval; embeddings were off unless stated.',
        'The labelled questions were written by the developers alongside the corpus; they are a regression guard, not an independent held-out evaluation.',
        'The hybrid arm is pending unless an already-installed local embedding model is supplied; its absence is not reported as a pass.',
      ],
    };
    const kw = result.arms.find(a => a.id === 'keyword_only'), oa = result.arms.find(a => a.id === 'dictionary');
    if (kw && oa && kw.status === 'measured') {
      const dKw = results.find(r => r.id === 'D1' && r.arm === 'keyword_only'), dOa = results.find(r => r.id === 'D1' && !r.arm);
      result.tradeoffs!.push(`Recall: graph-assisted ${pct(oa.recall)} vs keyword-only ${pct(kw.recall)}. On the structural question D1 keyword-only cited ${dKw?.cited.length ?? 0} of 3 expected files; graph-assisted cited ${dOa ? dOa.expected.filter(e => dOa.cited.includes(e)).length : 0}.`);
      result.tradeoffs!.push(`Context size: graph-assisted ${oa.contextBytesPerQuestion} vs keyword-only ${kw.contextBytesPerQuestion} bytes per question (${oa.contextBytesPerQuestion >= kw.contextBytesPerQuestion ? 'expansion adds context' : 'no extra context'}). Latency p50 ${oa.latencyMsP50} vs ${kw.latencyMsP50} ms.`);
      result.tradeoffs!.push(`Evidence verdicts (lexical coverage) were right on ${pct(oa.answerSupport ?? null)} of non-structural questions; this heuristic can miss paraphrased support, so a supported/insufficient label is advisory.`);
    }
    result.regressions = [...benchmarkRegressions(result), ...checks.filter(c => !c.ok).map(c => `check failed: ${c.name}`)];
    return result;
  } finally {
    await d.shutdown().catch(() => undefined);
    if (!opts.keepDir) fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Latest result store and run guard used by the daemon API. */
export class ContextBenchmarks {
  running = false;
  private d: Daemon;
  constructor(d: Daemon) { this.d = d; }

  latest(): ContextBenchmarkResult | null {
    try { const raw = this.d.store.kvGet('benchmark:context:latest'); return raw ? JSON.parse(raw) as ContextBenchmarkResult : null; } catch { return null; }
  }

  async run(o: BenchmarkOptions = {}): Promise<ContextBenchmarkResult> {
    if (this.running) throw new Error('A benchmark is already running.');
    this.running = true;
    try {
      const graphify = o.graphifyBinary ?? this.d.config.graphify?.binary;
      const result = await runContextBenchmark({ ...o, graphifyBinary: graphify && fs.existsSync(graphify) ? graphify : undefined });
      const dir = path.join(this.d.paths.root, 'benchmarks');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `context-${result.id}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
      if (!this.d.closed) {
        this.d.store.kvSet('benchmark:context:latest', JSON.stringify(result));
        this.d.commit([{ type: 'benchmark.completed', data: { runId: result.id, corpus: `${result.corpus.name}@${result.corpus.version}`, summary: { regressions: result.regressions, arms: result.arms.map(a => ({ id: a.id, status: a.status, retrievalAccuracy: a.retrievalAccuracy })) } } }]);
      }
      return result;
    } finally { this.running = false; }
  }
}
