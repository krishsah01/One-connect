// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Jev (TypeSafe System One) is an advisory model for the Decisions inbox. It is off until you turn
// it on here, needs a key in your Keychain, and each request shows exactly what would leave this Mac.
import { useEffect, useState } from 'react';
import type { Decision } from '@acc/core';
import { api, post } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, ErrorLine, useAction } from './common';

export interface JevStatus {
  enabled: boolean;
  endpoint: string;
  host: string;
  keyStored: boolean;
  ready: boolean;
  confirmedAt: string | null;
  disclosure: { cost: string; network: string; data: string; authority: string };
  protocol: string;
}

interface Preview {
  host: string;
  url: string;
  inputHash: string;
  payload: unknown;
  requestBody: unknown;
  items: number;
  chars: number;
  truncated: boolean;
  blocked: string | null;
  canRequest: boolean;
}

/** Settings card (Agents & connections): enable or disable the metered Jev connection. */
export function JevSettings() {
  const [s, setS] = useState<JevStatus | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [cost, setCost] = useState(false);
  const [network, setNetwork] = useState(false);
  const [data, setData] = useState(false);
  const [host, setHost] = useState('');
  const { busy, error, run } = useAction();
  const load = () => api<JevStatus>('/api/jev').then((r) => { setS(r); setEndpoint((e) => e || r.endpoint); }).catch(() => setS(null));
  useEffect(() => { void load(); }, []);
  if (!s) return null;
  const typedHost = (() => { try { return new URL(endpoint || s.endpoint).host; } catch { return ''; } })();
  const ready = cost && network && data && host === typedHost && typedHost !== '';
  return (
    <section className="card" aria-label="Jev advisory connection">
      <div className="card-h">
        <h2>Jev recommendations (TypeSafe System One)</h2>
        <span className="spacer" />
        <Badge tone={s.enabled ? (s.keyStored ? 'ok' : 'warn') : 'idle'}>{s.enabled ? (s.keyStored ? 'on' : 'on · key missing') : 'off'}</Badge>
      </div>
      <div className="card-b col small" style={{ gap: 10 }}>
        <p className="muted">Jev can suggest an answer to an open decision and how urgent it is. It is advice only: it is never recorded as your answer, and it cannot approve anything, including irreversible actions. It is off by default and nothing is sent anywhere until you turn it on and confirm each request.</p>
        <div className="banner tone-warn small">{s.disclosure.cost} {s.disclosure.network} {s.disclosure.data}</div>
        <div className="faint">{s.protocol}</div>
        {!s.keyStored && <div className="banner small">Add your Jev API key in <b>Connections</b> above (stored in the macOS Keychain). It is never shown again.</div>}
        {s.enabled ? (
          <div className="col" style={{ gap: 8 }}>
            <div>Enabled for <b className="mono">{s.host}</b>{s.confirmedAt ? ` since ${new Date(s.confirmedAt).toLocaleString()}` : ''}. Each recommendation still asks you to confirm the exact evidence first.</div>
            <button className="btn sm danger" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void run(async () => { await post('/api/jev/configure', { enabled: false }); await load(); })}>Turn Jev off</button>
          </div>
        ) : (
          <form className="col" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void run(async () => { await post('/api/jev/configure', { enabled: true, endpoint: endpoint || s.endpoint, confirm: { cost, network, data, host } }); setCost(false); setNetwork(false); setData(false); setHost(''); await load(); }); }}>
            <label>Endpoint<input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={s.endpoint} /></label>
            <label className="row"><input type="checkbox" checked={cost} onChange={(e) => setCost(e.target.checked)} /><span>I understand each request is metered and billed to my Jev account.</span></label>
            <label className="row"><input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} /><span>I allow One Connect to contact <b className="mono">{typedHost || 'this host'}</b> for Jev requests only.</span></label>
            <label className="row"><input type="checkbox" checked={data} onChange={(e) => setData(e.target.checked)} /><span>I understand redacted decision evidence leaves this Mac when I confirm a request.</span></label>
            <label>Type the host to confirm<input value={host} onChange={(e) => setHost(e.target.value)} placeholder={typedHost} autoComplete="off" /></label>
            <button className="btn sm primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !ready}>Turn Jev on</button>
          </form>
        )}
        <ErrorLine error={error} />
      </div>
    </section>
  );
}

/** Per-decision advisory: shows a recorded recommendation, or walks the owner through one confirmed request. */
export function JevAdvice({ d, now }: { d: Decision; now: number }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<JevStatus | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [cost, setCost] = useState(false);
  const [network, setNetwork] = useState(false);
  const [data, setData] = useState(false);
  const { busy, error, run } = useAction();
  const a = d.advisory ?? null;
  const isOpen = !d.answeredAt && !d.consumedAt;

  const begin = () => run(async () => {
    setOpen(true);
    const st = await api<JevStatus>('/api/jev');
    setStatus(st);
    if (st.enabled) setPreview(await api<Preview>(`/api/decisions/${d.id}/advisory/preview`));
  });
  const send = () => run(async () => {
    await post(`/api/decisions/${d.id}/advisory`, { inputHash: preview!.inputHash, confirm: { cost, network, data, host: preview!.host } });
    setOpen(false); setPreview(null); setCost(false); setNetwork(false); setData(false);
  });

  if (!a && !isOpen) return null;
  return (
    <div className="col jev-advice" style={{ gap: 8 }}>
      {a && (
        <div className={`banner small ${a.stale ? 'tone-warn' : 'tone-info'}`} role="note" aria-label="Jev advisory">
          <b>Jev advisory{a.stale ? ' (out of date)' : ''}:</b> {a.stale ? <>this advice was based on evidence that has since changed{a.staleReason ? ` (${a.staleReason})` : ''}. It is no longer a current recommendation.</> : <>suggests <b>{a.recommendation}</b>.</>}
          {a.rationale ? <> {a.rationale}</> : null}
          <div className="faint">Advice only, never your answer or an approval. Model {a.model} · {a.evidenceItems} evidence items sent to {a.host} {ago(a.requestedAt, now)} ago · usage {Object.entries(a.usage).map(([k, v]) => `${k} ${v}`).join(', ') || 'not reported'} · evidence hash <span className="mono">{a.inputHash.slice(0, 12)}</span></div>
        </div>
      )}
      {isOpen && !open && (!a || a.stale) && <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void begin()}>{a ? 'Ask Jev again' : 'Ask Jev for a recommendation'}</button>}
      {isOpen && open && (
        <div className="card" style={{ boxShadow: 'none' }}>
          <div className="card-b col small" style={{ gap: 8 }}>
            {status && !status.enabled && <div>Jev is off. Turn it on under <b>Agents &amp; connections</b> first. Nothing was sent.</div>}
            {status?.enabled && !status.keyStored && <div>Add your Jev API key under <b>Agents &amp; connections</b> first. Nothing was sent.</div>}
            {preview && (
              <>
                <div>This would send the evidence below to <b className="mono">{preview.host}</b> ({preview.items} items, {preview.chars.toLocaleString()} characters{preview.truncated ? ', trimmed to fit the limit' : ''}, secrets redacted). Cost: one metered request.</div>
                <pre className="mono small" style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview.requestBody, null, 2)}</pre>
                {preview.blocked && <div className="banner tone-warn small">{preview.blocked}</div>}
                {preview.canRequest && (
                  <>
                    <label className="row"><input type="checkbox" checked={cost} onChange={(e) => setCost(e.target.checked)} /><span>This request is metered and billed to my Jev account.</span></label>
                    <label className="row"><input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} /><span>Send over the network to {preview.host}.</span></label>
                    <label className="row"><input type="checkbox" checked={data} onChange={(e) => setData(e.target.checked)} /><span>The evidence shown above may leave this Mac.</span></label>
                  </>
                )}
              </>
            )}
            <div className="row wrap">
              {preview?.canRequest && <button className="btn sm primary" disabled={busy || !(cost && network && data)} onClick={() => void send()}>Send to Jev</button>}
              <button className="btn sm" disabled={busy} onClick={() => void run(async () => { if (preview) await post(`/api/decisions/${d.id}/advisory/cancel`, { inputHash: preview.inputHash }); setOpen(false); setPreview(null); })}>Cancel</button>
            </div>
            <div className="faint">Jev's answer is advice only. Your answer below is the only approval.</div>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
