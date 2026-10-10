// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EARLY_OUTPUT_LIMIT,
  pushBounded,
  shouldAcceptOutput,
  shouldBufferEarly,
  type TerminalOutput,
} from '../src/lib/nativeTerminal';

const output = (overrides: Partial<TerminalOutput> = {}): TerminalOutput => ({
  project: 'project-a',
  id: 'terminal-1',
  text: 'hello',
  seq: 1,
  ...overrides,
});

describe('native terminal transport', () => {
  beforeEach(() => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scopes live output to the active project and session with sequence deduplication', () => {
    const scope = { project: 'project-a', id: 'terminal-1' };
    expect(shouldAcceptOutput(output(), scope, 0)).toBe(true);
    expect(shouldAcceptOutput(output({ seq: 1 }), scope, 1)).toBe(false);
    expect(shouldAcceptOutput(output({ project: 'project-b' }), scope, 0)).toBe(false);
    expect(shouldAcceptOutput(output({ id: 'terminal-2' }), scope, 0)).toBe(false);
    expect(shouldAcceptOutput(output({ seq: 3 }), scope, 2)).toBe(true);
  });

  it('filters early buffering by project and known session id', () => {
    expect(shouldBufferEarly(output(), 'project-a', null)).toBe(true);
    expect(shouldBufferEarly(output(), 'project-b', null)).toBe(false);
    expect(shouldBufferEarly(output({ id: 'terminal-2' }), 'project-a', 'terminal-1')).toBe(false);
    expect(shouldBufferEarly(output(), 'project-a', 'terminal-1')).toBe(true);
  });

  it('bounds early output while attach is still in flight', () => {
    const early: TerminalOutput[] = [];
    for (let i = 1; i <= EARLY_OUTPUT_LIMIT + 5; i += 1) {
      pushBounded(early, output({ seq: i, text: `chunk-${i}` }));
    }
    expect(early).toHaveLength(EARLY_OUTPUT_LIMIT);
    expect(early[0]?.seq).toBe(6);
    expect(early.at(-1)?.seq).toBe(EARLY_OUTPUT_LIMIT + 5);
  });

  it('accepts camelCase exit metadata from native transport', () => {
    const payload: TerminalOutput = {
      project: 'project-a',
      id: 'terminal-1',
      text: 'done',
      seq: 4,
      exited: true,
      exitCode: 7,
      exitSignal: null,
      outputEnded: false,
      readFailed: false,
    };
    expect(payload.exitCode).toBe(7);
    expect(payload.outputEnded).toBe(false);
  });
});
