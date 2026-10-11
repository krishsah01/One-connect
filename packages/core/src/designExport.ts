// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Portable React/TypeScript source package for a structured design: the same runtime and component
// definitions the previews use, typed component and screen wrappers with props and callbacks, CSS
// variables, fixtures, assets and usage notes. Pure: callers supply the runtime and types sources.
import { foundationVariables } from './designFoundations.ts';
import type { DesignDocument } from './designDocumentTypes.ts';

export interface SourcePackageInput {
  document: DesignDocument;
  /** DocumentRenderer.tsx, copied verbatim apart from its type import. */
  runtimeSource: string;
  /** designDocumentTypes.ts, copied verbatim. */
  typesSource: string;
  status: 'draft' | 'release';
  release?: { artifactId: string; rev: number; documentHash: string; systemHash: string | null };
}
export interface SourcePackage {
  /** Text files by path. */
  files: Record<string, string>;
  /** Binary assets by path: the caller supplies the bytes from content-addressed storage. */
  assets: Record<string, { hash: string; mime: string }>;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const RESERVED = new Set(['variant', 'state', 'dark', 'width', 'onAction', 'assetUrl', 'children', 'key', 'ref', 'document', 'fixtures', 'class', 'default', 'function', 'new', 'delete', 'return', 'import', 'export', 'this', 'var', 'let', 'const', 'in', 'of', 'if', 'for', 'while', 'switch', 'case', 'do', 'else', 'try', 'catch', 'finally', 'throw', 'typeof', 'void', 'with', 'yield', 'await', 'enum', 'super', 'extends', 'static', 'public', 'private', 'protected', 'interface', 'package', 'implements']);
const words = (s: string) => s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
export const pascal = (s: string) => { const w = words(s).map(x => x[0].toUpperCase() + x.slice(1)).join(''); return /^[A-Za-z]/.test(w) ? w : `Design${w}`; };
export const camel = (s: string) => { const p = pascal(s); return p[0].toLowerCase() + p.slice(1); };
const str = (s: string) => JSON.stringify(s);
const doc = (s: string) => s.replace(/\*\//g, '*\\/').replace(/\s+/g, ' ').trim();
const kebab = (s: string) => words(s).join('-').toLowerCase() || 'design';

/** Unique identifiers from labels, avoiding reserved words and each other. */
function namer(taken: Iterable<string> = []) {
  const used = new Set(taken);
  return (label: string, make = camel) => {
    let base = make(label) || 'item';
    if (RESERVED.has(base)) base = `${base}Value`;
    let name = base, n = 2;
    while (used.has(name)) name = `${base}${n++}`;
    used.add(name);
    return name;
  };
}

/** CSS custom properties for both themes plus a reduced-motion override. */
export function tokensCss(d: DesignDocument): string {
  const block = (sel: string, vars: Record<string, string>) => `${sel} {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`;
  return `/* ${d.name}: generated from the structured design. Edit the design in One Connect, not this file. */\n`
    + block(':root', foundationVariables(d.tokens, false))
    + block('[data-theme="dark"]', foundationVariables(d.tokens, true))
    + '@media (prefers-reduced-motion: reduce) {\n  :root { --ds-duration-fast: 1ms; --ds-duration-normal: 1ms; --ds-duration-slow: 1ms; }\n}\n';
}

export function designSourcePackage(input: SourcePackageInput): SourcePackage {
  const d = input.document;
  const files: Record<string, string> = {};
  const assets: SourcePackage['assets'] = {};
  const packageName = `${kebab(d.name)}-design`;
  const componentName = namer(['Design', 'DocumentRenderer', 'ComponentRenderer', 'Icon']);
  const screenName = namer(['Design', 'DocumentRenderer']);

  files['src/types.ts'] = input.typesSource;
  files['src/runtime/DocumentRenderer.tsx'] = input.runtimeSource.replace(/from '@acc\/core'/g, "from '../types'");
  files['src/design.json'] = JSON.stringify(d, null, 2) + '\n';
  files['src/document.ts'] = `import design from './design.json';\nimport type { DesignDocument } from './types';\n\n/** The design as structured data. The runtime draws everything from it. */\nexport const document = design as unknown as DesignDocument;\n`;
  files['src/tokens.css'] = tokensCss(d);
  files['src/fixtures.ts'] = `/** Sample data used by the prototype. Pass your own values through the \`fixtures\` prop. */\nexport const fixtures: Record<string, string> = ${JSON.stringify(d.fixtures, null, 2)};\n`;

  for (const a of Object.values(d.assets)) if (!a.reference) assets[`assets/${a.hash}.${EXT[a.mime] ?? 'bin'}`] = { hash: a.hash, mime: a.mime };
  files['src/assets.ts'] = `/** Resolves image ids to the bundled files in ../assets (works with Vite, webpack 5 and other ESM bundlers). */\nconst files: Record<string, string> = {\n${Object.values(d.assets).filter(a => !a.reference).map(a => `  ${str(a.id)}: new URL(${str(`../assets/${a.hash}.${EXT[a.mime] ?? 'bin'}`)}, import.meta.url).href,`).join('\n')}\n};\nexport const assetUrl = (id: string): string | undefined => files[id];\n`;

  const componentDocs: string[] = [];
  const exports: string[] = [];
  const names = { component: '', screen: '' };
  for (const c of Object.values(d.components)) {
    const name = componentName(c.name, pascal);
    const propName = namer();
    const props = (c.props ?? []).map(p => ({ ...p, key: propName(p.label || p.id) }));
    const slots = (c.slots ?? []).filter(s => d.nodes[s]).map(s => ({ id: s, key: propName(d.nodes[s].name || s), label: d.nodes[s].name }));
    const variants = Object.keys(c.variants), states = Object.keys(c.states ?? {});
    const lines = [
      `import type { ReactNode } from 'react';`,
      `import { ComponentRenderer, type DesignActionEvent } from '../runtime/DocumentRenderer';`,
      `import { document } from '../document';`,
      `import { assetUrl } from '../assets';`,
      ``,
      ...(variants.length ? [`export type ${name}Variant = ${variants.map(str).join(' | ')};`] : []),
      ...(states.length ? [`export type ${name}State = ${states.map(str).join(' | ')};`] : []),
      ``,
      `export interface ${name}Props {`,
      ...props.map(p => `  /** ${doc(p.label)}${p.defaultValue ? ` (default: ${doc(p.defaultValue)})` : ''} */\n  ${p.key}?: ${p.field === 'hidden' ? 'boolean' : 'string'};`),
      ...slots.map(s => `  /** Content for the “${doc(s.label)}” slot. */\n  ${s.key}?: ReactNode;`),
      ...(variants.length ? [`  variant?: ${name}Variant;`] : []),
      ...(states.length ? [`  state?: ${name}State;`] : []),
      `  /** Use the dark theme. */`, `  dark?: boolean;`,
      `  /** Width used for responsive layout; measured from the container when omitted. */`, `  width?: number;`,
      `  /** Called for every click, change and submit inside the component. */`, `  onAction?: (event: DesignActionEvent) => void;`,
      `}`,
      ``,
      `/**`, ` * ${doc(c.description || c.name)}`, ...(c.usage ? [` *`, ` * Usage: ${doc(c.usage)}`] : []), ...(c.accessibility ? [` *`, ` * Accessibility: ${doc(c.accessibility)}`] : []), ` */`,
      `export function ${name}({ ${[...props.map(p => p.key), ...slots.map(s => s.key), ...(variants.length ? ['variant'] : []), ...(states.length ? ['state'] : []), 'dark', 'width', 'onAction'].join(', ')} }: ${name}Props) {`,
      `  return (`,
      `    <ComponentRenderer`,
      `      document={document}`,
      `      componentId=${str(c.id)}`,
      ...(variants.length ? [`      variant={variant}`] : []),
      ...(states.length ? [`      state={state}`] : []),
      `      values={{ ${props.map(p => `${str(p.id)}: ${p.field === 'hidden' ? `${p.key} === undefined ? undefined : String(${p.key})` : p.key}`).join(', ')} }}`,
      ...(slots.length ? [`      slots={{ ${slots.map(s => `${str(s.id)}: ${s.key}`).join(', ')} }}`] : []),
      `      dark={dark}`, `      width={width}`, `      onAction={onAction}`, `      assetUrl={assetUrl}`,
      `    />`,
      `  );`,
      `}`,
      ``,
    ];
    files[`src/components/${name}.tsx`] = lines.join('\n');
    names.component ||= name;
    exports.push(`export { ${name}, type ${name}Props${variants.length ? `, type ${name}Variant` : ''}${states.length ? `, type ${name}State` : ''} } from './components/${name}';`);
    componentDocs.push(`### ${name}\n\n${c.description || c.name}${c.usage ? `\n\n${c.usage}` : ''}\n\n| Prop | Type | Notes |\n|---|---|---|\n${[...props.map(p => `| \`${p.key}\` | ${p.field === 'hidden' ? 'boolean' : 'string'} | ${p.label} |`), ...slots.map(s => `| \`${s.key}\` | ReactNode | “${s.label}” slot |`), ...(variants.length ? [`| \`variant\` | ${variants.map(v => `\`${v}\``).join(', ')} | |`] : []), ...(states.length ? [`| \`state\` | ${states.map(v => `\`${v}\``).join(', ')} | |`] : []), '| `onAction` | (event) => void | Clicks, changes and submits |'].join('\n')}${c.accessibility ? `\n\nAccessibility: ${c.accessibility}` : ''}`);
  }

  const screenDocs: string[] = [];
  for (const s of d.screens) {
    const name = screenName(`${s.name} screen`, pascal);
    files[`src/screens/${name}.tsx`] = [
      `import { DocumentRenderer, type DocumentRendererProps } from '../runtime/DocumentRenderer';`,
      `import { document } from '../document';`,
      `import { assetUrl } from '../assets';`,
      ``,
      `export type ${name}Props = Omit<DocumentRendererProps, 'document' | 'screenId'>;`,
      ``,
      `/** ${doc(s.description || `The “${s.name}” ${s.kind === 'dialog' ? 'dialog' : s.kind === 'drawer' ? 'drawer' : 'screen'}`)}. Its prototype links stay live: navigation, overlays and validation run locally. */`,
      `export function ${name}(props: ${name}Props) {`,
      `  return <DocumentRenderer document={document} screenId=${str(s.id)} assetUrl={assetUrl} {...props} />;`,
      `}`,
      ``,
    ].join('\n');
    exports.push(`export { ${name}, type ${name}Props } from './screens/${name}';`);
    names.screen ||= name;
    screenDocs.push(`- \`${name}\`: ${s.name}${s.kind && s.kind !== 'page' ? ` (${s.kind})` : ''}. Designed states: ${s.states.join(', ')}.`);
  }

  files['src/index.ts'] = [
    `export { DocumentRenderer, ComponentRenderer, Icon, designVariables, type DocumentRendererProps, type DesignActionEvent } from './runtime/DocumentRenderer';`,
    `export { document } from './document';`,
    `export { fixtures } from './fixtures';`,
    `export { assetUrl } from './assets';`,
    `export type * from './types';`,
    ...exports,
    ``,
  ].join('\n');

  files['package.json'] = JSON.stringify({
    name: packageName, version: input.release ? `0.${input.release.rev}.0` : '0.0.0-draft', private: true, type: 'module',
    description: `${d.name}: design system components and screens exported from One Connect Designer.`,
    exports: { '.': './src/index.ts', './tokens.css': './src/tokens.css' }, files: ['src', 'assets', 'README.md'],
    peerDependencies: { react: '>=19' }, devDependencies: { '@types/react': '^19', typescript: '^5.9' }, scripts: { typecheck: 'tsc --noEmit' },
  }, null, 2) + '\n';
  files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2023', lib: ['ES2023', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, resolveJsonModule: true, esModuleInterop: true, skipLibCheck: true, noEmit: true }, include: ['src'] }, null, 2) + '\n';

  const status = input.status === 'release' && input.release
    ? `**Release:** artifact \`${input.release.artifactId}\` revision ${input.release.rev}. Document SHA-256 \`${input.release.documentHash}\`${input.release.systemHash ? `, design system \`${input.release.systemHash}\`` : ''}. The approval status of this release is recorded in the handoff manifest, not in this package.`
    : '> **Draft export for exploration.** This package was exported from an unapproved draft. It is not an approved release; don’t treat it as the design to implement.';
  files['README.md'] = `# ${d.name}

${status}

${d.direction || ''}

## What’s inside

- \`src/components\`: one React component per reusable design component, with typed props, variants, states and slots.
- \`src/screens\`: every screen as a component. Prototype links (navigation, dialogs, validation, sample data) keep working.
- \`src/tokens.css\`: the design tokens as CSS variables for light (\`:root\`) and dark (\`[data-theme="dark"]\`) themes.
- \`src/design.json\`: the structured design. The runtime in \`src/runtime\` draws everything from it, exactly as the Designer preview does.
- \`src/fixtures.ts\`: the sample data used by the prototype. \`assets/\`: bundled images.

## Use it

\`\`\`tsx
import { ${names.screen} } from '${packageName}';

export function Example() {
  return <${names.screen} onAction={e => console.log(e.nodeId, e.event, e.value)} />;
}
\`\`\`

- **Themes:** pass \`dark\` to any component or screen. To use the variables in your own CSS, import \`${packageName}/tokens.css\` and set \`data-theme="dark"\` on an ancestor.
- **Responsive layout:** components measure their container. Pass \`width\` to force a breakpoint (phone below ${d.settings.breakpoints.phone}px, tablet below ${d.settings.breakpoints.tablet}px).
- **Real data:** pass \`fixtures\` to a screen to replace sample values, and handle \`onAction\` to connect clicks, changes and form submissions to your application.
- **States:** pass \`contentState\` (\`empty\`, \`loading\`, \`error\`, \`partial\`, \`permission\`, \`offline\`) to preview data states.

## Components

${componentDocs.join('\n\n') || 'This design has no reusable components yet.'}

## Screens

${screenDocs.join('\n')}

## Notes

- This package is a design deliverable, not a verified production implementation. Run your own tests, accessibility checks and reviews.
- Edits to these files do not flow back into Designer. Change the design there and export again.
- The runtime accepts only validated data: no document can inject markup, scripts or arbitrary styles.

Run \`npm install\` then \`npm run typecheck\` to check the package.
`;
  return { files, assets };
}

// ---- zip --------------------------------------------------------------------------------------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(data: Uint8Array): number { let c = 0xffffffff; for (const b of data) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** A stored (uncompressed) zip archive. Paths are relative and use forward slashes. */
export function zipFiles(entries: { path: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder(), chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    if (e.path.startsWith('/') || e.path.split('/').some(p => p === '..' || p === '')) throw new Error(`Unsafe archive path: ${e.path}`);
    const name = enc.encode(e.path), crc = crc32(e.data), size = e.data.length;
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cen = new Uint8Array(46 + name.length), cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    cen.set(name, 46);
    chunks.push(local, e.data); central.push(cen);
    offset += local.length + size;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const c of [...chunks, ...central, end]) { out.set(c, at); at += c.length; }
  return out;
}
