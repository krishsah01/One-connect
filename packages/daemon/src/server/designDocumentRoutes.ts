// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// HTTP resources for structured designs under /api/designer: documents, operations, history,
// proposals, assets, kits, releases and workflow handoff. Bodies are validated here; the
// service validates operations and documents again before anything is stored.
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { DESIGN_STARTERS, DesignOperationsSchema, designDocumentFindings, TONES, TYPEFACES } from '@acc/core';
import type { Daemon } from '../daemon.ts';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/);
const kitId = z.string().regex(/^kit_[A-Za-z0-9_-]{1,64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const expected = z.number().int().positive();
const rev = z.coerce.number().int().positive();
const style = z.object({ tone: z.enum(Object.keys(TONES) as [string, ...string[]]).optional(), brand: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), typeface: z.enum(Object.keys(TYPEFACES) as [string, ...string[]]).optional(), density: z.enum(['compact', 'comfortable', 'spacious']).optional() }).strict();
const proposal = z.object({ prompt: z.string().max(2000), starter: z.enum(DESIGN_STARTERS).optional(), tone: style.shape.tone, brand: style.shape.brand, typeface: style.shape.typeface, audience: z.string().max(200).optional() }).strict();

export function registerDesignDocumentRoutes(app: FastifyInstance, d: Daemon) {
  const docs = () => d.designer.documents;
  const p = <T extends z.ZodRawShape>(shape: T, v: unknown) => z.object(shape).parse(v);

  // ---- documents ----------------------------------------------------------------------------------
  app.get('/api/designer/documents', async () => ({ documents: docs().list() }));
  app.post('/api/designer/documents', async req => {
    const b = z.object({ name: z.string().trim().min(1).max(150), starter: z.enum(DESIGN_STARTERS).default('dashboard'), style: style.optional(), proposal: proposal.optional() }).strict().parse(req.body);
    const r = docs().create({ name: b.name, starter: b.starter, style: b.style as never, proposal: b.proposal as never });
    return docs().view(r.document.id);
  });
  app.get('/api/designer/documents/:id', async req => docs().view(p({ id }, req.params).id));
  app.post('/api/designer/documents/:id/operations', { bodyLimit: 4 * 1024 * 1024 }, async req => {
    const b = z.object({ expected, operations: DesignOperationsSchema, label: z.string().max(80).optional() }).strict().parse(req.body);
    return docs().edit(p({ id }, req.params).id, b.expected, b.operations, undefined, b.label ?? 'Edit');
  });
  app.post('/api/designer/documents/:id/history', async req => {
    const b = z.object({ expected, direction: z.enum(['undo', 'redo']) }).strict().parse(req.body);
    return docs().history(p({ id }, req.params).id, b.expected, b.direction);
  });
  app.post('/api/designer/documents/:id/conflicts', { bodyLimit: 4 * 1024 * 1024 }, async req => {
    const b = z.object({ baseVersion: expected, operations: DesignOperationsSchema, label: z.string().max(80).default('Edit') }).strict().parse(req.body);
    return { proposal: docs().recordConflict(p({ id }, req.params).id, b.baseVersion, b.operations, b.label) };
  });
  app.post('/api/designer/documents/:id/proposals/:proposalId', async req => {
    const params = p({ id, proposalId: id }, req.params);
    const b = z.object({ decision: z.enum(['apply', 'discard']), expected: expected.optional(), rebase: z.boolean().optional() }).strict().parse(req.body);
    docs().decide(params.id, params.proposalId, b.decision, { expected: b.expected, rebase: b.rebase });
    return docs().view(params.id);
  });
  app.get('/api/designer/documents/:id/validation', async req => ({ findings: designDocumentFindings(docs().get(p({ id }, req.params).id).document) }));

  // ---- AI requests ----------------------------------------------------------------------------------
  app.get('/api/designer/documents/:id/skills', async req => {
    const q = z.object({ request: z.string().max(6000).default(''), kind: z.enum(['edit', 'generate', 'reconstruct', 'repair']).default('edit') }).parse(req.query);
    docs().get(p({ id }, req.params).id);
    return { skills: docs().focusedSkills(q.request, q.kind) };
  });
  app.post('/api/designer/documents/:id/ai', async req => {
    const b = z.object({ agentId: id, request: z.string().trim().min(1).max(6000), selection: z.array(id).max(100).default([]), files: z.array(z.string().max(300)).max(50).default([]), kind: z.enum(['edit', 'generate', 'reconstruct', 'repair']).default('edit') }).strict().parse(req.body);
    return docs().aiJob(p({ id }, req.params).id, b);
  });
  app.get('/api/designer/repository/files', async req => docs().repositoryFiles(z.object({ q: z.string().max(200).default('') }).parse(req.query).q));

  // ---- system, releases and exports -----------------------------------------------------------------
  app.get('/api/designer/documents/:id/release-readiness', async req => {
    const docId = p({ id }, req.params).id;
    return { blockers: docs().releaseBlockers(docId), impact: docs().systemImpact(docId) };
  });
  app.post('/api/designer/documents/:id/foundations', async req => {
    const b = z.object({ expected, expectedSystem: hash.nullable(), replacements: z.record(id, id).default({}) }).strict().parse(req.body);
    const docId = p({ id }, req.params).id;
    docs().saveFoundations(docId, b.expected, b.expectedSystem, b.replacements);
    return docs().view(docId);
  });
  app.post('/api/designer/documents/:id/system', async req => {
    const b = z.object({ expected }).strict().parse(req.body), docId = p({ id }, req.params).id;
    docs().rebase(docId, b.expected);
    return docs().view(docId);
  });
  app.post('/api/designer/documents/:id/releases', async req => {
    const b = z.object({ expected, agentId: id }).strict().parse(req.body);
    return docs().publish(p({ id }, req.params).id, b.expected, b.agentId);
  });
  app.get('/api/designer/documents/:id/export', async req => docs().exportDraft(p({ id }, req.params).id));
  app.get('/api/designer/releases/:artifactId/:rev', async req => { const x = p({ artifactId: id, rev }, req.params); return docs().releaseBundle(x.artifactId, x.rev); });
  app.get('/api/designer/releases/:artifactId/uses', async req => ({ uses: docs().workflowUses(p({ artifactId: id }, req.params).artifactId) }));
  app.post('/api/designer/releases/:artifactId/:rev/handoff', async req => {
    const x = p({ artifactId: id, rev }, req.params);
    const b = z.object({ workflowId: id.optional(), taskId: id.optional(), expectedVersion: expected.optional(), agentId: id.optional(), reviewAgentId: id.optional(), allowedPaths: z.array(z.string().max(200)).max(100).optional(), notes: z.string().max(2000).optional() }).strict().parse(req.body);
    return docs().handoff(x.artifactId, x.rev, b);
  });
  app.post('/api/designer/mocks/:artifactId/:rev/rebuild', async req => { const x = p({ artifactId: id, rev }, req.params); return docs().rebuildFromMock(x.artifactId, x.rev); });

  // ---- local library --------------------------------------------------------------------------------
  app.get('/api/designer/kits', async () => ({ kits: docs().kits() }));
  app.post('/api/designer/kits', async req => {
    const b = z.object({ documentId: id, kitId: kitId.optional(), name: z.string().trim().min(1).max(150).optional(), description: z.string().max(1000).optional() }).strict().parse(req.body);
    return docs().saveKit(b.documentId, b);
  });
  app.post('/api/designer/kits/:kitId/import', async req => { const r = docs().importKit(p({ kitId }, req.params).kitId); return docs().view(r.document.id); });
  app.get('/api/designer/documents/:id/kit-updates', async req => ({ updates: docs().kitUpdates(p({ id }, req.params).id) }));
  app.post('/api/designer/documents/:id/kits/:kitId/propose', async req => { const x = p({ id, kitId }, req.params); return { proposal: docs().proposeKit(x.id, x.kitId) }; });

  // ---- assets ---------------------------------------------------------------------------------------
  app.post('/api/designer/assets', { bodyLimit: 8 * 1024 * 1024 }, async req => {
    const b = z.object({ name: z.string().min(1).max(150), base64: z.string().max(7 * 1024 * 1024), reference: z.boolean().default(false) }).strict().parse(req.body);
    return docs().upload(b.name, b.base64, b.reference);
  });
  app.get('/api/designer/assets/:hash/data', async req => { const a = docs().asset(p({ hash }, req.params).hash); return { mime: a.mime, base64: a.data.toString('base64') }; });
  app.get('/api/designer/assets/:hash', async (req, reply) => {
    const a = docs().asset(p({ hash }, req.params).hash);
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=31536000, immutable').header('Content-Security-Policy', "default-src 'none'; sandbox").type(a.mime);
    return a.data;
  });
}
