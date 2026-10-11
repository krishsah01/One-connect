// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Project canvas: the layout of workflow frames and nodes, hidden-workflow rules and unsaved
// workflow sketches. Stored per project in the daemon's key-value store; it never starts work.
// Terminating a workflow cancels it through the workflow engine and reopens its unfinished steps.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CANVAS_LIMITS, containsSecret, continuationSketch, emptyCanvas, normalizeCanvas, type CanvasLayout } from '@acc/core';
import { CommandError } from '../errors.ts';
import type { Daemon } from '../daemon.ts';

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

/** One readable line per event for the Logs panel; data is bounded and redacted. */
function logLine(data: unknown): string {
  const o = (data ?? {}) as Record<string, unknown>;
  for (const k of ['message', 'text', 'reason', 'question', 'title', 'error', 'detail']) {
    const v = o[k] ?? (o.exit as Record<string, unknown> | undefined)?.[k];
    if (typeof v === 'string' && v.trim()) return v.slice(0, 240);
  }
  for (const k of ['run', 'workItem', 'assignment', 'workflow', 'decision', 'alert', 'approval']) {
    const v = o[k] as Record<string, unknown> | undefined;
    if (v && typeof v === 'object') return String(v.title ?? v.message ?? v.question ?? v.state ?? v.status ?? v.id ?? '').slice(0, 240);
  }
  return '';
}

export function registerCanvasRoutes(app: FastifyInstance, d: Daemon): void {
  app.get('/api/canvas', async () => read(d));
  app.get('/api/canvas/logs', async (req: FastifyRequest<{ Querystring: { after?: string; limit?: string } }>) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const tail = after === 0 ? Math.max(0, d.store.lastSeq() - limit) : after;
    const scanned = d.store.list({ afterSeq: tail, limit });
    const events = scanned.filter(e => e.kind === 'control' || e.type === 't.system' || e.type === 't.error');
    return {
      last: scanned.at(-1)?.seq ?? tail,
      events: events.map(e => ({ seq: e.seq, ts: e.ts, kind: e.kind, type: e.type, actor: e.actor?.id ?? null, agentId: e.agentId, runId: e.runId, workItemId: e.workItemId, text: d.redactText(logLine(e.data)) })),
    };
  });
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
    // The engine asks running agents for a pickup point before stopping them when it supports that.
    const engine = d.workflows as typeof d.workflows & { terminateWithPickup?: (id: string) => Promise<Record<string, string | null>> };
    let pickups: Record<string, string | null> = {};
    if (w.status !== 'completed' && w.status !== 'canceled') {
      if (engine.terminateWithPickup) pickups = await engine.terminateWithPickup(w.id);
      else await d.workflows.cancel(w.id);
    }
    const after = d.state.workflows![w.id]!;
    const cur = read(d);
    const id = `cont-${w.id.slice(0, 40)}-v${after.version}`;
    const sketch = continuationSketch(after, d.state, id, d.nowIso(), pickups);
    const frame = cur.layout.frames[w.id];
    const layout: CanvasLayout = {
      ...cur.layout,
      sketches: { ...cur.layout.sketches, [id]: sketch },
      frames: { ...cur.layout.frames, [id]: { x: (frame?.x ?? 0), y: (frame?.y ?? 0) + 420, hidden: false, showWhen: frame?.showWhen ?? { input: true, failure: true, finished: false } } },
    };
    return { sketchId: id, ...write(d, layout, cur.rev) };
  });
}
