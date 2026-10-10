// SPDX-License-Identifier: Apache-2.0
// Durable notification inbox from the project's event log.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { NotificationRecord } from '@acc/core';
import { NOTIFICATION_KIND_LABEL } from '@acc/core';
import { api, post } from '../lib/api';
import { ago, type Tone } from '../lib/format';
import { canMutate, type RemoteMode, type RemoteSession, useRemoteSession } from '../lib/remote';
import { Badge, ErrorLine, useAction, useTick } from './common';

const SEV: Record<NotificationRecord['severity'], Tone> = { critical: 'crit', warn: 'warn', info: 'info' };

const scoped = (session: RemoteSession | null, mode: RemoteMode, scope: string) =>
  mode === 'local' || Boolean(session?.scopes.includes(scope));

/** Scope-aware destination: no phone links to local-only management or agent consoles. */
export const notificationDestination = (n: NotificationRecord, session: RemoteSession | null, mode: RemoteMode): string | null => {
  if (mode !== 'local' && mode !== 'paired' && !(mode === 'offline' && session)) return null;
  if (n.refs.decisionId || n.refs.approvalId) return scoped(session, mode, 'decisions') ? '/decisions' : null;
  if (n.refs.runId) return scoped(session, mode, 'transcript') ? `/runs/${n.refs.runId}` : null;
  return mode === 'local' && !session && n.refs.agentId ? `/agents/${n.refs.agentId}` : null;
};

export function NotificationInbox({ limit = 8 }: { limit?: number }) {
  const [items, setItems] = useState<NotificationRecord[] | null>(null);
  const { busy, error, run } = useAction();
  const { session, mode } = useRemoteSession();
  const mayAck = canMutate(session, 'read');
  const now = useTick(30_000);
  const load = useCallback(() => api<{ notifications: NotificationRecord[] }>('/api/notifications').then((r) => setItems(r.notifications)).catch(() => setItems([])), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);
  const open = (items ?? []).filter((n) => !n.ackedAt);
  const shown = (items ?? []).slice(0, limit);
  return (
    <section className="col" style={{ gap: 8 }} aria-label="Notifications">
      <div className="row"><h2>Alerts</h2><span className="faint small">{open.length ? `${open.length} unread` : 'all caught up'}</span></div>
      {items && shown.length === 0 && <div className="empty card card-b">No alerts yet. Alerts appear here for stalled runs, waiting approvals, usage limits, failed checks and finished work.</div>}
      {shown.map((n) => {
        const dest = notificationDestination(n, session, mode);
        return (
        <article key={n.id} className={`card notif${n.ackedAt ? ' acked' : ''}`}>
          <div className="card-b col" style={{ gap: 4 }}>
            <div className="row wrap small" style={{ gap: 6 }}>
              <Badge tone={SEV[n.severity]}>{NOTIFICATION_KIND_LABEL[n.kind]}</Badge>
              {n.held.length > 0 && <Badge tone="idle" title={n.held.map((h) => `${h.channel}: ${h.reason}`).join('; ')}>held: {n.held[0].reason}</Badge>}
              <span className="spacer" /><span className="faint">{ago(n.at, now)} ago</span>
            </div>
            <div style={{ fontWeight: 550 }}>{n.title}</div>
            <div className="small muted">{n.detail}</div>
            <div className="row wrap">
              {dest && <Link className="btn sm" to={dest}>Open</Link>}
              {!n.ackedAt && <button className="btn sm" disabled={busy || !mayAck} onClick={() => void run(async () => { await post(`/api/notifications/${n.id}/ack`); await load(); })}>Mark read</button>}
            </div>
          </div>
        </article>
      );})}
      <ErrorLine error={error} />
    </section>
  );
}
