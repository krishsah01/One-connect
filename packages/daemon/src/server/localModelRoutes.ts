// SPDX-License-Identifier: Apache-2.0
// Bundled local models (summary agent and embeddings) for One Ask and the canvas Summary node.
// Available only when the desktop app passes its models folder; nothing is downloaded.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { containsSecret } from '@acc/core';
import { CommandError, type Daemon } from '../daemon.ts';
import { LocalModels, localModelsDir } from '../localModels.ts';

type R<B = unknown> = FastifyRequest<{ Body: B }>;

export function registerLocalModelRoutes(app: FastifyInstance, d: Daemon, models = new LocalModels({ dir: localModelsDir(), log: msg => console.log(msg) })): LocalModels {
  models.startBridge();
  app.addHook('onClose', async () => { await models.close(); });

  app.get('/api/local-models', async () => models.status());

  app.post('/api/local-models/summarize', async (req: R<{ question?: string; text?: string; sources?: { path: string; excerpt: string }[] }>) => {
    if (!models.status().available) throw new CommandError('The bundled summary model is not available in this build. Use the desktop app.', 409);
    const b = req.body ?? {};
    const sources = Array.isArray(b.sources) ? b.sources.slice(0, 12).map(s => ({ path: String(s?.path ?? ''), excerpt: String(s?.excerpt ?? '') })) : [];
    const material = JSON.stringify({ q: b.question ?? '', t: b.text ?? '', sources });
    if (containsSecret(material, { denylist: d.denylist() }).length) throw new CommandError('The material contains something that looks like a credential, so it was not sent to the model.', 400);
    try { return await models.summarize({ question: b.question ? String(b.question) : undefined, text: b.text ? String(b.text) : undefined, sources }); }
    catch (e) { throw new CommandError((e as Error).message, 502); }
  });

  return models;
}
