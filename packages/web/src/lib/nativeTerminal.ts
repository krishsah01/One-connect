// SPDX-License-Identifier: Apache-2.0
// Client transport helpers for native terminals: bounded early output, scoped events and safe IPC.
import { invoke } from '@tauri-apps/api/core';

export const EARLY_OUTPUT_LIMIT = 128;

export interface TerminalOutput {
  project: string;
  id: string;
  text: string;
  seq: number;
  exited?: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
  outputEnded?: boolean;
  readFailed?: boolean;
}

export interface TerminalAttach {
  text: string;
  seq: number;
  exited: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
  outputEnded?: boolean;
  readFailed?: boolean;
}

export function shouldAcceptOutput(
  output: TerminalOutput,
  scope: { project: string; id: string | null },
  after: number,
): boolean {
  return Boolean(scope.id) && output.project === scope.project && output.id === scope.id && output.seq > after;
}

/** Buffer live events for a known session while open/attach is still in flight. */
export function shouldBufferEarly(output: TerminalOutput, project: string, id: string | null): boolean {
  if (output.project !== project) return false;
  if (id && output.id !== id) return false;
  return true;
}

/** Keep early live events bounded while open/attach is still in flight. */
export function pushBounded<T>(queue: T[], item: T, limit = EARLY_OUTPUT_LIMIT): void {
  queue.push(item);
  if (queue.length > limit) queue.splice(0, queue.length - limit);
}

export async function safeTerminalResize(
  project: string,
  id: string,
  rows: number,
  cols: number,
): Promise<string | null> {
  try {
    await invoke('terminal_resize', { project, id, rows, cols });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function safeTerminalWrite(project: string, id: string, text: string): Promise<string | null> {
  try {
    await invoke('terminal_write', { project, id, text });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function abandonTerminal(project: string, id: string): Promise<void> {
  try {
    await invoke('terminal_close', { project, id });
  } catch {
    // Best-effort cleanup when a late open lands after unmount or project switch.
  }
}
