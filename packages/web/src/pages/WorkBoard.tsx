// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Tracker-synced board: lifecycle columns, filters, issue drawer with dispatch, Now/Next queues.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ControlState, WorkItem } from '@acc/core';
import { LIFECYCLE_LABELS, PIPELINE } from '@acc/core';
import { Avatar, Badge } from '../components/common';
import { DispatchPanel } from '../components/DispatchPanel';
import { ReviewMergePanel } from '../components/ReviewMergePanel';
import { ImportIssues } from '../components/ImportIssues';
import { NewIssueDialog } from '../components/NewIssueDialog';
import { QueueEditor } from '../components/QueueEditor';
import { ago } from '../lib/format';

export function WorkBoard({ state, trackerTarget }: { state: ControlState; trackerTarget: string }) {
  const [params, setParams] = useSearchParams();
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [agent, setAgent] = useState('');
  const [label, setLabel] = useState('');
  const [q, setQ] = useState('');
  const stage = params.get('stage');
  const selected = params.get('item');
  const items = useMemo(
    () =>
      Object.values(state.workItems)
        .filter((w) => w.state !== 'canceled')
        .filter((w) => !agent || w.ownerAgentId === agent)
        .filter((w) => !label || w.labels.includes(label))
        .filter((w) => !q || `${w.key} ${w.title}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt)),
    [state.workItems, agent, label, q],
  );
  const labels = [...new Set(Object.values(state.workItems).flatMap((w) => w.labels))].sort();
  const columns = PIPELINE.filter((p) => !stage || p.id === stage);
  const open = selected ? state.workItems[selected] : null;
  const select = (id: string | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set('item', id);
    else p.delete('item');
    setParams(p);
  };
  return (
    <div className="page col" style={{ gap: 16 }}>
      {importing && <ImportIssues close={() => setImporting(false)} />}
      <div className="row wrap">
        <h1 style={{ fontSize: 20 }}>Work board</h1>
        <span className="faint small">synced with {trackerTarget}</span>
        <span className="spacer" />
        <input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 160 }} />
        <select value={agent} onChange={(e) => setAgent(e.target.value)} style={{ width: 150 }}>
          <option value="">All agents</option>
          {Object.values(state.agents).map((a) => (
            <option key={a.id} value={a.id}>
              {a.config.name}
            </option>
          ))}
        </select>
        <select value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 130 }}>
          <option value="">All labels</option>
          {labels.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        {stage && (
          <button className="btn sm" onClick={() => setParams({})}>
            All stages
          </button>
        )}
        <button className="btn" onClick={() => setImporting(true)}>Import issues</button>
        <button className="btn primary" onClick={() => setCreating(true)}>
          New issue
        </button>
      </div>
      <div className="board">
        {columns.map((col) => {
          const its = items.filter((w) => col.states.includes(w.state));
          return (
            <div key={col.id} className="column">
              <h3>
                <span>{col.label}</span>
                <span className="faint">{its.length}</span>
              </h3>
              {its.map((w) => (
                <ItemCard key={w.id} w={w} state={state} selected={w.id === selected} onClick={() => select(w.id)} />
              ))}
            </div>
          );
        })}
      </div>
      <section className="card">
        <div className="card-h">
          <h2>Now / Next queues</h2>
          <span className="small faint">drag to reorder · drop on another agent to reassign · Next starts automatically when Now finishes</span>
        </div>
        <div className="card-b">
          <QueueEditor state={state} />
        </div>
      </section>
      {open && <ItemDrawer item={open} state={state} onClose={() => select(null)} />}
      {creating && <NewIssueDialog trackerTarget={trackerTarget} onClose={() => setCreating(false)} />}
    </div>
  );
}

function ItemCard({ w, state, selected, onClick }: { w: WorkItem; state: ControlState; selected: boolean; onClick: () => void }) {
  const owner = w.ownerAgentId ? state.agents[w.ownerAgentId] : null;
  const attention = w.state === 'blocked' || w.state === 'stalled' || w.state === 'failed';
  return (
    <div className={`item${selected ? ' sel' : ''}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="row small">
        <span className="mono faint">{w.key ?? 'pending'}</span>
        {w.sync.status === 'failed' && <Badge tone="crit">sync failed</Badge>}
        {w.sync.status === 'dry_run' && <Badge tone="warn">not in tracker</Badge>}
        {w.sync.status === 'pending' && <Badge tone="info">syncing</Badge>}
        <span className="spacer" />
        {owner && <Avatar id={owner.id} name={owner.config.name} size={20} />}
      </div>
      <div style={{ fontWeight: 550, margin: '3px 0' }}>{w.title}</div>
      <div className="row small wrap" style={{ gap: 4 }}>
        {attention && <Badge tone="crit">{LIFECYCLE_LABELS[w.state]}</Badge>}
        {w.labels.slice(0, 3).map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
        <span className="spacer" />
        <span className="faint">{ago(w.updatedAt)}</span>
      </div>
    </div>
  );
}

function ItemDrawer({ item, state, onClose }: { item: WorkItem; state: ControlState; onClose: () => void }) {
  const runs = item.runIds.map((id) => state.runs[id]).filter(Boolean);
  return (
    <div className="drawer" role="dialog" aria-label={item.title}>
      <div className="drawer-h">
        <div className="grow col" style={{ gap: 4 }}>
          <div className="row small">
            <span className="mono faint">{item.key ?? 'pending'}</span>
            <Badge tone={item.state === 'blocked' || item.state === 'failed' || item.state === 'stalled' ? 'crit' : 'accent'}>{LIFECYCLE_LABELS[item.state]}</Badge>
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer">
                open in tracker
              </a>
            )}
          </div>
          <h1 style={{ fontSize: 18 }}>{item.title}</h1>
          {item.blockedOn && <div className="small" style={{ color: 'var(--crit)' }}>Blocked on {item.blockedOn.kind}: {item.blockedOn.reason}</div>}
        </div>
        <button className="btn sm" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="drawer-b">
        {item.description && <div style={{ whiteSpace: 'pre-wrap' }}>{item.description}</div>}
        {item.acceptance.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            <h2>Acceptance criteria</h2>
            {item.acceptance.map((a, i) => (
              <div key={i} className="small">
                ☐ {a}
              </div>
            ))}
          </div>
        )}
        <div className="col" style={{ gap: 8 }}>
          <h2>Dispatch</h2>
          {item.origin && <div className="banner small">Imported from {item.origin.type}: {item.origin.key}. Changes stay local. {item.origin.url && <a href={item.origin.url} target="_blank" rel="noreferrer">View source</a>}</div>}
          <DispatchPanel item={item} state={state} />
        </div>
        <ReviewMergePanel item={item} state={state} />
        <div className="col" style={{ gap: 4 }}>
          <h2>Evidence</h2>
          {item.evidence.length === 0 && <div className="small faint">Nothing recorded. Done needs merge and acceptance evidence.</div>}
          {item.evidence.map((e) => (
            <div key={e.id} className="row small" style={{ alignItems: 'flex-start' }}>
              <Badge tone={e.verified ? (e.exitCode && e.exitCode !== 0 ? 'crit' : 'ok') : 'warn'}>{e.verified ? 'verified' : 'claimed'}</Badge>
              <div className="grow">
                <b>{e.kind}</b> {e.summary}
                {e.sha && <span className="mono faint"> @ {e.sha.slice(0, 10)}</span>}
              </div>
            </div>
          ))}
        </div>
        {runs.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            <h2>Runs</h2>
            {runs.map((r) => (
              <Link key={r.id} to={`/agents/${r.agentId}`} className="row small">
                <span>{state.agents[r.agentId]?.config.name}</span>
                <span className="faint">attempt {r.attempt}</span>
                <Badge>{r.exit?.kind ?? r.state}</Badge>
                <span className="spacer" />
                <span className="faint">{ago(r.createdAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
