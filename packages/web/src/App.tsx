// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The client's entry gate: sign-in and connection states, then one of two layouts. A local
// browser or the desktop app gets the canvas Shell; a paired phone gets PhoneApp.
import { useEffect } from 'react';
import { ErrorLine, useAction } from './components/common';
import { DEMO_PROJECT, isDesktop, useActiveProject } from './lib/desktop';
import { useRemoteSession } from './lib/remote';
import { live, openProject, useLive } from './lib/store';
import { PhoneApp } from './shell/PhoneApp';
import { ProjectSwitcher } from './shell/ProjectSwitcher';
import { Shell } from './shell/Shell';

export function App() {
  const { state, conn, meta, loadError } = useLive();
  useEffect(() => live.start(), []);
  const { busy, error, run } = useAction();
  const project = useActiveProject();
  const { session, checked: remoteChecked, mode } = useRemoteSession();

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
  const projectKey = project?.project ?? 'browser';
  if (session) return <PhoneApp state={state} session={session} conn={conn} demo={Boolean(meta.demo)} projectKey={projectKey} />;
  return <Shell key={projectKey} state={state} conn={conn} meta={{ demo: Boolean(meta.demo), tracker: meta.tracker ?? null }} projectSwitcher={isDesktop ? <ProjectSwitcher /> : <b className="ellipsis" title="This browser is connected to this project.">{state.project?.name ?? 'Choose a project'}</b>} />;
}
