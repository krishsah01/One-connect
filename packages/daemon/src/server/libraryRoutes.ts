// SPDX-License-Identifier: Apache-2.0
// HTTP routes for project skills, connectors and design mock artifacts. Registered on the main app,
// so they inherit its Host/Origin checks and session/install-token authentication.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HUMAN } from '@acc/core';
import { CommandError, type Daemon } from '../daemon.ts';

type R<P = Record<string, string>, B = unknown, Q = Record<string, string | undefined>> = FastifyRequest<{ Params: P; Body: B; Querystring: Q }>;
const revOf = (v: string | undefined): number | 'latest' => {
  if (v === undefined || v === 'latest') return 'latest';
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new CommandError('Invalid revision');
  return n;
};
const num = (v: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new CommandError('Invalid revision');
  return n;
};

export function registerLibraryRoutes(app: FastifyInstance, d: Daemon): void {
  // A sandboxed mock preview that navigates itself is still a frame navigation of this page:
  // keep every child frame on this origin (srcdoc previews are unaffected).
  app.addHook('onSend', async (req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html') && !req.url.startsWith('/api/') && !reply.getHeader('content-security-policy')) reply.header('content-security-policy', "frame-src 'self'; child-src 'self'");
    return payload;
  });

  // ---- skills ----------------------------------------------------------------------------
  app.get('/api/skills', async () => d.skillLib.catalog());
  app.get('/api/skills/templates/:id', async (req: R<{ id: string }>) => d.skillLib.template(req.params.id));
  app.post('/api/skills/import/preview', async (req: R<Record<string, string>, { files?: Record<string, unknown>; bundle?: unknown }>) => d.skillLib.importPreview(req.body as never));
  app.get('/api/skills/:id', async (req: R<{ id: string }>) => d.skillLib.detail(req.params.id));
  app.get('/api/skills/:id/content', async (req: R<{ id: string }, unknown, { version?: string; file?: string }>) => d.skillLib.readVersion(req.params.id, req.query.version ?? null, req.query.file ?? 'SKILL.md'));
  app.get('/api/skills/:id/versions/:version/export', async (req: R<{ id: string; version: string }>) => d.skillLib.exportVersion(req.params.id, num(req.params.version)));
  app.post('/api/skills/:id/draft', async (req: R<{ id: string }, { draft?: Record<string, unknown>; expected?: string | null }>) => {
    const draft = req.body?.draft ?? {};
    if (draft.id !== req.params.id) throw new CommandError('Skill id does not match the URL');
    return d.skillLib.saveDraft(draft, req.body?.expected ?? null);
  });
  app.post('/api/skills/:id/publish', async (req: R<{ id: string }, { expectedVersion?: number | null; expectedDraftHash?: string | null }>) => {
    const hash = req.body?.expectedDraftHash;
    if (hash === undefined || hash === null || hash === '') throw new CommandError('Publish requires the draft hash you reviewed.', 409);
    return { version: d.skillLib.publish(req.params.id, req.body?.expectedVersion ?? null, hash) };
  });
  app.post('/api/skills/:id/disable', async (req: R<{ id: string }, { disabled?: boolean }>) => ({ skill: d.skillLib.setDisabled(req.params.id, req.body?.disabled !== false) }));
  app.get('/api/assignments/:id/skills', async (req: R<{ id: string }>) => {
    const a = d.state.assignments[req.params.id];
    if (!a) throw new CommandError('unknown assignment', 404);
    return { skills: d.skillLib.forAssignment(a), export: d.skillLib.exportStatus(a.id) };
  });
  app.post('/api/assignments/:id/skills/export', async (req: R<{ id: string }>) => ({ export: await d.skillLib.reexport(req.params.id) }));

  // ---- connectors ------------------------------------------------------------------------
  app.get('/api/connectors', async () => d.connectors.list());
  app.post('/api/connectors/:id', async (req: R<{ id: string }, { connection?: Record<string, unknown>; expected?: string | null }>) => {
    const c = req.body?.connection ?? {};
    if (c.id !== req.params.id) throw new CommandError('Connection id does not match the URL');
    return { connection: d.connectors.save(c, req.body?.expected ?? null) };
  });
  app.post('/api/connectors/:id/disable', async (req: R<{ id: string }, { disabled?: boolean }>) => ({ connection: d.connectors.setDisabled(req.params.id, req.body?.disabled !== false) }));
  app.post('/api/connectors/:id/check', async (req: R<{ id: string }>) => ({ connection: await d.connectors.check(req.params.id) }));
  app.post('/api/connectors/:id/read', async (req: R<{ id: string }>) => d.connectors.readRelease(req.params.id));
  app.post('/api/connectors/:id/activate', async (req: R<{ id: string }, { action?: string }>) => d.connectors.requestActivation(req.params.id, String(req.body?.action ?? '') as never));
  app.post('/api/connectors/decisions/:id/resolve', async (req: R<{ id: string }, { answer?: string; nonce?: string }>) => ({ connection: await d.connectors.resolve(req.params.id, String(req.body?.answer ?? ''), HUMAN, { nonce: req.body?.nonce }) }));
  app.post('/api/connectors/:id/preview', async (req: R<{ id: string }, { query?: string; page?: number; pageSize?: number; token?: string }>) => d.connectors.previewImport(req.params.id, String(req.body?.query ?? ''), { page: req.body?.page, pageSize: req.body?.pageSize, token: req.body?.token }));
  app.post('/api/connectors/import', async (req: R<Record<string, string>, { token?: string; selections?: { id: string; acceptance: string[] }[] }>) => d.connectors.acceptImport(String(req.body?.token ?? ''), req.body?.selections ?? []));
  app.get('/api/connectors/:id/containers', async (req: R<{ id: string }>) => d.connectors.containers(req.params.id));
  app.post('/api/connectors/:id/tools/:tool', async (req: R<{ id: string; tool: string }, { arguments?: Record<string, unknown> }>) => d.connectors.requestToolCall(req.params.id, req.params.tool, req.body?.arguments ?? {}));
  app.get('/api/connectors/tool-requests/:requestId', async (req: R<{ requestId: string }>) => ({ request: d.connectors.getToolCallResult(req.params.requestId) }));

  // ---- design mocks ----------------------------------------------------------------------
  app.get('/api/mocks', async (req: R<Record<string, string>, unknown, { workItemId?: string; assignmentId?: string }>) => ({ mocks: d.mocks.list({ workItemId: req.query.workItemId, assignmentId: req.query.assignmentId }), design: d.state.design ? { hash: d.state.design.hash, version: d.state.design.version } : null }));
  app.get('/api/mocks/:id', async (req: R<{ id: string }>) => ({ mock: d.mocks.view(d.mocks.get(req.params.id)) }));
  app.post('/api/assignments/:id/mocks/capture', async (req: R<{ id: string }, { dir?: string; title?: string }>) => d.mocks.capture(req.params.id, String(req.body?.dir ?? ''), HUMAN, { title: req.body?.title }));
  app.get('/api/mocks/:id/revisions/:rev/preview', async (req: R<{ id: string; rev: string }, unknown, { page?: string }>, reply) => {
    reply.header('cache-control', 'no-store');
    return d.mocks.preview(req.params.id, revOf(req.params.rev), req.query.page ?? 'index.html');
  });
  app.get('/api/mocks/:id/revisions/:rev/source', async (req: R<{ id: string; rev: string }, unknown, { path?: string }>) => d.mocks.readSource(req.params.id, revOf(req.params.rev), String(req.query.path ?? '')));
  app.post('/api/mocks/:id/source', async (req: R<{ id: string }, { path?: string; content?: string; expectedSha?: string | null }>) => d.mocks.editSource(req.params.id, String(req.body?.path ?? ''), req.body?.content as string, req.body?.expectedSha ?? null));
  app.get('/api/mocks/:id/revisions/:rev/export', async (req: R<{ id: string; rev: string }>) => d.mocks.export(req.params.id, revOf(req.params.rev)));
  app.post('/api/mocks/:id/revisions/:rev/exceptions', async (req: R<{ id: string; rev: string }, { findingIds?: string[]; rationale?: string }>) => ({ mock: d.mocks.addException(req.params.id, num(req.params.rev), req.body?.findingIds ?? [], String(req.body?.rationale ?? ''), HUMAN) }));
  app.post('/api/mocks/:id/revisions/:rev/review', async (req: R<{ id: string; rev: string }, { decision?: string; note?: string }>) => ({ mock: d.mocks.review(req.params.id, num(req.params.rev), req.body?.decision as never, String(req.body?.note ?? ''), HUMAN) }));
  app.post('/api/mocks/:id/revisions/:rev/evidence', async (req: R<{ id: string; rev: string }, Record<string, unknown>>) => ({ evidence: d.mocks.addEvidence(req.params.id, num(req.params.rev), req.body ?? {}, HUMAN) }));
  app.post('/api/mocks/:id/revisions/:rev/findings/:finding/issue', async (req: R<{ id: string; rev: string; finding: string }>) => ({ item: d.mocks.findingToIssue(req.params.id, num(req.params.rev), req.params.finding) }));
}
