// SPDX-License-Identifier: Apache-2.0
// Local HTTP + WebSocket API. Binds 127.0.0.1 only. Every request needs a session cookie (from a
// one-time code), the install token, or (MCP bridge only) a per-run token. Host and Origin are
// checked against DNS rebinding and cross-site requests.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { EventEnvelope, RuleName } from '@acc/core';
import { HUMAN, reviewsForItem, RULE_NAMES } from '@acc/core';
import { changedFiles, diffPatch } from '../adapters/vcs/git.ts';
import { CommandError, type Daemon } from '../daemon.ts';
import { writePrivate } from '../paths.ts';
import { onboardingReport } from '../onboarding.ts';
import { registerProjectRoutes } from './project-routes.ts';
import { registerLibraryRoutes } from './libraryRoutes.ts';
import { registerDesignerRoutes } from './designerRoutes.ts';
import { registerHarnessRoutes } from './harnessRoutes.ts';
import { registerDictionaryRoutes } from './dictionaryRoutes.ts';
import { remoteGate, remotePrincipal } from '../phone/gate.ts';
import { registerPhoneHooks, registerPhoneRoutes } from '../phone/routes.ts';
import { deleteSecret, hasSecret, providerSecretFor, SECRET_NAMES, setSecret, type SecretName } from '../secrets.ts';

const WEB_DIST = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
const SESSION_COOKIE = 'acc_session';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

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

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

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
  const installToken = loadOrCreateInstallToken(d.paths.installToken);
  const codes = new Map<string, number>();
  const tickets = new Map<string, number>();
  const host = o.host ?? '127.0.0.1';
  let port = o.port;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(process.env.ACC_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [])]);
  const allowedOrigins = () => new Set([...[...allowedHosts()].map((h) => `http://${h}`), ...(o.devOrigins ?? [])]);

  const issueCode = () => {
    const c = randomBytes(16).toString('hex');
    codes.set(c, Date.now() + 2 * 60_000);
    return c;
  };

  const isAuthed = (req: FastifyRequest): boolean => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && safeEq(auth.slice(7), installToken)) return true;
    const s = cookie(req, SESSION_COOKIE);
    return Boolean(s && d.store.kvGet(`session:${sha(s)}`));
  };

  app.addHook('onRequest', async (req, reply) => {
    const h = req.headers.host ?? '';
    // A Host that names a live private tunnel is authenticated ONLY by a paired phone session (phone/gate.ts).
    if (d.remote.isRemoteHost(h)) return remoteGate(d, req, reply);
    if (!allowedHosts().has(h)) return reply.code(421).send({ error: `host ${h} not allowed` });
    const ticket = req.url.startsWith('/ws?') ? new URL(req.url, 'http://localhost').searchParams.get('ticket') : null;
    const desktopWs = ticket !== null && (tickets.get(ticket) ?? 0) > Date.now();
    if (ticket) tickets.delete(ticket);
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin) && !desktopWs) return reply.code(403).send({ error: 'cross-origin request refused' });
    const url = req.url.split('?')[0];
    if (url === '/auth' || url === '/api/health') return;
    if (url.startsWith('/api/mcp/')) {
      const t = req.headers['x-acc-run-token'];
      if (typeof t === 'string' && d.runs.runForToken(t)) return;
      return reply.code(401).send({ error: 'run token required' });
    }
    if (url.startsWith('/api/') || url === '/ws') {
      if (!isAuthed(req) && !desktopWs) {
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

  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));

  app.get('/auth', async (req: FastifyRequest<{ Querystring: { code?: string } }>, reply: FastifyReply) => {
    const code = req.query.code ?? '';
    const exp = codes.get(code);
    codes.delete(code);
    if (!exp || exp < Date.now()) return reply.code(401).type('text/plain').send('This sign-in link expired or was already used. Run `acc open` again.');
    const session = randomBytes(32).toString('hex');
    d.store.kvSet(`session:${sha(session)}`, new Date().toISOString());
    reply.header('set-cookie', `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    return reply.redirect('/');
  });

  app.post('/api/auth/code', async () => ({ code: issueCode() }));
  // Reached only after the local Host/Origin/install-token or session checks above.
  // Paired phones do not have this route; their identity comes from /api/remote/session.
  app.get('/api/auth/identity', async () => ({ mode: 'local' as const, project: d.config.project.name }));
  app.post('/api/auth/ws-ticket', async () => {
    for (const [key, expiry] of tickets) if (expiry < Date.now()) tickets.delete(key);
    const ticket = randomBytes(32).toString('hex');
    tickets.set(ticket, Date.now() + 60_000);
    return { ticket };
  });
  app.post('/api/desktop/shutdown', async () => {
    if (d.baseEnv().ACC_DESKTOP !== '1') throw new CommandError('Desktop-owned daemon required', 403);
    setTimeout(() => d.bus.emit('shutdown'), 100);
    return { ok: true };
  });

  // ---- state & reads -----------------------------------------------------------------------
  app.get('/api/state', async () => ({ seq: d.state.seq, state: d.state, demo: d.baseEnv().ACC_DEMO_FIXTURES === '1', tracker: { type: d.tracker.type, target: d.tracker.target, live: d.tracker.live }, outbox: d.store.outboxStats() }));
  app.get('/api/agents/:id/subscription-safety', async (req: FastifyRequest<{ Params: { id: string } }>) => d.subscriptionSafety.status(req.params.id));
  app.post('/api/agents/:id/subscription-safety', async (req: FastifyRequest<{ Params: { id: string }; Body: { paidModesOff?: boolean } }>) => d.subscriptionSafety.confirm(req.params.id, req.body?.paidModesOff === true));

  app.get('/api/runs/:id/events', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>) => {
    if (!d.state.runs[req.params.id]) throw new CommandError('unknown run', 404);
    const since = Number(req.query.since ?? 0), limit = Number(req.query.limit ?? 1000);
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new CommandError('Invalid event pagination');
    return { events: d.store.list({ runId: req.params.id, afterSeq: since, limit: Math.min(limit, 5000) }) };
  });

  app.get('/api/runs/:id/log', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { stream?: string } }>, reply) => {
    if (!d.state.runs[req.params.id]) throw new CommandError('unknown run', 404);
    const f = path.join(d.runs.supervisor.runDir(req.params.id), req.query.stream === 'stderr' ? 'stderr.log' : 'stdout.jsonl');
    return reply.type('text/plain').send(fs.existsSync(f) ? fs.createReadStream(f) : '');
  });

  app.get('/api/runs/:id/log/page', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { stream?: string; offset?: string } }>) => {
    if (!d.state.runs[req.params.id]) throw new CommandError('unknown run', 404);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new CommandError('Invalid log offset');
    const f = path.join(d.runs.supervisor.runDir(req.params.id), req.query.stream === 'stderr' ? 'stderr.log' : 'stdout.jsonl');
    if (!fs.existsSync(f)) return { text: '', offset: 0, nextOffset: 0, totalBytes: 0 };
    const fd = fs.openSync(f, 'r');
    try {
      const totalBytes = fs.fstatSync(fd).size;
      const start = Math.min(offset, totalBytes);
      const buf = Buffer.alloc(Math.min(128 * 1024, totalBytes - start));
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      const decoder = new StringDecoder('utf8');
      const text = decoder.write(buf.subarray(0, n)) + (start + n === totalBytes ? decoder.end() : '');
      return { text, offset: start, nextOffset: Math.min(totalBytes, start + Buffer.byteLength(text)), totalBytes };
    } finally { fs.closeSync(fd); }
  });

  app.get('/api/assignments/:id/diff', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const a = d.state.assignments[req.params.id];
    if (!a) throw new CommandError('unknown assignment', 404);
    if (!a.worktree || !a.baseSha || !fs.existsSync(a.worktree)) return { files: [], patch: '', truncated: false };
    const [files, p] = await Promise.all([changedFiles(a.worktree, a.baseSha), diffPatch(a.worktree, a.baseSha)]);
    return { files, ...p };
  });

  app.get('/api/work-items/:id/events', async (req: FastifyRequest<{ Params: { id: string } }>) => ({ events: d.store.list({ workItemId: req.params.id, kind: 'control', limit: 2000 }) }));

  app.get('/api/onboarding', async () => onboardingReport(d));
  app.get('/api/designer',async()=>({skills:d.designer.skills(),design:d.designer.exports()}));
  app.post('/api/designer/system',async(req:FastifyRequest<{Body:{system:unknown;expected?:string|null}}>)=>({revision:d.designer.save(req.body?.system,req.body?.expected??null)}));
  app.post('/api/agents/configure', async (req:FastifyRequest<{Body:{config:unknown;expected?:unknown}}>) => ({agent:d.saveAgent(req.body?.config,req.body?.expected??null)}));
  app.post('/api/agents/cost-approval', async (req:FastifyRequest<{Body:{config:unknown;expected?:unknown}}>) => d.agentCosts.request(req.body?.config,req.body?.expected??null));
  app.get('/api/settings', async () => d.settings.read());
  app.post('/api/settings/request', async (req:FastifyRequest<{Body:{settings:import('../settings.ts').SettingsDraft;expected:string}}>) => ({decision:d.settings.request(req.body?.settings,req.body?.expected)}));

  registerLibraryRoutes(app, d);
  registerDesignerRoutes(app, d);
  registerHarnessRoutes(app, d);
  registerDictionaryRoutes(app, d);
  registerPhoneRoutes(app, d);

  app.get('/api/team', async () => d.team.snapshot());
  app.get('/api/team/messages', async (req: FastifyRequest<{ Querystring: { agentId?: string; after?: string; limit?: string } }>) => d.team.list(req.query.agentId ?? null, { after: Number(req.query.after ?? 0), limit: Number(req.query.limit ?? 20) }));
  app.post('/api/team/messages', async (req: FastifyRequest<{ Body: import('../team.ts').SendTeamMessage }>) => ({ message: d.team.send(req.body, HUMAN) }));

  app.get('/api/docker', async () => d.docker.list());
  app.get('/api/docker/:id/logs', async (req: FastifyRequest<{ Params: { id: string } }>) => d.docker.logs(req.params.id));
  app.post('/api/docker/:id/request', async (req: FastifyRequest<{ Params: { id: string }; Body: { action: string } }>) => d.docker.request(req.params.id, req.body.action));
  app.post('/api/docker/decisions/:id/resolve', async (req: FastifyRequest<{ Params: { id: string }; Body: { answer: string; nonce?: string } }>) => d.docker.resolve(req.params.id, req.body.answer, { nonce: req.body.nonce }));

  await registerProjectRoutes(app, d);

  app.get('/api/imports/sources', async () => ({ sources: d.imports.sources() }));
  app.post('/api/imports/preview', async (req: FastifyRequest<{ Body: { sourceId: string; query?: string } }>) => d.imports.preview(req.body.sourceId, req.body.query));
  app.post('/api/imports/commit', async (req: FastifyRequest<{ Body: { token: string; ids: string[] } }>) => d.imports.import(req.body.token, req.body.ids));

  // ---- commands ----------------------------------------------------------------------------
  type B<T> = FastifyRequest<{ Body: T; Params: { id: string } }>;
  app.post('/api/issues', async (req: B<{ title: string; description?: string; acceptance?: string[]; labels?: string[]; priority?: number }>) => ({ item: d.createIssue(req.body ?? ({} as never), HUMAN) }));
  app.post('/api/assignments', async (req: B<{ workItemId: string; agentId: string; allowedPaths?: string[]; scope?: string; requiredChecks?: string[]; askHumanIf?: string[]; model?: string }>) => {
    const a = d.createAssignment(req.body);
    return { assignment: a, preflight: d.preflight(a.id) };
  });
  app.patch('/api/assignments/:id', async (req: B<Record<string, unknown>>) => {
    d.updateAssignment(req.params.id, req.body as never);
    return { assignment: d.state.assignments[req.params.id], preflight: d.preflight(req.params.id) };
  });
  app.post('/api/quick-task', async (req: FastifyRequest<{ Body: { agentId: string; title: string; description?: string; allowedPaths?: string[] } }>) => {
    const b = req.body ?? ({} as never);
    if (!b.title?.trim()) throw new CommandError('title is required');
    return d.quickTask({ agentId: String(b.agentId), title: b.title.trim(), description: b.description, allowedPaths: b.allowedPaths });
  });
  app.post('/api/assignments/:id/preflight', async (req: B<unknown>) => ({ preflight: d.preflight(req.params.id) }));
  app.post('/api/assignments/:id/dispatch', async (req: B<{ position?: 'now' | 'next' }>) => d.dispatch(req.params.id, { position: req.body?.position }));
  app.post('/api/assignments/:id/reassign', async (req: B<{ agentId: string }>) => {
    d.reassign(req.params.id, req.body.agentId);
    return { ok: true };
  });
  app.post('/api/assignments/:id/cancel', async (req: B<unknown>) => {
    d.cancelAssignment(req.params.id);
    return { ok: true };
  });
  app.post('/api/agents/:id/queue', async (req: B<{ next: string[] }>) => {
    d.setQueue(req.params.id, req.body.next ?? []);
    return { ok: true };
  });
  app.post('/api/agents/:id/probe', async (req: B<unknown>) => {
    await d.probe(req.params.id);
    return { agent: d.state.agents[req.params.id] };
  });
  app.post('/api/agents/:id/model', async (req: B<{ model: string }>) => {
    d.swapModel(req.params.id, String(req.body.model));
    return { ok: true };
  });
  app.post('/api/agents/:id/resume', async (req: B<unknown>) => {
    d.resumeAgent(req.params.id);
    return { ok: true };
  });
  app.post('/api/runs/:id/stop', async (req: B<{ reason?: string }>) => {
    await d.runs.stop(req.params.id, req.body?.reason ?? 'stopped by owner');
    return { ok: true };
  });
  app.post('/api/runs/:id/pause', async (req: B<unknown>) => {
    await d.runs.pause(req.params.id);
    return { ok: true };
  });
  app.post('/api/runs/:id/resume', async (req: B<unknown>) => ({ runId: await d.runs.resume(req.params.id) }));
  app.post('/api/runs/:id/send', async (req: B<{ message: string }>) => d.runs.send(req.params.id, String(req.body?.message ?? '')));
  app.post('/api/runs/:id/nudge', async (req: B<unknown>) => d.runs.nudge(req.params.id));
  app.post('/api/runs/:id/relay', async (req: B<{ text: string }>) => ({ handoff: await d.runs.relayResult(req.params.id, String(req.body?.text ?? '')) }));
  app.post('/api/runs/:id/accept-skeleton', async (req: B<unknown>) => {
    d.runs.acceptSkeleton(req.params.id);
    return { ok: true };
  });
  app.post('/api/approvals/:id/resolve', async (req: B<{ decision: string; channel?: string }>) => {
    d.resolveApproval(req.params.id, String(req.body?.decision ?? ''), req.body?.channel ?? 'web');
    return { ok: true };
  });
  app.post('/api/alerts/:id/resolve', async (req: B<{ resolution?: string }>) => {
    d.resolveAlert(req.params.id, req.body?.resolution ?? 'dismissed');
    return { ok: true };
  });
  app.post('/api/rules/:id', async (req: B<{ enabled: boolean }>) => {
    if (!(RULE_NAMES as readonly string[]).includes(req.params.id)) throw new CommandError('unknown rule', 404);
    d.setRule(req.params.id as RuleName, Boolean(req.body?.enabled));
    return { ok: true };
  });
  // ---- workflows, reviews, merges, decisions --------------------------------------------
  const settled = async <T>(p: Promise<T>): Promise<T> => {
    const r = await p;
    await d.workflows.idle();
    return r;
  };
  app.get('/api/workflows', async () => ({ workflows: d.workflows.list() }));
  app.post('/api/workflows', async (req: FastifyRequest<{ Body: { id?: string | null; definition: unknown; expectedVersion?: number | null } }>) => ({ workflow: d.workflows.save({ id: req.body?.id ?? null, definition: req.body?.definition, expectedVersion: req.body?.expectedVersion ?? null }) }));
  app.post('/api/workflows/validate', async (req: FastifyRequest<{ Body: { id?: string | null; definition: unknown; forStart?: boolean } }>) => d.workflows.validate(req.body?.definition, { workflowId: req.body?.id ?? null, forStart: Boolean(req.body?.forStart) }));
  app.post('/api/workflows/:id/:action', async (req: FastifyRequest<{ Params: { id: string; action: string } }>) => {
    const { id, action } = req.params;
    if (action === 'start') return { workflow: await settled(d.workflows.launch(id)) };
    if (action === 'pause') return { workflow: await settled(d.workflows.pause(id)) };
    if (action === 'resume') return { workflow: await settled(d.workflows.resume(id)) };
    if (action === 'cancel') return { workflow: await settled(d.workflows.cancel(id)) };
    throw new CommandError(`unknown workflow action ${action}`, 404);
  });
  app.post('/api/workflows/:id/tasks/:taskId/retry', async (req: FastifyRequest<{ Params: { id: string; taskId: string } }>) => ({ workflow: await settled(d.workflows.retry(req.params.id, req.params.taskId)) }));

  app.get('/api/work-items/:id/reviews', async (req: B<unknown>) => ({ reviews: reviewsForItem(d.state, req.params.id) }));
  app.post('/api/work-items/:id/review-request', async (req: B<{ reviewerAgentId: string; targetSha?: string; position?: 'now' | 'next' }>) => {
    const assignment = await d.reviewMerge.createReviewAssignment({ workItemId: req.params.id, reviewerAgentId: String(req.body?.reviewerAgentId ?? ''), targetSha: req.body?.targetSha ?? null });
    return { assignment, ...(await d.dispatch(assignment.id, { position: req.body?.position })) };
  });
  app.post('/api/work-items/:id/reviews', async (req: B<{ verdict: string; sha?: string; summary?: string; findings?: import('../reviewMerge.ts').FindingInput[] }>) => ({ review: await d.reviewMerge.recordHumanReview(req.params.id, req.body ?? ({} as never)) }));
  app.get('/api/work-items/:id/merge-gates', async (req: B<unknown>) => d.reviewMerge.gatesFor(req.params.id));
  app.post('/api/work-items/:id/merge-request', async (req: B<unknown>) => d.reviewMerge.requestMerge(req.params.id));
  app.post('/api/work-items/:id/acceptance', async (req: B<{ summary: string; env?: 'local' | 'ci' | 'production' | 'device' }>) => d.reviewMerge.recordAcceptance(req.params.id, req.body ?? ({} as never)));
  app.get('/api/decisions/:id/history', async (req: B<unknown>) => ({ decision: d.state.decisions[req.params.id] ?? null, events: d.decisions.history(req.params.id) }));
  app.post('/api/decisions/:id/prepare', async (req: B<{ answer: string }>) => d.decisions.prepare(req.params.id, String(req.body?.answer ?? '')));
  app.post('/api/decisions/:id/answer', async (req: B<{ answer: string; nonce?: string; channel?: string }>) => d.decisions.respond(req.params.id, String(req.body?.answer ?? ''), { nonce: req.body?.nonce ?? null, channel: req.body?.channel ?? 'web' }));
  app.get('/api/release/plans', async () => ({ plans: d.releasePlans.list(), codeHost: d.state.codeHost, infra: d.state.infra }));
  app.post('/api/release/plans', async (req: B<{ name?: string; workItemId?: string | null }>) => ({ plan: d.releasePlans.create(req.body ?? {}) }));
  app.post('/api/release/plans/:id', async (req: B<{ name?: string; workItemId?: string | null; steps?: { id?: string; kind: import('@acc/core').ReleaseStepKind; title: string; owner: string; command: string; check: string; rollback: string; rollbackCheck?: string; target?: string; environment?: string }[] }>) => ({ plan: d.releasePlans.update(req.params.id, req.body ?? {}) }));
  app.post('/api/release/plans/:id/cancel', async (req: B<unknown>) => ({ plan: d.releasePlans.cancel(req.params.id) }));
  app.post('/api/release/plans/:id/steps/:stepId/decision', async (req: FastifyRequest<{ Params: { id: string; stepId: string } }>) => d.releasePlans.requestStep(req.params.id, req.params.stepId));
  app.post('/api/release/plans/:id/steps/:stepId/rollback', async (req: FastifyRequest<{ Params: { id: string; stepId: string } }>) => d.releasePlans.requestRollback(req.params.id, req.params.stepId));
  app.post('/api/release/plans/:id/steps/:stepId/inspect', async (req: FastifyRequest<{ Params: { id: string; stepId: string } }>) => d.releasePlans.requestInspection(req.params.id, req.params.stepId));
  app.post('/api/release/refresh', async () => {
    const codeHost = await d.hosts.refresh();
    const infra = await d.infra.refresh();
    d.findings.maybeAuto();
    return { codeHost, infra };
  });
  app.post('/api/release/findings', async (req: B<{ kind?: string }>) => d.findings.link((req.body?.kind ?? '') as 'ci' | 'unprotected_branch' | 'migration_drift'));
  app.post('/api/release/deliveries', async (req: B<{ headers?: Record<string, string>; body?: string }>) => d.hosts.acceptDelivery(req.body ?? {}));
  app.get('/api/infra/health', async () => ({ health: d.state.infra, codeHost: d.state.codeHost }));
  app.post('/api/merges/:decisionId/execute', async (req: FastifyRequest<{ Params: { decisionId: string } }>) => d.reviewMerge.executeMerge(req.params.decisionId));

  app.post('/api/kill-switch', async (req: FastifyRequest<{ Body: { engaged: boolean } }>) => ({ stopped: await d.setKillSwitch(Boolean(req.body?.engaged)) }));
  app.post('/api/tracker/poll', async () => ({ changed: await d.poller.poll() }));

  // ---- connections (API keys in the Keychain) & egress transparency ----------------------------
  app.get('/api/connections', async () => {
    const out: Record<string, { stored: boolean; usedBy: string[] }> = {};
    for (const name of SECRET_NAMES) {
      out[name] = { stored: await hasSecret(name, d.baseEnv()), usedBy: d.config.agents.filter((a) => providerSecretFor(a)?.secret === name || (name === 'linear' && d.config.tracker.type === 'linear')).map((a) => a.id) };
    }
    return { connections: out, egress: { allowed: d.egress.allowed, recent: d.egress.log.slice(-50) } };
  });
  app.post('/api/connections/:id', async (req: FastifyRequest<{ Params: { id: string }; Body: { key?: string } }>) => {
    const name = req.params.id as SecretName;
    if (!(SECRET_NAMES as readonly string[]).includes(name)) throw new CommandError('unknown connection', 404);
    const key = String(req.body?.key ?? '').trim();
    if (!key) throw new CommandError('key is required');
    await setSecret(name, key);
    d.addSecret(key);
    for (const a of d.config.agents) if (providerSecretFor(a)?.secret === name && a.enabled !== false) void d.probe(a.id).catch(() => undefined);
    return { stored: true };
  });
  app.delete('/api/connections/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const name = req.params.id as SecretName;
    if (!(SECRET_NAMES as readonly string[]).includes(name)) throw new CommandError('unknown connection', 404);
    await deleteSecret(name);
    return { stored: false };
  });

  // ---- shared context (Obsidian vault + graphify) -------------------------------------------
  app.get('/api/context', async () => ({ enabled: d.context.enabled, config: d.context.knowledgeConfig, privateVault:d.context.privateVault, answer:d.context.answer.status, vault: d.context.vault?.status() ?? null, graph: d.context.graph?.status ?? null, docs:d.context.docs?.status() ?? null, brief: d.context.brief() }));
  app.post('/api/context/answer/refresh',async()=>{void d.context.answer.refresh(true);return{accepted:true,status:d.context.answer.status};});
  app.post('/api/context/connect', async (req: FastifyRequest<{ Body: unknown }>) => {
    await d.connectKnowledge(req.body);
    return { connected:true, config:d.config.knowledge, docs:d.context.docs?.status() };
  });
  app.post('/api/context/docs/index', async () => {
    if(!d.context.docs) throw new CommandError('Connect a markdown vault first');
    await d.context.docs.index();
    const status=d.context.docs.status();
    d.commit([{type:'context.docs',actor:HUMAN,data:{status}}]);
    return status;
  });
  app.post('/api/context/docs/ask', async (req: FastifyRequest<{ Body: { query: string } }>) => {
    if(!d.context.docs) throw new CommandError('Connect a markdown vault first');
    const context=d.context;
    const result=context.answer.cite(await context.docs!.ask(String(req.body?.query??'')));
    if(context===d.context && !d.closed) d.commit([{type:'context.docs',actor:HUMAN,data:{status:context.docs!.status()}}]);
    return result;
  });
  app.post('/api/context/sync', async () => ({ written: d.context.flush() }));
  app.post('/api/context/graph/rebuild', async () => {
    await d.context.refreshGraph(true);
    return { graph: d.context.graph?.status ?? null };
  });
  app.post('/api/context/query', async (req: FastifyRequest<{ Body: { query: string; graph?: boolean } }>) => {
    const q = String(req.body?.query ?? '').trim();
    if (!q) throw new CommandError('query is required');
    return d.context.search(q, { graph: req.body?.graph });
  });

  // ---- MCP bridge (per-run token) ----------------------------------------------------------
  app.post('/api/mcp/:id', async (req: B<Record<string, unknown>>) => {
    const token = String(req.headers['x-acc-run-token']);
    return d.mcp.call(token, req.params.id, req.body ?? {});
  });

  // ---- WebSocket ---------------------------------------------------------------------------
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
        let m: { type?: string; since?: number; runId?: string };
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (m.type === 'hello') {
          const since = Number(m.since ?? 0);
          const gap = d.state.seq - since;
          if (since <= 0 || gap > 5000) send({ type: 'snapshot', seq: d.state.seq, state: d.state });
          else send({ type: 'events', events: d.store.list({ afterSeq: since, kind: 'control', limit: 5000 }).filter((e) => !hidden(e)) });
          ready = true;
        } else if (m.type === 'subscribe_run' && m.runId) {
          if (!canTranscript) return send({ type: 'denied', reason: 'This phone was not granted run transcripts.' });
          runs.add(m.runId);
          const events = d.store.list({ runId: m.runId, afterSeq: Number(m.since ?? 0), limit: 1000 });
          send({ type: 'run_events', runId: m.runId, events, more: events.length === 1000 });
        } else if (m.type === 'unsubscribe_run' && m.runId) runs.delete(m.runId);
      });
      socket.on('close', () => {
        d.bus.off('events', onEvents);
        d.bus.off('live', onLive);
        d.bus.off('remote.revoked', onRevoked);
      });
    });
  });

  // ---- static UI ---------------------------------------------------------------------------
  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    // wildcard: serve whatever is in dist now, so a rebuilt UI works without restarting the daemon.
    await app.register(fastifyStatic, { root: WEB_DIST, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><title>One Connect</title><p>UI not built yet. Run <code>pnpm build</code> or use <code>pnpm dev:web</code>.</p>'));
  }

  const addr = await app.listen({ port, host });
  port = Number(new URL(addr).port);
  const url = `http://127.0.0.1:${port}`;
  d.url = url;
  return { app, url, installToken, issueCode };
}
