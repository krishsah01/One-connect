// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Design-system foundations: typed tokens with strict value grammars, light/dark resolution through
// aliases, layout settings, the content guide and a generator for complete starter foundations.
// Values are validated so a token can never smuggle a URL, expression or arbitrary CSS into a page.
import { z } from 'zod';
import type { DesignContentGuide, DesignSettings, DesignTokenType, DesignTokenValue } from './designDocumentTypes.ts';

export const DESIGN_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,95}$/;
const RESERVED = new Set(['constructor', 'prototype', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']);
export const designId = () => z.string().regex(DESIGN_ID_RE, 'Use letters, numbers, dashes or underscores, starting with a letter').refine(v => !RESERVED.has(v), 'Reserved name');

export const TOKEN_TYPES = ['color', 'dimension', 'font', 'fontWeight', 'lineHeight', 'letterSpacing', 'shadow', 'duration', 'easing', 'opacity', 'layer', 'number'] as const satisfies readonly DesignTokenType[];

const COLOR_RE = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const FONT_NAME = '[A-Za-z][A-Za-z0-9 -]{0,40}';
const FONT_RE = new RegExp(`^${FONT_NAME}(?:, ?${FONT_NAME}){0,5}$`);
const SHADOW_LAYER = '(?:inset )?-?\\d{1,3}px -?\\d{1,3}px \\d{1,3}px(?: -?\\d{1,3}px)? #[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?';
const SHADOW_RE = new RegExp(`^(?:none|${SHADOW_LAYER}(?:, ?${SHADOW_LAYER}){0,2})$`);
const EASING_RE = /^(?:linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\((?:-?(?:0|1|2)?(?:\.\d{1,3})?, ?){3}-?(?:0|1|2)?(?:\.\d{1,3})?\))$/;

/** Whether `value` is valid for a token of `type`. Numbers and strings are never coerced. */
export function validTokenValue(type: DesignTokenType, value: unknown): boolean {
  const num = (min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  switch (type) {
    case 'color': return typeof value === 'string' && COLOR_RE.test(value);
    case 'dimension': return num(0, 10000);
    case 'font': return typeof value === 'string' && FONT_RE.test(value);
    case 'fontWeight': return num(100, 900) && (value as number) % 100 === 0;
    case 'lineHeight': return num(0.8, 3);
    case 'letterSpacing': return num(-0.1, 0.5);
    case 'shadow': return typeof value === 'string' && SHADOW_RE.test(value);
    case 'duration': return num(0, 5000);
    case 'easing': return typeof value === 'string' && EASING_RE.test(value);
    case 'opacity': return num(0, 1);
    case 'layer': return num(0, 10000) && Number.isInteger(value);
    case 'number': return num(-10000, 10000);
  }
}

const source = z.object({ kitId: z.string().regex(/^kit_[A-Za-z0-9_-]{1,64}$/), version: z.number().int().positive() }).strict();
export const DesignTokenSchema = z.object({
  type: z.enum(TOKEN_TYPES),
  value: z.union([z.string().max(200), z.number().finite()]),
  dark: z.union([z.string().max(200), z.number().finite()]).optional(),
  alias: designId().optional(),
  darkAlias: designId().optional(),
  description: z.string().max(500),
  tier: z.enum(['primitive', 'semantic']).optional(),
  category: designId().optional(),
  source: source.optional(),
}).strict().superRefine((t, ctx) => {
  for (const [key, value] of [['value', t.value], ['dark', t.dark]] as const) {
    if (value !== undefined && !validTokenValue(t.type, value)) ctx.addIssue({ code: 'custom', path: [key], message: `Not a valid ${t.type} value` });
  }
});

/** Resolve a token for one theme, following aliases. Undefined for missing or cyclic references. */
export function resolveToken(tokens: Record<string, DesignTokenValue>, key: string, dark = false): string | number | undefined {
  const seen = new Set<string>();
  let current = key;
  for (;;) {
    if (seen.has(current) || seen.size > 32) return undefined;
    seen.add(current);
    const t = Object.hasOwn(tokens, current) ? tokens[current] : undefined;
    if (!t) return undefined;
    if (dark && t.darkAlias) { current = t.darkAlias; continue; }
    if (dark && t.dark !== undefined) return t.dark;
    if (t.alias) { current = t.alias; continue; }
    return t.value;
  }
}

/** Alias problems for one token: missing target, cycle, or a target of another type. */
export function tokenAliasProblem(tokens: Record<string, DesignTokenValue>, key: string): string | null {
  const t = tokens[key];
  for (const [label, target] of [['alias', t.alias], ['dark alias', t.darkAlias]] as const) {
    if (!target) continue;
    const other = Object.hasOwn(tokens, target) ? tokens[target] : undefined;
    if (!other) return `${label} points to a missing token`;
    if (other.type !== t.type) return `${label} points to a ${other.type} token`;
  }
  for (const dark of [false, true]) if (resolveToken(tokens, key, dark) === undefined) return 'aliases form a loop';
  return null;
}

export const DesignFoundationsSchema = z.record(designId(), DesignTokenSchema).superRefine((tokens, ctx) => {
  if (Object.keys(tokens).length > 2000) ctx.addIssue({ code: 'custom', message: 'A system supports at most 2,000 tokens' });
  for (const key of Object.keys(tokens)) {
    const problem = tokenAliasProblem(tokens, key);
    if (problem) ctx.addIssue({ code: 'custom', path: [key], message: `Invalid alias for ${key}: ${problem}` });
  }
});

/** A token's resolved value as CSS. Every type has a fixed unit; validated values are safe to emit. */
export function tokenCss(type: DesignTokenType, value: string | number): string {
  switch (type) {
    case 'dimension': return `${value}px`;
    case 'letterSpacing': return `${value}em`;
    case 'duration': return `${value}ms`;
    default: return String(value);
  }
}

/** `--ds-<id>` custom properties for one theme. Unresolvable tokens are skipped (and reported elsewhere). */
export function foundationVariables(tokens: Record<string, DesignTokenValue>, dark = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, t] of Object.entries(tokens)) {
    const v = resolveToken(tokens, key, dark);
    if (v !== undefined && validTokenValue(t.type, v)) out[`--ds-${key}`] = tokenCss(t.type, v);
  }
  return out;
}

export const DesignSettingsSchema = z.object({
  breakpoints: z.object({ phone: z.number().int().min(320).max(1200), tablet: z.number().int().min(480).max(1800) }).strict().refine(b => b.phone < b.tablet, 'The phone breakpoint must be smaller than the tablet breakpoint'),
  density: z.enum(['compact', 'comfortable', 'spacious']),
  container: z.number().int().min(480).max(2400),
  grid: z.object({ columns: z.number().int().min(1).max(24), gutter: z.number().int().min(0).max(200) }).strict(),
  motion: z.enum(['full', 'reduced']),
}).strict();

const copy = (max: number) => z.string().max(max);
export const DesignContentGuideSchema = z.object({
  voice: copy(1000),
  terms: z.array(z.object({ use: copy(60), avoid: copy(200) }).strict()).max(60),
  formats: z.object({ date: copy(60), number: copy(60), currency: copy(60) }).strict(),
  states: z.object({ empty: copy(300), loading: copy(300), error: copy(300), permission: copy(300), offline: copy(300) }).strict(),
  helperText: copy(500),
  errorText: copy(500),
}).strict();

export const DEFAULT_SETTINGS: DesignSettings = { breakpoints: { phone: 600, tablet: 1024 }, density: 'comfortable', container: 1200, grid: { columns: 12, gutter: 24 }, motion: 'full' };
export const DEFAULT_CONTENT: DesignContentGuide = {
  voice: 'Clear, warm and direct. Lead with what people can do next; avoid jargon and exclamation marks.',
  terms: [{ use: 'Sign in', avoid: 'Log in, Login' }, { use: 'Delete', avoid: 'Remove (for permanent actions)' }],
  formats: { date: 'Oct 10, 2026', number: '1,234.5', currency: '$1,234.50' },
  states: {
    empty: 'Nothing here yet. Add your first item to get started.',
    loading: 'Loading your content…',
    error: 'We couldn’t load this. Check your connection and try again.',
    permission: 'You need access to view this. Ask an owner to share it with you.',
    offline: 'You’re offline. Your work is safe and will sync when you reconnect.',
  },
  helperText: 'Use sentence case. Say what the field is for and give an example when the format matters.',
  errorText: 'Say what went wrong and how to fix it, in plain words. Never blame the person.',
};

// ---- color math ---------------------------------------------------------------------------------

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
export function luminanceOf(hex: string): number {
  const c = channels(hex).map(x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** WCAG contrast ratio of two opaque six-digit colors (alpha digits are ignored). */
export function contrastRatio(a: string, b: string): number {
  const x = luminanceOf(a.slice(0, 7)), y = luminanceOf(b.slice(0, 7));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
export function hslToHex(h: number, s: number, l: number): string {
  const sat = Math.min(100, Math.max(0, s)) / 100, light = Math.min(100, Math.max(0, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12, a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// ---- generated foundations ------------------------------------------------------------------------

export type DesignTone = 'calm' | 'bold' | 'warm' | 'minimal' | 'playful';
export type DesignTypeface = 'system' | 'humanist' | 'geometric' | 'serif' | 'mono';
export interface FoundationInput { brand: string; tone: DesignTone; typeface?: DesignTypeface; density?: DesignSettings['density'] }

export const TONES: Record<DesignTone, { label: string; summary: string; radius: [number, number, number]; scale: number; heading: number; shadow: boolean; saturation: number; typeface: DesignTypeface }> = {
  calm: { label: 'Calm and trustworthy', summary: 'Quiet surfaces, generous spacing and one confident accent.', radius: [6, 10, 14], scale: 1.2, heading: 600, shadow: true, saturation: 1, typeface: 'system' },
  bold: { label: 'Bold and energetic', summary: 'High contrast, strong headings and saturated actions.', radius: [4, 8, 12], scale: 1.25, heading: 700, shadow: true, saturation: 1.15, typeface: 'geometric' },
  warm: { label: 'Warm and friendly', summary: 'Soft corners, warm neutrals and approachable type.', radius: [8, 14, 20], scale: 1.2, heading: 600, shadow: true, saturation: 0.9, typeface: 'humanist' },
  minimal: { label: 'Minimal and precise', summary: 'Flat surfaces, crisp lines and restrained color.', radius: [2, 4, 6], scale: 1.18, heading: 600, shadow: false, saturation: 0.7, typeface: 'system' },
  playful: { label: 'Playful and expressive', summary: 'Rounded shapes, lively color and a larger type scale.', radius: [10, 16, 24], scale: 1.3, heading: 700, shadow: true, saturation: 1.1, typeface: 'geometric' },
};
export const TYPEFACES: Record<DesignTypeface, { label: string; stack: string }> = {
  system: { label: 'System sans', stack: 'system-ui, sans-serif' },
  humanist: { label: 'Humanist sans', stack: 'Avenir Next, Segoe UI, system-ui, sans-serif' },
  geometric: { label: 'Geometric sans', stack: 'Futura, Century Gothic, system-ui, sans-serif' },
  serif: { label: 'Editorial serif', stack: 'Iowan Old Style, Georgia, serif' },
  mono: { label: 'Technical mono', stack: 'SF Mono, Menlo, Consolas, monospace' },
};

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const LIGHTNESS = [97, 93, 85, 74, 62, 52, 43, 35, 27, 19, 12];

/** Complete foundations (palette, semantic colors, type, spacing, shape, elevation, motion, layers). */
export function generateFoundations(input: FoundationInput): Record<string, DesignTokenValue> {
  const tone = TONES[input.tone], brand = COLOR_RE.test(input.brand) ? input.brand.slice(0, 7).toLowerCase() : '#3456cb';
  const [h, s] = hexToHsl(brand), sat = Math.min(95, Math.max(30, s * tone.saturation));
  const tokens: Record<string, DesignTokenValue> = {};
  const add = (key: string, t: Omit<DesignTokenValue, 'description'> & { description?: string }) => { tokens[key] = { description: t.description ?? key, ...t }; };
  const scale = (name: string, hue: number, saturation: number) => STEPS.forEach((step, i) => add(`${name}-${step}`, { type: 'color', value: hslToHex(hue, saturation, LIGHTNESS[i]), tier: 'primitive', category: 'palette', description: `${name} ${step}` }));
  scale('brand', h, sat);
  scale('neutral', h, input.tone === 'warm' ? 14 : input.tone === 'minimal' ? 4 : 9);
  scale('green', 145, 55); scale('amber', 38, 85); scale('red', 4, 70); scale('blue', 212, 70);
  const pick = (name: string, against: string, from: number[]) => {
    for (const step of from) if (contrastRatio(String(tokens[`${name}-${step}`].value), against) >= 4.5) return `${name}-${step}`;
    return `${name}-${from.at(-1)}`;
  };
  const semantic = (key: string, light: string, dark: string, description: string) => add(key, { type: 'color', value: tokens[light].value, alias: light, darkAlias: dark, tier: 'semantic', category: 'color-role', description });
  const surfaceLight = '#ffffff', surfaceDark = String(tokens['neutral-900'].value);
  add('white', { type: 'color', value: '#ffffff', tier: 'primitive', category: 'palette', description: 'Pure white' });
  add('transparent', { type: 'color', value: '#ffffff00', tier: 'primitive', category: 'palette', description: 'No fill; shows what is behind.' });
  semantic('canvas', 'neutral-50', 'neutral-950', 'Page background behind everything.');
  semantic('surface', 'white', 'neutral-900', 'Cards, panels, inputs and tables.');
  semantic('surface-subtle', 'neutral-100', 'neutral-800', 'Hover rows, wells and secondary buttons.');
  semantic('text', 'neutral-900', 'neutral-50', 'Primary text and icons.');
  semantic('text-muted', pick('neutral', surfaceLight, [600, 700, 800]), pick('neutral', surfaceDark, [300, 200, 100]), 'Secondary text, help and metadata.');
  semantic('border', 'neutral-200', 'neutral-700', 'Dividers and card outlines.');
  semantic('border-strong', pick('neutral', surfaceLight, [500, 600]), 'neutral-400', 'Input boundaries and focusable outlines.');
  const accentLight = pick('brand', surfaceLight, [600, 700, 800, 900]), accentDark = pick('brand', surfaceDark, [300, 200, 100, 50]);
  semantic('accent', accentLight, accentDark, 'Primary actions, links and selection.');
  const onAccent = (step: string) => contrastRatio(String(tokens[step].value), '#ffffff') >= contrastRatio(String(tokens[step].value), String(tokens['neutral-950'].value)) ? 'white' : 'neutral-950';
  semantic('on-accent', onAccent(accentLight), onAccent(accentDark), 'Text and icons placed on the accent color.');
  semantic('accent-subtle', 'brand-100', 'brand-900', 'Selected and highlighted backgrounds.');
  semantic('focus', accentLight, accentDark, 'Keyboard focus ring.');
  for (const [role, name, description] of [['success', 'green', 'Success text and icons.'], ['warning', 'amber', 'Warning text and icons.'], ['danger', 'red', 'Errors and destructive actions.'], ['info', 'blue', 'Neutral notices.']] as const) {
    semantic(role, pick(name, surfaceLight, [600, 700, 800]), pick(name, surfaceDark, [400, 300, 200]), `${description} Always paired with a word or icon.`);
    semantic(`${role}-subtle`, `${name}-50`, `${name}-950`, `Background for ${role} notices.`);
  }
  semantic('on-danger', onAccent(String(tokens.danger.alias)), onAccent(String(tokens.danger.darkAlias)), 'Text placed on the danger color.');

  const face = TYPEFACES[input.typeface ?? tone.typeface];
  add('font-body', { type: 'font', value: face.stack, category: 'typography', description: 'Body and interface text.' });
  add('font-heading', { type: 'font', value: input.typeface === 'serif' || input.tone === 'warm' && input.typeface === undefined ? TYPEFACES.serif.stack : face.stack, category: 'typography', description: 'Headings.' });
  add('font-mono', { type: 'font', value: TYPEFACES.mono.stack, category: 'typography', description: 'Code and tabular figures.' });
  for (const [key, value] of [['weight-regular', 400], ['weight-medium', 500], ['weight-semibold', 600], ['weight-bold', 700], ['weight-heading', tone.heading]] as const) add(key, { type: 'fontWeight', value, category: 'typography', description: key.replace('weight-', '') });
  const sizes = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'];
  sizes.forEach((size, i) => add(`text-${size}`, { type: 'dimension', value: Math.round(16 * tone.scale ** (i - 2)), category: 'type-scale', description: `Text size ${size}` }));
  add('leading-tight', { type: 'lineHeight', value: 1.2, category: 'typography', description: 'Headings and large numbers.' });
  add('leading-normal', { type: 'lineHeight', value: 1.5, category: 'typography', description: 'Body text.' });
  add('tracking-tight', { type: 'letterSpacing', value: -0.02, category: 'typography', description: 'Large headings.' });
  add('tracking-normal', { type: 'letterSpacing', value: 0, category: 'typography', description: 'Body text.' });
  add('tracking-wide', { type: 'letterSpacing', value: 0.06, category: 'typography', description: 'Small uppercase labels.' });

  const density = { compact: 0.75, comfortable: 1, spacious: 1.25 }[input.density ?? 'comfortable'];
  [4, 8, 12, 16, 24, 32, 48, 64].forEach((px, i) => add(`space-${i + 1}`, { type: 'dimension', value: Math.round(px * density), category: 'spacing', description: `Spacing step ${i + 1}` }));
  const [sm, md, lg] = tone.radius;
  add('radius-sm', { type: 'dimension', value: sm, category: 'radius', description: 'Badges and small controls.' });
  add('radius-md', { type: 'dimension', value: md, category: 'radius', description: 'Buttons, inputs and menus.' });
  add('radius-lg', { type: 'dimension', value: lg, category: 'radius', description: 'Cards, dialogs and drawers.' });
  add('radius-full', { type: 'dimension', value: 999, category: 'radius', description: 'Pills and avatars.' });
  add('border-width', { type: 'dimension', value: 1, category: 'border', description: 'Default border width.' });
  add('shadow-sm', { type: 'shadow', value: tone.shadow ? '0px 1px 2px #1018280f' : 'none', category: 'elevation', description: 'Raised controls.' });
  add('shadow-md', { type: 'shadow', value: tone.shadow ? '0px 4px 12px #1018281a' : 'none', category: 'elevation', description: 'Cards and menus.' });
  add('shadow-lg', { type: 'shadow', value: tone.shadow ? '0px 16px 40px #10182829' : '0px 0px 0px 1px #10182833', category: 'elevation', description: 'Dialogs and drawers.' });
  add('opacity-disabled', { type: 'opacity', value: 0.5, category: 'opacity', description: 'Disabled controls.' });
  add('opacity-scrim', { type: 'opacity', value: 0.48, category: 'opacity', description: 'Backdrop behind dialogs.' });
  add('layer-dropdown', { type: 'layer', value: 100, category: 'layering', description: 'Menus and tooltips.' });
  add('layer-overlay', { type: 'layer', value: 200, category: 'layering', description: 'Dialogs and drawers.' });
  add('layer-toast', { type: 'layer', value: 300, category: 'layering', description: 'Notifications.' });
  add('duration-fast', { type: 'duration', value: 120, category: 'motion', description: 'Hover and press feedback.' });
  add('duration-normal', { type: 'duration', value: 200, category: 'motion', description: 'Menus, tabs and small transitions.' });
  add('duration-slow', { type: 'duration', value: 320, category: 'motion', description: 'Dialogs, drawers and page transitions.' });
  add('ease-standard', { type: 'easing', value: 'cubic-bezier(0.2, 0, 0, 1)', category: 'motion', description: 'Most transitions.' });
  add('ease-enter', { type: 'easing', value: 'cubic-bezier(0, 0, 0.2, 1)', category: 'motion', description: 'Elements entering.' });
  add('ease-exit', { type: 'easing', value: 'cubic-bezier(0.4, 0, 1, 1)', category: 'motion', description: 'Elements leaving.' });
  return tokens;
}

/** Token ids grouped by the builder's sections, in display order. */
export function foundationSections(tokens: Record<string, DesignTokenValue>) {
  const sections: { id: string; label: string; match: (t: DesignTokenValue) => boolean }[] = [
    { id: 'roles', label: 'Color roles', match: t => t.type === 'color' && t.tier !== 'primitive' },
    { id: 'palette', label: 'Palette', match: t => t.type === 'color' && t.tier === 'primitive' },
    { id: 'type', label: 'Typography', match: t => ['font', 'fontWeight', 'lineHeight', 'letterSpacing'].includes(t.type) || t.category === 'type-scale' },
    { id: 'space', label: 'Spacing and size', match: t => t.type === 'dimension' && t.category !== 'radius' && t.category !== 'border' && t.category !== 'type-scale' },
    { id: 'shape', label: 'Corners, borders and shadows', match: t => t.type === 'shadow' || t.category === 'radius' || t.category === 'border' || t.type === 'opacity' || t.type === 'layer' },
    { id: 'motion', label: 'Motion', match: t => t.type === 'duration' || t.type === 'easing' },
    { id: 'other', label: 'Other', match: () => true },
  ];
  const used = new Set<string>();
  return sections.map(s => {
    const ids = Object.entries(tokens).filter(([key, t]) => !used.has(key) && s.match(t)).map(([key]) => key);
    ids.forEach(k => used.add(k));
    return { id: s.id, label: s.label, ids };
  }).filter(s => s.ids.length);
}
