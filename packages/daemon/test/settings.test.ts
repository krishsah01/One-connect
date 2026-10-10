// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
describe('reviewed project settings', () => {
  it('saves the exact reviewed settings atomically and restores them without activating remote connections', async () => {
    const config = makeConfig(makeRepo());
    h = await startDaemon(config, { probe: false, server: false });
    const before = h.d.settings.read();
    const proposed = { ...before.settings, project: { ...before.settings.project, name: 'One project' }, code_host: { provider: 'github' as const, repo: 'owner/project', activated: true, host: 'api.github.com', scopes: ['repo:read'], finding_issues: 'manual' as const } };
    const review = h.d.settings.request(proposed, before.revision);
    expect(h.d.config.project.name).toBe('sample');
    expect(review.action).toMatchObject({ kind: 'settings', repo: config.project.repo });
    await expect(h.d.decisions.respond(review.id, 'save')).rejects.toMatchObject({ status: 428 });
    expect(() => h!.d.decisions.answer(review.id, 'save')).toThrow(/action executor/);
    const confirm = h.d.decisions.prepare(review.id, 'save');
    await h.d.decisions.respond(review.id, 'save', { nonce: confirm.nonce });
    expect(h.d.config.project.name).toBe('One project');
    expect(h.d.config.code_host?.activated).toBe(false);
    expect(h.d.store.kvGet(`settings:decision:${review.id}`)).toBeNull();
    expect(h.d.state.decisions[review.id]).toMatchObject({ answer: 'save', outcome: 'reviewed project settings saved' });
    expect(h.d.egress.log).toEqual([]);
    const dataDir = h.dataDir;
    await h.close(); h = undefined;
    h = await startDaemon(config, { dataDir, probe: false, server: false });
    expect(h.d.config.project.name).toBe('One project');
    expect(h.d.state.project?.name).toBe('One project');
    expect(h.d.config.code_host?.activated).toBe(false);
    expect(h.d.egress.log).toEqual([]);
  });

  it('refuses weakened safety and project identity changes without persisting a draft', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
    const { settings, revision } = h.d.settings.read();
    expect(() => h!.d.settings.request({ ...settings, project: { ...settings.project, repo: '/unrelated' } }, revision)).toThrow(/Repository/);
    expect(() => h!.d.settings.request({ ...settings, project: { ...settings.project, protected_branches: [] } }, revision)).toThrow(/protections/);
    expect(() => h!.d.settings.request({ ...settings, policies: { ...settings.policies, zero_extra_spend: false } }, revision)).toThrow(/Zero-extra/);
    expect(() => h!.d.settings.request({ ...settings, policies: { ...settings.policies, privacy: { strict_mcp: false } } }, revision)).toThrow(/privacy/);
    expect(h.d.store.kvGet('project:settings')).toBeNull();
  });

  it('replaced drafts and stale revisions cannot authorize later settings', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
    const { settings, revision } = h.d.settings.read();
    const first = h.d.settings.request({ ...settings, project: { ...settings.project, name: 'First' } }, revision);
    const second = h.d.settings.request({ ...settings, project: { ...settings.project, name: 'Second' } }, revision);
    expect(h.d.state.decisions[first.id].consumedAt).toBeTruthy();
    await expect(h.d.decisions.respond(first.id, 'save')).rejects.toMatchObject({ status: 409 });
    await h.d.decisions.respond(second.id, 'cancel');
    expect(h.d.config.project.name).toBe('sample');
    expect(() => h!.d.settings.request({ ...settings, project: { ...settings.project, name: 'Stale' } }, 'wrong-revision')).toThrow(/changed/);
  });
});
