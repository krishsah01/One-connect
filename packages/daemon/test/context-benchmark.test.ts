// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The context-quality benchmark on its disposable corpus: quality is asserted (no regression), sizes
// are labelled estimates, scope probes and incremental invalidation are guarded, and no paid or
// network step is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { benchmarkRegressions } from '@acc/core';
import { evidenceSupport, runContextBenchmark, supportTerms } from '../src/benchmark/contextBenchmark.ts';
import { BENCH_QUESTIONS, corpusFilesV1 } from '../src/benchmark/corpus.ts';
import { makeConfig, makeRepo, startDaemon } from './helpers.ts';

const FAKE_GRAPHIFY = path.join(import.meta.dirname, 'fixtures', 'fake-graphify.mjs');

describe('context benchmark', () => {
  it('retrieves every labelled fact with intact citations, abstains, stays in scope and updates incrementally', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('one-connect-bench-')).length;
    const r = await runContextBenchmark({});
    expect(r.regressions).toEqual([]);
    expect(benchmarkRegressions(r)).toEqual([]);
    const stack = r.arms.find((a) => a.id === 'dictionary')!;
    const base = r.arms.find((a) => a.id === 'full_context')!;
    expect(stack).toMatchObject({ status: 'measured', retrievalAccuracy: 1, citationIntegrity: 1, abstentionAccuracy: 1 });
    expect(base.retrievalAccuracy).toBe(1);
    expect(stack.contextBytesPerQuestion).toBeLessThan(base.contextBytesPerQuestion / 5);
    expect(r.arms.find((a) => a.id === 'skills_on_demand')!.retrievalAccuracy).toBe(1);
    expect(r.arms.find((a) => a.id === 'graphify')).toMatchObject({ status: 'not_measured' });
    // abstention and scope probes
    for (const q of r.questions.filter((x) => x.shouldAbstain)) expect(q.abstained && q.correct, q.id).toBe(true);
    expect(r.scope).toEqual({ canaries: 2, leaked: 0 });
    // version change: new facts found, superseded text gone, unchanged passages reused
    for (const id of ['V1', 'V2', 'V3']) expect(r.questions.find((q) => q.id === id)!.correct, id).toBe(true);
    expect(r.questions.flatMap((q) => q.staleHits)).toEqual([]);
    expect(r.invalidation!.staleChunkRemaining).toBe(0);
    expect(r.invalidation!.chunksReused / r.invalidation!.chunksBefore).toBeGreaterThan(0.8);
    expect(r.invalidation!.revisionAligned).toBe(true);
    // honesty about what was measured
    expect(r.tokens).toMatchObject({ estimate: 'bytes/4', providerReported: null });
    expect(r.alignment.stale.join(' ')).toMatch(/embeddings: not built/);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.find((c) => c.name.startsWith('No request left'))!.ok).toBe(true);
    expect(r.checks.find((c) => c.name.startsWith('Without a local model'))!.ok).toBe(true);
    // Arms are reported separately; the hybrid arm is pending (never green) without an installed model.
    expect(r.arms.find((a) => a.id === 'hybrid')).toMatchObject({ status: 'pending', retrievalAccuracy: null });
    const kw = r.arms.find((a) => a.id === 'keyword_only')!;
    expect(kw.status).toBe('measured');expect(stack.recall).toBeGreaterThanOrEqual(kw.recall!);
    expect(r.questions.find((q) => q.id === 'D1' && !q.arm)!.correct).toBe(true);
    expect(r.questions.find((q) => q.id === 'V4' && !q.arm)).toMatchObject({ correct: true, abstained: true, staleHits: [] });
    expect(r.tradeoffs!.length).toBeGreaterThan(0);expect(r.resources!.intakeMs).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain('CANARY-');
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('one-connect-bench-')).length).toBe(before); // disposable corpus is removed
  }, 60_000);

  it('exercises Graphify end to end when a binary is supplied, with matching revisions', async () => {
    const r = await runContextBenchmark({ graphifyBinary: FAKE_GRAPHIFY });
    const g = r.arms.find((a) => a.id === 'graphify')!;
    expect(g.status).toBe('measured');
    expect(g.retrievalAccuracy).toBe(1);
    expect(r.alignment.graphRevision).toBe(r.alignment.notesRevision);
    expect(r.regressions).toEqual([]);
  }, 60_000);

  it('flags a regression instead of reporting success', async () => {
    const r = await runContextBenchmark({});
    const broken = structuredClone(r);
    broken.arms.find((a) => a.id === 'dictionary')!.retrievalAccuracy = 0.8;
    broken.scope.leaked = 1;
    broken.invalidation!.staleChunkRemaining = 2;
    expect(benchmarkRegressions(broken).join(' ')).toMatch(/retrieval accuracy 80%.*out-of-scope.*stale content/);
  }, 60_000);

  it('uses a deterministic labelled corpus and a transparent abstention rule', () => {
    expect(corpusFilesV1()).toEqual(corpusFilesV1());
    expect(BENCH_QUESTIONS.some((q) => q.kind === 'abstain')).toBe(true);
    expect(BENCH_QUESTIONS.some((q) => q.kind === 'version')).toBe(true);
    expect(supportTerms('How many minutes before a booking session expires?')).toEqual(['minut', 'befor', 'booki', 'sessi', 'expir']);
    expect(evidenceSupport('luggage weight limit', ['Refunds take nine days'])).toBe(0);
    expect(evidenceSupport('refunds take days', ['Refunds are issued within days'])).toBeGreaterThanOrEqual(0.6);
  });

  it('runs through the daemon API, persists the latest result and records an event', async () => {
    const h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    try {
      const token = fs.readFileSync(path.join(h.d.paths.secrets, 'install-token'), 'utf8').trim();
      const call = (p: string, method = 'GET') => fetch(h.url + p, { method, headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined });
      expect((await (await call('/api/benchmark/context')).json() as { latest: unknown }).latest).toBeNull();
      const run = await (await call('/api/benchmark/context/run', 'POST')).json() as { result: { regressions: string[] } };
      expect(run.result.regressions).toEqual([]);
      const latest = await (await call('/api/benchmark/context')).json() as { latest: { id: string } };
      expect(latest.latest.id).toBeTruthy();
      expect(h.d.store.list({ types: ['benchmark.completed'] })).toHaveLength(1);
      expect(fs.readdirSync(path.join(h.d.paths.root, 'benchmarks')).length).toBe(1);
    } finally { await h.close(); }
  }, 90_000);
});
