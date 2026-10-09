// SPDX-License-Identifier: Apache-2.0
// Project canvas routes: bounded, secret-free layout storage with optimistic concurrency, and
// terminate = cancel through the workflow engine plus an editable continuation of unfinished steps.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasLayout, Workflow } from '@acc/core';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

async function api<T>(hh: Harness, method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const token = fs.readFileSync(hh.d.paths.installToken, 'utf8').trim();
  const r = await fetch(`${hh.url}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.status, body: (await r.json()) as T };
}

type Stored = { layout: CanvasLayout; rev: number; error?: string };

describe('project canvas', () => {
  it('stores a sanitized layout, refuses stale writes and credentials, and survives a restart', async () => {
    const cfg = makeConfig(makeRepo());
    h = await startDaemon(cfg);
    const empty = await api<Stored>(h, 'GET', '/api/canvas');
    expect(empty.body).toMatchObject({ rev: 0, layout: { version: 1, frames: {}, nodes: {}, sketches: {} } });

    const layout = { frames: { s1: { x: 10, y: 20, hidden: false } }, nodes: { 's1/t:build': { x: 5, y: 6 } }, sketches: { s1: { name: 'Draft', tasks: [{ id: 'build', kind: 'code', agentId: 'codex' }] } }, rogue: 'dropped' };
    const saved = await api<Stored>(h, 'PUT', '/api/canvas', { layout, rev: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body.rev).toBe(1);
    expect(saved.body.layout.sketches.s1.tasks[0]).toMatchObject({ id: 'build', kind: 'code', agentId: 'codex', dependsOn: [] });
    expect(JSON.stringify(saved.body.layout)).not.toContain('rogue');

    const stale = await api<Stored>(h, 'PUT', '/api/canvas', { layout, rev: 0 });
    expect(stale.status).toBe(409);
    const secret = await api<Stored>(h, 'PUT', '/api/canvas', { layout: { sketches: { s2: { name: 'token ghp_' + 'a'.repeat(36) } } }, rev: 1 });
    expect(secret.status).toBe(400);
    expect(secret.body.error).toMatch(/credentials/i);

    const dataDir = h.dataDir;
    await h.d.shutdown();
    h = await startDaemon(cfg, { dataDir });
    const again = await api<Stored>(h, 'GET', '/api/canvas');
    expect(again.body.rev).toBe(1);
    expect(again.body.layout.frames.s1).toMatchObject({ x: 10, y: 20 });
  });

  it('terminates a finalized workflow and reopens its unfinished steps as an editable sketch', async () => {
    h = await startDaemon(makeConfig(makeRepo()));
    const item = h.d.createIssue({ title: 'Notes', description: '', acceptance: ['a notes file exists'] });
    await waitFor(() => h!.d.state.workItems[item.id].key, 5000, 'tracker key');
    const def = { name: 'Notes flow', mode: 'collaborative', tasks: [{ id: 'build', title: 'Write notes', workItemId: item.id, agentId: 'claude', kind: 'code', allowedPaths: ['notes/**'] }, { id: 'review', kind: 'review', reviewOf: 'build', agentId: 'codex' }] };
    const draft = (await api<{ workflow: Workflow }>(h, 'POST', '/api/workflows', { definition: def })).body.workflow;

    expect((await api<Stored>(h, 'POST', `/api/canvas/workflows/${draft.id}/terminate`)).status).toBe(409); // drafts stay editable
    expect((await api(h, 'POST', `/api/workflows/${draft.id}/start`)).status).toBe(200);
    // Finalized workflows are locked by the engine itself.
    expect((await api(h, 'POST', '/api/workflows', { id: draft.id, definition: def, expectedVersion: draft.version })).status).toBe(409);

    const r = await api<Stored & { sketchId: string }>(h, 'POST', `/api/canvas/workflows/${draft.id}/terminate`);
    expect(r.status).toBe(200);
    expect(h.d.state.workflows[draft.id].status).toBe('canceled');
    const sketch = r.body.layout.sketches[r.body.sketchId];
    expect(sketch).toMatchObject({ name: 'Notes flow (continued)', continues: draft.id, workflowId: null });
    expect(sketch.tasks.map(t => t.id).sort()).toEqual(['build', 'review']);
    expect(r.body.layout.frames[r.body.sketchId]).toMatchObject({ hidden: false });
    expect((await api<Stored>(h, 'GET', '/api/canvas')).body.rev).toBe(r.body.rev);
  });
});
