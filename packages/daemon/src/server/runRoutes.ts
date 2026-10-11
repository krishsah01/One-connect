// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Runs: transcript pages, raw logs and run controls (stop, pause, resume, follow-ups, relay).
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { FastifyInstance } from 'fastify';
import { CommandError } from '../errors.ts';
import type { Daemon } from '../daemon.ts';
import type { Req } from './route.ts';

const LOG_PAGE_BYTES = 128 * 1024;

export function registerRunRoutes(app: FastifyInstance, d: Daemon): void {
  const known = (id: string) => {
    if (!d.state.runs[id]) throw new CommandError('unknown run', 404);
  };
  const logFile = (id: string, stream: string | undefined) => path.join(d.runs.supervisor.runDir(id), stream === 'stderr' ? 'stderr.log' : 'stdout.jsonl');

  app.get('/api/runs/:id/events', async (req: Req<unknown, { id: string }, { since?: string; limit?: string }>) => {
    known(req.params.id);
    const since = Number(req.query.since ?? 0), limit = Number(req.query.limit ?? 1000);
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new CommandError('Invalid event pagination');
    return { events: d.store.list({ runId: req.params.id, afterSeq: since, limit: Math.min(limit, 5000) }) };
  });

  app.get('/api/runs/:id/log', async (req: Req<unknown, { id: string }, { stream?: string }>, reply) => {
    known(req.params.id);
    const f = logFile(req.params.id, req.query.stream);
    return reply.type('text/plain').send(fs.existsSync(f) ? fs.createReadStream(f) : '');
  });

  app.get('/api/runs/:id/log/page', async (req: Req<unknown, { id: string }, { stream?: string; offset?: string }>) => {
    known(req.params.id);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new CommandError('Invalid log offset');
    const f = logFile(req.params.id, req.query.stream);
    if (!fs.existsSync(f)) return { text: '', offset: 0, nextOffset: 0, totalBytes: 0 };
    const fd = fs.openSync(f, 'r');
    try {
      const totalBytes = fs.fstatSync(fd).size;
      const start = Math.min(offset, totalBytes);
      const buf = Buffer.alloc(Math.min(LOG_PAGE_BYTES, totalBytes - start));
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      const decoder = new StringDecoder('utf8');
      const text = decoder.write(buf.subarray(0, n)) + (start + n === totalBytes ? decoder.end() : '');
      return { text, offset: start, nextOffset: Math.min(totalBytes, start + Buffer.byteLength(text)), totalBytes };
    } finally {
      fs.closeSync(fd);
    }
  });

  app.post('/api/runs/:id/stop', async (req: Req<{ reason?: string }>) => {
    await d.runs.stop(req.params.id, req.body?.reason ?? 'stopped by owner');
    return { ok: true };
  });
  app.post('/api/runs/:id/pause', async (req: Req) => {
    await d.runs.pause(req.params.id);
    return { ok: true };
  });
  app.post('/api/runs/:id/resume', async (req: Req) => ({ runId: await d.runs.resume(req.params.id) }));
  app.post('/api/runs/:id/send', async (req: Req<{ message: string }>) => d.runs.send(req.params.id, String(req.body?.message ?? '')));
  app.post('/api/runs/:id/nudge', async (req: Req) => d.runs.nudge(req.params.id));
  app.post('/api/runs/:id/relay', async (req: Req<{ text: string }>) => ({ handoff: await d.runs.relayResult(req.params.id, String(req.body?.text ?? '')) }));
  app.post('/api/runs/:id/accept-skeleton', async (req: Req) => {
    d.runs.acceptSkeleton(req.params.id);
    return { ok: true };
  });
}
