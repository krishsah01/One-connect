// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { invoke } from '@tauri-apps/api/core';
import type { AgentState, ControlState } from '@acc/core';
const NativeTerminal = lazy(() => import('../components/NativeTerminal').then(m => ({ default: m.NativeTerminal })));
import { Badge, ErrorLine, useAction } from '../components/common';
import { DockerWorkbench } from '../components/DockerWorkbench';
import { shellJoin } from '@acc/core';
import { isDesktop, useActiveProject } from '../lib/desktop';
import { post } from '../lib/api';
import { loginArgs, loginBinaryPath, loginBinaryStaleReason } from '../lib/onboarding';

interface Session { id: string; label: string; exited: boolean; exitCode?: number | null; exitSignal?: string | null; outputEnded?: boolean; readFailed?: boolean }
interface Opening { kind: 'shell' | 'login'; agentId?: string; assignmentId?: string; initialInput?: string; nonce: number }
interface Command { project: string; text: string; label: string; nonce: number }
/** Route state may offer a command for review. It never opens a terminal or runs that command. */
interface TerminalRequest { project: string; command: string; label: string; agentId?: string; login: boolean }
const safePrefill = (text: string) => text.trim().length > 0 && text.length <= 8192 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text);
const nativeCall = <T,>(name: string, args: Record<string, unknown>) => invoke<T>(name, args).catch((e: unknown) => { throw e instanceof Error ? e : new Error(String(e)); });

function readRequest(value: unknown): TerminalRequest | null {
  if (!value || typeof value !== 'object' || !('terminalRequest' in value)) return null;
  const request = value.terminalRequest;
  if (!request || typeof request !== 'object' || !('project' in request) || !('command' in request)) return null;
  if (typeof request.project !== 'string' || typeof request.command !== 'string' || !safePrefill(request.command)) return null;
  return {
    project: request.project, command: request.command,
    label: 'label' in request && typeof request.label === 'string' ? request.label.slice(0, 160) : 'Prepared command',
    agentId: 'agentId' in request && typeof request.agentId === 'string' ? request.agentId : undefined,
    login: 'login' in request && request.login === true,
  };
}

export function Workspace({ state, demo = false }: { state: ControlState; demo?: boolean }) {
  const project = useActiveProject()?.project ?? state.project?.repo ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const sequence = useRef(0);
  const [command, setCommand] = useState<Command | null>(null);
  const [prefillError, setPrefillError] = useState<string | null>(null);
  const request = readRequest(location.state);
  const hasRequest = Boolean(location.state && typeof location.state === 'object' && 'terminalRequest' in location.state);
  const matchingRequest = request?.project === project ? request : null;
  const discardRequest = () => navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  const prepare = (text: string, label: string) => {
    if (!safePrefill(text)) { setPrefillError('This command contains a line break or control character. Open a project shell and type it yourself.'); return; }
    setPrefillError(null);
    setCommand({ project, text, label, nonce: ++sequence.current });
    document.getElementById('project-terminals')?.scrollIntoView({ block: 'start' });
  };
  return <div className="page col workspace-page">
    <div className="page-heading"><div><h1>Terminal &amp; containers</h1><p>Work in {state.project?.name ?? 'this project'} without leaving One Connect. Terminals and container controls belong to this project.</p></div><Link className="btn" to="/projects">Manage projects</Link></div>
    <nav className="workspace-shortcuts" aria-label="Related project work"><Link to="/board">Work board</Link><Link to="/">Approvals</Link><Link to="/decisions">Decisions</Link><Link to="/setup">Agents &amp; sign-in</Link><Link to="/mocks">Mocks &amp; artifacts</Link></nav>
    {hasRequest && !matchingRequest && <div className="banner tone-warn col" role="alert"><span>{request ? 'This prepared command belongs to another project. Return to agent setup in the current project to prepare it again.' : 'This prepared command could not be read safely. Open a project shell and type the command yourself.'}</span><button className="btn sm" onClick={discardRequest}>Dismiss prepared command</button></div>}
    {matchingRequest && <section className="card terminal-preparation" aria-label="Review prepared command"><div className="card-h"><h2>{matchingRequest.label}</h2><Badge tone="idle">Not run</Badge></div><div className="card-b col">
      <p>This command will be typed into a new shell for <b>{state.project?.name}</b>. Review it, then press Return in the terminal to run it.</p>
      <pre className="prepared-command">{matchingRequest.command}</pre>
      {matchingRequest.login && <p className="small muted">The official tool handles your credentials. Its sign-in flow may open the vendor's OAuth page in your browser; return here after completing it, then re-check the agent in setup.</p>}
      <div className="row wrap">{isDesktop ? <button className="btn primary" disabled={!project || demo} onClick={() => { prepare(matchingRequest.command, matchingRequest.label); discardRequest(); }}>Open shell with command</button> : <span className="small muted">Open this project in the Mac app to use its integrated terminal.</span>}<button className="btn" onClick={discardRequest}>Cancel</button>{matchingRequest.login && <Link className="btn" to="/setup">Back to agent setup</Link>}</div>
      {demo && <p className="small muted">Add a real project to prepare commands; connection states in the offline demo are sample data.</p>}
    </div></section>}
    <ErrorLine error={prefillError} />
    <ProjectTerminals key={project} state={state} command={command} demo={demo} />
    <DockerWorkbench onTerminal={isDesktop ? text => prepare(text, 'Container command') : undefined} />
  </div>;
}

/** Sessions keep running across navigation and project switches; closing one is explicit. */
export function ProjectTerminals({ state, command, demo }: { state: ControlState; command: Command | null; demo: boolean }) {
  const project = useActiveProject()?.project ?? '';
  const [mode, setMode] = useState<'shell' | 'login'>('shell');
  const loginAgents = Object.values(state.agents).filter(a => a.config.provider === 'subscription' && a.config.enabled !== false && loginArgs(a.config.adapter));
  const [agent, setAgent] = useState('');
  const chosenAgent = loginAgents.find(a => a.id === agent) ?? loginAgents[0];
  const loginStale = chosenAgent ? loginBinaryStaleReason(chosenAgent) : null;
  const loginBinary = chosenAgent ? loginBinaryPath(chosenAgent) : null;
  const loginCommand = chosenAgent && loginBinary ? shellJoin([loginBinary, ...(loginArgs(chosenAgent.config.adapter) ?? [])]) : null;
  const [assignment, setAssignment] = useState('');
  const worktrees = Object.values(state.assignments).filter(a => a.worktree);
  const chosenAssignment = worktrees.find(a => a.id === assignment);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState('');
  const [opening, setOpening] = useState<Opening | null>(null);
  const [loginExitNotice, setLoginExitNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const selectionTouched = useRef(false);
  const { busy, error, run, setError } = useAction();
  const list = useCallback(async () => {
    if (!project) return [];
    const next = await nativeCall<Session[]>('terminal_list', { project });
    setSessions(next);
    return next;
  }, [project]);
  useEffect(() => {
    if (!isDesktop || !project) return;
    let disposed = false;
    void list().then(next => { if (!disposed && !selectionTouched.current) setSelected(current => current && next.some(s => s.id === current) ? current : next.at(-1)?.id ?? ''); }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [project, list]);
  useEffect(() => {
    if (command && command.project === project && isDesktop && project) {
      selectionTouched.current = true;
      setSelected('');
      setMode('shell');
      setOpening({ kind: 'shell', initialInput: command.text, nonce: ++sequence.current });
    }
  }, [command, project]);
  if (!isDesktop) return <section className="card"><div className="card-h"><h2>Project terminal</h2></div><div className="card-b col"><p className="muted">The integrated terminal is available in the Mac app. This browser can still show agent output, work items and approvals.</p><div className="row wrap"><Link className="btn" to="/team">Open team workspace</Link><Link className="btn" to="/">View approvals</Link></div></div></section>;
  const open = () => run(async () => {
    selectionTouched.current = true;
    setSelected('');
    setLoginExitNotice(null);
    if (mode === 'login' && chosenAgent) {
      const { agent: refreshed } = await post<{ agent: AgentState }>(`/api/agents/${encodeURIComponent(chosenAgent.id)}/probe`);
      if (!refreshed || refreshed.config.enabled === false) throw new Error('Enable this agent in setup before running its official login.');
      const stale = loginBinaryStaleReason(refreshed);
      if (stale) throw new Error(stale);
      if (!loginBinaryPath(refreshed)) throw new Error('Probe this agent to locate its official CLI before signing in.');
    }
    setOpening({ kind: mode, agentId: mode === 'login' ? chosenAgent?.id : undefined, assignmentId: mode === 'shell' ? chosenAssignment?.id : undefined, nonce: ++sequence.current });
  });
  const close = (id: string) => run(async () => {
    await nativeCall('terminal_close', { project, id });
    if (selected === id) setSelected('');
    await list();
  });
  const onExited = (id: string) => {
    void list().then(next => {
      const session = next.find(s => s.id === id);
      if (session?.label.startsWith('Sign in') && session.exited && !session.outputEnded && !session.readFailed) {
        setLoginExitNotice('The official login process ended. Re-check the agent in setup before dispatching work.');
      }
    }).catch(e => setError(e.message));
  };
  const onClosed = (id: string) => {
    setSessions(current => current.filter(s => s.id !== id));
    setSelected(current => current === id ? '' : current);
    setOpening(null);
    setLoginExitNotice(null);
    void list().catch(e => setError(e.message));
  };
  return <section id="project-terminals" className="card project-terminals"><div className="card-h"><h2>Project terminal</h2><span className="spacer" /><button className="btn sm" disabled={busy || !project} onClick={() => void run(list)}>Refresh sessions</button></div><div className="card-b col">
    <p className="small muted">Sessions keep running when you leave this page or switch projects. Closing a terminal stops that session. Commands run as your Mac user.</p>
    <div className="terminal-controls">
      <label>Terminal type<select value={mode} onChange={e => setMode(e.target.value as 'shell' | 'login')}><option value="shell">Project shell</option><option value="login">Official agent sign-in</option></select></label>
      {mode === 'login' ? <label>Subscription agent<select value={chosenAgent?.id ?? ''} onChange={e => setAgent(e.target.value)}>{!loginAgents.length && <option value="">No enabled subscription agents</option>}{loginAgents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label> : <label>Working directory<select value={chosenAssignment?.id ?? ''} onChange={e => setAssignment(e.target.value)}><option value="">Project repository</option>{worktrees.map(a => <option key={a.id} value={a.id}>{state.workItems[a.workItemId]?.key ?? a.workItemId} · {state.agents[a.agentId]?.config.name ?? a.agentId}</option>)}</select></label>}
      <button className="btn primary" disabled={busy || !project || (mode === 'login' && (!loginCommand || demo))} onClick={() => void open()}>{mode === 'login' ? 'Run official login' : 'New project terminal'}</button>
    </div>
    {mode === 'login' && <div className="terminal-login-note col small">
      {loginStale ? <span>{loginStale}</span> : loginCommand ? <><code>{loginCommand}</code><span>The button re-checks this agent, then runs its official login command in a native terminal. The vendor may open an OAuth page in your browser. One Connect does not receive your password.</span></> : <span>{loginAgents.length ? 'Locate the CLI from Agents & sign-in first. Saved drafts cannot run native login until enabled.' : 'Create a subscription agent using Codex, Claude Code or Cursor, then prepare its login from agent setup.'}</span>}
      {demo && <span>Live sign-in is unavailable in the offline demo. Add a real project first.</span>}
      <Link to="/setup">Open agent setup and re-check after sign-in</Link>
    </div>}
    {loginExitNotice && <div className="banner tone-warn col" role="status"><span>{loginExitNotice}</span><div className="row wrap"><Link className="btn sm" to="/setup">Re-check in setup</Link><button type="button" className="btn sm" onClick={() => setLoginExitNotice(null)}>Dismiss</button></div></div>}
    {chosenAssignment && mode === 'shell' && <div className="row wrap small"><code>{chosenAssignment.worktree}</code><Link to={`/board?item=${encodeURIComponent(chosenAssignment.workItemId)}`}>Open work item</Link><Link to={`/agents/${encodeURIComponent(chosenAssignment.agentId)}`}>Agent output &amp; approvals</Link></div>}
    {sessions.length > 0 && <div className="terminal-session-list" aria-label="Project terminal sessions">{sessions.map(s => <div key={s.id} className="terminal-session"><button type="button" aria-pressed={selected === s.id} className={`btn sm${selected === s.id ? ' primary' : ''}`} onClick={() => { selectionTouched.current = true; setOpening(null); setSelected(s.id); }}>{s.label}{s.readFailed ? ' (output unavailable)' : s.outputEnded ? ' (output ended)' : s.exited ? ' (exited)' : ''}</button><button type="button" className="btn sm" disabled={busy} aria-label={`Close ${s.label}`} onClick={() => void close(s.id)}>×</button></div>)}</div>}
    {!selected && !opening && <div className="terminal-empty"><b>{sessions.length ? 'Choose a terminal to reconnect.' : 'Your project shell is ready to open.'}</b><p>Open a terminal at the repository root or an assignment's worktree. Nothing runs until you choose a command.</p></div>}
    <Suspense fallback={<p role="status">Opening terminal…</p>}>
      {opening && !selected && <NativeTerminal key={`new-${opening.nonce}`} project={project} kind={opening.kind} agentId={opening.agentId} assignmentId={opening.assignmentId} initialInput={opening.initialInput} onSession={id => { setOpening(null); setSelected(id); void list().catch(e => setError(e.message)); }} onExited={onExited} onClosed={onClosed} onRetry={() => { setOpening(current => current ? { ...current, nonce: ++sequence.current } : null); setSelected(''); }} />}
      {selected && <NativeTerminal key={selected} project={project} session={selected} kind={sessions.find(s => s.id === selected)?.label.startsWith('Sign in') ? 'login' : 'shell'} onExited={onExited} onClosed={onClosed} onRetry={() => { setSelected(''); setOpening({ kind: mode, agentId: mode === 'login' ? chosenAgent?.id : undefined, assignmentId: mode === 'shell' ? chosenAssignment?.id : undefined, nonce: ++sequence.current }); }} />}
    </Suspense>
    {command?.project === project && <p className="small terminal-prefill-status" role="status">{command.label}: typed into a new project shell, not run. Review the command in the terminal and press Return when ready.</p>}
    <ErrorLine error={error} />
  </div></section>;
}
