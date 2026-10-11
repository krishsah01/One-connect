// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { describe, expect, it } from 'vitest';
import {
  applyDesignOperations, applyDesignPatch, componentUsage, contrastRatio, createDesignDocument, DEFAULT_DESIGN, DESIGN_STARTERS, designCss, designDiff,
  designDocumentFindings, designMarkdown, designSourcePackage, DesignSystemSchema, designTokenValue, diffDesignDocuments, generateFoundations,
  importHtmlDesign, inferStarter, libraryComponentOps, migrateDesignDocument, newDesignNode, parseDesignDocument, proposeDesign, resolveToken,
  starterLibrary, tokenUsage, validTokenValue, zipFiles, type DesignDocument,
} from '../src/index.ts';

const doc = (starter: (typeof DESIGN_STARTERS)[number] = 'dashboard') => createDesignDocument('doc', 'Studio', starter);

describe('starters and proposals', () => {
  it('builds every starter as a valid, multi-screen design with working links and no blocking findings', () => {
    for (const s of DESIGN_STARTERS) {
      const d = doc(s);
      expect(d.screens.length).toBeGreaterThanOrEqual(3);
      expect(d.interactions.length).toBeGreaterThan(0);
      expect(designDocumentFindings(d).filter(f => f.severity === 'error')).toEqual([]);
    }
  });

  it('proposes a direction, foundations, components and screens from one sentence', () => {
    expect(inferStarter('An online shop for handmade ceramics')).toBe('commerce');
    expect(inferStarter('Settings for my account')).toBe('settings');
    const p = proposeDesign({ prompt: 'A cozy online shop for handmade ceramics' });
    expect(p).toMatchObject({ starter: 'commerce', tone: 'warm', name: 'Cozy online shop for handmade ceramics' });
    expect(p.screens).toEqual(['Shop', 'Product', 'Cart']);
    expect(p.palette.find(c => c.role === 'text')).toBeTruthy();
    const d = p.document('doc');
    expect(d.direction).toMatch(/Warm and friendly/);
    expect(d.name).toBe(p.name);
  });

  it('generates readable foundations in both themes for any brand color', () => {
    for (const brand of ['#ffeb3b', '#0000ff', '#111111', '#e91e63', '#00bcd4']) for (const tone of ['calm', 'bold', 'warm', 'minimal', 'playful'] as const) {
      const t = generateFoundations({ brand, tone });
      for (const dark of [false, true]) {
        const ratio = (fg: string, bg: string) => contrastRatio(String(resolveToken(t, fg, dark)), String(resolveToken(t, bg, dark)));
        expect(ratio('text', 'surface')).toBeGreaterThanOrEqual(4.5);
        expect(ratio('text-muted', 'surface')).toBeGreaterThanOrEqual(4.5);
        expect(ratio('accent', 'surface')).toBeGreaterThanOrEqual(4.5);
        expect(ratio('on-accent', 'accent')).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('offers an editable library of common components', () => {
    const lib = starterLibrary().map(c => c.component.id);
    for (const id of ['button', 'text-field', 'dropdown', 'checkbox', 'switch', 'top-bar', 'tabs', 'dialog', 'drawer', 'menu', 'tooltip', 'notification', 'card', 'data-table', 'pagination', 'bar-chart', 'empty-state', 'loading-state', 'error-state']) expect(lib).toContain(id);
    const d = doc('onboarding');
    const op = libraryComponentOps(d, 'button')!;
    const next = applyDesignOperations(d, [op]);
    expect(next.components.button.variants).toHaveProperty('danger');
    expect(libraryComponentOps(next, 'button')).toBeNull();
  });
});

describe('editing operations', () => {
  it('turns repeated cards into a component, keeping their differences as overrides', () => {
    let d = createDesignDocument('doc', 'Studio', 'landing');
    const plans = Object.values(d.nodes).filter(n => n.kind === 'instance' && n.props.componentId === 'card');
    expect(plans.length).toBeGreaterThan(2);
    // Detach two plan cards so they are plain layers again, then make a new component from them.
    d = applyDesignOperations(d, [{ type: 'detach-instance', id: plans[0].id }, { type: 'detach-instance', id: plans[1].id }]);
    expect(d.nodes[plans[0].id].kind).toBe('card');
    const next = applyDesignOperations(d, [{ type: 'make-component', nodeId: plans[0].id, id: 'feature', name: 'Feature', replace: [plans[1].id] }]);
    expect(next.nodes[plans[1].id]).toMatchObject({ kind: 'instance', props: { componentId: 'feature' } });
    expect(Object.values(next.nodes[plans[1].id].props.overrides ?? {}).some(o => o.text)).toBe(true);
    expect(componentUsage(next, 'feature').instances).toEqual(expect.arrayContaining([plans[0].id, plans[1].id]));
    expect(designDocumentFindings(next).filter(f => f.severity === 'error')).toEqual([]);
  });

  it('refuses to delete a used component unless instances are detached, and detaching keeps slot content', () => {
    const d = doc();
    expect(() => applyDesignOperations(d, [{ type: 'remove-component', id: 'card' }])).toThrow(/still use/);
    const filled = Object.values(d.nodes).find(n => n.kind === 'instance' && n.props.componentId === 'card' && n.children.length)!;
    const fill = filled.children[0];
    const next = applyDesignOperations(d, [{ type: 'remove-component', id: 'card', detach: true }]);
    expect(next.components.card).toBeUndefined();
    expect(next.nodes[filled.id].kind).toBe('card');
    expect(Object.values(next.nodes).some(n => n.children.includes(fill))).toBe(true);
    expect(next.nodes[fill].props.slot).toBeUndefined();
  });

  it('replaces tokens everywhere they are referenced', () => {
    const d = doc();
    const before = tokenUsage(d).get('text-muted')!;
    expect(before.nodes.length + before.components.length).toBeGreaterThan(0);
    const next = applyDesignOperations(d, [{ type: 'replace-token', from: 'text-muted', to: 'text', remove: true }]);
    expect(tokenUsage(next).get('text-muted')).toBeUndefined();
    expect(next.tokens['text-muted']).toBeUndefined();
    expect(designDocumentFindings(next).filter(f => f.rule === 'token-reference')).toEqual([]);
    expect(() => applyDesignOperations(d, [{ type: 'replace-token', from: 'text', to: 'radius-md' }])).toThrow(/color token/);
  });

  it('groups, ungroups, moves and duplicates layers with their interactions', () => {
    const d = doc('onboarding');
    const root = d.nodes[d.screens.find(s => s.id === 'welcome')!.root];
    const section = d.nodes[root.children[0]];
    const [a, b] = section.children;
    const grouped = applyDesignOperations(d, [{ type: 'wrap-nodes', ids: [b, a], node: newDesignNode('group-1', 'frame', 'Group') }]);
    expect(grouped.nodes[section.id].children[0]).toBe('group-1');
    expect(grouped.nodes['group-1'].children).toEqual([a, b]);
    const ungrouped = applyDesignOperations(grouped, [{ type: 'unwrap-node', id: 'group-1' }]);
    expect(ungrouped.nodes[section.id].children).toEqual(section.children);
    const moved = applyDesignOperations(d, [{ type: 'move-node', id: a, parent: section.id, index: 3 }]);
    expect(moved.nodes[section.id].children.indexOf(a)).toBe(2);
    const dup = applyDesignOperations(d, [{ type: 'duplicate-node', id: 'welcome-start', newId: 'copy' }]);
    expect(dup.nodes['copy-welcome-start']).toBeTruthy();
    expect(dup.interactions.some(i => i.source === 'copy-welcome-start' && i.target === 'profile')).toBe(true);
    const removed = applyDesignOperations(dup, [{ type: 'remove-node', id: 'copy-welcome-start' }]);
    expect(removed.interactions.some(i => i.source === 'copy-welcome-start')).toBe(false);
  });

  it('rejects cycles, duplicate parents, executable properties and unsafe token values', () => {
    const d = doc();
    const grid = Object.values(d.nodes).find(n => n.name === 'Highlights')!;
    expect(() => applyDesignOperations(d, [{ type: 'move-node', id: d.nodes[d.screens[0].root].children[1], parent: grid.id, index: 0 }])).toThrow(/Cyclic/);
    const bad = structuredClone(d); bad.nodes[bad.screens[0].root].children.push(grid.id);
    expect(() => parseDesignDocument(bad)).toThrow(/multiple parents/);
    expect(() => applyDesignOperations(d, [{ type: 'update-node', id: grid.id, patch: { props: { onClick: 'alert(1)' } } }])).toThrow();
    expect(() => applyDesignOperations(d, [{ type: 'update-node', id: grid.id, patch: { props: { background: 'red; background: url(x)' } } }])).toThrow();
    for (const [type, value] of [['color', 'url(https://attacker)'], ['color', 'expression(alert(1))'], ['font', 'x;}body{display:none'], ['shadow', '0 0 0 red, url(x)'], ['easing', 'steps(1); background:url(x)'], ['dimension', '12px']] as const) {
      expect(validTokenValue(type, value)).toBe(false);
      expect(() => applyDesignOperations(d, [{ type: 'set-token', id: 'evil', value: { type, value, description: '' } }])).toThrow();
    }
    const cyclic = applyDesignOperations(d, [{ type: 'set-token', id: 'a1', value: { type: 'color', value: '#ffffff', alias: 'a2', description: '' } }, { type: 'set-token', id: 'a2', value: { type: 'color', value: '#ffffff', alias: 'a1', description: '' } }]);
    expect(designTokenValue(cyclic, 'a1')).toBeUndefined();
    expect(designDocumentFindings(cyclic).some(f => f.rule === 'token-alias' && f.tokenId === 'a1')).toBe(true);
  });

  it('keeps failed batches atomic and respects ancestor locks', () => {
    const d = doc();
    const before = JSON.stringify(d);
    const heading = Object.values(d.nodes).find(n => n.props.level === 1)!;
    expect(() => applyDesignOperations(d, [{ type: 'update-node', id: heading.id, patch: { props: { text: 'changed' } } }, { type: 'remove-node', id: d.screens[0].root }])).toThrow();
    expect(JSON.stringify(d)).toBe(before);
    const section = Object.values(d.nodes).find(n => n.children.includes(heading.id))!;
    const locked = applyDesignOperations(d, [{ type: 'update-node', id: section.id, patch: { locked: true } }]);
    expect(() => applyDesignOperations(locked, [{ type: 'update-node', id: heading.id, patch: { props: { text: 'changed' } } }])).toThrow(/Unlock/);
    expect(applyDesignOperations(locked, [{ type: 'update-node', id: section.id, patch: { locked: false } }]).nodes[section.id].locked).toBe(false);
  });

  it('records changes as patches that undo and redo exactly', () => {
    const d = doc();
    const next = applyDesignOperations(d, [{ type: 'set-token', id: 'accent', value: { ...d.tokens.accent, value: '#123456', alias: undefined, darkAlias: undefined } }, { type: 'rename', name: 'Renamed' }, { type: 'remove-screen', id: 'projects' }]);
    const { forward, backward } = diffDesignDocuments(d, next);
    expect(Object.keys(forward.tokens!)).toEqual(['accent']);
    expect(forward.name).toBe('Renamed');
    const undone = applyDesignPatch(next, backward, next.version + 1);
    expect({ ...undone, version: 0 }).toEqual({ ...d, version: 0 });
    const redone = applyDesignPatch(undone, forward, undone.version + 1);
    expect(redone.screens.map(s => s.id)).toEqual(next.screens.map(s => s.id));
  });
});

describe('findings', () => {
  it('measures contrast in both themes as drawn, including variants and inherited backgrounds', () => {
    const d = doc();
    const low = applyDesignOperations(d, [{ type: 'set-token', id: 'text-muted', value: { type: 'color', value: '#bbbbbb', dark: '#444444', description: 'too light' } }]);
    const contrast = designDocumentFindings(low).filter(f => f.rule === 'contrast');
    expect(contrast.some(f => /light theme/.test(f.message))).toBe(true);
    expect(contrast.some(f => /dark theme/.test(f.message))).toBe(true);
    expect(contrast.every(f => f.screenId || f.componentId)).toBe(true);
  });

  it('finds missing names, broken component use, prototype gaps and missing states', () => {
    const d = doc();
    const metric = Object.values(d.nodes).find(n => n.props.componentId === 'metric')!;
    const button = Object.values(d.nodes).find(n => n.kind === 'button')!;
    const bad = applyDesignOperations(d, [
      { type: 'update-node', id: metric.id, patch: { props: { variant: 'missing', overrides: { 'not-in-component': { text: 'x' } } } } },
      { type: 'update-node', id: button.id, patch: { props: { text: '', label: '' } } },
      { type: 'upsert-interaction', value: { id: 'broken', source: button.id, event: 'click', action: 'navigate', target: 'nowhere', transition: 'none' } },
      { type: 'update-screen', id: 'projects', patch: { states: ['success'] } },
    ]);
    const rules = designDocumentFindings(bad).map(f => f.rule);
    for (const r of ['variant-missing', 'override-invalid', 'accessible-name', 'interaction-target', 'states-missing']) expect(rules).toContain(r);
    const named = designDocumentFindings(bad).find(f => f.rule === 'accessible-name')!;
    expect(named.screenId ?? named.componentId).toBeTruthy();
  });
});

describe('contracts, exports and imports', () => {
  it('extends the contract to schema 3 without changing schema 2 output', () => {
    const old = designCss(DEFAULT_DESIGN), d = doc();
    const expanded = DesignSystemSchema.parse({ ...DEFAULT_DESIGN, schema: 3, foundations: d.tokens, foundationSettings: d.settings, content: d.content, replacements: { 'old-role': 'text' } });
    const css = designCss(expanded);
    expect(css).toContain(`--ds-accent: ${resolveToken(d.tokens, 'accent')}`);
    expect(css).toContain(`--ds-accent: ${resolveToken(d.tokens, 'accent', true)}`);
    expect(css).toContain('--ds-space-4: 16px');
    expect(designCss(DEFAULT_DESIGN)).toBe(old);
    expect(designDiff(DEFAULT_DESIGN, expanded).some(c => c.field === 'foundations.accent')).toBe(true);
    const md = designMarkdown({ version: 2, hash: 'a'.repeat(64), system: expanded, createdAt: '2026-10-10T00:00:00Z' });
    expect(md).toMatch(/## Foundations/);
    expect(md).toMatch(/`old-role` was removed; use `text`/);
    expect(() => DesignSystemSchema.parse({ ...expanded, foundations: { a: { type: 'color', value: '#ffffff', alias: 'a', description: '' } } })).toThrow(/alias/);
  });

  it('migrates schema 1 drafts in memory', () => {
    const v1 = { ...doc(), schema: 1 } as unknown as Record<string, unknown>;
    delete v1.content; delete v1.settings; delete v1.direction; delete v1.libraries;
    const d = parseDesignDocument(migrateDesignDocument(v1));
    expect(d.schema).toBe(2);
    expect(d.settings.breakpoints.phone).toBe(600);
  });

  it('generates typed components and screens that share the preview runtime', () => {
    const d = doc('settings');
    const pkg = designSourcePackage({ document: d, runtimeSource: "import type { DesignDocument } from '@acc/core';\nexport function DocumentRenderer() {}", typesSource: 'export {}', status: 'draft' });
    expect(pkg.files['src/runtime/DocumentRenderer.tsx']).toContain("from '../types'");
    expect(pkg.files['src/components/Sidebar.tsx']).toMatch(/export interface SidebarProps[\s\S]*brandName\?: string/);
    expect(pkg.files['src/components/Dialog.tsx']).toMatch(/variant\?: DialogVariant/);
    expect(pkg.files['src/screens/ProfileScreen.tsx']).toContain('screenId="profile"');
    expect(pkg.files['src/tokens.css']).toMatch(/\[data-theme="dark"\]/);
    expect(pkg.files['README.md']).toMatch(/Draft export/);
    const zip = zipFiles(Object.entries(pkg.files).map(([p, t]) => ({ path: p, data: new TextEncoder().encode(t) })));
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(() => zipFiles([{ path: '../escape', data: new Uint8Array() }])).toThrow(/Unsafe/);
  });

  it('rebuilds HTML pages as an editable interpretation without scripts or URLs', () => {
    const r = importHtmlDesign('doc', 'Old mock', [
      { path: 'index.html', html: '<!doctype html><html><head><title>Home</title><style>.btn{background:#7c3aed}</style><script>alert(1)</script></head><body><header class="row"><h1>Acme</h1><a href="pricing.html">Pricing</a></header><main><p>Hello &amp; welcome</p><label for="e">Email</label><input id="e" type="email" required><button onclick="steal()">Join</button><img src="https://evil.example/x.png" alt="Team photo"><table><tr><th>Plan</th></tr><tr><td>Pro</td></tr></table></main></body></html>' },
      { path: 'pricing.html', html: '<h1>Pricing</h1><ul><li>Free</li><li>Pro</li></ul>' },
    ]);
    const d: DesignDocument = r.document;
    expect(d.screens.map(s => s.name)).toEqual(['Home', 'pricing']);
    const kinds = Object.values(d.nodes).map(n => n.kind);
    for (const k of ['text', 'link', 'input', 'button', 'image', 'table', 'list']) expect(kinds).toContain(k);
    expect(Object.values(d.nodes).find(n => n.kind === 'input')).toMatchObject({ props: { label: 'Email', required: true, inputType: 'email' } });
    expect(d.interactions).toEqual([expect.objectContaining({ action: 'navigate', target: 'screen-2' })]);
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/alert|steal|evil\.example|onclick/);
    expect(resolveToken(d.tokens, 'brand-500')).toBeTruthy();
  });

  it('validates a 50-screen, 5,000-layer document and edits it quickly', () => {
    const d = doc();
    const extra: DesignDocument = { ...d, nodes: { ...d.nodes }, screens: [...d.screens] };
    for (let s = 0; s < 50 - d.screens.length; s++) {
      const root = newDesignNode(`root-${s}`, 'frame'); extra.nodes[root.id] = root;
      extra.screens.push({ id: `screen-${s}`, name: `Screen ${s}`, root: root.id, states: ['success', 'empty', 'loading', 'error'] });
      for (let n = 0; n < 100; n++) {
        const node = n % 10 === 0 ? { ...newDesignNode(`node-${s}-${n}`, 'instance'), props: { componentId: 'metric', overrides: { 'c-metric-value': { text: String(n) } } } } : newDesignNode(`node-${s}-${n}`, 'text');
        root.children.push(node.id); extra.nodes[node.id] = node;
      }
    }
    let t = performance.now();
    const big = parseDesignDocument(extra);
    expect(Object.keys(big.nodes).length).toBeGreaterThanOrEqual(4600);
    expect(designDocumentFindings(big).filter(f => f.severity === 'error')).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1500);
    t = performance.now();
    const next = applyDesignOperations(big, [{ type: 'update-node', id: 'node-3-5', patch: { props: { text: 'Edited' } } }]);
    diffDesignDocuments(big, next);
    expect(performance.now() - t).toBeLessThan(100);
  });
});
