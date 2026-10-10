// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { agentActor, type IntegrationMerge } from '@acc/core';
import { describe, expect, it } from 'vitest';
import { LocalTracker } from '../src/adapters/trackers/local.ts';
import { makeConfig, makeRepo, startDaemon, waitFor } from './helpers.ts';

const SHA = 'a'.repeat(40);

describe('release plans', () => {
  it('keeps ordered steps, records protected-target denial without transport, and comments the durable outcome', async () => {
    const cfg = makeConfig(makeRepo(), { code_host: { provider: 'github', repo: 'acme/widgets' } });
    const h = await startDaemon(cfg, { probe: false, server: false });
    let calls = 0;
    h.d.releasePlans.exec = async () => { calls++; throw new Error('protected target must never execute'); };
    try {
      const item = h.d.createIssue({ title: 'Ship', description: '' });
      await waitFor(() => h.d.state.workItems[item.id].trackerId);
      const merge: IntegrationMerge = { id: 'merge_test', workItemId: item.id, decisionId: 'dec_merge', reviewId: 'rev_test', sourceBranch: 'feature', sourceSha: 'b'.repeat(40), target: 'integration', targetShaBefore: 'c'.repeat(40), mergeSha: SHA, method: 'ref', at: h.d.nowIso(), postChecks: { status: 'passed', evidenceIds: [], at: h.d.nowIso() } };
      h.d.commit([{ type: 'merge.completed', workItemId: item.id, data: { merge } }]);
      const plan = h.d.releasePlans.create({ name: 'Wednesday', workItemId: item.id });
      expect(plan.sha).toBe(SHA);
      expect(plan.steps[0].target).toBe('integration');
      expect(plan.steps.map(s => s.kind)).toEqual(['push', 'pr', 'ci', 'migration_dry_run', 'backup', 'migrate', 'env_flags', 'deploy', 'verify_routes', 'device_qa']);
      expect(() => h.d.releasePlans.requestStep(plan.id, plan.steps[1].id)).toThrow(/cannot be skipped/);
      h.d.releasePlans.update(plan.id, { steps: plan.steps.map(s => ({ ...s, target: s.kind === 'push' ? 'main' : s.target })) });
      const opened = h.d.releasePlans.requestStep(plan.id, plan.steps[0].id);
      expect(opened.decision.action).toMatchObject({ kind: 'release', sha: SHA, configHash: expect.any(String) });
      expect(() => h.d.decisions.prepare(opened.decision.id, 'approve', agentActor('claude'))).toThrow(/only the human/);
      expect(() => h.d.decisions.answer(opened.decision.id, 'approve')).toThrow(/action executor/);
      await expect(h.d.releasePlans.resolve(opened.decision.id, 'approve')).rejects.toThrow(/confirmation/);
      expect(h.d.state.decisions[opened.decision.id].answer).toBeNull();
      const prep = h.d.decisions.prepare(opened.decision.id, 'approve');
      const result = await h.d.releasePlans.resolve(opened.decision.id, 'approve', { nonce: prep.nonce, channel: 'phone' });
      expect(result).toMatchObject({ executed: false, status: 'failed', evidence: { ok: false } });
      expect(result.evidence.summary).toMatch(/did not push/);
      expect(calls).toBe(0);
      expect(h.d.state.decisions[opened.decision.id]).toMatchObject({ answer: 'approve', channel: 'phone' });
      expect(h.d.store.kvGet(`release:authorization:${opened.decision.id}`)).toContain('settled');
      expect(() => h.d.releasePlans.requestStep(plan.id, plan.steps[1].id)).toThrow(/cannot be skipped/);
      const tracker = h.d.tracker as LocalTracker;
      h.d.outbox.kick();
      const note = await waitFor(() => tracker.comments(h.d.state.workItems[item.id].trackerId!).find(body => body.includes('Push')));
      expect(note).toMatch(/did not push/);
      const dataDir = h.dataDir;
      await h.close();
      const restored = await startDaemon(cfg, { probe: false, server: false, dataDir });
      try {
        expect(restored.d.state.releases[plan.id].steps[0].status).toBe('failed');
        expect(restored.d.state.decisions[opened.decision.id].answer).toBe('approve');
        await expect(restored.d.releasePlans.resolve(opened.decision.id, 'approve')).rejects.toThrow(/missing|answered/);
      } finally { await restored.close(); }
    } finally { await h.close().catch(() => undefined); }
  });
});
