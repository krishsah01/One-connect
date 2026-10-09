// SPDX-License-Identifier: Apache-2.0
// Project canvas: the layout of workflow frames and nodes, hidden-workflow rules and unsaved
// workflow sketches. Stored per project in the daemon's key-value store; it never starts work.
// Terminating a workflow cancels it through the workflow engine and reopens its unfinished steps.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CANVAS_LIMITS, containsSecret, continuationSketch, emptyCanvas, normalizeCanvas, type CanvasLayout } from '@acc/core';
import { CommandError, type Daemon } from '../daemon.ts';

type R<P = Record<string, string>, B = unknown> = FastifyRequest<{ Params: P; Body: B }>;
const KEY = 'canvas:layout';

interface Stored { layout: CanvasLayout; rev: number; savedAt: string | null }

function read(d: Daemon): Stored {
  const raw = d.store.kvGet(KEY);
  if (!raw) return { layout: emptyCanvas(), rev: 0, savedAt: null };
  const v = JSON.parse(raw) as Partial<Stored>;
  return { layout: normalizeCanvas(v.layout), rev: Number(v.rev) || 0, savedAt: v.savedAt ?? null };
}

function write(d: Daemon, layout: unknown, expectedRev: number | null): Stored {
  const cur = read(d);
  if (expectedRev != null && expectedRev !== cur.rev) throw new CommandError('The canvas changed in another window. Reload to see the latest layout.', 409);
  const clean = normalizeCanvas(layout);
  const json = JSON.stringify(clean);
  if (Buffer.byteLength(json) > CANVAS_LIMITS.bytes) throw new CommandError('The canvas layout is too large. Remove some sketches or hidden workflows.', 413);
  if (containsSecret(json, { denylist: d.denylist() }).length) throw new CommandError('Remove credentials from workflow names, titles or paths before saving.', 400);
  const next: Stored = { layout: clean, rev: cur.rev + 1, savedAt: d.nowIso() };
  d.store.kvSet(KEY, JSON.stringify(next));
  return next;
}

export function registerCanvasRoutes(app: FastifyInstance, d: Daemon): void {
  app.get('/api/canvas', async () => read(d));
  app.put('/api/canvas', async (req: R<Record<string, string>, { layout?: unknown; rev?: number | null }>) => write(d, req.body?.layout, req.body?.rev ?? null));

  /**
   * Terminate a finalized workflow: the engine stops its runs and cancels unfinished tasks (runs,
   * transcripts, sessions and evidence stay in the event log). Its unfinished steps reopen as an
   * editable sketch that carries each step's pickup point. Finished steps stay locked.
   */
  app.post('/api/canvas/workflows/:id/terminate', async (req: R<{ id: string }>) => {
    const w = d.state.workflows?.[req.params.id];
    if (!w) throw new CommandError('Unknown workflow', 404);
    if (w.status === 'draft') throw new CommandError('Drafts are still editable; nothing to terminate.', 409);
    if (w.status !== 'completed' && w.status !== 'canceled') await d.workflows.cancel(w.id);
    const after = d.state.workflows![w.id]!;
    const cur = read(d);
    const id = `cont-${w.id.slice(0, 40)}-v${after.version}`;
    const sketch = continuationSketch(after, d.state, id, d.nowIso());
    const frame = cur.layout.frames[w.id];
    const layout: CanvasLayout = {
      ...cur.layout,
      sketches: { ...cur.layout.sketches, [id]: sketch },
      frames: { ...cur.layout.frames, [id]: { x: (frame?.x ?? 0), y: (frame?.y ?? 0) + 420, hidden: false, showWhen: frame?.showWhen ?? { input: true, failure: true, finished: false } } },
    };
    return { sketchId: id, ...write(d, layout, cur.rev) };
  });
}
