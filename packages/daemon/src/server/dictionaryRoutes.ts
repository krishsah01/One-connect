// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Dictionary HTTP routes: intake control (cancel), cited search, committed-file view, the
// declarative structure graph, installed local model status and the agent context packet preview.
// Registered on the main app, so they inherit its Host/Origin checks and authentication.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CommandError, type Daemon } from '../daemon.ts';
import { redactMetadata } from '../context/redaction.ts';

type R<B = unknown, Q = Record<string, string | undefined>> = FastifyRequest<{ Body: B; Querystring: Q }>;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function registerDictionaryRoutes(app: FastifyInstance, d: Daemon): void {
  const answer = () => d.context.answer;
  app.post('/api/context/answer/cancel', async () => ({ cancelled: answer().cancel(), status: answer().status }));
  app.post('/api/context/answer/search', async (req: R<{ query?: string; limit?: number }>) => {
    if (!d.context.docs) throw new CommandError('No project knowledge is connected', 409);
    await answer().ensureFresh();
    const result = answer().cite(await d.context.docs.ask(String(req.body?.query ?? '')));
    if (!d.closed) d.commit([{ type: 'context.docs', data: { status: d.context.docs.status() } }]);
    return { ...result, intake: answer().status };
  });
  app.get('/api/context/answer/file', async (req: R<unknown, { path?: string; revision?:string }>) => {
    const file = answer().file(String(req.query.path ?? ''));
    if (!file) throw new CommandError('That file is not part of the indexed committed revision', 404);
    if(req.query.revision&&req.query.revision!==file.revision)throw new CommandError('The cited revision is no longer indexed. Search again to get current source lines.',409);
    return file;
  });
  app.get('/api/context/answer/structure', async (req: R<unknown, { file?: string }>) => {
    const m = answer().manifest, g = m.meta('current');
    if (!g) return { generation: null, summary: null, central: [], file: null };
    const summary = m.structureSummary(g);
    const file = req.query.file ? { path: req.query.file, symbols: m.symbolsOf(g, req.query.file), edges: m.edgesOf(g, req.query.file, 60) } : null;
    return redactMetadata({ generation: g, revision: answer().generation?.revision ?? null, summary: summary ? { ...summary, external: undefined } : null, central: m.central(g, 15), file, note: 'Parsed declaratively from committed source (imports, module declarations and documentation path mentions). It is not a call graph and not Graphify.' },s=>d.redactText(s));
  });
  app.get('/api/context/answer/models', async () => {
    const docs = d.context.docs;
    if (!docs) return { endpoint: null, reachable: false, models: [], note: 'No project knowledge is connected.' };
    const endpoint = docs.cfg.endpoint;
    let host = '';
    try { host = new URL(endpoint).hostname; } catch { /* invalid */ }
    if (!LOOPBACK.has(host)) return { endpoint, reachable: false, models: [], note: 'Only a local model service on this Mac is checked.' };
    try {
      const r = await d.egress.fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(4000) });
      if (!r.ok) return { endpoint, reachable: false, models: [], note: `Local model service returned HTTP ${r.status}.` };
      const body = await r.json() as { models?: { name?: string; size?: number; details?: { family?: string; parameter_size?: string } }[] };
      const models = (body.models ?? []).slice(0, 100).map(m => ({ name: String(m.name ?? ''), size: typeof m.size === 'number' ? m.size : null, family: m.details?.family ?? null, parameters: m.details?.parameter_size ?? null }));
      return { endpoint, reachable: true, models, embedding: docs.cfg.embedding_model, answer: docs.cfg.answer_model ?? null, note: 'Installed models only. One Connect never downloads a model.' };
    } catch {
      return { endpoint, reachable: false, models: [], note: 'No local model service is running. Keyword search keeps working.' };
    }
  });
  app.get('/api/context/answer/packet', async (req: R<unknown, { workItemId?: string; query?: string; budget?: string }>) =>
    d.context.packets.build({ workItemId: req.query.workItemId ?? null, query: req.query.query, budget: req.query.budget ? Number(req.query.budget) : undefined }));
}
