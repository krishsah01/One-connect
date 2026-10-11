// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// First-run setup state, kept in this browser: which step the person reached, which agents they chose,
// which downloads they allowed, and whether setup is finished or paused while a terminal step runs.
import { useSyncExternalStore } from 'react';

export const SETUP_STEPS = ['welcome', 'appearance', 'agents', 'downloads', 'signin', 'project', 'phone', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export interface SetupState {
  step: SetupStep;
  done: boolean;
  /** Setup is hidden while the person runs a prepared command; a Resume button brings it back. */
  paused: boolean;
  /** Adapter ids of the agents the person wants. */
  chosen: string[];
  /** Adapter id → install option id the person explicitly allowed to be prepared. */
  allowed: Record<string, string>;
}
const KEY = 'one-connect.setup';
const DEFAULT: SetupState = { step: 'welcome', done: false, paused: false, chosen: [], allowed: {} };
let current: SetupState = read();
const listeners = new Set<() => void>();

function read(): SetupState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const v = JSON.parse(raw) as Partial<SetupState>;
    const step = SETUP_STEPS.includes(v.step as SetupStep) ? (v.step as SetupStep) : 'welcome';
    return {
      step,
      done: v.done === true,
      paused: v.paused === true,
      chosen: Array.isArray(v.chosen) ? v.chosen.filter((x): x is string => typeof x === 'string') : [],
      allowed: v.allowed && typeof v.allowed === 'object' ? (v.allowed as Record<string, string>) : {},
    };
  } catch { return DEFAULT; }
}
export function readSetup(): SetupState { return current; }
export function updateSetup(patch: Partial<SetupState>): void {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private window: lives for this session */ }
  for (const l of listeners) l();
}
export function resetSetup(): void { updateSetup({ ...DEFAULT }); }
export function useSetup(): SetupState {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current);
}
