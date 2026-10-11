// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Local HTTP + WebSocket API. Binds 127.0.0.1 only. Every request needs a session cookie (from a
// one-time code), the install token, or (MCP bridge only) a per-run token. Host and Origin are
// checked against DNS rebinding and cross-site requests.
//
// This file is the security boundary and the composition of route modules. Each domain's routes
// live in their own module (one file per domain), listed once in ROUTE_MODULES below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { CommandError } from '../errors.ts';
import type { Daemon } from '../daemon.ts';
import { VERSION } from '../version.ts';
import { remoteGate } from '../phone/gate.ts';
import { registerPhoneHooks, registerPhoneRoutes } from '../phone/routes.ts';
import { LocalAuth, registerAuthRoutes } from './auth.ts';
import { registerEventSocket } from './eventSocket.ts';
import type { RouteModule } from './route.ts';
import { registerAgentRoutes } from './agentRoutes.ts';
import { registerCanvasRoutes } from './canvasRoutes.ts';
import { registerConnectionRoutes } from './connectionRoutes.ts';
import { registerContextRoutes } from './contextRoutes.ts';
import { registerControlRoutes } from './controlRoutes.ts';
import { registerDesignerRoutes } from './designerRoutes.ts';
import { registerDictionaryRoutes } from './dictionaryRoutes.ts';
import { registerHarnessRoutes } from './harnessRoutes.ts';
import { registerLibraryRoutes } from './libraryRoutes.ts';
import { registerLocalModelRoutes } from './localModelRoutes.ts';
import { registerMarketplaceRoutes } from './marketplaceRoutes.ts';
import { registerMcpRoutes, RUN_TOKEN_HEADER } from './mcpRoutes.ts';
import { registerProjectRoutes } from './projectRoutes.ts';
import { registerReleaseRoutes } from './releaseRoutes.ts';
import { registerRunRoutes } from './runRoutes.ts';
import { registerStateRoutes } from './stateRoutes.ts';
import { registerWorkflowLinkRoutes } from './workflowLinkRoutes.ts';
import { registerWorkflowRoutes } from './workflowRoutes.ts';
import { registerWorkRoutes } from './workRoutes.ts';

export { loadOrCreateInstallToken } from './auth.ts';

const WEB_DIST = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/** Every authenticated API surface. Adding a domain means adding its module here. */
const ROUTE_MODULES: readonly RouteModule[] = [
  registerStateRoutes,
  registerWorkRoutes,
  registerAgentRoutes,
  registerRunRoutes,
  registerControlRoutes,
  registerWorkflowRoutes,
  registerReleaseRoutes,
  registerConnectionRoutes,
  registerContextRoutes,
  registerMcpRoutes,
  registerWorkflowLinkRoutes,
  registerMarketplaceRoutes,
  registerLibraryRoutes,
  registerDesignerRoutes,
  registerCanvasRoutes,
  registerLocalModelRoutes,
  registerHarnessRoutes,
  registerDictionaryRoutes,
  registerPhoneRoutes,
  registerProjectRoutes,
];

export interface ServerOptions {
  port: number;
  host?: string;
  /** Extra allowed Origins (Vite dev server). */
  devOrigins?: string[];
}

export async function createServer(d: Daemon, o: ServerOptions): Promise<{ app: FastifyInstance; url: string; installToken: string; issueCode: () => string }> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, forceCloseConnections: true });
  // The plugin must mark upgrade requests before auth can reject them, so its onResponse
  // hook destroys failed handshake sockets rather than leaving daemon shutdown waiting.
  await app.register(fastifyWebsocket);
  const auth = new LocalAuth(d.store, d.paths.installToken);
  const host = o.host ?? '127.0.0.1';
  let port = o.port;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(process.env.ACC_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [])]);
  const allowedOrigins = () => new Set([...[...allowedHosts()].map((h) => `http://${h}`), ...(o.devOrigins ?? [])]);

  app.addHook('onRequest', async (req, reply) => {
    const h = req.headers.host ?? '';
    // A Host that names a live private tunnel is authenticated ONLY by a paired phone session (phone/gate.ts).
    if (d.remote.isRemoteHost(h)) return remoteGate(d, req, reply);
    if (!allowedHosts().has(h)) return reply.code(421).send({ error: `host ${h} not allowed` });
    const ticket = req.url.startsWith('/ws?') ? new URL(req.url, 'http://localhost').searchParams.get('ticket') : null;
    const desktopWs = ticket !== null && auth.redeemTicket(ticket);
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin) && !desktopWs) return reply.code(403).send({ error: 'cross-origin request refused' });
    const url = req.url.split('?')[0];
    if (url === '/auth' || url === '/api/health') return;
    if (url.startsWith('/api/mcp/')) {
      const t = req.headers[RUN_TOKEN_HEADER];
      if (typeof t === 'string' && d.runs.runForToken(t)) return;
      return reply.code(401).send({ error: 'run token required' });
    }
    if (url.startsWith('/api/') || url === '/ws') {
      if (!auth.isAuthenticated(req) && !desktopWs) {
        if (url === '/ws') reply.header('connection', 'close');
        return reply.code(401).send({ error: 'not signed in: run `acc open`' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !origin && !req.headers.authorization) return reply.code(403).send({ error: 'missing Origin' });
    }
  });

  registerPhoneHooks(app, d);

  app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, _req, reply) => {
    const status = err instanceof CommandError ? err.status : (err.statusCode ?? 500);
    reply.code(status).send({ error: err.message, ...(err instanceof CommandError && err.issues ? { issues: err.issues } : {}) });
  });

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));
  registerAuthRoutes(app, auth, () => d.config.project.name);
  app.post('/api/desktop/shutdown', async () => {
    if (d.baseEnv().ACC_DESKTOP !== '1') throw new CommandError('Desktop-owned daemon required', 403);
    setTimeout(() => d.bus.emit('shutdown'), 100);
    return { ok: true };
  });

  for (const register of ROUTE_MODULES) await register(app, d);
  registerEventSocket(app, d);
  await serveWebUi(app);

  const addr = await app.listen({ port, host });
  port = Number(new URL(addr).port);
  const url = `http://127.0.0.1:${port}`;
  d.url = url;
  return { app, url, installToken: auth.installToken, issueCode: () => auth.issueCode() };
}

async function serveWebUi(app: FastifyInstance): Promise<void> {
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><title>One Connect</title><p>UI not built yet. Run <code>pnpm build</code> or use <code>pnpm dev:web</code>.</p>'));
    return;
  }
  // wildcard: serve whatever is in dist now, so a rebuilt UI works without restarting the daemon.
  await app.register(fastifyStatic, { root: WEB_DIST, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not found' });
  });
}
