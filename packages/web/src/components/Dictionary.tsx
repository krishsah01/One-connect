// SPDX-License-Identifier: Apache-2.0
// One Ask building blocks: intake status and progress, per-stage freshness, change report,
// installed local models, cited search with an evidence verdict, the committed-file viewer, the
// declarative structure explorer and the agent context-packet preview. Every status is spelled
// out in text; color only reinforces it.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ControlState, DocAnswer, DocCitation, DictionaryStage, DictionaryStageName, DictionaryStatus } from '@acc/core';
import { Badge, ErrorLine, useAction } from './common';
import { api, post } from '../lib/api';
import './dictionary.css';

type Tone = 'ok' | 'warn' | 'crit' | 'idle' | 'info';
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : null);
const STAGES: { id: DictionaryStageName; label: string; help: string }[] = [
  { id: 'extract', label: 'Committed source', help: 'Exact Git blobs of the indexed revision, redacted before storage.' },
  { id: 'notes', label: 'Project notes', help: 'One generated Markdown note per included file in this project’s own vault folder.' },
  { id: 'structure', label: 'Import graph', help: 'Declarative imports, module declarations and doc → code mentions. Not a call graph.' },
  { id: 'keywords', label: 'Keyword index', help: 'Local SQLite full-text search. Works without any model.' },
  { id: 'vectors', label: 'Semantic vectors', help: 'Optional embeddings from an already-installed local Ollama model.' },
  { id: 'graph', label: 'Graphify', help: 'Optional AST code graph from your installed Graphify. No LLM mode.' },
];
const STAGE_TEXT: Record<DictionaryStage['state'], string> = { pending: 'Pending', running: 'Running', ready: 'Current', off: 'Off', unavailable: 'Not installed', error: 'Failed', stale: 'Stale' };
const stageTone = (s: DictionaryStage['state']): Tone => (s === 'ready' ? 'ok' : s === 'error' ? 'crit' : s === 'stale' || s === 'pending' || s === 'running' ? 'warn' : 'idle');
const STATE_TEXT: Record<DictionaryStatus['state'], string> = { missing: 'Not indexed', extracting: 'Reading committed source', indexing: 'Indexing', ready: 'Ready', partial: 'Partial', error: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled' };
export const stateTone = (s: DictionaryStatus['state'] | undefined): Tone => (s === 'ready' ? 'ok' : s === 'error' ? 'crit' : s === 'extracting' || s === 'indexing' ? 'info' : s ? 'warn' : 'idle');
const running = (s: DictionaryStatus | null | undefined) => Boolean(s && (s.job?.state === 'running' || ['extracting', 'indexing'].includes(s.state)));

/** Compact, reusable status: suitable for the project overview as well as the One Ask page. */
/** A changed selection/unmount revokes late output and errors from earlier requests. */
function useLatestRequest() {
  const epoch=useRef(0),alive=useRef(true);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
  const invalidate=useCallback(()=>{epoch.current++;setBusy(false);setError(null);},[]);
  const run=useCallback(async<T,>(request:()=>Promise<T>,accept:(result:T)=>void)=>{
    const ticket=++epoch.current;setBusy(true);setError(null);
    try{const result=await request();if(alive.current&&ticket===epoch.current)accept(result);}
    catch(e){if(alive.current&&ticket===epoch.current)setError((e as Error).message);}
    finally{if(alive.current&&ticket===epoch.current)setBusy(false);}
  },[]);
  return {busy,error,run,invalidate};
}

export function DictionaryStatusCard({ status, compact, onChanged }: { status: DictionaryStatus | null | undefined; compact?: boolean; onChanged?: () => void }) {
  const { busy, error, run } = useAction();
  const job = status?.job, active = running(status);
  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : null;
  return (
    <section className="card oa-status" aria-label="One Ask intake status"><div className="card-b col">
      <div className="row wrap"><h2>Project intake</h2><Badge tone={stateTone(status?.state)}>{status ? STATE_TEXT[status.state] : 'Not indexed'}</Badge><span className="spacer" />
        {active
          ? <button className="btn" disabled={busy} onClick={() => void run(async () => { await post('/api/context/answer/cancel'); onChanged?.(); })}>Cancel intake</button>
          : <button className="btn" disabled={busy} onClick={() => void run(async () => { await post('/api/context/answer/refresh'); onChanged?.(); })}>{status?.state === 'error' || status?.state === 'cancelled' || status?.state === 'interrupted' ? 'Retry intake' : 'Re-index project'}</button>}
      </div>
      <div className="oa-identity small"><span className="mono">{status?.ref ?? 'integration'} · {short(status?.revision) ?? 'no committed revision'}</span>{status?.updatedAt && <span className="faint">updated {new Date(status.updatedAt).toLocaleString()}</span>}</div>
      {active && job && (
        <div className="oa-progress" role="status" aria-live="polite">
          <div className="row small"><span>{job.stage ? `Stage: ${STAGES.find((s) => s.id === job.stage)?.label ?? job.stage}` : 'Starting'}</span><span className="spacer" /><span>{job.total ? `${job.done.toLocaleString()} of ${job.total.toLocaleString()} new files read` : 'No new files to read'}</span></div>
          <div className="meter" role="progressbar" aria-label="Files read for this intake" aria-valuemin={0} aria-valuemax={job.total || 1} aria-valuenow={job.done}><span style={{ width: `${pct ?? (job.total ? 0 : 100)}%` }} /></div>
          {job.coalesced > 0 && <span className="small faint">{job.coalesced} more request{job.coalesced === 1 ? '' : 's'} will run once, after this intake.</span>}
        </div>
      )}
      {status?.error && <p className={`small ${status.state === 'error' ? 'text-crit' : 'text-warn'}`}>{status.error}</p>}
      {!compact && <StageList status={status} />}
      {!compact && status?.changes && <ChangeSummary changes={status.changes} />}
      <p className="small faint">{status?.files ?? 0} included of {status?.totalFiles ?? 0} tracked files · {status?.excludedFiles ?? 0} excluded{status?.truncated ? ' · PARTIAL: limits reached' : ''} · uncommitted edits are never indexed</p>
      <ErrorLine error={error} />
    </div></section>
  );
}

export function StageList({ status }: { status: DictionaryStatus | null | undefined }) {
  const stages = status?.stages;
  return (
    <ul className="oa-stages" aria-label="Pipeline stages">
      {STAGES.map((s) => {
        const st = stages?.[s.id];
        const matches = st?.revision && st.revision === status?.revision;
        return (
          <li key={s.id} className={`oa-stage tone-${stageTone(st?.state ?? 'pending')}`}>
            <div className="row"><b>{s.label}</b><span className="spacer" /><Badge tone={stageTone(st?.state ?? 'pending')}>{st ? STAGE_TEXT[st.state] : 'Pending'}</Badge></div>
            <span className="small mono">{st?.revision ? `${short(st.revision)}${matches ? '' : ' · older revision'}` : '—'}</span>
            <span className="small faint">{st?.detail ?? s.help}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ChangeSummary({ changes }: { changes: NonNullable<DictionaryStatus['changes']> }) {
  const n = (xs: unknown[]) => xs.length;
  return (
    <details className="oa-changes"><summary className="small">
      Last intake: {changes.mode === 'incremental' ? 'incremental' : 'full rebuild'} ({changes.reason}) · {n(changes.added)} added · {n(changes.modified)} modified · {n(changes.deleted)} deleted · {n(changes.renamed)} renamed · {changes.reread} read from Git, {Math.max(0, changes.reused)} reused
    </summary>
      <div className="oa-change-grid small">
        {([['Added', changes.added], ['Modified', changes.modified], ['Deleted', changes.deleted]] as const).map(([label, xs]) => <div key={label}><b>{label}</b>{xs.length ? <ul>{xs.slice(0, 40).map((p) => <li key={p} className="mono">{p}</li>)}</ul> : <p className="faint">none</p>}</div>)}
        <div><b>Renamed</b>{changes.renamed.length ? <ul>{changes.renamed.slice(0, 40).map((r) => <li key={r.from} className="mono">{r.from} → {r.to}</li>)}</ul> : <p className="faint">none</p>}</div>
      </div>
      <p className="small faint">{changes.from ? `From ${short(changes.from)} to ${short(changes.to)}.` : `First intake at ${short(changes.to)}.`} Deleted files and replaced text are removed from notes, vectors and search.</p>
    </details>
  );
}

interface ModelStatus { endpoint: string | null; reachable: boolean; models: { name: string; family: string | null; parameters: string | null }[]; embedding?: string; answer?: string | null; note: string }
export function LocalModels({ semantic }: { semantic: boolean }) {
  const [m, setM] = useState<ModelStatus | null>(null);
  const { busy, error, run } = useLatestRequest();
  const check = () => void run(()=>api<ModelStatus>('/api/context/answer/models'),setM);
  const installed = (name?: string | null) => Boolean(name && m?.models.some((x) => x.name === name || x.name === `${name}:latest`));
  return (
    <section className="card card-b col oa-models" aria-label="Installed local models">
      <div className="row"><h2>Local models</h2><span className="spacer" /><button className="btn sm" disabled={busy} onClick={check}>{busy ? 'Checking…' : m ? 'Check again' : 'Check installed models'}</button></div>
      {!m && <p className="small muted">{semantic ? 'Semantic search is on. Check that its model is installed on this Mac.' : 'Keyword search works without any model.'} Checking contacts only the local model service on this Mac.</p>}
      {m && <>
        <p className="small"><Badge tone={m.reachable ? 'ok' : 'idle'}>{m.reachable ? 'Local service running' : 'Not reachable'}</Badge> <span className="mono faint">{m.endpoint}</span></p>
        {m.embedding && <p className="small">Embedding model <b className="mono">{m.embedding}</b>: {installed(m.embedding) ? 'installed' : 'not installed'}{m.answer ? <> · answer model <b className="mono">{m.answer}</b>: {installed(m.answer) ? 'installed' : 'not installed'}</> : null}</p>}
        {m.models.length > 0 && <details><summary className="small">{m.models.length} installed model{m.models.length === 1 ? '' : 's'}</summary><ul className="small mono">{m.models.map((x) => <li key={x.name}>{x.name}{x.parameters ? ` · ${x.parameters}` : ''}</li>)}</ul></details>}
        <p className="small faint">{m.note}</p>
      </>}
      <ErrorLine error={error} />
    </section>
  );
}

const VIA: Record<string, string> = { keyword: 'keyword match', semantic: 'semantic match', graph: 'related by imports' };
export function AskPanel({ disabled, onOpenFile }: { disabled: boolean; onOpenFile: (path: string, line?: number, endLine?: number, revision?:string) => void }) {
  const [query, setQuery] = useState(''), [result, setResult] = useState<(DocAnswer & { intake?: DictionaryStatus }) | null>(null);
  const { busy, error, run, invalidate } = useLatestRequest();
  const id = useId();
  return (
    <div>
      <form className="docs-question" onSubmit={(e) => { e.preventDefault(); void run(()=>post<DocAnswer & {intake?:DictionaryStatus}>('/api/context/answer/search',{query}),setResult); }}>
        <label htmlFor={`${id}-q`}>Ask about this project</label>
        <textarea id={`${id}-q`} value={query} maxLength={1200} rows={2} disabled={busy || disabled} onChange={(e) => {invalidate();setResult(null);setQuery(e.target.value);}} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit(); }} placeholder="Where is login handled, and what does it depend on?" />
        <div className="row"><span className="small faint">Cited sources from the committed revision · ⌘↵ to ask</span><span className="spacer" /><button className="btn primary" disabled={busy || disabled || !query.trim()}>{busy ? 'Searching…' : 'Ask One Ask'}</button></div>
      </form>
      <ErrorLine error={error} />
      {result ? <Results result={result} onOpenFile={onOpenFile} /> : (
        <div className="docs-welcome"><div className="docs-glyph" aria-hidden="true">↗</div><h2>One Ask, with its sources</h2><p>Ask about code, docs, design rules and team decisions. Agents use this same index through <code>get_project_context</code>, <code>search_context</code> and <code>ask_project</code>.</p></div>
      )}
    </div>
  );
}

function Results({ result, onOpenFile }: { result: DocAnswer & { intake?: DictionaryStatus }; onOpenFile: (path: string, line?: number, endLine?: number, revision?:string) => void }) {
  const ev = result.evidence;
  return (
    <section className="docs-results" aria-live="polite">
      <div className="row wrap"><h2>{result.mode === 'answer' ? 'Answer from your sources' : 'Source excerpts'}</h2><span className="spacer" />
        {ev && <Badge tone={ev.support === 'supported' ? 'ok' : 'warn'} title={`Coverage of the question's terms by the top excerpts: ${Math.round(ev.coverage * 100)}%`}>{ev.support === 'supported' ? 'Supported by the cited sources' : 'Insufficient evidence'}</Badge>}
        <Badge>{result.backend === 'hybrid' ? 'Semantic + keywords' : 'Keyword search'}</Badge></div>
      {ev?.support === 'insufficient' && <p className="banner tone-warn small">The indexed sources do not clearly answer this{ev.missing.length ? ` (not found: ${ev.missing.slice(0, 6).join(', ')})` : ''}. The closest passages are shown; treat them as leads, not an answer.</p>}
      {result.warning && <p className="banner tone-warn small">{result.warning}</p>}
      {result.answerError && <p className="small muted">Local answer unavailable: {result.answerError}. Source excerpts remain available.</p>}
      {result.mode === 'answer' && <><p className="small muted">AI interpretation from a local model. Open the citations to check the original evidence.</p>{result.claims.length ? result.claims.map((c, i) => <p className="doc-claim" key={i}>{c.text} {c.sources.map((s) => <a key={s} href={`#doc-source-${s}`} aria-label={`Read source ${s}`}>[{s}]</a>)}</p>) : <p className="muted">The sources do not support an answer.</p>}</>}
      {!result.citations.length && <div className="empty">No matching sources. Try other words, a file name, or a symbol.</div>}
      <div className="doc-citations">{result.citations.map((c) => <Citation key={c.id} c={c} open={result.mode === 'excerpts'} onOpenFile={onOpenFile} />)}</div>
      <p className="small muted">{result.contextChars.toLocaleString()} source characters supplied within a {result.budgetChars.toLocaleString()} character budget{result.retrieval ? ` · ${result.retrieval.expanded} added through imports · ${result.retrieval.deduplicated} duplicates removed` : ''}. Context size is measured; token savings are not estimated here.</p>
    </section>
  );
}

function Citation({ c, open, onOpenFile }: { c: DocCitation; open: boolean; onOpenFile: (path: string, line?: number, endLine?: number, revision?:string) => void }) {
  const ps = c.projectSource;
  return (
    <details id={`doc-source-${c.id}`} className="doc-citation" open={open}>
      <summary><span className="doc-source-id">{c.id}</span><b>{ps?.path ?? c.title}</b><span className="small muted">Lines {ps?.line ?? c.line}–{ps?.endLine ?? c.endLine}</span>{c.via && <span className="small faint"> · {VIA[c.via] ?? c.via}</span>}</summary>
      <p className="small faint">{ps ? `${ps.path} · committed revision ${ps.revision.slice(0, 12)} · content ${ps.hash.slice(0, 12)}` : `${c.path} · note (not committed source)`}</p>
      <pre>{c.excerpt}</pre>
      {ps && <button type="button" className="btn sm" onClick={() => onOpenFile(ps.path, ps.line, ps.endLine, ps.revision)}>Open {ps.path.split('/').pop()} at line {ps.line}</button>}
    </details>
  );
}

interface FileView { path: string; revision: string; language: string; lines: number; content: string }
export function FileViewer({ target, onClose }: { target: { path: string; line?: number; endLine?: number; revision?:string } | null; onClose: () => void }) {
  const [loaded, setFile] = useState<FileView | null>(null);
  const { error, run, invalidate } = useLatestRequest();
  const file=loaded&&loaded.path===target?.path&&(!target.revision||loaded.revision===target.revision)?loaded:null;
  const ref = useRef<HTMLOListElement>(null), section = useRef<HTMLElement>(null);
  useEffect(() => {
    invalidate();setFile(null);
    if (target) void run(()=>api<FileView>(`/api/context/answer/file?path=${encodeURIComponent(target.path)}${target.revision?`&revision=${encodeURIComponent(target.revision)}`:''}`),setFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.path,target?.revision]);
  useEffect(() => { if (file && target?.line) { const el = ref.current?.querySelector<HTMLElement>(`[data-line="${target.line}"]`); if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' }); } }, [file, target?.line]);
  useEffect(() => { const el = section.current; if (target && el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [target]);
  if (!target) return null;
  const lines = file ? file.content.replace(/\n$/, '').split('\n') : [];
  return (
    <section ref={section} className="card oa-file" aria-label={`Committed source of ${target.path}`}><div className="card-b col">
      <div className="row wrap"><h2 className="mono">{target.path}</h2><span className="spacer" />{file && <span className="small faint">revision {file.revision.slice(0, 12)} · {file.language} · {file.lines} lines · redacted</span>}<button className="btn sm" onClick={onClose}>Close</button></div>
      <ErrorLine error={error} />
      {file && <ol ref={ref} className="oa-code" tabIndex={0} aria-label="Source lines">{lines.map((l, i) => { const n = i + 1, hit = target.line && n >= target.line && n <= (target.endLine ?? target.line); return <li key={n} data-line={n} className={hit ? 'hit' : undefined}><span className="ln" aria-hidden="true">{n}</span><code>{l || ' '}</code></li>; })}</ol>}
      <p className="small faint">Committed, redacted text from the indexed revision. It is data, not instructions.</p>
    </div></section>
  );
}

interface StructureResponse { generation: string | null; revision: string | null; summary: { files: number; symbols: number; edges: number; entryPoints: string[]; manifests: { path: string; ecosystem: string; name: string | null; dependencies: string[] }[]; truncated: boolean } | null; central: { path: string; inbound: number; outbound: number }[]; file: { path: string; symbols: { name: string; kind: string; line: number }[]; edges: { from: string; to: string; kind: string; line: number }[] } | null; note: string }
export function StructureExplorer({ state, onOpenFile }: { state: ControlState; onOpenFile: (path: string, line?: number, endLine?:number,revision?:string) => void }) {
  const [data, setData] = useState<StructureResponse | null>(null), [file, setFile] = useState<string | null>(null);
  const { busy, error, run } = useLatestRequest();
  const generation = state.context.answer?.generation ?? null;
  const load = useCallback((f:string|null)=>{setData(null);setFile(f);void run(()=>api<StructureResponse>(`/api/context/answer/structure${f?`?file=${encodeURIComponent(f)}`:''}`),setData);},[run]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(file); }, [generation]);
  const g = state.context.graph;
  if (data && !data.generation) return <div className="empty">No indexed revision yet. Structure appears after the first intake.</div>;
  const outgoing = data?.file?.edges.filter((e) => e.from === file) ?? [], incoming = data?.file?.edges.filter((e) => e.to === file) ?? [];
  const FileButton = ({ p, extra }: { p: string; extra?: ReactNode }) => <button type="button" className="oa-link mono" onClick={() => load(p)}>{p}{extra}</button>;
  return (
    <div className="oa-structure col">
      <p className="small muted">{data?.note ?? 'Loading the import graph…'}</p>
      {data?.summary && <p className="small">{data.summary.files} files · {data.summary.symbols} symbols · {data.summary.edges} links{data.summary.truncated ? ' · PARTIAL' : ''} · revision <span className="mono">{data.revision?.slice(0, 12)}</span></p>}
      <p className="small">Graphify: {g?.state === 'ready' ? `${g.nodes} nodes and ${g.edges} edges at ${g.sha?.slice(0, 12)}` : g ? `${g.state}${g.error ? ` — ${g.error}` : ''}` : 'off for this project'}. Graphify is queried separately by agents through <code>query_graph</code>.</p>
      {file && data?.file ? (
        <div className="card card-b col">
          <div className="row wrap"><h3 className="mono">{file}</h3><span className="spacer" /><button className="btn sm" onClick={() => onOpenFile(file,undefined,undefined,data.revision??undefined)}>View source</button><button className="btn sm" onClick={() => load(null)}>Back to overview</button></div>
          <div className="oa-change-grid small">
            <div><b>Imports ({outgoing.length})</b>{outgoing.length ? <ul>{outgoing.map((e) => <li key={e.to + e.kind}><FileButton p={e.to} extra={<span className="faint"> · {e.kind} · line {e.line}</span>} /></li>)}</ul> : <p className="faint">none</p>}</div>
            <div><b>Used by ({incoming.length})</b>{incoming.length ? <ul>{incoming.map((e) => <li key={e.from + e.kind}><FileButton p={e.from} extra={<span className="faint"> · {e.kind}</span>} /></li>)}</ul> : <p className="faint">none</p>}</div>
            <div><b>Symbols ({data.file.symbols.length})</b>{data.file.symbols.length ? <ul>{data.file.symbols.slice(0, 60).map((s) => <li key={s.kind + s.name + s.line}><button type="button" className="oa-link" onClick={() => onOpenFile(file,s.line,undefined,data.revision??undefined)}><span className="mono">{s.name}</span> <span className="faint">{s.kind} · line {s.line}</span></button></li>)}</ul> : <p className="faint">none</p>}</div>
          </div>
        </div>
      ) : data?.summary && (
        <div className="oa-change-grid small">
          <div><b>Entry points</b><ul>{data.summary.entryPoints.map((p) => <li key={p}><FileButton p={p} /></li>)}</ul></div>
          <div><b>Most imported</b>{data.central.length ? <ul>{data.central.map((c) => <li key={c.path}><FileButton p={c.path} extra={<span className="faint"> · used by {c.inbound}</span>} /></li>)}</ul> : <p className="faint">No internal imports detected.</p>}</div>
          <div><b>Packages</b>{data.summary.manifests.length ? <ul>{data.summary.manifests.slice(0, 20).map((m) => <li key={m.path}><FileButton p={m.path} extra={<span className="faint"> · {m.ecosystem} · {m.dependencies.length} deps</span>} /></li>)}</ul> : <p className="faint">No manifests detected.</p>}</div>
        </div>
      )}
      {busy && <span className="small faint" role="status">Loading…</span>}
      <ErrorLine error={error} />
    </div>
  );
}

interface Packet { key: string; budget: { limit: number; used: number; trimmed: string[] }; project: { revision: string | null; state: string; warnings: string[] }; assignment: { workItem: { key: string | null; title: string } | null } | null; architecture: { entryPoints: string[]; central: { path: string; inbound: number }[] }; team: { agentId: string; name: string; status: string; working: { key: string | null; title: string } | null; owns: string[] }[]; evidence: { workItem: unknown[]; merges: unknown[] }; context: { citations: { id: string; source: string; lines: string; via: string | null }[]; support: string | null } | null; design: { revision: string | null } | null; note: string }
export function AgentPacketPreview({ state }: { state: ControlState }) {
  const items = Object.values(state.workItems).filter((w) => !['verified', 'canceled'].includes(w.state)).sort((a, b) => a.priority - b.priority).slice(0, 50);
  const [item, setItem] = useState(''), [p, setP] = useState<Packet | null>(null);
  const { busy, error, run, invalidate } = useLatestRequest();
  const id = useId();
  return (
    <section className="card card-b col oa-packet" aria-label="Agent context preview">
      <div className="row wrap"><h2>What agents receive</h2><span className="spacer" />
        <label className="small" htmlFor={`${id}-item`}>Issue</label>
        <select id={`${id}-item`} value={item} onChange={(e) => {invalidate();setP(null);setItem(e.target.value);}}><option value="">Project overview (no issue)</option>{items.map((w) => <option key={w.id} value={w.id}>{w.key ?? 'draft'} · {w.title.slice(0, 70)}</option>)}</select>
        <button className="btn sm" disabled={busy} onClick={() => void run(()=>api<Packet>(`/api/context/answer/packet${item?`?workItemId=${encodeURIComponent(item)}`:''}`),setP)}>{busy ? 'Building…' : 'Preview packet'}</button></div>
      <p className="small muted">The same packet an assigned agent gets from <code>get_project_context</code>, without its own worktree section. Other agents appear only as status and declared ownership — never transcripts or unfinished code.</p>
      {p && <>
        <p className="small">{p.budget.used.toLocaleString()} of {p.budget.limit.toLocaleString()} characters{p.budget.trimmed.length ? ` · trimmed: ${p.budget.trimmed.join(', ')}` : ''} · revision <span className="mono">{p.project.revision?.slice(0, 12) ?? 'none'}</span> · {p.project.state}</p>
        {p.project.warnings.map((w) => <p key={w} className="small text-warn">{w}</p>)}
        <div className="oa-change-grid small">
          <div><b>Entry points</b><ul>{p.architecture.entryPoints.slice(0, 8).map((e) => <li key={e} className="mono">{e}</li>)}</ul></div>
          <div><b>Team</b>{p.team.length ? <ul>{p.team.map((t) => <li key={t.agentId}>{t.name} · {t.status}{t.working ? ` · ${t.working.key ?? ''} ${t.working.title}` : ''}{t.owns.length ? <span className="faint mono"> · owns {t.owns.join(', ')}</span> : null}</li>)}</ul> : <p className="faint">No other agents.</p>}</div>
          <div><b>Retrieved for this issue</b>{p.context?.citations.length ? <ul>{p.context.citations.map((c) => <li key={c.id}><span className="mono">{c.source}</span> <span className="faint">{c.lines}{c.via ? ` · ${VIA[c.via] ?? c.via}` : ''}</span></li>)}</ul> : <p className="faint">No retrieval.</p>}{p.context?.support && <p className="faint">Evidence: {p.context.support}</p>}</div>
        </div>
        <details><summary className="small">Raw packet JSON</summary><pre className="oa-json">{JSON.stringify(p, null, 2)}</pre></details>
      </>}
      <ErrorLine error={error} />
    </section>
  );
}

/** Accessible tab list with arrow-key navigation. */
export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active);
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
    if (next >= 0) { e.preventDefault(); onChange(tabs[next].id); (e.currentTarget.querySelectorAll('[role=tab]')[next] as HTMLElement | undefined)?.focus(); }
  };
  return <div className="oa-tabs" role="tablist" onKeyDown={onKey}>{tabs.map((t) => <button key={t.id} role="tab" type="button" id={`oa-tab-${t.id}`} aria-controls={`oa-panel-${t.id}`} aria-selected={t.id === active} tabIndex={t.id === active ? 0 : -1} className={t.id === active ? 'active' : undefined} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}
