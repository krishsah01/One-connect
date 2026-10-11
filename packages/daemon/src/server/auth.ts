// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Local (same-machine) authentication: the install token, single-use sign-in codes, browser
// sessions and single-use WebSocket tickets for the desktop shell. Remote phones never use any
// of these; they are authenticated only by phone/gate.ts.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { writePrivate } from '../paths.ts';
import type { EventStore } from '../store/eventStore.ts';
import { sha256 } from '../util/hash.ts';

export const SESSION_COOKIE = 'acc_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const TICKET_TTL_MS = 60_000;
const SESSION_PREFIX = 'session:';

export function loadOrCreateInstallToken(file: string): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* create */
  }
  const t = randomBytes(32).toString('hex');
  writePrivate(file, t);
  return t;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

/** Expiring single-use secrets (sign-in codes, socket tickets), purged as new ones are issued. */
class SingleUseTokens {
  private readonly expiries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly bytes: number;

  constructor(ttlMs: number, bytes: number) {
    this.ttlMs = ttlMs;
    this.bytes = bytes;
  }

  issue(): string {
    const now = Date.now();
    for (const [token, expiry] of this.expiries) if (expiry < now) this.expiries.delete(token);
    const token = randomBytes(this.bytes).toString('hex');
    this.expiries.set(token, now + this.ttlMs);
    return token;
  }

  /** True once for a live token; the token is spent either way. */
  redeem(token: string): boolean {
    const expiry = this.expiries.get(token);
    this.expiries.delete(token);
    return expiry !== undefined && expiry >= Date.now();
  }
}

export class LocalAuth {
  readonly installToken: string;
  private readonly store: EventStore;
  private readonly codes = new SingleUseTokens(CODE_TTL_MS, 16);
  private readonly tickets = new SingleUseTokens(TICKET_TTL_MS, 32);

  constructor(store: EventStore, installTokenFile: string) {
    this.store = store;
    this.installToken = loadOrCreateInstallToken(installTokenFile);
  }

  /** A one-time sign-in code for `acc open` (valid two minutes). */
  issueCode(): string {
    return this.codes.issue();
  }

  issueTicket(): string {
    return this.tickets.issue();
  }

  redeemTicket(ticket: string): boolean {
    return this.tickets.redeem(ticket);
  }

  /** Exchange a sign-in code for a new session id, or null if the code is unknown, used or expired. */
  redeemCode(code: string): string | null {
    if (!this.codes.redeem(code)) return null;
    const session = randomBytes(32).toString('hex');
    this.store.kvSet(`${SESSION_PREFIX}${sha256(session)}`, new Date().toISOString());
    return session;
  }

  /** Install token (CLI, MCP bridge setup) or a live browser session. */
  isAuthenticated(req: FastifyRequest): boolean {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7), this.installToken)) return true;
    const session = readCookie(req, SESSION_COOKIE);
    if (!session) return false;
    const key = `${SESSION_PREFIX}${sha256(session)}`;
    const created = this.store.kvGet(key);
    if (!created) return false;
    // The cookie's Max-Age is advisory; the server enforces the same lifetime.
    if (!(Date.parse(created) + SESSION_TTL_MS > Date.now())) {
      this.store.kvDelete(key);
      return false;
    }
    return true;
  }

  sessionCookie(session: string): string {
    return `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
  }
}

/** Sign-in, identity and socket-ticket routes. Reached only after the local Host/Origin checks. */
export function registerAuthRoutes(app: FastifyInstance, auth: LocalAuth, projectName: () => string): void {
  app.get('/auth', async (req: FastifyRequest<{ Querystring: { code?: string } }>, reply: FastifyReply) => {
    const session = auth.redeemCode(req.query.code ?? '');
    if (!session) return reply.code(401).type('text/plain').send('This sign-in link expired or was already used. Run `acc open` again.');
    reply.header('set-cookie', auth.sessionCookie(session));
    return reply.redirect('/');
  });
  app.post('/api/auth/code', async () => ({ code: auth.issueCode() }));
  // Paired phones do not have this route; their identity comes from /api/remote/session.
  app.get('/api/auth/identity', async () => ({ mode: 'local' as const, project: projectName() }));
  app.post('/api/auth/ws-ticket', async () => ({ ticket: auth.issueTicket() }));
}
