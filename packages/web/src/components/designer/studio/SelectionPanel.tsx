// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The panel that appears only when a layer is selected. A handful of controls that matter for that
// kind of layer; everything else waits behind "Layout and more". Every change is one undo step.
import { useState } from 'react';
import type { DesignDocument, DesignInteraction, DesignLayout, DesignNode, DesignNodeProps, DesignOperation } from '@acc/core';
import { Icon } from '../workspace/DocumentRenderer';
import { Check, ColorPicker, Field, NumberField, Segmented, TextField, TokenSelect } from '../workspace/controls';
import { layerPath } from './model';

export const newId = (prefix = 'layer') => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const TEXT_KINDS = new Set(['text', 'button', 'badge', 'link', 'notification']);
const LABEL_KINDS = new Set(['input', 'textarea', 'checkbox', 'radio', 'switch', 'select', 'tabs', 'navigation', 'table', 'list', 'chart', 'progress', 'menu']);
const ICON_KINDS = new Set(['button', 'input', 'link', 'icon', 'badge']);
const ICONS = ['', 'plus', 'check', 'close', 'search', 'arrow-right', 'arrow-left', 'edit', 'trash', 'download', 'upload', 'settings', 'bell', 'user', 'users', 'calendar', 'chart', 'filter', 'menu', 'more', 'link', 'star', 'heart', 'info', 'warning', 'success', 'sparkle'] as const;
const ACTIONS: { v: DesignInteraction['action']; label: string; target: 'screen' | 'overlay' | 'none' | 'node' }[] = [
  { v: 'navigate', label: 'Go to screen', target: 'screen' }, { v: 'open-overlay', label: 'Open dialog', target: 'overlay' }, { v: 'close-overlay', label: 'Close dialog', target: 'none' },
  { v: 'back', label: 'Go back', target: 'none' }, { v: 'toggle', label: 'Show or hide a layer', target: 'node' }, { v: 'validate', label: 'Validate the form', target: 'none' },
];

export function SelectionPanel({ doc: d, node, apply, disabled, onClose, onSelect }: {
  doc: DesignDocument; node: DesignNode; apply: (ops: DesignOperation[], label?: string) => boolean; disabled: boolean; onClose: () => void; onSelect: (id: string) => void;
}) {
  const { screen, chain } = layerPath(d, node.id);
  const props = (patch: DesignNodeProps, label = `Edit ${node.name}`) => {
    const unset = Object.entries(patch).filter(([, v]) => v === undefined).map(([key]) => ({ type: 'unset-node-property' as const, id: node.id, area: 'props' as const, key }));
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    apply([...unset, ...(Object.keys(set).length ? [{ type: 'update-node' as const, id: node.id, patch: { props: set } }] : [])], label);
  };
  const layout = (patch: DesignLayout, label = `Arrange ${node.name}`) => {
    const unset = Object.entries(patch).filter(([, v]) => v === undefined).map(([key]) => ({ type: 'unset-node-property' as const, id: node.id, area: 'layout' as const, key }));
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    apply([...unset, ...(Object.keys(set).length ? [{ type: 'update-node' as const, id: node.id, patch: { layout: set } }] : [])], label);
  };
  const isButton = node.kind === 'button';
  const style: 'primary' | 'secondary' | 'ghost' = node.props.background === 'accent' ? 'primary' : node.props.background === undefined && !node.props.border ? 'ghost' : 'secondary';
  const setStyle = (v: typeof style) => props(v === 'primary' ? { background: 'accent', color: 'on-accent', border: false } : v === 'secondary' ? { background: 'surface', color: 'text', border: true } : { background: undefined, color: 'accent', border: false }, 'Change button style');
  const container = ['frame', 'card', 'dialog', 'drawer', 'slot'].includes(node.kind);
  const kindLabel = node.kind === 'instance' ? d.components[node.props.componentId ?? '']?.name ?? 'Component' : node.kind[0].toUpperCase() + node.kind.slice(1);

  return <aside className="dz-side" aria-label={`Selected: ${node.name}`}>
    <div className="dz-side-head">
      <nav className="dz-crumbs" aria-label="Where this layer is">
        {screen && <><span>{screen.name}</span><span aria-hidden="true">›</span></>}
        {chain.slice(0, -1).slice(-2).map(n => <span key={n.id}><button type="button" onClick={() => onSelect(n.id)}>{n.name}</button><span aria-hidden="true"> › </span></span>)}
        <b>{kindLabel}</b>
      </nav>
      <span className="spacer" />
      <button type="button" className="dz-icon-btn" aria-label="Close panel" onClick={onClose}><Icon name="close" size={14} /></button>
    </div>
    <fieldset className="dz-side-body" disabled={disabled} style={{ border: 0, margin: 0, minWidth: 0 }}>
      <TextField label="Name" value={node.name} onCommit={v => v && apply([{ type: 'update-node', id: node.id, patch: { name: v } }], 'Rename layer')} />
      {TEXT_KINDS.has(node.kind) && <TextField label={node.kind === 'text' ? 'Text' : 'Label'} value={node.props.text} multiline={node.kind === 'text'} onCommit={v => props({ text: v })} />}
      {LABEL_KINDS.has(node.kind) && <TextField label="Accessible label" value={node.props.label} hint="What a screen reader announces." onCommit={v => props({ label: v })} />}
      {node.kind === 'image' && <TextField label="Image description" value={node.props.alt} onCommit={v => props({ alt: v })} />}
      {['input', 'textarea'].includes(node.kind) && <TextField label="Placeholder" value={node.props.placeholder} onCommit={v => props({ placeholder: v })} />}
      {['select', 'tabs', 'navigation', 'radio'].includes(node.kind) && <TextField label="Options, one per line" value={node.props.options?.join('\n')} multiline onCommit={v => props({ options: v.split('\n').map(s => s.trim()).filter(Boolean) })} />}
      {node.kind === 'instance' && node.props.componentId && Object.keys(d.components[node.props.componentId]?.variants ?? {}).length > 0 && <Field label="Variant">
        <select value={node.props.variant ?? ''} onChange={e => props({ variant: e.target.value || undefined }, 'Change variant')}><option value="">Default</option>{Object.keys(d.components[node.props.componentId]!.variants).map(v => <option key={v}>{v}</option>)}</select></Field>}
      {isButton && <Segmented label="Style" value={style} options={[{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }, { value: 'ghost', label: 'Ghost' }]} onChange={setStyle} />}
      {['badge', 'notification'].includes(node.kind) && <Segmented label="Tone" value={node.props.tone ?? 'neutral'} options={(['neutral', 'info', 'success', 'warning', 'danger'] as const).map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} onChange={v => props({ tone: v }, 'Change tone')} />}
      {!isButton && node.kind !== 'instance' && <div className="dz-pair">
        <ColorPicker label={container ? 'Fill' : 'Text colour'} doc={d} value={container ? node.props.background : node.props.color} onChange={v => props(container ? { background: v } : { color: v }, 'Change colour')} />
        {container ? <Check label="Show border" checked={!!node.props.border} onChange={v => props({ border: v }, 'Toggle border')} /> : <ColorPicker label="Fill" doc={d} value={node.props.background} onChange={v => props({ background: v }, 'Change fill')} />}
      </div>}
      {(TEXT_KINDS.has(node.kind) || container) && !isButton && <div className="dz-pair">
        {TEXT_KINDS.has(node.kind) && <TokenSelect label="Text size" doc={d} types={['dimension']} categories={['type-scale']} value={node.props.fontSize} onChange={v => props({ fontSize: v }, 'Change text size')} />}
        {TEXT_KINDS.has(node.kind) && <TokenSelect label="Weight" doc={d} types={['fontWeight']} value={node.props.fontWeight} onChange={v => props({ fontWeight: v }, 'Change weight')} allowCustom={false} />}
        {container && <TokenSelect label="Corners" doc={d} types={['dimension']} categories={['radius']} value={node.props.radius} onChange={v => props({ radius: v }, 'Change corners')} />}
        {container && <TokenSelect label="Shadow" doc={d} types={['shadow']} value={node.props.shadow} onChange={v => props({ shadow: typeof v === 'string' ? v : undefined }, 'Change shadow')} allowCustom={false} />}
      </div>}
      {isButton && <div className="dz-pair">
        <TokenSelect label="Size" doc={d} types={['dimension']} categories={['type-scale']} value={node.props.fontSize} onChange={v => props({ fontSize: v }, 'Change size')} />
        <TokenSelect label="Corners" doc={d} types={['dimension']} categories={['radius']} value={node.props.radius} onChange={v => props({ radius: v }, 'Change corners')} />
      </div>}
      {ICON_KINDS.has(node.kind) && <Field label="Icon"><select value={node.props.icon ?? ''} onChange={e => props({ icon: (e.target.value || undefined) as DesignNodeProps['icon'] }, 'Change icon')}>{ICONS.map(i => <option key={i} value={i}>{i || 'None'}</option>)}</select></Field>}

      <Interactions doc={d} node={node} apply={apply} />

      <details>
        <summary>Layout and more</summary>
        <div className="dz-group" style={{ paddingTop: 10 }}>
          {container && <Segmented label="Arrange children" value={node.layout.direction ?? 'column'} options={[{ value: 'column', label: 'Stack' }, { value: 'row', label: 'Row' }, { value: 'grid', label: 'Grid' }]} onChange={v => layout({ direction: v })} />}
          {container && <div className="dz-pair">
            <TokenSelect label="Gap" doc={d} types={['dimension']} categories={['spacing']} value={node.layout.gap} onChange={v => layout({ gap: v })} />
            <TokenSelect label="Padding" doc={d} types={['dimension']} categories={['spacing']} value={node.layout.padding} onChange={v => layout({ padding: v })} />
          </div>}
          {container && node.layout.direction === 'grid' && <NumberField label="Columns" value={node.layout.columns ?? 2} min={1} max={12} onCommit={v => layout({ columns: v })} />}
          <div className="dz-pair">
            <Field label="Width"><select value={typeof node.layout.width === 'number' ? 'fixed' : node.layout.width ?? 'fill'} onChange={e => layout({ width: e.target.value === 'fixed' ? 320 : e.target.value as 'fill' | 'hug' })}><option value="fill">Fill</option><option value="hug">Fit content</option><option value="fixed">Fixed</option></select></Field>
            {typeof node.layout.width === 'number' ? <NumberField label="Width in px" value={node.layout.width} min={8} max={4000} onCommit={v => layout({ width: v ?? 'fill' })} /> : <TokenSelect label="Max width" doc={d} types={['dimension']} categories={['spacing']} value={node.layout.maxWidth} onChange={v => layout({ maxWidth: v })} customLabel="Pixels" />}
          </div>
          {container && <Check label="Wrap onto new lines" checked={!!node.layout.wrap} onChange={v => layout({ wrap: v })} />}
          <Check label="Hidden" checked={!!node.hidden} onChange={v => apply([{ type: 'update-node', id: node.id, patch: { hidden: v } }], v ? 'Hide layer' : 'Show layer')} />
          <Check label="Locked" checked={!!node.locked} onChange={v => apply([{ type: 'update-node', id: node.id, patch: { locked: v } }], v ? 'Lock layer' : 'Unlock layer')} />
        </div>
      </details>
    </fieldset>
    <div className="dz-side-foot">
      <div className="row">
        {node.kind !== 'instance' && chain.length > 1 && <button type="button" className="btn sm" disabled={disabled} onClick={() => apply([{ type: 'make-component', nodeId: node.id, id: newId('component'), name: node.name }], 'Make reusable')}>Make reusable</button>}
        {chain.length > 1 && <button type="button" className="btn sm" disabled={disabled} onClick={() => { const id = newId('copy'); if (apply([{ type: 'duplicate-node', id: node.id, newId: id }], 'Duplicate')) onSelect(id); }}>Duplicate</button>}
        <span className="spacer" />
        {chain.length > 1 && <button type="button" className="btn sm danger" disabled={disabled || node.locked} onClick={() => { if (apply([{ type: 'remove-node', id: node.id }], 'Delete layer')) onClose(); }}>Delete</button>}
      </div>
    </div>
  </aside>;
}

function Interactions({ doc: d, node, apply }: { doc: DesignDocument; node: DesignNode; apply: (ops: DesignOperation[], label?: string) => boolean }) {
  const mine = d.interactions.filter(i => i.source === node.id);
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<DesignInteraction['action']>('navigate'), [target, setTarget] = useState('');
  const def = ACTIONS.find(a => a.v === action)!;
  const targets = def.target === 'screen' ? d.screens.filter(s => s.kind !== 'dialog' && s.kind !== 'drawer') : def.target === 'overlay' ? d.screens.filter(s => s.kind === 'dialog' || s.kind === 'drawer') : def.target === 'node' ? Object.values(d.nodes).filter(n => n.id !== node.id) : [];
  const event: DesignInteraction['event'] = ['input', 'textarea', 'checkbox', 'radio', 'switch', 'select', 'tabs', 'navigation'].includes(node.kind) ? 'change' : 'click';
  const describe = (i: DesignInteraction) => {
    const a = ACTIONS.find(x => x.v === i.action);
    const t = i.target ? d.screens.find(s => s.id === i.target)?.name ?? d.nodes[i.target]?.name ?? i.target : '';
    return `${i.event === 'change' ? 'On change' : 'When clicked'}: ${a?.label.toLowerCase() ?? i.action}${t ? ` “${t}”` : ''}`;
  };
  return <div className="dz-group">
    <h3>{event === 'change' ? 'On change' : 'When clicked'}</h3>
    {mine.map(i => <div className="dz-interaction" key={i.id}><Icon name="arrow-right" size={13} /><span>{describe(i)}</span>
      <button type="button" className="dz-icon-btn" aria-label="Remove interaction" onClick={() => apply([{ type: 'remove-interaction', id: i.id }], 'Remove interaction')}><Icon name="close" size={12} /></button></div>)}
    {!adding && <button type="button" className="dz-link" onClick={() => setAdding(true)}>+ Add {mine.length ? 'another' : 'an interaction'}</button>}
    {adding && <div className="dz-group">
      <Field label="Do this"><select value={action} onChange={e => { setAction(e.target.value as DesignInteraction['action']); setTarget(''); }}>{ACTIONS.map(a => <option key={a.v} value={a.v}>{a.label}</option>)}</select></Field>
      {def.target !== 'none' && <Field label="Target"><select value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose…</option>{targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
      <div className="row" style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn sm primary" disabled={def.target !== 'none' && !target} onClick={() => { if (apply([{ type: 'upsert-interaction', value: { id: newId('interaction'), source: node.id, event, action, target: def.target === 'none' ? undefined : target, transition: action === 'open-overlay' ? 'scale' : action === 'navigate' ? 'fade' : 'none' } }], 'Add interaction')) { setAdding(false); setTarget(''); } }}>Add</button>
        <button type="button" className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button>
      </div>
    </div>}
  </div>;
}
