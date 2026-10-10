// SPDX-License-Identifier: Apache-2.0
// Project design system: edit a draft (autosaved on this project's daemon), preview it, validate it
// on the daemon, then save an immutable human-authored version. Drafts are never the approved contract.
import { useEffect, useMemo, useState } from 'react';
import {
  COLOR_ROLE_INFO, COLOR_ROLES, DEFAULT_DESIGN, designChecks, DesignSystemSchema, normalizeDesign,
  type ColorRole, type DesignChange, type DesignSystem,
} from '@acc/core';
import { Badge, Copy, ErrorLine, useAction } from '../common';
import { api, post } from '../../lib/api';
import { Specimen } from './Specimen';
import { DraftStatus, download, shortSha, useServerDraft, type ContractResponse, type FullExports, type Validation } from './shared';

function Seg<T extends string | number>({ name, value, options, onChange, label }: { name: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return <div className="col" style={{ gap: 6 }}><span className="small muted" id={`${name}-label`}>{label}</span>
    <div className="segmented" role="radiogroup" aria-labelledby={`${name}-label`}>{options.map(o => <label key={String(o.v)}><input type="radio" name={name} checked={value === o.v} onChange={() => onChange(o.v)} />{o.label}</label>)}</div>
  </div>;
}

export function DiffList({ changes, empty = 'No changes.' }: { changes: DesignChange[]; empty?: string }) {
  if (!changes.length) return <p className="small muted">{empty}</p>;
  const isColor = (v: string | null) => Boolean(v && /^#[0-9a-f]{6}$/i.test(v));
  const val = (v: string | null) => v === null ? <span className="faint">—</span> : <>{isColor(v) && <span className="swatch" style={{ background: v }} aria-hidden />}<span className="mono">{v.length > 140 ? `${v.slice(0, 140)}…` : v}</span></>;
  return <ul className="diff-list" aria-label="Contract changes">{changes.map(c => <li key={c.field}><b>{c.label}</b><span className="vals"><del aria-label="before">{val(c.before)}</del><span aria-hidden>→</span><ins aria-label="after">{val(c.after)}</ins></span></li>)}</ul>;
}

export function ContractEditor({ onSaved }: { onSaved?: () => void }) {
  const { busy, error, run, setError } = useAction();
  const [data, setData] = useState<ContractResponse | null>(null), [loadError, setLoadError] = useState('');
  const load = () => api<ContractResponse>('/api/designer/contract').then(r => { setData(r); setLoadError(''); return r; }).catch(e => { setLoadError((e as Error).message); return null; });
  useEffect(() => { void load(); }, []);
  const saved = data?.current ? normalizeDesign(data.current.revision.system) : null;
  const draft = useServerDraft<DesignSystem>(data ? 'system' : null, () => saved ?? DEFAULT_DESIGN);
  const [palette, setPalette] = useState<'colors' | 'dark'>('colors');
  const [validation, setValidation] = useState<{ for: string; result: Validation } | null>(null);
  const [note, setNote] = useState(''), [notice, setNotice] = useState('');
  const parsed = DesignSystemSchema.safeParse(draft.value);
  const system = parsed.success ? parsed.data : null;
  const key = JSON.stringify(draft.value);
  const checks = useMemo(() => (system ? designChecks(system) : []), [system && JSON.stringify(system)]);
  const blocking = checks.filter(c => c.blocking !== false && !c.passed);
  const sameAsSaved = Boolean(system && saved && JSON.stringify(system) === JSON.stringify(DesignSystemSchema.parse(saved)));
  const validated = validation?.for === key ? validation.result : null;
  const patch = (p: Partial<DesignSystem>) => draft.setValue(s => ({ ...s, ...p }));
  const setColor = (role: ColorRole, v: string) => draft.setValue(s => ({ ...s, [palette]: { ...s[palette], [role]: v } }));
  const s = draft.value;

  const validate = () => run(async () => { const r = await post<Validation>('/api/designer/validate', { system: draft.value }); setValidation({ for: key, result: r }); });
  const save = () => run(async () => {
    await draft.flush();
    const r = await post<{ revision: { version: number; hash: string } }>('/api/designer/contract', { system: draft.value, expected: data?.current?.revision.hash ?? null, note });
    setNotice(`Saved design contract v${r.revision.version} (${shortSha(r.revision.hash)}). New assignments freeze this version; existing assignments and active runs keep theirs.`);
    setNote(''); setValidation(null);
    const fresh = await load();
    if (fresh?.current) draft.reset(normalizeDesign(fresh.current.revision.system));
    onSaved?.();
  });

  if (loadError) return <ErrorLine error={`Could not load the design system: ${loadError}`} />;
  if (draft.error && !draft.loaded) return <ErrorLine error={draft.error} />;
  if (!data || !draft.loaded) return <div className="empty" role="status">Loading the design system…</div>;
  return <div className="col" style={{ gap: 20 }}>
    <ErrorLine error={error} />{notice && <p role="status" className="banner tone-ok small">{notice}</p>}
    <div className="contract-grid">
      <form className="card card-b contract-form" onSubmit={e => { e.preventDefault(); void validate(); }} aria-label="Design system draft">
        <fieldset disabled={busy}>
          <div className="row wrap"><h2 className="section">Draft</h2><span className="spacer" />
            {sameAsSaved ? <Badge tone="ok">matches contract v{data.current!.revision.version}</Badge> : <Badge tone="warn">unsaved draft · not approved</Badge>}
            <DraftStatus savedAt={draft.savedAt} error={draft.error} />
          </div>
          <label className="fieldset">Name<input required maxLength={100} value={s.name} onChange={e => patch({ name: e.target.value })} /></label>
          <label className="fieldset">Direction<span className="hint">Who it serves and how it should feel. Agents read this before every UI task.</span><textarea className="prose" rows={3} required maxLength={1200} value={s.direction} onChange={e => patch({ direction: e.target.value })} /></label>
          <details open><summary>Color roles</summary>
            <div className="col" style={{ gap: 12 }}>
              <div className="row wrap" style={{ gap: 16 }}>
                <Seg name="appearance" label="Appearance" value={s.appearance} onChange={v => patch({ appearance: v })} options={[{ v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }, { v: 'system', label: 'Both (follow system)' }]} />
                <Seg name="palette" label="Editing palette" value={palette} onChange={setPalette} options={[{ v: 'colors', label: 'Light palette' }, { v: 'dark', label: 'Dark palette' }]} />
              </div>
              <div className="role-grid">{COLOR_ROLES.map(role => {
                const value = s[palette]?.[role] ?? '#000000';
                return <label key={role} title={COLOR_ROLE_INFO[role].use}>
                  <input type="color" aria-label={`${COLOR_ROLE_INFO[role].label} color picker`} value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={e => setColor(role, e.target.value)} />
                  <span className="role-name">{COLOR_ROLE_INFO[role].label}</span>
                  <input type="text" aria-label={`${COLOR_ROLE_INFO[role].label} hex value`} spellCheck={false} maxLength={7} value={value} onChange={e => setColor(role, e.target.value)} />
                </label>;
              })}</div>
              <span className="small faint">Status colors are always paired with a word or icon. Hover a role to see where it is used.</span>
            </div>
          </details>
          <details><summary>Typography, density and shape</summary>
            <div className="pair-grid">
              <Seg name="pairing" label="Type pairing" value={s.typography.pairing} onChange={v => patch({ typography: { ...s.typography, pairing: v } })} options={[{ v: 'system', label: 'System sans' }, { v: 'editorial', label: 'Serif display' }]} />
              <label className="fieldset">Base text size<select value={s.typography.base} onChange={e => patch({ typography: { ...s.typography, base: Number(e.target.value) } })}>{[13, 14, 15, 16, 17, 18].map(n => <option key={n} value={n}>{n}px</option>)}</select></label>
              <Seg name="density" label="Density" value={s.density} onChange={v => patch({ density: v })} options={[{ v: 'comfortable', label: 'Comfortable' }, { v: 'compact', label: 'Compact' }]} />
              <label className="fieldset">Corner radius<input type="number" min={0} max={24} value={s.radius} onChange={e => patch({ radius: Number(e.target.value) })} /></label>
              <Seg name="border" label="Border width" value={s.borderWidth} onChange={v => patch({ borderWidth: v })} options={[{ v: 1, label: '1px' }, { v: 2, label: '2px' }]} />
              <Seg name="elevation" label="Elevation" value={s.elevation} onChange={v => patch({ elevation: v })} options={[{ v: 'soft', label: 'Soft shadows' }, { v: 'flat', label: 'Flat, borders only' }]} />
            </div>
          </details>
          <details><summary>Layout, motion and accessibility</summary>
            <div className="pair-grid">
              <label className="fieldset">Max content width<input type="number" min={720} max={1600} step={40} value={s.layout.maxWidth} onChange={e => patch({ layout: { ...s.layout, maxWidth: Number(e.target.value) } })} /></label>
              <Seg name="nav" label="Primary navigation" value={s.layout.navigation} onChange={v => patch({ layout: { ...s.layout, navigation: v } })} options={[{ v: 'sidebar', label: 'Sidebar' }, { v: 'top', label: 'Top bar' }]} />
              <Seg name="motion" label="Motion" value={s.motion} onChange={v => patch({ motion: v })} options={[{ v: 'subtle', label: 'Subtle' }, { v: 'reduced', label: 'Reduced' }]} />
              <Seg name="target" label="Minimum target" value={s.accessibility.targetSize} onChange={v => patch({ accessibility: { ...s.accessibility, targetSize: v } })} options={[{ v: 44, label: '44px' }, { v: 32, label: '32px' }, { v: 24, label: '24px' }]} />
              <Seg name="focus" label="Focus ring" value={s.accessibility.focusWidth} onChange={v => patch({ accessibility: { ...s.accessibility, focusWidth: v } })} options={[{ v: 2, label: '2px' }, { v: 3, label: '3px' }]} />
            </div>
          </details>
          <details><summary>Component notes and project rules</summary>
            <div className="col" style={{ gap: 12 }}>
              <label className="fieldset">Component notes<span className="hint">Project-specific recipes added to the generated button, field, table, dialog and state recipes.</span><textarea className="prose" rows={4} maxLength={3000} value={s.components} onChange={e => patch({ components: e.target.value })} /></label>
              <label className="fieldset">Project rules<textarea className="prose" rows={3} maxLength={2000} value={s.rules} onChange={e => patch({ rules: e.target.value })} /></label>
            </div>
          </details>
          <details open><summary>Measured contrast ({blocking.length ? `${blocking.length} failing` : 'all required pairs pass'})</summary>
            {!system ? <p className="small text-warn">{parsed.error?.issues[0] ? `${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}` : 'Invalid draft'}</p> :
              <table className="checks-table"><thead><tr><th>Pair</th><th className="num">Ratio</th><th className="num">Needs</th><th>Result</th></tr></thead><tbody>{checks.map(c => <tr key={c.name}><td><span className="swatch" style={{ background: c.fg }} aria-hidden /> on <span className="swatch" style={{ background: c.bg }} aria-hidden /> {c.name}</td><td className="num">{c.ratio.toFixed(2)}</td><td className="num">{c.required}</td><td><Badge tone={c.passed ? 'ok' : c.blocking === false ? 'idle' : 'crit'}>{c.passed ? 'pass' : c.blocking === false ? 'advisory' : 'fail'}</Badge></td></tr>)}</tbody></table>}
            <p className="small faint">Contrast is necessary, not sufficient. Keyboard, screen-reader, zoom and state checks happen on actual mocks.</p>
          </details>
          {validated && <div className={`banner small ${validated.ok ? 'tone-info' : 'tone-crit'}`} role="status">
            {validated.ok ? <>Validated on the daemon · draft SHA-256 <span className="mono">{shortSha(validated.hash)}</span>{validated.unchanged ? ' · identical to the current contract' : ''}</> : <>Not valid: {validated.errors.join(' ')}</>}
            {validated.warnings?.length ? <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{validated.warnings.map(w => <li key={w}>{w}</li>)}</ul> : null}
          </div>}
          {validated?.ok && !validated.unchanged && <div className="col"><h3 className="small">Changes from {data.current ? `v${data.current.revision.version}` : 'nothing (first version)'}</h3><DiffList changes={validated.diff ?? []} /></div>}
          <div className="save-bar">
            <button className="btn" disabled={busy || !system}>Validate draft</button>
            <input aria-label="Version note (optional)" placeholder="Version note (optional)" maxLength={500} value={note} onChange={e => setNote(e.target.value)} style={{ flex: '1 1 180px', width: 'auto' }} />
            <button type="button" className="btn primary" disabled={busy || !validated?.ok || validated.unchanged || blocking.length > 0} onClick={() => void save()} title={!validated ? 'Validate this exact draft first' : undefined}>Save as v{(data.current?.revision.version ?? 0) + 1}</button>
            <button type="button" className="btn ghost" disabled={busy || sameAsSaved} onClick={() => void run(async () => { await draft.discard(); setValidation(null); setError(null); })}>Discard draft</button>
          </div>
        </fieldset>
      </form>
      <div className="studio-stack">
        {system ? <Specimen system={system} label={sameAsSaved ? `Contract v${data.current!.revision.version}` : 'Draft preview · not the approved contract'} /> : <p className="empty">Fix the draft to preview it.</p>}
        <History data={data} />
      </div>
    </div>
  </div>;
}

function History({ data }: { data: ContractResponse }) {
  const { error, run } = useAction();
  const [selected, setSelected] = useState<string | null>(data.current?.revision.hash ?? null);
  const [rev, setRev] = useState<FullExports | null>(data.current);
  const [compare, setCompare] = useState<{ from: string; changes: DesignChange[] } | null>(null);
  useEffect(() => { setSelected(data.current?.revision.hash ?? null); setRev(data.current); setCompare(null); }, [data.current?.revision.hash]);
  const pick = (hash: string) => run(async () => { setSelected(hash); setCompare(null); setRev(await api<FullExports>(`/api/designer/revisions/${hash}`)); });
  const versions = [...data.history].reverse();
  const slug = rev ? `contract-v${rev.revision.version}` : 'contract';
  return <section className="card card-b col" aria-label="Contract versions" style={{ gap: 12 }}>
    <div className="row"><h2 className="section">Versions</h2><span className="spacer" /><span className="small faint">Immutable · human-authored · exact SHA-256</span></div>
    <ErrorLine error={error} />
    {versions.length === 0 ? <p className="small muted">No version saved yet. Validate and save the draft to create v1. Design jobs need a saved contract.</p> :
      <ul className="history-list">{versions.map(v => <li key={v.hash}><button type="button" aria-pressed={selected === v.hash} onClick={() => void pick(v.hash)}>
        <b>v{v.version}</b><span className="mono faint">{shortSha(v.hash)}</span>{v.schema === 1 && <Badge tone="idle">schema 1</Badge>}<span className="grow ellipsis">{v.note ?? ''}</span><span className="faint">{v.by?.type === 'human' ? 'you' : v.by?.id ?? 'owner'} · {new Date(v.createdAt).toLocaleString()}</span>
      </button></li>)}</ul>}
    {rev && <div className="col" style={{ gap: 10 }}>
      <div className="row wrap"><b>v{rev.revision.version}</b><span className="mono small faint">{rev.revision.hash}</span></div>
      <h3 className="small">Changes from {rev.parent ? `v${rev.parent.version}` : 'nothing (first version)'}</h3>
      <DiffList changes={compare?.changes ?? rev.diff} />
      {versions.length > 1 && <label className="row small">Compare with<select value={compare?.from ?? ''} onChange={e => { const from = e.target.value; if (!from) return setCompare(null); void run(async () => setCompare({ from, changes: (await api<{ changes: DesignChange[] }>(`/api/designer/diff?from=${from}&to=${rev.revision.hash}`)).changes })); }}><option value="">its parent</option>{versions.filter(v => v.hash !== rev.revision.hash).map(v => <option key={v.hash} value={v.hash}>v{v.version}</option>)}</select></label>}
      <div className="row wrap"><Copy text={rev.markdown} label="Copy DESIGN.md" /><Copy text={rev.css} label="Copy tokens.css" />
        <button type="button" className="btn sm" onClick={() => download(`${slug}-DESIGN.md`, rev.markdown, 'text/markdown')}>Download DESIGN.md</button>
        <button type="button" className="btn sm" onClick={() => download(`${slug}-tokens.css`, rev.css, 'text/css')}>Download tokens.css</button>
        <button type="button" className="btn sm" onClick={() => download(`${slug}-tokens.json`, JSON.stringify(rev.tokens, null, 2), 'application/json')}>Download tokens.json</button>
        <button type="button" className="btn sm" onClick={() => download(`${slug}-components.html`, rev.specimen, 'text/html')}>Download component examples</button></div>
      <details><summary className="small">Read DESIGN.md</summary><pre className="prompt-view">{rev.markdown}</pre></details>
      <p className="small faint">All four files are generated from this one revision. Engineering agents read the same files with get_design_system.</p>
    </div>}
  </section>;
}
