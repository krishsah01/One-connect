// SPDX-License-Identifier: Apache-2.0
// Project onboarding and Docker workbench routes. Registered by createServer behind the same
// authentication hook as every other /api route; each daemon serves exactly one project.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Daemon } from '../daemon.ts';
import { EnvironmentError } from '../environment/workbench.ts';
import { inspectProject, ProjectIntakeError } from '../projects/inspect.ts';

export async function registerProjectRoutes(app: FastifyInstance, d: Daemon): Promise<void> {
  const guard = <T>(fn: () => Promise<T>) => async (_req: FastifyRequest, reply: FastifyReply) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof EnvironmentError) return reply.code(e.status).send({ error: e.message });
      if (e instanceof ProjectIntakeError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  };
  type R<B = unknown, P = Record<string, string>> = FastifyRequest<{ Body: B; Params: P }>;

  app.get('/api/project/onboarding', (req, reply) => guard(async () => ({ inspection: await inspectProject(d.config.project.repo), answer: d.context.answer.status }))(req, reply));
  app.get('/api/environment', (req: FastifyRequest<{ Querystring: { refresh?: string } }>, reply) => guard(() => d.environment.status(req.query.refresh === '1'))(req, reply));
  app.get('/api/environment/services/:service/logs', (req: R<unknown, { service: string }>, reply) => guard(() => d.environment.logs(req.params.service))(req, reply));
  app.post('/api/environment/actions', (req: R<{ action?: string; services?: string[] }>, reply) => guard(() => d.environment.request(String(req.body?.action ?? ''), req.body?.services ?? []))(req, reply));
  app.post('/api/environment/actions/:id/resolve', (req: R<{ answer?: string; digest?: string; nonce?: string; channel?: string }, { id: string }>, reply) => guard(() => d.environment.resolve(req.params.id, String(req.body?.answer ?? ''), String(req.body?.digest ?? ''), { nonce: req.body?.nonce, channel: req.body?.channel ?? 'web' }))(req, reply));
  app.post('/api/environment/database/plan', (req: R, reply) => guard(() => d.environment.planDatabase(req.body))(req, reply));
  app.post('/api/environment/database/create', (req: R, reply) => guard(() => d.environment.createDatabase(req.body))(req, reply));
}
