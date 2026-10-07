// SPDX-License-Identifier: Apache-2.0
// Live client state: a snapshot from /api/state kept current over the WebSocket with the SAME
// reducer the daemon uses, so the UI can't drift from the event log.
import { useCallback, useSyncExternalStore } from 'react';
import type { AgentState, ControlState, EventEnvelope, Run } from '@acc/core';
import { applyEvent } from '@acc/core';
import { restartActiveEngine, switchProject, websocketUrl } from './desktop';
import { api, ApiError } from './api';

export type Conn = 'connecting' | 'live' | 'offline' | 'unauthorized';

interface Meta {
  demo: boolean;
  tracker: { type: string; target: string; live: boolean } | null;
  outbox: { pending: number; failing: number } | null;
}

type Listener = () => void;

class LiveStore {
  state: ControlState | null = null;
  conn: Conn = 'connecting';
  meta: Meta = { demo: false, tracker: null, outbox: null };
  loadError = '';
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private runEvents = new Map<string, EventEnvelope[]>();
  private runListeners = new Map<string, Set<Listener>>();
  private retry = 0;
  private started = false;
  private version = 0;
  /** Bumped on project switch; work started for an earlier project is discarded. */
  private gen = 0;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  snapshot = () => this.version;

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  start() {
    if (this.started) return;
    this.started = true;
    void this.load();
  }

  /** Drop every piece of the previous project's live state and connect to the active one. */
  switchProject() {
    this.gen++;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.state = null;
    this.meta = { demo: false, tracker: null, outbox: null };
    this.runEvents.clear();
    this.liveText.clear();
    this.loadError = '';
    this.conn = 'connecting';
    this.retry = 0;
    this.started = true;
    this.emit();
    void this.load();
  }

  async load() {
    const gen = this.gen;
    try {
      const r = await api<{ state: ControlState; demo?: boolean; tracker: Meta['tracker']; outbox: Meta['outbox'] }>('/api/state');
      if (gen !== this.gen) return;
      this.state = r.state;
      this.meta = { demo: Boolean(r.demo), tracker: r.tracker, outbox: r.outbox };
      this.loadError = '';
      await this.connect(gen);
    } catch (e) {
      if (gen !== this.gen) return;
      this.loadError = String(e);
      this.conn = e instanceof ApiError && e.status === 401 ? 'unauthorized' : 'offline';
      this.emit();
      if (this.conn === 'offline') setTimeout(() => { if (gen === this.gen) void restartActiveEngine().catch(() => {}).finally(() => { if (gen === this.gen) void this.load(); }); }, this.backoff());
    }
  }

  private backoff() {
    this.retry = Math.min(this.retry + 1, 6);
    return 500 * 2 ** this.retry;
  }

  private async connect(gen: number) {
    const url = await websocketUrl();
    if (gen !== this.gen) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return ws.close();
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', since: this.state?.seq ?? 0 }));
      for (const [runId, evs] of this.runEvents) ws.send(JSON.stringify({ type: 'subscribe_run', runId, since: evs.at(-1)?.seq ?? 0 }));
      this.conn = 'live';
      this.emit();
    };
    ws.onmessage = (m) => { if (this.ws === ws) this.onMessage(JSON.parse(String(m.data))); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.conn = 'offline';
      this.emit();
      setTimeout(() => { if (gen === this.gen) void this.load(); }, this.backoff());
    };
  }

  /** In-progress text per run (token streaming). Never persisted; cleared when the message lands. */
  liveText = new Map<string, { assistant: string; reasoning: string; at: string }>();

  liveFor(runId: string | null | undefined) {
    return runId ? this.liveText.get(runId) ?? null : null;
  }

  private onMessage(m: { type: string; events?: EventEnvelope[]; more?: boolean; state?: ControlState; runId?: string; runs?: Run[]; agents?: AgentState[]; role?: 'assistant' | 'reasoning'; text?: string; at?: string }) {
    if (m.type === 'live' && m.runId && m.role) {
      const cur = { ...(this.liveText.get(m.runId) ?? { assistant: '', reasoning: '', at: '' }) };
      cur[m.role] = m.text ?? '';
      cur.at = m.at ?? new Date().toISOString();
      if (!cur.assistant && !cur.reasoning) this.liveText.delete(m.runId);
      else this.liveText.set(m.runId, cur);
      this.notifyRun(m.runId);
      this.emit();
      return;
    }
    if (m.type === 'snapshot' && m.state) this.state = m.state;
    else if (m.type === 'events' && m.events) this.ingest(m.events);
    else if (m.type === 'run_events' && m.runId && m.events) {
      if (this.runEvents.has(m.runId)) {
        const cur = this.runEvents.get(m.runId)!;
        const seen = new Set(cur.map((e) => e.seq));
        this.runEvents.set(m.runId, [...cur, ...m.events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq));
        this.notifyRun(m.runId);
        if (m.more) void this.loadHistory(m.runId, m.events.at(-1)?.seq ?? 0);
      }
    } else if (m.type === 'patch' && this.state) {
      const runs = { ...this.state.runs };
      for (const r of m.runs ?? []) runs[r.id] = r;
      const agents = { ...this.state.agents };
      for (const a of m.agents ?? []) agents[a.id] = a;
      this.state = { ...this.state, runs, agents };
    }
    this.emit();
  }

  private ingest(events: EventEnvelope[]) {
    if (!this.state) return;
    let s = this.state;
    const touchedRuns = new Set<string>();
    for (const e of events) {
      if (e.kind === 'control' && e.seq <= s.seq) continue;
      s = applyEvent(s, e);
      if (e.runId && this.runEvents.has(e.runId)) {
        const list = this.runEvents.get(e.runId)!;
        if (!list.some((x) => x.seq === e.seq)) this.runEvents.set(e.runId, [...list, e]);
        touchedRuns.add(e.runId);
      }
    }
    this.state = s;
    for (const r of touchedRuns) this.notifyRun(r);
  }

  // ---- per-run transcripts -----------------------------------------------------------------

  private async loadHistory(runId: string, cursor: number) {
    try {
      while (this.runEvents.has(runId)) {
        const { events } = await api<{ events: EventEnvelope[] }>(`/api/runs/${runId}/events?since=${cursor}&limit=1000`);
        this.onMessage({ type: 'run_events', runId, events });
        if (events.length < 1000) return;
        cursor = events.at(-1)!.seq;
      }
    } catch {
      // Retry from the last contiguous page, even if newer live events have already arrived.
      setTimeout(() => void this.loadHistory(runId, cursor), 3000);
    }
  }

  watchRun(runId: string, l: Listener) {
    if (!this.runEvents.has(runId)) {
      this.runEvents.set(runId, []);
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'subscribe_run', runId, since: 0 }));
    }
    const set = this.runListeners.get(runId) ?? new Set();
    set.add(l);
    this.runListeners.set(runId, set);
    return () => {
      set.delete(l);
      // Keep the cache briefly: a quick re-subscribe (re-render, run switch back) reuses it.
      setTimeout(() => {
        if ((this.runListeners.get(runId)?.size ?? 0) > 0) return;
        this.runListeners.delete(runId);
        this.runEvents.delete(runId);
        if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'unsubscribe_run', runId }));
      }, 10_000);
    };
  }

  private static EMPTY: EventEnvelope[] = [];

  eventsFor(runId: string): EventEnvelope[] {
    return this.runEvents.get(runId) ?? LiveStore.EMPTY;
  }

  private notifyRun(runId: string) {
    for (const l of this.runListeners.get(runId) ?? []) l();
  }

  async refreshMeta() {
    try {
      const r = await api<{ tracker: Meta['tracker']; outbox: Meta['outbox'] }>('/api/state');
      this.meta = { ...this.meta, tracker: r.tracker, outbox: r.outbox };
      this.emit();
    } catch {
      /* ignore */
    }
  }
}

export const live = new LiveStore();

/** Switch the dashboard to another project. Other projects' engines and runs keep going. */
export async function openProject(id: string) {
  await switchProject(id);
  live.switchProject();
}

export function useLive(): { state: ControlState | null; conn: Conn; meta: Meta; loadError: string } {
  useSyncExternalStore(live.subscribe, live.snapshot);
  return { state: live.state, conn: live.conn, meta: live.meta, loadError: live.loadError };
}

const NONE: EventEnvelope[] = [];

/** The streaming (not yet recorded) text of a run, re-rendered as tokens arrive. */
export function useLiveText(runId: string | null) {
  const sub = useCallback((l: () => void) => (runId ? live.watchRun(runId, l) : () => {}), [runId]);
  const get = useCallback(() => live.liveFor(runId), [runId]);
  return useSyncExternalStore(sub, get);
}

/** Live transcript for one run. The returned array is replaced (never mutated) on change. */
export function useRunEvents(runId: string | null): EventEnvelope[] {
  const sub = useCallback((l: () => void) => (runId ? live.watchRun(runId, l) : () => {}), [runId]);
  const get = useCallback(() => (runId ? live.eventsFor(runId) : NONE), [runId]);
  return useSyncExternalStore(sub, get);
}
