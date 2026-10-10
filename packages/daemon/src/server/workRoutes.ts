// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Issues and assignments: create, edit, pre-flight, dispatch, queue moves, quick tasks, imports.
// Bodies are validated and unknown fields are dropped, so a client can only set what the
// command accepts (never e.g. an assignment's worktree, agent or review binding).
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EffortSchema, HUMAN } from '@acc/core';
import { changedFiles, diffPatch } from '../adapters/vcs/git.ts';
import { CommandError, type Daemon } from '../daemon.ts';
import { parseBody, type Req } from './route.ts';

const strings = z.array(z.string());

const IssueBody = z.object({
  title: z.string(),
  description: z.string().optional(),
  acceptance: strings.optional(),
  labels: strings.optional(),
  priority: z.number().optional(),
  requiresProductionVerification: z.boolean().optional(),
  parentKey: z.string().nullable().optional(),
});

const AssignmentBody = z.object({
  workItemId: z.string(),
  agentId: z.string(),
  allowedPaths: strings.optional(),
  scope: z.string().optional(),
  requiredChecks: strings.optional(),
  askHumanIf: strings.optional(),
  model: z.string().nullable().optional(),
});

/** Exactly the fields Daemon.updateAssignment accepts. */
const AssignmentPatch = z.object({
  prompt: z.string().optional(),
  scope: z.string().optional(),
  allowedPaths: strings.optional(),
  requiredChecks: strings.optional(),
  askHumanIf: strings.optional(),
  model: z.string().nullable().optional(),
  effort: EffortSchema.nullable().optional(),
});

const QuickTaskBody = z.object({
  agentId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  allowedPaths: strings.optional(),
});

export function registerWorkRoutes(app: FastifyInstance, d: Daemon): void {
  app.get('/api/work-items/:id/events', async (req: Req) => ({ events: d.store.list({ workItemId: req.params.id, kind: 'control', limit: 2000 }) }));

  app.get('/api/assignments/:id/diff', async (req: Req) => {
    const a = d.state.assignments[req.params.id];
    if (!a) throw new CommandError('unknown assignment', 404);
    if (!a.worktree || !a.baseSha || !fs.existsSync(a.worktree)) return { files: [], patch: '', truncated: false };
    const [files, p] = await Promise.all([changedFiles(a.worktree, a.baseSha), diffPatch(a.worktree, a.baseSha)]);
    return { files, ...p };
  });

  app.post('/api/issues', async (req: Req) => ({ item: d.createIssue(parseBody(IssueBody, req.body), HUMAN) }));

  app.post('/api/assignments', async (req: Req) => {
    const a = d.createAssignment(parseBody(AssignmentBody, req.body));
    return { assignment: a, preflight: d.preflight(a.id) };
  });
  app.patch('/api/assignments/:id', async (req: Req) => {
    d.updateAssignment(req.params.id, parseBody(AssignmentPatch, req.body));
    return { assignment: d.state.assignments[req.params.id], preflight: d.preflight(req.params.id) };
  });
  app.post('/api/assignments/:id/preflight', async (req: Req) => ({ preflight: d.preflight(req.params.id) }));
  app.post('/api/assignments/:id/dispatch', async (req: Req<{ position?: 'now' | 'next' }>) => d.dispatch(req.params.id, { position: req.body?.position }));
  app.post('/api/assignments/:id/reassign', async (req: Req) => {
    d.reassign(req.params.id, parseBody(z.object({ agentId: z.string().min(1) }), req.body).agentId);
    return { ok: true };
  });
  app.post('/api/assignments/:id/cancel', async (req: Req) => {
    d.cancelAssignment(req.params.id);
    return { ok: true };
  });

  app.post('/api/quick-task', async (req: Req) => {
    const b = parseBody(QuickTaskBody, req.body);
    if (!b.title.trim()) throw new CommandError('title is required');
    return d.quickTask({ agentId: b.agentId, title: b.title.trim(), description: b.description, allowedPaths: b.allowedPaths });
  });

  app.get('/api/imports/sources', async () => ({ sources: d.imports.sources() }));
  app.post('/api/imports/preview', async (req: Req) => {
    const b = parseBody(z.object({ sourceId: z.string(), query: z.string().optional() }), req.body);
    return d.imports.preview(b.sourceId, b.query);
  });
  app.post('/api/imports/commit', async (req: Req) => {
    const b = parseBody(z.object({ token: z.string(), ids: strings }), req.body);
    return d.imports.import(b.token, b.ids);
  });
}
