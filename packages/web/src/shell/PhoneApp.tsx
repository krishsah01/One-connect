// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The paired-phone layout: only the sections granted at pairing (home and approvals, Now,
// Decisions, reports, run output) and the kill switch when allowed. Project setup stays on the Mac.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router';
import type { ControlState } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { BrowserNotifier, OfflineBanner, PhoneTabBar } from '../components/PhoneShell';
import { post } from '../lib/api';
import { useOnline } from '../lib/offline';
import { can, canMutate, type RemoteSession } from '../lib/remote';

const Phone = lazy(() => import('../pages/Phone').then(m => ({ default: m.Phone })));
const Decisions = lazy(() => import('../pages/Decisions').then(m => ({ default: m.Decisions })));
const Reports = lazy(() => import('../pages/Reports').then(m => ({ default: m.Reports })));
const RunView = lazy(() => import('../pages/RunView').then(m => ({ default: m.RunView })));

const NAVIGATION = [{ label: 'This project', links: [
  { to: '/', label: 'Project home & approvals', count: 'approvals' },
  { to: '/phone', label: 'Now' },
  { to: '/decisions', label: 'Decisions', count: 'decisions' },
  { to: '/reports', label: 'Brief & reports' },
] }] as const;

function pageAvailable(pathname: string, session: RemoteSession): boolean {
  if (['/', '/phone', '/reports'].includes(pathname)) return can(session, 'read');
  if (pathname === '/decisions') return can(session, 'decisions');
  if (/^\/runs\/[^/]+$/.test(pathname)) return can(session, 'transcript');
  return false;
}

const sectionFor = (pathname: string) => (pathname.startsWith('/runs/') ? 'Run output' : 'This project');

export function PhoneApp({ state, session, conn, demo, projectKey }: { state: ControlState; session: RemoteSession; conn: string; demo: boolean; projectKey: string }) {
  const { busy, error, run } = useAction();
  const online = useOnline();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<string[]>(() => [...new Set(['This project', sectionFor(location.pathname)])]);
  const navigationButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setNavigationOpen(false);
    const group = sectionFor(location.pathname);
    setExpandedSections(current => current.includes(group) ? current : [...current, group]);
  }, [location.pathname, location.search, projectKey, session.id]);
  const closeNavigation = () => { setNavigationOpen(false); navigationButton.current?.focus(); };
  const toggleSection = (label: string, open: boolean) => setExpandedSections(current => open ? current.includes(label) ? current : [...current, label] : current.filter(name => name !== label));

  const kill = state.killSwitch.engaged;
  const pending = Object.values(state.approvals).filter((a) => !a.resolvedAt).length;
  const decisions = Object.values(state.decisions).filter((d) => !d.answeredAt && !d.consumedAt).length;
  const critical = Object.values(state.alerts).filter((a) => !a.resolvedAt && a.severity === 'critical').length;
  const navigation = NAVIGATION.map(section => ({ ...section, links: section.links.filter(link => pageAvailable(link.to, session)) })).filter(section => section.links.length > 0);
  const runs = can(session, 'transcript') ? Object.values(state.runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8) : [];
  const canKill = canMutate(session, 'kill_switch');
  return (
    <div className="workbench">
      <a className="workspace-skip" href="#workspace-content">Skip to workspace</a>
      <aside className="workspace-sidebar" onKeyDown={e => { if (e.key === 'Escape' && navigationOpen) { e.stopPropagation(); closeNavigation(); } }}>
        <div className="sidebar-brand-row"><LinkBrand /><button ref={navigationButton} type="button" className="btn sm workspace-nav-toggle" aria-controls="workspace-navigation" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(v => !v)}>{navigationOpen ? 'Close navigation' : 'Navigate'}</button></div>
        <div className="sidebar-project"><span className="small muted">Current project</span><b>{state.project?.name ?? 'Choose a project'}</b><span className="small muted">This phone is paired to this project only.</span></div>
        <nav id="workspace-navigation" className={`workspace-navigation${navigationOpen ? ' is-open' : ''}`} aria-label="Workspace navigation">
          {navigation.map(section => <details className="workspace-nav-section" key={section.label} open={expandedSections.includes(section.label)} onToggle={e => toggleSection(section.label, e.currentTarget.open)}>
            <summary>{section.label}</summary>
            {section.links.map(link => {
              const count = 'count' in link ? link.count === 'approvals' ? pending : decisions : 0;
              return <NavLink key={link.to} to={link.to} end={link.to === '/'} onClick={e => { if (navigationOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { setNavigationOpen(false); document.getElementById('workspace-content')?.focus(); } }}>{link.label}{count > 0 && <span aria-label={`${count} waiting`}>{count}</span>}</NavLink>;
            })}
          </details>)}
          {runs.length > 0 && <details className="workspace-nav-section" open={expandedSections.includes('Run output')} onToggle={e => toggleSection('Run output', e.currentTarget.open)}><summary>Run output</summary>{runs.map(r => <NavLink key={r.id} to={`/runs/${encodeURIComponent(r.id)}`}>{state.agents[r.agentId]?.config.name ?? r.agentId}<span>{r.state}</span></NavLink>)}</details>}
          <button type="button" className="btn workspace-nav-toggle" onClick={closeNavigation}>Close navigation</button>
        </nav>
        <div className="sidebar-footer"><b>Paired phone</b><span>Only controls granted for this project</span></div>
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
            // A phone may stop everything; releasing the kill switch stays on the Mac.
            disabled={busy || !online || conn !== 'live' || !canKill || kill}
            title={kill ? 'Release the kill switch in the Mac app' : `Stop every run in ${state.project?.name ?? 'this project'} now and block new dispatch.`}
            onClick={() => {
              if (conn !== 'live' || !online || !canKill || kill) return;
              if (window.confirm(`Stop ALL agent runs in ${state.project?.name ?? 'this project'} now and block new dispatch?`)) void run(() => post('/api/kill-switch', { engaged: true }));
            }}
          >
            {kill ? 'Stopped · release on Mac' : 'Kill switch'}
          </button>}
        </header>
        <OfflineBanner />
        <BrowserNotifier />
        {demo && <div className="banner tone-info" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>Offline demo · scripted agents and sample models · no subscription usage or live tracker connections</div>}
        {kill && (
          <div className="banner tone-crit" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>
            Kill switch engaged{state.killSwitch.by ? ` by ${state.killSwitch.by}` : ''}: all runs stopped, dispatch blocked.
          </div>
        )}
        {error && <ErrorLine error={error} />}
        <Suspense key={projectKey} fallback={<div className="page empty" role="status">Opening workspace…</div>}>{!pageAvailable(location.pathname, session) ? <div className="page col"><h1>Use a section available to this phone</h1><p className="muted">This phone shows the controls granted during pairing. Use One Connect on your Mac for project setup and management.</p><div className="row wrap">{can(session, 'read') && <Link className="btn" to="/phone">Project home</Link>}{can(session, 'decisions') && <Link className="btn" to="/decisions">Decisions</Link>}{can(session, 'read') && <Link className="btn" to="/reports">Reports</Link>}</div></div> : <Routes>
          <Route path="/" element={<Phone state={state} />} />
          <Route path="/phone" element={<Phone state={state} />} />
          <Route path="/decisions" element={<Decisions state={state} />} />
          <Route path="/reports" element={<Reports state={state} />} />
          <Route path="/runs/:id" element={<RunView state={state} />} />
        </Routes>}</Suspense>
      </main>
      <PhoneTabBar state={state} />
    </div>
  );
}

function LinkBrand() {
  return <div className="one-connect-brand"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><rect x="2" y="3" width="17" height="12" rx="6" fill="none" stroke="currentColor" strokeWidth="3" transform="rotate(-35 14 14)"/><rect x="9" y="13" width="17" height="12" rx="6" fill="none" stroke="currentColor" strokeWidth="3" transform="rotate(-35 14 14)"/></svg><span>One Connect</span></div>;
}
