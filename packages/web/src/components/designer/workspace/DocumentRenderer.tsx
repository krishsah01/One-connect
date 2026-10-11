// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The application-owned design runtime. It draws a structured design document with validated
// properties and an allowlist of behaviors: no document can inject markup, scripts, URLs or CSS.
// Designer previews, the frozen release viewer and exported React packages all use this same file;
// exports copy it verbatim (only the type import path changes), so keep it free of app imports.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { DesignContentState, DesignDocument, DesignIcon, DesignInteraction, DesignLayout, DesignNode, DesignNodeProps, DesignOverride, DesignTokenValue, DesignValue } from '@acc/core';

/** Every event a person causes in a prototype, for hosts that connect real data and services. */
export interface DesignActionEvent { nodeId: string; instanceId?: string; event: 'click' | 'change' | 'submit'; value: string; screenId: string }

export interface DocumentRendererProps {
  document: DesignDocument;
  /** Screen to show. Changing it resets the prototype to that screen. */
  screenId?: string;
  /** Viewport width used for responsive layouts. Measured from the container when omitted. */
  width?: number;
  dark?: boolean;
  /** Simulated data scenario for tables, charts and lists. */
  contentState?: DesignContentState;
  /** Values that replace the document's sample data (connect real data here). */
  fixtures?: Record<string, string>;
  /** Editor mode: clicks select layers and nothing in the prototype runs. */
  editing?: boolean;
  selected?: readonly string[];
  onSelect?: (id: string, modifiers: { shift: boolean; meta: boolean }) => void;
  /** Inline text edits. `instanceId` is set when the text belongs to a component instance. */
  onText?: (id: string, text: string, instanceId?: string) => void;
  assetUrl?: (assetId: string) => string | undefined;
  onAction?: (event: DesignActionEvent) => void;
  onNavigate?: (screenId: string) => void;
  reducedMotion?: boolean;
  /** Content for slot layers of a component drawn on its own (see ComponentRenderer). */
  slots?: Record<string, ReactNode>;
  /** Editor: make layers inside this instance individually selectable (component editing). */
  selectInside?: string;
}

// ---- tokens -------------------------------------------------------------------------------------

function resolve(tokens: Record<string, DesignTokenValue>, key: string, dark: boolean): string | number | undefined {
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
const UNITS: Partial<Record<DesignTokenValue['type'], string>> = { dimension: 'px', letterSpacing: 'em', duration: 'ms' };
// Token values were validated when saved; this second check keeps the runtime safe on its own.
const SAFE = /^[#A-Za-z0-9 ,.()%-]*$/;
/** CSS custom properties for every token in one theme. */
export function designVariables(tokens: Record<string, DesignTokenValue>, dark: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, t] of Object.entries(tokens)) {
    const v = resolve(tokens, key, dark);
    if (v === undefined || !SAFE.test(String(v)) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;
    out[`--ds-${key}`] = typeof v === 'number' ? `${v}${UNITS[t.type] ?? ''}` : v;
  }
  return out;
}
const ref = (token: string) => `var(--ds-${token})`;
const px = (v: DesignValue | undefined) => v === undefined ? undefined : typeof v === 'number' ? `${v}px` : ref(v);
const unitless = (v: DesignValue | undefined, unit = '') => v === undefined ? undefined : typeof v === 'number' ? `${v}${unit}` : ref(v);

// ---- base styles --------------------------------------------------------------------------------

export const DOCUMENT_STYLES = `
.design-renderer{--dsr-accent:var(--ds-accent,#2563eb);--dsr-focus:var(--ds-focus,var(--dsr-accent));--dsr-text:var(--ds-text,#1d2433);--dsr-muted:var(--ds-text-muted,#5b6577);--dsr-surface:var(--ds-surface,#fff);--dsr-subtle:var(--ds-surface-subtle,#f1f3f7);--dsr-border:var(--ds-border,#d9dee7);--dsr-strong:var(--ds-border-strong,#8a94a6);--dsr-radius:var(--ds-radius-md,8px);--dsr-fast:var(--ds-duration-fast,120ms);--dsr-ease:var(--ds-ease-standard,ease);
  position:relative;isolation:isolate;box-sizing:border-box;min-height:100%;font-family:var(--ds-font-body,system-ui,sans-serif);font-size:var(--ds-text-md,16px);line-height:var(--ds-leading-normal,1.5);color:var(--dsr-text);background:var(--ds-canvas,#f7f8fa);-webkit-font-smoothing:antialiased}
.design-renderer *,.design-renderer *::before,.design-renderer *::after{box-sizing:border-box}
.design-renderer :where(h1,h2,h3,h4,h5,h6,p,ul,ol,figure,fieldset,legend){margin:0;padding:0}
.design-renderer :where(button,input,select,textarea){font:inherit;color:inherit;letter-spacing:inherit}
.design-renderer :focus-visible{outline:var(--ds-focus-width,2px) solid var(--dsr-focus);outline-offset:2px}
.design-renderer .dsr-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;padding:0 18px;border:1px solid transparent;border-radius:var(--dsr-radius);background:var(--dsr-accent);color:var(--ds-on-accent,#fff);cursor:pointer;font-weight:var(--ds-weight-medium,500);text-align:center;transition:filter var(--dsr-fast) var(--dsr-ease),transform var(--dsr-fast) var(--dsr-ease)}
.design-renderer .dsr-button:hover:not(:disabled){filter:brightness(.96)}.design-renderer .dsr-button:active:not(:disabled){transform:translateY(1px)}
.design-renderer .dsr-button:disabled{opacity:var(--ds-opacity-disabled,.5);cursor:not-allowed}
.design-renderer .dsr-link{color:var(--dsr-accent);text-decoration:underline;text-underline-offset:3px;cursor:pointer;background:none;border:0;padding:0;font:inherit}
.design-renderer .dsr-field{display:flex;flex-direction:column;gap:6px;min-width:0}.design-renderer .dsr-field>span:first-child,.design-renderer legend{font-weight:var(--ds-weight-medium,500);font-size:var(--ds-text-sm,14px)}
.design-renderer .dsr-control{width:100%;min-height:44px;padding:10px 12px;border:var(--ds-border-width,1px) solid var(--dsr-strong);border-radius:var(--dsr-radius);background:var(--dsr-surface);color:var(--dsr-text)}
.design-renderer textarea.dsr-control{min-height:110px;resize:vertical}.design-renderer .dsr-control::placeholder{color:var(--dsr-muted);opacity:1}
.design-renderer .dsr-control[aria-invalid=true]{border-color:var(--ds-danger,#c0392b);box-shadow:0 0 0 1px var(--ds-danger,#c0392b)}
.design-renderer .dsr-help{font-size:var(--ds-text-sm,14px);color:var(--dsr-muted)}.design-renderer .dsr-error{font-size:var(--ds-text-sm,14px);color:var(--ds-danger,#b42318)}
.design-renderer .dsr-search{position:relative}.design-renderer .dsr-search svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--dsr-muted)}.design-renderer .dsr-search input{padding-left:38px}
.design-renderer .dsr-check{display:inline-flex;align-items:center;gap:10px;min-height:44px;cursor:pointer}.design-renderer .dsr-check input{width:20px;height:20px;accent-color:var(--dsr-accent);margin:0}
.design-renderer fieldset.dsr-radio{border:0;display:flex;flex-direction:column;gap:2px}
.design-renderer .dsr-switch{display:inline-flex;align-items:center;gap:12px;min-height:44px;background:none;border:0;padding:0;cursor:pointer;text-align:left}
.design-renderer .dsr-switch i{flex:none;width:44px;height:26px;border-radius:13px;background:var(--dsr-strong);position:relative;transition:background var(--dsr-fast) var(--dsr-ease)}
.design-renderer .dsr-switch i::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform var(--dsr-fast) var(--dsr-ease)}
.design-renderer .dsr-switch[aria-checked=true] i{background:var(--dsr-accent)}.design-renderer .dsr-switch[aria-checked=true] i::after{transform:translateX(18px)}
.design-renderer .dsr-tablist{display:flex;gap:4px;border-bottom:1px solid var(--dsr-border);overflow-x:auto}
.design-renderer .dsr-tab{min-height:44px;padding:0 14px;background:none;border:0;border-bottom:2px solid transparent;color:var(--dsr-muted);cursor:pointer;white-space:nowrap}
.design-renderer .dsr-tab[aria-selected=true]{color:var(--dsr-text);border-bottom-color:var(--dsr-accent);font-weight:var(--ds-weight-medium,500)}
.design-renderer .dsr-nav ul{display:flex;gap:4px;list-style:none;flex-wrap:wrap}.design-renderer .dsr-nav[data-vertical=true] ul{flex-direction:column}
.design-renderer .dsr-nav button{display:flex;align-items:center;width:100%;min-height:40px;padding:0 12px;border:0;border-radius:var(--dsr-radius);background:none;color:var(--dsr-muted);cursor:pointer;text-align:left}
.design-renderer .dsr-nav button[aria-current=page]{background:var(--ds-accent-subtle,var(--dsr-subtle));color:var(--dsr-text);font-weight:var(--ds-weight-medium,500)}
.design-renderer .dsr-pages{display:flex;gap:4px;align-items:center;list-style:none;flex-wrap:wrap}.design-renderer .dsr-pages button{min-width:40px;min-height:40px;border:1px solid var(--dsr-border);border-radius:var(--dsr-radius);background:var(--dsr-surface);cursor:pointer}
.design-renderer .dsr-pages button[aria-current=page]{background:var(--dsr-accent);color:var(--ds-on-accent,#fff);border-color:transparent}
.design-renderer .dsr-menu{position:relative;display:inline-block}.design-renderer .dsr-menu [role=menu]{position:absolute;top:calc(100% + 6px);left:0;z-index:var(--ds-layer-dropdown,100);min-width:180px;padding:6px;list-style:none;background:var(--dsr-surface);border:1px solid var(--dsr-border);border-radius:var(--dsr-radius);box-shadow:var(--ds-shadow-md,0 6px 20px #0002)}
.design-renderer [role=menuitem]{display:block;width:100%;min-height:40px;padding:0 12px;border:0;background:none;text-align:left;border-radius:6px;cursor:pointer}.design-renderer [role=menuitem]:hover,.design-renderer [role=menuitem]:focus{background:var(--dsr-subtle);outline:none}
.design-renderer .dsr-tooltip{position:relative;display:inline-flex}.design-renderer .dsr-tooltip>[role=tooltip]{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);z-index:var(--ds-layer-dropdown,100);width:max-content;max-width:240px;padding:6px 10px;border-radius:6px;background:var(--dsr-text);color:var(--dsr-surface);font-size:var(--ds-text-sm,14px);opacity:0;pointer-events:none;transition:opacity var(--dsr-fast) var(--dsr-ease)}
.design-renderer .dsr-tooltip:hover>[role=tooltip],.design-renderer .dsr-tooltip:focus-within>[role=tooltip]{opacity:1}
.design-renderer .dsr-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:var(--ds-radius-full,999px);font-size:var(--ds-text-sm,14px);font-weight:var(--ds-weight-medium,500);background:var(--dsr-subtle);color:var(--dsr-text)}
.design-renderer .dsr-avatar{display:inline-grid;place-items:center;flex:none;border-radius:50%;overflow:hidden;background:var(--ds-accent-subtle,var(--dsr-subtle));color:var(--dsr-text);font-weight:var(--ds-weight-medium,500);font-size:14px}
.design-renderer .dsr-notice{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:var(--dsr-radius);border:1px solid var(--dsr-border);background:var(--dsr-surface)}.design-renderer .dsr-notice b{display:block}
.design-renderer .dsr-progress{height:8px;border-radius:4px;background:var(--dsr-subtle);overflow:hidden}.design-renderer .dsr-progress>i{display:block;height:100%;background:var(--dsr-accent);border-radius:4px}
.design-renderer .dsr-spinner{display:inline-flex;align-items:center;gap:10px;color:var(--dsr-muted)}.design-renderer .dsr-spinner i{width:20px;height:20px;border-radius:50%;border:3px solid var(--dsr-subtle);border-top-color:var(--dsr-accent);animation:dsr-spin 800ms linear infinite}
.design-renderer .dsr-skeleton{display:flex;flex-direction:column;gap:10px}.design-renderer .dsr-skeleton i{display:block;height:12px;border-radius:6px;background:var(--dsr-subtle)}.design-renderer .dsr-skeleton i:last-child{width:60%}
.design-renderer .dsr-table{overflow-x:auto;border:1px solid var(--dsr-border);border-radius:var(--dsr-radius);background:var(--dsr-surface)}
.design-renderer table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}.design-renderer caption{text-align:left;padding:12px 14px;font-weight:var(--ds-weight-medium,500)}
.design-renderer th,.design-renderer td{padding:12px 14px;text-align:left;border-top:1px solid var(--dsr-border);white-space:nowrap}.design-renderer th{font-size:var(--ds-text-sm,14px);color:var(--dsr-muted);font-weight:var(--ds-weight-medium,500)}
.design-renderer .dsr-list{list-style:none;display:flex;flex-direction:column}.design-renderer .dsr-list li{padding:10px 0;border-top:1px solid var(--dsr-border)}.design-renderer .dsr-list li:first-child{border-top:0}
.design-renderer .dsr-chart svg{display:block;width:100%;height:auto;overflow:visible}.design-renderer .dsr-chart text{font-size:11px;fill:var(--dsr-muted)}
.design-renderer .dsr-state{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:24px;border:1px dashed var(--dsr-border);border-radius:var(--dsr-radius);color:var(--dsr-muted);background:var(--dsr-surface)}
.design-renderer .dsr-partial{font-size:var(--ds-text-sm,14px);color:var(--dsr-muted)}
.design-renderer .dsr-scrim{position:absolute;inset:0;z-index:var(--ds-layer-overlay,200);display:flex;align-items:flex-start;justify-content:center;padding:80px 16px 16px;background:rgb(15 20 30 / var(--ds-opacity-scrim,.48))}
.design-renderer .dsr-scrim[data-kind=drawer]{justify-content:flex-end;align-items:stretch;padding:0}
.design-renderer .dsr-overlay{position:sticky;top:80px;max-width:100%;max-height:calc(100vh - 120px);overflow:auto;outline:none}.design-renderer .dsr-scrim[data-kind=drawer] .dsr-overlay{top:0;height:100%;max-height:none;width:min(420px,100%);background:var(--dsr-surface);box-shadow:var(--ds-shadow-lg,0 10px 40px #0004)}
.design-renderer .dsr-close{position:absolute;top:8px;right:8px;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:var(--dsr-muted);cursor:pointer;z-index:1}
.design-renderer[data-editing=true] :where(input,select,textarea){pointer-events:none}
.design-renderer[data-editing=true] [data-select-id]{cursor:default}
.design-renderer[data-editing=true] [data-select-id]:hover{outline:1px solid #4f7cff88;outline-offset:1px}
.design-renderer[data-editing=true] [data-selected=true]{outline:2px solid #4f7cff;outline-offset:2px}
.design-renderer[data-editing=true] [data-hidden-layer=true]{opacity:.35}
.design-renderer [contenteditable=true]{outline:2px dashed #4f7cff;outline-offset:2px;cursor:text}
.design-renderer [data-transition=fade]{animation:dsr-fade var(--ds-duration-normal,200ms) var(--dsr-ease)}
.design-renderer [data-transition=slide]{animation:dsr-slide var(--ds-duration-slow,320ms) var(--dsr-ease)}
.design-renderer [data-transition=scale]{animation:dsr-scale var(--ds-duration-normal,200ms) var(--dsr-ease)}
.design-renderer[data-motion=reduced] *{animation-duration:1ms!important;transition-duration:1ms!important}
.design-renderer[data-motion=reduced] [data-transition]{animation:dsr-fade 1ms}
@media (prefers-reduced-motion:reduce){.design-renderer *{animation-duration:1ms!important;transition-duration:1ms!important}.design-renderer .dsr-spinner i{animation:none}}
@keyframes dsr-fade{from{opacity:0}to{opacity:1}}@keyframes dsr-slide{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}@keyframes dsr-scale{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}@keyframes dsr-spin{to{transform:rotate(360deg)}}
`;

// ---- icons (original, drawn on a 24px grid) -----------------------------------------------------

type Shape = ['p', string] | ['c', number, number, number] | ['r', number, number, number, number, number] | ['f', number, number, number];
const ICONS: Record<DesignIcon, Shape[]> = {
  star: [['p', 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.8z']],
  check: [['p', 'M5 12.5l4.5 4.5L19 7']], plus: [['p', 'M12 5v14M5 12h14']], minus: [['p', 'M5 12h14']], close: [['p', 'M6 6l12 12M18 6L6 18']],
  search: [['c', 11, 11, 6], ['p', 'M15.5 15.5L20 20']], 'arrow-right': [['p', 'M5 12h14M13 6l6 6-6 6']], 'arrow-left': [['p', 'M19 12H5M11 6l-6 6 6 6']],
  'chevron-down': [['p', 'M6 9l6 6 6-6']], 'chevron-right': [['p', 'M9 6l6 6-6 6']],
  heart: [['p', 'M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z']],
  home: [['p', 'M4 11l8-7 8 7v9h-5.5v-6h-5v6H4z']], user: [['c', 12, 8, 4], ['p', 'M4.5 20c.6-3.8 3.6-5.8 7.5-5.8s6.9 2 7.5 5.8']],
  users: [['c', 9, 8.5, 3.5], ['p', 'M2.5 20c.5-3.4 3-5.3 6.5-5.3s6 1.9 6.5 5.3'], ['c', 17, 9, 2.6], ['p', 'M16.5 14.4c2.8.2 4.6 1.9 5 4.6']],
  settings: [['c', 12, 12, 3], ['c', 12, 12, 7], ['p', 'M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8']],
  bell: [['p', 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.8 1.8H4.2z'], ['p', 'M10 20.5a2.2 2.2 0 0 0 4 0']],
  mail: [['r', 3, 5.5, 18, 13, 2], ['p', 'M3.5 7l8.5 6 8.5-6']], calendar: [['r', 3.5, 5, 17, 15.5, 2], ['p', 'M3.5 10h17M8 3v4M16 3v4']],
  chart: [['p', 'M3 20.5h18M6 20.5V12M11 20.5V6M16 20.5v-5M20 20.5V9']], folder: [['p', 'M3 6.5h6l2 2.5h10v10.5H3z']], file: [['p', 'M6 3h8.5L19 7.5V21H6z'], ['p', 'M14 3v5h5']],
  cart: [['p', 'M3 4h2.2l2.4 10.6h10.6L20.5 7H6.6'], ['c', 9, 19, 1.4], ['c', 17, 19, 1.4]], bag: [['p', 'M5 8.5h14L18 20.5H6z'], ['p', 'M9 8.5V7a3 3 0 0 1 6 0v1.5']],
  lock: [['r', 5, 10.5, 14, 10, 2], ['p', 'M8 10.5V8a4 4 0 0 1 8 0v2.5']], info: [['c', 12, 12, 9], ['p', 'M12 11v5.5'], ['f', 12, 8, 1.1]],
  warning: [['p', 'M12 3.5l9.2 16.5H2.8z'], ['p', 'M12 10v4.5'], ['f', 12, 17.3, 1.1]], error: [['c', 12, 12, 9], ['p', 'M9 9l6 6M15 9l-6 6']], success: [['c', 12, 12, 9], ['p', 'M8 12.3l2.8 2.8L16.2 9']],
  menu: [['p', 'M4 6.5h16M4 12h16M4 17.5h16']], more: [['f', 5.5, 12, 1.6], ['f', 12, 12, 1.6], ['f', 18.5, 12, 1.6]], filter: [['p', 'M3.5 5h17l-6.8 8v5.5l-3.4 1.8V13z']],
  upload: [['p', 'M12 16V4.5M7 9l5-5 5 5M4.5 20h15']], download: [['p', 'M12 4v11.5M7 11l5 5 5-5M4.5 20h15']], edit: [['p', 'M4.5 19.5h4L19.2 8.8l-4-4L4.5 15.5z'], ['p', 'M13.6 6.4l4 4']],
  trash: [['p', 'M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13']], link: [['p', 'M10 14a4 4 0 0 0 5.6.2l3.1-3.1a4 4 0 0 0-5.7-5.7l-1.2 1.2'], ['p', 'M14 10a4 4 0 0 0-5.6-.2l-3.1 3.1a4 4 0 0 0 5.7 5.7l1.2-1.2']],
  globe: [['c', 12, 12, 9], ['p', 'M3 12h18M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18']], sparkle: [['p', 'M12 3l2.1 6.2 6.4 2.3-6.4 2.3L12 20l-2.1-6.2-6.4-2.3 6.4-2.3z']],
  moon: [['p', 'M19.5 14.5A8 8 0 1 1 9.5 4.5a6.4 6.4 0 0 0 10 10z']], sun: [['c', 12, 12, 4], ['p', 'M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8']],
};
export function Icon({ name, size = 20, label }: { name: DesignIcon; size?: number | string; label?: string }) {
  const shapes = ICONS[name] ?? ICONS.star;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      {shapes.map((s, i) => s[0] === 'p' ? <path key={i} d={s[1]} /> : s[0] === 'c' ? <circle key={i} cx={s[1]} cy={s[2]} r={s[3]} /> : s[0] === 'f' ? <circle key={i} cx={s[1]} cy={s[2]} r={s[3]} fill="currentColor" stroke="none" /> : <rect key={i} x={s[1]} y={s[2]} width={s[3]} height={s[4]} rx={s[5]} />)}
    </svg>
  );
}
const TONE_ICON: Record<string, DesignIcon> = { info: 'info', success: 'success', warning: 'warning', danger: 'error', neutral: 'info' };

// ---- layout -------------------------------------------------------------------------------------

const CONTAINERS = new Set(['frame', 'card', 'dialog', 'drawer', 'slot']);
type ParentFlow = 'row' | 'column' | 'grid' | 'none';
function boxStyle(n: DesignNode, l: DesignLayout, parent: ParentFlow): CSSProperties {
  const s: CSSProperties = {};
  if (CONTAINERS.has(n.kind)) {
    s.display = l.direction === 'grid' ? 'grid' : 'flex';
    if (l.direction !== 'grid') s.flexDirection = l.direction === 'row' ? 'row' : 'column';
    if (l.direction === 'grid') s.gridTemplateColumns = `repeat(${l.columns ?? 2}, minmax(0, 1fr))`;
    s.gap = px(l.gap);
    s.flexWrap = l.wrap ? 'wrap' : undefined;
    s.alignItems = l.align === 'start' ? 'flex-start' : l.align === 'end' ? 'flex-end' : l.align === 'center' ? 'center' : l.direction === 'row' ? 'center' : 'stretch';
    s.justifyContent = { start: 'flex-start', end: 'flex-end', center: 'center', between: 'space-between' }[l.justify ?? 'start'];
    s.position = 'relative';
  }
  const pad = px(l.padding);
  s.paddingTop = px(l.paddingY) ?? pad; s.paddingBottom = px(l.paddingY) ?? pad;
  s.paddingLeft = px(l.paddingX) ?? pad; s.paddingRight = px(l.paddingX) ?? pad;
  if (l.width === 'fill') {
    if (parent === 'row') { s.flex = '1 1 0'; s.minWidth = 0; } else if (parent === 'column') { s.alignSelf = 'stretch'; } else s.width = '100%';
  } else if (l.width === 'hug') { s.width = 'fit-content'; s.maxWidth = '100%'; if (parent === 'column') s.alignSelf = 'flex-start'; }
  else if (typeof l.width === 'number') { s.width = l.width; s.maxWidth = '100%'; s.flexShrink = 0; }
  if (l.height === 'fill') { if (parent === 'column') s.flex = '1 1 0'; else s.height = '100%'; }
  else if (typeof l.height === 'number') s.height = l.height;
  if (l.minWidth !== undefined) s.minWidth = l.minWidth;
  if (l.minHeight !== undefined) s.minHeight = l.minHeight;
  if (l.maxWidth !== undefined) { s.maxWidth = px(l.maxWidth); if (CONTAINERS.has(n.kind) && l.width !== 'hug') { s.marginLeft = 'auto'; s.marginRight = 'auto'; s.width = '100%'; } }
  if (l.position === 'absolute') { s.position = 'absolute'; s.left = l.x ?? 0; s.top = l.y ?? 0; }
  return s;
}
function paintStyle(p: DesignNodeProps): CSSProperties {
  const s: CSSProperties = {};
  if (p.color) s.color = ref(p.color);
  if (p.background) s.background = ref(p.background);
  if (p.border || p.borderColor) s.border = `var(--ds-border-width, 1px) solid ${p.borderColor ? ref(p.borderColor) : 'var(--dsr-border)'}`;
  if (p.radius !== undefined) s.borderRadius = px(p.radius);
  if (p.shadow) s.boxShadow = ref(p.shadow);
  if (p.font) s.fontFamily = ref(p.font);
  if (p.fontSize !== undefined) s.fontSize = px(p.fontSize);
  if (p.lineHeight !== undefined) s.lineHeight = unitless(p.lineHeight);
  if (p.letterSpacing !== undefined) s.letterSpacing = unitless(p.letterSpacing, 'em');
  if (p.fontWeight !== undefined) s.fontWeight = unitless(p.fontWeight) as CSSProperties['fontWeight'];
  if (p.textAlign) s.textAlign = p.textAlign;
  if (p.opacity !== undefined) s.opacity = p.opacity;
  if (p.layer !== undefined) s.zIndex = unitless(p.layer) as unknown as number;
  return s;
}

// ---- runtime state ------------------------------------------------------------------------------

interface Runtime {
  screen: string;
  history: string[];
  overlays: string[];
  fixtures: Record<string, string>;
  states: Record<string, DesignContentState>;
  variants: Record<string, string>;
  visible: Record<string, boolean>;
  values: Record<string, string>;
  errors: Record<string, string>;
  transition: string;
  /** Bumped on each navigation so entrance animations replay. */
  step: number;
}
interface Scope {
  instance?: string;
  /** Props from the instance's variant and component state, by component layer id. */
  layer?: Record<string, DesignNodeProps>;
  overrides?: Record<string, DesignOverride>;
  fills?: Map<string, string[]>;
  /** The instance's variant or state name, for behaviors such as announcing a loading button. */
  stateName?: string;
  outer?: Scope;
}

/** Initials for an avatar label. */
const initials = (label: string) => label.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';

export function DocumentRenderer(props: DocumentRendererProps) {
  const { document: d, editing = false, dark = false, contentState = 'success' } = props;
  const container = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(1280);
  useLayoutEffect(() => {
    if (props.width !== undefined || !container.current || typeof ResizeObserver === 'undefined') return;
    const el = container.current, ro = new ResizeObserver(() => setMeasured(el.clientWidth || 1280));
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.width]);
  const width = props.width ?? measured;
  const first = props.screenId && d.screens.some(s => s.id === props.screenId) ? props.screenId : d.screens.find(s => s.kind !== 'dialog' && s.kind !== 'drawer')?.id ?? d.screens[0]?.id;
  const initial = useCallback((): Runtime => ({ screen: first, history: [], overlays: [], fixtures: { ...d.fixtures, ...props.fixtures }, states: {}, variants: {}, visible: {}, values: {}, errors: {}, transition: 'none', step: 0 }), [first, d.fixtures, props.fixtures]);
  const [rt, setRt] = useState<Runtime>(initial);
  const lastReset = useRef({ id: d.id, first, editing });
  useEffect(() => {
    const prev = lastReset.current;
    if (prev.id !== d.id || prev.first !== first || prev.editing !== editing) { lastReset.current = { id: d.id, first, editing }; setRt(initial()); }
  }, [d.id, first, editing, initial]);
  useEffect(() => { if (props.fixtures) setRt(r => ({ ...r, fixtures: { ...r.fixtures, ...props.fixtures } })); }, [props.fixtures]);
  const latest = useRef(rt); latest.current = rt;

  const variables = useMemo(() => designVariables(d.tokens, dark), [d.tokens, dark]);
  const parent = useMemo(() => { const m = new Map<string, string>(); for (const n of Object.values(d.nodes)) for (const c of n.children) m.set(c, n.id); return m; }, [d.nodes]);
  const byScreen = useMemo(() => new Map(d.screens.map(s => [s.id, s])), [d.screens]);
  const bp = d.settings?.breakpoints ?? { phone: 600, tablet: 1024 };
  const size: 'phone' | 'tablet' | 'desktop' = width < bp.phone ? 'phone' : width < bp.tablet ? 'tablet' : 'desktop';
  const selected = useMemo(() => new Set(props.selected ?? []), [props.selected]);
  const motion = props.reducedMotion || d.settings?.motion === 'reduced' ? 'reduced' : 'full';
  const [editingText, setEditingText] = useState<string | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const emit = props.onAction, navigateCb = props.onNavigate;
  /** Run the interactions for an event, bubbling clicks to the nearest layer that handles them. */
  const act = (chain: string[], scope: Scope, event: 'click' | 'change' | 'submit', value: string) => {
    if (editing) return;
    const source = chain[chain.length - 1];
    emit?.({ nodeId: source, instanceId: scope.instance, event, value, screenId: latest.current.screen });
    const handles = (id: string) => d.interactions.filter(i => i.source === id && i.event === event && (i.match === undefined || i.match === value));
    let list: DesignInteraction[] = [];
    for (let k = chain.length - 1; k >= 0 && !list.length; k--) { list = handles(chain[k]); if (event !== 'click') break; }
    if (!list.length) return;
    let next = { ...latest.current };
    for (const i of list) {
      if (i.when && next.fixtures[i.when.fixture] !== i.when.equals) continue;
      const target = i.target ?? '';
      if (i.action === 'validate') {
        const errors = validate(next);
        next = { ...next, errors };
        if (Object.keys(errors).length) {
          setRt(next);
          requestAnimationFrame(() => container.current?.querySelector<HTMLElement>('[aria-invalid=true]')?.focus());
          return;
        }
        continue;
      }
      next = { ...next, transition: i.transition };
      switch (i.action) {
        case 'navigate': if (byScreen.has(target)) { next = { ...next, history: [...next.history, next.screen], screen: target, overlays: [], step: next.step + 1, errors: {} }; navigateCb?.(target); } break;
        case 'back': next = next.overlays.length ? { ...next, overlays: next.overlays.slice(0, -1) } : next.history.length ? { ...next, screen: next.history.at(-1)!, history: next.history.slice(0, -1), step: next.step + 1 } : next; break;
        case 'open-overlay': if (byScreen.has(target)) { restoreFocus.current = globalThis.document?.activeElement as HTMLElement | null; next = { ...next, overlays: [...next.overlays, target], step: next.step + 1 }; } break;
        case 'close-overlay': next = { ...next, overlays: next.overlays.slice(0, -1), errors: {} }; break;
        case 'set-state': next = { ...next, states: { ...next.states, [target]: i.value as DesignContentState } }; break;
        case 'set-variant': next = { ...next, variants: { ...next.variants, [target]: i.value ?? '' } }; break;
        case 'set-value': next = { ...next, fixtures: { ...next.fixtures, [target]: i.value ?? value } }; break;
        case 'toggle': next = { ...next, visible: { ...next.visible, [target]: !isVisible(target, next) } }; break;
        case 'show': next = { ...next, visible: { ...next.visible, [target]: true } }; break;
        case 'hide': next = { ...next, visible: { ...next.visible, [target]: false } }; break;
        case 'select-tab': next = { ...next, values: { ...next.values, [`/${target}`]: i.value ?? '0' } }; break;
      }
    }
    setRt(next);
  };
  const isVisible = (id: string, r: Runtime) => r.visible[id] ?? !d.nodes[id]?.hidden;
  /** Required fields in the open overlay (or the screen) that are still empty. */
  const validate = (r: Runtime): Record<string, string> => {
    const errors: Record<string, string> = {};
    const scopeRoot = r.overlays.length ? byScreen.get(r.overlays.at(-1)!)?.root : byScreen.get(r.screen)?.root;
    const walk = (id: string, scope: Scope, depth: number) => {
      const n = d.nodes[id];
      if (!n || depth > 100 || !isVisible(id, r) && !scope.instance) return;
      const p = { ...n.props, ...scope.layer?.[id], ...(scope.overrides?.[id] as DesignNodeProps | undefined) };
      const key = `${scope.instance ?? ''}/${id}`;
      if (p.required && ['input', 'textarea', 'select', 'checkbox'].includes(n.kind)) {
        const v = r.values[key] ?? (n.kind === 'checkbox' ? String(!!p.checked) : p.bind ? r.fixtures[p.bind.fixture] ?? '' : p.value ?? '');
        if (n.kind === 'checkbox' ? v !== 'true' : !v.trim()) errors[key] = p.errorText || (n.kind === 'checkbox' ? 'Check this box to continue.' : `Enter ${(p.label ?? 'this field').toLowerCase()}.`);
      }
      if (n.kind === 'instance') {
        const c = d.components[p.componentId ?? ''];
        if (c) walk(c.root, instanceScope(n, p, scope), depth + 1);
        for (const ch of n.children) walk(ch, scope, depth + 1);
        return;
      }
      for (const ch of n.children) walk(ch, scope, depth + 1);
    };
    if (scopeRoot) walk(scopeRoot, {}, 0);
    return errors;
  };
  const instanceScope = (n: DesignNode, p: DesignNodeProps, outer: Scope): Scope => {
    const c = d.components[p.componentId ?? '']!;
    const chosen = rt.variants[n.id] ?? '';
    const layer: Record<string, DesignNodeProps> = {};
    for (const m of [c.variants[p.variant ?? ''], c.states?.[p.componentState ?? ''], c.variants[chosen], c.states?.[chosen]]) if (m) for (const [k, v] of Object.entries(m)) layer[k] = { ...layer[k], ...v };
    const fills = new Map<string, string[]>();
    for (const ch of n.children) { const slot = d.nodes[ch]?.props.slot; if (slot) fills.set(slot, [...(fills.get(slot) ?? []), ch]); }
    return { instance: n.id, layer, overrides: p.overrides, fills, outer, stateName: chosen || p.componentState };
  };

  // ---- drawing ------------------------------------------------------------------------------------

  const draw = (id: string, scope: Scope, chain: string[], flow: ParentFlow, depth: number, placement?: DesignLayout): ReactNode => {
    const n = d.nodes[id];
    if (!n || depth > 100) return null;
    const o = scope.overrides?.[id];
    let p: DesignNodeProps = { ...n.props, ...scope.layer?.[id] };
    if (o) for (const [k, v] of Object.entries(o)) if (k !== 'hidden' && v !== undefined) (p as Record<string, unknown>)[k] = v;
    if (p.bind && Object.hasOwn(rt.fixtures, p.bind.fixture)) p = { ...p, [p.bind.field]: rt.fixtures[p.bind.fixture] };
    const responsive = size === 'phone' ? n.responsive?.phone : size === 'tablet' ? n.responsive?.tablet : undefined;
    const hiddenHere = !!responsive?.hidden || !!o?.hidden || !isVisible(id, rt) || (p.visibleWhen ? rt.fixtures[p.visibleWhen.fixture] !== p.visibleWhen.equals : false);
    if (hiddenHere && !editing) return null;
    if (responsive?.hidden && editing) return null;
    const { hidden: _h, fontSize: rFont, ...rLayout } = responsive ?? {};
    const layout: DesignLayout = { ...n.layout, ...rLayout, ...placement };
    if (rFont !== undefined) p = { ...p, fontSize: rFont };
    const selectId = selectIdFor(id, scope, props.selectInside);
    const textOwner = scope.instance && selectId !== id ? outermost(scope) : undefined;
    const key = `${scope.instance ?? ''}/${id}`;
    const here = [...chain, id];
    const style: CSSProperties = { ...boxStyle(n, layout, flow), ...paintStyle(p) };
    const base: Record<string, unknown> = {
      'data-node-id': id, 'data-select-id': selectId, style,
      ...(editing ? { 'data-selected': selected.has(selectId) || undefined, 'data-hidden-layer': hiddenHere || undefined } : {}),
      onClick: (e: React.MouseEvent) => {
        if (editing) { e.stopPropagation(); e.preventDefault(); props.onSelect?.(selectId, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }); return; }
        if (CLICKABLE.has(n.kind)) { e.stopPropagation(); act(here, scope, 'click', ''); }
      },
    };
    if (!editing && !CLICKABLE.has(n.kind) && d.interactions.some(i => i.source === id && i.event === 'click')) {
      base.onClick = (e: React.MouseEvent) => { e.stopPropagation(); act(here, scope, 'click', ''); };
      base.role = 'button'; base.tabIndex = 0;
      base.onKeyDown = (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(here, scope, 'click', ''); } };
      (style as Record<string, unknown>).cursor = 'pointer';
    }
    const childFlow: ParentFlow = layout.direction === 'grid' ? 'grid' : layout.direction === 'row' ? 'row' : 'column';
    const kids = (list = n.children) => list.map(c => <Fragment key={c}>{draw(c, scope, here, childFlow, depth + 1)}</Fragment>);
    const state = rt.states[id] ?? p.state ?? contentState;
    const textEditable = editing && !n.locked && props.onText;
    const inlineText = (text: string | undefined, fallback = '') => {
      const editingThis = editingText === key;
      return {
        contentEditable: editingThis || undefined, suppressContentEditableWarning: true,
        onDoubleClick: textEditable ? (e: React.MouseEvent) => { e.stopPropagation(); setEditingText(key); requestAnimationFrame(() => { const el = e.target as HTMLElement; el.focus(); const range = globalThis.document.createRange(); range.selectNodeContents(el); const sel = globalThis.getSelection(); sel?.removeAllRanges(); sel?.addRange(range); }); } : undefined,
        onBlur: editingThis ? (e: React.FocusEvent<HTMLElement>) => { setEditingText(null); const next = e.currentTarget.textContent ?? ''; if (next !== (text ?? fallback)) props.onText?.(id, next, textOwner); } : undefined,
        onKeyDown: editingThis ? (e: ReactKeyboardEvent<HTMLElement>) => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); } } : undefined,
        children: text ?? fallback,
      };
    };
    if (['table', 'chart', 'list'].includes(n.kind) && state !== 'success' && state !== 'partial') {
      const copy = d.content?.states ?? { empty: 'Nothing here yet.', loading: 'Loading…', error: 'This couldn’t load.', permission: 'You don’t have access to this.', offline: 'You’re offline.' };
      if (state === 'loading') return <div {...base} className="dsr-state" aria-busy="true"><span className="dsr-spinner" role="status"><i aria-hidden="true" />{copy.loading}</span><div className="dsr-skeleton" style={{ width: '100%' }} aria-hidden="true"><i /><i /><i /></div></div>;
      const msg = copy[state as keyof typeof copy] ?? copy.empty;
      return <div {...base} className="dsr-state" role={state === 'error' ? 'alert' : 'status'}>
        <Icon name={state === 'error' ? 'warning' : state === 'permission' ? 'lock' : state === 'offline' ? 'globe' : 'folder'} size={28} />
        <p>{msg}</p>
        {state === 'error' && <button type="button" className="dsr-button" style={{ background: 'var(--dsr-surface)', color: 'var(--dsr-text)', borderColor: 'var(--dsr-strong)' }} onClick={e => { e.stopPropagation(); if (!editing) setRt(r => ({ ...r, states: { ...r.states, [id]: 'success' } })); }}>Try again</button>}
      </div>;
    }
    const partial = state === 'partial';
    switch (n.kind) {
      case 'instance': {
        const c = d.components[p.componentId ?? ''];
        if (!c) return <div {...base} className="dsr-state">Choose a component</div>;
        const inner = instanceScope(n, p, scope);
        const placementFields: DesignLayout = {};
        for (const k of ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'position', 'x', 'y'] as const) if (layout[k] !== undefined) (placementFields as Record<string, unknown>)[k] = layout[k];
        return draw(c.root, inner, here, flow, depth + 1, placementFields);
      }
      case 'slot': {
        const host = scope.instance === '__component' && !scope.outer?.instance ? props.slots?.[id] : undefined;
        if (host !== undefined) return <div {...base}>{host}</div>;
        const fills = scope.fills?.get(id);
        return <div {...base}>{fills ? fills.map(f => <Fragment key={f}>{draw(f, scope.outer ?? {}, here, childFlow, depth + 1)}</Fragment>) : kids()}</div>;
      }
      case 'frame': case 'card': case 'dialog': case 'drawer': {
        const role = n.kind === 'dialog' || n.kind === 'drawer' ? { role: 'group', 'aria-label': n.name } : {};
        return <div {...base} {...role}>{p.text && <p>{p.text}</p>}{kids()}</div>;
      }
      case 'text': {
        const Tag = (p.level ? `h${p.level}` : 'p') as 'p';
        return <Tag {...base} {...inlineText(p.text)} />;
      }
      case 'button': {
        const icon = p.icon ? <Icon name={p.icon} size="1.15em" /> : null;
        const busy = scope.stateName === 'loading';
        return <button {...base} type="button" className="dsr-button" disabled={!editing && p.disabled} aria-busy={busy || undefined} aria-label={!p.text && p.label ? p.label : undefined}>
          {p.iconPosition !== 'end' && icon}<span {...inlineText(p.text ?? (p.label ? undefined : 'Button'))} />{p.iconPosition === 'end' && icon}
        </button>;
      }
      case 'link':
        return <a {...base} href="#" className="dsr-link" onClick={e => { e.preventDefault(); (base.onClick as (e: React.MouseEvent) => void)(e); }} {...inlineText(p.text, 'Link')} />;
      case 'badge': {
        const tone = p.tone && p.tone !== 'neutral' ? { background: ref(`${p.tone}-subtle`), color: ref(p.tone) } : {};
        return <span {...base} className="dsr-badge" style={{ ...tone, ...style }}>{p.icon && <Icon name={p.icon} size="1em" />}<span {...inlineText(p.text, 'Badge')} /></span>;
      }
      case 'avatar': {
        const url = p.assetId && d.assets[p.assetId] ? props.assetUrl?.(p.assetId) : undefined;
        const dim = typeof layout.width === 'number' ? layout.width : 40;
        return <span {...base} className="dsr-avatar" style={{ width: dim, height: dim, ...style }} role="img" aria-label={p.label ?? 'Avatar'}>{url ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(p.label ?? '')}</span>;
      }
      case 'icon':
        return <span {...base} style={{ display: 'inline-flex', ...style }}><Icon name={p.icon ?? 'star'} size={typeof p.fontSize === 'number' ? p.fontSize : '1.25em'} label={p.label || undefined} /></span>;
      case 'image': {
        const url = p.assetId && d.assets[p.assetId] ? props.assetUrl?.(p.assetId) ?? `./assets/${d.assets[p.assetId].hash}` : undefined;
        const crop = p.crop ?? { x: 50, y: 50, zoom: 1 };
        const h = typeof layout.height === 'number' ? layout.height : 200;
        return <div {...base} style={{ overflow: 'hidden', height: h, ...style }}>
          {url ? <img src={url} alt={p.alt ?? ''} draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: p.fit ?? 'cover', objectPosition: `${crop.x}% ${crop.y}%`, transform: crop.zoom !== 1 ? `scale(${crop.zoom})` : undefined, transformOrigin: `${crop.x}% ${crop.y}%` }} />
            : <div role="img" aria-label={p.alt || 'Image placeholder'} style={{ display: 'grid', placeItems: 'center', height: '100%', background: 'var(--dsr-subtle)', color: 'var(--dsr-muted)' }}><Icon name="file" size={28} /></div>}
        </div>;
      }
      case 'shape': return <div {...base} style={{ minHeight: typeof layout.height === 'number' ? undefined : 80, ...style }} aria-hidden="true" />;
      case 'divider': return <hr {...base} style={{ border: 0, borderTop: '1px solid var(--dsr-border)', margin: 0, ...style }} />;
      case 'input': case 'textarea': case 'select': {
        const value = rt.values[key] ?? (p.bind?.field === 'value' ? rt.fixtures[p.bind.fixture] : undefined);
        const err = rt.errors[key] ?? (p.errorText && scope.layer?.[id]?.errorText ? p.errorText : undefined);
        const helpId = `${safeId(key)}-help`, errId = `${safeId(key)}-error`;
        const described = [p.helperText && helpId, err && errId].filter(Boolean).join(' ') || undefined;
        const change = (v: string) => {
          if (editing) return;
          setRt(r => {
            const { [key]: _gone, ...errors } = r.errors;
            return { ...r, values: { ...r.values, [key]: v }, errors, fixtures: p.bind ? { ...r.fixtures, [p.bind.fixture]: v } : r.fixtures };
          });
          act(here, scope, 'change', v);
        };
        const common = { 'data-key': key, id: safeId(key), className: 'dsr-control', disabled: !editing && p.disabled, required: p.required, 'aria-invalid': err ? true : undefined, 'aria-describedby': described, tabIndex: editing ? -1 : undefined };
        const control = n.kind === 'textarea'
          ? <textarea {...common} placeholder={p.placeholder} value={value ?? p.value ?? ''} readOnly={editing} onChange={e => change(e.target.value)} />
          : n.kind === 'select'
            ? <select {...common} value={value ?? p.value ?? p.options?.[0] ?? ''} onChange={e => change(e.target.value)}>{(p.options ?? []).map((v, i) => <option key={i} value={v}>{v}</option>)}</select>
            : <input {...common} type={p.inputType ?? 'text'} placeholder={p.placeholder} value={value ?? p.value ?? ''} readOnly={editing} onChange={e => change(e.target.value)} />;
        return <label {...base} className="dsr-field" htmlFor={safeId(key)} onClick={editing ? base.onClick as never : undefined}>
          <span>{p.label}{p.required && <span aria-hidden="true"> *</span>}</span>
          {p.icon === 'search' || p.inputType === 'search' ? <span className="dsr-search"><Icon name="search" size={18} />{control}</span> : control}
          {p.helperText && <span className="dsr-help" id={helpId}>{p.helperText}</span>}
          {err && <span className="dsr-error" id={errId} role="alert">{err}</span>}
        </label>;
      }
      case 'checkbox': {
        const checked = (rt.values[key] ?? String(!!p.checked)) === 'true', err = rt.errors[key];
        return <div {...base} className="dsr-field">
          <label className="dsr-check"><input type="checkbox" data-key={key} checked={checked} disabled={!editing && p.disabled} required={p.required} aria-invalid={err ? true : undefined} tabIndex={editing ? -1 : undefined}
            onChange={e => { if (editing) return; const v = String(e.target.checked); setRt(r => { const { [key]: _x, ...errors } = r.errors; return { ...r, values: { ...r.values, [key]: v }, errors }; }); act(here, scope, 'change', v); }} />{p.label}</label>
          {err && <span className="dsr-error" role="alert">{err}</span>}
        </div>;
      }
      case 'radio': {
        const current = Number(rt.values[key] ?? p.selected ?? 0), name = safeId(key);
        return <fieldset {...base} className="dsr-radio"><legend>{p.label}</legend>{(p.options ?? []).map((opt, i) => <label key={i} className="dsr-check"><input type="radio" name={name} checked={current === i} tabIndex={editing ? -1 : undefined} onChange={() => { if (editing) return; setRt(r => ({ ...r, values: { ...r.values, [key]: String(i) } })); act(here, scope, 'change', opt); }} />{opt}</label>)}</fieldset>;
      }
      case 'switch': {
        const on = (rt.values[key] ?? String(!!p.checked)) === 'true';
        return <button {...base} type="button" role="switch" aria-checked={on} className="dsr-switch" disabled={!editing && p.disabled}
          onClick={e => { if (editing) return (base.onClick as (e: React.MouseEvent) => void)(e); e.stopPropagation(); const v = String(!on); setRt(r => ({ ...r, values: { ...r.values, [key]: v } })); act(here, scope, 'change', v); }}>
          <i aria-hidden="true" /><span>{p.label}</span>
        </button>;
      }
      case 'tabs': {
        const options = p.options ?? [], current = Math.min(options.length - 1, Math.max(0, Number(rt.values[`/${id}`] ?? rt.values[key] ?? p.selected ?? 0)));
        const panels = n.children;
        return <div {...base}>
          <Tabs ids={safeId(key)} options={options} label={p.label ?? 'Tabs'} current={current} disabled={editing} onChange={i => { setRt(r => ({ ...r, values: { ...r.values, [key]: String(i), [`/${id}`]: String(i) } })); act(here, scope, 'change', options[i]); }} />
          {panels.length > 0 && <div role="tabpanel" id={`${safeId(key)}-panel`} aria-labelledby={`${safeId(key)}-tab-${current}`} tabIndex={0} style={{ paddingTop: 16 }}>{draw(panels[Math.min(current, panels.length - 1)], scope, here, 'column', depth + 1)}</div>}
        </div>;
      }
      case 'menu': return <div {...base} style={{ ...style, display: 'inline-block' }}><Menu label={p.label ?? p.text ?? 'Menu'} text={p.text ?? p.label ?? 'Menu'} options={p.options ?? []} disabled={editing} onPick={v => act(here, scope, 'change', v)} /></div>;
      case 'navigation': {
        const options = p.options ?? [], current = Number(rt.values[key] ?? p.selected ?? 0), vertical = layout.direction === 'column';
        return <nav {...base} className="dsr-nav" aria-label={p.label ?? 'Navigation'} data-vertical={vertical}>
          <ul>{options.map((opt, i) => <li key={i}><button type="button" tabIndex={editing ? -1 : undefined} aria-current={current === i ? 'page' : undefined} onClick={e => { if (editing) return; e.stopPropagation(); setRt(r => ({ ...r, values: { ...r.values, [key]: String(i) } })); act(here, scope, 'change', opt); }}>{opt}</button></li>)}</ul>
        </nav>;
      }
      case 'pagination': {
        const total = Math.max(1, Math.min(50, p.values?.[0] ?? 5)), current = Number(rt.values[key] ?? p.selected ?? 0);
        const go = (i: number) => { if (editing) return; const page = Math.max(0, Math.min(total - 1, i)); setRt(r => ({ ...r, values: { ...r.values, [key]: String(page) } })); act(here, scope, 'change', String(page + 1)); };
        const shown = [...new Set([0, current - 1, current, current + 1, total - 1].filter(i => i >= 0 && i < total))].sort((a, b) => a - b);
        return <nav {...base} aria-label={p.label ?? 'Pagination'}><ul className="dsr-pages">
          <li><button type="button" aria-label="Previous page" disabled={current === 0} onClick={e => { e.stopPropagation(); go(current - 1); }}><Icon name="arrow-left" size={16} /></button></li>
          {shown.map((i, k) => <li key={i}>{k > 0 && shown[k - 1] !== i - 1 && <span aria-hidden="true" style={{ padding: '0 4px' }}>…</span>}<button type="button" aria-current={i === current ? 'page' : undefined} aria-label={`Page ${i + 1}`} onClick={e => { e.stopPropagation(); go(i); }}>{i + 1}</button></li>)}
          <li><button type="button" aria-label="Next page" disabled={current >= total - 1} onClick={e => { e.stopPropagation(); go(current + 1); }}><Icon name="arrow-right" size={16} /></button></li>
        </ul></nav>;
      }
      case 'tooltip': {
        const tipId = `${safeId(key)}-tip`;
        return <span {...base} className="dsr-tooltip" tabIndex={editing ? undefined : 0} aria-describedby={tipId}>{kids()}<span role="tooltip" id={tipId}>{p.text}</span></span>;
      }
      case 'notification': {
        const tone = p.tone ?? 'info';
        return <div {...base} className="dsr-notice" role={tone === 'danger' ? 'alert' : 'status'} style={{ borderColor: ref(tone), background: ref(`${tone}-subtle`), ...style }}>
          <span style={{ color: ref(tone), display: 'inline-flex', paddingTop: 2 }}><Icon name={p.icon ?? TONE_ICON[tone] ?? 'info'} /></span>
          <div>{p.label && <b>{p.label}</b>}<span {...inlineText(p.text)} /></div>
        </div>;
      }
      case 'progress': {
        const v = Math.max(0, Math.min(100, p.values?.[0] ?? 0));
        return <div {...base} className="dsr-field"><span>{p.label}</span><div className="dsr-progress" role="progressbar" aria-label={p.label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${v}%` }} /></div></div>;
      }
      case 'spinner': return <span {...base} className="dsr-spinner" role="status"><i aria-hidden="true" />{p.label ?? 'Loading'}</span>;
      case 'skeleton': return <div {...base} className="dsr-skeleton" aria-hidden="true">{Array.from({ length: Math.max(1, Math.min(12, p.values?.[0] ?? 3)) }, (_, i) => <i key={i} />)}</div>;
      case 'table': {
        const rows = p.rows ?? [], body = partial ? rows.slice(1, Math.max(2, Math.ceil(rows.length / 2))) : rows.slice(1);
        const numeric = (rows[1] ?? []).map((_, j) => rows.slice(1).every(r => /^[-+$€£¥]?[\d.,]+%?$/.test((r[j] ?? '').trim())));
        return <div {...base}>
          <div className="dsr-table" role="region" aria-label={p.label ?? 'Table'} tabIndex={0}>
            <table>{p.label && <caption>{p.label}</caption>}<thead><tr>{(rows[0] ?? []).map((v, i) => <th key={i} scope="col" style={numeric[i] ? { textAlign: 'right' } : undefined}>{v}</th>)}</tr></thead>
              <tbody>{body.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} style={numeric[j] ? { textAlign: 'right' } : undefined}>{v}</td>)}</tr>)}</tbody></table>
          </div>
          {partial && <p className="dsr-partial" role="status">Some rows couldn’t load. Showing what’s available.</p>}
        </div>;
      }
      case 'chart': return <div {...base} className="dsr-chart"><Chart kind={p.chart ?? 'bar'} label={p.label ?? 'Chart'} values={partial ? (p.values ?? []).slice(0, Math.ceil((p.values ?? []).length / 2)) : p.values ?? []} labels={p.options ?? []} />{partial && <p className="dsr-partial" role="status">Some values couldn’t load.</p>}</div>;
      case 'list': {
        const items = partial ? (p.options ?? []).slice(0, Math.ceil((p.options ?? []).length / 2)) : p.options ?? [];
        return <ul {...base} className="dsr-list" aria-label={p.label}>{items.map((v, i) => <li key={i}>{v}</li>)}</ul>;
      }
    }
  };

  // ---- overlays and focus -------------------------------------------------------------------------

  const overlayRef = useRef<HTMLDivElement>(null);
  const topOverlay = rt.overlays.at(-1);
  useEffect(() => {
    if (!topOverlay) { if (restoreFocus.current?.isConnected) restoreFocus.current.focus(); restoreFocus.current = null; return; }
    const el = overlayRef.current;
    const target = el?.querySelector<HTMLElement>('input,select,textarea,button:not(.dsr-close),[href],[tabindex="0"]') ?? el;
    target?.focus();
  }, [topOverlay]);
  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); setRt(r => ({ ...r, overlays: r.overlays.slice(0, -1), errors: {} })); return; }
    if (e.key !== 'Tab' || !overlayRef.current) return;
    const items = [...overlayRef.current.querySelectorAll<HTMLElement>('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[href],[tabindex="0"]')];
    if (!items.length) return;
    const firstEl = items[0], last = items[items.length - 1], active = globalThis.document.activeElement;
    if (e.shiftKey && active === firstEl) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && active === last) { e.preventDefault(); firstEl.focus(); }
  };

  const screen = byScreen.get(rt.screen) ?? d.screens[0];
  const style = { ...variables } as CSSProperties;
  return (
    <div ref={container} className="design-renderer" style={style} data-theme={dark ? 'dark' : 'light'} data-size={size} data-editing={editing || undefined} data-motion={motion}>
      <style>{DOCUMENT_STYLES}</style>
      <div key={`${screen?.id}-${rt.step}`} data-transition={rt.transition !== 'none' && !editing ? rt.transition : undefined} inert={rt.overlays.length > 0 && !editing ? true : undefined} style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        {screen && draw(screen.root, {}, [], 'none', 0)}
      </div>
      {!editing && rt.overlays.map((sid, i) => {
        const s = byScreen.get(sid);
        if (!s) return null;
        const top = i === rt.overlays.length - 1;
        return <div key={`${sid}-${i}`} className="dsr-scrim" data-kind={s.kind === 'drawer' ? 'drawer' : 'dialog'} onClick={e => { if (e.target === e.currentTarget) setRt(r => ({ ...r, overlays: r.overlays.slice(0, -1), errors: {} })); }} inert={top ? undefined : true}>
          <div ref={top ? overlayRef : undefined} className="dsr-overlay" role="dialog" aria-modal="true" aria-label={s.name} tabIndex={-1} onKeyDown={trap} data-transition={rt.transition !== 'none' ? (s.kind === 'drawer' ? 'slide' : rt.transition) : undefined}>
            <button type="button" className="dsr-close" aria-label={`Close ${s.name}`} onClick={() => setRt(r => ({ ...r, overlays: r.overlays.slice(0, -1), errors: {} }))}><Icon name="close" /></button>
            {draw(s.root, {}, [], 'none', 0)}
          </div>
        </div>;
      })}
    </div>
  );
}

const CLICKABLE = new Set(['button', 'link']);
const safeId = (key: string) => `dsr-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
const outermost = (scope: Scope): string => { let s: Scope = scope; while (s.outer?.instance) s = s.outer; return s.instance!; };
/** What a click selects: the outermost instance, or inner layers of the instance being inspected. */
function selectIdFor(id: string, scope: Scope, inside?: string): string {
  if (!scope.instance) return id;
  const chain: Scope[] = [];
  for (let s: Scope | undefined = scope; s?.instance; s = s.outer) chain.push(s);
  const top = chain[chain.length - 1].instance!;
  if (top !== inside) return top;
  return chain.length === 1 ? id : chain[chain.length - 2].instance!;
}

function Tabs({ ids, options, label, current, disabled, onChange }: { ids: string; options: string[]; label: string; current: number; disabled: boolean; onChange: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const key = (e: ReactKeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % options.length : e.key === 'ArrowLeft' ? (i - 1 + options.length) % options.length : e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(next);
    list.current?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
  };
  return <div ref={list} role="tablist" aria-label={label} className="dsr-tablist">
    {options.map((v, i) => <button key={i} id={`${ids}-tab-${i}`} type="button" role="tab" className="dsr-tab" aria-selected={current === i} aria-controls={`${ids}-panel`} tabIndex={disabled ? -1 : current === i ? 0 : -1} onClick={e => { if (disabled) return; e.stopPropagation(); onChange(i); }} onKeyDown={e => !disabled && key(e, i)}>{v}</button>)}
  </div>;
}

function Menu({ label, text, options, disabled, onPick }: { label: string; text: string; options: string[]; disabled: boolean; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const items = () => [...(wrap.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
  useEffect(() => { if (open) requestAnimationFrame(() => items()[0]?.focus()); }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    globalThis.document.addEventListener('mousedown', close);
    return () => globalThis.document.removeEventListener('mousedown', close);
  }, [open]);
  const move = (e: ReactKeyboardEvent) => {
    const list = items(), at = list.indexOf(globalThis.document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return <div ref={wrap} className="dsr-menu">
    <button ref={button} type="button" className="dsr-button" style={{ background: 'var(--dsr-surface)', color: 'var(--dsr-text)', borderColor: 'var(--dsr-strong)' }} aria-haspopup="menu" aria-expanded={open} aria-label={label !== text ? label : undefined} tabIndex={disabled ? -1 : undefined}
      onClick={e => { if (disabled) return; e.stopPropagation(); setOpen(v => !v); }} onKeyDown={e => { if (!disabled && e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}>
      {text}<Icon name="chevron-down" size={16} />
    </button>
    {open && <ul role="menu" aria-label={label} onKeyDown={move}>{options.map((o, i) => <li key={i} role="none"><button type="button" role="menuitem" tabIndex={-1} onClick={e => { e.stopPropagation(); setOpen(false); button.current?.focus(); onPick(o); }}>{o}</button></li>)}</ul>}
  </div>;
}

const SERIES = ['accent', 'info', 'success', 'warning', 'danger'];
function Chart({ kind, label, values, labels }: { kind: 'bar' | 'line' | 'donut'; label: string; values: number[]; labels: string[] }) {
  const max = Math.max(1, ...values), w = Math.max(240, values.length * 48), h = 180;
  const summary = `${label}: ${values.map((v, i) => `${labels[i] ?? `item ${i + 1}`} ${v}`).join(', ')}`;
  if (kind === 'donut') {
    const total = values.reduce((a, b) => a + b, 0) || 1, r = 60, c = 2 * Math.PI * r;
    let offset = 0;
    return <svg viewBox="0 0 320 160" role="img" aria-label={summary}><title>{summary}</title>
      <g transform="translate(80 80) rotate(-90)">{values.map((v, i) => { const len = (v / total) * c; const el = <circle key={i} r={r} fill="none" stroke={ref(SERIES[i % SERIES.length])} strokeWidth={22} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} />; offset += len; return el; })}</g>
      {values.slice(0, 6).map((v, i) => <g key={i} transform={`translate(170 ${24 + i * 22})`}><rect width="10" height="10" rx="2" fill={ref(SERIES[i % SERIES.length])} /><text x="16" y="9">{labels[i] ?? `Item ${i + 1}`} · {v}</text></g>)}
    </svg>;
  }
  const x = (i: number) => 24 + i * ((w - 48) / Math.max(1, values.length - 1));
  const y = (v: number) => h - 24 - (v / max) * (h - 48);
  return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={summary}><title>{summary}</title>
    <line x1="16" x2={w - 8} y1={h - 24} y2={h - 24} stroke="var(--dsr-border)" />
    {kind === 'bar'
      ? values.map((v, i) => { const bw = Math.min(36, (w - 32) / values.length - 10); const bx = 16 + i * ((w - 32) / values.length) + ((w - 32) / values.length - bw) / 2; return <rect key={i} x={bx} y={y(v)} width={bw} height={h - 24 - y(v)} rx="4" fill="var(--dsr-accent)" />; })
      : <><polyline fill="none" stroke="var(--dsr-accent)" strokeWidth="2.5" strokeLinejoin="round" points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />{values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill="var(--dsr-accent)" />)}</>}
    {labels.slice(0, values.length).map((t, i) => <text key={i} x={kind === 'bar' ? 16 + i * ((w - 32) / values.length) + (w - 32) / values.length / 2 : x(i)} y={h - 6} textAnchor="middle">{t}</text>)}
  </svg>;
}

/** One component drawn on its own with prop values and slot content, as used by exported code. */
export function ComponentRenderer({ document: d, componentId, variant, state, values, slots, dark = false, width, onAction, assetUrl }: {
  document: DesignDocument; componentId: string; variant?: string; state?: string; values?: Record<string, string | undefined>;
  slots?: Record<string, ReactNode>; dark?: boolean; width?: number; onAction?: (event: DesignActionEvent) => void; assetUrl?: (assetId: string) => string | undefined;
}) {
  const c = d.components[componentId];
  const doc = useMemo<DesignDocument | null>(() => {
    if (!c) return null;
    const overrides: Record<string, DesignOverride> = {};
    for (const prop of c.props ?? []) {
      const v = values?.[prop.id];
      if (v === undefined) continue;
      overrides[prop.node] = { ...overrides[prop.node], [prop.field]: prop.field === 'hidden' ? v === 'true' : v };
    }
    const host: DesignNode = { id: '__component', name: c.name, kind: 'instance', children: [], layout: { width: 'fill' }, props: { componentId, ...(variant ? { variant } : {}), ...(state ? { componentState: state } : {}), overrides } };
    return { ...d, nodes: { ...d.nodes, __component: host }, screens: [{ id: '__component-screen', name: c.name, root: '__component', states: ['success'] }] };
  }, [d, c, componentId, variant, state, values]);
  if (!doc) return null;
  return <DocumentRenderer document={doc} dark={dark} width={width} onAction={onAction} assetUrl={assetUrl} slots={slots} />;
}
