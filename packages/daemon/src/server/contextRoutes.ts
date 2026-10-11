// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Shared context: the markdown vault, document questions, the code graph and context search.
import type { FastifyInstance } from 'fastify';
import { HUMAN } from '@acc/core';
import { CommandError } from '../errors.ts';
import type { Daemon } from '../daemon.ts';
import type { Req } from './route.ts';

export function registerContextRoutes(app: FastifyInstance, d: Daemon): void {
  const docs = () => {
    if (!d.context.docs) throw new CommandError('Connect a markdown vault first');
    return d.context.docs;
  };
  app.get('/api/context', async () => ({ enabled: d.context.enabled, config: d.context.knowledgeConfig, privateVault: d.context.privateVault, answer: d.context.answer.status, vault: d.context.vault?.status() ?? null, graph: d.context.graph?.status ?? null, docs: d.context.docs?.status() ?? null, brief: d.context.brief() }));
  app.post('/api/context/answer/refresh', async () => {
    void d.context.answer.refresh(true);
    return { accepted: true, status: d.context.answer.status };
  });
  app.post('/api/context/connect', async (req: Req) => {
    await d.connectKnowledge(req.body);
    return { connected: true, config: d.config.knowledge, docs: d.context.docs?.status() };
  });
  app.post('/api/context/docs/index', async () => {
    const index = docs();
    await index.index();
    const status = index.status();
    d.commit([{ type: 'context.docs', actor: HUMAN, data: { status } }]);
    return status;
  });
  app.post('/api/context/docs/ask', async (req: Req<{ query: string }>) => {
    const index = docs();
    // The context can be replaced (reconnect, reload) while the question is answered.
    const context = d.context;
    const result = context.answer.cite(await index.ask(String(req.body?.query ?? '')));
    if (context === d.context && !d.closed) d.commit([{ type: 'context.docs', actor: HUMAN, data: { status: index.status() } }]);
    return result;
  });
  app.post('/api/context/sync', async () => ({ written: d.context.flush() }));
  app.post('/api/context/graph/rebuild', async () => {
    await d.context.refreshGraph(true);
    return { graph: d.context.graph?.status ?? null };
  });
  app.post('/api/context/query', async (req: Req<{ query: string; graph?: boolean }>) => {
    const q = String(req.body?.query ?? '').trim();
    if (!q) throw new CommandError('query is required');
    return d.context.search(q, { graph: req.body?.graph });
  });
}
