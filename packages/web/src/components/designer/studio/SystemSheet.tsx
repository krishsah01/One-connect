// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The Design system sheet: this design's foundations as swatches, type and shape, with the published
// project system one step away. The full project contract editor stays available but folded.
import { useRef, useState } from 'react';
import { resolveToken, type ControlState, type DesignDocument, type DesignOperation } from '@acc/core';
import { ErrorLine } from '../../common';
import { post } from '../../../lib/api';
import { ContractEditor } from '../ContractEditor';
import { Icon } from '../workspace/DocumentRenderer';

const ROLE_ORDER = ['accent', 'on-accent', 'accent-subtle', 'text', 'text-muted', 'canvas', 'surface', 'surface-subtle', 'border', 'border-strong', 'success', 'warning', 'danger', 'info', 'focus'];

export function SystemSheet({ doc: d, apply, state, dark: initialDark, mutate, onClose, onNotice }: {
  doc: DesignDocument; apply: (ops: DesignOperation[], label?: string) => boolean; state: ControlState; dark: boolean;
  mutate: <T>(fn: () => Promise<T>) => Promise<T | undefined>; onClose: () => void; onNotice: (text: string) => void;
}) {
  const [dark, setDark] = useState(initialDark);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const colors = Object.entries(d.tokens).filter(([, t]) => t.type === 'color' && t.tier !== 'primitive').sort(([a], [b]) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const fonts = Object.entries(d.tokens).filter(([, t]) => t.type === 'font');
  const sizes = Object.entries(d.tokens).filter(([k, t]) => t.type === 'dimension' && t.category === 'type-scale' && k.startsWith('text-')).sort(([, a], [, b]) => Number(b.value) - Number(a.value));
  const radii = Object.entries(d.tokens).filter(([, t]) => t.type === 'dimension' && t.category === 'radius');
  const hex = (key: string) => { const v = resolveToken(d.tokens, key, dark); return typeof v === 'string' && /^#/.test(v) ? v.slice(0, 7) : '#000000'; };
  const setColor = (key: string, value: string) => {
    const t = d.tokens[key]; if (!t) return;
    const { alias, darkAlias, ...rest } = t;
    void alias; void darkAlias;
    apply([{ type: 'set-token', id: key, value: dark ? { ...rest, dark: value } : { ...rest, value, ...(t.dark === undefined && t.darkAlias === undefined ? {} : {}) } }], `Change ${key}`);
  };
  const act = async (fn: () => Promise<unknown>, done: string) => { setBusy(true); setError(''); try { const r = await mutate(fn); if (r !== undefined) onNotice(done); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const system = state.design;
  const inSync = Boolean(system && d.systemHash === system.hash);

  return <aside className="dz-side wide" aria-label="Design system">
    <div className="dz-side-head"><h2>Design system</h2><span className="sub">{system ? `project v${system.version}${inSync ? '' : ' · this draft differs'}` : 'nothing published yet'}</span><span className="spacer" />
      <button type="button" className="dz-icon-btn" aria-label="Close design system" onClick={onClose}><Icon name="close" size={14} /></button></div>
    <div className="dz-side-body">
      <ErrorLine error={error} />
      <section className="dz-group" aria-labelledby="dz-sys-colors">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><h3 id="dz-sys-colors">Colours</h3><span style={{ flex: 1 }} />
          <div className="dz-seg" role="group" aria-label="Theme"><button type="button" aria-pressed={!dark} onClick={() => setDark(false)}>Light</button><button type="button" aria-pressed={dark} onClick={() => setDark(true)}>Dark</button></div></div>
        <div className="dz-swatches">{colors.map(([key, t]) => <button key={key} type="button" className="dz-swatch" title={t.description} onClick={() => { setEditing(key); requestAnimationFrame(() => picker.current?.click()); }} aria-label={`${key}: ${hex(key)}. Change`}>
          <i style={{ background: hex(key) }} aria-hidden="true" /><span>{key}</span><code>{hex(key).toUpperCase()}</code></button>)}</div>
        <input ref={picker} type="color" className="sr-only" tabIndex={-1} aria-hidden="true" value={editing ? hex(editing) : '#000000'} onChange={e => editing && setColor(editing, e.target.value)} />
        <p className="dz-help">Fills carry on-accent text; status dots and text use the role colours. Changing a role changes every layer that uses it.</p>
      </section>

      <section className="dz-group" aria-labelledby="dz-sys-type">
        <h3 id="dz-sys-type">Type</h3>
        <div className="dz-type-list">
          {fonts.map(([key, t]) => <div className="dz-type-row" key={key}><span style={{ fontFamily: String(t.value), fontWeight: key === 'font-heading' ? 600 : 400 }}>{key.replace('font-', '')}</span><span className="spacer" /><small>{String(t.value).split(',')[0].replace(/["']/g, '')}</small></div>)}
          {sizes.map(([key, t]) => <div className="dz-type-row" key={key}><span style={{ fontSize: Math.min(28, Number(t.value)), lineHeight: 1.2 }}>{key.replace('text-', '')}</span><span className="spacer" /><small>{String(t.value)} px</small></div>)}
        </div>
      </section>

      <section className="dz-group" aria-labelledby="dz-sys-shape">
        <h3 id="dz-sys-shape">Spacing and shape</h3>
        <div className="dz-pair">
          <label className="dw-field"><span className="dw-field-label">Density</span><select value={d.settings.density} onChange={e => apply([{ type: 'set-settings', value: { ...d.settings, density: e.target.value as DesignDocument['settings']['density'] } }], 'Change density')}><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option></select></label>
          <label className="dw-field"><span className="dw-field-label">Motion</span><select value={d.settings.motion} onChange={e => apply([{ type: 'set-settings', value: { ...d.settings, motion: e.target.value as DesignDocument['settings']['motion'] } }], 'Change motion')}><option value="full">Full</option><option value="reduced">Reduced</option></select></label>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{radii.map(([key, t]) => <span key={key} className="dz-pill" title={t.description}><i style={{ width: 14, height: 14, borderRadius: Math.min(7, Number(t.value) / 2), background: 'var(--text-3)' }} aria-hidden="true" />{key.replace('radius-', '')} · {String(t.value)}px</span>)}</div>
      </section>

      <section className="dz-group" aria-labelledby="dz-sys-comps">
        <h3 id="dz-sys-comps">Components · {Object.keys(d.components).length}</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{Object.values(d.components).slice(0, 14).map(c => <span key={c.id} className="dz-pill" title={c.description}>{c.name}</span>)}{Object.keys(d.components).length > 14 && <span className="dz-pill">+{Object.keys(d.components).length - 14}</span>}</div>
        <p className="dz-help">Select any layer and choose “Make reusable” to add a component.</p>
      </section>

      <details>
        <summary>Edit the full project contract</summary>
        <div style={{ paddingTop: 10 }}><ContractEditor /></div>
      </details>
    </div>
    <div className="dz-side-foot">
      <div className="row">
        <button type="button" className="btn primary" style={{ flex: 1, justifyContent: 'center', height: 38 }} disabled={busy} onClick={() => void act(() => post(`/api/designer/documents/${d.id}/foundations`, { expected: d.version, expectedSystem: system?.hash ?? null }), `Published these foundations as the project design system${system ? ` v${system.version + 1}` : ''}.`)}>{system ? `Publish as v${system.version + 1}` : 'Publish as the project system'}</button>
        <button type="button" className="btn" style={{ height: 38 }} disabled={busy || !system || inSync} onClick={() => void act(() => post(`/api/designer/documents/${d.id}/system`, { expected: d.version }), `This draft now uses project design system v${system?.version}.`)}>Use project v{system?.version ?? '—'}</button>
      </div>
      <p className="dz-help">Publishing freezes these tokens for every new design job. Designs in progress keep the version they started with.</p>
    </div>
  </aside>;
}
