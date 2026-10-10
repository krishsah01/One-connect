// SPDX-License-Identifier: Apache-2.0
// The only place remote (tunnelled) requests are authenticated. A request whose Host is a live
// tunnel name is NEVER authenticated by the Mac's sign-in cookie, the install token or a run
// token: it needs a paired phone session, an exact Origin, a CSRF header for changes, and a route
// its granted scopes allow. Everything else is refused and audited.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { remoteDecisionAccess, remoteRouteDecision } from '@acc/core';
import type { Daemon } from '../daemon.ts';
import type { RemotePrincipal } from './remote.ts';

const principals = new WeakMap<object, RemotePrincipal>();
export const remotePrincipal = (req: FastifyRequest): RemotePrincipal | null => principals.get(req.raw) ?? null;

function parseCookie(raw: string | undefined, name: string): string | null {
  for (const part of (raw ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

function same(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function remoteGate(d: Daemon, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const url = req.url.split('?')[0];
  const method = req.method;
  const mutating = method !== 'GET' && method !== 'HEAD';
  const expected = d.remote.origin();
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-content-type-options', 'nosniff');
  const deny = (status: number, error: string, sessionId: string | null = null) => {
    d.remote.denied(sessionId, method, url, error);
    reply.header('cache-control', 'no-store');
    return reply.code(status).send({ error });
  };
  const origin = req.headers.origin;

  // Static UI (shell, assets, the /pair page). Sign-in links are never redeemable over a tunnel.
  if (!url.startsWith('/api/') && url !== '/ws') {
    if (url === '/auth') return deny(403, 'Sign-in links are not accepted over the tunnel.');
    if (mutating) return deny(405, 'Method not allowed.');
    return undefined;
  }
  reply.header('cache-control', 'no-store');
  if (url === '/api/health') return undefined;

  if (url === '/api/remote/pair') {
    if (method !== 'POST') return deny(405, 'Method not allowed.');
    if (!expected || origin !== expected) return deny(403, 'Cross-origin pairing request refused.');
    return undefined;
  }

  const auth = d.remote.authenticate(parseCookie(req.headers.cookie, d.remote.cookieName()));
  if (!auth.ok) return deny(auth.status, auth.error);
  const p = auth.principal;
  if (origin && origin !== expected) return deny(403, 'Cross-origin request refused.', p.session.id);
  if ((mutating || url === '/ws') && origin !== expected) return deny(403, 'A matching Origin is required.', p.session.id);
  if (mutating && !same(req.headers['x-acc-csrf'] as string | undefined, p.csrf)) return deny(403, 'CSRF token missing or wrong. Reload the page.', p.session.id);
  // The body is not parsed yet: the kill-switch body rule is re-checked with the real body in remotePreHandler.
  const decision = remoteRouteDecision(method, req.url, p.scopes, { engaged: true });
  if (!decision.allow) return deny(403, decision.reason, p.session.id);
  principals.set(req.raw, p);
  return undefined;
}

/** Checks that need the parsed body or the target record; runs after parsing for remote sessions only. */
export async function remotePreHandler(d: Daemon, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const initial = remotePrincipal(req);
  if (!initial) return undefined;
  // Scope/revocation can change while a request body is being parsed.
  const auth = d.remote.authenticate(parseCookie(req.headers.cookie, d.remote.cookieName()));
  if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
  const p = auth.principal;
  principals.set(req.raw, p);
  const url = req.url.split('?')[0];
  const body = (req.body ?? {}) as Record<string, unknown>;
  const refuse = (error: string) => { d.remote.denied(p.session.id, req.method, url, error); return reply.code(403).send({ error }); };
  const decision = remoteRouteDecision(req.method, req.url, p.scopes, body);
  if (!decision.allow) return refuse(decision.reason);
  const m = /^\/api\/decisions\/([^/]+)\/(prepare|answer|history)$/.exec(url);
  if (m) {
    let id: string;
    try { id = decodeURIComponent(m[1]); } catch { return refuse('Invalid Decision id.'); }
    const dec = d.state.decisions[id];
    if (p.session.project !== d.remote.project) return refuse('This session belongs to a different project.');
    if (dec) {
      const target = d.remote.isRemoteDecision(id) ? { kind: 'remote' as const } : d.notifications.isEndpointDecision(id) ? { kind: 'notification' as const } : dec;
      const access = remoteDecisionAccess(target, p.scopes, d.notifications.isDeliveryDecision(id));
      if (!access.allow) return refuse(access.reason);
      const positive = target.kind === 'settings' ? 'save' : target.kind === 'merge' ? 'merge' : 'approve';
      if (m[2] !== 'history' && body.answer === positive && ['merge', 'docker', 'connector', 'remote', 'notification', 'cost', 'settings'].includes(target.kind ?? '') && !d.decisions.needsConfirmation(dec, positive)) return refuse('This action has no second-confirmation binding. Request a corrected Decision on the Mac.');
    }
    body.channel = 'phone';
  }
  if (/^\/api\/approvals\/[^/]+\/resolve$/.test(url)) body.channel = 'phone';
  return undefined;
}
