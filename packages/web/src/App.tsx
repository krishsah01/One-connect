// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router';
import { Badge, ErrorLine, useAction } from './components/common';
import { post } from './lib/api';
import { live, openProject, useLive } from './lib/store';
import { DEMO_PROJECT, isDesktop, listProjects, useActiveProject, type ProjectList } from './lib/desktop';
const Projects = lazy(()=>import('./pages/Projects').then(m=>({default:m.Projects})));
const AgentConsole = lazy(()=>import('./pages/AgentConsole').then(m=>({default:m.AgentConsole})));
const AgentsSetup = lazy(()=>import('./pages/AgentsSetup').then(m=>({default:m.AgentsSetup})));
const MissionControl = lazy(()=>import('./pages/MissionControl').then(m=>({default:m.MissionControl})));
const Workspace = lazy(()=>import('./pages/Workspace').then(m=>({default:m.Workspace})));
const WorkBoard = lazy(()=>import('./pages/WorkBoard').then(m=>({default:m.WorkBoard})));
const Team = lazy(()=>import('./pages/Team').then(m=>({default:m.Team})));
const Analytics = lazy(()=>import('./pages/Analytics').then(m=>({default:m.Analytics})));
const Docs = lazy(()=>import('./pages/Docs').then(m=>({default:m.Docs})));
const AgentBuilder = lazy(()=>import('./pages/AgentBuilder').then(m=>({default:m.AgentBuilder})));
const Designer = lazy(()=>import('./pages/Designer').then(m=>({default:m.Designer})));
const Workflows = lazy(()=>import('./pages/Workflows').then(m=>({default:m.Workflows})));
const Decisions = lazy(()=>import('./pages/Decisions').then(m=>({default:m.Decisions})));
const Skills = lazy(()=>import('./pages/Skills').then(m=>({default:m.Skills})));
const Connectors = lazy(()=>import('./pages/Connectors').then(m=>({default:m.Connectors})));
const Mocks = lazy(()=>import('./pages/Mocks').then(m=>({default:m.Mocks})));

export function App() {
  const { state, conn, meta, loadError } = useLive();
  useEffect(() => live.start(), []);
  const { busy, error, run } = useAction();
  const project = useActiveProject();

  if (conn === 'unauthorized') {
    return (
      <div className="splash card card-b col">
        <h1 style={{ fontSize: 20 }}>Sign in</h1>
        <p className="muted">
          This control center only accepts signed-in browsers. In a terminal on this machine, from the repo, run <code>pnpm acc open</code> (for the demo: <code>pnpm demo:open</code>). It opens a one-time sign-in link in your browser. The link the daemon printed at startup works once, within 2 minutes.
        </p>
      </div>
    );
  }
  if (!state) {
    if (isDesktop && conn === 'offline') return <div className="splash card card-b col"><h1>{project ? `${project.name} is not available` : 'App startup failed'}</h1><p className="muted">{loadError}</p><p className="faint">Retrying automatically…</p>{project?.project !== DEMO_PROJECT && <button className="btn" onClick={() => void openProject(DEMO_PROJECT).catch(() => {})}>Open the offline demo instead</button>}</div>;
    return <div className="splash empty">{conn === 'offline' ? 'Daemon unreachable: start it with `acc daemon`. Retrying…' : 'Connecting…'}</div>;
  }
  const kill = state.killSwitch.engaged;
  const pending = Object.values(state.approvals).filter((a) => !a.resolvedAt).length;
  const decisions = Object.values(state.decisions).filter((d) => !d.answeredAt && !d.consumedAt).length;
  const critical = Object.values(state.alerts).filter((a) => !a.resolvedAt && a.severity === 'critical').length;
  return (
    <div className="workbench">
      <aside className="workspace-sidebar">
        <LinkBrand />
        <div className="sidebar-project"><span className="small muted">Current project</span><b>{state.project?.name ?? 'Choose a project'}</b>{isDesktop && <ProjectSwitcher />}</div>
        <nav className="workspace-navigation" aria-label="Workspace navigation">
          <NavLink to="/" end>Overview{pending ? <span>{pending}</span> : null}</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/team">Team workspace</NavLink>
          <NavLink to="/board">Work board</NavLink>
          <NavLink to="/workflows">Workflows</NavLink>
          <NavLink to="/decisions">Decisions{decisions ? <span>{decisions}</span> : null}</NavLink>
          <NavLink to="/analytics">Analytics</NavLink>
          <NavLink to="/docs">One Answer</NavLink>
          <NavLink to="/designer">Designer</NavLink>
          <NavLink to="/skills">Skills</NavLink>
          <NavLink to="/connectors">Connectors</NavLink>
          <NavLink to="/mocks">Mocks</NavLink>
          <NavLink to="/workspace">Terminal & containers</NavLink>
          <NavLink to="/setup">Agents & connections</NavLink>
        </nav>
        <div className="sidebar-team"><h2>Your agents</h2>{Object.values(state.agents).map(a => <NavLink key={a.id} to={`/agents/${a.id}`}><span className={`sidebar-status status-${a.status}`}/><span className="ellipsis grow">{a.config.name}</span><span className="small faint">{a.status}</span></NavLink>)}</div>
        <div className="sidebar-footer"><b>Local workspace</b><span>{Object.values(state.agents).some(a => a.config.metered_opt_in) ? 'Paid agents explicitly enabled' : 'Paid fallback off'}</span></div>
      </aside>
      <main className="workbench-main">
      <header className="topbar">
        <span className="small muted">One Connect</span><span className="topbar-project">{state.project?.name}</span>
        <span className="spacer" />
        {critical > 0 && <Badge tone="crit">{critical} critical</Badge>}
        <Badge tone={conn === 'live' ? 'ok' : 'warn'}>{conn === 'live' ? 'live' : 'reconnecting'}</Badge>
        <button
          className={`btn sm kill ${kill ? 'danger solid' : 'danger'}`}
          disabled={busy}
          title={kill ? 'Release the kill switch' : `Stop every run in ${state.project?.name ?? 'this project'} now and block new dispatch. Projects has a kill switch for all projects.`}
          onClick={() => {
            if (kill || window.confirm(`Stop ALL agent runs in ${state.project?.name ?? 'this project'} now and block new dispatch?`)) void run(() => post('/api/kill-switch', { engaged: !kill }));
          }}
        >
          {kill ? 'Kill switch ON · release' : 'Kill switch'}
        </button>
      </header>
      {meta.demo && <div className="banner tone-info" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>Offline demo · scripted agents and sample models · no subscription usage or live tracker connections</div>}
      {kill && (
        <div className="banner tone-crit" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>
          Kill switch engaged{state.killSwitch.by ? ` by ${state.killSwitch.by}` : ''}: all runs stopped, dispatch blocked.
        </div>
      )}
      {error && <ErrorLine error={error} />}
      <Suspense key={project?.project ?? 'browser'} fallback={<div className="page empty" role="status">Opening workspace…</div>}><Routes>
        <Route path="/" element={<MissionControl state={state} />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/board" element={<WorkBoard state={state} trackerTarget={meta.tracker?.target ?? 'tracker'} />} />
        <Route path="/workflows" element={<Workflows state={state} />} />
        <Route path="/decisions" element={<Decisions state={state} />} />
        <Route path="/agents/:id" element={<AgentConsole state={state} />} />
        <Route path="/agents/new" element={<AgentBuilder state={state} />} />
        <Route path="/agents/:id/edit" element={<AgentBuilder state={state} />} />
        <Route path="/workspace" element={<Workspace state={state} />} />
        <Route path="/setup" element={<AgentsSetup state={state} tracker={meta.tracker} />} />
        <Route path="/team" element={<Team state={state} />} />
        <Route path="/analytics" element={<Analytics state={state} />} />
        <Route path="/docs" element={<Docs state={state} />} />
        <Route path="/designer" element={<Designer state={state} />} />
        <Route path="/skills" element={<Skills state={state} />} />
        <Route path="/connectors" element={<Connectors state={state} />} />
        <Route path="/mocks" element={<Mocks state={state} />} />
        <Route path="/mocks/:id" element={<Mocks state={state} />} />
        <Route path="*" element={<div className="page empty">Not found</div>} />
      </Routes></Suspense>
      </main>
    </div>
  );
}

/** Quick switch between added projects; other projects keep running in the background. */
function ProjectSwitcher() {
  const active = useActiveProject();
  const navigate = useNavigate();
  const [list, setList] = useState<ProjectList | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { const load = () => void listProjects().then(setList).catch(() => {}); load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [active?.project]);
  const options = [...(list?.projects ?? []).map(p => ({ id: p.id, label: `${p.running ? '● ' : ''}${p.name}` })), { id: DEMO_PROJECT, label: `${list?.demo.running ? '● ' : ''}Offline demo` }];
  return <div className="col" style={{ gap: 4 }}>
    <select aria-label="Switch project" disabled={busy} value={active?.project ?? ''} onChange={e => { const id = e.target.value; if (id === '__manage') navigate('/projects'); else void run(() => openProject(id)); }}>
      {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      <option value="__manage">Add or manage projects…</option>
    </select>
    {error && <span className="small" role="alert">{error}</span>}
  </div>;
}

function LinkBrand() {
  return <div className="one-connect-brand"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><rect x="2" y="3" width="17" height="12" rx="6" fill="none" stroke="currentColor" strokeWidth="3" transform="rotate(-35 14 14)"/><rect x="9" y="13" width="17" height="12" rx="6" fill="none" stroke="currentColor" strokeWidth="3" transform="rotate(-35 14 14)"/></svg><span>One Connect</span></div>;
}
