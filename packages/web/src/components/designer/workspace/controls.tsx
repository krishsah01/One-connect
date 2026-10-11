// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Small controls shared by the Designer workspace panels. Fields commit on blur or Enter so one
// edit becomes one undo step, and token pickers show values, not just names.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { resolveToken, type DesignDocument, type DesignTokenType, type DesignValue } from '@acc/core';
import { Icon } from './DocumentRenderer';

export function Section({ title, children, open = true, actions, id }: { title: string; children: ReactNode; open?: boolean; actions?: ReactNode; id?: string }) {
  const [isOpen, setOpen] = useState(open);
  return <section className="dw-section" id={id}>
    <div className="dw-section-head">
      <button type="button" className="dw-section-toggle" aria-expanded={isOpen} onClick={() => setOpen(v => !v)}><Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />{title}</button>
      {actions}
    </div>
    {isOpen && <div className="dw-section-body">{children}</div>}
  </section>;
}

export function Field({ label, hint, children, inline }: { label: string; hint?: string; children: ReactNode; inline?: boolean }) {
  return <label className={`dw-field${inline ? ' inline' : ''}`}><span className="dw-field-label">{label}</span>{children}{hint && <span className="dw-hint">{hint}</span>}</label>;
}

export function TextField({ label, value, onCommit, multiline, placeholder, hint, disabled, autoFocusKey }: { label: string; value: string | undefined; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string; hint?: string; disabled?: boolean; autoFocusKey?: string }) {
  const [text, setText] = useState(value ?? '');
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (document.activeElement !== ref.current) setText(value ?? ''); }, [value]);
  useEffect(() => { if (autoFocusKey) ref.current?.focus(); }, [autoFocusKey]);
  const commit = () => { if (text !== (value ?? '')) onCommit(text); };
  const props = { ref, value: text, placeholder, disabled, onChange: (e: { target: { value: string } }) => setText(e.target.value), onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); (e.target as HTMLElement).blur(); } if (e.key === 'Escape') { setText(value ?? ''); (e.target as HTMLElement).blur(); } } };
  return <Field label={label} hint={hint}>{multiline ? <textarea rows={3} {...props} /> : <input type="text" {...props} />}</Field>;
}

export function NumberField({ label, value, onCommit, min = -10000, max = 10000, step = 1, suffix, placeholder, disabled }: { label: string; value: number | undefined; onCommit: (v: number | undefined) => void; min?: number; max?: number; step?: number; suffix?: string; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (document.activeElement !== ref.current) setText(value === undefined ? '' : String(value)); }, [value]);
  const commit = () => {
    if (text.trim() === '') { if (value !== undefined) onCommit(undefined); return; }
    const n = Math.min(max, Math.max(min, Number(text)));
    if (Number.isFinite(n) && n !== value) onCommit(n); else setText(value === undefined ? '' : String(value));
  };
  return <Field label={label}><span className="dw-number"><input ref={ref} type="number" inputMode="decimal" min={min} max={max} step={step} value={text} placeholder={placeholder} disabled={disabled}
    onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />{suffix && <span aria-hidden="true">{suffix}</span>}</span></Field>;
}

export function Segmented<T extends string>({ label, value, options, onChange, hideLabel }: { label: string; value: T | undefined; options: { value: T; label: string; icon?: Parameters<typeof Icon>[0]['name'] }[]; onChange: (v: T) => void; hideLabel?: boolean }) {
  const id = useId();
  return <div className="dw-field" role="group" aria-labelledby={id}>
    <span className={`dw-field-label${hideLabel ? ' sr-only' : ''}`} id={id}>{label}</span>
    <div className="dw-segmented">{options.map(o => <button key={o.value} type="button" aria-pressed={value === o.value} title={o.label} aria-label={o.icon ? o.label : undefined} onClick={() => onChange(o.value)}>{o.icon ? <Icon name={o.icon} size={16} /> : o.label}</button>)}</div>
  </div>;
}

export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="dw-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />{label}</label>;
}

const swatch = (d: DesignDocument, key: string, dark = false) => { const v = resolveToken(d.tokens, key, dark); return typeof v === 'string' ? v.slice(0, 7) : '#000000'; };
/** Display value of a token for one theme, with its unit. */
export function tokenLabel(d: DesignDocument, key: string) {
  const t = d.tokens[key], v = resolveToken(d.tokens, key);
  if (!t || v === undefined) return 'missing';
  return t.type === 'dimension' ? `${v}px` : t.type === 'duration' ? `${v}ms` : String(v);
}

/** Choose a color token. Semantic roles first; the primitive palette is one click away. */
export function ColorPicker({ label, doc, value, onChange, allowNone = true }: { label: string; doc: DesignDocument; value: string | undefined; onChange: (v: string | undefined) => void; allowNone?: boolean }) {
  const [open, setOpen] = useState(false), [all, setAll] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const colors = Object.entries(doc.tokens).filter(([, t]) => t.type === 'color');
  const roles = colors.filter(([, t]) => t.tier !== 'primitive'), palette = colors.filter(([, t]) => t.tier === 'primitive');
  const missing = value !== undefined && doc.tokens[value]?.type !== 'color';
  return <div className="dw-field" ref={wrap}>
    <span className="dw-field-label">{label}</span>
    <button type="button" className="dw-color-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(v => !v)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
      {value && !missing ? <i style={{ background: swatch(doc, value) }} /> : <i className="none" />}
      <span>{missing ? `${value} (missing)` : value ?? 'Inherit'}</span><Icon name="chevron-down" size={14} />
    </button>
    {open && <div className="dw-color-popover" role="listbox" aria-label={label} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
      {allowNone && <button type="button" role="option" aria-selected={value === undefined} onClick={() => { onChange(undefined); setOpen(false); }}><i className="none" />Inherit</button>}
      {(all ? [...roles, ...palette] : roles).map(([k, t]) => <button type="button" role="option" key={k} aria-selected={value === k} title={t.description} onClick={() => { onChange(k); setOpen(false); }}>
        <i style={{ background: swatch(doc, k) }} /><span>{k}</span><i className="dark" style={{ background: swatch(doc, k, true) }} aria-hidden="true" />
      </button>)}
      {palette.length > 0 && <button type="button" className="dw-link" onClick={() => setAll(v => !v)}>{all ? 'Show roles only' : `Show palette (${palette.length})`}</button>}
    </div>}
  </div>;
}

/** Choose a size, weight or other token, or type a custom value when allowed. */
export function TokenSelect({ label, doc, types, value, onChange, categories, allowCustom = true, customLabel = 'Custom', min = 0, max = 2000, unit = 'px' }: {
  label: string; doc: DesignDocument; types: DesignTokenType[]; value: DesignValue | undefined; onChange: (v: DesignValue | undefined) => void;
  categories?: string[]; allowCustom?: boolean; customLabel?: string; min?: number; max?: number; unit?: string;
}) {
  const options = Object.entries(doc.tokens).filter(([, t]) => types.includes(t.type) && (!categories || !t.category || categories.includes(t.category)));
  const custom = typeof value === 'number';
  const missing = typeof value === 'string' && !doc.tokens[value];
  return <div className="dw-field">
    <span className="dw-field-label">{label}</span>
    <div className="dw-token-select">
      <select aria-label={label} value={value === undefined ? '' : custom ? '__custom' : value} onChange={e => { const v = e.target.value; onChange(v === '' ? undefined : v === '__custom' ? Number(resolveToken(doc.tokens, String(value ?? '')) ?? 0) || 0 : v); }}>
        <option value="">Default</option>
        {missing && <option value={value as string}>{value} (missing)</option>}
        {options.map(([k]) => <option key={k} value={k}>{k} · {tokenLabel(doc, k)}</option>)}
        {allowCustom && <option value="__custom">{customLabel}…</option>}
      </select>
      {custom && <span className="dw-number"><input type="number" aria-label={`${label} value`} min={min} max={max} value={value} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); }} /><span aria-hidden="true">{unit}</span></span>}
    </div>
  </div>;
}

export function IconButton({ label, icon, onClick, pressed, disabled, className }: { label: string; icon: Parameters<typeof Icon>[0]['name']; onClick: () => void; pressed?: boolean; disabled?: boolean; className?: string }) {
  return <button type="button" className={`dw-icon-button${className ? ` ${className}` : ''}`} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon name={icon} size={16} /></button>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="dw-empty-panel"><b>{title}</b>{children && <div>{children}</div>}</div>;
}
