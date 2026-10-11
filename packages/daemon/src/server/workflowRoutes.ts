// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Workflows, reviews, merges and decisions: the routes that move work through gates.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { reviewsForItem } from '@acc/core';
import { CommandError } from '../errors.ts';
import type { Daemon } from '../daemon.ts';
import type { FindingInput } from '../reviewMerge.ts';
import type { Req } from './route.ts';

export function registerWorkflowRoutes(app: FastifyInstance, d: Daemon): void {
  // A workflow command answers once the engine has applied its consequences.
  const settled = async <T>(p: Promise<T>): Promise<T> => {
    const r = await p;
    await d.workflows.idle();
    return r;
  };
  const actions: Record<string, (id: string) => Promise<unknown>> = {
    start: (id) => d.workflows.launch(id),
    pause: (id) => d.workflows.pause(id),
    resume: (id) => d.workflows.resume(id),
    cancel: (id) => d.workflows.cancel(id),
  };
  app.get('/api/workflows', async () => ({ workflows: d.workflows.list() }));
  app.post('/api/workflows', async (req: Req<{ id?: string | null; definition: unknown; expectedVersion?: number | null }>) => ({ workflow: d.workflows.save({ id: req.body?.id ?? null, definition: req.body?.definition, expectedVersion: req.body?.expectedVersion ?? null }) }));
  app.post('/api/workflows/validate', async (req: Req<{ id?: string | null; definition: unknown; forStart?: boolean }>) => d.workflows.validate(req.body?.definition, { workflowId: req.body?.id ?? null, forStart: Boolean(req.body?.forStart) }));
  app.post('/api/workflows/:id/:action', async (req: FastifyRequest<{ Params: { id: string; action: string } }>) => {
    const { id, action } = req.params;
    const run = Object.hasOwn(actions, action) ? actions[action] : undefined;
    if (!run) throw new CommandError(`unknown workflow action ${action}`, 404);
    return { workflow: await settled(run(id)) };
  });
  app.post('/api/workflows/:id/tasks/:taskId/retry', async (req: FastifyRequest<{ Params: { id: string; taskId: string } }>) => ({ workflow: await settled(d.workflows.retry(req.params.id, req.params.taskId)) }));

  app.get('/api/work-items/:id/reviews', async (req: Req) => ({ reviews: reviewsForItem(d.state, req.params.id) }));
  app.post('/api/work-items/:id/review-request', async (req: Req<{ reviewerAgentId: string; targetSha?: string; position?: 'now' | 'next' }>) => {
    const assignment = await d.reviewMerge.createReviewAssignment({ workItemId: req.params.id, reviewerAgentId: String(req.body?.reviewerAgentId ?? ''), targetSha: req.body?.targetSha ?? null });
    return { assignment, ...(await d.dispatch(assignment.id, { position: req.body?.position })) };
  });
  app.post('/api/work-items/:id/reviews', async (req: Req<{ verdict: string; sha?: string; summary?: string; findings?: FindingInput[] }>) => ({ review: await d.reviewMerge.recordHumanReview(req.params.id, req.body ?? ({} as never)) }));
  app.get('/api/work-items/:id/merge-gates', async (req: Req) => d.reviewMerge.gatesFor(req.params.id));
  app.post('/api/work-items/:id/merge-request', async (req: Req) => d.reviewMerge.requestMerge(req.params.id));
  app.post('/api/work-items/:id/acceptance', async (req: Req<{ summary: string; env?: 'local' | 'ci' | 'production' | 'device' }>) => d.reviewMerge.recordAcceptance(req.params.id, req.body ?? ({} as never)));
  app.post('/api/merges/:decisionId/execute', async (req: FastifyRequest<{ Params: { decisionId: string } }>) => d.reviewMerge.executeMerge(req.params.decisionId));

  app.get('/api/decisions/:id/history', async (req: Req) => ({ decision: d.state.decisions[req.params.id] ?? null, events: d.decisions.history(req.params.id) }));
  app.post('/api/decisions/:id/prepare', async (req: Req<{ answer: string }>) => d.decisions.prepare(req.params.id, String(req.body?.answer ?? '')));
  app.post('/api/decisions/:id/answer', async (req: Req<{ answer: string; nonce?: string; channel?: string }>) => d.decisions.respond(req.params.id, String(req.body?.answer ?? ''), { nonce: req.body?.nonce ?? null, channel: req.body?.channel ?? 'web' }));
}
