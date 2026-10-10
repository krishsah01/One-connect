// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Shutdown is fault-isolated, and run-stop hooks replace monkey-patching RunManager.stop.
import { describe, expect, it } from 'vitest';
import { makeConfig, makeRepo, startDaemon } from './helpers.ts';

describe('daemon lifecycle', () => {
  it('a failing service still lets shutdown snapshot and close the event store', async () => {
    const h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
    h.d.team.stop = () => { throw new Error('boom'); };
    await expect(h.d.shutdown()).rejects.toThrow(/team: boom/);
    expect(h.d.closed).toBe(true);
    expect(() => h.d.store.kvGet('anything')).toThrow();
  });

  it('runs every registered hook before a stop', async () => {
    const h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
    const seen: string[] = [];
    h.d.runs.onBeforeStop((runId) => { seen.push(runId); });
    await expect(h.d.runs.stop('run_missing', 'test')).rejects.toMatchObject({ status: 404 });
    expect(seen).toEqual(['run_missing']);
    await h.close();
  });
});
