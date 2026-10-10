// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Results of the context-quality benchmark on the disposable fixture corpus. Sizes are bytes and
// bytes/4 ESTIMATES; provider-reported tokens do not exist because no model is called.
import { useCallback, useEffect, useState } from 'react';
import type { ContextBenchmarkResult } from '@acc/core';
import { Badge, ErrorLine, useAction } from './common';
import { api, post } from '../lib/api';

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

export function ContextBenchmarkPanel() {
  const [r, setR] = useState<ContextBenchmarkResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api<{ latest: ContextBenchmarkResult | null }>('/api/benchmark/context').then((x) => { setR(x.latest); setLoaded(true); }).catch(() => setLoaded(true)), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="card" aria-label="Context quality benchmark"><div className="card-b col" style={{ gap: 10 }}>
      <div className="row wrap"><h2>Context quality benchmark</h2><span className="spacer" /><button className="btn" disabled={busy} onClick={() => void run(async () => { const x = await post<{ result: ContextBenchmarkResult }>('/api/benchmark/context/run'); setR(x.result); })}>{busy ? 'Running…' : 'Run on the fixture corpus'}</button></div>
      <p className="small muted" style={{ margin: 0 }}>Compares One Ask retrieval, Graphify and on-demand skills with a full-context baseline on a disposable corpus with labelled questions. No project data is read, no model is called and nothing is downloaded. It guards this pipeline against regressions; it does not prove general answer quality.</p>
      {!r && loaded && <div className="small muted">No run yet.</div>}
      {r && (
        <>
          <div className="row wrap small"><Badge tone={r.regressions.length ? 'crit' : 'ok'}>{r.regressions.length ? `${r.regressions.length} regression${r.regressions.length === 1 ? '' : 's'}` : 'no regression on this set'}</Badge><span className="faint">{new Date(r.at).toLocaleString()} · {r.corpus.name} v{r.corpus.version} · {r.corpus.files} files, {r.corpus.bytes} bytes, {r.corpus.questions} labelled questions</span></div>
          {r.regressions.map((x) => <div key={x} className="banner tone-crit small">{x}</div>)}
          <div className="table-scroll"><table className="bench-table">
            <thead><tr><th>Arm</th><th>Bytes / question</th><th>Est. tokens</th><th>Latency p50 / p95</th><th>Retrieval</th><th>Citations</th><th>Abstention</th></tr></thead>
            <tbody>{r.arms.map((a) => (
              <tr key={a.id}>
                <td>{a.label}{a.status === 'not_measured' && <div className="small faint">Not measured: {a.reason}</div>}{a.status === 'measured' && a.reason && <div className="small faint">{a.reason}</div>}</td>
                <td>{a.status === 'measured' ? a.contextBytesPerQuestion.toLocaleString() : '–'}</td>
                <td>{a.status === 'measured' ? `~${a.estimatedTokensPerQuestion.toLocaleString()}` : '–'}</td>
                <td>{a.latencyMsP50 === null ? '–' : `${a.latencyMsP50} / ${a.latencyMsP95} ms`}</td>
                <td>{pct(a.retrievalAccuracy)}</td><td>{pct(a.citationIntegrity)}</td><td>{pct(a.abstentionAccuracy)}</td>
              </tr>))}</tbody>
          </table></div>
          <div className="small faint">Estimated tokens are bytes divided by 4. Provider-reported tokens: none (no inference). A byte ratio is not proven token savings.</div>
          {r.invalidation && <div className="small">Version change: {r.invalidation.chunksReused} of {r.invalidation.chunksBefore} passages reused, {r.invalidation.chunksAdded} added, {r.invalidation.chunksRemoved} removed, {r.invalidation.staleChunkRemaining} stale passages left; notes revision {r.invalidation.revisionAligned ? 'matches' : 'does NOT match'} the commit.</div>}
          <div className="small">Scope probes: {r.scope.leaked} of {r.scope.canaries} out-of-scope canary strings leaked. Index revisions: notes {r.alignment.notesRevision?.slice(0, 8) ?? 'none'}, embeddings {r.alignment.embeddingsRevision?.slice(0, 8) ?? 'off'}, graph {r.alignment.graphRevision?.slice(0, 8) ?? 'off'}.{r.alignment.stale.length ? ` Stale or absent: ${r.alignment.stale.join('; ')}.` : ''}</div>
          <details><summary className="small">Checks, method and limits</summary>
            <ul className="small">{r.checks.map((c) => <li key={c.name}>{c.ok ? '✓' : '✗'} {c.name}: {c.detail}</li>)}</ul>
            <ul className="small">{r.method.map((m) => <li key={m}>{m}</li>)}</ul>
            <ul className="small">{r.limits.map((m) => <li key={m}>{m}</li>)}</ul>
          </details>
          <details><summary className="small">Per-question results ({r.questions.length})</summary>
            <div className="table-scroll"><table className="bench-table"><thead><tr><th>ID</th><th>Kind</th><th>Result</th><th>Cited</th><th>Bytes</th><th>ms</th></tr></thead><tbody>{r.questions.map((q) => <tr key={q.id}><td>{q.id}</td><td>{q.kind}</td><td>{q.correct ? 'correct' : 'WRONG'}{q.shouldAbstain ? (q.abstained ? ' (abstained)' : ' (answered)') : ''}</td><td className="small">{q.cited.join(', ') || '–'}</td><td>{q.contextBytes}</td><td>{q.latencyMs}</td></tr>)}</tbody></table></div>
          </details>
        </>
      )}
      <ErrorLine error={error} />
    </div></section>
  );
}
