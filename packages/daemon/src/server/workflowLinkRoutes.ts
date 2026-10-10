// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HUMAN } from '@acc/core';
import type { Daemon } from '../daemon.ts';
export function registerWorkflowLinkRoutes(app: FastifyInstance, d: Daemon): void {
  app.get('/api/workflow-links', async () => ({ links: d.workflowLinks.list() }));
  app.post('/api/workflow-links', async req => ({ link: d.workflowLinks.save(req.body, HUMAN) }));
  app.post('/api/workflow-links/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>) => ({ link: d.workflowLinks.cancel(req.params.id, HUMAN) }));
  app.post('/api/workflow-links/:id/decide', async (req: FastifyRequest<{ Params: { id: string }; Body: { option: string } }>) => ({ link: await d.workflowLinks.decide(req.params.id, req.body?.option, HUMAN) }));
}
