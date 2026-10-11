// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The live event socket. Clients say hello with their last seq and get either the missed control
// events or a fresh snapshot; run transcripts are streamed only for runs a client subscribes to.
import type { FastifyInstance } from 'fastify';
import type { EventEnvelope } from '@acc/core';
import type { Daemon } from '../daemon.ts';
import { remotePrincipal } from '../phone/gate.ts';

/** A non-negative integer from untrusted input, else 0. */
const seqOf = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

export function registerEventSocket(app: FastifyInstance, d: Daemon): void {
  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket, wsReq) => {
      // A phone session sees only what its scopes allow: no remote-access audit events, no transcripts without `transcript`.
      const principal = remotePrincipal(wsReq);
      const canTranscript = !principal || principal.scopes.includes('transcript');
      const hidden = (e: EventEnvelope) => Boolean(principal) && e.type.startsWith('remote.');
      const onRevoked = (id: string) => { if (principal?.session.id === id) socket.close(4001, 'session revoked'); };
      if (principal) d.bus.on('remote.revoked', onRevoked);
      const runs = new Set<string>();
      let ready = false;
      const phoneAuthorized = () => {
        if (!principal || d.remote.socketAuthorized(principal.session.id, principal.scopes)) return true;
        socket.close(4001, 'session no longer authorized');
        return false;
      };
      const send = (message: unknown) => {
        if (!phoneAuthorized()) return;
        const messages = principal ? d.remote.projectMessages(message, principal.scopes) : [message];
        for (const m of messages) if (socket.readyState === 1) socket.send(JSON.stringify(m));
      };
      const onEvents = (events: EventEnvelope[]) => {
        if (!ready) return;
        const out = events.filter((e) => !hidden(e) && (e.kind === 'control' || (e.runId && runs.has(e.runId))));
        if (out.length) send({ type: 'events', events: out });
        // Runs this client isn't watching: send their updated projections (liveness, last event)
        // instead of the full transcript.
        const touched = [...new Set(events.filter((e) => e.kind === 'transcript' && e.runId && !runs.has(e.runId)).map((e) => e.runId!))];
        if (touched.length) {
          const rs = touched.map((id) => d.state.runs[id]).filter(Boolean);
          send({ type: 'patch', seq: d.state.seq, runs: rs, agents: [...new Set(rs.map((r) => r.agentId))].map((id) => d.state.agents[id]).filter(Boolean) });
        }
      };
      d.bus.on('events', onEvents);
      // Token streaming: every client gets the in-progress text (Mission Control shows a preview).
      const onLive = (m: { runId: string; agentId: string; role: string; text: string; at: string }) => {
        if (ready && canTranscript) send({ type: 'live', ...m });
      };
      d.bus.on('live', onLive);
      socket.on('message', (raw: Buffer) => {
        if (!phoneAuthorized()) return;
        let m: { type?: string; since?: unknown; runId?: unknown };
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const runId = typeof m.runId === 'string' && m.runId ? m.runId : null;
        if (m.type === 'hello') {
          const since = seqOf(m.since);
          const gap = d.state.seq - since;
          if (since <= 0 || gap > 5000) send({ type: 'snapshot', seq: d.state.seq, state: d.state });
          else send({ type: 'events', events: d.store.list({ afterSeq: since, kind: 'control', limit: 5000 }).filter((e) => !hidden(e)) });
          ready = true;
        } else if (m.type === 'subscribe_run' && runId) {
          if (!canTranscript) return send({ type: 'denied', reason: 'This phone was not granted run transcripts.' });
          runs.add(runId);
          const events = d.store.list({ runId, afterSeq: seqOf(m.since), limit: 1000 });
          send({ type: 'run_events', runId, events, more: events.length === 1000 });
        } else if (m.type === 'unsubscribe_run' && runId) runs.delete(runId);
      });
      socket.on('close', () => {
        d.bus.off('events', onEvents);
        d.bus.off('live', onLive);
        d.bus.off('remote.revoked', onRevoked);
      });
    });
  });
}
