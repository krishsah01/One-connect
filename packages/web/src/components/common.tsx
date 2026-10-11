// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentState, Approval, UsageInfo } from '@acc/core';
import { isManualRelay } from '@acc/core';
import { post } from '../lib/api';
import { ago, hue, initials, type Tone } from '../lib/format';
import { playSound } from '../lib/sounds';

export function Light({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={`light tone-${tone}${pulse ? ' pulse' : ''}`} aria-hidden />;
}

export function Badge({ tone, children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge${tone ? ` tone-${tone}` : ''}`} title={title}>
      {children}
    </span>
  );
}

export function Avatar({ id, name, size = 22 }: { id: string; name: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: `hsl(${hue(id)} 55% 45%)`, width: size, height: size }} title={name}>
      {initials(name)}
    </span>
  );
}

/** The house switch: previews on pointer-down, commits on click, stretches its pill knob while travelling (styles.css `.toggle`). */
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const [pressed, setPressed] = useState(false);
  const [moving, setMoving] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flip = () => {
    if (disabled) return;
    setMoving(on ? 'moving-off' : 'moving-on');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoving(''), 200);
    playSound('toggle-tick', 0.35);
    onChange(!on);
  };
  const release = () => setPressed(false);
  return <button type="button" role="switch" className={`toggle${on ? ' on' : ''}${moving ? ` ${moving}` : ''}${pressed ? ' pressed' : ''}`} aria-checked={on} aria-label={label} disabled={disabled}
    onPointerDown={() => { if (!disabled) setPressed(true); }} onPointerUp={release} onPointerLeave={release} onPointerCancel={release} onClick={flip} />;
}

export function UsageMeter({ usage }: { usage: UsageInfo }) {
  if (usage.windows.length === 0) return <div className="small faint">Included usage: {usage.status === 'unknown' ? 'not exposed by vendor' : usage.status}</div>;
  return (
    <div className="col" style={{ gap: 5 }}>
      {usage.windows.map((w) => {
        const p = w.usedPercent ?? 0;
        return (
          <div key={w.name} className="col" style={{ gap: 2 }}>
            <div className="row small">
              <span className="muted grow">{w.name}</span>
              <span className="mono">{w.usedPercent === null ? '?' : `${p}%`}</span>
              {w.resetsAt && <span className="faint">resets {new Date(w.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
            </div>
            <div className={`meter${p >= 100 ? ' crit' : p >= 85 ? ' warn' : ''}`}>
              <span style={{ width: `${Math.min(100, p)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BillingBadge({ agent }: { agent: AgentState }) {
  if (isManualRelay(agent.config)) return <Badge tone="idle">relay</Badge>;
  if (agent.config.billing === 'local') return <Badge tone="ok" title={`${agent.config.provider} on this machine: no cost`}>local model</Badge>;
  if (agent.config.metered_opt_in) return <Badge tone="crit" title={`${agent.config.provider}: pay per token${agent.config.budget_usd_per_day ? `, stop threshold $${agent.config.budget_usd_per_day}/day; in-flight usage can exceed it` : ', no daily stop threshold'}`}>METERED{agent.config.budget_usd_per_day ? ` · threshold $${agent.config.budget_usd_per_day}/day` : ''}</Badge>;
  if (agent.billing.mode === 'metered') return <Badge tone="crit" title={agent.billing.source}>metered: blocked</Badge>;
  if (agent.billing.mode === 'subscription') return <Badge tone={agent.billing.overage === 'on' ? 'crit' : 'ok'} title={`${agent.billing.source}${agent.billing.overage === 'unknown' ? ' · overage state unknown' : ''}`}>included plan{agent.billing.overage === 'on' ? ' · overage ON' : ''}</Badge>;
  return <Badge tone="warn" title={agent.billing.source}>billing unknown</Badge>;
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** Re-render every `ms` so relative times stay fresh. */
export function useTick(ms = 5000): number {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return t;
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="banner tone-crit" role="alert">
      {error}
    </div>
  );
}

export function ApprovalCard({ ap, agentName, now }: { ap: Approval; agentName: string; now: number }) {
  const { busy, error, run } = useAction();
  const [text, setText] = useState('');
  let detail = ap.detail;
  try {
    const j = JSON.parse(ap.detail) as { reason?: string };
    if (j.reason) detail = j.reason;
  } catch {
    /* text */
  }
  const resolve = (decision: string) => run(() => post(`/api/approvals/${ap.id}/resolve`, { decision, channel: window.innerWidth < 640 ? 'phone' : 'web' }));
  return (
    <div className="approval col">
      <div className="row small">
        <b>{agentName}</b>
        <span className="faint">{ap.kind === 'tool_permission' ? 'wants permission' : 'asks'}</span>
        <span className="spacer" />
        <span className="faint">{ago(ap.createdAt, now)} ago</span>
      </div>
      <div style={{ fontWeight: 550 }}>{ap.title}</div>
      {detail && <div className="small muted">{detail}</div>}
      <div className="row wrap">
        {(ap.options.length ? ap.options : ['approve', 'deny']).map((o) => (
          <button key={o} className={`btn sm${o === 'approve' || o === 'yes' ? ' primary' : o === 'deny' || o === 'no' ? ' danger' : ''}`} disabled={busy} onClick={() => void resolve(o)}>
            {o}
          </button>
        ))}
      </div>
      {ap.kind === 'ask_human' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void resolve(text.trim());
          }}
        >
          <input placeholder="Or answer in your own words…" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn sm" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
