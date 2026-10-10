// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Mac-first setup uses the vendor's installed official runtime and its own sign-in flow.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AgentState, BinaryInfo, BillingInfo, ControlState, Run } from '@acc/core';
import { RULE_NAMES, ruleEnabled, sharedCapacity } from '@acc/core';
import { Badge, BillingBadge, Copy, ErrorLine, Toggle, UsageMeter, useAction } from '../components/common';
import { api, post } from '../lib/api';
import { ago } from '../lib/format';
import { isDesktop, useActiveProject } from '../lib/desktop';
import { useOnline } from '../lib/offline';
import { shellJoin } from '@acc/core';
import { JevSettings } from '../components/Jev';
import {
  agentNewerBinary,
  AUTH_LABEL,
  AUTH_TONE,
  connectionGuidance,
  LOGIN_ARGS,
  loginBinaryPath,
  loginBinaryStaleReason,
  vendorLoginBlockedReason,
} from '../lib/onboarding';

interface Vendor {
  adapter: string;
  displayName: string;
  installUrl: string;
  loginHint: string;
  candidates: BinaryInfo[];
  pinned: BinaryInfo | null;
  newer: BinaryInfo | null;
  configuredAgents: string[];
}

function LoginAction({ adapter, binary, project, name, agentId, demo, blocked }: { adapter: string; binary?: string | null; project: string; name: string; agentId?: string; demo?: boolean; blocked?: string | null }) {
  const args = LOGIN_ARGS[adapter];
  if (!args) return null;
  if (demo) return <p className="small muted">The offline demo uses sample connections. Add a real project to sign in to your account.</p>;
  if (blocked) return <p className="small muted">{blocked}</p>;
  if (!binary) return <p className="small muted">Scan installed tools to locate this runtime before preparing its login.</p>;
  const command = shellJoin([binary, ...args]);
  return <div className="setup-login col">
    <code className="setup-command">{command}</code>
    <div className="row wrap">{isDesktop && project && <Link className="btn sm" to="/workspace" state={{ terminalRequest: { project, command, label: `${name} sign-in`, agentId, login: true } }}>Prepare sign-in in terminal</Link>}<Copy text={command} label="Copy login command" /></div>
    <span className="small muted">{isDesktop ? 'Opens a command preview. You choose when to open the shell and press Return to run it.' : 'Use the Mac app for the integrated terminal. The official tool handles this login on your Mac.'}</span>
  </div>;
}

export function AgentsSetup({ state, tracker, demo = false }: { state: ControlState; tracker: { type: string; target: string; live: boolean } | null; demo?: boolean }) {
  const project = useActiveProject()?.project ?? state.project?.repo ?? '';
  const online = useOnline();
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const scan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try { const result = await api<{ vendors: Vendor[] }>('/api/onboarding'); setVendors(result.vendors); }
    catch (e) { setScanError(e instanceof Error ? e.message : String(e)); }
    finally { setScanning(false); }
  }, []);
  useEffect(() => { void scan(); }, [scan]);
  const agents = Object.values(state.agents);
  const enabled = agents.filter(a => a.config.enabled !== false);
  const signedIn = enabled.filter(a => a.config.provider === 'subscription' && a.auth.state === 'logged_in');
  const latestRuns = new Map<string, Run>();
  for (const entry of Object.values(state.runs)) {
    const previous = latestRuns.get(entry.agentId);
    if (!previous || entry.createdAt > previous.createdAt) latestRuns.set(entry.agentId, entry);
  }
  return <div className="page col agents-setup">
    <div className="page-heading"><div><h1>Agents &amp; sign-in</h1><p>Connect the official tools on your Mac to {state.project?.name ?? 'this project'}. Use your own subscription login and keep your team's work in one place.</p></div><Link className="btn primary" to="/agents/new">Create agent</Link></div>
    <ol className="setup-steps" aria-label="Connect your project and agents">
      <li><b>Choose your project</b><span>{state.project?.name ?? 'Choose a repository'} is the current workspace. Its work, agents and terminal sessions stay together.</span><Link to="/projects">Manage projects</Link></li>
      <li><b>Configure an agent</b><span>{agents.length ? `${enabled.length} enabled, ${agents.length - enabled.length} saved drafts. Give each agent a role and a model source.` : 'Start with Codex, Claude Code or Cursor using an existing subscription. New drafts stay offline until enabled.'}</span><Link to="/agents/new">Create agent</Link></li>
      <li><b>Sign in, then check</b><span>{signedIn.length ? `${signedIn.length} enabled subscription agent${signedIn.length === 1 ? ' has' : 's have'} a detected login. Review billing and usage before dispatch.` : 'Find the installed tool below, prepare its login in the integrated terminal, then re-check the enabled agent.'}</span><a href="#installed-tools">Find installed tools</a></li>
    </ol>
    <div className="setup-explanation"><p>Subscription agents use their vendor's official runtime. The CLI handles your credentials and may open a vendor OAuth page in your browser; return to One Connect after signing in. Several agents can share one login and its included usage limits.</p><p className="small muted">A detected login does not prove that paid overage is off. Review your account's paid modes and the account confirmation below. API keys are optional and separate from subscription sign-in.</p></div>
    <div className="row wrap setup-actions"><button className="btn" disabled={scanning || !online} onClick={() => void scan()}>{scanning ? 'Scanning installed tools…' : 'Scan installed tools'}</button><button className="btn" disabled={busy || !online || !enabled.length} onClick={() => void run(async () => { await Promise.all(enabled.map(a => post(`/api/agents/${encodeURIComponent(a.id)}/probe`))); await scan(); })}>{busy ? 'Checking connections…' : 'Re-check enabled agents'}</button><Link to="/workspace">Open project terminal</Link></div>
    <ErrorLine error={error} />
    <ErrorLine error={scanError} />
    <section className="setup-team" aria-labelledby="configured-agents"><div className="row wrap"><h2 id="configured-agents">Your configured agents</h2><span className="small muted">Connection state comes from the last check.</span></div>
      {!agents.length && <div className="setup-empty"><h3>No agents configured yet</h3><p>Find an installed runtime below and sign in, then create an agent with its role and model policy.</p><Link className="btn primary" to="/agents/new">Create your first agent</Link></div>}
      <div className="agents">{agents.map(a => {
        const vendor = vendors?.find(v => v.adapter === a.config.adapter);
        const staleBinary = loginBinaryStaleReason(a);
        const binary = loginBinaryPath(a, vendor?.pinned?.path);
        const newer = agentNewerBinary(a) ?? vendor?.newer;
        const latest = latestRuns.get(a.id);
        return <section key={a.id} className="card setup-agent">
          <div className="card-h"><div className="col"><b>{a.config.name}</b><span className="small muted">{a.config.role}{a.config.subscription ? ` · ${a.config.subscription}` : ''}</span></div><span className="spacer" /><BillingBadge agent={a} /></div>
          <div className="card-b col"><div className="row wrap"><Badge tone={a.config.enabled === false ? 'idle' : AUTH_TONE[a.auth.state]}>{a.config.enabled === false ? 'Saved draft · runtime off' : AUTH_LABEL[a.auth.state]}</Badge><span className="small muted">{a.probedAt ? `Checked ${ago(a.probedAt)} ago` : 'Not checked yet'}</span></div>
            <p className="setup-guidance">{connectionGuidance(a)}</p>
            {newer && a.config.enabled !== false && <p className="small muted">Pinned binary {a.binary?.path ?? 'not checked'} · newer copy at <code>{newer.path}</code>{newer.version ? ` (${newer.version})` : ''}. Re-check or pin the newer build before dispatch.</p>}
            {staleBinary && a.config.enabled !== false && <p className="small muted">{staleBinary}</p>}
            {a.config.provider === 'subscription' && <LoginAction adapter={a.config.adapter} binary={binary} project={project} name={a.config.name} agentId={a.id} demo={demo} blocked={a.config.enabled === false ? 'Enable this agent in Edit agent before preparing its official login.' : staleBinary} />}
            {a.auth.state === 'not_installed' && vendor?.installUrl && <a className="small" href={vendor.installUrl} target="_blank" rel="noreferrer">Open official setup guide (browser)</a>}
            <UsageMeter usage={sharedCapacity(state.agents, a.id).usage} />
            <SubscriptionConfirmation agent={a} />
            <details className="setup-details"><summary>Connection details &amp; installed copies</summary><div className="kv">
              <span>Runtime</span><span>{vendor?.displayName ?? a.config.adapter}</span>
              <span>Model source</span><span>{a.config.provider}{a.config.ollama_route ? ` (${a.config.ollama_route})` : ''}</span>
              <span>Sign-in</span><span>{a.auth.detail ?? AUTH_LABEL[a.auth.state]}{a.auth.tier ? ` · ${a.auth.tier} plan` : ''}</span>
              {a.auth.fix && <><span>Guidance</span><span>{a.auth.fix}</span></>}
              <span>Billing</span><BillingLine b={a.billing} />
              <span>Shared capacity</span><span>{sharedCapacity(state.agents, a.id).group ?? 'Separate API/local connection'}</span>
              <span>Agent binary</span><span className="mono">{a.binary ? `${a.binary.path} ${a.binary.version ?? ''}` : a.config.adapter === 'relay' ? 'Manual relay' : 'Not checked or not found'}</span>
              <span>Models</span><span>{a.models.available.filter(m => !m.hidden).length} available · newest <code>{a.models.newest ?? 'not discovered'}</code></span>
            </div>{a.binaryCandidates.filter(c => c.path !== a.binary?.path).map(c => <div key={c.path} className="small mono setup-command">{c.path} {c.version}{c.prerelease && <Badge tone="warn">prerelease</Badge>}</div>)}{a.billing.notes?.map(note => <p key={note} className="small muted">{note}</p>)}</details>
            <div className="row wrap setup-agent-actions"><Link className="btn sm" to={`/agents/${encodeURIComponent(a.id)}`}>Output &amp; approvals</Link>{latest && <Link className="btn sm" to={`/runs/${encodeURIComponent(latest.id)}`}>Full latest output</Link>}{latest && <Link className="small" to={`/board?item=${encodeURIComponent(latest.workItemId)}`}>Work item</Link>}</div>
            <div className="row wrap"><Link className="btn sm" to={`/agents/${encodeURIComponent(a.id)}/edit`}>Edit agent</Link><Link className="btn sm" to={`/agents/new?clone=${encodeURIComponent(a.id)}`}>Duplicate</Link><button className="btn sm" disabled={busy || !online || a.config.enabled === false} onClick={() => void run(async () => { await post(`/api/agents/${encodeURIComponent(a.id)}/probe`); await scan(); })}>Re-check connection</button></div>
          </div>
        </section>;
      })}</div>
    </section>
    <section id="installed-tools" className="card installed-tools"><div className="card-h"><h2>Installed tools on this Mac</h2><span className="spacer" /><span className="small muted">Detects local copies; does not install or sign in</span></div><div className="card-b col">
      {scanning && !vendors && <p className="muted" role="status">Looking for installed runtimes…</p>}
      {!scanning && !vendors && <p className="muted">Detection is unavailable. Use Scan installed tools to retry.</p>}
      {vendors?.length === 0 && <p className="muted">No runtime information was returned. Scan installed tools to try again.</p>}
      {vendors?.map(v => <div key={v.adapter} className="installed-tool"><div className="installed-tool-heading"><h3>{v.displayName}</h3><Badge tone={v.candidates.length ? 'ok' : 'warn'}>{v.candidates.length ? `${v.candidates.length} installed ${v.candidates.length === 1 ? 'copy' : 'copies'}` : 'Not detected'}</Badge></div><div className="col">
        {!v.candidates.length && <p className="small muted">Install this runtime using the official vendor guide, then scan again. One Connect does not download tools.</p>}
        {v.pinned && <span className="small mono setup-command">Detected default: {v.pinned.path} {v.pinned.version ?? 'version not reported'}</span>}
        {v.candidates.length > 1 && <details className="setup-details"><summary>Show all installed copies</summary>{v.candidates.map(c => <div key={c.path} className="small mono setup-command">{c.path} {c.version}{c.prerelease && <Badge tone="warn">prerelease</Badge>}</div>)}</details>}
        {v.newer && <span className="small muted">Another build is available on this Mac. Use Edit agent to select its binary; scanning does not change existing pins.</span>}
        <p className="small muted">{v.loginHint}</p>
        <LoginAction adapter={v.adapter} binary={v.pinned?.path} project={project} name={v.displayName} demo={demo} blocked={vendorLoginBlockedReason(v)} />
        <div className="row wrap small"><span className="muted">Used by</span>{v.configuredAgents.length ? v.configuredAgents.map(id => <Link key={id} to={`/agents/${encodeURIComponent(id)}/edit`}>{state.agents[id]?.config.name ?? id}</Link>) : <span>No agent yet. <Link to="/agents/new">Create agent</Link></span>}</div>
        {v.installUrl && <a className="small" href={v.installUrl} target="_blank" rel="noreferrer">Official setup guide (browser)</a>}
      </div></div>)}
    </div></section>
    <details className="setup-optional" id="api-connections"><summary>API keys &amp; optional services</summary><div className="col"><p className="muted">Official subscription sign-in needs no API key here. These connections are for explicitly configured API, cloud and advisory services.</p><Connections /><JevSettings /></div></details>
    <details className="setup-optional"><summary>Runtime rule overrides</summary><div className="col"><p className="small muted">Existing per-project overrides. <Link to="/settings">Settings &amp; policies</Link> manages the saved project policy.</p><fieldset className="col" disabled={busy || !online} style={{ border: 0, padding: 0, margin: 0 }}>{RULE_NAMES.map(rule => <div key={rule} className="row"><Toggle on={state.rules[rule] ?? ruleEnabled(state.policies ?? undefined, rule)} label={rule.replace(/_/g, ' ')} onChange={enabled => void run(() => post(`/api/rules/${rule}`, { enabled }))} /><span>{rule.replace(/_/g, ' ')}</span></div>)}</fieldset></div></details>
    <section className="setup-next-links" aria-label="Continue in this project"><div><h2>Continue with your project</h2><p className="small muted">Assign work, review requests and open the original output in its existing view.</p></div><div className="workspace-shortcuts"><Link to="/board">Assign work</Link><Link to="/">Review approvals</Link><Link to="/decisions">Answer decisions</Link><Link to="/mocks">Mocks &amp; artifacts</Link><Link to="/settings">Settings &amp; policies</Link><Link to="/connectors">Manage connectors</Link></div>{tracker && <div className="row wrap small"><span>Tracker: {tracker.target}</span><Badge tone={tracker.live ? 'ok' : 'warn'}>{tracker.live ? 'Live' : 'Dry run · outbound writes off'}</Badge><button className="btn sm" disabled={busy || !online || !tracker.live} onClick={() => void run(() => post('/api/tracker/poll'))}>Sync tracker now</button></div>}</section>
  </div>;
}

interface SubscriptionStatus { required: boolean; valid: boolean; confirmedAt: string | null; expiresAt: string | null; message: string }
function SubscriptionConfirmation({ agent }: { agent: AgentState }) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const online = useOnline();
  const { busy, error, run } = useAction();
  useEffect(() => {
    let active = true;
    const load = () => api<SubscriptionStatus>(`/api/agents/${encodeURIComponent(agent.id)}/subscription-safety`).then(value => { if (active) { setStatus(value); setLoadError(null); } }).catch(e => { if (active) { setStatus(null); setLoadError(e instanceof Error ? e.message : String(e)); } });
    setChecked(false);
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [agent.id, agent.probedAt, agent.config]);
  if (loadError) return <div className="col small"><span className="muted">Account confirmation is unavailable. Re-check the agent or reconnect this project.</span><ErrorLine error={loadError} /></div>;
  if (!status?.required) return null;
  return <div className={`banner small ${status.valid ? 'tone-info' : 'tone-warn'}`}>
    <p>{status.message}</p>
    {status.valid ? <p className="faint">Reconfirm after switching accounts, re-checking the runtime or restarting One Connect. Expires {status.expiresAt ? new Date(status.expiresAt).toLocaleString() : ''}.</p> : <div className="col" style={{ gap: 8 }}>
      <label className="row"><input type="checkbox" disabled={!online} checked={checked} onChange={e => setChecked(e.target.checked)} /><span>I checked this signed-in account: paid overage, purchased credits and auto-recharge are off.</span></label>
      <button className="btn sm" disabled={!checked || busy || !online || agent.auth.state !== 'logged_in' || !agent.binary || agent.config.enabled === false} onClick={() => void run(async () => setStatus(await post<SubscriptionStatus>(`/api/agents/${encodeURIComponent(agent.id)}/subscription-safety`, { paidModesOff: true })))}>Record my confirmation</button>
    </div>}
    <ErrorLine error={error} />
  </div>;
}

function BillingLine({ b }: { b: BillingInfo }) {
  return (
    <span className="small">
      <Badge tone={b.mode === 'subscription' ? 'ok' : b.mode === 'metered' ? 'crit' : 'warn'}>{b.mode}</Badge> <span className="muted">{b.source}</span> · overage <b>{b.overage}</b>
    </span>
  );
}

const CONNECTION_INFO: Record<string, { title: string; note: string }> = {
  'anthropic-api': { title: 'Anthropic Console API key', note: 'For an Anthropic API agent. Requests bill per token and require explicit cost approval when configuring the agent.' },
  'openai-api': { title: 'OpenAI API key', note: 'For an OpenAI API agent. This billing is separate from your ChatGPT subscription and requires explicit cost approval.' },
  openrouter: { title: 'OpenRouter API key', note: "For OpenRouter models through the configured API runtime. Review each model's pricing and set a credit limit on the key." },
  'ollama-cloud': { title: 'Ollama API key (cloud models)', note: 'Only for Ollama cloud agents that use the cloud API route. Cloud models through a signed-in local Ollama need no key here. Billed through your Ollama plan.' },
  jev: { title: 'Jev API key (TypeSafe System One)', note: 'Advisory recommendations on decisions. Jev stays off until you turn it on below and confirm each request.' },
  linear: { title: 'Linear API key', note: 'Read (and, when live, write) issues in your Linear workspace.' },
};

/** API keys live in the macOS Keychain; the UI can store or remove them but never reads them back. */
function Connections() {
  const [data, setData] = useState<{ connections: Record<string, { stored: boolean; usedBy: string[] }>; egress: { allowed: string[]; recent: { at: string; host: string; allowed: boolean; method: string }[] } } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const online = useOnline();
  const { busy, error, run } = useAction();
  const load = () => api<typeof data>('/api/connections').then(value => { setData(value); setLoadError(null); }).catch(e => { setData(null); setLoadError(e instanceof Error ? e.message : String(e)); });
  useEffect(() => {
    void load();
  }, []);
  if (!data) return <section className="card card-b col"><h2>Optional connection keys</h2><p className="small muted" role="status">{loadError ? 'Connection keys could not be loaded. Reconnect this project or retry.' : 'Loading optional connections…'}</p><ErrorLine error={loadError} />{loadError && <button className="btn sm" disabled={busy || !online} onClick={() => void run(load)}>Retry connections</button>}</section>;
  return (
    <section className="card">
      <div className="card-h">
        <h2>Connections</h2>
        <span className="spacer" />
        <span className="small faint">Keys are stored in your macOS Keychain and only given to that connection's own runs.</span>
      </div>
      <div className="card-b col" style={{ gap: 14 }}>
        <div className="banner tone-ok small">
          Configured outbound hosts: {data.egress.allowed.filter((h) => !/^(127\.0\.0\.1|localhost)$/.test(h)).join(', ') || 'none beyond this Mac'}. Official agent tools contact their own vendor when you run them. Review external connections in <Link to="/connectors">Connectors</Link>.
        </div>
        <div className="agents">
          {Object.entries(data.connections).map(([name, c]) => (
            <div key={name} className="card" style={{ boxShadow: 'none' }}>
              <div className="card-h">
                <b>{CONNECTION_INFO[name]?.title ?? name}</b>
                <span className="spacer" />
                <Badge tone={c.stored ? 'ok' : 'idle'}>{c.stored ? 'key stored' : 'not set'}</Badge>
              </div>
              <div className="card-b col small">
                <span className="faint">{CONNECTION_INFO[name]?.note}</span>
                <span className="faint">Used by: {c.usedBy.join(', ') || 'no agent yet'}</span>
                <form
                  className="row wrap"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const key = draft[name]?.trim();
                    if (key) void run(async () => {
                      await post(`/api/connections/${name}`, { key });
                      setDraft({ ...draft, [name]: '' });
                      await load();
                    });
                  }}
                >
                  <input type="password" name={`${name}-key`} aria-label={`${CONNECTION_INFO[name]?.title ?? name}: ${c.stored ? 'replacement key' : 'key'}`} autoComplete="off" spellCheck={false} placeholder={c.stored ? 'Replace key…' : 'Paste key…'} value={draft[name] ?? ''} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} />
                  <button className="btn sm primary" disabled={busy || !online || !draft[name]?.trim()}>
                    Save
                  </button>
                  {c.stored && (
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={busy || !online}
                      onClick={() =>
                        void run(async () => {
                          await api(`/api/connections/${name}`, { method: 'DELETE' });
                          await load();
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </form>
              </div>
            </div>
          ))}
        </div>
        <div className="small faint">Local models need no key: run Ollama or LM Studio, then create an agent from <b>Create agent</b> and choose that model source. Ollama cloud models use your Ollama plan, either through a signed-in local Ollama or with the key above.</div>
        <ErrorLine error={error} />
      </div>
    </section>
  );
}
