// SPDX-License-Identifier: Apache-2.0
// Live component and state specimen rendered from a contract (saved or draft). Everything here is
// trusted app UI: keyboard tabs, an inline dialog with focus return, field validation and states.
import { useId, useRef, useState, type CSSProperties } from 'react';
import { activeModes, designTokens, paletteFor, typeScale, type DesignSystem } from '@acc/core';

export function specimenVars(s: DesignSystem, mode: 'light' | 'dark'): CSSProperties {
  const p = paletteFor(s, mode), t = typeScale(s.typography.base);
  const tok = Object.fromEntries(designTokens(s).filter(x => !x.mode).map(x => [x.key, x.value]));
  const space = Object.fromEntries([1, 2, 3, 4, 5].map(i => [`--sp-s${i}`, tok[`space.${i}`]]));
  return {
    ...Object.fromEntries(Object.entries(p).map(([k, v]) => [`--sp-${k}`, v])),
    ...space,
    '--sp-radius': tok.radius, '--sp-radius-sm': tok['radius.small'], '--sp-bw': tok['border.width'],
    '--sp-shadow': tok['shadow.1'], '--sp-shadow2': s.elevation === 'flat' ? `0 0 0 ${s.borderWidth}px ${p.border}` : tok['shadow.2'],
    '--sp-body': `${t.body}px`, '--sp-small': `${t.small}px`, '--sp-caption': `${t.caption}px`, '--sp-h2': `${t.h2}px`, '--sp-h3': `${t.h3}px`,
    '--sp-display': tok['font.display'], '--sp-control': tok['control.height'], '--sp-target': tok['a11y.target'], '--sp-focusw': tok['a11y.focus-width'],
    '--sp-fast': tok['motion.fast'], fontFamily: tok['font.body'],
  } as CSSProperties;
}

const STATES = ['empty', 'loading', 'error', 'success'] as const;

export function Specimen({ system, label, mode: forced }: { system: DesignSystem; label: string; mode?: 'light' | 'dark' }) {
  const modes = activeModes(system);
  const [mode, setMode] = useState<'light' | 'dark'>(forced ?? modes[0]);
  const shown = modes.includes(mode) ? mode : modes[0];
  const [tab, setTab] = useState<'overview' | 'activity'>('overview');
  const [state, setState] = useState<(typeof STATES)[number]>('empty');
  const [dialog, setDialog] = useState(false), [email, setEmail] = useState('team@'), [touched, setTouched] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const invalid = touched && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const open = () => { setDialog(true); setTimeout(() => heading.current?.focus(), 0); };
  const close = () => { setDialog(false); setTimeout(() => trigger.current?.focus(), 0); };
  return <section className="specimen" style={specimenVars(system, shown)} aria-label={`Component specimen: ${label}`}>
    <div className="specimen-bar">
      <b>{system.name}</b><span>{label}</span><span style={{ flex: 1 }} />
      {modes.length > 1 && <div role="group" aria-label="Specimen color mode" className="sp-row">{modes.map(m => <button key={m} type="button" className={`sp-btn ${m === shown ? 'sp-primary' : 'sp-secondary'}`} aria-pressed={m === shown} onClick={() => setMode(m)}>{m === 'light' ? 'Light' : 'Dark'}</button>)}</div>}
    </div>
    <div className="specimen-body">
      <div className="sp-row" style={{ justifyContent: 'space-between' }}>
        <div><h3>Release checks</h3><p className="sp-muted">Everything that must pass before the next deploy.</p></div>
        <div className="sp-row"><button type="button" className="sp-btn sp-secondary">Export</button><button type="button" className="sp-btn sp-primary" ref={trigger} onClick={open} aria-haspopup="dialog" aria-expanded={dialog}>Schedule run</button></div>
      </div>
      {dialog && <div role="dialog" aria-modal="false" aria-labelledby={`${id}-dlg`} className="sp-dialog" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <h4 id={`${id}-dlg`} tabIndex={-1} ref={heading}>Schedule a check run</h4>
        <p className="sp-muted">Runs every check on the integration branch. Escape closes this dialog and returns focus.</p>
        <div className="sp-row"><button type="button" className="sp-btn sp-primary" onClick={close}>Schedule</button><button type="button" className="sp-btn sp-secondary" onClick={close}>Cancel</button></div>
      </div>}
      <div className="sp-tabs" role="tablist" aria-label="Specimen sections">
        {(['overview', 'activity'] as const).map((t, i, all) => <button key={t} id={`${id}-t-${t}`} role="tab" type="button" aria-selected={tab === t} aria-controls={`${id}-p`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)} onKeyDown={e => {
          const n = e.key === 'ArrowRight' || e.key === 'End' ? all[(i + 1) % all.length] : e.key === 'ArrowLeft' || e.key === 'Home' ? all[(i + all.length - 1) % all.length] : null;
          if (n) { e.preventDefault(); setTab(n); document.getElementById(`${id}-t-${n}`)?.focus(); }
        }}>{t === 'overview' ? 'Overview' : 'Activity'}</button>)}
      </div>
      <div id={`${id}-p`} role="tabpanel" aria-labelledby={`${id}-t-${tab}`}>
        {tab === 'overview' ? <div className="sp-card">
          <table><thead><tr><th>Check</th><th>Status</th><th className="num">Duration</th></tr></thead><tbody>
            <tr><td>Unit tests</td><td><span className="sp-badge sp-success">✓ Passed</span></td><td className="num">42s</td></tr>
            <tr><td>Phone layout</td><td><span className="sp-badge sp-warning">! Needs review</span></td><td className="num">—</td></tr>
            <tr><td>Accessibility scan</td><td><span className="sp-badge sp-dangertext">× Failed</span></td><td className="num">1m 04s</td></tr>
            <tr><td>Bundle size</td><td><span className="sp-badge sp-info">… Running</span></td><td className="num">—</td></tr>
          </tbody></table>
        </div> : <div className="sp-card"><p>Codex finished <b>ENG-12</b> and attached 3 checks.</p><p className="sp-muted">2 minutes ago</p></div>}
      </div>
      <div className="sp-states">
        <label className="sp-field">Notify email<input value={email} aria-invalid={invalid} aria-describedby={`${id}-em`} onChange={e => setEmail(e.target.value)} onBlur={() => setTouched(true)} /><span id={`${id}-em`} className={invalid ? 'sp-error' : 'sp-help'}>{invalid ? 'Enter a complete email address.' : 'We send a summary after each run.'}</span></label>
        <div className="sp-row" style={{ alignItems: 'flex-end' }}><button type="button" className="sp-btn sp-danger">Delete schedule</button><button type="button" className="sp-btn sp-primary" disabled>Disabled</button></div>
      </div>
      <div>
        <div className="sp-row" role="group" aria-label="Content state">{STATES.map(s => <button key={s} type="button" className={`sp-btn ${s === state ? 'sp-primary' : 'sp-secondary'}`} aria-pressed={s === state} onClick={() => setState(s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}</div>
        <div className="sp-card" style={{ marginTop: 'var(--sp-s3)' }} aria-live="polite" aria-busy={state === 'loading'}>
          {state === 'empty' && <><h4>No reports yet</h4><p className="sp-muted">Reports appear after the first scheduled run.</p><div><button type="button" className="sp-btn sp-primary">Schedule a run</button></div></>}
          {state === 'loading' && <><span className="sp-muted">Loading reports…</span><div className="sp-skeleton" /><div className="sp-skeleton" /><div className="sp-skeleton" style={{ width: '60%' }} /></>}
          {state === 'error' && <div role="alert"><h4 className="sp-dangertext">Reports could not load</h4><p>Your filters are kept. Check your connection and try again.</p><div style={{ marginTop: 'var(--sp-s3)' }}><button type="button" className="sp-btn sp-secondary">Try again</button></div></div>}
          {state === 'success' && <><h4 className="sp-success">Schedule saved</h4><p>The next run starts at 09:00.</p></>}
        </div>
      </div>
    </div>
  </section>;
}
