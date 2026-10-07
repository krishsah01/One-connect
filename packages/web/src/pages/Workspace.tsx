// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ControlState } from '@acc/core';
const NativeTerminal = lazy(() => import('../components/NativeTerminal').then(m => ({ default: m.NativeTerminal })));
import { ErrorLine, useAction } from '../components/common';
import { DockerWorkbench } from '../components/DockerWorkbench';
import { isDesktop, useActiveProject } from '../lib/desktop';
interface Session { id: string; label: string; exited: boolean }
interface Opening { kind: 'shell' | 'login'; agentId?: string; assignmentId?: string; initialInput?: string; nonce: number }
export function Workspace({ state }: { state: ControlState }) {
  const [command, setCommand] = useState<{ text: string; nonce: number } | null>(null);
  return <div className="page col" style={{ gap: 18 }}><h1 style={{ fontSize: 20 }}>Terminal & containers</h1>
    <ProjectTerminals state={state} command={command} />
    <DockerWorkbench onTerminal={isDesktop ? text => setCommand({ text, nonce: Date.now() }) : undefined} />
  </div>;
}
/** This project's terminals. They keep running while you switch projects and reattach here. */
function ProjectTerminals({ state, command }: { state: ControlState; command: { text: string; nonce: number } | null }) {
  const project = useActiveProject()?.project ?? '';
  const [mode, setMode] = useState<'shell' | 'login'>('shell');
  const loginAgents = Object.values(state.agents).filter(a => ['codex-cli','claude-headless','cursor-agent-cli'].includes(a.config.adapter));
  const [agent, setAgent] = useState(loginAgents[0]?.id ?? '');
  const [assignment, setAssignment] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState('');
  const [opening, setOpening] = useState<Opening | null>(null);
  const { error, run } = useAction();
  const list = useCallback(async () => { if (!project) return []; const s = await invoke<Session[]>('terminal_list', { project }); setSessions(s); return s; }, [project]);
  useEffect(() => { if (!isDesktop || !project) return; void list().then(s => setSelected(cur => cur && s.some(x => x.id === cur) ? cur : s.at(-1)?.id ?? '')).catch(() => {}); }, [project, list]);
  useEffect(() => { if (command) { setSelected(''); setOpening({ kind: 'shell', initialInput: command.text, nonce: command.nonce }); } }, [command]);
  if (!isDesktop) return <section className="card"><div className="card-h"><h2>Terminal</h2></div><div className="card-b"><p className="muted">The native terminal is available in the Mac app. Agent transcripts and chat remain available in this browser.</p></div></section>;
  const open = () => { setSelected(''); setOpening({ kind: mode, agentId: mode === 'login' ? agent : undefined, assignmentId: mode === 'shell' ? assignment || undefined : undefined, nonce: Date.now() }); };
  const close = (id: string) => run(async () => { await invoke('terminal_close', { project, id }); if (selected === id) setSelected(''); await list(); });
  return <section className="card"><div className="card-h"><h2>Terminal</h2><span className="spacer" /><span className="small faint">Belongs to this project · keeps running when you switch projects</span></div><div className="card-b col">
    <div className="row wrap"><select aria-label="Terminal mode" value={mode} onChange={e => setMode(e.target.value as 'shell' | 'login')}><option value="shell">Project shell</option><option value="login">Sign in to agent</option></select>
      {mode === 'login' ? <select aria-label="Login agent" value={agent} onChange={e => setAgent(e.target.value)}>{loginAgents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select> : <select aria-label="Working directory" value={assignment} onChange={e => setAssignment(e.target.value)}><option value="">Project repository</option>{Object.values(state.assignments).filter(a => a.worktree).map(a => <option key={a.id} value={a.id}>{state.workItems[a.workItemId]?.key} · {a.agentId}</option>)}</select>}
      <button className="btn primary" disabled={mode === 'login' && !loginAgents.length} onClick={open}>New terminal</button></div>
    {sessions.length > 0 && <div className="row wrap" role="tablist" aria-label="Project terminals">{sessions.map(s => <span key={s.id} className="row" style={{ gap: 2 }}><button role="tab" aria-selected={selected === s.id} className={`btn sm${selected === s.id ? ' primary' : ''}`} onClick={() => { setOpening(null); setSelected(s.id); }}>{s.label}{s.exited ? ' (exited)' : ''}</button><button className="btn sm" aria-label={`Close ${s.label}`} onClick={() => void close(s.id)}>×</button></span>)}</div>}
    <Suspense fallback={<p>Opening terminal…</p>}>
      {opening && !selected && <NativeTerminal key={`new-${opening.nonce}`} project={project} kind={opening.kind} agentId={opening.agentId} assignmentId={opening.assignmentId} initialInput={opening.initialInput} onSession={id => { setOpening(null); setSelected(id); void list(); }} />}
      {selected && <NativeTerminal key={selected} project={project} session={selected} kind={sessions.find(s => s.id === selected)?.label.startsWith('Sign in') ? 'login' : 'shell'} />}
    </Suspense>
    {command && <p className="small faint">Commands from the Docker workbench are typed into a new project shell but not run; review them and press Return.</p>}
    <ErrorLine error={error} />
  </div></section>;
}
