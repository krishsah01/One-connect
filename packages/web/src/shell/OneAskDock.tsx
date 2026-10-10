// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// One Ask, always on the canvas: ask what you're unsure about, see cited sources, and get a
// plain-language summary from the bundled local model. The answer can become a canvas node.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { DocAnswer } from '@acc/core';
import { api, ApiError, post } from '../lib/api';
import { Icon } from './icons';

export interface AskResult { question: string; answer: string; sources: string[] }
interface LocalStatus { available: boolean }

export function OneAskDock({ onAdd }: { onAdd: (r: AskResult) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<'ask' | 'summary' | null>(null);
  const [result, setResult] = useState<DocAnswer | null>(null);
  const [asked, setAsked] = useState('');
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { input.current?.focus(); if (!local) void api<LocalStatus>('/api/local-models').then(setLocal).catch(() => setLocal({ available: false })); } }, [open, local]);

  const summarize = async (question: string, r: DocAnswer) => {
    if (!r.citations.length) return;
    setBusy('summary');
    try {
      const s = await post<{ summary: string }>('/api/local-models/summarize', { question, sources: r.citations.slice(0, 8).map(c => ({ path: `${c.path}:${c.line}`, excerpt: c.excerpt })) });
      setSummary(s.summary);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const ask = async () => {
    const question = q.trim();
    if (!question) { setError('Type a question first.'); return; }
    setBusy('ask'); setError(null); setSummary(null); setResult(null);
    try {
      const r = await post<DocAnswer>('/api/context/answer/search', { query: question });
      setResult(r); setAsked(question); setBusy(null);
      if (local?.available) await summarize(question, r);
    } catch (e) {
      setBusy(null);
      setError(e instanceof ApiError && e.status === 409 ? 'Connect your project knowledge in One Ask first.' : e instanceof Error ? e.message : String(e));
    }
  };
  const answerText = summary ?? (result?.claims.length ? result.claims.map(c => c.text).join('\n') : result?.citations.slice(0, 3).map(c => `${c.path}:${c.line} ${c.excerpt}`).join('\n') ?? '');

  if (!open) return <button type="button" className="ask-pill" onClick={() => setOpen(true)} aria-expanded="false"><Icon name="ask" size={16} />One Ask</button>;
  return (
    <section className="ask-dock" aria-label="One Ask" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
      <div className="row"><Icon name="ask" size={16} /><b className="grow">One Ask</b><Link className="small" to="/docs">Full view</Link><button type="button" className="shell-icon-btn" aria-label="Close One Ask" onClick={() => setOpen(false)}><Icon name="close" size={14} /></button></div>
      <form onSubmit={e => { e.preventDefault(); void ask(); }} className="col" style={{ gap: 6 }}>
        <textarea ref={input} rows={2} maxLength={1200} aria-label="Ask about this project" placeholder="What are you unsure about? e.g. Where is checkout handled?" value={q} onChange={e => { setQ(e.target.value); setError(null); }}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(); } }} />
        <div className="row"><span className="small faint grow">{local?.available ? 'Summaries by the bundled local model' : 'Cited sources from your project'}</span><button type="submit" className="btn sm primary" disabled={busy !== null}>{busy === 'ask' ? 'Asking…' : 'Ask'}</button></div>
      </form>
      {error && <p className="small crit-text" role="alert">{error}</p>}
      {result && <div className="ask-result" aria-live="polite">
        {busy === 'summary' && <p className="small muted">Summarizing…</p>}
        {summary && <div className="ask-summary"><span className="small muted"><Icon name="spark" size={12} /> Plain-language summary</span><p>{summary}</p></div>}
        {!summary && result.claims.length > 0 && <ul className="ask-claims">{result.claims.map((c, i) => <li key={i}>{c.text}</li>)}</ul>}
        {result.citations.length === 0 ? <p className="small muted">No sources matched. Try different words.</p> : <details><summary className="small">{result.citations.length} source{result.citations.length === 1 ? '' : 's'}</summary><ul className="ask-sources">{result.citations.slice(0, 8).map(c => <li key={c.id}><code>{c.path}:{c.line}</code><span className="small muted">{c.excerpt.slice(0, 160)}</span></li>)}</ul></details>}
        <div className="row" style={{ gap: 6 }}>
          {!summary && local?.available && result.citations.length > 0 && <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void summarize(asked, result)}>Summarize</button>}
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={!answerText} onClick={() => onAdd({ question: asked, answer: answerText, sources: result.citations.slice(0, 20).map(c => `${c.path}:${c.line}`) })}>Add to canvas</button>
        </div>
      </div>}
    </section>
  );
}
