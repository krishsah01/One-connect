// SPDX-License-Identifier: Apache-2.0
// Live client state: a snapshot from /api/state kept current over the WebSocket with the SAME
// reducer the daemon uses, so the UI can't drift from the event log.
import { useCallback, useSyncExternalStore } from 'react';
import type { AgentState, ControlState, EventEnvelope, Run } from '@acc/core';
import { applyEvent } from '@acc/core';
import { restartActiveEngine, switchProject, websocketUrl } from './desktop';
import { api, ApiError } from './api';
import { clearPhoneAuthority, loadRemoteSession, markConnectionOffline, onPhoneAuthorityCleared, remoteMode } from './remote';

export type Conn = 'connecting' | 'live' | 'offline' | 'unauthorized';

interface Meta {
  demo: boolean;
  tracker: { type: string; target: string; live: boolean } | null;
  outbox: { pending: number; failing: number } | null;
}

type Listener = () => void;

const authorityLive = () => remoteMode() === 'local' || remoteMode() === 'paired';

export class LiveStore {
  state: ControlState | null = null;
  conn: Conn = 'connecting';
  meta: Meta = { demo: false, tracker: null, outbox: null };
  loadError = '';
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<(events: EventEnvelope[]) => void>();
  private runEvents = new Map<string, EventEnvelope[]>();
  private runListeners = new Map<string, Set<Listener>>();
  private retry = 0;
  private started = false;
  private version = 0;
  private snapshotSeq = 0;
  private controlCursor = 0;
  private seenControls = new Set<number>();
  /** Bumped on project switch; work started for an earlier project is discarded. */
  private gen = 0;
  /** Bumped when phone authority changes; stale socket callbacks are ignored. */
  private authGen = 0;
  private loading: { gen: number; pending: Promise<void> } | null = null;
  private reloadRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeAuthority = onPhoneAuthorityCleared(() => this.invalidateAuthority());

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  snapshot = () => this.version;

  /** Live control events as they arrive (not snapshots). Used for browser notifications. */
  onEvents = (l: (events: EventEnvelope[]) => void) => {
    this.eventListeners.add(l);
    return () => { this.eventListeners.delete(l); };
  };

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  start() {
    if (this.started) return;
    this.started = true;
    void this.load();
  }

  /** Detach a client completely (also used by isolated socket contract fixtures). */
  dispose() {
    this.started = false;
    this.gen++;
    this.authGen++;
    this.unsubscribeAuthority();
    this.closeSocket();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.dropProjectState('offline');
  }

  private closeSocket() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  /** Drop complete project state when authority or project changes. */
  dropProjectState(conn: Conn = 'connecting') {
    this.state = null;
    this.snapshotSeq = this.controlCursor = 0; this.seenControls.clear();
    this.meta = { demo: false, tracker: null, outbox: null };
    this.runEvents.clear();
    this.liveText.clear();
    this.loadError = '';
    this.conn = conn;
    for (const runId of this.runListeners.keys()) this.notifyRun(runId);
    this.emit();
  }

  /** Drop every piece of the previous project's live state and connect to the active one. */
  switchProject() {
    this.gen++;
    clearPhoneAuthority('checking');
    this.closeSocket();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.loading = null;
    this.reloadRequested = false;
    this.retry = 0;
    this.started = true;
    this.dropProjectState('connecting');
    void this.load();
  }

  load(): Promise<void> {
    if (this.loading?.gen === this.gen) return this.loading.pending;
    const gen = this.gen;
    const job = { gen, pending: this.loadCurrent(gen) };
    this.loading = job;
    void job.pending.finally(() => {
      if (this.loading !== job) return;
      this.loading = null;
      if (this.reloadRequested && this.started && gen === this.gen && authorityLive()) {
        this.reloadRequested = false;
        void this.load();
      }
    });
    return job.pending;
  }

  private async loadCurrent(gen: number) {
    // Startup and each reconnect must first await an actual identity response. A detached
    // bootstrap check can otherwise leave the store stuck before it ever asks for state.
    await loadRemoteSession();
    if (gen !== this.gen) return;
    const authGen = this.authGen;
    this.reloadRequested = false;
    if (!authorityLive()) {
      this.dropProjectState(remoteMode() === 'unauthorized' ? 'unauthorized' : remoteMode() === 'checking' ? 'connecting' : 'offline');
      if (remoteMode() === 'offline') this.scheduleRetry(gen, authGen);
      return;
    }
    try {
      const r = await api<{ state: ControlState; demo?: boolean; tracker: Meta['tracker']; outbox: Meta['outbox'] }>('/api/state');
      if (gen !== this.gen || authGen !== this.authGen) return;
      this.acceptSnapshot(r.state);
      this.meta = { demo: Boolean(r.demo), tracker: r.tracker, outbox: r.outbox };
      this.loadError = '';
      await this.connect(gen, authGen);
    } catch (e) {
      if (gen !== this.gen || authGen !== this.authGen) return;
      this.loadError = String(e);
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) clearPhoneAuthority('unauthorized');
      else markConnectionOffline();
      this.conn = remoteMode() === 'unauthorized' ? 'unauthorized' : 'offline';
      this.emit();
      if (this.conn === 'offline') this.scheduleRetry(gen, this.authGen);
    }
  }

  private backoff() {
    this.retry = Math.min(this.retry + 1, 6);
    return 500 * 2 ** this.retry;
  }

  private scheduleRetry(gen: number, authGen: number) {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (gen !== this.gen || authGen !== this.authGen || !this.started) return;
      void restartActiveEngine().catch(() => {}).finally(() => {
        if (gen === this.gen && authGen === this.authGen && this.started) void this.load();
      });
    }, this.backoff());
  }

  private async connect(gen: number, authGen: number) {
    const url = await websocketUrl();
    if (gen !== this.gen || authGen !== this.authGen) return;
    this.closeSocket();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return ws.close();
      void (async () => {
        if (gen !== this.gen || authGen !== this.authGen || this.ws !== ws) return;
        await loadRemoteSession();
        if (gen !== this.gen || authGen !== this.authGen || this.ws !== ws) return;
        if (!authorityLive()) {
          this.conn = remoteMode() === 'unauthorized' ? 'unauthorized' : remoteMode() === 'checking' ? 'connecting' : 'offline';
          this.emit();
          ws.close();
          return;
        }
        this.retry = 0;
        ws.send(JSON.stringify({ type: 'hello', since: this.state?.seq ?? 0 }));
        for (const [runId, evs] of this.runEvents) ws.send(JSON.stringify({ type: 'subscribe_run', runId, since: evs.at(-1)?.seq ?? 0 }));
        this.conn = 'live';
        this.emit();
      })();
    };
    ws.onmessage = (m) => {
      if (this.ws !== ws || gen !== this.gen || authGen !== this.authGen) return;
      try { this.onMessage(JSON.parse(String(m.data))); } catch { /* Ignore malformed frames. */ }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4001) this.clearPhoneCaches();
      else markConnectionOffline();
    };
  }

  invalidateAuthority() {
    this.authGen++;
    this.closeSocket();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.dropProjectState(remoteMode() === 'unauthorized' ? 'unauthorized' : remoteMode() === 'offline' ? 'offline' : 'connecting');
    if (!this.started) return;
    if (authorityLive()) {
      this.reloadRequested = true;
      queueMicrotask(() => { if (this.started && authorityLive()) void this.load(); });
    } else if (remoteMode() === 'offline') this.scheduleRetry(this.gen, this.authGen);
  }

  /** Drop run caches when phone authority is revoked; credentials are never stored here. */
  clearPhoneCaches() {
    clearPhoneAuthority('checking');
    void this.load();
  }

  dropRunCaches() {
    this.runEvents.clear();
    this.liveText.clear();
    for (const runId of this.runListeners.keys()) this.notifyRun(runId);
    this.emit();
  }

  /** In-progress text per run (token streaming). Never persisted; cleared when the message lands. */
  liveText = new Map<string, { assistant: string; reasoning: string; at: string }>();

  liveFor(runId: string | null | undefined) {
    return runId ? this.liveText.get(runId) ?? null : null;
  }

  private onMessage(m: { type: string; events?: EventEnvelope[]; more?: boolean; state?: ControlState; runId?: string; runs?: Run[]; agents?: AgentState[]; role?: 'assistant' | 'reasoning'; text?: string; at?: string }) {
    if (!authorityLive()) return;
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
    if (m.type === 'snapshot' && m.state) this.acceptSnapshot(m.state);
    else if (m.type === 'events' && m.events) { this.ingest(m.events); for (const l of this.eventListeners) l(m.events); }
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

  private acceptSnapshot(state: ControlState) {
    this.state = state; this.snapshotSeq = this.controlCursor = state.seq; this.seenControls.clear();
  }

  private ingest(events: EventEnvelope[]) {
    if (!this.state || !authorityLive()) return;
    let s = this.state;
    const touchedRuns = new Set<string>();
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
      if (e.kind === 'control') {
        if (e.seq <= this.snapshotSeq || this.seenControls.has(e.seq)) continue;
        if (e.seq < this.controlCursor) {
          // Unseen old control state cannot be applied over newer mutations. Repair from the
          // authoritative snapshot; no client-side guess can safely reconstruct missing batches.
          this.closeSocket(); this.conn = 'connecting';
          if (this.loading) this.reloadRequested = true; else void this.load();
          break;
        }
        this.seenControls.add(e.seq); this.controlCursor = e.seq;
        if (this.seenControls.size > 10_000) this.seenControls.delete(this.seenControls.values().next().value!);
        s = applyEvent(s, e);
      } else if (e.seq > this.snapshotSeq && !this.runEvents.get(e.runId ?? '')?.some(x => x.seq === e.seq)) {
        // Subscribed transcript sequences are not a durable cursor for control replay.
        s = { ...applyEvent(s, e), seq: this.controlCursor };
      }
      if (e.runId && this.runEvents.has(e.runId)) {
        const list = this.runEvents.get(e.runId)!;
        if (!list.some((x) => x.seq === e.seq)) this.runEvents.set(e.runId, [...list, e]);
        touchedRuns.add(e.runId);
      }
      if (e.runId && e.type === 't.message' && (e.data as { role?: string }).role === 'assistant') {
        const preview = this.liveText.get(e.runId);
        if (preview && Date.parse(e.ts) >= Date.parse(preview.at)) {
          this.liveText.delete(e.runId);
          touchedRuns.add(e.runId);
        }
      }
    }
    this.state = s;
    for (const r of touchedRuns) this.notifyRun(r);
  }

  // ---- per-run transcripts -----------------------------------------------------------------

  private async loadHistory(runId: string, cursor: number) {
    if (!authorityLive()) return;
    const gen = this.gen, authGen = this.authGen;
    try {
      while (this.runEvents.has(runId) && gen === this.gen && authGen === this.authGen) {
        const { events } = await api<{ events: EventEnvelope[] }>(`/api/runs/${runId}/events?since=${cursor}&limit=1000`);
        if (gen !== this.gen || authGen !== this.authGen) return;
        this.onMessage({ type: 'run_events', runId, events });
        if (events.length < 1000) return;
        cursor = events.at(-1)!.seq;
      }
    } catch {
      // Retry from the last contiguous page, even if newer live events have already arrived.
      setTimeout(() => { if (gen === this.gen && authGen === this.authGen && this.runEvents.has(runId)) void this.loadHistory(runId, cursor); }, 3000);
    }
  }

  watchRun(runId: string, l: Listener) {
    const gen = this.gen, authGen = this.authGen;
    if (!this.runEvents.has(runId)) {
      this.runEvents.set(runId, []);
      if (this.ws?.readyState === 1 && authorityLive()) this.ws.send(JSON.stringify({ type: 'subscribe_run', runId, since: 0 }));
    }
    const set = this.runListeners.get(runId) ?? new Set();
    set.add(l);
    this.runListeners.set(runId, set);
    return () => {
      set.delete(l);
      // Keep the cache briefly: a quick re-subscribe (re-render, run switch back) reuses it.
      setTimeout(() => {
        if (gen !== this.gen || authGen !== this.authGen || this.runListeners.get(runId) !== set) return;
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
    const gen = this.gen, authGen = this.authGen;
    try {
      const r = await api<{ tracker: Meta['tracker']; outbox: Meta['outbox'] }>('/api/state');
      if (gen !== this.gen || authGen !== this.authGen || !authorityLive()) return;
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

/** Test hook: push a live preview token as the WebSocket would. */
export function testLivePreview(runId: string, role: 'assistant' | 'reasoning', text: string, at: string) {
  (live as unknown as { onMessage(m: unknown): void }).onMessage({ type: 'live', runId, role, text, at });
}

/** Test hook: ingest recorded events through the live reducer. */
export function testIngestEvents(events: EventEnvelope[]) {
  (live as unknown as { ingest(e: EventEnvelope[]): void }).ingest(events);
}

/** Test hook: subscribe a run transcript cache entry. */
export function testWatchRun(runId: string) {
  return live.watchRun(runId, () => {});
}
