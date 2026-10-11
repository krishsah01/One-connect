// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The local dashboard shell: one canvas (or the issue list) as the main surface, a short top bar,
// and every other tool in a side drawer, the Settings dialog or the command palette. Existing
// routes keep working; they now open over the canvas instead of replacing it.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, matchPath, Route, Routes, useLocation, useNavigate } from 'react-router';
import type { ControlState } from '@acc/core';
import { ApprovalCard, Badge, ErrorLine, useAction, useTick } from '../components/common';
import { post } from '../lib/api';
import { canMutate } from '../lib/remote';
import { useOnline } from '../lib/offline';
import { isDesktop } from '../lib/desktop';
import { needsAgentConnection } from '../lib/onboarding';
import { BrowserNotifier, OfflineBanner } from '../components/PhoneShell';
import { Icon, type IconName } from './icons';
import { BottomPanel, readPanelPrefs, savePanelPrefs, type PanelPrefs } from './BottomPanel';
import { applyTheme, readTheme, setTheme, useTheme, type ThemeChoice } from '../lib/theme';
import './shell.css';

const Canvas = lazy(() => import('../pages/Canvas').then(m => ({ default: m.Canvas })));
const WorkBoard = lazy(() => import('../pages/WorkBoard').then(m => ({ default: m.WorkBoard })));
const Projects = lazy(() => import('../pages/Projects').then(m => ({ default: m.Projects })));
const AgentConsole = lazy(() => import('../pages/AgentConsole').then(m => ({ default: m.AgentConsole })));
const AgentsSetup = lazy(() => import('../pages/AgentsSetup').then(m => ({ default: m.AgentsSetup })));
const MissionControl = lazy(() => import('../pages/MissionControl').then(m => ({ default: m.MissionControl })));
const Workspace = lazy(() => import('../pages/Workspace').then(m => ({ default: m.Workspace })));
const Team = lazy(() => import('../pages/Team').then(m => ({ default: m.Team })));
const Analytics = lazy(() => import('../pages/Analytics').then(m => ({ default: m.Analytics })));
const Docs = lazy(() => import('../pages/Docs').then(m => ({ default: m.Docs })));
const AgentBuilder = lazy(() => import('../pages/AgentBuilder').then(m => ({ default: m.AgentBuilder })));
const Designer = lazy(() => import('../pages/Designer').then(m => ({ default: m.Designer })));
const Workflows = lazy(() => import('../pages/Workflows').then(m => ({ default: m.Workflows })));
const Decisions = lazy(() => import('../pages/Decisions').then(m => ({ default: m.Decisions })));
const Skills = lazy(() => import('../pages/Skills').then(m => ({ default: m.Skills })));
const Connectors = lazy(() => import('../pages/Connectors').then(m => ({ default: m.Connectors })));
const Phone = lazy(() => import('../pages/Phone').then(m => ({ default: m.Phone })));
const Reports = lazy(() => import('../pages/Reports').then(m => ({ default: m.Reports })));
const Remote = lazy(() => import('../pages/Remote').then(m => ({ default: m.Remote })));
const RunView = lazy(() => import('../pages/RunView').then(m => ({ default: m.RunView })));
const Mocks = lazy(() => import('../pages/Mocks').then(m => ({ default: m.Mocks })));
const ReleaseCockpit = lazy(() => import('../pages/ReleaseCockpit').then(m => ({ default: m.ReleaseCockpit })));
const Settings = lazy(() => import('../pages/Settings').then(m => ({ default: m.Settings })));

export interface ShellMeta { demo: boolean; tracker: { type: string; target: string; live: boolean } | null }

/** Settings dialog sections, in order. Each keeps its existing route so links and bookmarks work. */
export const SETTINGS_TABS = [
  { id: 'settings', path: '/settings', label: 'Project and policies', also: [] as string[] },
  { id: 'agents', path: '/setup', label: 'Agents and sign-in', also: ['/agents/new', '/agents/:id/edit'] },
  { id: 'connectors', path: '/connectors', label: 'Connectors', also: [] },
  { id: 'skills', path: '/skills', label: 'Skills', also: [] },
  { id: 'projects', path: '/projects', label: 'Projects', also: [] },
  { id: 'phone', path: '/remote', label: 'Phone and alerts', also: ['/phone'] },
] as const;

const INSIGHT_TABS = [
  { path: '/insights', label: 'Overview' },
  { path: '/reports', label: 'Brief and reports' },
  { path: '/analytics', label: 'Analytics' },
  { path: '/release', label: 'Release' },
] as const;

type Surface =
  | { kind: 'base' }
  | { kind: 'settings'; tab: (typeof SETTINGS_TABS)[number]['id'] }
  | { kind: 'drawer'; title: string; wide?: boolean; body: 'inbox' | 'insights' | 'docs' | 'designer' | 'mocks' | 'agent' | 'team' | 'workspace' | 'run' | 'workflows' | 'decisions' };

const is = (pattern: string, path: string) => Boolean(matchPath({ path: pattern, end: true }, path));

/** Which surface a route opens. The canvas or list always stays mounted underneath. */
export function surfaceFor(path: string): Surface {
  for (const t of SETTINGS_TABS) if (is(t.path, path) || t.also.some(p => is(p, path))) return { kind: 'settings', tab: t.id };
  if (is('/inbox', path)) return { kind: 'drawer', title: 'Inbox', body: 'inbox' };
  if (is('/decisions', path)) return { kind: 'drawer', title: 'Decisions', body: 'decisions' };
  if (INSIGHT_TABS.some(t => is(t.path, path))) return { kind: 'drawer', title: 'Insights', body: 'insights', wide: true };
  if (is('/docs', path)) return { kind: 'drawer', title: 'One Ask', body: 'docs', wide: true };
  if (is('/designer', path)) return { kind: 'drawer', title: 'Designer', body: 'designer', wide: true };
  if (is('/mocks', path) || is('/mocks/:id', path)) return { kind: 'drawer', title: 'Mocks', body: 'mocks', wide: true };
  if (is('/agents/:id', path)) return { kind: 'drawer', title: 'Agent', body: 'agent', wide: true };
  if (is('/team', path)) return { kind: 'drawer', title: 'Team conversations', body: 'team', wide: true };
  if (is('/workspace', path)) return { kind: 'drawer', title: 'Terminal and containers', body: 'workspace', wide: true };
  if (is('/runs/:id', path)) return { kind: 'drawer', title: 'Run output', body: 'run', wide: true };
  if (is('/workflows', path)) return { kind: 'drawer', title: 'All workflows', body: 'workflows', wide: true };
  return { kind: 'base' };
}

export function Shell({ state, meta, conn, projectSwitcher }: { state: ControlState; meta: ShellMeta; conn: string; projectSwitcher: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();
  const { busy, error, run } = useAction();
  const [palette, setPalette] = useState(false);
  const [panel, setPanel] = useState<PanelPrefs>(readPanelPrefs);
  const onPanel = (p: PanelPrefs) => { setPanel(p); savePanelPrefs(p); };
  const { choice } = useTheme();
  useEffect(() => { applyTheme(readTheme()); }, []);
  const surface = surfaceFor(location.pathname);
  const listView = location.pathname === '/board';
  const lastBase = useRef(listView ? '/board' : '/');
  useEffect(() => { if (surface.kind === 'base') lastBase.current = location.pathname === '/board' ? '/board' : '/'; }, [surface.kind, location.pathname]);
  const close = () => navigate(lastBase.current);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(v => !v); }
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); setPanel(p => { const next = { ...p, open: !p.open }; savePanelPrefs(next); return next; }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const kill = state.killSwitch.engaged;
  const approvals = Object.values(state.approvals).filter(a => !a.resolvedAt).length;
  const decisions = Object.values(state.decisions).filter(d => !d.answeredAt && !d.consumedAt).length;
  const critical = Object.values(state.alerts).filter(a => !a.resolvedAt && a.severity === 'critical').length;
  const inbox = approvals + decisions + critical;
  const enabledAgents = Object.values(state.agents).filter(a => a.config.enabled !== false);
  const needsConnection = needsAgentConnection(Object.values(state.agents));
  const name = state.project?.name ?? 'this project';

  return (
    <div className="shell">
      <a className="workspace-skip" href="#shell-main">Skip to workspace</a>
      <header className="shell-bar">
        <Link to="/" className="shell-brand" aria-label="One Connect canvas"><BrandMark /></Link>
        <div className="shell-project">
          <span className={`shell-live ${conn === 'live' ? 'on' : ''}`} title={conn === 'live' ? 'Live' : 'Reconnecting'} aria-label={conn === 'live' ? 'Live' : 'Reconnecting'} />
          {projectSwitcher}
        </div>
        <div className="shell-views" role="group" aria-label="Main view">
          <Link to="/" className={!listView ? 'on' : ''} aria-current={!listView ? 'page' : undefined}><Icon name="canvas" />Canvas</Link>
          <Link to="/board" className={listView ? 'on' : ''} aria-current={listView ? 'page' : undefined}><Icon name="list" />List</Link>
        </div>
        <button type="button" className="shell-ask" onClick={() => setPalette(true)} aria-keyshortcuts="Meta+K Control+K" aria-label="Ask or jump to (⌘K)"><Icon name="search" /><span>Ask or jump to…</span><kbd>⌘K</kbd></button>
        <span className="spacer" />
        <Link to="/inbox" className={`shell-icon-btn${inbox ? ' attention' : ''}`} aria-label={inbox ? `Inbox, ${inbox} waiting` : 'Inbox'}><Icon name="bell" /><span className="shell-label">Inbox</span>{inbox > 0 && <b>{inbox}</b>}</Link>
        <Link to="/insights" className="shell-icon-btn" aria-label="Insights"><Icon name="chart" /><span className="shell-label">Insights</span></Link>
        <button type="button" className={`shell-icon-btn${panel.open ? ' on' : ''}`} aria-label={panel.open ? 'Hide terminal and logs' : 'Show terminal and logs'} aria-pressed={panel.open} aria-keyshortcuts="Control+`" title="Terminal and logs (Ctrl+`)" onClick={() => onPanel({ ...panel, open: !panel.open })}><Icon name="terminal" /><span className="shell-label">Console</span></button>
        <ThemeButton choice={choice} />
        <Link to="/settings" className="shell-icon-btn" aria-label="Settings"><Icon name="gear" /><span className="shell-label">Settings</span></Link>
        <button
          type="button"
          className={`btn sm kill ${kill ? 'danger solid' : 'danger'}`}
          disabled={busy || !online || conn !== 'live' || !canMutate(null, 'kill_switch')}
          title={kill ? 'Release the kill switch' : `Stop every run in ${name} now and block new dispatch. Projects has a kill switch for all projects.`}
          onClick={() => { if (kill || window.confirm(`Stop ALL agent runs in ${name} now and block new dispatch?`)) void run(() => post('/api/kill-switch', { engaged: !kill })); }}
        ><Icon name="stop" size={14} />{kill ? 'Stopped · release' : 'Stop all'}</button>
      </header>
      {meta.demo && <div className="shell-note tone-info">Offline demo · scripted agents and sample models · no subscription usage or live tracker connections</div>}
      {kill && <div className="shell-note tone-crit" role="status">Kill switch engaged{state.killSwitch.by ? ` by ${state.killSwitch.by}` : ''}: all runs stopped, dispatch blocked.</div>}
      {needsConnection && !meta.demo && <div className="shell-note tone-warn"><span><b>{enabledAgents.length ? 'An agent connection needs attention.' : 'Connect your first agent.'}</b> Choose an official runtime, sign in and check its connection before assigning work.</span><Link className="btn sm" to="/setup">Open agent setup</Link></div>}
      <OfflineBanner />
      <BrowserNotifier />
      <ErrorLine error={error} />
      <main id="shell-main" className="shell-main" tabIndex={-1}>
        <Suspense fallback={<div className="page empty" role="status">Opening workspace…</div>}>
          {listView ? <div className="shell-list"><WorkBoard state={state} trackerTarget={meta.tracker?.target ?? 'tracker'} /></div> : <Canvas state={state} />}
        </Suspense>
      </main>
      <BottomPanel state={state} demo={meta.demo} prefs={panel} onPrefs={onPanel} />
      {surface.kind === 'drawer' && <Drawer title={surface.title} wide={surface.wide} onClose={close}><DrawerBody body={surface.body} state={state} meta={meta} /></Drawer>}
      {surface.kind === 'settings' && <SettingsDialog tab={surface.tab} state={state} meta={meta} onClose={close} />}
      {palette && <CommandPalette state={state} onClose={() => setPalette(false)} />}
    </div>
  );
}

function BrandMark() {
  return <svg width="22" height="22" viewBox="0 0 28 28" aria-hidden="true"><rect x="2" y="3" width="17" height="12" rx="6" fill="none" stroke="currentColor" strokeWidth="3" transform="rotate(-35 14 14)"/><rect x="9" y="13" width="17" height="12" rx="6" fill="none" stroke="currentColor" strokeWidth="3" transform="rotate(-35 14 14)"/></svg>;
}

/** Focus moves in on open and back to the opener on close; Escape closes. */
function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
  return { ref, onKeyDown };
}

function Drawer({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: ReactNode }) {
  const { ref, onKeyDown } = useDialogFocus(onClose);
  return (
    <div className="shell-drawer-layer" onKeyDown={onKeyDown}>
      <div className="shell-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className={`shell-drawer${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="shell-drawer-h"><b>{title}</b><span className="spacer" /><button type="button" className="shell-icon-btn" onClick={onClose} aria-label={`Close ${title}`}><Icon name="close" /></button></div>
        <div className="shell-drawer-b"><Suspense fallback={<div className="page empty" role="status">Opening…</div>}>{children}</Suspense></div>
      </div>
    </div>
  );
}

/**
 * Drawers are opened from the URL without a page route, so pages that read `:id` with useParams
 * (agent console, run output, mocks) get their own route context here.
 */
function DrawerBody({ body, state, meta }: { body: Extract<Surface, { kind: 'drawer' }>['body']; state: ControlState; meta: ShellMeta }) {
  switch (body) {
    case 'inbox': return <Inbox state={state} />;
    case 'decisions': return <Decisions state={state} />;
    case 'insights': return <Insights state={state} />;
    case 'docs': return <Docs state={state} />;
    case 'designer': return <Designer state={state} />;
    case 'mocks': return <Routes><Route path="/mocks" element={<Mocks state={state} />} /><Route path="/mocks/:id" element={<Mocks state={state} />} /></Routes>;
    case 'agent': return <Routes><Route path="/agents/:id" element={<AgentDrawer state={state} />} /></Routes>;
    case 'team': return <Team state={state} />;
    case 'workspace': return <Workspace state={state} demo={meta.demo} />;
    case 'run': return <Routes><Route path="/runs/:id" element={<RunView state={state} />} /></Routes>;
    case 'workflows': return <Workflows state={state} />;
  }
}

function Tabs({ tabs, label }: { tabs: readonly { path: string; label: string }[]; label: string }) {
  const { pathname } = useLocation();
  return <nav className="shell-tabs" aria-label={label}>{tabs.map(t => <Link key={t.path} to={t.path} aria-current={pathname === t.path ? 'page' : undefined} className={pathname === t.path ? 'on' : ''}>{t.label}</Link>)}</nav>;
}

function Insights({ state }: { state: ControlState }) {
  const { pathname } = useLocation();
  return <>
    <Tabs tabs={INSIGHT_TABS} label="Insights" />
    {pathname === '/reports' ? <Reports state={state} /> : pathname === '/analytics' ? <Analytics state={state} /> : pathname === '/release' ? <ReleaseCockpit state={state} /> : <MissionControl state={state} />}
  </>;
}

function AgentDrawer({ state }: { state: ControlState }) {
  const { pathname } = useLocation();
  const id = decodeURIComponent(pathname.split('/')[2] ?? '');
  return <>
    <Tabs tabs={[{ path: `/agents/${encodeURIComponent(id)}`, label: state.agents[id]?.config.name ?? 'Agent' }, { path: '/team', label: 'Team conversations' }]} label="Agent" />
    <AgentConsole state={state} />
  </>;
}

/** Everything that needs the owner, in one place: questions and approvals, decisions, alerts. */
function Inbox({ state }: { state: ControlState }) {
  const now = useTick();
  const approvals = Object.values(state.approvals).filter(a => !a.resolvedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const decisions = Object.values(state.decisions).filter(d => !d.answeredAt && !d.consumedAt).length;
  const alerts = Object.values(state.alerts).filter(a => !a.resolvedAt).sort((a, b) => (a.severity === 'critical' ? -1 : 0) - (b.severity === 'critical' ? -1 : 0));
  return <div className="page col" style={{ gap: 16 }}>
    <section className="col" style={{ gap: 8 }} aria-labelledby="inbox-approvals">
      <h2 id="inbox-approvals">Questions and approvals {approvals.length > 0 && <Badge tone="warn">{approvals.length}</Badge>}</h2>
      {approvals.length === 0 ? <p className="muted small">No agent is waiting on you.</p> : approvals.map(a => <ApprovalCard key={a.id} ap={a} agentName={state.agents[a.agentId]?.config.name ?? a.agentId} now={now} />)}
    </section>
    <section className="col" style={{ gap: 8 }} aria-labelledby="inbox-decisions">
      <h2 id="inbox-decisions">Decisions {decisions > 0 && <Badge tone="warn">{decisions}</Badge>}</h2>
      {decisions === 0 ? <p className="muted small">Nothing to decide. Merges, releases, connector access and other gated actions appear here.</p> : <Decisions state={state} />}
    </section>
    <section className="col" style={{ gap: 8 }} aria-labelledby="inbox-alerts">
      <h2 id="inbox-alerts">Alerts</h2>
      {alerts.length === 0 ? <p className="muted small">No stalled runs, idle agents or sync problems.</p> : <ul className="shell-alerts">{alerts.map(a => <li key={a.id}><Badge tone={a.severity === 'critical' ? 'crit' : a.severity === 'warn' ? 'warn' : 'info'}>{a.severity}</Badge><span className="grow">{a.message}</span>{a.runId && <Link to={`/runs/${encodeURIComponent(a.runId)}`}>Open run</Link>}</li>)}</ul>}
    </section>
  </div>;
}

function SettingsDialog({ tab, state, meta, onClose }: { tab: (typeof SETTINGS_TABS)[number]['id']; state: ControlState; meta: ShellMeta; onClose: () => void }) {
  const { ref, onKeyDown } = useDialogFocus(onClose);
  const { pathname } = useLocation();
  const body = tab === 'settings' ? <Settings state={state} />
    : tab === 'agents' ? is('/agents/new', pathname) || is('/agents/:id/edit', pathname) ? <AgentBuilder state={state} /> : <AgentsSetup state={state} tracker={meta.tracker} demo={meta.demo} />
    : tab === 'connectors' ? <Connectors state={state} />
    : tab === 'skills' ? <Skills state={state} />
    : tab === 'projects' ? <Projects />
    : pathname === '/phone' ? <Phone state={state} /> : <Remote state={state} />;
  return (
    <div className="shell-modal-layer" onKeyDown={onKeyDown}>
      <div className="shell-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="shell-modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
        <nav className="shell-modal-nav" aria-label="Settings sections">
          <b>Settings</b>
          {SETTINGS_TABS.map(t => <Link key={t.id} to={t.path} className={t.id === tab ? 'on' : ''} aria-current={t.id === tab ? 'page' : undefined}>{t.label}</Link>)}
          {tab === 'phone' && <Link to="/phone" className={pathname === '/phone' ? 'on sub' : 'sub'}>Phone preview</Link>}
          <span className="spacer" />
          {!isDesktop && <span className="small faint">This browser is connected to this project.</span>}
        </nav>
        <div className="shell-modal-b">
          <button type="button" className="shell-icon-btn shell-modal-close" onClick={onClose} aria-label="Close settings"><Icon name="close" /></button>
          <Suspense fallback={<div className="page empty" role="status">Opening…</div>}>{body}</Suspense>
        </div>
      </div>
    </div>
  );
}

interface Command { label: string; hint: string; icon: IconName; to: string; words: string }

const COMMANDS: Command[] = [
  { label: 'Canvas', hint: 'Workflows as nodes', icon: 'canvas', to: '/', words: 'home overview workflows nodes' },
  { label: 'Issue list', hint: 'Work board and imports', icon: 'list', to: '/board', words: 'board issues kanban backlog import queue' },
  { label: 'Inbox', hint: 'Questions, approvals, decisions, alerts', icon: 'bell', to: '/inbox', words: 'approvals decisions alerts waiting' },
  { label: 'One Ask', hint: 'Ask about this project', icon: 'search', to: '/docs', words: 'ask question context vault obsidian graph docs' },
  { label: 'Designer', hint: 'Design system and design jobs', icon: 'canvas', to: '/designer', words: 'design mock ui contract tokens brief' },
  { label: 'Mocks', hint: 'Captured mocks, review, handoff', icon: 'canvas', to: '/mocks', words: 'artifacts preview review handoff' },
  { label: 'Insights', hint: 'Overview of agents, gates and alerts', icon: 'chart', to: '/insights', words: 'mission control overview' },
  { label: 'Brief and reports', hint: 'Now, next and handoff cards', icon: 'chart', to: '/reports', words: 'report brief summary' },
  { label: 'Analytics', hint: 'Activity and pipeline', icon: 'chart', to: '/analytics', words: 'metrics stats' },
  { label: 'Release', hint: 'Release plan and checks', icon: 'chart', to: '/release', words: 'ship deploy publish cockpit' },
  { label: 'Team conversations', hint: 'Messages between agents', icon: 'bell', to: '/team', words: 'team chat messages capacity' },
  { label: 'Terminal and containers', hint: 'Project terminal and Docker', icon: 'list', to: '/workspace', words: 'terminal shell docker container' },
  { label: 'All workflows', hint: 'Table of every workflow', icon: 'list', to: '/workflows', words: 'workflow table list' },
  { label: 'Settings: project and policies', hint: 'Checks, models, code host', icon: 'gear', to: '/settings', words: 'settings policies checks models' },
  { label: 'Settings: agents and sign-in', hint: 'Add agents, sign in, plans', icon: 'gear', to: '/setup', words: 'agents login sign in setup subscription' },
  { label: 'Settings: connectors', hint: 'Trackers, code hosts, tools', icon: 'gear', to: '/connectors', words: 'connectors integrations github linear tools mcp' },
  { label: 'Settings: skills', hint: 'Skill library', icon: 'gear', to: '/skills', words: 'skills library import' },
  { label: 'Settings: projects', hint: 'Add or switch projects', icon: 'gear', to: '/projects', words: 'projects repo clone switch' },
  { label: 'Settings: phone and alerts', hint: 'Pairing and notifications', icon: 'gear', to: '/remote', words: 'phone remote pairing notifications alerts' },
];

function CommandPalette({ state, onClose }: { state: ControlState; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const agents: Command[] = Object.values(state.agents).map(a => ({ label: a.config.name, hint: `Agent · ${a.status}`, icon: 'canvas', to: `/agents/${encodeURIComponent(a.id)}`, words: `agent ${a.config.role} ${a.config.adapter}` }));
    const all = [...COMMANDS, ...agents];
    const hits = needle ? all.filter(c => `${c.label} ${c.hint} ${c.words}`.toLowerCase().includes(needle)) : all;
    return needle ? [...hits, { label: `One Ask: “${q.trim()}”`, hint: 'Ask your project knowledge', icon: 'search' as const, to: '/docs', words: '' }] : hits;
  }, [q, state.agents]);
  const go = (c: Command | undefined) => { if (!c) return; onClose(); navigate(c.to); };
  return (
    <div className="shell-modal-layer palette" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="shell-scrim" onClick={onClose} aria-hidden="true" />
      <div className="shell-palette" role="dialog" aria-modal="true" aria-label="Ask or jump to">
        <input ref={input} role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results[active] ? `palette-${active}` : undefined} aria-label="Ask or jump to" placeholder="Search tools, agents and settings, or ask a question" value={q}
          onChange={e => { setQ(e.target.value); setActive(0); }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(results.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
          }} />
        <ul id="palette-list" role="listbox" aria-label="Results">
          {results.map((c, i) => <li key={`${c.to}-${c.label}`} id={`palette-${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onClick={() => go(c)}><Icon name={c.icon} /><span className="grow">{c.label}</span><span className="small faint">{c.hint}</span></li>)}
        </ul>
      </div>
    </div>
  );
}

const THEMES: { id: ThemeChoice; label: string; short: string; icon: IconName }[] = [{ id: 'day', label: 'Day', short: 'Day', icon: 'sun' }, { id: 'night', label: 'Night (pitch black)', short: 'Night', icon: 'moon' }, { id: 'machine', label: 'Machine (follow system)', short: 'Machine', icon: 'monitor' }];

/** Day → Night → Machine. */
function ThemeButton({ choice }: { choice: ThemeChoice }) {
  const i = THEMES.findIndex(t => t.id === choice);
  const cur = THEMES[i];
  const next = THEMES[(i + 1) % THEMES.length];
  return <button type="button" className="shell-icon-btn" aria-label={`Theme: ${cur.label}. Switch to ${next.label}`} title={`Theme: ${cur.label}`} onClick={() => setTheme(next.id)}><Icon name={cur.icon} /><span className="shell-label">{cur.short}</span></button>;
}
