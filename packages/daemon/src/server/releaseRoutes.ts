// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Release cockpit: ordered plans, step approvals, code-host and infrastructure health, findings.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ReleaseStepKind } from '@acc/core';
import type { Daemon } from '../daemon.ts';
import type { Req } from './route.ts';

type StepParams = FastifyRequest<{ Params: { id: string; stepId: string } }>;
interface StepInput { id?: string; kind: ReleaseStepKind; title: string; owner: string; command: string; check: string; rollback: string; rollbackCheck?: string; target?: string; environment?: string }

export function registerReleaseRoutes(app: FastifyInstance, d: Daemon): void {
  app.get('/api/release/plans', async () => ({ plans: d.releasePlans.list(), codeHost: d.state.codeHost, infra: d.state.infra }));
  app.post('/api/release/plans', async (req: Req<{ name?: string; workItemId?: string | null }>) => ({ plan: d.releasePlans.create(req.body ?? {}) }));
  app.post('/api/release/plans/:id', async (req: Req<{ name?: string; workItemId?: string | null; steps?: StepInput[] }>) => ({ plan: d.releasePlans.update(req.params.id, req.body ?? {}) }));
  app.post('/api/release/plans/:id/cancel', async (req: Req) => ({ plan: d.releasePlans.cancel(req.params.id) }));
  app.post('/api/release/plans/:id/steps/:stepId/decision', async (req: StepParams) => d.releasePlans.requestStep(req.params.id, req.params.stepId));
  app.post('/api/release/plans/:id/steps/:stepId/rollback', async (req: StepParams) => d.releasePlans.requestRollback(req.params.id, req.params.stepId));
  app.post('/api/release/plans/:id/steps/:stepId/inspect', async (req: StepParams) => d.releasePlans.requestInspection(req.params.id, req.params.stepId));
  app.post('/api/release/refresh', async () => {
    const codeHost = await d.hosts.refresh();
    const infra = await d.infra.refresh();
    d.findings.maybeAuto();
    return { codeHost, infra };
  });
  app.post('/api/release/findings', async (req: Req<{ kind?: string }>) => d.findings.link((req.body?.kind ?? '') as 'ci' | 'unprotected_branch' | 'migration_drift'));
  app.post('/api/release/deliveries', async (req: Req<{ headers?: Record<string, string>; body?: string }>) => d.hosts.acceptDelivery(req.body ?? {}));
  app.get('/api/infra/health', async () => ({ health: d.state.infra, codeHost: d.state.codeHost }));
}
