// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// UI sounds: six short brand sounds served from /sounds/ (first open, install, toggle, needs you, run done,
// alert). A per-device switch (default on), silent under reduced motion, and a missing file is simply never
// played. Nothing loops; nothing plays on every launch.
export type SoundName = 'first-open' | 'install-complete' | 'toggle-tick' | 'needs-you' | 'run-done' | 'alert';
export type SoundChoice = 'on' | 'off';
const KEY = 'one-connect.sounds';
const listeners = new Set<(v: SoundChoice) => void>();
const cache = new Map<SoundName, HTMLAudioElement | null>();

export function readSounds(): SoundChoice {
  try { return localStorage.getItem(KEY) === 'off' ? 'off' : 'on'; } catch { return 'on'; }
}
export function setSounds(v: SoundChoice): void {
  try { if (v === 'off') localStorage.setItem(KEY, 'off'); else localStorage.removeItem(KEY); } catch { /* private window */ }
  for (const l of listeners) l(v);
}
export function onSoundsChange(l: (v: SoundChoice) => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Play a brand sound once. Call from a user gesture where possible; browsers may block the rest, which stays silent. */
export function playSound(name: SoundName, volume = 0.5): void {
  if (readSounds() === 'off' || reducedMotion() || typeof Audio === 'undefined') return;
  try {
    let a = cache.get(name);
    if (a === undefined) {
      a = new Audio(`/sounds/${name}.mp3`);
      a.preload = 'auto';
      a.addEventListener('error', () => cache.set(name, null));
      cache.set(name, a);
    }
    if (!a || typeof a.play !== 'function') return;
    a.currentTime = 0;
    a.volume = volume;
    const p = a.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* blocked or missing: stay silent */ });
  } catch { /* never let a sound break the UI */ }
}
