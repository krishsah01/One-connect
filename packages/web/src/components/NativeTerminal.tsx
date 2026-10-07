// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
interface Output { project: string; id: string; text: string; seq: number }
/**
 * A native terminal owned by one project. With `session` it reattaches to a running terminal and
 * replays its bounded scrollback; otherwise it opens a new one. Unmounting only detaches: the
 * terminal keeps running in its project until it is closed explicitly or the project stops.
 * `initialInput` is typed but never submitted, so the user reviews it and presses Return.
 */
export function NativeTerminal({ project, session, kind = 'shell', agentId, assignmentId, initialInput, onSession }: { project: string; session?: string; kind?: 'shell' | 'login'; agentId?: string; assignmentId?: string; initialInput?: string; onSession?: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const sessionCallback = useRef(onSession);
  sessionCallback.current = onSession;
  useEffect(() => {
    let disposed = false;
    let id: string | null = session ?? null;
    let attached = false;
    let after = 0;
    let unlisten: (() => void) | undefined;
    const early: Output[] = [];
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, monospace', scrollback: 10000, theme: { background: '#10151c', foreground: '#dde3ec' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(box.current!); fit.fit();
    const resize = new ResizeObserver(() => { fit.fit(); if (id && attached) void invoke('terminal_resize', { project, id, rows: terminal.rows, cols: terminal.cols }); });
    resize.observe(box.current!);
    const input = terminal.onData(text => { if (id && attached) void invoke('terminal_write', { project, id, text }).catch(e => setError(String(e))); });
    const show = (o: Output) => { if (o.project === project && o.id === id && o.seq > after) { after = o.seq; terminal.write(o.text); } };
    void (async () => {
      unlisten = await listen<Output>('terminal-output', event => { if (!attached) early.push(event.payload); else show(event.payload); });
      if (disposed) { unlisten(); return; }
      if (id) {
        const back = await invoke<{ text: string; seq: number }>('terminal_attach', { project, id });
        if (disposed) return;
        terminal.write(back.text);
        after = back.seq;
      } else {
        id = await invoke<string>('terminal_open', { project, kind, agentId: agentId ?? null, assignmentId: assignmentId ?? null });
        if (disposed) return;
      }
      attached = true;
      for (const o of early) show(o);
      early.length = 0;
      fit.fit(); await invoke('terminal_resize', { project, id, rows: terminal.rows, cols: terminal.cols });
      if (!session && initialInput) await invoke('terminal_write', { project, id, text: initialInput });
      if (!session) sessionCallback.current?.(id);
      terminal.focus();
    })().catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; unlisten?.(); input.dispose(); resize.disconnect(); terminal.dispose(); };
  }, [project, session, kind, agentId, assignmentId, initialInput]);
  return <div className="col"><div className="small muted">{kind === 'login' ? 'Vendor login · credentials are handled by the official CLI' : 'Your project shell · commands run as your user'}</div>{error && <div className="banner tone-crit">{error}</div>}<div ref={box} style={{ height: 360, padding: 10, background: '#10151c', borderRadius: 8 }} /></div>;
}
