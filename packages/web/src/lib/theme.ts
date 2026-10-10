// SPDX-License-Identifier: Apache-2.0
// Day, Night or Machine (follow the system). A per-viewer preference kept in this browser only.
import { useEffect, useState } from 'react';

export type ThemeChoice = 'day' | 'night' | 'machine';
const KEY = 'one-connect.theme';
const listeners = new Set<(t: ThemeChoice) => void>();

export function readTheme(): ThemeChoice {
  try { const v = localStorage.getItem(KEY); return v === 'day' || v === 'night' ? v : 'machine'; } catch { return 'machine'; }
}

export function applyTheme(t: ThemeChoice): void {
  const root = document.documentElement;
  if (t === 'machine') delete root.dataset.theme; else root.dataset.theme = t === 'day' ? 'light' : 'dark';
}

export function setTheme(t: ThemeChoice): void {
  try { localStorage.setItem(KEY, t); } catch { /* private window: still applies for this session */ }
  applyTheme(t);
  for (const l of listeners) l(t);
}

/** The current choice and the resolved light/dark mode, kept in sync with the system setting. */
export function useTheme(): { choice: ThemeChoice; mode: 'light' | 'dark' } {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const [systemDark, setSystemDark] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    listeners.add(setChoice);
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq?.addEventListener?.('change', onChange);
    return () => { listeners.delete(setChoice); mq?.removeEventListener?.('change', onChange); };
  }, []);
  return { choice, mode: choice === 'day' ? 'light' : choice === 'night' ? 'dark' : systemDark ? 'dark' : 'light' };
}
