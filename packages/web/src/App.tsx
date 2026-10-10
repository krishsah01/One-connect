// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { Badge, ErrorLine, useAction } from './components/common';
import { post } from './lib/api';
import { live, openProject, useLive } from './lib/store';
import { BrowserNotifier, OfflineBanner, PhoneTabBar } from './components/PhoneShell';
import { useOnline } from './lib/offline';
import { can, canMutate, useRemoteSession, type RemoteSession } from './lib/remote';
import { DEMO_PROJECT, isDesktop, listProjects, useActiveProject, type ProjectList } from './lib/desktop';
import { Shell } from './shell/Shell';
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
const Phone = lazy(()=>import('./pages/Phone').then(m=>({default:m.Phone})));
const Reports = lazy(()=>import('./pages/Reports').then(m=>({default:m.Reports})));
const Remote = lazy(()=>import('./pages/Remote').then(m=>({default:m.Remote})));
const RunView = lazy(()=>import('./pages/RunView').then(m=>({default:m.RunView})));
const Mocks = lazy(()=>import('./pages/Mocks').then(m=>({default:m.Mocks})));
const ReleaseCockpit = lazy(()=>import('./pages/ReleaseCockpit').then(m=>({default:m.ReleaseCockpit})));
const Settings = lazy(()=>import('./pages/Settings').then(m=>({default:m.Settings})));

const NAVIGATION = [
  { label: 'Work', links: [
    { to: '/', label: 'Overview & approvals', count: 'approvals' },
    { to: '/board', label: 'Work board' },
    { to: '/team', label: 'Team workspace' },
    { to: '/decisions', label: 'Decisions', count: 'decisions' },
    { to: '/workflows', label: 'Workflows' },
    { to: '/release', label: 'Release' },
  ] },
  { label: 'Context & output', links: [
    { to: '/docs', label: 'One Ask' },
    { to: '/designer', label: 'Designer' },
    { to: '/mocks', label: 'Mocks & artifacts' },
    { to: '/reports', label: 'Brief & reports' },
    { to: '/analytics', label: 'Analytics' },
  ] },
  { label: 'Set up & connect', links: [
    { to: '/projects', label: 'Projects' },
    { to: '/setup', label: 'Agents & sign-in' },
    { to: '/workspace', label: 'Terminal & containers' },
    { to: '/connectors', label: 'Connectors' },
    { to: '/skills', label: 'Skills' },
    { to: '/settings', label: 'Settings & policies' },
    { to: '/remote', label: 'Phone & alerts' },
    { to: '/phone', label: 'Phone view' },
  ] },
] as const;
const PHONE_NAVIGATION = [{ label: 'This project', links: [
  { to: '/', label: 'Project home & approvals', count: 'approvals' },
  { to: '/phone', label: 'Now' },
  { to: '/decisions', label: 'Decisions', count: 'decisions' },
  { to: '/reports', label: 'Brief & reports' },
] }] as const;

function navigationGroup(pathname: string): string {
  return NAVIGATION.find(section => section.links.some(link => link.to === '/' ? pathname === '/' : pathname === link.to || pathname.startsWith(`${link.to}/`)))?.label ?? (pathname.startsWith('/agents/') ? 'Set up & connect' : 'Work');
}

function phonePageAvailable(pathname: string, session: RemoteSession): boolean {
  if (['/', '/phone', '/reports'].includes(pathname)) return can(session, 'read');
  if (pathname === '/decisions') return can(session, 'decisions');
  if (/^\/runs\/[^/]+$/.test(pathname)) return can(session, 'transcript');
  return false;
}

export function App() {
  const { state, conn, meta, loadError } = useLive();
  useEffect(() => live.start(), []);
  const { busy, error, run } = useAction();
  const project = useActiveProject();
  const online = useOnline();
  const { session, checked: remoteChecked, mode } = useRemoteSession();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<string[]>(() => session ? ['This project', ...(location.pathname.startsWith('/runs/') ? ['Run output'] : [])] : [...new Set(['Work', navigationGroup(location.pathname)])]);
  const navigationButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setNavigationOpen(false);
    const group = session ? location.pathname.startsWith('/runs/') ? 'Run output' : 'This project' : navigationGroup(location.pathname);
    setExpandedSections(current => current.includes(group) ? current : [...current, group]);
  }, [location.pathname, location.search, project?.project, session?.id]);
  const closeNavigation = () => { setNavigationOpen(false); navigationButton.current?.focus(); };
  const toggleSection = (label: string, open: boolean) => setExpandedSections(current => open ? current.includes(label) ? current : [...current, label] : current.includes(label) ? current.filter(name => name !== label) : current);

  if (conn === 'unauthorized' || mode === 'unauthorized') {
    return (
      <div className="splash card card-b col">
        <h1 style={{ fontSize: 20 }}>Sign in</h1>
        {isDesktop ? <><p className="muted">The Mac app could not authorize this project's local connection. Reopen the project to refresh its local session.</p><button className="btn" disabled={busy || !project} onClick={() => { if (project) void run(() => openProject(project.project)); }}>Reconnect this project</button><ErrorLine error={error} /></> : ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname) ? (
          <p className="muted">
            This control center only accepts signed-in browsers. In a terminal on this machine, from the repo, run <code>pnpm acc open</code> (for the demo: <code>pnpm demo:open</code>). It opens a one-time sign-in link in your browser. The link the daemon printed at startup works once, within 2 minutes.
          </p>
        ) : (
          <p className="muted">This phone is not paired, or its pairing expired or was revoked. On the Mac open Phone & alerts and create a fresh single-use pairing link, then open it here.</p>
        )}
      </div>
    );
  }
  if (!state) {
    if (isDesktop && conn === 'offline') return <div className="splash card card-b col"><h1>{project ? `${project.name} is not available` : 'App startup failed'}</h1><p className="muted">{loadError}</p><p className="faint">Retrying automatically…</p>{project?.project !== DEMO_PROJECT && <button className="btn" onClick={() => void openProject(DEMO_PROJECT).catch(() => {})}>Open the offline demo instead</button>}</div>;
    return <div className="splash empty">{conn === 'offline' ? 'Daemon unreachable: start it with `acc daemon`. Retrying…' : 'Connecting…'}</div>;
  }
  if (!remoteChecked || mode === 'checking') return <div className="splash empty" role="status">Checking this browser's project access…</div>;
  if (mode !== 'local' && !session) return <div className="splash empty" role="status">Project connection unavailable. Reconnecting…</div>;
  // The local dashboard is the canvas shell; a paired phone keeps its focused layout below.
  if (!session) return <Shell key={project?.project ?? 'browser'} state={state} conn={conn} meta={{ demo: Boolean(meta.demo), tracker: meta.tracker ?? null }} projectSwitcher={isDesktop ? <ProjectSwitcher /> : <b className="ellipsis" title="This browser is connected to this project.">{state.project?.name ?? 'Choose a project'}</b>} />;
  const kill = state.killSwitch.engaged;
  const pending = Object.values(state.approvals).filter((a) => !a.resolvedAt).length;
  const decisions = Object.values(state.decisions).filter((d) => !d.answeredAt && !d.consumedAt).length;
  const critical = Object.values(state.alerts).filter((a) => !a.resolvedAt && a.severity === 'critical').length;
  const enabledAgents = Object.values(state.agents).filter(a => a.config.enabled !== false);
  const needsConnection = enabledAgents.length === 0 || enabledAgents.some(a => a.config.provider === 'subscription' && a.config.adapter !== 'relay' && a.auth.state !== 'logged_in');
  const navigation = (session ? PHONE_NAVIGATION : NAVIGATION).map(section => ({ ...section, links: section.links.filter(link => !session || phonePageAvailable(link.to, session)) })).filter(section => section.links.length > 0);
  const phoneRuns = session && can(session, 'transcript') ? Object.values(state.runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8) : [];
  return (
    <div className="workbench">
      <a className="workspace-skip" href="#workspace-content">Skip to workspace</a>
      <aside className="workspace-sidebar" onKeyDown={e => { if (e.key === 'Escape' && navigationOpen) { e.stopPropagation(); closeNavigation(); } }}>
        <div className="sidebar-brand-row"><LinkBrand /><button ref={navigationButton} type="button" className="btn sm workspace-nav-toggle" aria-controls="workspace-navigation" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(v => !v)}>{navigationOpen ? 'Close navigation' : 'Navigate'}</button></div>
        <div className="sidebar-project"><span className="small muted">Current project</span><b>{state.project?.name ?? 'Choose a project'}</b>{isDesktop ? <ProjectSwitcher /> : <span className="small muted">{session ? 'This phone is paired to this project only.' : 'This browser is connected to this project.'}</span>}</div>
        <nav id="workspace-navigation" className={`workspace-navigation${navigationOpen ? ' is-open' : ''}`} aria-label="Workspace navigation">
          {navigation.map(section => <details className="workspace-nav-section" key={section.label} open={expandedSections.includes(section.label)} onToggle={e => toggleSection(section.label, e.currentTarget.open)}>
            <summary>{section.label}</summary>
            {section.links.map(link => {
              const count = 'count' in link ? link.count === 'approvals' ? pending : decisions : 0;
              return <NavLink key={link.to} to={link.to} end={link.to === '/'} onClick={e => { if (navigationOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { setNavigationOpen(false); document.getElementById('workspace-content')?.focus(); } }}>{session && link.to === '/' ? 'Project home & approvals' : link.label}{count > 0 && <span aria-label={`${count} waiting`}>{count}</span>}</NavLink>;
            })}
          </details>)}
          {phoneRuns.length > 0 && <details className="workspace-nav-section" open={expandedSections.includes('Run output')} onToggle={e => toggleSection('Run output', e.currentTarget.open)}><summary>Run output</summary>{phoneRuns.map(r => <NavLink key={r.id} to={`/runs/${encodeURIComponent(r.id)}`}>{state.agents[r.agentId]?.config.name ?? r.agentId}<span>{r.state}</span></NavLink>)}</details>}
          <button type="button" className="btn workspace-nav-toggle" onClick={closeNavigation}>Close navigation</button>
        </nav>
        {!session && <div className="sidebar-team"><h2>Your agents</h2>{Object.values(state.agents).map(a => <NavLink key={a.id} to={`/agents/${encodeURIComponent(a.id)}`}><span className={`sidebar-status status-${a.status}`}/><span className="ellipsis grow">{a.config.name}</span><span className="small faint">{a.status}</span></NavLink>)}</div>}
        <div className="sidebar-footer"><b>{session ? 'Paired phone' : 'Local workspace'}</b><span>{session ? 'Only controls granted for this project' : enabledAgents.some(a => a.config.metered_opt_in) ? 'Metered agents explicitly enabled' : 'No metered agents enabled'}</span></div>
      </aside>
      <main id="workspace-content" className="workbench-main" tabIndex={-1}>
      <header className="topbar">
        <span className="small muted">One Connect</span><span className="topbar-project" title={state.project?.name}>{state.project?.name}</span>
        <span className="spacer" />
        {pending > 0 && <Link className="topbar-attention" to="/">Approvals <b>{pending}</b></Link>}
        {decisions > 0 && can(session, 'decisions') && <Link className="topbar-attention" to="/decisions">Decisions <b>{decisions}</b></Link>}
        {critical > 0 && <Badge tone="crit">{critical} critical</Badge>}
        <Badge tone={conn === 'live' ? 'ok' : 'warn'}>{conn === 'live' ? 'live' : 'reconnecting'}</Badge>
        {can(session, 'kill_switch') && <button
          className={`btn sm kill ${kill ? 'danger solid' : 'danger'}`}
          disabled={busy || !online || conn !== 'live' || !canMutate(session, 'kill_switch') || (Boolean(session) && kill)}
          title={kill ? session ? 'Release the kill switch in the Mac app' : 'Release the kill switch' : `Stop every run in ${state.project?.name ?? 'this project'} now and block new dispatch.${session ? '' : ' Projects has a kill switch for all projects.'}`}
          onClick={() => {
            if (conn !== 'live' || !online || !canMutate(session, 'kill_switch') || (session && kill)) return;
            if (kill || window.confirm(`Stop ALL agent runs in ${state.project?.name ?? 'this project'} now and block new dispatch?`)) void run(() => post('/api/kill-switch', { engaged: !kill }));
          }}
        >
          {kill ? session ? 'Stopped · release on Mac' : 'Kill switch ON · release' : 'Kill switch'}
        </button>}
      </header>
      <OfflineBanner />
      <BrowserNotifier />
      {meta.demo && <div className="banner tone-info" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>Offline demo · scripted agents and sample models · no subscription usage or live tracker connections</div>}
      {kill && (
        <div className="banner tone-crit" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>
          Kill switch engaged{state.killSwitch.by ? ` by ${state.killSwitch.by}` : ''}: all runs stopped, dispatch blocked.
        </div>
      )}
      {error && <ErrorLine error={error} />}
      {location.pathname === '/' && needsConnection && !meta.demo && !session && <div className="workspace-next-step"><span><b>{enabledAgents.length ? 'Agent connection needs attention.' : 'Connect your first agent.'}</b> Choose an official runtime, sign in and check its connection before assigning work.</span><Link className="btn sm" to="/setup">Open agent setup</Link></div>}
      <Suspense key={project?.project ?? 'browser'} fallback={<div className="page empty" role="status">Opening workspace…</div>}>{session && !phonePageAvailable(location.pathname, session) ? <div className="page col"><h1>Use a section available to this phone</h1><p className="muted">This phone shows the controls granted during pairing. Use One Connect on your Mac for project setup and management.</p><div className="row wrap">{can(session, 'read') && <Link className="btn" to="/phone">Project home</Link>}{can(session, 'decisions') && <Link className="btn" to="/decisions">Decisions</Link>}{can(session, 'read') && <Link className="btn" to="/reports">Reports</Link>}</div></div> : <Routes>
        <Route path="/" element={session ? <Phone state={state} /> : <MissionControl state={state} />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/board" element={<WorkBoard state={state} trackerTarget={meta.tracker?.target ?? 'tracker'} />} />
        <Route path="/workflows" element={<Workflows state={state} />} />
        <Route path="/decisions" element={<Decisions state={state} />} />
        <Route path="/phone" element={<Phone state={state} />} />
        <Route path="/reports" element={<Reports state={state} />} />
        <Route path="/remote" element={<Remote state={state} />} />
        <Route path="/runs/:id" element={<RunView state={state} />} />
        <Route path="/release" element={<ReleaseCockpit state={state} />} />
        <Route path="/agents/:id" element={<AgentConsole state={state} />} />
        <Route path="/agents/new" element={<AgentBuilder state={state} />} />
        <Route path="/agents/:id/edit" element={<AgentBuilder state={state} />} />
        <Route path="/workspace" element={<Workspace state={state} demo={meta.demo} />} />
        <Route path="/setup" element={<AgentsSetup state={state} tracker={meta.tracker} demo={meta.demo} />} />
        <Route path="/settings" element={<Settings state={state} />} />
        <Route path="/team" element={<Team state={state} />} />
        <Route path="/analytics" element={<Analytics state={state} />} />
        <Route path="/docs" element={<Docs state={state} />} />
        <Route path="/designer" element={<Designer state={state} />} />
        <Route path="/skills" element={<Skills state={state} />} />
        <Route path="/connectors" element={<Connectors state={state} />} />
        <Route path="/mocks" element={<Mocks state={state} />} />
        <Route path="/mocks/:id" element={<Mocks state={state} />} />
        <Route path="*" element={<div className="page col"><h1>Page not found</h1><p className="muted">Open this project's work board or choose a section from navigation.</p><div className="row wrap"><Link className="btn" to="/board">Open work board</Link><Link className="btn" to="/">Overview</Link></div></div>} />
      </Routes>}</Suspense>
      </main>
      <PhoneTabBar state={state} />
    </div>
  );
}

/** Quick switch between added projects; other projects keep running in the background. */
export function ProjectSwitcher() {
  const active = useActiveProject();
  const navigate = useNavigate();
  const [list, setList] = useState<ProjectList | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { const load = () => void listProjects().then(setList).catch(() => {}); load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [active?.project]);
  const options = [...(list?.projects ?? []).map(p => ({ id: p.id, label: `${p.running ? '● ' : ''}${p.name}` })), { id: DEMO_PROJECT, label: `${list?.demo.running ? '● ' : ''}Offline demo` }];
  return <div className="col" style={{ gap: 4 }}>
    <select aria-label="Switch project" disabled={busy} value={active?.project ?? ''} onChange={e => { const id = e.target.value; if (id === '__manage') navigate('/projects'); else void run(() => openProject(id)); }}>
      {active && !options.some(o => o.id === active.project) && <option value={active.project}>{active.name}</option>}
      {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      <option value="__manage">Add or manage projects…</option>
    </select>
    {error && <span className="small" role="alert">{error}</span>}
  </div>;
}

function LinkBrand() {
  return <div className="one-connect-brand"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><rect x="2" y="3" width="17" height="12" rx="6" fill="none" stroke="currentColor" strokeWidth="3" transform="rotate(-35 14 14)"/><rect x="9" y="13" width="17" height="12" rx="6" fill="none" stroke="currentColor" strokeWidth="3" transform="rotate(-35 14 14)"/></svg><span>One Connect</span></div>;
}
