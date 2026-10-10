// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// HTTP routes for phone access, notifications, Brief & Reports and the context benchmark.
// Registered on the main app, so Host/Origin/auth checks (local or remote gate) run first.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CommandError, type Daemon } from '../daemon.ts';
import { buildBrief, buildMorningReport, buildTimeline, renderStandupMarkdown } from '@acc/core';
import { phoneLog, phoneLogPage } from './logs.ts';
import { phoneDecision, phoneHistory, phoneReportEvents } from './projection.ts';
import { remotePreHandler, remotePrincipal } from './gate.ts';

type R<B = unknown, P = Record<string, string>, Q = Record<string, string | undefined>> = FastifyRequest<{ Body: B; Params: P; Querystring: Q }>;

export function registerPhoneHooks(app: FastifyInstance, d: Daemon): void {
  app.addHook('preHandler', async (req, reply) => remotePreHandler(d, req, reply));
  app.addHook('onSend', async (req, reply, payload) => {
    const p = remotePrincipal(req);
    if (!p || reply.statusCode >= 400) return payload;
    const url = req.url.split('?')[0];
    const log = /^\/api\/runs\/([^/]+)\/log(\/page)?$/.exec(url);
    if (log) {
      const query = req.query as { stream?: string; offset?: string };
      const id = decodeURIComponent(log[1]);
      if (payload && typeof payload === 'object' && 'destroy' in payload) (payload as { destroy(): void }).destroy();
      if (log[2]) return JSON.stringify(phoneLogPage(d, id, query.stream, Number(query.offset ?? 0)));
      return phoneLog(d, id, query.stream).toString('utf8');
    }
    if (typeof payload !== 'string') return payload;
    if (url === '/api/state') return JSON.stringify({ seq: d.state.seq, state: d.remote.projectState(p.scopes) });
    if (/^\/api\/runs\/[^/]+\/events$/.test(url)) {
      const body = JSON.parse(payload) as { events?: Parameters<typeof phoneHistory>[1] };
      return JSON.stringify({ events: phoneHistory(d, body.events ?? [], p.scopes) });
    }
    if (/^\/api\/work-items\/[^/]+\/events$/.test(url)) {
      const body = JSON.parse(payload) as { events?: Parameters<typeof phoneReportEvents>[1] };
      return JSON.stringify({ events: phoneReportEvents(d, body.events ?? [], p.scopes) });
    }
    if (url === '/api/team') {
      const body = JSON.parse(payload);
      const assignment = (a: Record<string, unknown> | null) => a ? { assignmentId: a.assignmentId, issueId: a.issueId, key: a.key, title: a.title, state: a.state } : null;
      return JSON.stringify({ project: body.project, seq: body.seq, agents: (body.agents ?? []).map((a: Record<string, any>) => ({ id: a.id, name: a.name, role: a.role, status: a.status, model: a.model, capacity: a.capacity, now: (a.now ?? []).map(assignment), next: (a.next ?? []).map(assignment) })), moreAgents: body.moreAgents, nextOffset: body.nextOffset, pendingDecisions: p.scopes.includes('decisions') ? body.pendingDecisions : [], inbox: [] });
    }
    if (/^\/api\/decisions\/[^/]+\/history$/.test(url)) {
      const body = JSON.parse(payload) as { events?: Parameters<typeof d.remote.projectEvents>[0] };
      return JSON.stringify({ events: d.remote.projectEvents(body.events ?? [], p.scopes) });
    }
    if (/^\/api\/decisions\/[^/]+\/answer$/.test(url)) {
      const body = JSON.parse(payload) as Record<string, any>;
      // Specialized executors can return full connection/configuration objects to the Mac.
      // The phone receives its recorded Decision and bounded result fields only.
      return d.redactText(JSON.stringify({ decision: body.decision ? phoneDecision(d, body.decision) : undefined,
        ...(body.merge ? { merge: { merged: body.merge.merged, mergeSha: body.merge.mergeSha, reason: body.merge.reason } } : {}),
        ...(body.connection ? { connection: { state: body.connection.state } } : {}),
        ...(body.docker ? { docker: { executed: body.docker.executed, exitCode: body.docker.exitCode } } : {}),
        ...(body.environment ? { environment: { executed: body.environment.executed } } : {}),
        ...(body.release ? { release: { executed: body.release.executed, status: body.release.status } } : {}),
        ...(body.cost ? { cost: { saved: body.cost.saved } } : {}),
        ...(body.settings ? { settings: { saved: body.settings.saved } } : {}),
        ...(body.remote ? { remote: { tunnel: { state: body.remote.tunnel?.state, detail: body.remote.tunnel?.detail } } } : {}),
        ...(body.notification ? { notification: { recorded: true } } : {}),
      }));
    }
    // Redact every successful phone JSON/text response, including recorded inbox and team data.
    return d.redactText(payload);
  });
}

export function registerPhoneRoutes(app: FastifyInstance, d: Daemon): void {
  /** Admin routes are for the signed-in Mac. The remote gate already refuses them for phones; this is the second lock. */
  const local = (req: FastifyRequest) => { if (remotePrincipal(req)) throw new CommandError('This action is only available on the Mac.', 403); };

  // ---- remote access --------------------------------------------------------------------------
  app.get('/api/remote/status', async (req) => { local(req); return d.remote.status(); });
  app.get('/api/remote/review', async (req) => { local(req); return d.remote.review(); });
  app.post('/api/remote/config', async (req: R<Record<string, unknown>>) => { local(req); await d.remote.configure(req.body ?? {}); return d.remote.status(); });
  app.post('/api/remote/launch', async (req) => { local(req); const r = d.remote.requestLaunch(); return { decision: r.decision, plan: r.plan }; });
  app.post('/api/remote/stop', async (req) => { local(req); await d.remote.stop('stopped by owner'); return d.remote.status(); });
  app.post('/api/remote/pairings', async (req) => { local(req); return d.remote.issuePairing(); });
  app.post('/api/remote/revoke-all', async (req) => { local(req); return { revoked: d.remote.revokeAll('revoked by owner') }; });
  app.delete('/api/remote/sessions/:id', async (req: R<unknown, { id: string }>) => { local(req); if (!d.remote.revoke(req.params.id, 'revoked by owner')) throw new CommandError('No such active phone session', 404); return d.remote.status(); });
  app.get('/api/remote/audit', async (req) => {
    local(req);
    return { events: d.store.list({ types: ['remote.config_changed', 'remote.tunnel_requested', 'remote.tunnel_state', 'remote.pairing_issued', 'remote.paired', 'remote.pair_failed', 'remote.session_revoked', 'remote.request_denied'], limit: 100, order: 'desc' }) };
  });

  // Phone-facing: pairing (no session yet), session info, logout.
  app.post('/api/remote/pair', async (req: R<{ token?: string }>, reply) => {
    if (!d.remote.isRemoteHost(req.headers.host ?? '')) throw new CommandError('Pairing is only available through the tunnel.', 403);
    const r = d.remote.pair(String(req.body?.token ?? ''));
    const maxAge = Math.max(60, Math.round((Date.parse(r.session.expiresAt) - d.now().getTime()) / 1000));
    reply.header('set-cookie', `${r.cookieName}=${r.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${r.secure ? '; Secure' : ''}`);
    return { paired: true, csrf: r.csrf, scopes: r.session.scopes, expiresAt: r.session.expiresAt, project: d.state.project?.name ?? null };
  });
  app.get('/api/remote/session', async (req) => {
    const p = remotePrincipal(req);
    if (!p) throw new CommandError('Not a phone session', 403);
    return { id: p.session.id, label: p.session.label, scopes: p.scopes, expiresAt: p.session.expiresAt, csrf: p.csrf, project: d.state.project?.name ?? null };
  });
  app.post('/api/remote/logout', async (req, reply) => {
    const p = remotePrincipal(req);
    if (!p) throw new CommandError('Not a phone session', 403);
    d.remote.revoke(p.session.id, 'signed out on the phone', { type: 'human', id: 'owner' });
    reply.header('set-cookie', `${d.remote.cookieName()}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${d.remote.cookieName().startsWith('__Host-') ? '; Secure' : ''}`);
    return { ok: true };
  });

  // ---- notifications -----------------------------------------------------------------------------
  app.get('/api/notifications', async (req) => { void req; return { notifications: d.notifications.list(100), status: remotePrincipal(req) ? undefined : d.notifications.status() }; });
  app.post('/api/notifications/:id/ack', async (req: R<unknown, { id: string }>) => { d.notifications.ack(req.params.id); return { ok: true }; });
  app.post('/api/notifications/config', async (req: R<Record<string, unknown>>) => { local(req); d.notifications.configure(req.body ?? {}); return d.notifications.status(); });
  app.post('/api/notifications/test', async (req) => { local(req); return { notification: await d.notifications.sendTest(), status: d.notifications.status() }; });
  app.post('/api/notifications/endpoints/:channel/activate', async (req: R<unknown, { channel: string }>) => {
    local(req);
    if (req.params.channel !== 'webpush' && req.params.channel !== 'chat') throw new CommandError('Unknown channel', 404);
    return { decision: d.notifications.requestEndpointActivation(req.params.channel) };
  });
  app.post('/api/notifications/:id/deliveries/:channel/request', async (req: R<unknown, { id: string; channel: string }>) => {
    local(req);
    if (req.params.channel !== 'webpush' && req.params.channel !== 'chat') throw new CommandError('Unknown channel', 404);
    return { decision: d.notifications.requestDelivery(req.params.id, req.params.channel) };
  });

  // ---- Brief & Reports, Timeline -------------------------------------------------------------------
  type Q = Record<string, string | undefined>;
  const reportView = (req: FastifyRequest) => {
    const p = remotePrincipal(req);
    return p ? { state: d.remote.projectState(p.scopes), events: phoneReportEvents(d, d.reports.events(), p.scopes) } : null;
  };
  const brief = (req: R<unknown, Record<string, string>, Q>) => {
    const v = reportView(req);
    return v ? buildBrief(v.state, v.events, d.reports.filter(req.query), d.nowIso()) : d.reports.brief(req.query);
  };
  const morning = (req: R<unknown, Record<string, string>, Q>) => {
    const v = reportView(req);
    if (!v) return d.reports.morning(req.query);
    const f = d.reports.filter(req.query), to = f.to ?? d.nowIso(), from = f.from ?? new Date(Date.parse(to) - 24 * 3_600_000).toISOString();
    return buildMorningReport(v.state, v.events, { from, to, filter: { issue: f.issue, agent: f.agent } }, d.nowIso());
  };
  app.get('/api/reports/brief', async (req: R<unknown, Record<string, string>, Q>) => brief(req));
  app.get('/api/reports/timeline', async (req: R<unknown, Record<string, string>, Q>) => {
    const v = reportView(req);
    if (!v) return d.reports.timeline(req.query);
    const before = Number(req.query.before), limit = Math.max(1, Math.min(Number(req.query.limit ?? 100) || 100, 500));
    return buildTimeline(v.state, v.events, d.reports.filter(req.query), { limit, beforeSeq: Number.isSafeInteger(before) && before > 0 ? before : null });
  });
  app.get('/api/reports/morning', async (req: R<unknown, Record<string, string>, Q>) => morning(req));
  app.get('/api/reports/standup', async (req: R<unknown, Record<string, string>, Q>, reply) => {
    const report = morning(req), r = { report, markdown: renderStandupMarkdown(report, brief(req)) };
    if (req.query.format === 'md') return reply.type('text/markdown; charset=utf-8').header('content-disposition', 'attachment; filename="standup.md"').send(r.markdown);
    return r;
  });

  // ---- context-quality benchmark (Mac only) ------------------------------------------------------------
  app.get('/api/benchmark/context', async (req) => { local(req); return { latest: d.benchmarks.latest(), running: d.benchmarks.running }; });
  app.post('/api/benchmark/context/run', async (req) => {
    local(req);
    // Uses only the Graphify binary already configured or discovered for this project; the request cannot name one.
    return { result: await d.benchmarks.run({}) };
  });
}
