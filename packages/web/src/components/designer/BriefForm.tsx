// SPDX-License-Identifier: Apache-2.0
// The design brief. Autosaved as a draft; creating it makes an ordinary issue and a draft assignment
// that the human reviews and dispatches. Nothing runs from this form.
import { useEffect, useState } from 'react';
import { briefPages, DESIGN_RUNTIME_LIMITS, DESIGN_STATE_LABELS, DESIGN_STATES, DesignBriefSchema, type DesignBriefInput } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../common';
import { post } from '../../lib/api';
import { DraftStatus, useServerDraft, type JobView, type StudioOverview } from './shared';

type Brief = Required<Pick<DesignBriefInput, 'mode' | 'title' | 'brief' | 'audience' | 'interactions' | 'fixtures' | 'agentId'>> & { screens: { name: string; purpose: string }[]; states: (typeof DESIGN_STATES)[number][]; existingPaths: string };
const BLANK = (): Brief => ({ mode: 'prototype', title: '', brief: '', audience: '', screens: [{ name: 'Overview', purpose: '' }], states: ['empty', 'loading', 'error', 'success'], interactions: '', fixtures: '', existingPaths: '', agentId: '' });
const toInput = (b: Brief) => ({ ...b, existingPaths: b.existingPaths.split('\n').map(s => s.trim()).filter(Boolean) });

export function BriefForm({ overview, onCreated }: { overview: StudioOverview; onCreated: (v: JobView) => void }) {
  const { busy, error, run } = useAction();
  const draft = useServerDraft<Brief>('brief', BLANK);
  const b = { ...BLANK(), ...draft.value };
  const set = (p: Partial<Brief>) => draft.setValue(x => ({ ...BLANK(), ...x, ...p }));
  const parsed = DesignBriefSchema.safeParse(toInput(b));
  const pages = briefPages({ screens: b.screens.filter(s => s.name.trim()).map(s => ({ name: s.name, purpose: s.purpose })) });
  const [preview, setPreview] = useState<{ dir: string } | null>(null);
  useEffect(() => {
    if (!parsed.success) { setPreview(null); return; }
    let alive = true;
    const t = setTimeout(() => { void post<{ ok: boolean; dir?: string }>('/api/designer/brief/preview', { brief: toInput(b) }).then(r => { if (alive) setPreview(r.ok && r.dir ? { dir: r.dir } : null); }).catch(() => { if (alive) setPreview(null); }); }, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [parsed.success, b.title, b.agentId]);
  const agents = overview.agents;
  const chosen = agents.find(a => a.id === b.agentId);
  const issues = parsed.success ? [] : parsed.error.issues.map(i => i.message);
  const moveScreen = (i: number, d: -1 | 1) => { const s = [...b.screens]; const j = i + d; if (j < 0 || j >= s.length) return; [s[i], s[j]] = [s[j], s[i]]; set({ screens: s }); };

  if (!draft.loaded && draft.error) return <ErrorLine error={draft.error} />;
  if (!draft.loaded) return <div className="empty" role="status">Loading your brief…</div>;
  return <form className="card card-b col" style={{ gap: 14 }} aria-label="Design brief" onSubmit={e => { e.preventDefault(); void run(async () => {
    if (!overview.contract) throw new Error('Save a project design system first. Design jobs freeze the saved contract.');
    await draft.flush();
    const v = await post<JobView>('/api/designer/jobs', { brief: toInput(b) });
    draft.reset(BLANK());
    onCreated(v);
  }); }}>
    <div className="row wrap"><h2 className="section">Brief</h2><span className="spacer" /><DraftStatus savedAt={draft.savedAt} error={draft.error} label="Brief" /></div>
    <ErrorLine error={error} />
    <fieldset disabled={busy} className="col" style={{ border: 0, padding: 0, margin: 0, gap: 14 }}>
      <div className="col" style={{ gap: 6 }}><span className="small muted" id="brief-mode">What are we designing?</span>
        <div className="segmented" role="radiogroup" aria-labelledby="brief-mode">
          <label><input type="radio" name="mode" checked={b.mode === 'prototype'} onChange={() => set({ mode: 'prototype' })} />New prototype</label>
          <label><input type="radio" name="mode" checked={b.mode === 'revise'} onChange={() => set({ mode: 'revise' })} />Revise existing project UI</label>
        </div>
      </div>
      <label className="fieldset">Title<input required maxLength={90} value={b.title} onChange={e => set({ title: e.target.value })} placeholder="Release checks dashboard" /></label>
      <label className="fieldset">Brief<span className="hint">The problem, the main task and what a good result lets people do.</span><textarea className="prose" rows={4} required maxLength={4000} value={b.brief} onChange={e => set({ brief: e.target.value })} placeholder="Engineers need to see which release checks failed, why, and re-run one without leaving the page." /></label>
      <label className="fieldset">Audience<input required maxLength={400} value={b.audience} onChange={e => set({ audience: e.target.value })} placeholder="Engineers and release managers, mostly on laptops; on-call on phones" /></label>
      <div className="col" style={{ gap: 8 }}>
        <div className="row"><span className="small muted" id="screens-label">Screens and pages</span><span className="spacer" /><button type="button" className="btn sm" disabled={b.screens.length >= 8} onClick={() => set({ screens: [...b.screens, { name: '', purpose: '' }] })}>Add screen</button></div>
        <div className="screens-list" role="group" aria-labelledby="screens-label">{b.screens.map((s, i) => <div className="screen-row" key={i}>
          <span className="small faint" aria-hidden>{i + 1}.</span>
          <input aria-label={`Screen ${i + 1} name`} required maxLength={60} value={s.name} onChange={e => set({ screens: b.screens.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Screen name" />
          <input className="purpose" aria-label={`Screen ${i + 1} purpose`} maxLength={300} value={s.purpose} onChange={e => set({ screens: b.screens.map((x, j) => (j === i ? { ...x, purpose: e.target.value } : x)) })} placeholder="What happens here" />
          <span className="row" style={{ gap: 4 }}><code title="Page file">{pages[i]?.path ?? ''}</code>
            <button type="button" className="btn sm ghost" aria-label={`Move screen ${i + 1} up`} disabled={i === 0} onClick={() => moveScreen(i, -1)}>↑</button>
            <button type="button" className="btn sm ghost" aria-label={`Move screen ${i + 1} down`} disabled={i === b.screens.length - 1} onClick={() => moveScreen(i, 1)}>↓</button>
            <button type="button" className="btn sm ghost" aria-label={`Remove screen ${i + 1}`} disabled={b.screens.length === 1} onClick={() => set({ screens: b.screens.filter((_, j) => j !== i) })}>×</button></span>
        </div>)}</div>
      </div>
      <div className="col" style={{ gap: 6 }}><span className="small muted" id="states-label">States every data view must show</span>
        <div className="state-chips" role="group" aria-labelledby="states-label">{DESIGN_STATES.map(st => <label key={st}><input type="checkbox" checked={b.states.includes(st)} onChange={e => set({ states: e.target.checked ? [...b.states, st] : b.states.filter(x => x !== st) })} />{DESIGN_STATE_LABELS[st]}</label>)}</div>
      </div>
      <label className="fieldset">Key interactions<span className="hint">Optional. What must actually work in the mock.</span><textarea className="prose" rows={2} maxLength={1500} value={b.interactions} onChange={e => set({ interactions: e.target.value })} placeholder="Filter by status, open a failed check, re-run it from a confirmation dialog" /></label>
      <label className="fieldset">Fixture data<span className="hint">Optional. Plausible local data the mock should use. Never paste real customer data or secrets.</span><textarea className="prose" rows={2} maxLength={1500} value={b.fixtures} onChange={e => set({ fixtures: e.target.value })} placeholder="12 checks across 3 services; one with a very long name; one that takes 9 minutes" /></label>
      {b.mode === 'revise' && <label className="fieldset">Existing UI to study (read-only)<span className="hint">Repository paths or globs, one per line. The agent recreates them as a mock and does not edit them.</span><textarea rows={3} value={b.existingPaths} onChange={e => set({ existingPaths: e.target.value })} placeholder={'src/pages/Checks.tsx\nsrc/components/checks/**'} /></label>}
      <div className="col" style={{ gap: 6 }}><span className="small muted" id="agent-label">Design agent</span>
        {agents.length === 0 ? <p className="small muted">No agents are configured. Add one in agent settings.</p> :
          <div className="agent-options" role="radiogroup" aria-labelledby="agent-label">{agents.map(a => <label key={a.id} className="agent-option" aria-disabled={!a.eligibility.ok}>
            <input type="radio" name="agent" disabled={!a.eligibility.ok} checked={b.agentId === a.id} onChange={() => set({ agentId: a.id })} />
            <b>{a.name}</b>
            <Badge tone={!a.eligibility.ok ? 'idle' : a.eligibility.paid ? 'crit' : 'ok'}>{a.eligibility.label}</Badge>
            <span className="reason">{a.eligibility.reason}</span>
          </label>)}</div>}
      </div>
      <details><summary className="small">What the isolated preview cannot do</summary><ul className="limits">{DESIGN_RUNTIME_LIMITS.map(l => <li key={l}>{l}</li>)}</ul><p className="small faint">The agent is told these limits. Questions it asks with ask_human arrive here and in Decisions.</p></details>
      <div className="col small" style={{ gap: 4 }}>
        <span className="muted">Creates an issue and a draft assignment{chosen ? ` for ${chosen.name}` : ''} that writes only <code>{preview?.dir ?? 'design/<slug>'}/</code>: {pages.map(p => p.path).join(', ')}. You review the exact prompt and pre-flight before anything runs.</span>
        {!overview.contract && <span className="text-warn">Save a project design system first.</span>}
        {issues.length > 0 && (b.title || b.brief) && <span className="text-warn">{issues.slice(0, 3).join(' · ')}</span>}
      </div>
      <div className="row wrap"><button className="btn primary" disabled={busy || !parsed.success || !overview.contract || !chosen?.eligibility.ok}>Create reviewable task</button><button type="button" className="btn ghost" disabled={busy} onClick={() => void draft.discard()}>Clear brief</button></div>
    </fieldset>
  </form>;
}
