// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// First-run setup: the whole path from "just downloaded" to "agents signed in, project open".
// Nothing is downloaded or run by this screen. Installs and sign-ins are prepared as commands in a
// terminal the person controls, and only after they allowed that specific download.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { AgentConfig, BinaryInfo, ControlState } from '@acc/core';
import { AgentConfigSchema, shellJoin } from '@acc/core';
import { Appearance } from './Appearance';
import { Badge, Copy, ErrorLine, useAction } from './common';
import { api, post } from '../lib/api';
import { addProject, chooseFolder, inspectFolder, isDesktop, switchProject, useActiveProject, type Inspection } from '../lib/desktop';
import { AUTH_LABEL, AUTH_TONE, loginArgs } from '../lib/onboarding';
import { playSound } from '../lib/sounds';
import { SETUP_STEPS, updateSetup, useSetup, type SetupStep } from '../lib/setup';

interface InstallOption { id: string; label: string; command: string; recommended?: boolean; note?: string }
interface Vendor {
  adapter: string; displayName: string; installUrl: string; loginHint: string;
  candidates: BinaryInfo[]; pinned: BinaryInfo | null; configuredAgents: string[];
  catalog: { summary: string; docsUrl: string; install: InstallOption[]; terms: { label: string; url: string }[] } | null;
}

const TITLES: Record<SetupStep, string> = { welcome: 'Welcome', appearance: 'Appearance', agents: 'Your agents', downloads: 'Downloads', signin: 'Sign in', project: 'Project', phone: 'Phone', done: 'Ready' };
const PLAN_HINT: Record<string, string> = {
  'claude-headless': 'Claude Code · Claude Pro or Max',
  'codex-cli': 'Codex · ChatGPT Plus or Pro',
  'cursor-agent-cli': 'Cursor · Cursor Pro',
  'opencode-server': 'OpenCode · your own model source',
  relay: 'Antigravity, Gemini app, IDE agents · copy and paste',
  'generic-cli': 'Any other CLI · its own login',
};

export function FirstRun({ state, demo }: { state: ControlState; demo: boolean }) {
  const setup = useSetup();
  const navigate = useNavigate();
  const project = useActiveProject()?.project ?? state.project?.repo ?? '';
  const { busy, error, run } = useAction();
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [pairing, setPairing] = useState<{ url: string; expiresAt: string } | null>(null);
  const scan = useCallback(async () => {
    setScanError(null);
    try { const r = await api<{ vendors: Vendor[] }>('/api/onboarding'); setVendors(r.vendors); }
    catch (e) { setScanError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const needsVendors = !setup.done && !setup.paused && (setup.step === 'agents' || setup.step === 'downloads' || setup.step === 'signin');
  useEffect(() => { if (needsVendors && !vendors) void scan(); }, [needsVendors, vendors, scan]);

  const index = SETUP_STEPS.indexOf(setup.step);
  const go = (step: SetupStep) => { updateSetup({ step }); playSound('toggle-tick', 0.25); };
  const next = () => go(SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)]);
  const back = () => go(SETUP_STEPS[Math.max(index - 1, 0)]);
  const finish = () => { playSound('first-open', 0.6); updateSetup({ done: true, paused: false }); };
  const skip = () => updateSetup({ done: true, paused: false });
  const chosenVendors = useMemo(() => (vendors ?? []).filter(v => setup.chosen.includes(v.adapter)), [vendors, setup.chosen]);
  const installed = (v: Vendor) => v.candidates.length > 0;
  const agentFor = (adapter: string) => Object.values(state.agents).find(a => a.config.adapter === adapter);
  /** Hand a command to the terminal page for review. Setup pauses and offers Resume. */
  const toTerminal = (command: string, label: string, login: boolean) => {
    updateSetup({ paused: true });
    navigate('/workspace', { state: { terminalRequest: { project, command, label, login } } });
  };
  /** Create an enabled subscription agent for each chosen vendor that has none yet. */
  const ensureAgents = async () => {
    if (demo) return;
    for (const v of chosenVendors) {
      if (agentFor(v.adapter) || v.configuredAgents.length) continue;
      const id = v.adapter.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const config = AgentConfigSchema.parse({ id, name: v.displayName, role: 'engineer', adapter: v.adapter as AgentConfig['adapter'], provider: 'subscription' });
      await post('/api/agents/configure', { config, expected: null });
    }
  };

  if (setup.done) return null;
  if (setup.paused) {
    return <button type="button" className="setup-resume btn primary" onClick={() => { updateSetup({ paused: false }); setVendors(null); }}>Resume setup · {TITLES[setup.step]}</button>;
  }

  const pendingDownloads = chosenVendors.filter(v => !installed(v));

  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      {setup.step !== 'welcome' && (
        <aside className="setup-rail" aria-label="Setup steps">
          <ol>
            {SETUP_STEPS.filter(s => s !== 'welcome').map(s => {
              const i = SETUP_STEPS.indexOf(s);
              return <li key={s} className={i === index ? 'on' : i < index ? 'past' : ''} aria-current={i === index ? 'step' : undefined}>{TITLES[s]}</li>;
            })}
          </ol>
          {setup.step !== 'done' && <button type="button" className="btn ghost sm" onClick={skip}>Skip setup</button>}
        </aside>
      )}
      <section className="setup-pane">
        <ErrorLine error={error} />

        {setup.step === 'welcome' && (
          <div className="welcome-card">
            <svg className="welcome-mark" viewBox="0 0 512 512" width="112" height="112" aria-hidden="true">
              <path className="wm-strut" d="M168 256 L344 136 M168 256 L344 376" strokeWidth="26" strokeLinecap="round" fill="none" />
              <circle className="wm-hub" cx="168" cy="256" r="66" strokeWidth="14" />
              <circle className="wm-a" cx="344" cy="136" r="48" strokeWidth="14" />
              <circle className="wm-b" cx="344" cy="376" r="48" strokeWidth="14" />
            </svg>
            <h1 id="setup-title" className="welcome-title">Your agents. Your subscriptions. One log.</h1>
            <p className="welcome-lede">Run Claude Code, Codex and Cursor as a team on the plans you already pay for. Setup takes a few minutes and never downloads anything without asking you first.</p>
            <div className="row wrap">
              <button type="button" className="btn primary welcome-go" autoFocus onClick={next}>Set up One Connect</button>
              <button type="button" className="btn ghost" onClick={skip}>Skip, I know the way</button>
            </div>
          </div>
        )}

        {setup.step === 'appearance' && (
          <div className="setup-step">
            <h1 id="setup-title">How should it look?</h1>
            <p className="muted">Day, night or follow the Mac. Colour-blind-safe status colours, high contrast and UI sounds live here, and in Settings later.</p>
            <Appearance />
            <Nav back={back} next={next} />
          </div>
        )}

        {setup.step === 'agents' && (
          <div className="setup-step">
            <h1 id="setup-title">Which agents do you want?</h1>
            <p className="muted">Each one runs through its vendor's official tool, signed in with your own account. Pick any number; Agents lets you change this later.</p>
            <ErrorLine error={scanError} />
            {!vendors && !scanError && <p className="muted" role="status">Looking for installed tools…</p>}
            <ul className="setup-choices">
              {(vendors ?? []).map(v => {
                const on = setup.chosen.includes(v.adapter);
                return (
                  <li key={v.adapter}>
                    <label className="choice">
                      <input type="checkbox" checked={on} onChange={e => updateSetup({ chosen: e.target.checked ? [...setup.chosen, v.adapter] : setup.chosen.filter(a => a !== v.adapter) })} />
                      <span className="choice-body"><b>{v.displayName}</b><span className="small muted">{PLAN_HINT[v.adapter] ?? v.catalog?.summary ?? v.loginHint}</span></span>
                      {installed(v) ? <Badge tone="ok">installed{v.pinned?.version ? ` · ${v.pinned.version}` : ''}</Badge> : <Badge tone="idle">not installed</Badge>}
                    </label>
                  </li>
                );
              })}
            </ul>
            <Nav back={back} next={() => void run(async () => { await ensureAgents(); next(); })} nextLabel={setup.chosen.length ? `Continue with ${setup.chosen.length}` : 'Continue without agents'} disabled={busy || !vendors} />
          </div>
        )}

        {setup.step === 'downloads' && (
          <div className="setup-step">
            <h1 id="setup-title">Downloads need your permission</h1>
            <p className="muted">One Connect installs nothing by itself. Allowing a download prepares the vendor's own install command in a terminal you control; you press Return. Nothing happens until then.</p>
            {pendingDownloads.length === 0 && <p className="setup-ok"><Badge tone="ok">nothing to download</Badge> Every agent you chose is already installed.</p>}
            <ul className="setup-choices">
              {pendingDownloads.map(v => {
                const options = v.catalog?.install ?? [];
                const picked = options.find(o => o.id === setup.allowed[v.adapter]) ?? null;
                const recommended = options.find(o => o.recommended) ?? options[0] ?? null;
                return (
                  <li key={v.adapter} className="download">
                    <div className="row wrap"><b>{v.displayName}</b><span className="spacer" />{v.catalog?.docsUrl && <a className="small" href={v.catalog.docsUrl} target="_blank" rel="noreferrer">Vendor guide</a>}</div>
                    {options.length > 0 ? (
                      <>
                        <label className="choice allow">
                          <input type="checkbox" checked={Boolean(picked)} onChange={e => { const allowed = { ...setup.allowed }; if (e.target.checked && recommended) allowed[v.adapter] = recommended.id; else delete allowed[v.adapter]; updateSetup({ allowed }); }} />
                          <span className="choice-body"><b>Allow this download</b><span className="small muted">From the vendor, with the command below. Review it before you run it.</span></span>
                        </label>
                        {options.length > 1 && picked && (
                          <select value={picked.id} onChange={e => updateSetup({ allowed: { ...setup.allowed, [v.adapter]: e.target.value } })}>
                            {options.map(o => <option key={o.id} value={o.id}>{o.label}{o.recommended ? ' (recommended)' : ''}</option>)}
                          </select>
                        )}
                        {picked && (
                          <>
                            <code className="setup-command">{picked.command}</code>
                            {picked.note && <span className="small muted">{picked.note}</span>}
                            <div className="row wrap">
                              {isDesktop && !demo && <button type="button" className="btn sm" onClick={() => toTerminal(picked.command, `Install ${v.displayName}`, false)}>Open in terminal</button>}
                              <Copy text={picked.command} />
                            </div>
                          </>
                        )}
                        {v.catalog?.terms.length ? <span className="small faint">Installing means accepting the vendor's {v.catalog.terms.map(t => t.label).join(' and ')}.</span> : null}
                      </>
                    ) : (
                      <p className="small muted">No scripted install for this tool. <a href={v.installUrl} target="_blank" rel="noreferrer">Install it from the vendor</a>, then rescan.</p>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="small faint">Not downloaded here: Docker Desktop (runs the project you develop) and Node 24+, pnpm and git (power the engine).</p>
            <div className="row wrap"><button type="button" className="btn sm" disabled={busy} onClick={() => void run(scan)}>Rescan installed tools</button></div>
            <Nav back={back} next={next} />
          </div>
        )}

        {setup.step === 'signin' && (
          <div className="setup-step">
            <h1 id="setup-title">Sign in with your own accounts</h1>
            <p className="muted">The official tool does the login, in your browser if it needs to. One Connect never sees or stores the credentials.</p>
            {chosenVendors.length === 0 && <p className="muted">No agents chosen. Add them any time from Agents.</p>}
            <ul className="setup-choices">
              {chosenVendors.map(v => {
                const agent = agentFor(v.adapter);
                const auth = agent?.auth.state ?? (installed(v) ? 'unknown' : 'not_installed');
                const args = loginArgs(v.adapter);
                const binary = agent?.binary?.path ?? v.pinned?.path ?? v.candidates[0]?.path ?? null;
                const command = args && binary ? shellJoin([binary, ...args]) : null;
                return (
                  <li key={v.adapter} className="download">
                    <div className="row wrap"><b>{v.displayName}</b><Badge tone={AUTH_TONE[auth]}>{AUTH_LABEL[auth]}</Badge></div>
                    {auth === 'logged_in' ? null : command ? (
                      <>
                        <code className="setup-command">{command}</code>
                        <div className="row wrap">
                          {isDesktop && !demo && <button type="button" className="btn sm primary" onClick={() => toTerminal(command, `${v.displayName} sign-in`, true)}>Prepare sign-in in terminal</button>}
                          <Copy text={command} />
                        </div>
                      </>
                    ) : (
                      <span className="small muted">{installed(v) ? 'This tool signs in inside its own app.' : 'Install this tool first, then rescan.'}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="row wrap"><button type="button" className="btn sm" disabled={busy} onClick={() => void run(scan)}>Re-check sign-ins</button></div>
            <Nav back={back} next={next} />
          </div>
        )}

        {setup.step === 'project' && (
          <div className="setup-step">
            <h1 id="setup-title">Open a project</h1>
            {isDesktop && !demo ? (
              <>
                <p className="muted">Choose a local repository. One Connect scans it without running its scripts and keeps its own state outside the repo.</p>
                <div className="row wrap">
                  <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const path = await chooseFolder('project'); setInspection(await inspectFolder(path)); })}>Choose folder…</button>
                  {inspection && <code className="small">{inspection.path}</code>}
                </div>
                {inspection && <div className="row wrap"><button type="button" className="btn primary" disabled={busy} onClick={() => void run(async () => { const p = await addProject(inspection.path, inspection.name); await switchProject(p.id); setInspection(null); next(); })}>Add and open {inspection.name}</button></div>}
                <p className="small faint">Cloning from a Git URL and starting a repo from scratch live in Projects, with the exact command shown before anything touches the network.</p>
              </>
            ) : (
              <p className="muted">This browser is connected to <b>{state.project?.name ?? 'a project'}</b>. {demo ? 'The offline demo uses a sample repository and scripted agents.' : 'Projects are added from the Mac app.'}</p>
            )}
            <Nav back={back} next={next} nextLabel={isDesktop && !demo && !state.project ? 'Skip for now' : 'Continue'} />
          </div>
        )}

        {setup.step === 'phone' && (
          <div className="setup-step">
            <h1 id="setup-title">Answer from your phone</h1>
            <p className="muted">Approvals, questions and cost decisions can reach a phone inbox. Optional; the link is single-use and expires.</p>
            {pairing ? (
              <div className="col"><code className="setup-command">{pairing.url}</code><div className="row wrap"><Copy text={pairing.url} /><span className="small muted">Open it on your phone before it expires.</span></div></div>
            ) : (
              <button type="button" className="btn" disabled={busy || demo} onClick={() => void run(async () => { setPairing(await post<{ url: string; expiresAt: string }>('/api/remote/pairings')); })}>Create pairing link</button>
            )}
            {demo && <p className="small faint">Pairing is available on a real project.</p>}
            <Nav back={back} next={next} nextLabel={pairing ? 'Continue' : 'Skip for now'} />
          </div>
        )}

        {setup.step === 'done' && (
          <div className="setup-step">
            <h1 id="setup-title">You're set.</h1>
            <ul className="setup-summary">
              <li><b>{setup.chosen.length || 'No'}</b> agent{setup.chosen.length === 1 ? '' : 's'} chosen{chosenVendors.length ? `: ${chosenVendors.map(v => v.displayName).join(', ')}` : ''}</li>
              <li><b>{Object.values(state.agents).filter(a => a.auth.state === 'logged_in').length}</b> signed in</li>
              <li>Project: <b>{state.project?.name ?? 'none yet'}</b></li>
            </ul>
            <p className="muted">Everything an agent does lands in the event log. Pushes, deploys and anything paid come to you first.</p>
            <div className="row wrap">
              <button type="button" className="btn primary welcome-go" autoFocus onClick={finish}>Open the canvas</button>
              <button type="button" className="btn ghost" onClick={back}>Back</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Nav({ back, next, nextLabel = 'Continue', disabled }: { back: () => void; next: () => void; nextLabel?: string; disabled?: boolean }) {
  return (
    <div className="setup-nav row wrap">
      <button type="button" className="btn ghost" onClick={back}>Back</button>
      <span className="spacer" />
      <button type="button" className="btn primary" disabled={disabled} onClick={next}>{nextLabel}</button>
    </div>
  );
}
