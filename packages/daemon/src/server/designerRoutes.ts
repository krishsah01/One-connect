// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// HTTP routes for the Designer studio: contract drafts and versions, design jobs, refinement,
// comparison, review, evidence and handoff bundles. Registered on the main app, so they inherit
// its Host/Origin checks and session/install-token authentication; remote sessions are deny-by-default.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HUMAN, REVIEW_CHECKLIST } from '@acc/core';
import { CommandError, type Daemon } from '../daemon.ts';
import { SKILL_PURPOSE, SKILL_SETS } from '../designer.ts';

type R<P = Record<string, string>, B = unknown, Q = Record<string, string | undefined>> = FastifyRequest<{ Params: P; Body: B; Querystring: Q }>;
const num = (v: string | undefined, label = 'revision'): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new CommandError(`Invalid ${label}`);
  return n;
};
const revOf = (v: string | undefined): number | 'latest' => (v === undefined || v === 'latest' ? 'latest' : num(v));

export function registerDesignerRoutes(app: FastifyInstance, d: Daemon): void {
  const studio = () => d.designer.studio;

  // ---- contract --------------------------------------------------------------------------------
  app.get('/api/designer/contract', async () => ({
    current: d.designer.fullExports(),
    history: d.designer.history().map(r => ({ version: r.version, hash: r.hash, createdAt: r.createdAt, by: r.by ?? null, parent: r.parent ?? null, note: r.note ?? null, schema: (r.system as { schema?: number }).schema === 2 ? 2 : 1 })),
    draft: d.designer.draft('system'),
    skills: d.designer.skills().map(s => ({ ...s, purpose: SKILL_PURPOSE[s.id] ?? s.description })),
    skillSets: { design: d.designer.defaultSkillIds({ labels: ['design'] }), implementation: SKILL_SETS.implementation, review: SKILL_SETS.review },
    checklist: REVIEW_CHECKLIST,
  }));
  app.get('/api/designer/revisions/:hash', async (req: R<{ hash: string }>) => {
    const r = d.designer.fullExports(req.params.hash);
    if (!r) throw new CommandError('Unknown design revision', 404);
    return r;
  });
  app.get('/api/designer/diff', async (req: R<Record<string, string>, unknown, { from?: string; to?: string }>) => d.designer.diff(req.query.from || null, String(req.query.to ?? '')));
  app.post('/api/designer/validate', async (req: R<Record<string, string>, { system?: unknown }>) => d.designer.validate(req.body?.system));
  app.post('/api/designer/contract', async (req: R<Record<string, string>, { system?: unknown; expected?: string | null; note?: string }>) => {
    const revision = d.designer.save(req.body?.system, req.body?.expected ?? null, req.body?.note ?? '');
    return { revision, exports: d.designer.fullExports(revision.hash) };
  });

  // ---- drafts (never approved, never frozen) ---------------------------------------------------
  app.get('/api/designer/drafts/:key', async (req: R<{ key: string }>) => ({ draft: d.designer.draft(req.params.key) }));
  app.put('/api/designer/drafts/:key', async (req: R<{ key: string }, { value?: unknown; base?: string | null }>) => ({ draft: d.designer.saveDraft(req.params.key, req.body?.value ?? null, req.body?.base ?? null) }));
  app.delete('/api/designer/drafts/:key', async (req: R<{ key: string }>) => { d.designer.clearDraft(req.params.key); return { ok: true }; });

  // ---- jobs ------------------------------------------------------------------------------------
  app.get('/api/designer/studio', async () => studio().overview());
  app.post('/api/designer/brief/preview', async (req: R<Record<string, string>, { brief?: unknown }>) => studio().previewBrief(req.body?.brief));
  app.post('/api/designer/jobs', async (req: R<Record<string, string>, { brief?: unknown }>) => {
    const view = studio().createJob(req.body?.brief, HUMAN);
    d.designer.clearDraft('brief');
    return { ...view, prompt: d.state.assignments[view.job.assignmentId]?.prompt ?? '' };
  });
  app.get('/api/designer/jobs/:id', async (req: R<{ id: string }>) => {
    const view = studio().view(studio().job(req.params.id));
    return { ...view, prompt: d.state.assignments[view.job.assignmentId]?.prompt ?? '' };
  });
  app.post('/api/designer/jobs/:id/cancel', async (req: R<{ id: string }>) => studio().cancel(req.params.id, HUMAN));
  app.post('/api/designer/jobs/:id/capture', async (req: R<{ id: string }>) => {
    const r = await studio().captureJob(req.params.id, HUMAN);
    return { artifactId: r.artifact.id, revision: r.revision.rev, unchanged: r.unchanged };
  });

  // ---- artifacts -------------------------------------------------------------------------------
  app.get('/api/mocks/:id/lineage', async (req: R<{ id: string }>) => ({ jobs: studio().lineage(req.params.id) }));
  app.get('/api/mocks/:id/compare', async (req: R<{ id: string }, unknown, { from?: string; to?: string; file?: string }>) => d.mocks.compare(req.params.id, num(req.query.from), num(req.query.to), req.query.file || undefined));
  app.post('/api/mocks/:id/revisions/:rev/refine', async (req: R<{ id: string; rev: string }, { request?: string; agentId?: string; mode?: 'auto' | 'new-assignment' }>) => {
    const view = await studio().refine(req.params.id, num(req.params.rev), String(req.body?.request ?? ''), { agentId: req.body?.agentId || undefined, mode: req.body?.mode === 'new-assignment' ? 'new-assignment' : 'auto' }, HUMAN);
    d.designer.clearDraft(`refine:${req.params.id}`);
    return view;
  });
  app.post('/api/mocks/:id/revisions/:rev/review-request', async (req: R<{ id: string; rev: string }, { agentId?: string }>) => studio().requestReview(req.params.id, num(req.params.rev), String(req.body?.agentId ?? ''), HUMAN));
  app.post('/api/mocks/:id/revisions/:rev/decision', async (req: R<{ id: string; rev: string }, { decision?: string; note?: string; checklist?: unknown }>) => ({ mock: d.mocks.review(req.params.id, num(req.params.rev), req.body?.decision as never, String(req.body?.note ?? ''), HUMAN, { checklist: req.body?.checklist }) }));
  app.post('/api/mocks/:id/revisions/:rev/evidence/upload', { bodyLimit: 8 * 1024 * 1024 }, async (req: R<{ id: string; rev: string }, Record<string, unknown>>) => ({ evidence: d.mocks.addEvidence(req.params.id, num(req.params.rev), req.body ?? {}, HUMAN) }));
  app.get('/api/mocks/:id/evidence/:evidenceId/image', async (req: R<{ id: string; evidenceId: string }>, reply) => {
    reply.header('cache-control', 'no-store');
    return d.mocks.evidenceImage(req.params.id, req.params.evidenceId);
  });
  app.get('/api/mocks/:id/revisions/:rev/bundle', async (req: R<{ id: string; rev: string }, unknown, { approved?: string }>) => d.mocks.export(req.params.id, revOf(req.params.rev), { approvedOnly: req.query.approved === '1' }));
  app.post('/api/mocks/:id/revisions/:rev/engineering', async (req: R<{ id: string; rev: string }, { agentId?: string; allowedPaths?: string[]; notes?: string }>) => {
    const view = studio().prepareEngineering(req.params.id, num(req.params.rev), { agentId: String(req.body?.agentId ?? ''), allowedPaths: Array.isArray(req.body?.allowedPaths) ? req.body!.allowedPaths : [], notes: req.body?.notes }, HUMAN);
    return { ...view, prompt: d.state.assignments[view.job.assignmentId]?.prompt ?? '' };
  });
}
