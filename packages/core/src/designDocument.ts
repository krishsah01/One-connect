// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Structured design documents: validation, typed editing operations shared by people and agents,
// compact history patches, deterministic findings and where-used indexes.
//
// Operations are copy-on-write: an untouched layer keeps its object identity, so a change can be
// recorded as a small patch (the before and after of only what changed) and checked incrementally.
import { z } from 'zod';
import {
  DEFAULT_CONTENT, DEFAULT_SETTINGS, DesignContentGuideSchema, DesignSettingsSchema, DesignTokenSchema, contrastRatio, designId,
  resolveToken, tokenAliasProblem,
} from './designFoundations.ts';
import type {
  DesignAsset, DesignComponent, DesignContentState, DesignDocument, DesignDocumentFinding, DesignInteraction, DesignNode, DesignNodeKind,
  DesignNodeProps, DesignOverride, DesignTokenType, DesignTokenValue,
} from './designDocumentTypes.ts';

export * from './designDocumentTypes.ts';
export * from './designFoundations.ts';

export const DESIGN_DOCUMENT_SCHEMA = 2;
export const DESIGN_LIMITS = { nodes: 10_000, screens: 100, components: 500, assets: 500, fixtures: 500, interactions: 10_000, depth: 100, operations: 500 } as const;

const id = designId();
const text = z.string().max(6000);
const dimension = z.number().finite().min(0).max(10000);
const value = z.union([dimension, id]);
const STATES = ['success', 'empty', 'loading', 'error', 'partial', 'permission', 'offline'] as const satisfies readonly DesignContentState[];
export const DESIGN_CONTENT_STATES = STATES;
const state = z.enum(STATES);

export const DESIGN_NODE_KINDS = [
  'frame', 'card', 'dialog', 'drawer', 'slot', 'instance',
  'text', 'image', 'icon', 'shape', 'divider', 'badge', 'avatar', 'link',
  'button', 'input', 'textarea', 'checkbox', 'radio', 'switch', 'select',
  'tabs', 'menu', 'navigation', 'pagination', 'tooltip',
  'notification', 'progress', 'spinner', 'skeleton',
  'table', 'chart', 'list',
] as const satisfies readonly DesignNodeKind[];
/** Kinds that hold child layers in the editor. */
export const CONTAINER_KINDS: readonly DesignNodeKind[] = ['frame', 'card', 'dialog', 'drawer', 'slot', 'tabs', 'tooltip'];
/** Kinds people operate with a keyboard or pointer; each needs an accessible name. */
export const CONTROL_KINDS: readonly DesignNodeKind[] = ['button', 'link', 'input', 'textarea', 'checkbox', 'radio', 'switch', 'select', 'tabs', 'menu', 'navigation', 'pagination'];
export const DESIGN_ICONS = [
  'star', 'check', 'plus', 'minus', 'close', 'search', 'arrow-right', 'arrow-left', 'chevron-down', 'chevron-right',
  'heart', 'home', 'user', 'users', 'settings', 'bell', 'mail', 'calendar', 'chart', 'folder', 'file',
  'cart', 'bag', 'lock', 'info', 'warning', 'error', 'success', 'menu', 'more', 'filter', 'upload',
  'download', 'edit', 'trash', 'link', 'globe', 'sparkle', 'moon', 'sun',
] as const;

const layoutShape = {
  direction: z.enum(['column', 'row', 'grid']).optional(),
  gap: value.optional(), padding: value.optional(), paddingX: value.optional(), paddingY: value.optional(),
  columns: z.number().int().min(1).max(24).optional(), wrap: z.boolean().optional(),
  align: z.enum(['start', 'center', 'end', 'stretch']).optional(), justify: z.enum(['start', 'center', 'end', 'between']).optional(),
  width: z.union([dimension, z.enum(['fill', 'hug'])]).optional(), height: z.union([dimension, z.enum(['fill', 'hug'])]).optional(),
  minWidth: dimension.optional(), maxWidth: value.optional(), minHeight: dimension.optional(),
  position: z.enum(['flow', 'absolute']).optional(),
  x: z.number().finite().min(-10000).max(10000).optional(), y: z.number().finite().min(-10000).max(10000).optional(),
};
export const DesignLayoutSchema = z.object(layoutShape).strict();
export const DesignResponsiveSchema = z.object({ ...layoutShape, hidden: z.boolean().optional(), fontSize: z.union([z.number().min(6).max(400), id]).optional() }).strict();
const icon = z.enum(DESIGN_ICONS);
export const DesignOverrideSchema = z.object({
  text: text.optional(), label: text.optional(), value: text.optional(), placeholder: text.optional(), helperText: text.optional(),
  assetId: id.optional(), hidden: z.boolean().optional(), color: id.optional(), background: id.optional(), icon: icon.optional(),
  options: z.array(text).max(100).optional(), selected: z.number().int().min(0).max(100).optional(),
}).strict();
export const DesignNodePropsSchema = z.object({
  text: text.optional(), label: text.optional(), placeholder: text.optional(), value: text.optional(), helperText: text.optional(), errorText: text.optional(),
  required: z.boolean().optional(), disabled: z.boolean().optional(), checked: z.boolean().optional(), selected: z.number().int().min(0).max(100).optional(),
  options: z.array(text).max(100).optional(), rows: z.array(z.array(text).max(30)).max(500).optional(),
  values: z.array(z.number().finite().min(0).max(100000)).max(200).optional(), chart: z.enum(['bar', 'line', 'donut']).optional(),
  tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger']).optional(),
  inputType: z.enum(['text', 'email', 'number', 'password', 'search', 'tel', 'date']).optional(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).optional(),
  assetId: id.optional(), alt: text.optional(), fit: z.enum(['cover', 'contain']).optional(),
  crop: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100), zoom: z.number().min(1).max(4) }).strict().optional(),
  icon: icon.optional(), iconPosition: z.enum(['start', 'end']).optional(),
  color: id.optional(), background: id.optional(), borderColor: id.optional(), shadow: id.optional(), font: id.optional(),
  radius: value.optional(), fontSize: z.union([z.number().min(6).max(400), id]).optional(), lineHeight: z.union([z.number().min(0.8).max(3), id]).optional(),
  letterSpacing: z.union([z.number().min(-0.1).max(0.5), id]).optional(), fontWeight: z.union([z.number().int().min(100).max(900).multipleOf(100), id]).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(), opacity: z.number().min(0).max(1).optional(), border: z.boolean().optional(),
  layer: z.union([z.number().int().min(0).max(10000), id]).optional(),
  componentId: id.optional(), variant: id.optional(), componentState: id.optional(), overrides: z.record(id, DesignOverrideSchema).optional(), slot: id.optional(),
  visibleWhen: z.object({ fixture: id, equals: text }).strict().optional(),
  bind: z.object({ fixture: id, field: z.enum(['text', 'value', 'label']) }).strict().optional(),
  state: state.optional(),
}).strict();
export const DesignNodeSchema = z.object({
  id, name: z.string().trim().min(1).max(150), kind: z.enum(DESIGN_NODE_KINDS), children: z.array(id).max(DESIGN_LIMITS.nodes),
  props: DesignNodePropsSchema, layout: DesignLayoutSchema,
  responsive: z.object({ phone: DesignResponsiveSchema.optional(), tablet: DesignResponsiveSchema.optional() }).strict().optional(),
  locked: z.boolean().optional(), hidden: z.boolean().optional(),
}).strict();
const variantMap = z.record(id, z.record(id, DesignNodePropsSchema));
export const DesignComponentSchema = z.object({
  id, name: z.string().trim().min(1).max(150), root: id, description: text, category: id.optional(),
  variants: variantMap, states: variantMap.optional(),
  props: z.array(z.object({ id, label: z.string().trim().min(1).max(80), node: id, field: z.enum(['text', 'label', 'value', 'placeholder', 'helperText', 'assetId', 'hidden']), defaultValue: text.optional() }).strict()).max(50).optional(),
  slots: z.array(id).max(50).optional(), usage: text.optional(), accessibility: text,
  source: z.object({ kitId: z.string().regex(/^kit_[A-Za-z0-9_-]{1,64}$/), version: z.number().int().positive() }).strict().optional(),
}).strict();
export const DesignAssetSchema = z.object({ id, name: z.string().trim().min(1).max(150), hash: z.string().regex(/^[a-f0-9]{64}$/), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), bytes: z.number().int().positive().max(5 * 1024 * 1024), reference: z.boolean() }).strict();
export const DESIGN_ACTIONS = ['navigate', 'back', 'open-overlay', 'close-overlay', 'set-state', 'set-variant', 'set-value', 'toggle', 'show', 'hide', 'validate', 'select-tab'] as const;
export const DesignInteractionSchema = z.object({
  id, source: id, event: z.enum(['click', 'submit', 'change']), action: z.enum(DESIGN_ACTIONS),
  target: id.optional(), value: text.optional(), transition: z.enum(['none', 'fade', 'slide', 'scale']),
  match: text.optional(), when: z.object({ fixture: id, equals: text }).strict().optional(),
}).strict();
export const DesignScreenSchema = z.object({
  id, name: z.string().trim().min(1).max(150), root: id, states: z.array(state).min(1).max(7),
  kind: z.enum(['page', 'dialog', 'drawer']).optional(), description: text.optional(),
  reference: z.object({ assetId: id, opacity: z.number().min(0).max(1) }).strict().optional(),
  flow: z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict().optional(),
}).strict();
const library = z.object({ kitId: z.string().regex(/^kit_[A-Za-z0-9_-]{1,64}$/), version: z.number().int().positive(), name: z.string().trim().min(1).max(150) }).strict();
export const DesignDocumentSchema = z.object({
  schema: z.literal(DESIGN_DOCUMENT_SCHEMA), id, name: z.string().trim().min(1).max(150), version: z.number().int().positive(),
  systemHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  screens: z.array(DesignScreenSchema).min(1).max(DESIGN_LIMITS.screens),
  nodes: z.record(id, DesignNodeSchema), components: z.record(id, DesignComponentSchema), tokens: z.record(id, DesignTokenSchema),
  assets: z.record(id, DesignAssetSchema), fixtures: z.record(id, text), interactions: z.array(DesignInteractionSchema).max(DESIGN_LIMITS.interactions),
  content: DesignContentGuideSchema, settings: DesignSettingsSchema, direction: z.string().max(2000), libraries: z.array(library).max(50),
}).strict();

// ---- migration and structure ----------------------------------------------------------------------

const V1_ICONS: Record<string, string> = { arrow: 'arrow-right' };
/** Documents saved before schema 2 gain the content guide, settings and library list. */
export function migrateDesignDocument(input: unknown): unknown {
  if (!input || typeof input !== 'object' || (input as { schema?: unknown }).schema !== 1) return input;
  const d = structuredClone(input) as Record<string, unknown> & { nodes?: Record<string, { props?: Record<string, unknown> }> };
  for (const n of Object.values(d.nodes ?? {})) if (n?.props && typeof n.props.icon === 'string' && V1_ICONS[n.props.icon]) n.props.icon = V1_ICONS[n.props.icon];
  return { ...d, schema: DESIGN_DOCUMENT_SCHEMA, content: DEFAULT_CONTENT, settings: DEFAULT_SETTINGS, direction: '', libraries: [] };
}

/** Indexes rebuilt from the document: parent of each layer and the screen or component that owns it. */
export interface DesignIndex {
  parent: Map<string, string>;
  owner: Map<string, { screenId?: string; componentId?: string }>;
}
export function indexDesign(d: DesignDocument): DesignIndex {
  const parent = new Map<string, string>(), owner: DesignIndex['owner'] = new Map();
  for (const n of Object.values(d.nodes)) for (const c of n.children) parent.set(c, n.id);
  const mark = (rootId: string, o: { screenId?: string; componentId?: string }) => {
    const stack = [rootId];
    while (stack.length) {
      const key = stack.pop()!;
      if (owner.has(key) || !d.nodes[key]) continue;
      owner.set(key, o);
      stack.push(...d.nodes[key].children);
    }
  };
  for (const s of d.screens) mark(s.root, { screenId: s.id });
  for (const c of Object.values(d.components)) mark(c.root, { componentId: c.id });
  return { parent, owner };
}

/**
 * Structural invariants checked after every change, in linear time: identities match keys, every
 * child exists and has one parent, screens and components own distinct detached roots, and the
 * layer tree (including component instances) has no cycles or extreme nesting.
 */
export function assertDesignStructure(d: DesignDocument): void {
  const nodeCount = Object.keys(d.nodes).length;
  if (nodeCount > DESIGN_LIMITS.nodes) throw new Error(`A document supports at most ${DESIGN_LIMITS.nodes.toLocaleString('en-US')} layers`);
  if (Object.keys(d.components).length > DESIGN_LIMITS.components) throw new Error('Too many components');
  if (Object.keys(d.assets).length > DESIGN_LIMITS.assets) throw new Error('Too many assets');
  if (Object.keys(d.fixtures).length > DESIGN_LIMITS.fixtures) throw new Error('Too many fixtures');
  for (const map of [d.nodes, d.components, d.assets] as Record<string, { id: string }>[]) for (const [key, item] of Object.entries(map)) if (key !== item.id) throw new Error('Object identity does not match its key');
  if (new Set(d.screens.map(s => s.id)).size !== d.screens.length) throw new Error('Screen IDs must be unique');
  if (new Set(d.interactions.map(i => i.id)).size !== d.interactions.length) throw new Error('Interaction IDs must be unique');
  const parents = new Map<string, string>();
  for (const n of Object.values(d.nodes)) for (const child of n.children) {
    if (!Object.hasOwn(d.nodes, child)) throw new Error(`Missing child layer ${child}`);
    if (parents.has(child)) throw new Error('A layer cannot have multiple parents');
    parents.set(child, n.id);
  }
  const roots = [...d.screens.map(s => s.root), ...Object.values(d.components).map(c => c.root)];
  if (new Set(roots).size !== roots.length) throw new Error('Screens and components need distinct roots');
  for (const root of roots) if (!Object.hasOwn(d.nodes, root) || parents.has(root)) throw new Error('Invalid screen or component root');
  // Iterative depth-first walk with colors: 1 = on the current path, 2 = finished.
  const color = new Map<string, 1 | 2>();
  for (const start of Object.keys(d.nodes)) {
    if (color.has(start)) continue;
    const stack: { key: string; depth: number; next: string[] }[] = [];
    const enter = (key: string, depth: number) => {
      if (depth > DESIGN_LIMITS.depth) throw new Error('Cyclic or excessively nested component/layer tree');
      const n = d.nodes[key], c = n.kind === 'instance' && n.props.componentId ? d.components[n.props.componentId] : undefined;
      color.set(key, 1);
      stack.push({ key, depth, next: c ? [...n.children, c.root] : [...n.children] });
    };
    enter(start, 0);
    while (stack.length) {
      const top = stack[stack.length - 1], next = top.next.pop();
      if (next === undefined) { color.set(top.key, 2); stack.pop(); continue; }
      const seen = color.get(next);
      if (seen === 1) throw new Error('Cyclic or excessively nested component/layer tree');
      if (seen === 2) continue;
      enter(next, top.depth + 1);
    }
  }
}

/** Full validation, used when a document enters from outside (imports, kits, agent releases). */
export function parseDesignDocument(input: unknown): DesignDocument {
  const d = DesignDocumentSchema.parse(migrateDesignDocument(input)) as DesignDocument;
  assertDesignStructure(d);
  return d;
}

// ---- operations ---------------------------------------------------------------------------------

const nodePatch = DesignNodeSchema.omit({ id: true, children: true }).partial().strict();
export const DesignOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update-node'), id, patch: nodePatch }).strict(),
  z.object({ type: z.literal('unset-node-property'), id, area: z.enum(['props', 'layout']), key: z.string().max(40) }).strict(),
  z.object({ type: z.literal('insert-node'), node: DesignNodeSchema, parent: id, index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal('insert-tree'), nodes: z.array(DesignNodeSchema).min(1).max(2000), parent: id, index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal('remove-node'), id }).strict(),
  z.object({ type: z.literal('move-node'), id, parent: id, index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('duplicate-node'), id, newId: id }).strict(),
  z.object({ type: z.literal('wrap-nodes'), ids: z.array(id).min(1).max(500), node: DesignNodeSchema }).strict(),
  z.object({ type: z.literal('unwrap-node'), id }).strict(),
  z.object({ type: z.literal('add-screen'), screen: DesignScreenSchema, root: DesignNodeSchema, nodes: z.array(DesignNodeSchema).max(2000).optional(), index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal('update-screen'), id, patch: DesignScreenSchema.omit({ id: true, root: true }).partial().strict() }).strict(),
  z.object({ type: z.literal('remove-screen'), id }).strict(),
  z.object({ type: z.literal('move-screen'), id, index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('set-token'), id, value: DesignTokenSchema.nullable() }).strict(),
  z.object({ type: z.literal('replace-token'), from: id, to: id, remove: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('set-component'), value: DesignComponentSchema }).strict(),
  z.object({ type: z.literal('add-component'), value: DesignComponentSchema, nodes: z.array(DesignNodeSchema).min(1).max(2000) }).strict(),
  z.object({ type: z.literal('replace-component'), value: DesignComponentSchema, nodes: z.array(DesignNodeSchema).min(1).max(2000) }).strict(),
  z.object({ type: z.literal('remove-component'), id, detach: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('make-component'), nodeId: id, id, name: z.string().trim().min(1).max(150), replace: z.array(id).max(200).optional() }).strict(),
  z.object({ type: z.literal('detach-instance'), id }).strict(),
  z.object({ type: z.literal('set-asset'), value: DesignAssetSchema }).strict(),
  z.object({ type: z.literal('remove-asset'), id }).strict(),
  z.object({ type: z.literal('set-interactions'), value: z.array(DesignInteractionSchema).max(DESIGN_LIMITS.interactions) }).strict(),
  z.object({ type: z.literal('upsert-interaction'), value: DesignInteractionSchema }).strict(),
  z.object({ type: z.literal('remove-interaction'), id }).strict(),
  z.object({ type: z.literal('set-fixture'), id, value: text.nullable() }).strict(),
  z.object({ type: z.literal('set-content'), value: DesignContentGuideSchema }).strict(),
  z.object({ type: z.literal('set-settings'), value: DesignSettingsSchema }).strict(),
  z.object({ type: z.literal('set-direction'), value: z.string().max(2000) }).strict(),
  z.object({ type: z.literal('rename'), name: z.string().trim().min(1).max(150) }).strict(),
  z.object({ type: z.literal('set-libraries'), value: z.array(library).max(50) }).strict(),
]);
export type DesignOperation = z.infer<typeof DesignOperationSchema>;
export const DesignOperationsSchema = z.array(DesignOperationSchema).min(1).max(DESIGN_LIMITS.operations);

/** Style fields that hold token references, by where they live. */
const PROP_TOKEN_FIELDS = ['color', 'background', 'borderColor', 'shadow', 'font', 'radius', 'fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'layer'] as const;
const LAYOUT_TOKEN_FIELDS = ['gap', 'padding', 'paddingX', 'paddingY', 'maxWidth'] as const;
const RESPONSIVE_TOKEN_FIELDS = [...LAYOUT_TOKEN_FIELDS, 'fontSize'] as const;
/** Which token types each style field accepts. */
export const TOKEN_FIELD_TYPES: Record<string, DesignTokenType[]> = {
  color: ['color'], background: ['color'], borderColor: ['color'], shadow: ['shadow'], font: ['font'],
  radius: ['dimension'], fontSize: ['dimension'], lineHeight: ['lineHeight', 'number'], letterSpacing: ['letterSpacing'], fontWeight: ['fontWeight'], layer: ['layer'],
  gap: ['dimension'], padding: ['dimension'], paddingX: ['dimension'], paddingY: ['dimension'], maxWidth: ['dimension'],
};

/** Every token reference held by a set of props or a layout. */
function propTokenRefs(p: DesignNodeProps | undefined, out: { field: string; token: string }[]) {
  if (!p) return;
  for (const f of PROP_TOKEN_FIELDS) { const v = p[f]; if (typeof v === 'string') out.push({ field: f, token: v }); }
  for (const o of Object.values(p.overrides ?? {})) for (const f of ['color', 'background'] as const) if (o[f]) out.push({ field: f, token: o[f]! });
}
function layoutTokenRefs(l: object | undefined, out: { field: string; token: string }[]) {
  if (!l) return;
  for (const f of [...LAYOUT_TOKEN_FIELDS, 'fontSize']) { const v = (l as Record<string, unknown>)[f]; if (typeof v === 'string') out.push({ field: f, token: v }); }
}
export function nodeTokenRefs(n: DesignNode): { field: string; token: string }[] {
  const out: { field: string; token: string }[] = [];
  propTokenRefs(n.props, out); layoutTokenRefs(n.layout, out); layoutTokenRefs(n.responsive?.phone, out); layoutTokenRefs(n.responsive?.tablet, out);
  return out;
}

/** Shallow copies of every top-level collection; untouched entries keep their identity. */
function draftOf(d: DesignDocument): DesignDocument {
  return { ...d, screens: [...d.screens], nodes: { ...d.nodes }, components: { ...d.components }, tokens: { ...d.tokens }, assets: { ...d.assets }, fixtures: { ...d.fixtures }, interactions: [...d.interactions], libraries: [...d.libraries] };
}

export interface ApplyOptions {
  /** Validate the whole document with the schema instead of only what changed. */
  full?: boolean;
  /** Keep the version unchanged (history replays set it themselves). */
  keepVersion?: boolean;
}

/**
 * Apply a batch atomically. The input document is never mutated; a failure leaves it unchanged.
 * Unresolved content references (tokens, assets, variants…) stay allowed and appear as findings.
 */
export function applyDesignOperations(document: DesignDocument, input: unknown, o: ApplyOptions = {}): DesignDocument {
  const operations = DesignOperationsSchema.parse(input) as DesignOperation[];
  const d = draftOf(document);
  const fresh = new Set<string>();
  const get = (key: string) => { if (!Object.hasOwn(d.nodes, key)) throw new Error(`Layer ${key} no longer exists`); return d.nodes[key]; };
  /** A private copy of a layer for this transaction. */
  const edit = (key: string): DesignNode => {
    const n = get(key);
    if (!fresh.has(key)) { d.nodes[key] = { ...n, children: [...n.children], props: { ...n.props }, layout: { ...n.layout }, ...(n.responsive ? { responsive: { ...n.responsive } } : {}) }; fresh.add(key); }
    return d.nodes[key];
  };
  const put = (n: DesignNode) => { d.nodes[n.id] = n; fresh.add(n.id); };
  let parentCache: Map<string, string> | null = null;
  const parents = () => parentCache ??= new Map(Object.values(d.nodes).flatMap(n => n.children.map(c => [c, n.id] as const)));
  const structural = () => { parentCache = null; };
  const assertEditable = (key: string) => {
    const map = parents();
    for (let cur: string | undefined = key; cur; cur = map.get(cur)) if (get(cur).locked) throw new Error('Unlock the layer before editing');
  };
  const subtree = (key: string): string[] => { const out: string[] = [], stack = [key]; while (stack.length) { const k = stack.pop()!; out.push(k); stack.push(...get(k).children); } return out; };
  /** Remove a subtree; interactions that start inside it go too unless `keep` still has those layers. */
  const removeTree = (key: string, keep?: Set<string>) => {
    const gone = new Set(subtree(key));
    for (const k of gone) delete d.nodes[k];
    if (d.interactions.some(i => gone.has(i.source) && !keep?.has(i.source))) d.interactions = d.interactions.filter(i => !gone.has(i.source) || keep?.has(i.source));
    structural();
  };
  const unique = (key: string) => { if (Object.hasOwn(d.nodes, key)) throw new Error(`Layer ID ${key} already exists`); };
  const insertChild = (parent: string, child: string, index?: number) => {
    const p = edit(parent);
    p.children.splice(Math.min(index ?? p.children.length, p.children.length), 0, child);
    structural();
  };
  const detachFromParent = (key: string) => {
    const p = parents().get(key);
    if (!p) throw new Error('Screen and component roots cannot be moved or removed');
    const e = edit(p); e.children = e.children.filter(x => x !== key); structural();
    return p;
  };
  /** Copy a subtree under new ids (prefix-original), applying props from `extra` by original id. */
  const cloneTree = (key: string, prefix: string, extra: (orig: string) => Partial<DesignNode> = () => ({})): string => {
    const old = get(key), next = `${prefix}-${key}`.slice(0, 96);
    unique(next);
    const copy: DesignNode = { ...structuredClone(old), id: next, children: [], ...extra(key) };
    put(copy);
    copy.children = old.children.map(c => cloneTree(c, prefix, extra));
    return next;
  };
  const insertTree = (nodes: DesignNode[]) => {
    const ids = new Set(nodes.map(n => n.id));
    if (ids.size !== nodes.length) throw new Error('Duplicate layer IDs in inserted tree');
    for (const n of nodes) { unique(n.id); for (const c of n.children) if (!ids.has(c)) throw new Error('Inserted layers may only contain each other'); }
    for (const n of nodes) put(structuredClone(n));
    structural();
  };
  const instancesOf = (componentId: string) => Object.values(d.nodes).filter(n => n.kind === 'instance' && n.props.componentId === componentId);
  const detach = (instanceId: string) => {
    const inst = get(instanceId), c = d.components[inst.props.componentId ?? ''];
    if (inst.kind !== 'instance' || !c) throw new Error('Choose a component instance to detach');
    const variant = { ...(c.variants[inst.props.variant ?? ''] ?? {}), ...(c.states?.[inst.props.componentState ?? ''] ?? {}) };
    const extra = (orig: string): Partial<DesignNode> => {
      const base = get(orig), o = inst.props.overrides?.[orig];
      const props: DesignNodeProps = { ...base.props, ...variant[orig] };
      if (o) for (const [k, v] of Object.entries(o)) if (k !== 'hidden') (props as Record<string, unknown>)[k] = v;
      return { props, ...(o?.hidden ? { hidden: true } : {}) };
    };
    const root = cloneTree(c.root, instanceId, extra);
    const copy = edit(root);
    const fills = inst.children.filter(ch => get(ch).props.slot);
    // Slot fills replace the default content of their slot copies; other children are discarded.
    for (const fill of fills) {
      const slot = `${instanceId}-${get(fill).props.slot}`.slice(0, 96);
      if (!Object.hasOwn(d.nodes, slot) || get(slot).kind !== 'slot') continue;
      const s = edit(slot);
      if (!s.children.some(x => fills.includes(x))) { for (const x of s.children) removeTree(x); s.children = []; }
      const e = edit(fill); delete e.props.slot;
      s.children.push(fill);
      structural();
    }
    for (const ch of inst.children) if (!fills.includes(ch)) removeTree(ch);
    const target = edit(instanceId);
    d.nodes[instanceId] = { ...target, kind: copy.kind, props: copy.props, children: copy.children, layout: { ...copy.layout, ...target.layout } };
    delete d.nodes[root];
    structural();
  };
  const rewriteTokens = (from: string, to: string) => {
    const swap = (o: Record<string, unknown> | undefined, fields: readonly string[]) => { if (!o) return o; let changed = false; const c = { ...o }; for (const f of fields) if (c[f] === from) { c[f] = to; changed = true; } return changed ? c : o; };
    for (const n of Object.values(d.nodes)) {
      if (!nodeTokenRefs(n).some(r => r.token === from)) continue;
      const e = edit(n.id);
      e.props = swap(e.props as Record<string, unknown>, PROP_TOKEN_FIELDS) as DesignNodeProps;
      if (e.props.overrides) e.props.overrides = Object.fromEntries(Object.entries(e.props.overrides).map(([k, v]) => [k, swap(v as Record<string, unknown>, ['color', 'background']) as typeof v]));
      e.layout = swap(e.layout as Record<string, unknown>, LAYOUT_TOKEN_FIELDS) as DesignNode['layout'];
      if (e.responsive) e.responsive = { phone: swap(e.responsive.phone as Record<string, unknown>, RESPONSIVE_TOKEN_FIELDS), tablet: swap(e.responsive.tablet as Record<string, unknown>, RESPONSIVE_TOKEN_FIELDS) } as DesignNode['responsive'];
    }
    for (const c of Object.values(d.components)) {
      const fix = (m?: Record<string, Record<string, DesignNodeProps>>) => m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([n, p]) => [n, swap(p as Record<string, unknown>, PROP_TOKEN_FIELDS) as DesignNodeProps]))]));
      const json = JSON.stringify([c.variants, c.states]);
      if (json.includes(`"${from}"`)) d.components[c.id] = { ...c, variants: fix(c.variants)!, ...(c.states ? { states: fix(c.states) } : {}) };
    }
    for (const [k, t] of Object.entries(d.tokens)) if (t.alias === from || t.darkAlias === from) d.tokens[k] = { ...t, ...(t.alias === from ? { alias: to } : {}), ...(t.darkAlias === from ? { darkAlias: to } : {}) };
  };

  for (const op of operations) {
    switch (op.type) {
      case 'update-node': {
        const n = get(op.id);
        const onlyUnlock = Object.keys(op.patch).length === 1 && op.patch.locked === false;
        if (!onlyUnlock) assertEditable(op.id);
        if (op.patch.kind && op.patch.kind !== n.kind && (n.kind === 'instance' || op.patch.kind === 'instance')) throw new Error('Use components to create or detach instances');
        const e = edit(op.id);
        const { props, layout, responsive, ...rest } = op.patch;
        Object.assign(e, rest);
        if (props) e.props = { ...e.props, ...props };
        if (layout) e.layout = { ...e.layout, ...layout };
        if (responsive) e.responsive = { ...e.responsive, ...responsive };
        break;
      }
      case 'unset-node-property': {
        assertEditable(op.id);
        const shape: Record<string, unknown> = op.area === 'props' ? DesignNodePropsSchema.shape : DesignLayoutSchema.shape;
        if (!Object.hasOwn(shape, op.key)) throw new Error('Unknown property');
        const e = edit(op.id);
        const area = { ...e[op.area] } as Record<string, unknown>;
        delete area[op.key];
        (e as unknown as Record<string, unknown>)[op.area] = area;
        break;
      }
      case 'insert-node':
        assertEditable(op.parent); unique(op.node.id); put(structuredClone(op.node)); insertChild(op.parent, op.node.id, op.index);
        break;
      case 'insert-tree':
        assertEditable(op.parent); insertTree(op.nodes); insertChild(op.parent, op.nodes[0].id, op.index);
        if (parents().get(op.nodes[0].id) !== op.parent || op.nodes.slice(1).some(n => !parents().has(n.id))) throw new Error('Inserted layers must form one tree');
        break;
      case 'remove-node':
        assertEditable(op.id); detachFromParent(op.id); removeTree(op.id);
        break;
      case 'move-node': {
        assertEditable(op.id); assertEditable(op.parent);
        const from = parents().get(op.id), index = from === op.parent ? get(from).children.indexOf(op.id) : -1;
        detachFromParent(op.id);
        insertChild(op.parent, op.id, index >= 0 && index < op.index ? op.index - 1 : op.index);
        break;
      }
      case 'duplicate-node': {
        const p = parents().get(op.id);
        if (!p) throw new Error('Select a layer inside a screen');
        assertEditable(p);
        const copy = cloneTree(op.id, op.newId);
        const sources = new Set(subtree(op.id));
        const copies = d.interactions.filter(i => sources.has(i.source)).map(i => ({ ...i, id: `${op.newId}-${i.id}`.slice(0, 96), source: `${op.newId}-${i.source}`.slice(0, 96) }));
        if (copies.length) d.interactions = [...d.interactions, ...copies];
        insertChild(p, copy, get(p).children.indexOf(op.id) + 1);
        break;
      }
      case 'wrap-nodes': {
        const map = parents(), parent = map.get(op.ids[0]);
        if (!parent || op.ids.some(x => map.get(x) !== parent)) throw new Error('Select layers with the same parent to group them');
        assertEditable(parent);
        const siblings = get(parent).children, ordered = siblings.filter(x => op.ids.includes(x)), at = siblings.indexOf(ordered[0]);
        unique(op.node.id);
        put({ ...structuredClone(op.node), children: ordered });
        const e = edit(parent); e.children = e.children.filter(x => !ordered.includes(x)); e.children.splice(at, 0, op.node.id);
        structural();
        break;
      }
      case 'unwrap-node': {
        assertEditable(op.id);
        const n = get(op.id);
        if (n.kind === 'instance') throw new Error('Detach the instance instead');
        const p = parents().get(op.id);
        if (!p) throw new Error('Screen and component roots cannot be ungrouped');
        const e = edit(p), at = e.children.indexOf(op.id);
        e.children.splice(at, 1, ...n.children);
        delete d.nodes[op.id];
        structural();
        break;
      }
      case 'add-screen': {
        if (d.screens.some(s => s.id === op.screen.id)) throw new Error('A screen with that ID already exists');
        if (op.screen.root !== op.root.id) throw new Error('The screen root must be the provided layer');
        insertTree([op.root, ...(op.nodes ?? [])]);
        if ((op.nodes ?? []).some(n => !parents().has(n.id))) throw new Error('Screen layers must form one tree under its root');
        d.screens.splice(Math.min(op.index ?? d.screens.length, d.screens.length), 0, op.screen);
        break;
      }
      case 'update-screen': {
        const i = d.screens.findIndex(s => s.id === op.id);
        if (i < 0) throw new Error('Unknown screen');
        d.screens[i] = { ...d.screens[i], ...op.patch };
        break;
      }
      case 'remove-screen': {
        const s = d.screens.find(x => x.id === op.id);
        if (!s) throw new Error('Unknown screen');
        if (d.screens.length === 1) throw new Error('A design needs at least one screen');
        d.screens = d.screens.filter(x => x.id !== op.id);
        removeTree(s.root);
        break;
      }
      case 'move-screen': {
        const i = d.screens.findIndex(s => s.id === op.id);
        if (i < 0) throw new Error('Unknown screen');
        const [s] = d.screens.splice(i, 1);
        d.screens.splice(Math.min(op.index, d.screens.length), 0, s);
        break;
      }
      case 'set-token':
        if (op.value) d.tokens[op.id] = op.value as DesignTokenValue; else delete d.tokens[op.id];
        break;
      case 'replace-token': {
        const from = d.tokens[op.from], to = d.tokens[op.to];
        if (!to) throw new Error('Choose an existing replacement token');
        if (from && from.type !== to.type) throw new Error(`Replace a ${from.type} token with another ${from.type} token`);
        if (op.from === op.to) throw new Error('Choose a different replacement token');
        rewriteTokens(op.from, op.to);
        if (op.remove) delete d.tokens[op.from];
        break;
      }
      case 'set-component': {
        const c = op.value as DesignComponent;
        if (!Object.hasOwn(d.nodes, c.root)) throw new Error('The component root layer does not exist');
        d.components[c.id] = c;
        break;
      }
      case 'add-component': {
        const c = op.value as DesignComponent;
        if (d.components[c.id]) throw new Error(`A component called ${c.name} already exists`);
        if (op.nodes[0].id !== c.root) throw new Error('The first layer must be the component root');
        insertTree(op.nodes);
        if (op.nodes.slice(1).some(n => !parents().has(n.id))) throw new Error('Component layers must form one tree under its root');
        d.components[c.id] = c;
        break;
      }
      case 'replace-component': {
        const c = op.value as DesignComponent, old = d.components[c.id];
        if (!old) throw new Error('Unknown component');
        if (op.nodes[0].id !== c.root) throw new Error('The first layer must be the component root');
        removeTree(old.root, new Set(op.nodes.map(n => n.id)));
        insertTree(op.nodes);
        if (op.nodes.slice(1).some(n => !parents().has(n.id))) throw new Error('Component layers must form one tree under its root');
        d.components[c.id] = c;
        break;
      }
      case 'remove-component': {
        const c = d.components[op.id];
        if (!c) throw new Error('Unknown component');
        const users = instancesOf(op.id);
        if (users.length && !op.detach) throw new Error(`${users.length} instance${users.length === 1 ? '' : 's'} still use${users.length === 1 ? 's' : ''} ${c.name}. Detach or replace them first.`);
        for (const u of users) detach(u.id);
        delete d.components[op.id];
        removeTree(c.root);
        break;
      }
      case 'make-component': {
        assertEditable(op.nodeId);
        if (d.components[op.id]) throw new Error('Component ID already exists');
        if (!parents().has(op.nodeId)) throw new Error('Choose a layer inside a screen');
        if (get(op.nodeId).kind === 'instance') throw new Error('This layer is already a component instance');
        const shape = (key: string): string => { const n = get(key); return `${n.kind}(${n.children.map(shape).join(',')})`; };
        const order = (key: string): string[] => [key, ...get(key).children.flatMap(order)];
        const copyOf = (orig: string) => `${op.id}-${orig}`.slice(0, 96);
        const root = cloneTree(op.nodeId, op.id);
        d.components[op.id] = { id: op.id, name: op.name, root, description: '', variants: {}, accessibility: '' };
        const sourceOrder = order(op.nodeId);
        // Behavior on inner layers becomes component behavior; on replaced copies it moves to the instance.
        const retarget = new Map<string, string>(sourceOrder.slice(1).map(k => [k, copyOf(k)]));
        const toInstance = (key: string, overrides?: Record<string, DesignOverride>) => {
          const n = get(key);
          for (const inner of order(key).slice(1)) if (!retarget.has(inner)) retarget.set(inner, key);
          d.interactions = d.interactions.map(i => retarget.has(i.source) ? { ...i, source: retarget.get(i.source)! } : i);
          for (const c of n.children) removeTree(c);
          d.nodes[key] = { ...n, kind: 'instance', children: [], props: { componentId: op.id, ...(overrides && Object.keys(overrides).length ? { overrides } : {}) }, layout: n.layout };
          fresh.add(key);
        };
        for (const other of op.replace ?? []) {
          if (other === op.nodeId) continue;
          assertEditable(other);
          if (shape(other) !== shape(op.nodeId)) throw new Error(`${get(other).name} has a different structure, so it can’t become an instance of ${op.name}`);
          const overrides: Record<string, DesignOverride> = {};
          order(other).forEach((key, i) => {
            const mine = get(key).props, theirs = get(sourceOrder[i]).props, o: DesignOverride = {};
            for (const f of ['text', 'label', 'value', 'placeholder', 'helperText', 'assetId'] as const) if (mine[f] !== undefined && mine[f] !== theirs[f]) o[f] = mine[f];
            if (Object.keys(o).length) overrides[copyOf(sourceOrder[i])] = o;
          });
          toInstance(other, overrides);
        }
        toInstance(op.nodeId);
        break;
      }
      case 'detach-instance':
        assertEditable(op.id); detach(op.id);
        break;
      case 'set-asset':
        d.assets[op.value.id] = op.value as DesignAsset;
        break;
      case 'remove-asset': {
        const users = Object.values(d.nodes).filter(n => n.props.assetId === op.id || Object.values(n.props.overrides ?? {}).some(o => o.assetId === op.id));
        if (users.length || d.screens.some(s => s.reference?.assetId === op.id)) throw new Error(`This image is still used by ${users.length || 1} layer${users.length > 1 ? 's' : ''}. Replace it first.`);
        delete d.assets[op.id];
        break;
      }
      case 'set-interactions':
        d.interactions = op.value as DesignInteraction[];
        break;
      case 'upsert-interaction': {
        const i = d.interactions.findIndex(x => x.id === op.value.id);
        if (i >= 0) d.interactions[i] = op.value as DesignInteraction; else d.interactions.push(op.value as DesignInteraction);
        break;
      }
      case 'remove-interaction':
        d.interactions = d.interactions.filter(x => x.id !== op.id);
        break;
      case 'set-fixture':
        if (op.value === null) delete d.fixtures[op.id]; else d.fixtures[op.id] = op.value;
        break;
      case 'set-content': d.content = op.value; break;
      case 'set-settings': d.settings = op.value as DesignDocument['settings']; break;
      case 'set-direction': d.direction = op.value; break;
      case 'rename': d.name = op.name; break;
      case 'set-libraries': d.libraries = op.value; break;
    }
  }
  if (!o.keepVersion) d.version = document.version + 1;
  if (o.full) return parseDesignDocument(d);
  validateChanged(document, d);
  return d;
}

/** Schema-check only entries whose identity changed, then the linear structural check. */
function validateChanged(before: DesignDocument, after: DesignDocument) {
  for (const [key, n] of Object.entries(after.nodes)) if (before.nodes[key] !== n) DesignNodeSchema.parse(n);
  for (const [key, c] of Object.entries(after.components)) if (before.components[key] !== c) DesignComponentSchema.parse(c);
  for (const [key, t] of Object.entries(after.tokens)) if (before.tokens[key] !== t) DesignTokenSchema.parse(t);
  for (const [key, a] of Object.entries(after.assets)) if (before.assets[key] !== a) DesignAssetSchema.parse(a);
  if (before.screens !== after.screens) z.array(DesignScreenSchema).min(1).max(DESIGN_LIMITS.screens).parse(after.screens);
  if (before.interactions !== after.interactions && after.interactions.length > DESIGN_LIMITS.interactions) throw new Error('Too many interactions');
  assertDesignStructure(after);
}

// ---- history patches ----------------------------------------------------------------------------

type MapKey = 'nodes' | 'components' | 'tokens' | 'assets' | 'fixtures';
type ValueKey = 'screens' | 'interactions' | 'content' | 'settings' | 'direction' | 'name' | 'libraries' | 'systemHash';
const MAP_KEYS: MapKey[] = ['nodes', 'components', 'tokens', 'assets', 'fixtures'];
const VALUE_KEYS: ValueKey[] = ['screens', 'interactions', 'content', 'settings', 'direction', 'name', 'libraries', 'systemHash'];
/** The parts of a document a change touched. `null` in a map removes that entry. */
export type DesignPatch = { [K in MapKey]?: Record<string, DesignDocument[K][string] | null> } & { [K in ValueKey]?: DesignDocument[K] };

/** Forward and backward patches between two versions, comparing entries by identity then content. */
export function diffDesignDocuments(a: DesignDocument, b: DesignDocument): { forward: DesignPatch; backward: DesignPatch } {
  const forward: DesignPatch = {}, backward: DesignPatch = {};
  const same = (x: unknown, y: unknown) => x === y || JSON.stringify(x) === JSON.stringify(y);
  for (const key of MAP_KEYS) {
    const before = a[key] as Record<string, unknown>, after = b[key] as Record<string, unknown>;
    const f: Record<string, unknown> = {}, r: Record<string, unknown> = {};
    for (const k of Object.keys(after)) if (!Object.hasOwn(before, k) || !same(before[k], after[k])) { f[k] = after[k]; r[k] = Object.hasOwn(before, k) ? before[k] : null; }
    for (const k of Object.keys(before)) if (!Object.hasOwn(after, k)) { f[k] = null; r[k] = before[k]; }
    if (Object.keys(f).length) { (forward as Record<string, unknown>)[key] = f; (backward as Record<string, unknown>)[key] = r; }
  }
  for (const key of VALUE_KEYS) if (!same(a[key], b[key])) { (forward as Record<string, unknown>)[key] = b[key]; (backward as Record<string, unknown>)[key] = a[key]; }
  return { forward, backward };
}

/** Apply a history patch and check the result. */
export function applyDesignPatch(d: DesignDocument, patch: DesignPatch, version: number): DesignDocument {
  const next = draftOf(d) as DesignDocument & Record<string, unknown>;
  for (const key of MAP_KEYS) {
    const changes = patch[key] as Record<string, unknown> | undefined;
    if (!changes) continue;
    const map = next[key] as Record<string, unknown>;
    for (const [k, v] of Object.entries(changes)) if (v === null) delete map[k]; else map[k] = v;
  }
  for (const key of VALUE_KEYS) if (Object.hasOwn(patch, key)) next[key] = patch[key] as never;
  next.version = version;
  validateChanged(d, next);
  return next;
}

export function patchIsEmpty(p: DesignPatch): boolean { return Object.keys(p).length === 0; }

// ---- traversal, findings and where-used ---------------------------------------------------------------

export interface WalkContext {
  /** The instance this layer is drawn inside, if any. */
  instance?: string;
  /** Effective props after variants, states and overrides. */
  props: DesignNodeProps;
  hidden: boolean;
  color?: string;
  background?: string;
  depth: number;
}

/**
 * Visit every layer as it is drawn on a screen: instances expand into their component with variant,
 * state and override props applied, and slot fills render inside their slots.
 */
export function walkScreen(d: DesignDocument, rootId: string, visit: (n: DesignNode, ctx: WalkContext) => void) {
  const go = (key: string, inherited: { color?: string; background?: string }, depth: number, inst?: { id: string; layer: Record<string, DesignNodeProps>; overrides: NonNullable<DesignNodeProps['overrides']>; fills: Map<string, string[]> }) => {
    const n = d.nodes[key];
    if (!n || depth > DESIGN_LIMITS.depth) return;
    const o = inst?.overrides[key];
    const props: DesignNodeProps = { ...n.props, ...inst?.layer[key], ...(o ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'hidden')) : {}) };
    const clear = props.background !== undefined && /^#[0-9a-fA-F]{6}00$/.test(String(resolveToken(d.tokens, props.background) ?? ''));
    const ctx: WalkContext = { instance: inst?.id, props, hidden: !!(n.hidden || o?.hidden), color: props.color ?? inherited.color, background: clear ? inherited.background : props.background ?? inherited.background, depth };
    visit(n, ctx);
    const next = { color: ctx.color, background: ctx.background };
    if (n.kind === 'instance') {
      const c = d.components[props.componentId ?? ''];
      if (!c) return;
      const layer: Record<string, DesignNodeProps> = {};
      for (const m of [c.variants[props.variant ?? ''], c.states?.[props.componentState ?? '']]) if (m) for (const [k, v] of Object.entries(m)) layer[k] = { ...layer[k], ...v };
      const fills = new Map<string, string[]>();
      for (const ch of n.children) { const slot = d.nodes[ch]?.props.slot; if (slot) fills.set(slot, [...(fills.get(slot) ?? []), ch]); }
      go(c.root, next, depth + 1, { id: n.id, layer, overrides: props.overrides ?? {}, fills });
      for (const list of fills.values()) for (const ch of list) go(ch, next, depth + 1, inst);
      return;
    }
    const filled = n.kind === 'slot' ? inst?.fills.get(key) : undefined;
    if (!filled) for (const ch of n.children) go(ch, next, depth + 1, inst);
  };
  go(rootId, {}, 0);
}

const LARGE_TEXT = (p: DesignNodeProps, d: DesignDocument) => {
  const size = typeof p.fontSize === 'string' ? Number(resolveToken(d.tokens, p.fontSize)) : p.fontSize ?? 16;
  const weight = typeof p.fontWeight === 'string' ? Number(resolveToken(d.tokens, p.fontWeight)) : p.fontWeight ?? 400;
  return size >= 24 || (size >= 18.66 && weight >= 700);
};
const TEXT_KINDS: readonly DesignNodeKind[] = ['text', 'button', 'link', 'badge', 'list', 'navigation', 'tabs', 'menu', 'pagination', 'table'];

/** Accessible name a control will expose, or null. */
export function accessibleName(n: DesignNode, p: DesignNodeProps = n.props): string | null {
  if (n.kind === 'button' || n.kind === 'link') return (p.text || p.label || '').trim() || null;
  if (n.kind === 'menu') return (p.label || p.text || '').trim() || null;
  return (p.label ?? '').trim() || null;
}

/**
 * Deterministic checks a person can repair: references, accessible names, contrast in both themes,
 * component use, prototype interactions and data states. Findings never block saving a draft;
 * errors block releases.
 */
export function designDocumentFindings(d: DesignDocument): DesignDocumentFinding[] {
  const out: DesignDocumentFinding[] = [];
  const { owner } = indexDesign(d);
  const add = (rule: string, message: string, at: { nodeId?: string; screenId?: string; componentId?: string; tokenId?: string } = {}, severity: 'error' | 'warning' = 'error') => {
    const where = at.nodeId ? owner.get(at.nodeId) : undefined;
    out.push({ id: `${rule}:${at.nodeId ?? at.tokenId ?? at.componentId ?? at.screenId ?? out.length}:${out.length}`, rule, severity, message, ...at, ...(where && !at.screenId && !at.componentId ? where : {}) });
  };
  for (const key of Object.keys(d.tokens)) {
    const problem = tokenAliasProblem(d.tokens, key);
    if (problem) add('token-alias', `Token “${key}”: ${problem}`, { tokenId: key });
  }
  const tokenOk = (ref: string, field: string) => { const t = d.tokens[ref]; return !!t && (TOKEN_FIELD_TYPES[field] ?? []).includes(t.type); };
  for (const n of Object.values(d.nodes)) {
    for (const r of nodeTokenRefs(n)) if (!tokenOk(r.token, r.field)) add('token-reference', `${n.name} uses “${r.token}” for ${r.field}, which isn’t a ${(TOKEN_FIELD_TYPES[r.field] ?? ['valid']).join(' or ')} token in this design`, { nodeId: n.id, tokenId: r.token });
    if (n.props.assetId && !d.assets[n.props.assetId]) add('asset-missing', `${n.name} uses an image that is no longer in this design`, { nodeId: n.id });
    if (n.kind === 'image' && n.props.alt === undefined) add('image-description', `${n.name} needs a description, or mark it as decorative`, { nodeId: n.id });
    for (const ref of [n.props.visibleWhen?.fixture, n.props.bind?.fixture]) if (ref && !Object.hasOwn(d.fixtures, ref)) add('fixture-missing', `${n.name} refers to sample data “${ref}” that doesn’t exist`, { nodeId: n.id });
    if (n.kind === 'instance') {
      const c = d.components[n.props.componentId ?? ''];
      if (!c) { add('component-missing', `${n.name} refers to a missing component`, { nodeId: n.id }); continue; }
      const inside = new Set<string>(); const stack = [c.root];
      while (stack.length) { const k = stack.pop()!; if (inside.has(k) || !d.nodes[k]) continue; inside.add(k); stack.push(...d.nodes[k].children); }
      if (n.props.variant && !c.variants[n.props.variant]) add('variant-missing', `${n.name} uses variant “${n.props.variant}”, which ${c.name} no longer has`, { nodeId: n.id, componentId: c.id });
      if (n.props.componentState && !c.states?.[n.props.componentState]) add('state-missing', `${n.name} uses state “${n.props.componentState}”, which ${c.name} doesn’t define`, { nodeId: n.id, componentId: c.id });
      for (const key of Object.keys(n.props.overrides ?? {})) if (!inside.has(key)) add('override-invalid', `${n.name} overrides a layer that ${c.name} no longer contains`, { nodeId: n.id, componentId: c.id });
      for (const ch of n.children) { const slot = d.nodes[ch]?.props.slot; if (slot && !(c.slots ?? []).includes(slot)) add('slot-invalid', `${d.nodes[ch].name} fills a slot ${c.name} doesn’t have`, { nodeId: ch, componentId: c.id }); }
    }
  }
  for (const c of Object.values(d.components)) {
    const inside = new Set<string>(); const stack = [c.root];
    while (stack.length) { const k = stack.pop()!; if (inside.has(k) || !d.nodes[k]) continue; inside.add(k); stack.push(...d.nodes[k].children); }
    for (const [label, map] of [['variant', c.variants], ['state', c.states ?? {}]] as const) for (const [name, layers] of Object.entries(map)) for (const key of Object.keys(layers)) if (!inside.has(key)) add('component-layer', `${c.name} ${label} “${name}” changes a layer it doesn’t contain`, { componentId: c.id });
    for (const p of c.props ?? []) if (!inside.has(p.node)) add('component-prop', `${c.name} property “${p.label}” points to a missing layer`, { componentId: c.id });
    for (const s of c.slots ?? []) if (!inside.has(s) || d.nodes[s]?.kind !== 'slot') add('component-slot', `${c.name} lists a slot that isn’t a slot layer inside it`, { componentId: c.id });
  }
  // Names and contrast are measured as drawn, so variants, overrides and inherited colors count.
  // Component definitions are checked first; an instance repeats a finding only when it differs.
  const reported = new Set<string>();
  const drawn = (rootId: string, at: { screenId?: string; componentId?: string }) => walkScreen(d, rootId, (n, ctx) => {
    if (ctx.hidden) return;
    const nodeId = ctx.instance ?? n.id;
    const report = (rule: string, signature: string, message: string) => {
      const key = `${rule}|${n.id}|${signature}`;
      if (reported.has(key)) return;
      reported.add(key);
      add(rule, message, { nodeId, ...at });
    };
    if (CONTROL_KINDS.includes(n.kind) && !accessibleName(n, ctx.props)) report('accessible-name', '', `${n.name} needs a visible label or accessible name`);
    if (TEXT_KINDS.includes(n.kind) && ctx.color && ctx.background && d.tokens[ctx.color]?.type === 'color' && d.tokens[ctx.background]?.type === 'color') for (const dark of [false, true]) {
      const fg = resolveToken(d.tokens, ctx.color, dark), bg = resolveToken(d.tokens, ctx.background, dark);
      if (typeof fg !== 'string' || typeof bg !== 'string') continue;
      const need = LARGE_TEXT(ctx.props, d) ? 3 : 4.5, ratio = contrastRatio(fg, bg);
      if (ratio < need) report('contrast', `${fg}|${bg}|${need}`, `${n.name} has ${ratio.toFixed(2)}:1 ${dark ? 'dark' : 'light'} theme contrast; it needs ${need}:1`);
    }
  });
  for (const c of Object.values(d.components)) drawn(c.root, { componentId: c.id });
  for (const s of d.screens) drawn(s.root, { screenId: s.id });

  const screenIds = new Set(d.screens.map(s => s.id));
  for (const i of d.interactions) {
    const src = d.nodes[i.source], at = { nodeId: src ? i.source : undefined };
    if (!src) { add('interaction-source', 'An interaction starts from a layer that no longer exists'); continue; }
    const target = i.target ?? '';
    if ((i.action === 'navigate' || i.action === 'open-overlay') && !screenIds.has(target)) add('interaction-target', `${src.name}: choose an existing screen to ${i.action === 'navigate' ? 'go to' : 'open'}`, at);
    if (['toggle', 'show', 'hide', 'set-state'].includes(i.action) && !d.nodes[target]) add('interaction-target', `${src.name}: choose an existing layer for “${i.action}”`, at);
    if (i.action === 'set-state' && !STATES.includes(i.value as DesignContentState)) add('interaction-value', `${src.name}: choose a supported content state`, at);
    if (i.action === 'set-variant') {
      const t = d.nodes[target], c = t?.kind === 'instance' ? d.components[t.props.componentId ?? ''] : undefined;
      if (!c) add('interaction-target', `${src.name}: choose a component instance to change`, at);
      else if (!c.variants[i.value ?? ''] && !c.states?.[i.value ?? '']) add('interaction-value', `${src.name}: ${c.name} has no variant or state “${i.value ?? ''}”`, at);
    }
    if (i.action === 'select-tab' && (d.nodes[target]?.kind !== 'tabs' || !/^\d{1,3}$/.test(i.value ?? ''))) add('interaction-target', `${src.name}: choose a tab set and tab number`, at);
    if (i.action === 'set-value' && !Object.hasOwn(d.fixtures, target)) add('interaction-target', `${src.name}: choose existing sample data to update`, at);
    if (i.when && !Object.hasOwn(d.fixtures, i.when.fixture)) add('fixture-missing', `${src.name}: the condition uses sample data that doesn’t exist`, at);
  }
  const reachable = new Set<string>([d.screens[0].id]);
  for (const i of d.interactions) if (i.target && (i.action === 'navigate' || i.action === 'open-overlay')) reachable.add(i.target);
  const prototyped = d.interactions.some(i => i.action === 'navigate' || i.action === 'open-overlay');
  for (const s of d.screens) {
    if (prototyped && !reachable.has(s.id)) add('flow-unreachable', `Nothing in the prototype leads to ${s.name}`, { screenId: s.id }, 'warning');
    if (s.reference && !d.assets[s.reference.assetId]) add('asset-missing', `${s.name}’s reference image is no longer in this design`, { screenId: s.id });
    let data = false;
    walkScreen(d, s.root, n => { if (['table', 'chart', 'list'].includes(n.kind)) data = true; });
    if (data) {
      const missing = (['empty', 'loading', 'error'] as const).filter(v => !s.states.includes(v));
      if (missing.length) add('states-missing', `${s.name} shows data but doesn’t design its ${missing.join(', ')} state${missing.length === 1 ? '' : 's'}`, { screenId: s.id }, 'warning');
    }
  }
  return out;
}

/** Where each token is used: layers, component variants and other tokens that alias it. */
export function tokenUsage(d: DesignDocument): Map<string, { nodes: string[]; components: string[]; tokens: string[] }> {
  const usage = new Map<string, { nodes: string[]; components: string[]; tokens: string[] }>();
  const entry = (k: string) => { let u = usage.get(k); if (!u) usage.set(k, u = { nodes: [], components: [], tokens: [] }); return u; };
  for (const n of Object.values(d.nodes)) for (const r of new Set(nodeTokenRefs(n).map(r => r.token))) entry(r).nodes.push(n.id);
  for (const c of Object.values(d.components)) {
    const refs: { field: string; token: string }[] = [];
    for (const m of [c.variants, c.states ?? {}]) for (const layers of Object.values(m)) for (const p of Object.values(layers)) propTokenRefs(p, refs);
    for (const r of new Set(refs.map(r => r.token))) entry(r).components.push(c.id);
  }
  for (const [k, t] of Object.entries(d.tokens)) for (const a of new Set([t.alias, t.darkAlias].filter(Boolean) as string[])) entry(a).tokens.push(k);
  return usage;
}

/** Instances of a component and the screens they appear on. */
export function componentUsage(d: DesignDocument, componentId: string): { instances: string[]; screens: string[]; components: string[] } {
  const { owner } = indexDesign(d);
  const instances = Object.values(d.nodes).filter(n => n.kind === 'instance' && n.props.componentId === componentId).map(n => n.id);
  const screens = new Set<string>(), components = new Set<string>();
  for (const i of instances) { const o = owner.get(i); if (o?.screenId) screens.add(o.screenId); if (o?.componentId) components.add(o.componentId); }
  // A component nested in another component shows wherever that one is used.
  for (const c of components) for (const s of componentUsage(d, c).screens) screens.add(s);
  return { instances, screens: [...screens], components: [...components] };
}

/** Screens a patch changes, directly or through components and tokens they use. */
export function affectedScreens(d: DesignDocument, patch: DesignPatch): string[] {
  const { owner } = indexDesign(d);
  const out = new Set<string>(), comps = new Set<string>(Object.keys(patch.components ?? {}));
  for (const key of Object.keys(patch.nodes ?? {})) { const o = owner.get(key); if (o?.screenId) out.add(o.screenId); if (o?.componentId) comps.add(o.componentId); }
  for (const c of comps) for (const s of componentUsage(d, c).screens) out.add(s);
  if (patch.tokens) {
    const usage = tokenUsage(d), changed = new Set(Object.keys(patch.tokens));
    let grew = true;
    while (grew) { grew = false; for (const t of [...changed]) for (const a of usage.get(t)?.tokens ?? []) if (!changed.has(a)) { changed.add(a); grew = true; } }
    for (const t of changed) { for (const n of usage.get(t)?.nodes ?? []) { const o = owner.get(n); if (o?.screenId) out.add(o.screenId); if (o?.componentId) for (const s of componentUsage(d, o.componentId).screens) out.add(s); } for (const c of usage.get(t)?.components ?? []) for (const s of componentUsage(d, c).screens) out.add(s); }
  }
  if (patch.screens) for (const s of patch.screens) if (!d.screens.some(x => x.id === s.id && JSON.stringify(x) === JSON.stringify(s))) out.add(s.id);
  if (patch.interactions) for (const i of [...patch.interactions, ...d.interactions]) { const o = owner.get(i.source); if (o?.screenId) out.add(o.screenId); }
  return d.screens.filter(s => out.has(s.id)).map(s => s.id);
}

/** A short plain-language summary of what a patch changes. */
export function describePatch(d: DesignDocument, patch: DesignPatch): string[] {
  const out: string[] = [];
  const count = (m: Record<string, unknown> | undefined, isNew: (k: string) => boolean) => {
    const keys = Object.keys(m ?? {}); const added = keys.filter(k => m![k] !== null && isNew(k)).length, removed = keys.filter(k => m![k] === null).length;
    return { added, removed, changed: keys.length - added - removed };
  };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  for (const [key, word] of [['nodes', 'layer'], ['components', 'component'], ['tokens', 'style'], ['assets', 'image'], ['fixtures', 'sample value']] as const) {
    const c = count(patch[key] as Record<string, unknown> | undefined, k => !Object.hasOwn(d[key], k));
    const parts = [c.added && `${plural(c.added, word)} added`, c.changed && `${plural(c.changed, word)} changed`, c.removed && `${plural(c.removed, word)} removed`].filter(Boolean);
    if (parts.length) out.push(parts.join(', '));
  }
  if (patch.screens) {
    const before = new Set(d.screens.map(s => s.id)), after = new Set(patch.screens.map(s => s.id));
    const added = [...after].filter(s => !before.has(s)).length, removed = [...before].filter(s => !after.has(s)).length;
    out.push(added || removed ? [added && `${plural(added, 'screen')} added`, removed && `${plural(removed, 'screen')} removed`].filter(Boolean).join(', ') : 'Screen details changed');
  }
  if (patch.interactions) out.push('Prototype interactions changed');
  if (patch.content) out.push('Content guidelines changed');
  if (patch.settings) out.push('Layout settings changed');
  if (patch.direction !== undefined) out.push('Visual direction changed');
  if (patch.name) out.push(`Renamed to “${patch.name}”`);
  return out;
}

/** A layer id that doesn't exist yet: prefix plus a short random suffix. */
export function freshDesignId(d: Pick<DesignDocument, 'nodes'> | null, prefix = 'layer'): string {
  const clean = prefix.replace(/[^A-Za-z0-9_-]/g, '').replace(/^[^A-Za-z]+/, '') || 'layer';
  for (;;) {
    const key = `${clean.slice(0, 80)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!d || !Object.hasOwn(d.nodes, key)) return key;
  }
}

/** A new layer of a kind with friendly defaults. */
export function newDesignNode(key: string, kind: DesignNodeKind, name?: string): DesignNode {
  const label = name ?? KIND_LABELS[kind];
  const props: DesignNodeProps = {};
  const layout: DesignNode['layout'] = {};
  switch (kind) {
    case 'frame': layout.direction = 'column'; layout.gap = 16; layout.width = 'fill'; break;
    case 'card': Object.assign(props, { background: 'surface', border: true, radius: 'radius-lg' }); Object.assign(layout, { direction: 'column', gap: 12, padding: 24, width: 'fill' }); break;
    case 'dialog': case 'drawer': Object.assign(props, { background: 'surface', radius: 'radius-lg', shadow: 'shadow-lg' }); Object.assign(layout, { direction: 'column', gap: 16, padding: 24, width: kind === 'dialog' ? 480 : 360 }); break;
    case 'slot': layout.direction = 'column'; layout.gap = 8; layout.width = 'fill'; break;
    case 'text': props.text = 'Write something clear and useful.'; break;
    case 'button': Object.assign(props, { text: 'Continue', background: 'accent', color: 'on-accent', radius: 'radius-md' }); layout.width = 'hug'; break;
    case 'link': props.text = 'Learn more'; props.color = 'accent'; layout.width = 'hug'; break;
    case 'badge': Object.assign(props, { text: 'New', tone: 'info' }); layout.width = 'hug'; break;
    case 'avatar': props.label = 'Alex Morgan'; layout.width = 40; layout.height = 40; break;
    case 'icon': props.icon = 'star'; props.label = 'Star'; layout.width = 'hug'; break;
    case 'image': layout.width = 'fill'; layout.height = 200; props.fit = 'cover'; break;
    case 'shape': props.background = 'accent-subtle'; props.radius = 'radius-md'; layout.width = 'fill'; layout.height = 120; break;
    case 'input': Object.assign(props, { label: 'Email address', placeholder: 'name@example.com', inputType: 'email' }); layout.width = 'fill'; break;
    case 'textarea': Object.assign(props, { label: 'Message', placeholder: 'Tell us a little more' }); layout.width = 'fill'; break;
    case 'checkbox': props.label = 'Remember me'; break;
    case 'radio': Object.assign(props, { label: 'Plan', options: ['Starter', 'Team', 'Enterprise'], selected: 0 }); break;
    case 'switch': props.label = 'Email notifications'; props.checked = true; break;
    case 'select': Object.assign(props, { label: 'Role', options: ['Owner', 'Editor', 'Viewer'], value: 'Editor' }); layout.width = 'fill'; break;
    case 'tabs': Object.assign(props, { label: 'Sections', options: ['Overview', 'Activity', 'Settings'], selected: 0 }); Object.assign(layout, { direction: 'column', gap: 16, width: 'fill' }); break;
    case 'menu': Object.assign(props, { text: 'Actions', label: 'Actions', options: ['Rename', 'Duplicate', 'Delete'] }); layout.width = 'hug'; break;
    case 'navigation': Object.assign(props, { label: 'Main', options: ['Home', 'Projects', 'Reports', 'Settings'], selected: 0 }); layout.width = 'fill'; break;
    case 'pagination': Object.assign(props, { label: 'Pages', values: [5], selected: 0 }); layout.width = 'hug'; break;
    case 'tooltip': props.text = 'Helpful detail appears here'; Object.assign(layout, { direction: 'row', width: 'hug' }); break;
    case 'notification': Object.assign(props, { text: 'Your changes were saved.', tone: 'success', label: 'Saved' }); layout.width = 'fill'; break;
    case 'progress': Object.assign(props, { label: 'Upload progress', values: [60] }); layout.width = 'fill'; break;
    case 'spinner': props.label = 'Loading'; layout.width = 'hug'; break;
    case 'skeleton': props.values = [3]; layout.width = 'fill'; break;
    case 'divider': layout.width = 'fill'; break;
    case 'table': Object.assign(props, { label: 'Recent projects', rows: [['Name', 'Status', 'Owner'], ['Atlas', 'Active', 'Priya'], ['Luna', 'In review', 'Sam'], ['Nova', 'Paused', 'Lee']] }); layout.width = 'fill'; break;
    case 'chart': Object.assign(props, { label: 'Weekly activity', chart: 'bar', values: [35, 60, 42, 85, 70, 95, 64], options: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }); layout.width = 'fill'; break;
    case 'list': Object.assign(props, { label: 'Tasks', options: ['Review the brief', 'Share the first draft', 'Collect feedback'] }); layout.width = 'fill'; break;
    case 'instance': layout.width = 'fill'; break;
  }
  return { id: key, name: label, kind, children: [], props, layout };
}

export const KIND_LABELS: Record<DesignNodeKind, string> = {
  frame: 'Frame', card: 'Card', dialog: 'Dialog', drawer: 'Drawer', slot: 'Slot', instance: 'Component',
  text: 'Text', image: 'Image', icon: 'Icon', shape: 'Shape', divider: 'Divider', badge: 'Badge', avatar: 'Avatar', link: 'Link',
  button: 'Button', input: 'Text field', textarea: 'Text area', checkbox: 'Checkbox', radio: 'Radio group', switch: 'Switch', select: 'Dropdown',
  tabs: 'Tabs', menu: 'Menu', navigation: 'Navigation', pagination: 'Pagination', tooltip: 'Tooltip',
  notification: 'Notification', progress: 'Progress bar', spinner: 'Spinner', skeleton: 'Loading placeholder',
  table: 'Table', chart: 'Chart', list: 'List',
};

/** Resolve a token for one theme on a document. */
export function designTokenValue(d: Pick<DesignDocument, 'tokens'>, key: string, dark = false): string | number | undefined {
  return resolveToken(d.tokens, key, dark);
}

