// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { ControlState } from '@acc/core';

vi.mock('../src/lib/desktop', () => ({ isDesktop: true, useActiveProject: () => ({ project: 'project-a' }) }));
vi.mock('../src/components/DockerWorkbench', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/components/DockerWorkbench')>();
  return { ...actual, DockerWorkbench: () => null };
});

const writes: string[] = [];
const inputs: ((text: string) => void)[] = [];
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    loadAddon() {}
    open() {}
    write(text: string) { writes.push(text); }
    focus() {}
    dispose() {}
    onData(cb: (text: string) => void) { inputs.push(cb); return { dispose() {} }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const native = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {};
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return { calls, handlers, listeners };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    native.calls.push({ cmd, args });
    const handler = native.handlers[cmd];
    if (!handler) throw new Error(`unexpected command ${cmd}`);
    return handler(args);
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, cb: (event: { payload: unknown }) => void) => {
    const listener = (payload: unknown) => cb({ payload });
    const set = native.listeners.get(event) ?? new Set();
    set.add(listener);
    native.listeners.set(event, set);
    return () => set.delete(listener);
  }),
}));

import { EARLY_OUTPUT_LIMIT } from '../src/lib/nativeTerminal';
import { NativeTerminal } from '../src/components/NativeTerminal';
import { Workspace } from '../src/pages/Workspace';

beforeEach(() => {
  native.calls.length = 0;
  native.listeners.clear();
  writes.length = 0;
  inputs.length = 0;
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  Object.assign(native.handlers, {
    terminal_open: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return 'terminal-9';
    },
    terminal_attach: () => ({ text: 'attached', seq: 2, exited: false, exitCode: null, exitSignal: null }),
    terminal_resize: () => null,
    terminal_write: () => null,
    terminal_close: () => null,
    terminal_list: () => [],
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('NativeTerminal transport', () => {
  it('keeps a failed close visible and retries the same session without reporting success', async () => {
    let attempts = 0;
    const onClosed = vi.fn();
    native.handlers.terminal_close = () => { if (++attempts === 1) throw new Error('fixture stop denied'); return null; };
    render(<NativeTerminal project="project-a" session="terminal-existing" onClosed={onClosed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close session' }));
    expect(await screen.findByText(/It may still be running: fixture stop denied/)).toBeTruthy();
    expect(screen.queryByText('Terminal session closed.')).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    expect(await screen.findByText('Terminal session closed.')).toBeTruthy();
    expect(onClosed).toHaveBeenCalledExactlyOnceWith('terminal-existing');
    expect(native.calls.filter(c => c.cmd === 'terminal_close').map(c => c.args)).toEqual([
      { project: 'project-a', id: 'terminal-existing' }, { project: 'project-a', id: 'terminal-existing' },
    ]);
  });

  it('blocks duplicate close requests and ignores a late failure after switching sessions', async () => {
    let reject!: (e: Error) => void;
    native.handlers.terminal_close = () => new Promise((_, r) => { reject = r; });
    const onClosed = vi.fn();
    const { rerender } = render(<NativeTerminal project="project-a" session="terminal-old" onClosed={onClosed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close session' }));
    expect(screen.getByRole('button', { name: 'Closing session…' }).hasAttribute('disabled')).toBe(true);
    expect(native.calls.filter(c => c.cmd === 'terminal_close')).toHaveLength(1);
    rerender(<NativeTerminal project="project-b" session="terminal-new" onClosed={onClosed} />);
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'terminal_attach' && c.args.project === 'project-b')).toBe(true));
    reject(new Error('old project stop denied'));
    await new Promise(r => setTimeout(r, 10));
    expect(screen.queryByText(/old project stop denied/)).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('reconnects after an input failure instead of opening another process', async () => {
    const onRetry = vi.fn();
    native.handlers.terminal_write = () => { throw new Error('fixture input failed'); };
    render(<NativeTerminal project="project-a" session="terminal-existing" onRetry={onRetry} />);
    await screen.findByRole('button', { name: 'Close session' });
    inputs[0]('echo test');
    expect(await screen.findByText('fixture input failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(native.calls.filter(c => c.cmd === 'terminal_attach')).toHaveLength(2));
    expect(native.calls.some(c => c.cmd === 'terminal_open')).toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.queryByText('fixture input failed')).toBeNull();
  });

  it('closes a late-opened session when unmounted before attach completes', async () => {
    let release!: () => void;
    native.handlers.terminal_open = () => new Promise<string>(resolve => { release = () => resolve('terminal-9'); });
    const { unmount } = render(<NativeTerminal project="project-a" kind="shell" />);
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'terminal_open')).toBe(true));
    unmount();
    release();
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'terminal_close' && c.args.id === 'terminal-9')).toBe(true));
  });

  it('unsubscribes when listen resolves after unmount', async () => {
    const unsub = vi.fn();
    let releaseListen!: (stop: () => void) => void;
    const { listen } = await import('@tauri-apps/api/event');
    vi.mocked(listen).mockImplementationOnce(() => new Promise((resolve) => {
      releaseListen = (stop) => resolve(() => { unsub(); stop(); });
    }));
    native.handlers.terminal_open = () => 'terminal-1';
    const { unmount } = render(<NativeTerminal project="project-a" kind="shell" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    unmount();
    releaseListen(() => {});
    await waitFor(() => expect(unsub).toHaveBeenCalledTimes(1));
  });

  it('ignores duplicate sequence events after attach', async () => {
    native.handlers.terminal_open = () => 'terminal-1';
    native.handlers.terminal_attach = () => ({ text: 'seed', seq: 2, exited: false });
    render(<NativeTerminal project="project-a" session="terminal-1" />);
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'terminal_attach')).toBe(true));
    const emit = [...(native.listeners.get('terminal-output') ?? [])];
    emit.forEach(cb => cb({ project: 'project-a', id: 'terminal-1', text: 'stale', seq: 1 }));
    emit.forEach(cb => cb({ project: 'project-a', id: 'terminal-1', text: 'fresh', seq: 3, exited: true }));
    expect(await screen.findByText(/session has ended|login process ended/i)).toBeTruthy();
  });

  it('open attaches scrollback and replays early events beyond the queue cap', async () => {
    let opened = false;
    native.handlers.terminal_open = async () => {
      opened = true;
      return 'terminal-9';
    };
    native.handlers.terminal_attach = () => ({
      text: 'scrollback',
      seq: EARLY_OUTPUT_LIMIT,
      exited: false,
      exitCode: null,
      exitSignal: null,
    });
    render(<NativeTerminal project="project-a" kind="shell" />);
    await waitFor(() => expect(opened).toBe(true));
    const emit = [...(native.listeners.get('terminal-output') ?? [])];
    for (let i = 1; i <= EARLY_OUTPUT_LIMIT + 10; i += 1) {
      emit.forEach(cb => cb({ project: 'project-a', id: 'terminal-9', text: `chunk-${i}`, seq: i }));
    }
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'terminal_attach' && c.args.id === 'terminal-9')).toBe(true));
    await waitFor(() => expect(writes.join('')).toContain('scrollback'));
    await waitFor(() => expect(writes.join('')).toContain(`chunk-${EARLY_OUTPUT_LIMIT + 10}`));
    expect(writes.some((chunk) => chunk === 'chunk-1')).toBe(false);
    expect(writes.some((chunk) => chunk === `chunk-${EARLY_OUTPUT_LIMIT + 1}`)).toBe(true);
  });

  it('retry after open failure opens exactly once more', async () => {
    let opens = 0;
    native.handlers.terminal_open = () => {
      opens += 1;
      if (opens === 1) throw new Error('Probe this agent to locate its official CLI');
      return 'terminal-retry';
    };
    native.handlers.terminal_attach = () => ({ text: '', seq: 0, exited: false });
    render(<NativeTerminal project="project-a" kind="login" agentId="cursor" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Probe this agent');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(opens).toBe(2));
    await waitFor(() => expect(native.calls.filter(c => c.cmd === 'terminal_open')).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retry from an exited session opens a new terminal instead of reattaching', async () => {
    const onRetry = vi.fn();
    const onSession = vi.fn();
    native.handlers.terminal_attach = () => ({ text: 'old', seq: 1, exited: true, exitCode: 0, exitSignal: null });
    native.handlers.terminal_open = () => 'terminal-new';
    render(<NativeTerminal project="project-a" session="terminal-old" onRetry={onRetry} onSession={onSession} />);
    await waitFor(() => expect(screen.getByText(/session has ended/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Open another terminal' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'terminal_open')).toBe(true));
    expect(native.calls.filter(c => c.cmd === 'terminal_attach' && c.args.id === 'terminal-old')).toHaveLength(1);
    await waitFor(() => expect(onSession).toHaveBeenCalledWith('terminal-new'));
  });

  it('abandons an unpublished open when navigation happens during resize', async () => {
    let release!: () => void;
    native.handlers.terminal_open = () => 'terminal-new';
    native.handlers.terminal_resize = () => new Promise(resolve => { release = () => resolve(null); });
    const onSession = vi.fn();
    const { unmount } = render(<NativeTerminal project="project-a" onSession={onSession} />);
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'terminal_resize')).toBe(true));
    unmount(); release();
    await waitFor(() => expect(native.calls.filter(c => c.cmd === 'terminal_close' && c.args.id === 'terminal-new')).toHaveLength(1));
    expect(onSession).not.toHaveBeenCalled();
  });

  it('retains a published session when navigating away', async () => {
    const onSession = vi.fn();
    const { unmount } = render(<NativeTerminal project="project-a" onSession={onSession} />);
    await waitFor(() => expect(onSession).toHaveBeenCalledWith('terminal-9'));
    unmount();
    expect(native.calls.some(c => c.cmd === 'terminal_close')).toBe(false);
  });

  it('preserves the entire native scrollback when a burst exceeds the pending event queue', async () => {
    let release!: () => void;
    native.handlers.terminal_open = () => new Promise(resolve => { release = () => resolve('terminal-burst'); });
    const text = Array.from({ length: 260 }, (_, i) => `chunk-${i + 1}\n`).join('');
    native.handlers.terminal_attach = () => ({ text, seq: 260, exited: false });
    render(<NativeTerminal project="project-a" />);
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'terminal_open')).toBe(true));
    const emit = [...(native.listeners.get('terminal-output') ?? [])];
    for (let i = 1; i <= 260; i++) emit.forEach(cb => cb({ project: 'project-a', id: 'terminal-burst', text: `chunk-${i}\n`, seq: i }));
    release();
    await waitFor(() => expect(writes.join('')).toBe(text));
    emit.forEach(cb => cb({ project: 'project-a', id: 'terminal-burst', text: 'next\n', seq: 261 }));
    await waitFor(() => expect(writes.join('')).toBe(text + 'next\n'));
  });

  it('labels output failure without claiming the login process exited', async () => {
    native.handlers.terminal_attach = () => ({ text: '', seq: 1, exited: true, readFailed: true });
    render(<MemoryRouter><NativeTerminal project="project-a" session="terminal-login" kind="login" /></MemoryRouter>);
    expect(await screen.findByText(/process may still be running/)).toBeTruthy();
    expect(screen.queryByText(/The login process ended/)).toBeNull();
  });

  it('Workspace does not turn lost login output into a process-exit notice', async () => {
    native.handlers.terminal_list = () => [{ id: 'terminal-login', label: 'Sign in Cursor', exited: true, readFailed: true }];
    native.handlers.terminal_attach = () => ({ text: '', seq: 1, exited: true, readFailed: true });
    const state = { project: { name: 'fixture', repo: '/fixture' }, agents: {}, assignments: {}, workItems: {} } as unknown as ControlState;
    render(<MemoryRouter><Workspace state={state} /></MemoryRouter>);
    expect(await screen.findByText(/process may still be running/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in Cursor (output unavailable)' })).toBeTruthy();
    expect(screen.queryByText('The official login process ended. Re-check the agent in setup before dispatching work.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close session' })).toBeTruthy();
  });

  it('Workspace keeps the terminal mounted and retries a failed open', async () => {
    let opens = 0;
    native.handlers.terminal_open = () => {
      if (++opens === 1) throw new Error('fixture opening failed');
      return 'terminal-recovered';
    };
    const state = { project: { name: 'fixture', repo: '/fixture' }, agents: {}, assignments: {}, workItems: {} } as unknown as ControlState;
    render(<MemoryRouter><Workspace state={state} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'New project terminal' }));
    expect(await screen.findByText('fixture opening failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(opens).toBe(2));
    await waitFor(() => expect(screen.queryByText('fixture opening failed')).toBeNull());
    expect(native.calls.filter(c => c.cmd === 'terminal_open')).toHaveLength(2);
  });

  it('shows retry controls when open fails', async () => {
    native.handlers.terminal_open = () => { throw new Error('Probe this agent to locate its official CLI'); };
    render(<NativeTerminal project="project-a" kind="login" agentId="cursor" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Probe this agent');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
