// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Appearance preferences kept in this browser only: Day, Night or Machine (follow the system), plus two
// accessibility switches from the design system — colour-blind-safe status colours and high contrast.
// They land on <html> as data-theme, data-vision and data-contrast; tokens.css maps the combination to a theme.
import { useEffect, useState } from 'react';

export type ThemeChoice = 'day' | 'night' | 'machine';
export type VisionChoice = 'standard' | 'cb';
export type ContrastChoice = 'standard' | 'high';
export interface Appearance { theme: ThemeChoice; vision: VisionChoice; contrast: ContrastChoice }
const KEY = 'one-connect.theme';
const VISION_KEY = 'one-connect.vision';
const CONTRAST_KEY = 'one-connect.contrast';
const listeners = new Set<(a: Appearance) => void>();

const get = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const put = (key: string, value: string | null): void => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private window: still applies for this session */ } };

export function readTheme(): ThemeChoice {
  const v = get(KEY); return v === 'day' || v === 'night' ? v : 'machine';
}
export function readAppearance(): Appearance {
  return { theme: readTheme(), vision: get(VISION_KEY) === 'cb' ? 'cb' : 'standard', contrast: get(CONTRAST_KEY) === 'high' ? 'high' : 'standard' };
}

export function applyTheme(t: ThemeChoice): void {
  const root = document.documentElement;
  if (t === 'machine') delete root.dataset.theme; else root.dataset.theme = t === 'day' ? 'light' : 'dark';
}
export function applyAppearance(a: Appearance): void {
  applyTheme(a.theme);
  const root = document.documentElement;
  if (a.vision === 'cb') root.dataset.vision = 'cb'; else delete root.dataset.vision;
  if (a.contrast === 'high') root.dataset.contrast = 'high'; else delete root.dataset.contrast;
}

const notify = () => { const a = readAppearance(); for (const l of listeners) l(a); };

export function setTheme(t: ThemeChoice): void {
  put(KEY, t);
  applyTheme(t);
  notify();
}
export function setVision(v: VisionChoice): void {
  put(VISION_KEY, v === 'cb' ? 'cb' : null);
  applyAppearance(readAppearance());
  notify();
}
export function setContrast(c: ContrastChoice): void {
  put(CONTRAST_KEY, c === 'high' ? 'high' : null);
  applyAppearance(readAppearance());
  notify();
}

/** The current choice and the resolved light/dark mode, kept in sync with the system setting. */
export function useTheme(): { choice: ThemeChoice; mode: 'light' | 'dark' } {
  const { theme: choice, mode } = useAppearance();
  return { choice, mode };
}

/** Every appearance preference plus the resolved light/dark mode. */
export function useAppearance(): Appearance & { mode: 'light' | 'dark' } {
  const [a, setA] = useState<Appearance>(readAppearance);
  const [systemDark, setSystemDark] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    listeners.add(setA);
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq?.addEventListener?.('change', onChange);
    return () => { listeners.delete(setA); mq?.removeEventListener?.('change', onChange); };
  }, []);
  const mode = a.theme === 'day' ? 'light' : a.theme === 'night' ? 'dark' : systemDark ? 'dark' : 'light';
  return { ...a, mode };
}
