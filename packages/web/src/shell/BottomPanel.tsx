// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Collapsible bottom panel, as in ComfyUI: project terminals and a live log of what the engine did.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ControlState } from '@acc/core';
import { api } from '../lib/api';
import { isDesktop } from '../lib/desktop';
import { Icon } from './icons';

const ProjectTerminals = lazy(() => import('../pages/Workspace').then(m => ({ default: m.ProjectTerminals })));

export type PanelTab = 'terminal' | 'logs';
const KEY = 'one-connect.bottom-panel';
export interface PanelPrefs { open: boolean; height: number; tab: PanelTab }

export function readPanelPrefs(): PanelPrefs {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PanelPrefs> | null; return { open: Boolean(v?.open), height: Math.min(700, Math.max(140, Number(v?.height) || 280)), tab: v?.tab === 'terminal' ? 'terminal' : 'logs' }; }
  catch { return { open: false, height: 280, tab: 'logs' }; }
}
export function savePanelPrefs(p: PanelPrefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* per-viewer convenience only */ } }

interface LogEvent { seq: number; ts: string; kind: string; type: string; actor: string | null; agentId: string | null; runId: string | null; workItemId: string | null; text: string }
type Filter = 'all' | 'runs' | 'decisions' | 'problems';
const FILTERS: { id: Filter; label: string; test: (e: LogEvent) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'runs', label: 'Runs', test: e => e.type.startsWith('run.') || e.type.startsWith('t.') || e.type.startsWith('assignment.') || e.type.startsWith('workflow.') },
  { id: 'decisions', label: 'Decisions', test: e => e.type.startsWith('decision.') || e.type.startsWith('approval.') },
  { id: 'problems', label: 'Problems', test: e => e.type.startsWith('alert.') || e.type === 't.error' || /fail|error|blocked|denied|refused/i.test(`${e.type} ${e.text}`) },
];

export function BottomPanel({ state, demo, prefs, onPrefs }: { state: ControlState; demo: boolean; prefs: PanelPrefs; onPrefs: (p: PanelPrefs) => void }) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  const set = (p: Partial<PanelPrefs>) => onPrefs({ ...prefs, ...p });
  useEffect(() => {
    const move = (e: PointerEvent) => { if (drag.current) set({ height: Math.min(Math.round(window.innerHeight * 0.75), Math.max(140, drag.current.h + drag.current.y - e.clientY)) }); };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  });
  return (
    <section className={`bp${prefs.open ? ' open' : ''}`} style={prefs.open ? { height: prefs.height } : undefined} aria-label="Bottom panel">
      {prefs.open && <div className="bp-resize" role="separator" aria-orientation="horizontal" aria-label="Resize bottom panel" tabIndex={0}
        onPointerDown={e => { drag.current = { y: e.clientY, h: prefs.height }; }}
        onKeyDown={e => { if (e.key === 'ArrowUp') set({ height: Math.min(700, prefs.height + 24) }); if (e.key === 'ArrowDown') set({ height: Math.max(140, prefs.height - 24) }); }} />}
      <div className="bp-tabs" role="tablist" aria-label="Bottom panel">
        {(['terminal', 'logs'] as const).map(t => <button key={t} type="button" role="tab" aria-selected={prefs.open && prefs.tab === t} className={prefs.open && prefs.tab === t ? 'on' : ''} onClick={() => set(prefs.open && prefs.tab === t ? { open: false } : { open: true, tab: t })}>{t === 'terminal' ? 'Terminal' : 'Logs'}</button>)}
        <span className="spacer" />
        <button type="button" className="shell-icon-btn" aria-label={prefs.open ? 'Collapse bottom panel' : 'Expand bottom panel'} aria-expanded={prefs.open} onClick={() => set({ open: !prefs.open })}><Icon name={prefs.open ? 'chevronDown' : 'chevronUp'} size={14} /></button>
      </div>
      {prefs.open && <div className="bp-body" role="tabpanel">
        {prefs.tab === 'terminal'
          ? isDesktop ? <Suspense fallback={<p className="small muted bp-pad">Opening terminals…</p>}><div className="bp-terminal"><ProjectTerminals state={state} command={null} demo={demo} /></div></Suspense>
            : <p className="small muted bp-pad">Terminals run inside the One Connect desktop app, attached to this project. <Link to="/workspace">Terminal and containers</Link> shows what this browser can do.</p>
          : <Logs />}
      </div>}
    </section>
  );
}

function Logs() {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await api<{ last: number; events: LogEvent[] }>(`/api/canvas/logs?after=${last.current}&limit=300`);
        if (stop) return;
        last.current = r.last;
        if (r.events.length) setEvents(cur => [...cur, ...r.events].slice(-1500));
        setError(null);
      } catch (e) { if (!stop) setError(e instanceof Error ? e.message : String(e)); }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  useEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [events, filter, q]);
  const test = FILTERS.find(f => f.id === filter)!.test;
  const needle = q.trim().toLowerCase();
  const shown = events.filter(e => test(e) && (!needle || `${e.type} ${e.text} ${e.agentId ?? ''}`.toLowerCase().includes(needle)));
  return <div className="bp-logs">
    <div className="bp-logs-bar">
      <div role="group" aria-label="Filter logs" className="bp-chips">{FILTERS.map(f => <button key={f.id} type="button" aria-pressed={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>
      <input aria-label="Search logs" placeholder="Search logs" value={q} onChange={e => setQ(e.target.value)} />
      <span className="small faint">{shown.length} of {events.length}</span>
      {error && <span className="small crit-text" role="alert">{error}</span>}
    </div>
    <div ref={box} className="bp-log-lines" role="log" aria-live="polite" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {shown.length === 0 && <p className="small faint bp-pad">{events.length ? 'No lines match.' : 'Nothing logged yet. Engine events appear here as they happen.'}</p>}
      {shown.map(e => <div key={e.seq} className={`bp-line${FILTERS[3].test(e) ? ' problem' : ''}`}>
        <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time>
        <span className="bp-type">{e.type}</span>
        {e.agentId && <span className="bp-agent">{e.agentId}</span>}
        <span className="bp-text">{e.text}</span>
        {e.runId && <Link className="small" to={`/runs/${encodeURIComponent(e.runId)}`}>run</Link>}
      </div>)}
    </div>
  </div>;
}
