// SPDX-License-Identifier: Apache-2.0
// Small stroke icons for the canvas shell. Decorative: every use carries a text label or aria-label.
const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM20 20l-4-4',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  stop: 'M7 7h10v10H7z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  canvas: 'M4 6h5v4H4zM15 14h5v4h-5zM9 8h3a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  eye: 'M2 12s4-7 10-7s10 7 10 7s-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 6.6C3.9 8.3 2 12 2 12s4 6 10 6c1.6 0 3-.4 4.3-1',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  play: 'M8 5l11 7l-11 7z',
  pause: 'M8 5v14M16 5v14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  chevronUp: 'M6 15l6-6l6 6',
  chevronDown: 'M6 9l6 6l6-6',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  terminal: 'M4 5h16v14H4zM8 10l3 2l-3 2M13 15h3',
  ask: 'M12 21a9 9 0 1 0-8.2-5.3L3 21l5.3-.8A9 9 0 0 0 12 21zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 16.5h.01',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16 5l4 1l-3 14l-4-1z',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={PATHS[name]} /></svg>;
}
