// SPDX-License-Identifier: Apache-2.0
// Review, evidence, comparison, source, refinement and handoff for one exact mock revision.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { designAgentEligibility, REVIEW_CHECKLIST, VIEWPORTS, type ChecklistId, type ControlState, type DiffLine, type MockEvidence, type MockFinding } from '@acc/core';
import { Badge, Copy, ErrorLine, useAction } from '../common';
import { api, post } from '../../lib/api';
import { isDesktop } from '../../lib/desktop';
import type { Tone } from '../../lib/format';
import { JobCard } from './JobCard';
import { loadPreview, StaticFrame, type Viewport } from './MockStage';
import { download, DraftStatus, shortSha, useServerDraft, type MockView, type RevisionView } from './shared';

export type Act = (fn: () => Promise<unknown>) => Promise<unknown>;
const SEV: Record<MockFinding['severity'], Tone> = { error: 'crit', warn: 'warn', info: 'idle' };
const EVIDENCE: Record<MockEvidence['status'], Tone> = { passed: 'ok', failed: 'crit', not_run: 'idle' };
const actorName = (a: { type: string; id: string }, state: ControlState) => (a.type === 'human' ? 'you' : a.type === 'agent' ? state.agents[a.id]?.config.name ?? a.id : 'One Connect');

// ---- review --------------------------------------------------------------------------------------

type Item = { result: 'pass' | 'fail' | 'not_checked'; basis: 'static' | 'browser' | 'human'; evidenceIds: string[]; note: string };
type ReviewDraft = { items: Record<ChecklistId, Item>; note: string };
const freshReview = (): ReviewDraft => ({ items: Object.fromEntries(REVIEW_CHECKLIST.map(c => [c.id, { result: 'not_checked', basis: c.id === 'contrast' ? 'static' : 'human', evidenceIds: [], note: '' } satisfies Item])) as unknown as Record<ChecklistId, Item>, note: '' });

function hint(id: ChecklistId, r: RevisionView): string {
  const count = (rule: RegExp) => r.findings.filter(f => rule.test(f.rule)).length;
  switch (id) {
    case 'responsive': return `Use the phone, tablet and desktop buttons above. ${count(/viewport-meta/) ? 'Static: the entry page has no viewport meta tag.' : 'Static: the viewport meta tag is present.'}`;
    case 'keyboard': return isDesktop ? 'Tab through the interactive preview window. Static checks cannot see focus or key handling.' : 'Keyboard behavior needs the desktop interactive preview or an executed browser check; the static render cannot show it.';
    case 'contrast': return `The contract's measured contrast table is in DESIGN.md. Static: ${count(/off-token-color/)} file${count(/off-token-color/) === 1 ? '' : 's'} with off-token colors.`;
    case 'states': return r.handoff?.states.length ? `Agent claims: ${r.handoff.states.join(', ')}. Check each in the preview.` : 'No structured handoff lists the states. Check each in the preview.';
    case 'tokens': return `Static: ${count(/^tokens$|off-token-color/)} token finding${count(/^tokens$|off-token-color/) === 1 ? '' : 's'}. Literal values outside tokens need an exception.`;
  }
}

export function ReviewPanel({ mock, r, state, act, busy, latest }: { mock: MockView; r: RevisionView; state: ControlState; act: Act; busy: boolean; latest: boolean }) {
  const [chosen, setChosen] = useState<string[]>([]), [rationale, setRationale] = useState('');
  const [reviewer, setReviewer] = useState('');
  const draft = useServerDraft<ReviewDraft>(`review:${mock.id}:${r.rev}`, freshReview);
  const rv = { ...freshReview(), ...draft.value, items: { ...freshReview().items, ...draft.value.items } };
  const setItem = (id: ChecklistId, p: Partial<Item>) => draft.setValue(x => ({ ...rv, ...x, items: { ...rv.items, ...x.items, [id]: { ...rv.items[id], ...x.items?.[id], ...p } } }));
  const findings = [...(r.gate.drift ? [r.gate.drift] : []), ...r.findings];
  const covered = new Set(r.exceptions.flatMap(e => e.findingIds)), open = new Set(r.gate.open.map(f => f.id));
  const base = `/api/mocks/${mock.id}/revisions/${r.rev}`;
  const executed = r.evidence.filter(e => e.executed);
  const author = r.authoredBy ?? r.by;
  const allPass = REVIEW_CHECKLIST.every(c => rv.items[c.id].result === 'pass');
  const staticOnly = REVIEW_CHECKLIST.filter(c => c.id !== 'contrast' && rv.items[c.id].basis === 'static');
  const reviewers = Object.values(state.agents).filter(a => !(author.type === 'agent' && author.id === a.id) && designAgentEligibility(a).ok);
  const checklist = REVIEW_CHECKLIST.map(c => ({ id: c.id, ...rv.items[c.id] }));
  const decide = (decision: 'approved' | 'changes_requested') => act(async () => { await draft.flush(); await post(`${base}/decision`, { decision, note: rv.note, checklist }); await draft.discard(); });
  return <div className="col" style={{ gap: 16 }}>
    <section className="col" aria-labelledby="findings-h"><h3 id="findings-h">Static findings</h3>
      <p className="small faint">Measured from source at capture. They catch remote resources, storage, missing pages and literal colors; they cannot prove visual or interaction quality.</p>
      <ul className="check-list">{findings.map(f => <li key={f.id}>
        {f.severity === 'warn' && open.has(f.id) ? <input type="checkbox" style={{ width: 'auto' }} aria-label={`Select ${f.rule} for an exception`} checked={chosen.includes(f.id)} onChange={e => setChosen(c => (e.target.checked ? [...c, f.id] : c.filter(x => x !== f.id)))} /> : <span style={{ width: 13 }} />}
        <Badge tone={SEV[f.severity]}>{f.severity}</Badge><span className="grow"><b>{f.rule}</b> {f.message}{f.file ? <span className="faint"> · {f.file}{f.line ? `:${f.line}` : ''}</span> : null}</span>
        {covered.has(f.id) && <Badge tone="info">excepted</Badge>}
        {f.severity !== 'info' && <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => post(`${base}/findings/${encodeURIComponent(f.id)}/issue`))}>Create issue</button>}
      </li>)}</ul>
      {chosen.length > 0 && <form className="col card card-b" onSubmit={e => { e.preventDefault(); void act(async () => { await post(`${base}/exceptions`, { findingIds: chosen, rationale }); setChosen([]); setRationale(''); }); }}>
        <label className="fieldset">Why is this exception acceptable? It is recorded with your name and this exact revision.<textarea className="prose" rows={2} required minLength={10} maxLength={2000} value={rationale} onChange={e => setRationale(e.target.value)} /></label>
        <button className="btn" disabled={busy || rationale.trim().length < 10}>Record exception for {chosen.length} finding{chosen.length === 1 ? '' : 's'}</button>
        <span className="small faint">Errors such as remote resources or navigation must be fixed; they cannot be excepted.</span>
      </form>}
      {r.exceptions.length > 0 && <div className="col small"><b>Exceptions</b>{r.exceptions.map(e => <p key={e.id} style={{ margin: 0 }}>{actorName(e.by, state)} · {new Date(e.at).toLocaleString()}: {e.rationale}</p>)}</div>}
    </section>

    <section className="col" aria-labelledby="checklist-h" style={{ gap: 10 }}>
      <div className="row wrap"><h3 id="checklist-h">Review checklist · revision {r.rev}</h3><span className="spacer" /><DraftStatus savedAt={draft.savedAt} error={draft.error} label="Review" /></div>
      <p className="small faint">Bound to content <code>{shortSha(r.hash)}</code> and contract {r.designRevision ? `v${r.designRevision.version}` : 'none'}. A later revision or contract change needs its own review. Content author: {actorName(author, state)}{author.type === 'human' ? ' — your approval alone is not independent; ask an agent reviewer below.' : '.'}</p>
      <fieldset className="checklist" disabled={busy || !draft.loaded}>
        <legend className="small muted">Mark what you actually checked and how</legend>
        {REVIEW_CHECKLIST.map(c => { const it = rv.items[c.id]; return <div className="item" key={c.id}>
          <span><b>{c.label}</b></span>
          <select aria-label={`${c.label} result`} value={it.result} onChange={e => setItem(c.id, { result: e.target.value as Item['result'] })}><option value="not_checked">not checked</option><option value="pass">pass</option><option value="fail">fail</option></select>
          <select aria-label={`${c.label} basis`} value={it.basis} onChange={e => setItem(c.id, { basis: e.target.value as Item['basis'] })}><option value="human">I looked at the rendered mock</option><option value="browser">executed browser check</option><option value="static">static source check</option></select>
          <span className="help">{c.help} {hint(c.id, r)}</span>
          {it.basis === 'browser' && <div className="evidence-pick">{executed.length ? executed.map(e => <label key={e.id}><input type="checkbox" checked={it.evidenceIds.includes(e.id)} onChange={ev => setItem(c.id, { evidenceIds: ev.target.checked ? [...it.evidenceIds, e.id] : it.evidenceIds.filter(x => x !== e.id) })} />{e.kind} · {e.status} · {e.summary.slice(0, 50)}</label>) : <span className="text-warn">No executed evidence on this revision yet. Attach it on the Evidence tab.</span>}</div>}
          <input className="note" aria-label={`${c.label} note`} placeholder="Note (optional)" maxLength={500} value={it.note} onChange={e => setItem(c.id, { note: e.target.value })} />
        </div>; })}
      </fieldset>
      <label className="fieldset">Review note<textarea className="prose" rows={2} maxLength={2000} value={rv.note} onChange={e => draft.setValue(x => ({ ...rv, ...x, note: e.target.value }))} /></label>
      <div className="row wrap">
        <button type="button" className="btn primary" disabled={busy || r.gate.open.length > 0 || !allPass || staticOnly.length > 0} onClick={() => void decide('approved')}>Approve revision {r.rev}</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void decide('changes_requested')}>Request changes</button>
        {r.gate.open.length > 0 ? <span className="small text-warn">{r.gate.open.length} open finding{r.gate.open.length === 1 ? '' : 's'} must be fixed or excepted first.</span>
          : !allPass ? <span className="small faint">Every item must pass before approval.</span>
            : staticOnly.length ? <span className="small text-warn">Static checks cannot pass {staticOnly.map(c => c.label.toLowerCase()).join(', ')}.</span> : null}
      </div>
      {!latest && <p className="small text-warn">This is not the latest revision. An approval here does not carry to later revisions.</p>}
    </section>

    <section className="col" aria-labelledby="reviews-h"><h3 id="reviews-h">Reviews of revision {r.rev}</h3>
      {r.reviews.length === 0 ? <p className="small muted">No reviews yet.</p> : r.reviews.map((v, i) => <div key={i} className="card card-b col small" style={{ gap: 4, boxShadow: 'none' }}>
        <div className="row wrap"><Badge tone={v.decision === 'approved' ? 'ok' : 'crit'}>{v.decision.replace('_', ' ')}</Badge><b>{actorName(v.by, state)}</b>{v.independent === false ? <Badge tone="warn">author · not independent</Badge> : <Badge tone="info">independent</Badge>}{v.by.type === 'agent' && <Badge tone="idle">advisory</Badge>}<span className="faint">{new Date(v.at).toLocaleString()}</span></div>
        {v.note && <span>{v.note}</span>}
        {v.checklist && <span className="faint">{v.checklist.map(c => `${REVIEW_CHECKLIST.find(x => x.id === c.id)?.label}: ${c.result.replace('_', ' ')} (${c.basis})`).join(' · ')}</span>}
      </div>)}
      <form className="row wrap" onSubmit={e => { e.preventDefault(); void act(() => post(`${base}/review-request`, { agentId: reviewer })); }}>
        <select aria-label="Independent reviewer" value={reviewer} onChange={e => setReviewer(e.target.value)} style={{ width: 'auto' }}><option value="">Choose an independent agent reviewer</option>{reviewers.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select>
        <button className="btn" disabled={busy || !reviewer}>Request independent review</button>
        <span className="small faint">Creates a read-only review issue and draft assignment for an agent who did not author this revision. Its verdict is advisory.</span>
      </form>
    </section>
  </div>;
}

// ---- evidence ------------------------------------------------------------------------------------

function EvidenceImage({ mockId, evidenceId }: { mockId: string; evidenceId: string }) {
  const [src, setSrc] = useState<string | null>(null), [err, setErr] = useState('');
  useEffect(() => { let alive = true; void api<{ mime: string; base64: string }>(`/api/mocks/${mockId}/evidence/${evidenceId}/image`).then(r => alive && setSrc(`data:${r.mime};base64,${r.base64}`)).catch(e => alive && setErr((e as Error).message)); return () => { alive = false; }; }, [mockId, evidenceId]);
  return err ? <span className="small text-warn">{err}</span> : src ? <img className="evidence-shot" src={src} alt="Attached screenshot evidence" /> : <span className="small faint">Loading screenshot…</span>;
}

export function EvidencePanel({ mock, r, state, act, busy, page, viewport }: { mock: MockView; r: RevisionView; state: ControlState; act: Act; busy: boolean; page: string; viewport: Viewport }) {
  const [kind, setKind] = useState<'viewport' | 'command' | 'screenshot'>('viewport'), [summary, setSummary] = useState(''), [executed, setExecuted] = useState(false), [status, setStatus] = useState<'passed' | 'failed'>('passed');
  const [vpName, setVpName] = useState(viewport.name), [command, setCommand] = useState(''), [exitCode, setExitCode] = useState(''), [action, setAction] = useState(''), [tool, setTool] = useState(isDesktop ? 'One Connect native preview' : 'Browser static render');
  const [image, setImage] = useState<{ name: string; data: string } | null>(null), [fileError, setFileError] = useState('');
  useEffect(() => setVpName(viewport.name), [viewport.name]);
  const pickFile = (f: File | undefined) => {
    setFileError(''); setImage(null);
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return setFileError('Choose a PNG, JPEG or WebP screenshot.');
    if (f.size > 5 * 1024 * 1024) return setFileError('Screenshots must be 5 MB or smaller.');
    const reader = new FileReader();
    reader.onload = () => setImage({ name: f.name, data: String(reader.result) });
    reader.readAsDataURL(f);
  };
  const submit = () => act(async () => {
    const v = VIEWPORTS.find(x => x.name === vpName)!;
    const body = { kind, summary, executed, status: executed ? status : 'not_run', action: action || undefined, tool: tool || undefined, page, ...(kind === 'command' ? { command, exitCode: exitCode === '' ? null : Number(exitCode) } : { viewport: v }), ...(kind === 'screenshot' && image ? { image: image.data } : {}) };
    await post(`/api/mocks/${mock.id}/revisions/${r.rev}/evidence${kind === 'screenshot' ? '/upload' : ''}`, body);
    setSummary(''); setAction(''); setImage(null);
  });
  return <div className="col" style={{ gap: 14 }}>
    <p className="small faint">Evidence is bound to revision {r.rev} (<code>{shortSha(r.hash)}</code>). Nothing is reported as passing unless someone ran it. Agent commands are marked observed only when One Connect saw them in that run's transcript. One Connect cannot tell what a screenshot shows; reviewers judge that.</p>
    {r.evidence.length === 0 ? <p className="small muted">No evidence attached yet.</p> : <ul className="check-list">{r.evidence.map(e => <li key={e.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <div className="row wrap"><Badge tone={EVIDENCE[e.status]}>{e.status === 'not_run' ? 'not run' : e.status}</Badge><Badge tone={e.verified ? 'ok' : 'idle'} title={e.verified ? 'One Connect saw this command and exit code in the run transcript.' : 'Reported, not observed by One Connect.'}>{e.verified ? 'observed in run' : `reported by ${e.source}`}</Badge>
        <span className="grow small"><b>{e.kind}</b> {e.summary}{e.action ? ` · ${e.action}` : ''}{e.command ? <> · <code>{e.command}</code>{e.exitCode !== undefined && e.exitCode !== null ? ` → exit ${e.exitCode}` : ''}</> : null}{e.viewport ? ` · ${e.viewport.name} ${e.viewport.width}×${e.viewport.height}` : ''}{e.page ? ` · ${e.page}` : ''}{e.tool ? ` · ${e.tool}` : ''}</span>
        <span className="small faint">{actorName(e.by, state)} · {new Date(e.at).toLocaleString()}</span></div>
      {e.screenshot && (e.screenshot.stored === 'evidence' ? <EvidenceImage mockId={mock.id} evidenceId={e.id} /> : <span className="small faint">Screenshot {e.screenshot.path} ({shortSha(e.screenshot.sha256)}) from the mock folder.</span>)}
    </li>)}</ul>}
    <form className="card card-b col" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h3>Add your evidence</h3>
      <div className="row wrap">
        <select aria-label="Evidence kind" value={kind} onChange={e => setKind(e.target.value as typeof kind)} style={{ width: 'auto' }}><option value="viewport">Viewport check</option><option value="screenshot">Screenshot</option><option value="command">Command</option></select>
        {kind !== 'command' && <select aria-label="Viewport" value={vpName} onChange={e => setVpName(e.target.value)} style={{ width: 'auto' }}>{VIEWPORTS.map(v => <option key={v.name} value={v.name}>{v.name} {v.width}×{v.height}</option>)}</select>}
        {kind === 'command' && <><input aria-label="Command" required className="mono" value={command} onChange={e => setCommand(e.target.value)} placeholder="playwright-cli screenshot …" style={{ flex: '1 1 220px', width: 'auto' }} /><input aria-label="Exit code" type="number" value={exitCode} onChange={e => setExitCode(e.target.value)} placeholder="exit code" style={{ width: 110 }} /></>}
        <span className="small faint">Page: <code>{page}</code></span>
      </div>
      {kind === 'screenshot' && <label className="fieldset">Screenshot of the rendered preview (PNG, JPEG or WebP, up to 5 MB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => pickFile(e.target.files?.[0])} />{fileError && <span className="small text-warn">{fileError}</span>}{image && <span className="small faint">{image.name}</span>}</label>}
      <label className="fieldset">What did you do?<input maxLength={300} value={action} onChange={e => setAction(e.target.value)} placeholder="Tabbed through filters, opened and closed the re-run dialog with Escape" /></label>
      <div className="pair-grid"><label className="fieldset">Result summary<input required maxLength={500} value={summary} onChange={e => setSummary(e.target.value)} /></label><label className="fieldset">Tool<input maxLength={120} value={tool} onChange={e => setTool(e.target.value)} /></label></div>
      <div className="row wrap"><label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={executed} onChange={e => setExecuted(e.target.checked)} />I actually ran this check</label>{executed && <select aria-label="Result" value={status} onChange={e => setStatus(e.target.value as typeof status)} style={{ width: 'auto' }}><option value="passed">passed</option><option value="failed">failed</option></select>}<button className="btn" disabled={busy || !summary.trim() || (kind === 'screenshot' && !image)}>Attach to revision {r.rev}</button></div>
      <span className="small faint">Unchecked is recorded as “not run”. Your entries are labelled as reported by you.</span>
    </form>
  </div>;
}

// ---- compare ---------------------------------------------------------------------------------------

interface Comparison { from: number; to: number; added: string[]; removed: string[]; changed: string[]; unchanged: string[]; contract: { changed: boolean; from: { version: number } | null; to: { version: number } | null }; file: string | null; diff?: DiffLine[] | null; tooLarge: boolean; gates: { from: string; to: string } }

export function ComparePanel({ mock, r, viewport, page }: { mock: MockView; r: RevisionView; viewport: Viewport; page: string }) {
  const revs = mock.revisions.map(x => x.rev);
  const [from, setFrom] = useState(revs.length > 1 ? (revs[revs.indexOf(r.rev) - 1] ?? revs[0]) : r.rev), [to, setTo] = useState(r.rev);
  const [file, setFile] = useState<string>(''), [cmp, setCmp] = useState<Comparison | null>(null), [err, setErr] = useState('');
  const [docs, setDocs] = useState<[string | null, string | null]>([null, null]);
  useEffect(() => { let alive = true; setErr(''); void api<Comparison>(`/api/mocks/${mock.id}/compare?from=${from}&to=${to}${file ? `&file=${encodeURIComponent(file)}` : ''}`).then(c => alive && setCmp(c)).catch(e => alive && setErr((e as Error).message)); return () => { alive = false; }; }, [mock.id, from, to, file]);
  useEffect(() => { if (isDesktop) return; let alive = true; setDocs([null, null]); const get = (rev: number) => loadPreview(mock.id, rev, page).then(p => p.static).catch(() => null); void Promise.all([get(from), get(to)]).then(d => alive && setDocs(d as [string | null, string | null])); return () => { alive = false; }; }, [mock.id, from, to, page]);
  if (revs.length < 2) return <p className="small muted">Only one revision exists. Refine or edit the mock to create another, then compare them here.</p>;
  return <div className="col" style={{ gap: 12 }}>
    <div className="row wrap"><label className="row small">From<select value={from} onChange={e => setFrom(Number(e.target.value))} style={{ width: 'auto' }}>{revs.map(n => <option key={n} value={n}>rev {n}</option>)}</select></label><label className="row small">To<select value={to} onChange={e => setTo(Number(e.target.value))} style={{ width: 'auto' }}>{revs.map(n => <option key={n} value={n}>rev {n}</option>)}</select></label>{cmp && <span className="small faint">gates: rev {cmp.from} {cmp.gates.from.replace(/_/g, ' ')} → rev {cmp.to} {cmp.gates.to.replace(/_/g, ' ')}</span>}</div>
    <ErrorLine error={err} />
    {cmp && <>
      {cmp.contract.changed && <div className="banner tone-warn small">Built on different contracts: v{cmp.contract.from?.version ?? '—'} → v{cmp.contract.to?.version ?? '—'}.</div>}
      <div className="row wrap small"><Badge tone="ok">{cmp.added.length} added</Badge><Badge tone="crit">{cmp.removed.length} removed</Badge><Badge tone="warn">{cmp.changed.length} changed</Badge><Badge>{cmp.unchanged.length} unchanged</Badge></div>
      <div className="row wrap small">{[...cmp.changed, ...cmp.added, ...cmp.removed].map(p => <button key={p} type="button" className={`btn sm${p === file ? ' primary' : ''}`} aria-pressed={p === file} onClick={() => setFile(p)}>{p}</button>)}</div>
      {file && (cmp.tooLarge ? <p className="small muted">{file} is binary or too large for an inline diff. Compare the rendered pages below.</p> : cmp.diff && <pre className="diff-view" aria-label={`Changes to ${file}`} tabIndex={0}>{cmp.diff.map((l, i) => l.op === '…' ? <div key={i} className="gap">… {l.count} unchanged line{l.count === 1 ? '' : 's'}</div> : <div key={i} className={l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}>{l.op === '=' ? '  ' : `${l.op} `}{l.text}</div>)}</pre>)}
    </>}
    {!isDesktop && <div className="compare-grid">{[from, to].map((rev, i) => <div key={i} className="col"><span className="small muted">rev {rev} · {page} · {viewport.name}</span>{docs[i] ? <StaticFrame doc={docs[i]!} viewport={viewport} title={`Revision ${rev}, ${page}, static render`} /> : <span className="small faint">{page} does not exist in revision {rev}, or it is still rendering.</span>}</div>)}</div>}
    {isDesktop && <p className="small faint">Open each revision in its own interactive preview window from the stage above to compare behavior.</p>}
  </div>;
}

// ---- source ----------------------------------------------------------------------------------------

interface Source { path: string; sha256: string; encoding: 'utf8' | 'base64'; content: string; kind: string; rev: number }
type SourceDraft = { content: string; baseSha: string; baseRev: number } | null;

export function SourcePanel({ mock, r, onSaved, busy, run }: { mock: MockView; r: RevisionView; onSaved: (rev: number) => void; busy: boolean; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const latest = mock.revisions.at(-1)!;
  const [file, setFile] = useState(r.files.some(f => f.path === 'index.html') ? 'index.html' : r.files[0]?.path ?? '');
  const [viewed, setViewed] = useState<Source | null>(null), [current, setCurrent] = useState<Source | null>(null), [notice, setNotice] = useState('');
  const editable = latest.files.some(f => f.path === file && ['html', 'css', 'js', 'svg', 'json', 'md'].includes(f.kind));
  const draft = useServerDraft<SourceDraft>(editable ? `source:${mock.id}:${file}` : null, () => null);
  useEffect(() => { let alive = true; setViewed(null); void api<Source>(`/api/mocks/${mock.id}/revisions/${r.rev}/source?path=${encodeURIComponent(file)}`).then(s => alive && setViewed(s)).catch(() => alive && setViewed(null)); return () => { alive = false; }; }, [mock.id, r.rev, file]);
  useEffect(() => { let alive = true; setCurrent(null); if (!editable) return; void api<Source>(`/api/mocks/${mock.id}/revisions/${latest.rev}/source?path=${encodeURIComponent(file)}`).then(s => alive && setCurrent(s)).catch(() => undefined); return () => { alive = false; }; }, [mock.id, latest.rev, file, editable]);
  const d = draft.value;
  const stale = Boolean(d && current && d.baseSha !== current.sha256);
  const startEdit = (content: string) => current && draft.setValue({ content, baseSha: current.sha256, baseRev: latest.rev });
  return <div className="col" style={{ gap: 12 }}>
    <div className="row wrap small" role="group" aria-label="Files">{r.files.map(f => <button key={f.path} type="button" className={`btn sm${f.path === file ? ' primary' : ''}`} aria-pressed={f.path === file} onClick={() => setFile(f.path)}>{f.path} <span className="faint">{(f.bytes / 1024).toFixed(1)} KiB</span></button>)}</div>
    {!viewed ? <div className="empty" role="status">Loading source…</div> : viewed.encoding === 'base64' ? <img className="evidence-shot" alt={viewed.path} src={`data:image/${viewed.path.split('.').pop() === 'jpg' ? 'jpeg' : viewed.path.split('.').pop() === 'svg' ? 'svg+xml' : viewed.path.split('.').pop()};base64,${viewed.content}`} /> : d === null ? <>
      <div className="row wrap small"><Badge tone="info">captured revision {r.rev}</Badge><span className="faint">immutable · <code>{shortSha(viewed.sha256)}</code></span></div>
      <pre className="prompt-view" tabIndex={0} aria-label={`${viewed.path} at revision ${r.rev}`}>{viewed.content}</pre>
      <div className="row wrap">
        {editable && <button type="button" className="btn sm" disabled={!current || !draft.loaded} onClick={() => startEdit(viewed.content)}>{r.rev === latest.rev ? 'Edit as a draft' : `Restore this file from revision ${r.rev} into a draft`}</button>}
        <span className="small faint">{r.rev === latest.rev ? 'Saving writes the file in the assignment worktree and captures a new revision. Earlier revisions never change.' : `Restoring copies revision ${r.rev}'s file into an editable draft based on the latest revision ${latest.rev}; saving it creates revision ${latest.rev + 1}.`}</span>
      </div>
    </> : <form className="col" onSubmit={e => { e.preventDefault(); void run(async () => {
      await draft.flush();
      await draft.flush();
      const res = await post<{ revision: { rev: number } }>(`/api/mocks/${mock.id}/source`, { path: file, content: d.content, expectedSha: d.baseSha });
      await draft.discard(); setNotice(`Saved ${file} as revision ${res.revision.rev}.`); onSaved(res.revision.rev);
    }); }}>
      <div className="row wrap small"><Badge tone="warn">draft · not captured</Badge><span className="faint">based on revision {d.baseRev}</span><DraftStatus savedAt={draft.savedAt} error={draft.error} /></div>
      {stale && <div className="banner tone-warn small">The latest revision's {file} changed since this draft started. Saving will be refused; copy your text, then start a new draft.</div>}
      <textarea aria-label={`Edit ${file}`} className="mono" rows={18} value={d.content} onChange={e => draft.setValue({ ...d, content: e.target.value })} />
      <div className="row wrap"><button className="btn primary" disabled={busy || stale || d.content === current?.content}>Save as revision {latest.rev + 1}</button><button type="button" className="btn" onClick={() => void draft.discard()}>Discard draft</button><Copy text={d.content} label="Copy text" /></div>
    </form>}
    {draft.error && <ErrorLine error={draft.error} />}
    {notice && <p role="status" className="small text-ok">{notice}</p>}
  </div>;
}

// ---- refine ----------------------------------------------------------------------------------------

type RefineDraft = { request: string; agentId: string; mode: 'auto' | 'new-assignment' };
export function RefinePanel({ mock, r, state, busy, run }: { mock: MockView; r: RevisionView; state: ControlState; busy: boolean; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const latest = mock.revisions.at(-1)!;
  const draft = useServerDraft<RefineDraft>(`refine:${mock.id}`, () => ({ request: '', agentId: '', mode: 'auto' }));
  const v = draft.value;
  const [created, setCreated] = useState<string | null>(null);
  const jobs = Object.values(state.designStudio?.jobs ?? {}).filter(j => j.kind === 'refine' && j.artifactId === mock.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const srcAssignment = state.assignments[latest.assignmentId ?? mock.assignmentId];
  const agents = Object.values(state.agents).filter(a => designAgentEligibility(a).ok);
  return <div className="col" style={{ gap: 14 }}>
    {r.rev !== latest.rev ? <p className="small muted">Refinements start from the latest revision ({latest.rev}). <Link to={`/mocks/${mock.id}?rev=${latest.rev}&tab=refine`}>Refine revision {latest.rev}</Link>. To return to this revision's version of a file, use Source → “Restore this file”, save it, then refine.</p> :
    <form className="card card-b col" onSubmit={e => { e.preventDefault(); void run(async () => { await draft.flush(); const res = await post<{ job: { id: string } }>(`/api/mocks/${mock.id}/revisions/${r.rev}/refine`, { request: v.request, agentId: v.agentId || undefined, mode: v.mode }); draft.reset({ request: '', agentId: '', mode: 'auto' }); setCreated(res.job.id); }); }}>
      <div className="row wrap"><h3>Refine revision {r.rev}</h3><span className="spacer" /><DraftStatus savedAt={draft.savedAt} error={draft.error} label="Request" /></div>
      <label className="fieldset">What should change?<span className="hint">Name the page and state. Everything else stays as it is in revision {r.rev}.</span><textarea className="prose" rows={4} required maxLength={4000} value={v.request} onChange={e => draft.setValue({ ...v, request: e.target.value })} placeholder="checks.html: the error state should keep filters and offer a retry; add a long-name example to the table" /></label>
      <div className="col" style={{ gap: 6 }}><span className="small muted" id="refine-mode">How</span>
        <div className="segmented" role="radiogroup" aria-labelledby="refine-mode"><label><input type="radio" name="refine-mode" checked={v.mode === 'auto'} onChange={() => draft.setValue({ ...v, mode: 'auto' })} />Continue the same session when possible</label><label><input type="radio" name="refine-mode" checked={v.mode === 'new-assignment'} onChange={() => draft.setValue({ ...v, mode: 'new-assignment' })} />New scoped task</label></div>
        <span className="small faint">{v.mode === 'auto' ? `Sends the request to ${state.agents[srcAssignment?.agentId ?? '']?.config.name ?? 'the agent'} as a follow-up in the same assignment (same issue, worktree and frozen contract v${latest.designRevision?.version ?? '—'}). If the session cannot continue, a scoped child issue is created instead for you to dispatch.` : 'Creates a child issue and a draft assignment that starts from the source branch and may only write this mock folder. It freezes the current contract.'}</span>
      </div>
      {v.mode === 'new-assignment' && <label className="fieldset">Agent<select value={v.agentId} onChange={e => draft.setValue({ ...v, agentId: e.target.value })}><option value="">Same agent as revision {r.rev}</option>{agents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label>}
      <div className="row wrap"><button className="btn primary" disabled={busy || v.request.trim().length < 3}>Request refinement</button><span className="small faint">Captured revisions are never changed; the result is a new revision you can compare.</span></div>
    </form>}
    {created && state.designStudio?.jobs[created] && <JobCard job={state.designStudio.jobs[created]} state={state} open />}
    {jobs.filter(j => j.id !== created).slice(0, 5).map(j => <JobCard key={j.id} job={j} state={state} />)}
  </div>;
}

// ---- handoff ---------------------------------------------------------------------------------------

interface Bundle { manifest: Record<string, unknown> & { gate: string; revision: number; contentHash: string }; files: unknown[]; designMarkdown: string | null; tokensCss: string | null; tokensJson: Record<string, unknown> | null; specimenHtml: string | null; handoffMd: string; evidenceImages: unknown[] }

export function HandoffPanel({ mock, r, state, busy, run }: { mock: MockView; r: RevisionView; state: ControlState; busy: boolean; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [bundle, setBundle] = useState<Bundle | null>(null), [approvedOnly, setApprovedOnly] = useState(r.gate.state === 'approved');
  const [agentId, setAgentId] = useState(''), [paths, setPaths] = useState(''), [notes, setNotes] = useState(''), [created, setCreated] = useState<string | null>(null);
  const approved = r.gate.state === 'approved';
  const contractCurrent = Boolean(r.designRevision && state.design && r.designRevision.hash === state.design.hash);
  const agents = Object.values(state.agents).filter(a => designAgentEligibility(a).ok);
  const jobs = Object.values(state.designStudio?.jobs ?? {}).filter(j => j.kind === 'engineering' && j.artifactId === mock.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const slug = `${mock.dir.replace('design/', '')}-rev${r.rev}`;
  return <div className="col" style={{ gap: 16 }}>
    <section className="card card-b col" aria-labelledby="bundle-h">
      <h3 id="bundle-h">Handoff bundle</h3>
      <p className="small muted">The exact files of revision {r.rev}, its review, checklist and evidence (with screenshots), and the DESIGN.md, tokens.css, tokens.json and component examples of contract {r.designRevision ? `v${r.designRevision.version}` : '—'}. Exporting saves files on this computer; nothing is published or sent.</p>
      <div className="row wrap"><label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={approvedOnly} onChange={e => setApprovedOnly(e.target.checked)} />Require an approved revision</label>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => setBundle(await api<Bundle>(`/api/mocks/${mock.id}/revisions/${r.rev}/bundle${approvedOnly ? '?approved=1' : ''}`)))}>Prepare bundle</button></div>
      {bundle && <div className="col" style={{ gap: 8 }}>
        <div className="row wrap small"><Badge tone={bundle.manifest.gate === 'approved' ? 'ok' : 'warn'}>{String(bundle.manifest.gate).replace(/_/g, ' ')}</Badge><span>revision {bundle.manifest.revision} · <code>{shortSha(bundle.manifest.contentHash)}</code></span></div>
        <div className="row wrap">
          <button type="button" className="btn sm primary" onClick={() => download(`${slug}-handoff.json`, JSON.stringify(bundle, null, 2), 'application/json')}>Download full bundle (.json)</button>
          <button type="button" className="btn sm" onClick={() => download(`${slug}-HANDOFF.md`, bundle.handoffMd, 'text/markdown')}>HANDOFF.md</button>
          {bundle.designMarkdown && <button type="button" className="btn sm" onClick={() => download(`${slug}-DESIGN.md`, bundle.designMarkdown!, 'text/markdown')}>DESIGN.md</button>}
          {bundle.tokensCss && <button type="button" className="btn sm" onClick={() => download(`${slug}-tokens.css`, bundle.tokensCss!, 'text/css')}>tokens.css</button>}
          {bundle.tokensJson && <button type="button" className="btn sm" onClick={() => download(`${slug}-tokens.json`, JSON.stringify(bundle.tokensJson, null, 2), 'application/json')}>tokens.json</button>}
          {bundle.specimenHtml && <button type="button" className="btn sm" onClick={() => download(`${slug}-components.html`, bundle.specimenHtml!, 'text/html')}>Component examples</button>}
        </div>
        <details><summary className="small">Manifest</summary><pre className="prompt-view">{JSON.stringify(bundle.manifest, null, 2)}</pre></details>
      </div>}
    </section>
    <section className="card card-b col" aria-labelledby="eng-h">
      <h3 id="eng-h">Engineering task</h3>
      {!approved ? <p className="small muted">Only an approved revision can be handed to engineering. Revision {r.rev} is {r.gate.state.replace(/_/g, ' ')}.</p>
        : !contractCurrent ? <p className="small text-warn">Revision {r.rev} was approved on contract v{r.designRevision?.version}, but the project contract is now v{state.design?.version}. Refine and approve a revision on the current contract first.</p>
          : <form className="col" onSubmit={e => { e.preventDefault(); void run(async () => { const res = await post<{ job: { id: string } }>(`/api/mocks/${mock.id}/revisions/${r.rev}/engineering`, { agentId, allowedPaths: paths.split('\n').map(s => s.trim()).filter(Boolean), notes }); setCreated(res.job.id); }); }}>
            <p className="small muted">Creates an issue and a draft assignment that cite this exact revision, content hash and contract, with implementation acceptance criteria. Review and dispatch it like any other task. An approved mock is not a passing implementation.</p>
            <label className="fieldset">Engineer<select required value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">Choose an eligible agent</option>{agents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label>
            <label className="fieldset">Allowed paths<span className="hint">One glob per line. Empty allows the whole repository.</span><textarea rows={2} value={paths} onChange={e => setPaths(e.target.value)} placeholder={'src/pages/checks/**\nsrc/components/**'} /></label>
            <label className="fieldset">Notes for engineering<textarea className="prose" rows={2} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></label>
            <button className="btn primary" disabled={busy || !agentId}>Prepare engineering task</button>
          </form>}
      {created && state.designStudio?.jobs[created] && <JobCard job={state.designStudio.jobs[created]} state={state} open />}
      {jobs.filter(j => j.id !== created).map(j => <div key={j.id} className="row small"><Link to={`/board?item=${j.workItemId}`}>{state.workItems[j.workItemId]?.key ?? 'issue'}</Link><span className="faint">for revision {j.fromRev} · {new Date(j.createdAt).toLocaleString()}</span></div>)}
    </section>
  </div>;
}
