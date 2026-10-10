// SPDX-License-Identifier: Apache-2.0
// Phone-facing shell pieces: the offline banner, the bottom tab bar with a project menu, and the
// browser-notification bridge. Nothing here stores data on the device.
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import type { ControlState, EventEnvelope, NotificationRecord } from '@acc/core';
import { NOTIFICATION_KIND_LABEL } from '@acc/core';
import { live } from '../lib/store';
import { useOnline } from '../lib/offline';
import { notificationPermission } from '../lib/pwa';
import { can, useRemoteSession } from '../lib/remote';
import { isDesktop } from '../lib/desktop';

export function OfflineBanner() {
  const online = useOnline();
  useEffect(() => {
    document.documentElement.toggleAttribute('data-offline', !online);
    return () => document.documentElement.removeAttribute('data-offline');
  }, [online]);
  if (online) return null;
  return (
    <div className="banner tone-warn offline-banner" role="alert">
      <b>Offline.</b> Changes are disabled and nothing is queued. What you see below is the last live state received and may be out of date; reconnect before approving anything.
    </div>
  );
}

const TABS = [
  { to: '/phone', label: 'Now', end: true },
  { to: '/decisions', label: 'Decisions' },
  { to: '/reports', label: 'Reports' },
  { to: '/team', label: 'Agents' },
] as const;

const MENU = [
  ['/', 'Overview'], ['/phone', 'Phone view'], ['/team', 'Team workspace'], ['/board', 'Work board'], ['/workflows', 'Workflows'], ['/decisions', 'Decisions'], ['/reports', 'Brief & Reports'],
  ['/analytics', 'Analytics'], ['/docs', 'One Ask'], ['/designer', 'Design system'], ['/mocks', 'Design mocks'], ['/skills', 'Skills'], ['/connectors', 'Connectors'], ['/release', 'Release'], ['/remote', 'Phone & alerts'], ['/workspace', 'Terminal & containers'], ['/setup', 'Agents & connections'], ['/settings', 'Settings & policies'],
] as const;

export function PhoneTabBar({ state }: { state: ControlState }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const { session, mode } = useRemoteSession();
  useEffect(() => setOpen(false), [loc.pathname]);
  const decisions = Object.values(state.decisions).filter((d) => !d.answeredAt && !d.consumedAt).length + Object.values(state.approvals).filter((a) => !a.resolvedAt).length;
  const available = (to: string) => mode === 'local' || Boolean(session && (to === '/decisions' ? can(session, 'decisions') : ['/', '/phone', '/reports'].includes(to) && can(session, 'read')));
  const runs = session && can(session, 'transcript') ? Object.values(state.runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8) : [];
  return (
    <>
      {open && (
        <div className="phone-menu" role="dialog" aria-label="Project menu">
          <div className="phone-menu-head">
            <span className="small faint">Project</span>
            <b>{state.project?.name ?? 'Project'}</b>
            <span className="small muted">{session ? 'This phone is paired to this project only.' : isDesktop ? 'Switch projects from the Projects page.' : 'This browser is signed in to this project.'}</span>
          </div>
          <nav aria-label="Project sections">
            {MENU.filter(([to]) => available(to)).map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
            {mode === 'local' && Object.values(state.agents).map((a) => <NavLink key={a.id} to={`/agents/${a.id}`}>{a.config.name} <span className="faint small">{a.status}</span></NavLink>)}
            {runs.map(r => <NavLink key={r.id} to={`/runs/${encodeURIComponent(r.id)}`}>{state.agents[r.agentId]?.config.name ?? r.agentId} <span className="faint small">{r.state}</span></NavLink>)}
          </nav>
          <button type="button" className="btn" onClick={() => setOpen(false)}>Close menu</button>
        </div>
      )}
      <nav className="phone-tabbar" aria-label="Primary">
        {TABS.filter(t => available(t.to)).map((t) => (
          <NavLink key={t.to} to={t.to} end={'end' in t ? t.end : false}>
            {t.label}{t.to === '/decisions' && decisions ? <span className="tab-count">{decisions}</span> : null}
          </NavLink>
        ))}
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Menu</button>
      </nav>
    </>
  );
}

/** Shows a browser notification for each routed alert, only when this browser granted permission. Title only: no detail, no transcript. */
export function BrowserNotifier() {
  useEffect(() => live.onEvents((events: EventEnvelope[]) => {
    if (notificationPermission() !== 'granted') return;
    for (const e of events) {
      if (e.type !== 'notification.emitted') continue;
      const n = (e.data as { notification: NotificationRecord }).notification;
      if (!n.routed.includes('browser') || Date.now() - Date.parse(n.at) > 120_000) continue;
      const opts: NotificationOptions = { body: NOTIFICATION_KIND_LABEL[n.kind], tag: n.dedupeKey, data: { url: '/phone' } };
      navigator.serviceWorker?.getRegistration().then((r) => (r ? r.showNotification(n.title, opts) : void new Notification(n.title, opts))).catch(() => undefined);
    }
  }), []);
  return null;
}
