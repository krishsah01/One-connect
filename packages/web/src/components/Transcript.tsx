// SPDX-License-Identifier: Apache-2.0
// Live, filterable transcript of one run's structured events.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope } from '@acc/core';
import { api } from '../lib/api';
import { hhmm } from '../lib/format';

const FILTERS = {
  all: () => true,
  messages: (e: EventEnvelope) => e.type === 't.message' || e.type === 't.reasoning',
  commands: (e: EventEnvelope) => e.type === 't.command' || e.type === 't.tool_call' || e.type === 't.tool_result',
  edits: (e: EventEnvelope) => e.type === 't.file_edit' || e.type === 't.commit',
  tests: (e: EventEnvelope) => e.type === 't.test_result' || (e.type === 't.command' && /test/i.test(e.data.command)),
  errors: (e: EventEnvelope) => e.type === 't.error' || (e.type === 't.command' && e.data.status === 'failed') || (e.type === 't.raw' && e.data.stream === 'stderr'),
  raw: () => false,
} as const;
type Filter = keyof typeof FILTERS;

/** The vendor CLI's own output, exactly as the durable (redacted) log recorded it. */
export function RawLog({ runId, active }: { runId: string; active: boolean }) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [page, setPage] = useState({ text: '', offset: 0, nextOffset: 0, totalBytes: 0 });
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => api<typeof page>(`/api/runs/${runId}/log/page?stream=${stream}&offset=${offset}`).then(p => { if (alive) { setPage(p); setError(''); } }).catch(e => alive && setError(String(e)));
    void load();
    const i = active ? setInterval(load, 1500) : null;
    return () => {
      alive = false;
      if (i) clearInterval(i);
    };
  }, [runId, stream, active, offset]);
  return (
    <div className="col" style={{ gap: 6, padding: '8px 14px' }}>
      <div className="chips">
        {(['stdout', 'stderr'] as const).map((s) => (
          <button key={s} type="button" className={`chip${stream === s ? ' on' : ''}`} onClick={() => { setStream(s); setOffset(0); setHistory([]); }}>
            {s}
          </button>
        ))}
      </div>
      <div className="row small faint">
        <button className="btn sm" disabled={!history.length} onClick={() => { setOffset(history.at(-1)!); setHistory(history.slice(0, -1)); }}>Previous</button>
        <span>Bytes {page.offset}–{page.nextOffset} of {page.totalBytes}</span>
        <button className="btn sm" disabled={page.nextOffset >= page.totalBytes} onClick={() => { setHistory([...history, offset]); setOffset(page.nextOffset); }}>Next</button>
      </div>
      {error && <div className="error">{error}</div>}
      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5 }}>{page.text || '(empty)'}</pre>
    </div>
  );
}

function Row({ e }: { e: EventEnvelope }) {
  const t = <span className="t">{hhmm(e.ts)}</span>;
  switch (e.type) {
    case 't.message':
      return (
        <div className={`ev msg${e.data.role === 'user' ? ' user' : ''}`}>
          {t}
          <span>{e.data.role === 'user' ? '›' : '◆'}</span>
          <div className="body">{e.data.text}</div>
        </div>
      );
    case 't.reasoning':
      return (
        <div className="ev sys">
          {t}
          <span>∴</span>
          <details className="body">
            <summary>reasoning</summary>
            {e.data.text}
          </details>
        </div>
      );
    case 't.command': {
      const failed = e.data.status === 'failed';
      return (
        <div className={`ev cmd${failed ? ' err' : ''}`}>
          {t}
          <span>$</span>
          <div className="body">
            {e.data.command}
            {e.data.status !== 'started' && <span className={failed ? '' : 'faint'}>{`  → exit ${e.data.exitCode ?? '?'}`}</span>}
            {e.data.output && (
              <details>
                <summary>output</summary>
                <pre>{e.data.output}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    case 't.file_edit':
      return (
        <div className="ev">
          {t}
          <span>✎</span>
          <div className="body">
            {e.data.change} <b>{e.data.path}</b>
          </div>
        </div>
      );
    case 't.test_result':
      return (
        <div className={`ev${e.data.counts.failed ? ' err' : ''}`}>
          {t}
          <span>✓</span>
          <div className="body">
            tests: {e.data.counts.passed} passed, {e.data.counts.failed} failed{e.data.counts.skipped ? `, ${e.data.counts.skipped} skipped` : ''} <span className="faint">({e.data.command})</span>
          </div>
        </div>
      );
    case 't.commit':
      return (
        <div className="ev">
          {t}
          <span>●</span>
          <div className="body">
            commit <b>{e.data.sha.slice(0, 10)}</b> {e.data.subject}
          </div>
        </div>
      );
    case 't.tool_call':
      return (
        <div className="ev cmd">
          {t}
          <span>⚙</span>
          <div className="body">
            {e.data.name} <span className="faint">{e.data.summary}</span>
          </div>
        </div>
      );
    case 't.tool_result':
      return (
        <div className={`ev sys${e.data.ok ? '' : ' err'}`}>
          {t}
          <span>↳</span>
          <div className="body">{e.data.summary}</div>
        </div>
      );
    case 't.error':
      return (
        <div className="ev err">
          {t}
          <span>!</span>
          <div className="body">
            {e.data.failure ? `[${e.data.failure}] ` : ''}
            {e.data.message}
          </div>
        </div>
      );
    case 't.system':
      return (
        <div className="ev sys">
          {t}
          <span>·</span>
          <div className="body">{e.data.text}</div>
        </div>
      );
    case 't.raw':
      return (
        <div className={`ev raw${e.data.stream === 'stderr' ? ' err' : ''}`}>
          {t}
          <span>{e.data.stream === 'stderr' ? '⚠' : '·'}</span>
          <div className="body">{e.data.line}</div>
        </div>
      );
    case 't.usage':
      return null;
    default:
      return null;
  }
}

export function Transcript({ events, live, runId, active, footer }: { events: EventEnvelope[]; live?: { assistant: string; reasoning: string } | null; runId?: string | null; active?: boolean; footer?: React.ReactNode }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => events.filter((e) => e.kind === 'transcript' && FILTERS[filter](e)), [events, filter]);
  const [pageStart, setPageStart] = useState<number | null>(null);
  const start = pageStart === null ? Math.max(0, shown.length - 200) : Math.min(pageStart, Math.max(0, shown.length - 1));
  const visible = shown.slice(start, start + 200);
  useEffect(() => { setPageStart(null); }, [runId, filter]);
  const liveLen = (live?.assistant.length ?? 0) + (live?.reasoning.length ?? 0);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, liveLen, follow]);
  return (
    <div className="col" style={{ gap: 0 }}>
      <div className="row wrap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <div className="chips">
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <button key={f} type="button" className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="row small faint" style={{ gap: 5 }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} style={{ width: 'auto' }} /> follow
        </label>
      </div>
      {filter !== 'raw' && shown.length > 200 && <div className="row small faint" style={{ padding: '6px 14px' }}>
        <button className="btn sm" disabled={start === 0} onClick={() => { setPageStart(Math.max(0, start - 200)); setFollow(false); }}>Earlier</button>
        <span>Events {start + 1}–{Math.min(start + 200, shown.length)} of {shown.length}</span>
        <button className="btn sm" disabled={pageStart === null} onClick={() => setPageStart(start + 200 >= shown.length - 200 ? null : start + 200)}>Later</button>
        <button className="btn sm" disabled={pageStart === null} onClick={() => { setPageStart(null); setFollow(true); }}>Latest</button>
      </div>}
      <div
        className="transcript"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {filter === 'raw' && runId ? (
          <RawLog runId={runId} active={Boolean(active)} />
        ) : (
          <>
            {shown.length === 0 && !liveLen && <div className="empty">{events.length ? 'Nothing matches this filter.' : 'No events yet.'}</div>}
            {visible.map((e) => (
              <Row key={e.seq} e={e} />
            ))}
            {(filter === 'all' || filter === 'messages') && live?.reasoning && (
              <div className="ev sys live">
                <span className="t">live</span>
                <span>∴</span>
                <div className="body">{live.reasoning}</div>
              </div>
            )}
            {(filter === 'all' || filter === 'messages') && live?.assistant && (
              <div className="ev msg live">
                <span className="t">live</span>
                <span>◆</span>
                <div className="body">
                  {live.assistant}
                  <span className="caret" />
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {footer}
    </div>
  );
}
