// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  abandonTerminal,
  pushBounded,
  safeTerminalResize,
  safeTerminalWrite,
  shouldAcceptOutput,
  shouldBufferEarly,
  type TerminalAttach,
  type TerminalOutput,
} from '../lib/nativeTerminal';

/**
 * A native terminal owned by one project. With `session` it reattaches to a running terminal and
 * replays its bounded scrollback; otherwise it opens a new one. Unmounting only detaches: the
 * terminal keeps running in its project until it is closed explicitly or the project stops.
 * `initialInput` is typed but never submitted, so the user reviews it and presses Return.
 */
export function NativeTerminal({
  project,
  session,
  kind = 'shell',
  agentId,
  assignmentId,
  initialInput,
  onSession,
  onExited,
  onClosed,
  onRetry,
}: {
  project: string;
  session?: string;
  kind?: 'shell' | 'login';
  agentId?: string;
  assignmentId?: string;
  initialInput?: string;
  onSession?: (id: string) => void;
  onExited?: (id: string) => void;
  onClosed?: (id: string) => void;
  onRetry?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resizeError, setResizeError] = useState('');
  const [exited, setExited] = useState(false);
  const [endState, setEndState] = useState<TerminalAttach | null>(null);
  const [activeId, setActiveId] = useState(session ?? '');
  const [attempt, setAttempt] = useState(0);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(false);
  const [closeError, setCloseError] = useState('');
  const openFresh = useRef(false);
  const retrySession = useRef<string | null>(null);
  const closePending = useRef<{ id: string; gen: number } | null>(null);
  const sessionCallback = useRef(onSession);
  const exitedCallback = useRef(onExited);
  const retryCallback = useRef(onRetry);
  const closedCallback = useRef(onClosed);
  sessionCallback.current = onSession;
  exitedCallback.current = onExited;
  retryCallback.current = onRetry;
  closedCallback.current = onClosed;

  const retry = () => {
    if (closePending.current) return;
    generation.current += 1;
    // A transport error is not evidence that the process ended. Reconnect to that session.
    openFresh.current = exited || closed || !activeId;
    retrySession.current = openFresh.current ? null : activeId;
    setAttempt((value) => value + 1);
    setError('');
    setResizeError('');
    setExited(false);
    setEndState(null);
    setClosed(false);
    setCloseError('');
    setLoading(true);
    setActiveId('');
    if (openFresh.current) retryCallback.current?.();
  };

  const close = async () => {
    if (!activeId || closePending.current) return;
    const id = activeId, gen = generation.current;
    const request = { id, gen };
    closePending.current = request;
    setClosing(true);
    setCloseError('');
    try {
      await invoke('terminal_close', { project, id });
      if (generation.current !== gen) return;
      setClosing(false);
      // Stop accepting input/output from this attachment only after native close succeeds.
      generation.current += 1;
      setActiveId('');
      setClosed(true);
      setExited(false);
      setEndState(null);
      setError('');
      setResizeError('');
      closedCallback.current?.(id);
    } catch (e) {
      if (generation.current === gen) setCloseError(`Could not close this session. It may still be running: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (closePending.current === request) closePending.current = null;
      if (generation.current === gen) setClosing(false);
    }
  };

  useEffect(() => {
    const gen = ++generation.current;
    closePending.current = null;
    let disposed = false;
    const attachTo = openFresh.current ? null : (retrySession.current ?? session ?? null);
    retrySession.current = null;
    setClosed(false);
    setClosing(false);
    setCloseError('');
    let id: string | null = attachTo;
    let attached = false;
    let after = 0;
    let unlisten: (() => void) | undefined;
    let published = Boolean(attachTo);
    const abandonUnpublished = () => {
      if (!attachTo && id && !published) {
        published = true;
        void abandonTerminal(project, id);
      }
    };
    const early: TerminalOutput[] = [];
    const stale = () => disposed || generation.current !== gen;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, monospace',
      scrollback: 10000,
      theme: { background: '#10151c', foreground: '#dde3ec' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(box.current!);
    fit.fit();
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (!id || !attached || stale() || closePending.current) return;
      void safeTerminalResize(project, id, terminal.rows, terminal.cols).then((message) => {
        if (!message || stale()) return;
        setResizeError(message);
      });
    });
    resize.observe(box.current!);
    const input = terminal.onData((text) => {
      if (!id || !attached || stale() || closePending.current) return;
      void safeTerminalWrite(project, id, text).then((message) => {
        if (!message || stale()) return;
        setError(message);
      });
    });
    const applyExit = (back: TerminalAttach) => {
      if (!back.exited) return;
      setExited(true);
      setEndState(back);
      if (id) exitedCallback.current?.(id);
    };
    const show = (o: TerminalOutput) => {
      if (!shouldAcceptOutput(o, { project, id }, after)) return;
      after = o.seq;
      terminal.write(o.text);
      if (o.exited) {
        setExited(true);
        setEndState(o as TerminalAttach);
        if (id) exitedCallback.current?.(id);
      }
    };
    void (async () => {
      try {
        const stop = await listen<TerminalOutput>('terminal-output', (event) => {
          if (stale()) return;
          if (!attached) {
            if (shouldBufferEarly(event.payload, project, id)) pushBounded(early, event.payload);
          } else {
            show(event.payload);
          }
        });
        if (stale()) {
          stop();
          return;
        }
        unlisten = stop;
        if (id) {
          const back = await invoke<TerminalAttach>('terminal_attach', { project, id });
          if (stale()) {
            unlisten();
            return;
          }
          terminal.write(back.text);
          after = back.seq;
          applyExit(back);
        } else {
          id = await invoke<string>('terminal_open', { project, kind, agentId: agentId ?? null, assignmentId: assignmentId ?? null });
          if (stale()) {
            unlisten();
            abandonUnpublished();
            return;
          }
          const back = await invoke<TerminalAttach>('terminal_attach', { project, id });
          if (stale()) {
            unlisten();
            abandonUnpublished();
            return;
          }
          terminal.write(back.text);
          after = back.seq;
          applyExit(back);
        }
        attached = true;
        setActiveId(id);
        for (const o of early) show(o);
        early.length = 0;
        fit.fit();
        const resizeMessage = await safeTerminalResize(project, id, terminal.rows, terminal.cols);
        if (resizeMessage && !stale()) setResizeError(resizeMessage);
        if (stale()) {
          unlisten();
          abandonUnpublished();
          return;
        }
        if (!attachTo && initialInput) {
          const writeMessage = await safeTerminalWrite(project, id, initialInput);
          if (writeMessage && !stale()) setError(writeMessage);
        }
        if (stale()) {
          unlisten();
          abandonUnpublished();
          return;
        }
        if (!attachTo && !stale()) {
          published = true;
          sessionCallback.current?.(id);
        }
        if (!stale()) {
          openFresh.current = false;
          setLoading(false);
          terminal.focus();
        }
      } catch (e) {
        abandonUnpublished();
        if (!stale()) {
          setLoading(false);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      disposed = true;
      if (generation.current === gen) generation.current += 1;
      abandonUnpublished();
      unlisten?.();
      input.dispose();
      resize.disconnect();
      terminal.dispose();
    };
  }, [project, session, kind, agentId, assignmentId, initialInput, attempt]);

  const notice = resizeError && !error ? resizeError : '';
  return (
    <div className="col native-terminal">
      <div className="small muted">
        {kind === 'login'
          ? 'Vendor login · credentials are handled by the official CLI'
          : 'Your project shell · commands run as your user'}
      </div>
      {loading && <p className="small muted" role="status">Opening terminal…</p>}
      {closeError && <div className="banner tone-crit" role="alert">{closeError}</div>}
      {(error || notice) && !closed && (
        <div className="banner tone-crit col" role="alert">
          <span>{error || notice}</span>
          <div className="row wrap">
            <button type="button" className="btn sm" disabled={closing} onClick={retry}>Retry</button>
          </div>
        </div>
      )}
      {exited && !loading && !closed && (
        <div className="banner tone-warn col" role="status">
          <span>
            {endState?.readFailed ? 'Terminal output could not be read; the process may still be running. Close this session to stop it.'
              : endState?.outputEnded ? 'Terminal output ended; the process may still be running. Close this session to stop it.'
              : kind === 'login'
              ? 'The login process ended. That does not prove sign-in succeeded or that paid overage is off.'
              : 'This terminal session has ended.'}
            {endState?.exitSignal ? ` Signal: ${endState.exitSignal}.` : endState?.exitCode != null ? ` Exit code: ${endState.exitCode}.` : ''}
          </span>
          <div className="row wrap">
            {kind === 'login' && <Link className="btn sm" to="/setup">Re-check agent in setup</Link>}
            <button type="button" className="btn sm" disabled={closing} onClick={retry}>Open another terminal</button>
          </div>
        </div>
      )}
      {activeId && !loading && !closed && <button type="button" className="btn sm" disabled={closing} onClick={() => void close()}>{closing ? 'Closing session…' : 'Close session'}</button>}
      {closed && <div className="banner tone-info col" role="status"><span>Terminal session closed.</span><button type="button" className="btn sm" onClick={retry}>Open another terminal</button></div>}
      <div ref={box} style={{ height: 360, padding: 10, background: '#10151c', borderRadius: 8 }} aria-busy={loading} />
    </div>
  );
}
