// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Setup step 1 and the own-account confirmation. The user picks a harness, runs the vendor's own
// installer themselves (prepared in the project terminal, never run without their Return), then
// either signs in with their own plan or adds an API key. Subscription logins need a confirmation
// that the login is theirs, unshared and unmodified, against the vendor terms linked here.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AccountPolicy, AgentState, BinaryInfo } from '@acc/core';
import { Badge, Copy, ErrorLine, useAction } from './common';
import { api, post } from '../lib/api';
import { isDesktop } from '../lib/desktop';
import { useOnline } from '../lib/offline';

export interface HarnessCatalogEntry {
  adapter: string;
  displayName: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  install: { id: string; label: string; command: string; recommended?: boolean; note?: string }[];
  terms: { label: string; url: string }[];
  termsRevision: string;
  subscription: { loginArgs: string[]; plans: string; notes: string[] } | null;
  apiKey: { provider: string; keyUrl: string; note: string } | null;
  signer: { teamId: string; organization: string } | null;
}

export interface SetupVendor {
  adapter: string;
  displayName: string;
  candidates: BinaryInfo[];
  pinned: BinaryInfo | null;
  configuredAgents: string[];
  catalog: HarnessCatalogEntry | null;
}

/** The API keys panel is a closed <details>; open it when a step links there. */
const openKeys = () => { const el = document.getElementById('api-connections'); if (el instanceof HTMLDetailsElement) el.open = true; };

function TermsLinks({ terms }: { terms: { label: string; url: string }[] }) {
  if (!terms.length) return null;
  return <ul className="harness-terms">{terms.map(t => <li key={t.url}><a href={t.url} target="_blank" rel="noreferrer">{t.label}</a></li>)}</ul>;
}

function InstallOption({ option, name, project, demo }: { option: HarnessCatalogEntry['install'][number]; name: string; project: string; demo: boolean }) {
  return <div className="harness-install">
    <div className="row wrap"><b>{option.label}</b>{option.recommended && <Badge tone="ok">Recommended</Badge>}</div>
    <code className="setup-command">{option.command}</code>
    {option.note && <span className="small muted">{option.note}</span>}
    <div className="row wrap">
      {isDesktop && project && !demo && <Link className="btn sm" to="/workspace" state={{ terminalRequest: { project, command: option.command, label: `Install ${name}`, login: false } }}>Prepare in terminal</Link>}
      <Copy text={option.command} label="Copy command" />
    </div>
  </div>;
}

/** Step 1: choose the harness, install it from the vendor, then pick subscription or API key. */
export function HarnessPicker({ vendors, accounts, project, demo, scanning, onScan }: { vendors: SetupVendor[] | null; accounts: AccountPolicy | null; project: string; demo: boolean; scanning: boolean; onScan: () => void }) {
  const online = useOnline();
  const keysOnly = accounts?.mode === 'api-keys-only';
  const entries = (vendors ?? []).filter((v): v is SetupVendor & { catalog: HarnessCatalogEntry } => Boolean(v.catalog));
  return <section className="card harness-picker" id="choose-harness" aria-labelledby="choose-harness-title">
    <div className="card-h"><h2 id="choose-harness-title">Choose your harness</h2><span className="spacer" /><button className="btn sm" disabled={scanning || !online} onClick={onScan}>{scanning ? 'Scanning…' : 'I installed it, scan again'}</button></div>
    <div className="card-b col">
      <p className="small muted">Install each tool from its vendor. One Connect shows the vendor's official command and prepares it in your project terminal. Nothing runs until you press Return, and One Connect never downloads or changes a vendor tool.</p>
      <div className={`banner small ${keysOnly ? 'tone-warn' : 'tone-info'}`}>
        {keysOnly
          ? <p><b>API keys only.</b> This workspace is set for shared, hosted or team use. Subscription sign-in is refused, and each agent uses its vendor's API key, billed to the key owner. <Link to="/settings">Change in Settings</Link></p>
          : <p><b>Personal use.</b> Subscription sign-in is for you alone, on this Mac. If other people use this install, or you host it or run it for customers, set Accounts to <i>API keys only</i> in <Link to="/settings">Settings</Link>.</p>}
      </div>
      {!vendors && <p className="muted" role="status">{scanning ? 'Looking for installed tools…' : 'Scan installed tools to see what is on this Mac.'}</p>}
      <div className="agents harness-grid">{entries.map(v => {
        const h = v.catalog;
        const installed = v.candidates.length > 0;
        return <article key={v.adapter} className="card harness-card">
          <div className="card-h"><div className="col"><b>{h.displayName}</b><span className="small muted">{h.vendor}</span></div><span className="spacer" /><Badge tone={installed ? 'ok' : 'warn'}>{installed ? `Installed${v.pinned?.version ? ` · ${v.pinned.version}` : ''}` : 'Not installed'}</Badge></div>
          <div className="card-b col">
            <p className="small">{h.summary}</p>
            {installed
              ? <details className="setup-details"><summary>Reinstall or update from the vendor</summary><div className="col">{h.install.map(o => <InstallOption key={o.id} option={o} name={h.displayName} project={project} demo={demo} />)}</div></details>
              : <div className="col">{h.install.map(o => <InstallOption key={o.id} option={o} name={h.displayName} project={project} demo={demo} />)}<a className="small" href={h.docsUrl} target="_blank" rel="noreferrer">Vendor install guide (browser)</a></div>}
            <div className="harness-routes col">
              {h.subscription && <div className="col">
                <Link className={`btn sm${keysOnly ? '' : ' primary'}`} aria-disabled={keysOnly || !installed} onClick={e => { if (keysOnly || !installed) e.preventDefault(); }} to={`/agents/new?adapter=${encodeURIComponent(h.adapter)}&provider=subscription`}>Use my own {h.displayName} plan</Link>
                <span className="small muted">{keysOnly ? 'Unavailable in an API-keys-only workspace.' : !installed ? 'Install it first.' : `${h.subscription.plans}. You sign in yourself with the vendor's own login.`}</span>
              </div>}
              {h.apiKey && <div className="col">
                <Link className="btn sm" aria-disabled={!installed} onClick={e => { if (!installed) e.preventDefault(); }} to={`/agents/new?adapter=${encodeURIComponent(h.adapter)}&provider=${encodeURIComponent(h.apiKey.provider)}`}>Use an API key instead</Link>
                <span className="small muted">{h.apiKey.note} <a href={h.apiKey.keyUrl} target="_blank" rel="noreferrer">Create a key</a>, then add it under <a href="#api-connections" onClick={openKeys}>API keys</a>.</span>
              </div>}
              {!h.subscription && !h.apiKey && <div className="col">
                <Link className="btn sm" aria-disabled={!installed} onClick={e => { if (!installed) e.preventDefault(); }} to={`/agents/new?adapter=${encodeURIComponent(h.adapter)}&provider=ollama`}>Use with local or API-key models</Link>
                <span className="small muted">No login of its own. Choose Ollama, or a provider whose key you add under <a href="#api-connections" onClick={openKeys}>API keys</a>.</span>
              </div>}
            </div>
            <details className="setup-details"><summary>Vendor terms{h.subscription ? ' for subscription sign-in' : ''}</summary><div className="col">{h.subscription?.notes.map(n => <p key={n} className="small muted">{n}</p>)}<TermsLinks terms={h.terms} /></div></details>
          </div>
        </article>;
      })}</div>
    </div>
  </section>;
}

interface AccountStatus {
  required: boolean; valid: boolean; state: string; message: string; acknowledgedAt: string | null; expiresAt: string | null; dueSoon: boolean;
  vendor: string | null; terms: { label: string; url: string }[]; notes: string[]; statements: { id: string; text: string }[];
  accountLabel: string | null; signature: { state: string; detail: string }; mode: string; apiKeyRoute: { provider: string; keyUrl: string; note: string } | null;
}

const SIGNATURE_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'idle'> = { verified: 'ok', unsigned: 'warn', unavailable: 'idle', mismatch: 'crit', invalid: 'crit', not_expected: 'idle' };
const SIGNATURE_LABEL: Record<string, string> = { verified: 'Official vendor binary', unsigned: 'Unsigned launcher', unavailable: 'Signature not checked', mismatch: 'Not the vendor\'s signature', invalid: 'Signature broken', not_expected: 'Unsigned by vendor' };

/** Per-agent: confirm own, unshared, unmodified use against the vendor terms; shows expiry. */
export function AccountTerms({ agent }: { agent: AgentState }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const online = useOnline();
  const { busy, error, run } = useAction();
  const route = `/api/agents/${encodeURIComponent(agent.id)}/account-terms`;
  useEffect(() => {
    let active = true;
    const load = () => api<AccountStatus>(route).then(v => { if (active) { setStatus(v); setLoadError(null); } }).catch(e => { if (active) { setStatus(null); setLoadError(e instanceof Error ? e.message : String(e)); } });
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [route, agent.probedAt, agent.config]);
  if (loadError) return <ErrorLine error={loadError} />;
  if (!status?.required) return null;
  const sig = status.signature;
  const all = status.statements.every(s => checked[s.id]);
  return <div className={`banner small account-terms ${status.valid ? (status.dueSoon ? 'tone-warn' : 'tone-info') : 'tone-warn'}`}>
    <div className="row wrap"><b>Own account &amp; vendor terms</b>{status.accountLabel && <span className="muted">Signed in as {status.accountLabel}</span>}<span className="spacer" />{sig.state !== 'not_expected' && <Badge tone={SIGNATURE_TONE[sig.state] ?? 'idle'} title={sig.detail}>{SIGNATURE_LABEL[sig.state] ?? sig.state}</Badge>}</div>
    <p>{status.message}</p>
    {(sig.state === 'mismatch' || sig.state === 'invalid' || sig.state === 'unsigned') && <p className="faint">{sig.detail}</p>}
    {status.state === 'api_keys_only' ? <p>{status.apiKeyRoute ? <>Use <Link to={`/agents/new?adapter=${encodeURIComponent(agent.config.adapter)}&provider=${encodeURIComponent(status.apiKeyRoute.provider)}`}>an API-key agent for {status.vendor}</Link> instead. {status.apiKeyRoute.note}</> : 'This harness has no API-key route. Use another harness with an API key.'}</p>
      : status.valid
        ? <div className="row wrap"><span className="faint">Confirmed {status.acknowledgedAt ? new Date(status.acknowledgedAt).toLocaleDateString() : ''}. Review again by {status.expiresAt ? new Date(status.expiresAt).toLocaleDateString() : ''}, or sooner if the vendor terms or the signed-in account change.</span><button className="btn sm" disabled={busy || !online} onClick={() => void run(async () => setStatus(await api<AccountStatus>(route, { method: 'DELETE' })))}>Withdraw</button></div>
        : <div className="col" style={{ gap: 8 }}>
          {status.notes.map(n => <p key={n} className="faint">{n}</p>)}
          <TermsLinks terms={status.terms} />
          {status.statements.map(s => <label key={s.id} className="row"><input type="checkbox" disabled={!online} checked={Boolean(checked[s.id])} onChange={e => setChecked({ ...checked, [s.id]: e.target.checked })} /><span>{s.text}</span></label>)}
          <button className="btn sm" disabled={!all || busy || !online || agent.auth.state !== 'logged_in' || !agent.binary || agent.config.enabled === false} onClick={() => void run(async () => { setStatus(await post<AccountStatus>(route, { statements: status.statements.map(s => s.id) })); setChecked({}); })}>Record my confirmation</button>
          {agent.auth.state !== 'logged_in' && <span className="faint">Sign in with the vendor CLI and re-check this agent first.</span>}
        </div>}
    <ErrorLine error={error} />
  </div>;
}
