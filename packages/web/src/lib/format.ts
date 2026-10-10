// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import type { AgentStatus, RunState } from '@acc/core';

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso || iso === 'unknown') return 'unknown';
  const m = Math.round((Date.parse(iso) - now) / 60_000);
  if (m <= 0) return 'now';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'idle' | 'accent';

export const AGENT_TONE: Record<AgentStatus, Tone> = {
  running: 'ok',
  starting: 'info',
  waiting: 'warn',
  stalled: 'crit',
  failed: 'crit',
  limited: 'warn',
  paused: 'idle',
  offline: 'crit',
  idle: 'idle',
};

export const RUN_TONE: Record<RunState, Tone> = {
  queued: 'info',
  starting: 'info',
  running: 'ok',
  'waiting-for-approval': 'warn',
  'waiting-for-input': 'warn',
  stalled: 'crit',
  paused: 'idle',
  failed: 'crit',
  finished: 'accent',
  orphaned: 'crit',
};

export const initials = (name: string) =>
  name
    .split(/[\s-]+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** Stable hue per agent id for avatars. */
export function hue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
