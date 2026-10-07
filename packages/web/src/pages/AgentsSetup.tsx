// SPDX-License-Identifier: Apache-2.0
// Onboarding: which vendor CLIs are installed (and which copy is pinned), each agent's login
// state with the vendor's own login command, billing mode, models, usage; rule toggles.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AgentState, AuthStatus, BinaryInfo, BillingInfo, ControlState } from '@acc/core';
import { RULE_NAMES, ruleEnabled, sharedCapacity } from '@acc/core';
import { Badge, BillingBadge, Copy, ErrorLine, Toggle, UsageMeter, useAction } from '../components/common';
import { api, post } from '../lib/api';
import { ago } from '../lib/format';

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

const AUTH_TONE: Record<AuthStatus['state'], 'ok' | 'crit' | 'warn'> = { logged_in: 'ok', expired: 'crit', not_installed: 'crit', unknown: 'warn' };

export function AgentsSetup({ state, tracker }: { state: ControlState; tracker: { type: string; target: string; live: boolean } | null }) {
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void api<{ vendors: Vendor[] }>('/api/onboarding').then((r) => setVendors(r.vendors)).catch(() => setVendors([]));
  }, []);
  const agents = Object.values(state.agents);
  return (
    <div className="page col" style={{ gap: 16 }}>
      <div className="row wrap">
        <h1 style={{ fontSize: 20 }}>Agents &amp; subscriptions</h1>
        <span className="spacer" />
        <Link className="btn primary" to="/agents/new">Create agent</Link>
        <button className="btn" disabled={busy} onClick={() => void run(() => Promise.all(agents.filter(a=>a.config.enabled!==false).map((a) => post(`/api/agents/${a.id}/probe`))))}>
          Re-check enabled
        </button>
      </div>
      <div className="banner tone-info small">
        Subscription agents use their vendor's official runtime and <b>your own</b> login. Several agents can share one login and its usage limits. Saved drafts stay offline until enabled. Check your plan's terms for automated use, and keep paid overage / on-demand / auto-recharge off in each vendor account.
      </div>
      <ErrorLine error={error} />
      <div className="agents">
        {agents.map((a) => (
          <section key={a.id} className="card">
            <div className="card-h">
              <b>{a.config.name}</b>
              <span className="faint small">
                {a.config.subscription ?? ''} · {a.config.role}
              </span>
              <span className="spacer" />
              <BillingBadge agent={a} />
            </div>
            <div className="card-b col">
              <div className="kv">
                <span>Enabled</span><span>{a.config.enabled===false?'Draft · runtime off':'Yes'}</span>
                <span>Capacity group</span><span>{sharedCapacity(state.agents,a.id).group??'Separate API/local connection'}</span>
                <span>Adapter</span>
                <span className="mono">{a.config.adapter}</span>
                <span>Sign-in</span>
                <span>
                  <Badge tone={AUTH_TONE[a.auth.state]}>{a.auth.state.replace('_', ' ')}</Badge> <span className="small muted">{a.auth.detail}</span>
                  {a.auth.tier && <span className="small muted"> · {a.auth.tier} plan</span>}
                </span>
                {a.auth.fix && (
                  <>
                    <span>Fix</span>
                    <span className="row small">
                      <span className="grow">{a.auth.fix}</span>
                      {/`([^`]+)`/.exec(a.auth.fix) && <Copy text={/`([^`]+)`/.exec(a.auth.fix)![1]} label="Copy command" />}
                    </span>
                  </>
                )}
                <span>Billing</span>
                <BillingLine b={a.billing} />
                <span>Binary</span>
                <span className="mono small" style={{ wordBreak: 'break-all' }}>
                  {a.binary ? `${a.binary.path} ${a.binary.version ?? ''}` : a.config.adapter === 'relay' ? 'n/a (relay)' : 'not found'}
                </span>
                <span>Models</span>
                <span className="small">
                  {a.models.available.filter((m) => !m.hidden).length} available · newest <span className="mono">{a.models.newest ?? '?'}</span>
                </span>
                <span>Checked</span>
                <span className="small">{a.probedAt ? `${ago(a.probedAt)} ago` : 'never'}</span>
              </div>
              {a.binaryCandidates.length > 1 && (
                <div className="small col" style={{ gap: 2 }}>
                  <span className="faint">Other copies found</span>
                  {a.binaryCandidates
                    .filter((c) => c.path !== a.binary?.path)
                    .map((c) => (
                      <span key={c.path} className="mono">
                        {c.path} {c.version} {c.prerelease && <Badge tone="warn">prerelease</Badge>}
                      </span>
                    ))}
                </div>
              )}
              <UsageMeter usage={sharedCapacity(state.agents,a.id).usage} />
              <SubscriptionConfirmation agent={a} />
              {a.billing.notes?.map((n) => (
                <div key={n} className="small faint">
                  · {n}
                </div>
              ))}
              <div className="row wrap"><Link className="btn sm" to={`/agents/${a.id}/edit`}>Edit agent</Link><Link className="btn sm" to={`/agents/new?clone=${a.id}`}>Duplicate</Link>
              <button className="btn sm" disabled={busy||a.config.enabled===false} onClick={() => void run(() => post(`/api/agents/${a.id}/probe`))}>
                Re-check
              </button>
              </div>
            </div>
          </section>
        ))}
      </div>

      <Connections />

      <section className="card">
        <div className="card-h">
          <h2>Vendor CLIs on this machine</h2>
        </div>
        <div className="card-b">
          {!vendors && <div className="faint small">Detecting…</div>}
          {vendors && (
            <table className="table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Copies (★ pinned)</th>
                  <th>Login</th>
                  <th>Agents</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) => (
                  <tr key={v.adapter}>
                    <td>{v.displayName}</td>
                    <td className="mono small">
                      {v.candidates.length === 0 && (
                        <a href={v.installUrl} target="_blank" rel="noreferrer">
                          install from vendor
                        </a>
                      )}
                      {v.candidates.map((c) => (
                        <div key={c.path} style={{ wordBreak: 'break-all' }}>
                          {c.path === v.pinned?.path ? '★ ' : ''}
                          {c.path} {c.version} {c.prerelease && <Badge tone="warn">prerelease</Badge>}
                        </div>
                      ))}
                      {v.newer && <div style={{ color: 'var(--warn)' }}>newer build available: pin it with binary:</div>}
                    </td>
                    <td className="small">{v.loginHint}</td>
                    <td className="small">{v.configuredAgents.join(', ') || <span className="faint">none</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div className="row wrap" style={{ alignItems: 'stretch', gap: 16 }}>
        <section className="card grow" style={{ minWidth: 280 }}>
          <div className="card-h">
            <h2>Rules</h2>
          </div>
          <div className="card-b col">
            {RULE_NAMES.map((r) => {
              const on = state.rules[r] ?? ruleEnabled(state.policies ?? undefined, r);
              return (
                <div key={r} className="row">
                  <Toggle on={on} label={r} onChange={(v) => void run(() => post(`/api/rules/${r}`, { enabled: v }))} />
                  <span>{r.replace(/_/g, ' ')}</span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="card grow" style={{ minWidth: 280 }}>
          <div className="card-h">
            <h2>Tracker</h2>
          </div>
          <div className="card-b col small">
            {tracker && (
              <>
                <div className="row">
                  <b>{tracker.target}</b>
                  <Badge tone={tracker.live ? 'ok' : 'warn'}>{tracker.live ? 'live' : 'dry run'}</Badge>
                </div>
                {!tracker.live && <div className="faint">Outbound writes are off. Set <code>tracker.live: true</code> in control-center.yaml when you're ready.</div>}
                <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={busy || !tracker.live} onClick={() => void run(() => post('/api/tracker/poll'))}>
                  Sync now
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

interface SubscriptionStatus { required: boolean; valid: boolean; confirmedAt: string | null; expiresAt: string | null; message: string }
function SubscriptionConfirmation({ agent }: { agent: AgentState }) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    const load = () => api<SubscriptionStatus>(`/api/agents/${agent.id}/subscription-safety`).then(setStatus).catch(() => setStatus(null));
    setChecked(false);
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [agent.id, agent.probedAt, agent.config]);
  if (!status?.required) return null;
  return <div className={`banner small ${status.valid ? 'tone-info' : 'tone-warn'}`}>
    <p>{status.message}</p>
    {status.valid ? <p className="faint">Reconfirm after switching accounts, re-checking the runtime or restarting One Connect. Expires {status.expiresAt ? new Date(status.expiresAt).toLocaleString() : ''}.</p> : <div className="col" style={{ gap: 8 }}>
      <label className="row"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /><span>I checked this signed-in account: paid overage, purchased credits and auto-recharge are off.</span></label>
      <button className="btn sm" disabled={!checked || busy || agent.auth.state !== 'logged_in'} onClick={() => void run(async () => setStatus(await post<SubscriptionStatus>(`/api/agents/${agent.id}/subscription-safety`, { paidModesOff: true })))}>Record my confirmation</button>
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
  'anthropic-api': { title: 'Anthropic Console API key', note: 'Claude Code bills this key per token. Agents need provider: anthropic-api and metered_opt_in.' },
  'openai-api': { title: 'OpenAI API key', note: 'Codex bills this key per token. Agents need provider: openai-api and metered_opt_in.' },
  openrouter: { title: 'OpenRouter API key', note: 'Any OpenRouter model (including free ones) through Codex. Pay per token; set a credit limit on the key too.' },
  linear: { title: 'Linear API key', note: 'Read (and, when live, write) issues in your Linear workspace.' },
};

/** API keys live in the macOS Keychain; the UI can store or remove them but never reads them back. */
function Connections() {
  const [data, setData] = useState<{ connections: Record<string, { stored: boolean; usedBy: string[] }>; egress: { allowed: string[]; recent: { at: string; host: string; allowed: boolean; method: string }[] } } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const load = () => api<typeof data>('/api/connections').then(setData).catch(() => setData(null));
  useEffect(() => {
    void load();
  }, []);
  if (!data) return null;
  return (
    <section className="card">
      <div className="card-h">
        <h2>Connections</h2>
        <span className="spacer" />
        <span className="small faint">Keys are stored in your macOS Keychain and only given to that connection's own runs.</span>
      </div>
      <div className="card-b col" style={{ gap: 14 }}>
        <div className="banner tone-ok small">
          <b>Private by design.</b> No telemetry, no phone-home. This app contacts only: {data.egress.allowed.filter((h) => !/^(127\.0\.0\.1|localhost)$/.test(h)).join(', ') || 'nothing beyond this Mac'}. Agent CLIs talk to their own vendor (the connection you chose).
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
                  className="row"
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
                  <input type="password" autoComplete="off" placeholder={c.stored ? 'Replace key…' : 'Paste key…'} value={draft[name] ?? ''} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} />
                  <button className="btn sm primary" disabled={busy || !draft[name]?.trim()}>
                    Save
                  </button>
                  {c.stored && (
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={busy}
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
        <div className="small faint">Local models need no key: run Ollama or LM Studio and add an agent with <code>provider: ollama</code> (or <code>lmstudio</code>).</div>
        <ErrorLine error={error} />
      </div>
    </section>
  );
}
