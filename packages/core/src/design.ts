// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Project design contract. One representation (the token table) generates tokens.css, the
// machine-readable tokens, DESIGN.md, the component specimen and readable diffs. Saved revisions are
// immutable; schema 1 revisions stay readable and render exactly as they did when they were frozen.
import { z } from 'zod';
import { DesignContentGuideSchema, DesignFoundationsSchema, DesignSettingsSchema, designId, foundationSections, resolveToken, tokenCss, validTokenValue } from './designFoundations.ts';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color').transform(s => s.toLowerCase());

export const COLOR_ROLES = ['background', 'surface', 'subtle', 'text', 'muted', 'accent', 'accentText', 'border', 'focus', 'success', 'warning', 'danger', 'info'] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
export const COLOR_ROLE_INFO: Record<ColorRole, { label: string; use: string }> = {
  background: { label: 'Canvas', use: 'Page background behind panels.' },
  surface: { label: 'Surface', use: 'Cards, panels, inputs and tables.' },
  subtle: { label: 'Subtle surface', use: 'Hover and selected rows, secondary buttons, code and empty-state wells.' },
  text: { label: 'Text', use: 'Primary text and icons.' },
  muted: { label: 'Secondary text', use: 'Help text, metadata, placeholders and input boundaries.' },
  accent: { label: 'Accent', use: 'Primary actions, links, selection and progress.' },
  accentText: { label: 'On accent', use: 'Text and icons placed on the accent color.' },
  border: { label: 'Divider', use: 'Decorative dividers and card outlines. Not enough for input boundaries.' },
  focus: { label: 'Focus ring', use: 'Visible keyboard focus outline.' },
  success: { label: 'Success', use: 'Success text and icons. Always paired with a word or icon.' },
  warning: { label: 'Warning', use: 'Warning text and icons. Always paired with a word or icon.' },
  danger: { label: 'Danger', use: 'Errors and destructive actions. Always paired with a word or icon.' },
  info: { label: 'Information', use: 'Neutral notices and in-progress states.' },
};

const palette = z.object(Object.fromEntries(COLOR_ROLES.map(r => [r, color])) as Record<ColorRole, typeof color>);
export type Palette = z.infer<typeof palette>;

export const LIGHT_PALETTE: Palette = {
  background: '#f3f6f7', surface: '#ffffff', subtle: '#e8eff1', text: '#18343b', muted: '#526870', accent: '#087e8b', accentText: '#ffffff',
  border: '#c9d6da', focus: '#0a6f7a', success: '#1a7f37', warning: '#9a5b00', danger: '#b42318', info: '#0b6bcb',
};
export const DARK_PALETTE: Palette = {
  background: '#0e1416', surface: '#151d20', subtle: '#1f2a2e', text: '#e4eef0', muted: '#a3b5ba', accent: '#4cc5cf', accentText: '#0b1f22',
  border: '#2c3a3f', focus: '#7dd8df', success: '#4ac26b', warning: '#e3a33b', danger: '#f47067', info: '#6cb6ff',
};

export const DesignSystemSchema = z.object({
  schema: z.union([z.literal(2), z.literal(3)]).default(2),
  /** Schema 3: the typed token system published from Designer, with its layout settings and content guide. */
  foundations: DesignFoundationsSchema.optional(),
  foundationSettings: DesignSettingsSchema.optional(),
  content: DesignContentGuideSchema.optional(),
  /** Schema 3: tokens removed from the system and the token designs should use instead. */
  replacements: z.record(designId(), designId()).refine(r => Object.keys(r).length <= 500, 'Too many replacements').optional(),
  name: z.string().trim().min(1).max(100),
  direction: z.string().trim().min(1).max(1200),
  /** Light only, dark only, or both following the viewer's system preference. */
  appearance: z.enum(['light', 'dark', 'system']).default('system'),
  colors: palette,
  dark: palette.default(DARK_PALETTE),
  typography: z.object({ pairing: z.enum(['system', 'editorial']).default('system'), base: z.number().int().min(13).max(18).default(14) }).default({ pairing: 'system', base: 14 }),
  density: z.enum(['compact', 'comfortable']).default('comfortable'),
  radius: z.number().int().min(0).max(24).default(8),
  borderWidth: z.union([z.literal(1), z.literal(2)]).default(1),
  elevation: z.enum(['flat', 'soft']).default('soft'),
  layout: z.object({ maxWidth: z.number().int().min(720).max(1600).default(1200), navigation: z.enum(['sidebar', 'top']).default('sidebar') }).default({ maxWidth: 1200, navigation: 'sidebar' }),
  motion: z.enum(['reduced', 'subtle']).default('subtle'),
  accessibility: z.object({ targetSize: z.union([z.literal(24), z.literal(32), z.literal(44)]).default(44), focusWidth: z.union([z.literal(2), z.literal(3)]).default(2) }).default({ targetSize: 44, focusWidth: 2 }),
  components: z.string().max(3000).default(''),
  rules: z.string().max(2000).default(''),
});
export type DesignSystem = z.infer<typeof DesignSystemSchema>;
export type DesignSystemInput = z.input<typeof DesignSystemSchema>;

/** Schema 1 contracts saved before the expanded system. Kept verbatim; never re-hashed. */
export interface LegacyDesignSystem {
  name: string; direction: string;
  colors: { background: string; surface: string; text: string; muted: string; accent: string; accentText: string; border: string };
  typography: 'system' | 'editorial'; spacing: 'compact' | 'comfortable'; radius: number; motion: 'reduced' | 'subtle'; rules: string;
}
export type AnyDesignSystem = DesignSystem | LegacyDesignSystem;
export const isLegacyDesign = (s: AnyDesignSystem): s is LegacyDesignSystem => ![2, 3].includes((s as { schema?: number }).schema ?? 1);

export interface DesignRevision {
  version: number;
  hash: string;
  system: AnyDesignSystem;
  createdAt: string;
  /** Who saved it (always a human) and the revision it replaced. Absent on early revisions. */
  by?: { type: 'human' | 'agent' | 'system'; id: string };
  parent?: string | null;
  note?: string;
}
export interface DesignSkill { id: string; name: string; description: string; license: string; source: string; version: string }

export const DEFAULT_DESIGN: DesignSystem = {
  schema: 2,
  name: 'Connected clarity',
  direction: 'A calm, readable workbench. Pearl surfaces, ink text, teal actions. Use hierarchy and shared tokens to make complex work understandable.',
  appearance: 'system',
  colors: LIGHT_PALETTE,
  dark: DARK_PALETTE,
  typography: { pairing: 'system', base: 14 },
  density: 'comfortable',
  radius: 8,
  borderWidth: 1,
  elevation: 'soft',
  layout: { maxWidth: 1200, navigation: 'sidebar' },
  motion: 'subtle',
  accessibility: { targetSize: 44, focusWidth: 2 },
  components: '',
  rules: 'Use sentence-case labels, clear empty and error states, and visible keyboard focus. Tables describe comparisons; status never relies on color alone. Avoid generic promotional copy.',
};

/**
 * Accepts the current shape or a schema 1 object (from older clients) and returns a parse input.
 * Upgrading only happens when a human saves; stored legacy revisions are never rewritten.
 */
export function upgradeDesignInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const o = input as Record<string, unknown>;
  if (o.schema === 2 || o.schema === 3 || typeof o.typography !== 'string') return input;
  const c = (o.colors ?? {}) as Record<string, string>;
  return {
    schema: 2, name: o.name, direction: o.direction, appearance: 'light',
    colors: { ...LIGHT_PALETTE, ...Object.fromEntries(Object.entries(c).filter(([k]) => k in LIGHT_PALETTE)) },
    dark: DARK_PALETTE,
    typography: { pairing: o.typography, base: 14 }, density: o.spacing ?? 'comfortable', radius: o.radius ?? 8,
    motion: o.motion ?? 'subtle', rules: o.rules ?? '',
  };
}

/** In-memory view of any revision as schema 2, for diffs and previews only. */
export function normalizeDesign(s: AnyDesignSystem): DesignSystem {
  return isLegacyDesign(s) ? DesignSystemSchema.parse(upgradeDesignInput(s)) : s;
}

// ---- measurements -------------------------------------------------------------------------------

const luminance = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

export interface DesignCheck { name: string; mode?: 'light' | 'dark'; fg?: string; bg?: string; ratio: number; required?: number; passed: boolean; blocking?: boolean; note?: string }

const PAIRS: [string, ColorRole, ColorRole, number, boolean][] = [
  ['Body on surface', 'text', 'surface', 4.5, true],
  ['Body on canvas', 'text', 'background', 4.5, true],
  ['Body on subtle surface', 'text', 'subtle', 4.5, true],
  ['Secondary text on surface', 'muted', 'surface', 4.5, true],
  ['Secondary text on canvas', 'muted', 'background', 4.5, true],
  ['Action label', 'accentText', 'accent', 4.5, true],
  ['Link text on surface', 'accent', 'surface', 4.5, true],
  ['Focus ring on canvas', 'focus', 'background', 3, true],
  ['Focus ring on surface', 'focus', 'surface', 3, true],
  ['Input boundary on surface', 'muted', 'surface', 3, true],
  ['Success text on surface', 'success', 'surface', 4.5, true],
  ['Warning text on surface', 'warning', 'surface', 4.5, true],
  ['Danger text on surface', 'danger', 'surface', 4.5, true],
  ['Information text on surface', 'info', 'surface', 4.5, true],
  ['Divider on surface', 'border', 'surface', 1.2, false],
];

export const activeModes = (s: DesignSystem): ('light' | 'dark')[] => (s.appearance === 'system' ? ['light', 'dark'] : [s.appearance]);
export const paletteFor = (s: DesignSystem, mode: 'light' | 'dark'): Palette => (mode === 'dark' ? s.dark : s.colors);

/**
 * Measured color pairs for every active mode. Blocking failures prevent saving. Passing contrast
 * is necessary but never sufficient: keyboard, screen reader, zoom and state checks are separate.
 */
export function designChecks(s: AnyDesignSystem): DesignCheck[] {
  if (isLegacyDesign(s)) return legacyChecks(s);
  const modes = activeModes(s);
  return modes.flatMap(mode => {
    const p = paletteFor(s, mode);
    return PAIRS.map(([name, fg, bg, required, blocking]) => {
      const ratio = contrast(p[fg], p[bg]);
      return { name: modes.length > 1 ? `${name} (${mode})` : name, mode, fg: p[fg], bg: p[bg], ratio, required, passed: ratio >= required, blocking, ...(blocking ? {} : { note: 'Advisory: dividers may be light; input boundaries use the secondary text color.' }) };
    });
  });
}
export const blockingFailures = (s: AnyDesignSystem) => designChecks(s).filter(c => c.blocking !== false && !c.passed);

// ---- token table: the single source for CSS, JSON, DESIGN.md and diffs --------------------------

export type TokenGroup = 'color' | 'typography' | 'space' | 'shape' | 'elevation' | 'layout' | 'motion' | 'accessibility';
export interface DesignToken { key: string; css: string; value: string; group: TokenGroup; mode?: 'light' | 'dark'; description: string }

const kebab = (k: string) => k.replace(/[A-Z]/g, x => '-' + x.toLowerCase());
const FONTS = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
export const SPACE_SCALE = { compact: [2, 4, 8, 12, 16, 20, 24], comfortable: [4, 8, 12, 16, 24, 32, 48] } as const;
export const TYPE_STEPS = [['caption', -2], ['small', -1], ['body', 0], ['h3', 1], ['h2', 2], ['h1', 3], ['display', 4]] as const;
type TypeStep = (typeof TYPE_STEPS)[number][0];

export function typeScale(base: number): Record<TypeStep, number> {
  return Object.fromEntries(TYPE_STEPS.map(([n, step]) => [n, step < 0 ? base + step : Math.round(base * 1.2 ** step)])) as Record<TypeStep, number>;
}

export function designTokens(s: DesignSystem): DesignToken[] {
  const out: DesignToken[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const p = paletteFor(s, mode);
    for (const r of COLOR_ROLES) out.push({ key: `color.${r}`, css: `--design-${kebab(r)}`, value: p[r], group: 'color', mode, description: COLOR_ROLE_INFO[r].use });
  }
  const t = typeScale(s.typography.base);
  out.push({ key: 'font.body', css: '--design-font', value: FONTS.sans, group: 'typography', description: 'Body and interface text.' });
  out.push({ key: 'font.display', css: '--design-font-display', value: s.typography.pairing === 'editorial' ? FONTS.serif : FONTS.sans, group: 'typography', description: 'Page titles and display headings.' });
  out.push({ key: 'font.mono', css: '--design-font-mono', value: FONTS.mono, group: 'typography', description: 'Code, ids and hashes only.' });
  for (const [n] of TYPE_STEPS) out.push({ key: `size.${n}`, css: `--design-size-${n}`, value: `${t[n]}px`, group: 'typography', description: `${n} text size.` });
  out.push({ key: 'leading.body', css: '--design-leading', value: '1.5', group: 'typography', description: 'Body line height.' });
  out.push({ key: 'leading.heading', css: '--design-leading-heading', value: '1.25', group: 'typography', description: 'Heading line height.' });
  out.push({ key: 'space.base', css: '--design-space', value: `${s.density === 'compact' ? 4 : 8}px`, group: 'space', description: 'Base spacing unit.' });
  SPACE_SCALE[s.density].forEach((v, i) => out.push({ key: `space.${i + 1}`, css: `--design-space-${i + 1}`, value: `${v}px`, group: 'space', description: `Spacing step ${i + 1}.` }));
  out.push({ key: 'control.height', css: '--design-control-height', value: `${controlHeight(s)}px`, group: 'space', description: 'Buttons, inputs and selects.' });
  out.push({ key: 'radius', css: '--design-radius', value: `${s.radius}px`, group: 'shape', description: 'Controls, cards and dialogs.' });
  out.push({ key: 'radius.small', css: '--design-radius-sm', value: `${Math.round(s.radius / 2)}px`, group: 'shape', description: 'Badges, chips and inline code.' });
  out.push({ key: 'border.width', css: '--design-border-width', value: `${s.borderWidth}px`, group: 'shape', description: 'Dividers, cards and input boundaries.' });
  out.push({ key: 'shadow.1', css: '--design-shadow-1', value: s.elevation === 'flat' ? 'none' : '0 1px 2px rgb(16 24 40 / 8%)', group: 'elevation', description: 'Cards and raised controls.' });
  out.push({ key: 'shadow.2', css: '--design-shadow-2', value: s.elevation === 'flat' ? 'none' : '0 8px 24px rgb(16 24 40 / 16%)', group: 'elevation', description: 'Menus, popovers and dialogs. Flat systems use a border instead.' });
  out.push({ key: 'layout.max-width', css: '--design-max-width', value: `${s.layout.maxWidth}px`, group: 'layout', description: 'Maximum content width.' });
  out.push({ key: 'layout.gutter', css: '--design-gutter', value: `${s.density === 'compact' ? 16 : 24}px`, group: 'layout', description: 'Page side padding at desktop width; halve on phones.' });
  out.push({ key: 'motion.fast', css: '--design-duration-fast', value: s.motion === 'reduced' ? '0ms' : '120ms', group: 'motion', description: 'Hover, press and focus transitions.' });
  out.push({ key: 'motion.slow', css: '--design-duration-slow', value: s.motion === 'reduced' ? '0ms' : '200ms', group: 'motion', description: 'Panels, dialogs and toasts.' });
  out.push({ key: 'motion.ease', css: '--design-ease', value: 'cubic-bezier(.2, 0, 0, 1)', group: 'motion', description: 'Standard easing.' });
  out.push({ key: 'a11y.target', css: '--design-target', value: `${s.accessibility.targetSize}px`, group: 'accessibility', description: 'Minimum pointer target size.' });
  out.push({ key: 'a11y.focus-width', css: '--design-focus-width', value: `${s.accessibility.focusWidth}px`, group: 'accessibility', description: 'Focus outline width.' });
  if (s.schema === 3 && s.foundations) {
    const f = s.foundations;
    const group = (t: { type: string; category?: string }): TokenGroup => t.type === 'color' ? 'color' : ['font', 'fontWeight', 'lineHeight', 'letterSpacing'].includes(t.type) || t.category === 'type-scale' ? 'typography'
      : t.type === 'shadow' ? 'elevation' : t.type === 'duration' || t.type === 'easing' ? 'motion' : t.category === 'radius' || t.category === 'border' ? 'shape' : 'space';
    for (const [key, entry] of Object.entries(f)) {
      for (const mode of entry.type === 'color' ? (['light', 'dark'] as const) : (['light'] as const)) {
        const v = resolveToken(f, key, mode === 'dark');
        if (v === undefined || !validTokenValue(entry.type, v)) continue;
        out.push({ key: `foundation.${key}`, css: `--ds-${key}`, value: tokenCss(entry.type, v), group: group(entry), ...(entry.type === 'color' ? { mode } : {}), description: entry.description });
      }
    }
  }
  return out;
}
const controlHeight = (s: DesignSystem) => Math.max(s.density === 'compact' ? 32 : 40, s.accessibility.targetSize === 44 ? 40 : s.accessibility.targetSize);

/** Every color a mock may use literally: the active palettes. */
export function designPalette(s: AnyDesignSystem): string[] {
  if (isLegacyDesign(s)) return Object.values(s.colors).map(c => c.toLowerCase());
  return [...new Set(activeModes(s).flatMap(m => Object.values(paletteFor(s, m))))];
}

const block = (sel: string, tokens: DesignToken[], extra: string[] = []) => `${sel} {\n${[...extra, ...tokens.map(t => `  ${t.css}: ${t.value};`)].join('\n')}\n}\n`;

/** tokens.css. Legacy revisions keep their exact original output. */
export function designCss(s: AnyDesignSystem): string {
  if (isLegacyDesign(s)) return legacyCss(s);
  const all = designTokens(s);
  const primary: 'light' | 'dark' = s.appearance === 'dark' ? 'dark' : 'light';
  const colors = (m: 'light' | 'dark') => all.filter(t => t.group === 'color' && t.mode === m);
  const rest = all.filter(t => t.group !== 'color');
  let css = '/* Generated from the project design contract. Edit the contract, not this file. */\n';
  css += block(':root', [...colors(primary), ...rest], [`  color-scheme: ${s.appearance === 'system' ? 'light dark' : primary};`]);
  if (s.appearance === 'system') {
    css += `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', colors('dark')).replace(/^(?=.)/gm, '  ')}}\n`;
    css += block(':root[data-theme="dark"]', colors('dark'), ['  color-scheme: dark;']);
    css += block(':root[data-theme="light"]', colors('light'), ['  color-scheme: light;']);
  }
  css += '@media (prefers-reduced-motion: reduce) {\n  :root { --design-duration-fast: 0ms; --design-duration-slow: 0ms; }\n}\n';
  return css;
}

/** Design Tokens Community Group style groups, plus the contract identity. */
export function designTokensJson(r: DesignRevision): Record<string, unknown> {
  const legacy = isLegacyDesign(r.system);
  const s = normalizeDesign(r.system);
  const out: Record<string, Record<string, unknown>> = {};
  for (const t of designTokens(s)) {
    if (legacy && t.mode === 'dark') continue;
    const [group, ...rest] = t.key.split('.');
    const name = rest.join('.') || group;
    const bucket = (out[t.mode ? `${group}-${t.mode}` : group] ??= {});
    const type = t.group === 'color' ? 'color' : group === 'font' ? 'fontFamily' : /px$/.test(t.value) ? 'dimension' : /ms$/.test(t.value) ? 'duration' : 'string';
    bucket[name] = { $type: type, $value: t.value, $description: t.description, $extensions: { 'one-connect': { css: t.css } } };
  }
  return {
    $description: `${s.name}: design contract v${r.version}. Generated; edit the contract in One Connect.`,
    $extensions: { 'one-connect': { contract: { version: r.version, hash: r.hash, schema: legacy ? 1 : s.schema }, appearance: s.appearance, ...(legacy ? { note: 'Schema 1 contract: roles it did not define use schema 2 defaults here. tokens.css holds the frozen values.' } : {}) } },
    ...out,
  };
}

// ---- readable diffs -----------------------------------------------------------------------------

export interface DesignChange { field: string; label: string; before: string | null; after: string | null }

function flatten(s: DesignSystem): Record<string, [string, string]> {
  const f: Record<string, [string, string]> = {
    name: ['Name', s.name], direction: ['Direction', s.direction], appearance: ['Appearance', s.appearance],
    'typography.pairing': ['Type pairing', s.typography.pairing], 'typography.base': ['Base text size', `${s.typography.base}px`],
    density: ['Density', s.density], radius: ['Corner radius', `${s.radius}px`], borderWidth: ['Border width', `${s.borderWidth}px`],
    elevation: ['Elevation', s.elevation], 'layout.maxWidth': ['Max content width', `${s.layout.maxWidth}px`], 'layout.navigation': ['Navigation', s.layout.navigation],
    motion: ['Motion', s.motion], 'accessibility.targetSize': ['Minimum target', `${s.accessibility.targetSize}px`], 'accessibility.focusWidth': ['Focus width', `${s.accessibility.focusWidth}px`],
    components: ['Component notes', s.components], rules: ['Project rules', s.rules],
  };
  for (const r of COLOR_ROLES) {
    f[`colors.${r}`] = [`${COLOR_ROLE_INFO[r].label} (light)`, s.colors[r]];
    f[`dark.${r}`] = [`${COLOR_ROLE_INFO[r].label} (dark)`, s.dark[r]];
  }
  if (s.schema === 3) {
    const tokens = s.foundations ?? {};
    for (const [key, t] of Object.entries(tokens)) {
      const show = (dark: boolean) => { const v = resolveToken(tokens, key, dark); return v === undefined ? 'unresolved' : tokenCss(t.type, v); };
      const ref = [t.alias && `→ ${t.alias}`, t.darkAlias && `dark → ${t.darkAlias}`].filter(Boolean).join(', ');
      f[`foundations.${key}`] = [`Token ${key}`, `${show(false)}${t.type === 'color' ? ` / dark ${show(true)}` : ''}${ref ? ` (${ref})` : ''}`];
    }
    const st = s.foundationSettings;
    if (st) {
      f['foundationSettings.breakpoints'] = ['Breakpoints', `phone < ${st.breakpoints.phone}px, tablet < ${st.breakpoints.tablet}px`];
      f['foundationSettings.density'] = ['Layout density', st.density];
      f['foundationSettings.container'] = ['Container width', `${st.container}px`];
      f['foundationSettings.grid'] = ['Grid', `${st.grid.columns} columns, ${st.grid.gutter}px gutter`];
      f['foundationSettings.motion'] = ['Motion preference', st.motion];
    }
    if (s.content) {
      f['content.voice'] = ['Voice', s.content.voice];
      f['content.terms'] = ['Preferred terms', s.content.terms.map(t => `${t.use} (not ${t.avoid})`).join('; ')];
      f['content.formats'] = ['Formats', `${s.content.formats.date}; ${s.content.formats.number}; ${s.content.formats.currency}`];
      for (const [k, v] of Object.entries(s.content.states)) f[`content.states.${k}`] = [`${k[0].toUpperCase()}${k.slice(1)} state copy`, v];
    }
    for (const [from, to] of Object.entries(s.replacements ?? {})) f[`replacements.${from}`] = [`Replace ${from}`, to];
  }
  return f;
}

/** Field-level changes from `a` to `b` (a null `a` is a first version). */
export function designDiff(a: AnyDesignSystem | null, b: AnyDesignSystem): DesignChange[] {
  const before = a ? flatten(normalizeDesign(a)) : {};
  const after = flatten(normalizeDesign(b));
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter(k => before[k]?.[1] !== after[k]?.[1]).map(k => ({ field: k, label: (after[k] ?? before[k])[0], before: before[k]?.[1] ?? null, after: after[k]?.[1] ?? null }));
}

// ---- DESIGN.md and specimen ---------------------------------------------------------------------

export const COMPONENT_RECIPES: { name: string; recipe: string; states: string }[] = [
  { name: 'Button', recipe: 'Height var(--design-control-height), min width var(--design-target), padding 0 var(--design-space-4), radius var(--design-radius). Primary: accent fill with on-accent label. Secondary: subtle fill with text color. Danger: danger text on surface with a danger border; confirm destructive actions.', states: 'hover darkens 6%; focus-visible shows a var(--design-focus-width) var(--design-focus) outline offset 2px; active; disabled uses aria-disabled or disabled with 55% opacity and an explanation nearby; loading keeps its width, shows progress text and sets aria-busy.' },
  { name: 'Text field', recipe: 'Visible label above, help text below in secondary text. Boundary var(--design-border-width) solid var(--design-muted) on surface. Same height as buttons.', states: 'focus-visible outline; invalid sets aria-invalid, a danger boundary and an error message linked with aria-describedby; disabled and read-only are visually distinct.' },
  { name: 'Card and panel', recipe: 'Surface background, divider border, radius var(--design-radius), shadow var(--design-shadow-1), padding var(--design-space-4) to var(--design-space-5). One clear heading per card.', states: 'selected uses an accent border or subtle background, never color alone.' },
  { name: 'Table and list', recipe: 'Left-align text, right-align numbers, sticky header on long lists, subtle row hover. Phones collapse to stacked rows with labels.', states: 'empty, loading (skeleton rows of stable height), error with retry, filtered-to-nothing with a clear-filter action.' },
  { name: 'Status and badge', recipe: 'Status color plus a word or icon. Badges use radius var(--design-radius-sm) and small text.', states: 'success, warning, danger, information and neutral.' },
  { name: 'Tabs', recipe: 'role=tablist with arrow-key, Home and End navigation; only the selected tab is in the tab order. Selected tab: text color plus an accent underline.', states: 'focus-visible outline; disabled tabs explain why.' },
  { name: 'Dialog', recipe: 'Raised surface with var(--design-shadow-2) (border when flat), modal backdrop, labelled heading, Escape closes, focus moves inside and returns to the trigger.', states: 'confirm, destructive confirm, form with inline errors, busy.' },
  { name: 'Notice and toast', recipe: 'Inline notices sit next to the content they describe. Toasts announce through a polite live region and never carry the only copy of an error.', states: 'information, success, warning, error; dismissible when not critical.' },
  { name: 'Empty, loading, error and success states', recipe: 'Every data view designs all four. Empty explains what will appear and the first action. Loading keeps layout stable. Error says what failed and how to retry without losing input. Success confirms what changed.', states: 'Include a long-content and a narrow-phone variant.' },
];

export function designMarkdown(r: DesignRevision): string {
  if (isLegacyDesign(r.system)) return legacyMarkdown(r);
  const s = r.system;
  const t = typeScale(s.typography.base);
  const checks = designChecks(s);
  const colorRows = COLOR_ROLES.map(role => `| ${COLOR_ROLE_INFO[role].label} | \`${s.colors[role]}\` | \`${s.dark[role]}\` | \`--design-${kebab(role)}\` | ${COLOR_ROLE_INFO[role].use} |`).join('\n');
  return `# ${s.name}

Design contract v${r.version} · SHA-256 ${r.hash} · schema ${s.schema}

${s.direction}

## How to use this contract

Read this exact revision before UI work and include its version and hash in your handoff. Import \`tokens.css\` and use \`var(--design-*)\` variables instead of literal values. A visual exception needs a recorded human decision with rationale; never change the contract to fit a mock. Skills and reference systems guide execution, but this contract controls the project's visual identity.

## Color roles

Appearance: **${s.appearance}**${s.appearance === 'system' ? ' (light by default; dark under prefers-color-scheme: dark or data-theme="dark")' : ''}. Active modes: ${activeModes(s).join(', ')}.

| Role | Light | Dark | CSS variable | Use |
|---|---|---|---|---|
${colorRows}

Status never relies on color alone: pair it with a word or icon.

## Typography

${s.typography.pairing === 'editorial' ? 'Serif display headings (`--design-font-display`) with a system sans body.' : 'System sans for headings and body.'} Monospace only for code, ids and hashes. Sentence case. Base ${s.typography.base}px, ratio 1.2: ${TYPE_STEPS.map(([n]) => `${n} ${t[n]}px`).join(', ')}. Body line height 1.5, headings 1.25. Keep line length near 60–80 characters.

## Spacing and density

${s.density === 'compact' ? 'Compact' : 'Comfortable'} density. Spacing steps (\`--design-space-1\` … \`-7\`): ${SPACE_SCALE[s.density].map(v => `${v}px`).join(', ')}. Controls are ${controlHeight(s)}px tall. Group related content with smaller steps and separate sections with larger ones.

## Shape, borders and elevation

Radius ${s.radius}px (small ${Math.round(s.radius / 2)}px). Border width ${s.borderWidth}px. Elevation: ${s.elevation === 'flat' ? 'flat; separate layers with borders, not shadows' : 'soft; cards use `--design-shadow-1`, overlays `--design-shadow-2`'}.

## Layout

Maximum content width ${s.layout.maxWidth}px with \`--design-gutter\` side padding. Primary navigation: ${s.layout.navigation === 'sidebar' ? 'a left sidebar on desktop and tablet, collapsing to a menu button on phones' : 'a top bar, collapsing to a menu button on phones'}. Breakpoints: phone below 640px, tablet 640–1023px, desktop 1024px and above. Check phone 390×844, tablet 820×1180 and desktop 1280×800.

## Motion

${s.motion === 'reduced' ? 'Reduced: state changes are instant. No decorative animation.' : 'Subtle: 120ms for hover and press, 200ms for panels and dialogs, standard easing. No decorative loops.'} Always honor \`prefers-reduced-motion\`.

## Accessibility and interaction rules

- Every control is reachable and operable with a keyboard in a logical order. Focus is always visible: ${s.accessibility.focusWidth}px \`--design-focus\` outline with a 2px offset.
- Pointer targets are at least ${s.accessibility.targetSize}px.
- Use semantic elements and accessible names. Label fields visibly; connect errors with \`aria-describedby\`; announce asynchronous results with a live region.
- Content reflows at 320px wide and stays usable at 200% zoom.
- Dialogs trap focus, close with Escape and return focus to their trigger.
- The contrast table below is necessary but does not prove accessibility. Keyboard, screen reader, zoom and state checks are recorded separately.

## Component recipes

${COMPONENT_RECIPES.map(c => `### ${c.name}\n\n${c.recipe}\n\nStates: ${c.states}`).join('\n\n')}
${s.components.trim() ? `\n### Project component notes\n\n${s.components.trim()}\n` : ''}
## Project rules

${s.rules.trim() || 'None recorded.'}
${s.schema === 3 && s.foundations ? foundationsMarkdown(s) : ''}
## Measured contrast

| Pair | Ratio | Required | Result |
|---|---|---|---|
${checks.map(c => `| ${c.name} | ${c.ratio.toFixed(2)}:1 | ${c.required}:1 | ${c.passed ? 'pass' : c.blocking === false ? 'advisory' : 'fail'} |`).join('\n')}

## Engineering handoff

Implement against this revision only. Copy \`tokens.css\` (or map \`tokens.json\`) into the application's styling layer, build the recipes above as shared components, and keep every literal color, size and duration in tokens. For each screen, implement the empty, loading, error and success states shown in the approved mock. Report keyboard, focus, phone/tablet/desktop and project check results with the exact commands. An approved mock is a reference, not a passing implementation.
`;
}

/** Schema 3: the published token system, layout settings and content guide. */
function foundationsMarkdown(s: DesignSystem): string {
  const f = s.foundations ?? {};
  const value = (key: string, dark: boolean) => { const v = resolveToken(f, key, dark); return v === undefined ? 'unresolved' : tokenCss(f[key].type, v); };
  const sections = foundationSections(f).map(sec => `### ${sec.label}\n\n| Token | CSS variable | Light | Dark | Use |\n|---|---|---|---|---|\n${sec.ids.map(k => `| ${k} | \`--ds-${k}\` | \`${value(k, false)}\` | ${f[k].type === 'color' ? `\`${value(k, true)}\`` : '—'} | ${f[k].description.replace(/\|/g, '/')} |`).join('\n')}`).join('\n\n');
  const st = s.foundationSettings, c = s.content;
  return `
## Foundations

Use these \`--ds-*\` variables in components and screens. Semantic roles alias the primitive palette; components should use roles, not palette steps.

${sections}
${st ? `\n### Layout settings\n\nPhone below ${st.breakpoints.phone}px, tablet below ${st.breakpoints.tablet}px. ${st.density[0].toUpperCase()}${st.density.slice(1)} density. Content width up to ${st.container}px on a ${st.grid.columns}-column grid with ${st.grid.gutter}px gutters. Motion: ${st.motion === 'reduced' ? 'reduced (opacity changes only)' : 'full, with reduced-motion alternatives'}.\n` : ''}${c ? `\n### Content guide\n\n${c.voice}\n\n${c.terms.length ? `Preferred terms: ${c.terms.map(t => `**${t.use}** (not ${t.avoid})`).join(', ')}.\n\n` : ''}Formats: dates like ${c.formats.date}, numbers like ${c.formats.number}, currency like ${c.formats.currency}. Helper text: ${c.helperText} Errors: ${c.errorText}\n\nState copy: empty “${c.states.empty}”, loading “${c.states.loading}”, error “${c.states.error}”, no access “${c.states.permission}”, offline “${c.states.offline}”.\n` : ''}${Object.keys(s.replacements ?? {}).length ? `\n### Removed tokens\n\n${Object.entries(s.replacements!).map(([a, b]) => `- \`${a}\` was removed; use \`${b}\`.`).join('\n')}\n` : ''}`;
}

/** A self-contained, static component and state specimen generated from the contract. */
export function designSpecimenHtml(r: DesignRevision): string {
  const s = normalizeDesign(r.system);
  const esc = (x: string) => x.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const css = `${designCss(r.system)}
*{box-sizing:border-box}body{margin:0;background:var(--design-background);color:var(--design-text);font:var(--design-size-body, 14px)/var(--design-leading, 1.5) var(--design-font)}
main{max-width:var(--design-max-width, 1200px);margin:0 auto;padding:var(--design-space-6, 32px) var(--design-gutter, 24px);display:grid;gap:var(--design-space-6, 32px)}
h1,h2,h3{font-family:var(--design-font-display, var(--design-font));line-height:var(--design-leading-heading, 1.25);margin:0}h1{font-size:var(--design-size-h1, 24px)}h2{font-size:var(--design-size-h3, 17px)}
p{margin:0}.muted{color:var(--design-muted)}section{display:grid;gap:var(--design-space-3, 12px)}.row{display:flex;flex-wrap:wrap;gap:var(--design-space-3, 12px);align-items:center}
.card{background:var(--design-surface);border:var(--design-border-width, 1px) solid var(--design-border);border-radius:var(--design-radius);box-shadow:var(--design-shadow-1, none);padding:var(--design-space-5, 24px);display:grid;gap:var(--design-space-3, 12px)}
button{font:inherit;min-height:var(--design-control-height, 40px);min-width:var(--design-target, 44px);padding:0 var(--design-space-4, 16px);border-radius:var(--design-radius);border:var(--design-border-width, 1px) solid transparent;cursor:pointer}
.primary{background:var(--design-accent);color:var(--design-accent-text)}.secondary{background:var(--design-subtle, var(--design-background));color:var(--design-text)}.danger{background:var(--design-surface);color:var(--design-danger, var(--design-text));border-color:var(--design-danger, var(--design-border))}
button:focus-visible,input:focus-visible,a:focus-visible{outline:var(--design-focus-width, 2px) solid var(--design-focus, var(--design-accent));outline-offset:2px}button[disabled]{opacity:.55;cursor:not-allowed}
label{display:grid;gap:var(--design-space-1, 4px);font-weight:600}input{font:inherit;font-weight:400;min-height:var(--design-control-height, 40px);padding:0 var(--design-space-3, 12px);border:var(--design-border-width, 1px) solid var(--design-muted);border-radius:var(--design-radius);background:var(--design-surface);color:var(--design-text)}
input[aria-invalid=true]{border-color:var(--design-danger, var(--design-text))}.help{font-weight:400;font-size:var(--design-size-small, 13px);color:var(--design-muted)}.error{font-weight:400;font-size:var(--design-size-small, 13px);color:var(--design-danger, var(--design-text))}
.badge{display:inline-block;padding:2px var(--design-space-2, 8px);border-radius:var(--design-radius-sm, 4px);font-size:var(--design-size-caption, 12px);background:var(--design-subtle, var(--design-background))}
.s-success{color:var(--design-success, var(--design-text))}.s-warning{color:var(--design-warning, var(--design-text))}.s-danger{color:var(--design-danger, var(--design-text))}.s-info{color:var(--design-info, var(--design-text))}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:var(--design-space-2, 8px) var(--design-space-3, 12px);border-bottom:var(--design-border-width, 1px) solid var(--design-border)}td.num,th.num{text-align:right}
.states{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--design-space-4, 16px)}.skeleton{height:12px;border-radius:var(--design-radius-sm, 4px);background:var(--design-subtle, var(--design-border))}
.tabs{display:flex;gap:var(--design-space-2, 8px);border-bottom:var(--design-border-width, 1px) solid var(--design-border)}.tabs button{background:none;color:var(--design-muted);border-radius:0}.tabs [aria-selected=true]{color:var(--design-text);border-bottom:2px solid var(--design-accent)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(s.name)} · contract v${r.version} specimen</title><style>${css}</style></head>
<body><main>
<header><p class="muted">Design contract v${r.version} · ${r.hash.slice(0, 12)} · generated specimen</p><h1>${esc(s.name)}</h1><p class="muted">${esc(s.direction)}</p></header>
<section aria-labelledby="buttons"><h2 id="buttons">Buttons</h2><div class="row"><button class="primary" type="button">Save changes</button><button class="secondary" type="button">Cancel</button><button class="danger" type="button">Delete project</button><button class="primary" type="button" disabled>Disabled</button><button class="primary" type="button" aria-busy="true">Saving…</button></div></section>
<section aria-labelledby="fields"><h2 id="fields">Fields</h2><div class="states"><label>Project name<input value="Atlas"><span class="help">Shown to your team.</span></label><label>Email<input aria-invalid="true" aria-describedby="email-error" value="team@"><span class="error" id="email-error">Enter a complete email address.</span></label></div></section>
<section aria-labelledby="status"><h2 id="status">Status</h2><div class="row"><span class="badge s-success">✓ Passed</span><span class="badge s-warning">! Needs review</span><span class="badge s-danger">× Failed</span><span class="badge s-info">… Running</span></div></section>
<section aria-labelledby="tabs"><h2 id="tabs">Tabs</h2><div class="tabs" role="tablist" aria-label="Example"><button role="tab" aria-selected="true" type="button">Overview</button><button role="tab" aria-selected="false" tabindex="-1" type="button">Activity</button></div></section>
<section aria-labelledby="table"><h2 id="table">Table</h2><div class="card"><table><thead><tr><th>Check</th><th>Owner</th><th class="num">Duration</th></tr></thead><tbody><tr><td>Unit tests</td><td>Codex</td><td class="num">42s</td></tr><tr><td>Phone layout</td><td>Design review</td><td class="num">—</td></tr></tbody></table></div></section>
<section aria-labelledby="states"><h2 id="states">Content states</h2><div class="states">
<div class="card"><h3>Empty</h3><p class="muted">No reports yet. Reports appear after the first scheduled run.</p><div><button class="primary" type="button">Schedule a run</button></div></div>
<div class="card" aria-busy="true"><h3>Loading</h3><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div>
<div class="card" role="alert"><h3 class="s-danger">Error</h3><p>Reports could not load. Your filters are kept.</p><div><button class="secondary" type="button">Try again</button></div></div>
<div class="card"><h3 class="s-success">Success</h3><p>Schedule saved. The next run starts at 09:00.</p></div>
</div></section>
</main></body></html>
`;
}

// ---- schema 1 renderers, unchanged so frozen assignments and captured tokens stay stable -------

function legacyChecks(s: LegacyDesignSystem): DesignCheck[] {
  return ([['Body on surface', s.colors.text, s.colors.surface], ['Body on canvas', s.colors.text, s.colors.background], ['Secondary text', s.colors.muted, s.colors.surface], ['Action label', s.colors.accentText, s.colors.accent]] as const)
    .map(([name, a, b]) => ({ name, fg: a, bg: b, ratio: contrast(a, b), required: 4.5, passed: contrast(a, b) >= 4.5, blocking: true }));
}
function legacyCss(s: LegacyDesignSystem): string {
  return ':root {\n' + Object.entries(s.colors).map(([k, v]) => `  --design-${kebab(k)}: ${v};`).join('\n') + `\n  --design-radius: ${s.radius}px;\n  --design-space: ${s.spacing === 'compact' ? 4 : 8}px;\n  --design-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\n}\n`;
}
function legacyMarkdown(r: DesignRevision): string {
  const s = r.system as LegacyDesignSystem;
  return `# ${s.name}\n\nDesign contract v${r.version} · SHA-256 ${r.hash}\n\n${s.direction}\n\n## Tokens\n\n` + Object.entries(s.colors).map(([k, v]) => `- ${k}: \`${v}\` (CSS: --design-${kebab(k)})`).join('\n') + `\n\n## Layout and components\n\nTypography: ${s.typography === 'editorial' ? 'serif display headings, system sans body' : 'system sans, monospace only for code'}. Spacing: ${s.spacing === 'compact' ? '4' : '8'} px base. Radius: ${s.radius} px. Motion: ${s.motion}; honor reduced motion.\n\nUse semantic controls, readable contrast, visible focus, keyboard operation, and complete loading/empty/error states. Mobile targets: 44 px. Keep content readable at 200% zoom.\n\n${s.rules}\n\n## Enforcement\n\nRead this exact revision before UI work. Use the supplied tokens. Any visual exception needs a human design decision and a recorded rationale. Include the design revision and viewport/check evidence in handoffs. Skill references guide execution; this project contract controls its visual identity.\n`;
}
