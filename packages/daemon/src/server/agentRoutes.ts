// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Agents: builder saves, paid-mode approvals, subscription safety, queues, probes and models.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Daemon } from '../daemon.ts';
import { parseBody, type Req } from './route.ts';

export function registerAgentRoutes(app: FastifyInstance, d: Daemon): void {
  app.post('/api/agents/configure', async (req: Req<{ config: unknown; expected?: unknown }>) => ({ agent: d.saveAgent(req.body?.config, req.body?.expected ?? null) }));
  app.post('/api/agents/cost-approval', async (req: Req<{ config: unknown; expected?: unknown }>) => d.agentCosts.request(req.body?.config, req.body?.expected ?? null));
  app.get('/api/agents/:id/subscription-safety', async (req: Req) => d.subscriptionSafety.status(req.params.id));
  // Own-account / vendor-terms confirmation for subscription logins (owner only, at this Mac).
  app.get('/api/agents/:id/account-terms', async (req: Req) => d.accounts.status(req.params.id));
  app.post('/api/agents/:id/account-terms', async (req: Req<{ statements?: unknown }>) => d.accounts.acknowledge(req.params.id, req.body?.statements));
  app.delete('/api/agents/:id/account-terms', async (req: Req) => d.accounts.revoke(req.params.id));
  app.post('/api/agents/:id/subscription-safety', async (req: Req<{ paidModesOff?: boolean }>) => d.subscriptionSafety.confirm(req.params.id, req.body?.paidModesOff === true));

  app.post('/api/agents/:id/queue', async (req: Req) => {
    d.setQueue(req.params.id, parseBody(z.object({ next: z.array(z.string()).default([]) }), req.body).next);
    return { ok: true };
  });
  app.post('/api/agents/:id/probe', async (req: Req) => {
    await d.probe(req.params.id);
    return { agent: d.state.agents[req.params.id] };
  });
  app.post('/api/agents/:id/model', async (req: Req) => {
    d.swapModel(req.params.id, parseBody(z.object({ model: z.string().min(1) }), req.body).model);
    return { ok: true };
  });
  app.post('/api/agents/:id/resume', async (req: Req) => {
    d.resumeAgent(req.params.id);
    return { ok: true };
  });
}
