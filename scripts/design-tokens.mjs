// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Compiles design/tokens.json (the One Connect design system, mirrored from the Design System artifact)
// into packages/web/src/tokens.css. Theme ids map onto <html> attributes:
//   data-theme="light|dark" (absent = follow the system), data-vision="cb" (colour-blind safe), data-contrast="high".
// Run: node scripts/design-tokens.mjs   (add --check to fail when the file is stale)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'design', 'tokens.json');
const out = path.join(root, 'packages', 'web', 'src', 'tokens.css');
const t = JSON.parse(readFileSync(src, 'utf8'));
const first = t.color.themes[0].id;
const val = (tok, id) => (typeof tok.value === 'string' ? tok.value : tok.value[id] ?? tok.value[first]);
const perTheme = [...t.color.tokens, ...t.shadow.tokens];
const block = (id, indent = '  ') => perTheme.map(k => `${indent}--${k.name}: ${val(k, id)};`).join('\n');
// Only the lines that differ from a base theme, so the cascade stays small.
const diff = (id, base, indent = '  ') => perTheme.filter(k => val(k, id) !== val(k, base)).map(k => `${indent}--${k.name}: ${val(k, id)};`).join('\n');

const light = { id: 'light', vision: 'cb-light', contrast: 'hc-light' };
const dark = { id: 'dark', vision: 'cb-dark', contrast: 'hc-dark' };
const modeRules = (m, selector) => [
  `${selector} {\n${m.id === 'light' ? block(m.id) : diff(m.id, 'light')}\n}`,
  `${selector}[data-vision='cb'] {\n${diff(m.vision, m.id)}\n}`,
  `${selector}[data-contrast='high'] {\n${diff(m.contrast, m.id)}\n}`,
  `${selector}[data-vision='cb'][data-contrast='high'] {\n${diff(m.contrast, m.id)}\n${diff(m.vision, m.id)}\n}`,
].join('\n');

const scales = [...t.spacing.tokens, ...t.radius.tokens, ...t.duration.tokens, ...t.easing.tokens].map(k => `  --${k.name}: ${k.value};`).join('\n');
const fonts = Object.entries(t.type.families).map(([k, v]) => `  --font-${k}: ${v};`).join('\n');
const styles = t.type.groups.flatMap(g => g.styles.map(s => `.${s.name} { font: ${s.fontWeight} ${s.fontSize}/${s.lineHeight} var(--font-${s.family ?? g.family});${s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : ''}${s.name === 'overline' ? ' text-transform: uppercase;' : ''} }`)).join('\n');

const css = `/* SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0 */
/* GENERATED from design/tokens.json by scripts/design-tokens.mjs. Edit the JSON, not this file. */
:root {
  color-scheme: light dark;
${scales}
${fonts}
}
${modeRules(light, ':root')}
@media (prefers-color-scheme: dark) {
${modeRules(dark, ':root:not([data-theme=\'light\'])').replace(/^/gm, '  ').replace(/^ {2}(\s*--)/gm, '  $1')}
}
${modeRules(dark, ":root[data-theme='dark']")}
${styles}
`;
if (process.argv.includes('--check')) {
  let cur = ''; try { cur = readFileSync(out, 'utf8'); } catch { /* missing */ }
  if (cur !== css) { console.error('packages/web/src/tokens.css is stale: run node scripts/design-tokens.mjs'); process.exit(1); }
  console.log('tokens.css is current');
} else {
  writeFileSync(out, css);
  console.log(`wrote ${path.relative(root, out)}: ${t.color.tokens.length} colours × ${t.color.themes.length} themes`);
}
