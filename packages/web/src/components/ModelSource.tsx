// SPDX-License-Identifier: Apache-2.0
// Agent builder helpers: honest runtime state for Ollama (local and cloud), and the exact
// capabilities and limits of the chosen harness. Read-only checks: nothing here starts inference.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AgentConfig, ModelInfo } from '@acc/core';
import { api } from '../lib/api';
import { Badge, Copy, ErrorLine, useAction } from './common';
import type { Tone } from '../lib/format';

export interface OllamaStatus {
  route: 'local' | 'daemon' | 'api';
  state: 'ready' | 'server_not_running' | 'not_signed_in' | 'key_missing' | 'key_rejected' | 'sign_in_unknown' | 'error';
  message: string;
  fix?: string;
  version?: string;
  signedInAs?: string | null;
  models: ModelInfo[];
}

const STATE_LABEL: Record<OllamaStatus['state'], { text: string; tone: Tone }> = {
  ready: { text: 'ready', tone: 'ok' },
  server_not_running: { text: 'Ollama not running', tone: 'crit' },
  not_signed_in: { text: 'not signed in', tone: 'warn' },
  key_missing: { text: 'API key missing', tone: 'warn' },
  key_rejected: { text: 'API key rejected', tone: 'crit' },
  sign_in_unknown: { text: 'sign-in unknown', tone: 'warn' },
  error: { text: 'cannot check', tone: 'warn' },
};

export function OllamaPanel({ cfg, patch }: { cfg: AgentConfig; patch: (c: Partial<AgentConfig>) => void }) {
  const [st, setSt] = useState<OllamaStatus | null>(null);
  const { busy, error, run } = useAction();
  const route = cfg.provider === 'ollama-cloud' ? (cfg.ollama_route ?? 'daemon') : 'local';
  const check = () => run(async () => setSt(await api<OllamaStatus>(`/api/ollama/status?provider=${cfg.provider}&route=${route}`)));
  useEffect(() => {
    setSt(null);
    // Local discovery is safe on selection. A cloud API check is an explicit owner action.
    if (route !== 'api') void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.provider, route]);
  const cloud = cfg.provider === 'ollama-cloud';
  return (
    <section className="card ollama-panel" aria-label="Ollama status">
      <div className="card-h">
        <h2>{cloud ? 'Ollama cloud models' : 'Ollama local models'}</h2>
        <span className="spacer" />
        {st && <Badge tone={STATE_LABEL[st.state].tone}>{STATE_LABEL[st.state].text}</Badge>}
        <button type="button" className="btn sm" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check Ollama'}</button>
      </div>
      <div className="card-b col small" style={{ gap: 10 }}>
        {cloud ? (
          <>
            <p className="muted">Cloud models run on Ollama's servers under your <b>Ollama subscription</b>. Ollama does not report remaining usage to One Connect, so usage shows as unknown, and you confirm your plan's paid-overage settings before dispatch. They are not shown as per-token spend.</p>
            <fieldset style={{ border: 0, padding: 0 }} className="col">
              <label className="row"><input type="radio" name="ollama-route" checked={route === 'daemon'} onChange={() => patch({ ollama_route: 'daemon', model: 'newest' })} /><span><b>Signed-in local Ollama</b>: models whose names end in <code>-cloud</code> / <code>:cloud</code>, no key stored here.</span></label>
              <label className="row"><input type="radio" name="ollama-route" checked={route === 'api'} onChange={() => patch({ ollama_route: 'api', model: 'newest' })} /><span><b>Ollama cloud API</b> with an Ollama API key kept in your Keychain.</span></label>
            </fieldset>
          </>
        ) : (
          <p className="muted">Runs on this Mac through Ollama at 127.0.0.1:11434. Free. No account, no key, nothing leaves this machine. Models ending in <code>-cloud</code> belong to the cloud source.</p>
        )}
        {st && <div>{st.message}</div>}
        {st?.fix && (
          <div className="row">
            <span className="grow">{st.fix}</span>
            {/`([^`]+)`/.exec(st.fix) && <Copy text={/`([^`]+)`/.exec(st.fix)![1]} label="Copy command" />}
            {st.state === 'key_missing' && <Link className="btn sm" to="/setup">Open connections</Link>}
          </div>
        )}
        {st && st.models.length > 0 && (
          <ul className="col" style={{ gap: 4, listStyle: 'none', padding: 0 }}>
            {st.models.map((m) => {
              const reason = m.hidden ? (cloud ? 'a local model: use the local source' : 'an Ollama cloud model: use the cloud source') : m.tools === false ? 'no tool calling: cannot work as a coding agent' : m.tools !== true ? 'tool support unverified: re-probe before dispatch' : null;
              return (
                <li key={m.id} className="row">
                  <span className="mono grow">{m.id}</span>
                  {m.tools === true && <Badge tone="ok">tools</Badge>}
                  {m.tools === undefined && <Badge tone="idle" title="Ollama did not report capabilities">tools unknown</Badge>}
                  {reason ? <span className="faint">{reason}</span> : <button type="button" className="btn sm" aria-pressed={cfg.model === m.id} onClick={() => patch({ model: m.id })}>{cfg.model === m.id ? 'Selected' : 'Use'}</button>}
                </li>
              );
            })}
          </ul>
        )}
        <ErrorLine error={error} />
      </div>
    </section>
  );
}

interface Harness {
  adapter: string;
  displayName: string;
  limitations: string[];
  capabilities: Record<string, boolean>;
  license?: string;
  version?: { ok: boolean; message: string };
  supportedSeries?: string[];
  supportedVersions?: string[];
  verification?: string;
  binary?: { path: string; version: string | null } | null;
}
interface Provider { id: string; keyStored: boolean | null; secret: string | null; needsOptIn: boolean }

/** What this harness can and cannot do inside One Connect, before the agent exists. */
export function HarnessNotes({ cfg }: { cfg: AgentConfig }) {
  const [cat, setCat] = useState<{ harnesses: Harness[]; providers: Provider[] } | null>(null);
  useEffect(() => {
    let live = true;
    void api<{ harnesses: Harness[]; providers: Provider[] }>('/api/harnesses').then((r) => live && setCat(r)).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const h = cat?.harnesses.find((x) => x.adapter === cfg.adapter);
  const provider = cat?.providers.find((p) => p.id === cfg.provider);
  if (!h) return null;
  const needsKey = provider?.secret && (cfg.provider !== 'ollama-cloud' || cfg.ollama_route === 'api');
  return (
    <section className="card harness-notes" aria-label="Runtime capabilities">
      <div className="card-h"><h2>{h.displayName}</h2>{h.license && <Badge tone="info">{h.license} licensed</Badge>}</div>
      <div className="card-b col small" style={{ gap: 6 }}>
        <ul style={{ margin: 0, paddingLeft: 18 }}>{h.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        <div className="faint">Approvals routed here: {h.capabilities.hostApprovals ? 'yes' : 'no'} · live messages: {h.capabilities.streamingInput ? 'yes' : 'no'} · resume: {h.capabilities.resume ? 'yes' : 'no'}</div>
        {h.version && <div className={`banner small ${h.version.ok ? 'tone-info' : 'tone-warn'}`}>{h.binary ? h.version.message : `OpenCode was not found on this Mac. Install the official release yourself (supported version ${h.supportedVersions?.join(', ') ?? h.supportedSeries?.join(', ')}); One Connect never downloads it.`}</div>}
        {h.verification && <div className="faint">{h.verification}</div>}
        {needsKey && <div className={`banner small ${provider?.keyStored ? 'tone-info' : 'tone-warn'}`}>{provider?.keyStored ? 'A key is stored in your Keychain for this provider.' : <>No key is stored for this provider. Add it under <Link to="/setup">Agents &amp; connections</Link> before the agent can run.</>}</div>}
      </div>
    </section>
  );
}
