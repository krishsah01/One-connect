// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Rebuild static HTML (a legacy mock's pages) as an editable structured design. This is an
// interpretation, not a copy: scripts, styles and URLs are dropped, text and structure become layers,
// local page links become prototype navigation. The original artifact is never modified.
import { DEFAULT_CONTENT, DEFAULT_SETTINGS, contrastRatio, generateFoundations, hexToHsl } from './designFoundations.ts';
import { DESIGN_DOCUMENT_SCHEMA, newDesignNode, parseDesignDocument } from './designDocument.ts';
import type { DesignDocument, DesignInteraction, DesignNode, DesignNodeKind, DesignNodeProps, DesignScreen } from './designDocumentTypes.ts';

interface El { tag: string; attrs: Record<string, string>; children: (El | string)[] }
const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'wbr']);
const SKIP = new Set(['script', 'style', 'head', 'template', 'noscript', 'svg', 'iframe', 'object', 'canvas', 'video', 'audio']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', middot: '·', times: '×', rarr: '→', larr: '←' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

/** A forgiving parser for the limited HTML found in mocks. Never executes anything. */
export function parseHtmlTree(html: string): El {
  const root: El = { tag: 'root', attrs: {}, children: [] }, stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/\s*([a-z0-9-]+)\s*>|<([a-z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|</gi;
  let skipping: string | null = null, m: RegExpExecArray | null;
  const text = html.slice(0, 2_000_000);
  while ((m = re.exec(text))) {
    const [, close, open, rawAttrs, selfClose, txt] = m;
    if (skipping) { if (close?.toLowerCase() === skipping) skipping = null; continue; }
    if (txt !== undefined) { const t = decode(txt); if (t.trim()) stack[stack.length - 1].children.push(t); continue; }
    if (open) {
      const tag = open.toLowerCase();
      if (SKIP.has(tag)) { if (!selfClose && !VOID.has(tag)) skipping = tag; continue; }
      const attrs: Record<string, string> = {};
      for (const a of (rawAttrs ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const el: El = { tag, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (!VOID.has(tag) && !selfClose) stack.push(el);
      if (stack.length > 200) stack.pop();
      continue;
    }
    if (close) {
      const tag = close.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
    }
  }
  return root;
}

const textOf = (e: El | string): string => typeof e === 'string' ? e : e.children.map(textOf).join(' ');
const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 600);
const find = (e: El, tag: string): El | null => { for (const c of e.children) if (typeof c !== 'string') { if (c.tag === tag) return c; const f = find(c, tag); if (f) return f; } return null; };
const all = (e: El, tag: string, out: El[] = []): El[] => { for (const c of e.children) if (typeof c !== 'string') { if (c.tag === tag) out.push(c); all(c, tag, out); } return out; };
const HEADING: Record<string, { size: string; level: 1 | 2 | 3 | 4 }> = { h1: { size: 'text-3xl', level: 1 }, h2: { size: 'text-2xl', level: 2 }, h3: { size: 'text-xl', level: 3 }, h4: { size: 'text-lg', level: 4 }, h5: { size: 'text-md', level: 4 }, h6: { size: 'text-md', level: 4 } };
const CONTAINER_TAGS = new Set(['div', 'section', 'main', 'header', 'footer', 'article', 'aside', 'form', 'figure', 'fieldset', 'body', 'html', 'root', 'dialog', 'details']);

export interface ImportedPage { path: string; html: string; title?: string }
export interface ImportResult { document: DesignDocument; notes: string[] }

/** Most saturated, readable color mentioned in the pages' styles, as a brand suggestion. */
function brandFrom(css: string): string | null {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/#([0-9a-f]{6})\b/gi)) { const c = `#${m[1].toLowerCase()}`; counts.set(c, (counts.get(c) ?? 0) + 1); }
  const candidates = [...counts.keys()].filter(c => { const [, s, l] = hexToHsl(c); return s > 35 && l > 20 && l < 70 && contrastRatio(c, '#ffffff') >= 3; });
  candidates.sort((a, b) => hexToHsl(b)[1] * (counts.get(b) ?? 1) - hexToHsl(a)[1] * (counts.get(a) ?? 1));
  return candidates[0] ?? null;
}

export function importHtmlDesign(id: string, name: string, pages: ImportedPage[], systemHash: string | null = null): ImportResult {
  const notes: string[] = [];
  const nodes: Record<string, DesignNode> = {}, screens: DesignScreen[] = [], interactions: DesignInteraction[] = [];
  const used = new Set<string>();
  const key = (base: string) => { const b = (/^[A-Za-z]/.test(base) ? base : `l-${base}`).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80); let k = b, n = 2; while (used.has(k)) k = `${b}-${n++}`; used.add(k); return k; };
  const screenFor = new Map(pages.map((p, i) => [p.path, `screen-${i + 1}`]));
  const links: { source: string; href: string }[] = [];
  let count = 0;
  const add = (prefix: string, kind: DesignNodeKind, label: string, props: DesignNodeProps = {}, layout: DesignNode['layout'] = {}): DesignNode => {
    const n = newDesignNode(key(`${prefix}-${kind}`), kind, label.slice(0, 80) || undefined);
    n.props = { ...n.props, ...props }; n.layout = { ...n.layout, ...layout };
    nodes[n.id] = n; count++;
    return n;
  };
  const labelFor = (page: El, input: El): string => {
    if (input.attrs['aria-label']) return input.attrs['aria-label'];
    if (input.attrs.id) { const l = all(page, 'label').find(x => x.attrs.for === input.attrs.id); if (l) return clean(textOf(l)); }
    return input.attrs.placeholder || input.attrs.name || 'Field';
  };
  const convert = (page: El, e: El | string, prefix: string): string[] => {
    if (count > 3000) return [];
    if (typeof e === 'string') { const t = clean(e); return t ? [add(prefix, 'text', 'Text', { text: t }).id] : []; }
    const t = e.tag;
    if (HEADING[t]) return [add(prefix, 'text', 'Heading', { text: clean(textOf(e)), fontSize: HEADING[t].size, fontWeight: 'weight-heading', font: 'font-heading', level: HEADING[t].level, lineHeight: 'leading-tight' }).id];
    if (t === 'p' || t === 'span' || t === 'small' || t === 'strong' || t === 'em' || t === 'label' || t === 'blockquote' || t === 'figcaption' || t === 'legend' || t === 'summary' || t === 'b' || t === 'i' || t === 'code' || t === 'time') {
      if (t === 'label' && e.children.some(c => typeof c !== 'string' && ['input', 'select', 'textarea'].includes(c.tag))) return e.children.flatMap(c => convert(page, c, prefix));
      if (t === 'label' && e.attrs.for) return [];
      const text = clean(textOf(e));
      return text ? [add(prefix, 'text', t === 'label' ? 'Label' : 'Text', { text, ...(t === 'small' ? { fontSize: 'text-sm', color: 'text-muted' } : t === 'strong' || t === 'b' ? { fontWeight: 'weight-semibold' } : {}) }).id] : [];
    }
    if (t === 'button' || (t === 'input' && ['submit', 'button', 'reset'].includes(e.attrs.type ?? ''))) {
      const text = clean(textOf(e)) || e.attrs.value || e.attrs['aria-label'] || 'Button';
      return [add(prefix, 'button', text, { text, background: 'accent', color: 'on-accent', radius: 'radius-md' }, { width: 'hug' }).id];
    }
    if (t === 'a') {
      const text = clean(textOf(e)) || e.attrs['aria-label'] || 'Link';
      const n = add(prefix, 'link', text, { text, color: 'accent' }, { width: 'hug' });
      const href = (e.attrs.href ?? '').split('#')[0];
      if (href && screenFor.has(href)) links.push({ source: n.id, href });
      return [n.id];
    }
    if (t === 'input') {
      const type = (e.attrs.type ?? 'text').toLowerCase(), label = labelFor(page, e);
      if (type === 'hidden') return [];
      if (type === 'checkbox' || type === 'radio') return [add(prefix, 'checkbox', label, { label, checked: 'checked' in e.attrs }).id];
      return [add(prefix, 'input', label, { label, placeholder: e.attrs.placeholder, value: e.attrs.value, required: 'required' in e.attrs, inputType: (['email', 'number', 'password', 'search', 'tel', 'date'].includes(type) ? type : 'text') as DesignNodeProps['inputType'] }).id];
    }
    if (t === 'textarea') { const label = labelFor(page, e); return [add(prefix, 'textarea', label, { label, placeholder: e.attrs.placeholder }).id]; }
    if (t === 'select') { const label = labelFor(page, e), options = all(e, 'option').map(o => clean(textOf(o))).filter(Boolean).slice(0, 100); return [add(prefix, 'select', label, { label, options, value: options[0] }).id]; }
    if (t === 'img') return [add(prefix, 'image', e.attrs.alt || 'Image', { alt: e.attrs.alt ?? '' }, { height: 200 }).id];
    if (t === 'hr') return [add(prefix, 'divider', 'Divider').id];
    if (t === 'table') {
      const rows = all(e, 'tr').slice(0, 200).map(r => r.children.filter((c): c is El => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th')).map(c => clean(textOf(c))).slice(0, 30));
      const caption = find(e, 'caption');
      return [add(prefix, 'table', caption ? clean(textOf(caption)) : 'Table', { rows: rows.filter(r => r.length), label: caption ? clean(textOf(caption)) : 'Table' }).id];
    }
    if (t === 'nav') {
      const items = all(e, 'a').map(a => clean(textOf(a))).filter(Boolean).slice(0, 12);
      if (items.length) return [add(prefix, 'navigation', 'Navigation', { label: e.attrs['aria-label'] || 'Navigation', options: items, selected: 0 }).id];
    }
    if ((t === 'ul' || t === 'ol') && e.children.every(c => typeof c === 'string' || c.tag === 'li') && all(e, 'li').every(li => li.children.every(c => typeof c === 'string' || !['ul', 'ol', 'button', 'input', 'img', 'table'].includes(c.tag)))) {
      const items = all(e, 'li').map(li => clean(textOf(li))).filter(Boolean).slice(0, 100);
      if (items.length) return [add(prefix, 'list', 'List', { label: e.attrs['aria-label'] || 'List', options: items }).id];
    }
    const kids = e.children.flatMap(c => convert(page, c, prefix));
    if (!CONTAINER_TAGS.has(t) && !['ul', 'ol', 'li', 'nav', 'dl', 'dt', 'dd'].includes(t)) return kids;
    if (kids.length === 0) return [];
    if (kids.length === 1 && t !== 'form' && t !== 'section') return kids;
    const style = (e.attrs.style ?? '') + ' ' + (e.attrs.class ?? '');
    const rowish = /\b(row|flex|inline|toolbar|actions|buttons|nav|header|bar)\b/i.test(style) && !/column/i.test(style);
    const gridish = /\b(grid|cards|tiles|columns)\b/i.test(style);
    const frame = add(prefix, /card|panel|tile/i.test(style) ? 'card' : 'frame', e.attrs['aria-label'] || (t === 'root' ? 'Page' : t[0].toUpperCase() + t.slice(1)), {}, gridish ? { direction: 'grid', columns: Math.min(4, Math.max(2, kids.length)), gap: 'space-5' } : rowish ? { direction: 'row', gap: 'space-3', wrap: true, align: 'center' } : { direction: 'column', gap: 'space-4' });
    if (gridish) frame.responsive = { phone: { columns: 1 }, tablet: { columns: 2 } };
    frame.children = kids;
    return [frame.id];
  };
  let css = '';
  pages.slice(0, 40).forEach((p, i) => {
    css += p.html.match(/<style[\s\S]*?<\/style>/gi)?.join('\n') ?? '';
    const tree = parseHtmlTree(p.html), body = find(tree, 'body') ?? tree;
    const sid = screenFor.get(p.path)!, prefix = `p${i + 1}`;
    const kids = body.children.flatMap(c => convert(tree, c, prefix));
    const root = add(prefix, 'frame', p.title || p.path, { background: 'canvas', color: 'text', font: 'font-body' }, { direction: 'column', gap: 'space-5', padding: 'space-6', width: 'fill', minHeight: 720 });
    root.responsive = { phone: { padding: 'space-4' } };
    root.children = kids;
    const title = p.title || clean(decode(p.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/<[^>]*>/g, '')) || p.path.replace(/\.html$/, '');
    screens.push({ id: sid, name: title.slice(0, 150) || `Screen ${i + 1}`, root: root.id, states: ['success', 'empty', 'loading', 'error'] });
  });
  if (pages.length > 40) notes.push(`Only the first 40 of ${pages.length} pages were rebuilt.`);
  if (count > 3000) notes.push('Large pages were shortened to keep the design editable.');
  links.forEach((l, i) => interactions.push({ id: `link-${i + 1}`, source: l.source, event: 'click', action: 'navigate', target: screenFor.get(l.href)!, transition: 'fade' }));
  const brand = brandFrom(css);
  if (brand) notes.push(`Brand color ${brand} was taken from the original styles. Typography and spacing use generated foundations; review them in Design system.`);
  notes.push('Images were kept as placeholders with their descriptions. Add the real images under Assets.');
  const document: DesignDocument = {
    schema: DESIGN_DOCUMENT_SCHEMA, id, name: name.slice(0, 150) || 'Rebuilt design', version: 1, systemHash,
    screens: screens.length ? screens : [{ id: 'screen-1', name: 'Screen 1', root: add('empty', 'frame', 'Screen').id, states: ['success'] }],
    nodes, components: {}, tokens: generateFoundations({ brand: brand ?? '#2563eb', tone: 'calm' }), assets: {}, fixtures: {}, interactions,
    content: DEFAULT_CONTENT, settings: DEFAULT_SETTINGS, direction: 'Rebuilt from an HTML mock. Review the visual direction and foundations.', libraries: [],
  };
  return { document: parseDesignDocument(document), notes };
}
