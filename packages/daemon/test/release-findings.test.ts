// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Provider reads are injected; no network, Keychain, tracker delivery or infra process.
import { afterEach, expect, it } from 'vitest';
import { Daemon } from '../src/daemon.ts';
import { makeConfig, tmpDir } from './helpers.ts';

const instances: Daemon[] = [];
afterEach(() => { for (const d of instances.splice(0)) { d.closed = true; d.store.close(); } });
function fixture() {
  const d = new Daemon({ config: makeConfig(tmpDir('finding-repo'), { code_host: { provider: 'github', repo: 'acme/widgets', host: 'api.github.com', scopes: ['repo'], finding_issues: 'rule' } }), dataDir: tmpDir('finding-data'), allowTempDataDir: true,
    baseEnv: { ACC_SECRET_GITHUB: 'injected-fixture-value' }, fetch: async url => {
      const body = url.endsWith('/commits/main') ? { sha: 'a'.repeat(40) } : url.endsWith('/check-runs') ? { check_runs: [{ name: 'tests', status: 'completed', conclusion: 'failure' }] } : {};
      return new Response(JSON.stringify(body), { status: url.endsWith('/protection') ? 404 : 200 });
    },
  });
  d.outbox.kick = () => {};
  instances.push(d);
  return d;
}
it('requires exact current read capability and Settings binding for live findings; refuses retained facts after edits', async () => {
  const d = fixture();
  d.connectors.save({ id: 'checks', name: 'Checks only', config: { ...d.connectors.defaults().github, capabilities: ['checks:read'] } }, null);
  const decision = d.connectors.requestActivation('checks', 'read').decision!;
  const prepared = d.decisions.prepare(decision.id, 'approve');
  await d.decisions.respond(decision.id, 'approve', { nonce: prepared.nonce });
  const result = await d.connectors.readRelease('checks');
  expect(d.connectors.releaseReadCurrent('github', 'checks:read')).toBe(true);
  expect(d.findings.active('ci')).toBe(true);
  expect(d.findings.active('unprotected_branch')).toBe(false);
  // A capability cannot borrow green/red data left over by a different read.
  d.state.codeHost = { ...d.state.codeHost!, protected: false };
  expect(d.findings.active('ci')).toBe(false);
  expect(d.findings.active('unprotected_branch')).toBe(false);
  d.state.codeHost = 'source' in result.result ? result.result : null;
  const finding = d.findings.link('ci');
  expect(finding.sync).toBe('pending');
  expect(d.findings.link('ci').item.id).toBe(finding.item.id);
  expect(d.store.pendingOutbox(d.nowIso()).filter(row => row.op === 'create_issue')).toHaveLength(1);
  d.config.project.production_branch = 'other';
  expect(d.findings.active('ci')).toBe(false);
  expect(() => d.findings.link('ci')).toThrow(/current scoped proof/);
  d.findings.maybeAuto();
  expect(Object.values(d.state.workItems)).toHaveLength(1);
});
it('does not reuse a finding from another repository/branch scope or file an issue from an unconfigured snapshot', () => {
  const d = fixture();
  d.state.codeHost = { provider: 'github', source: 'fixture', productionBranch: 'main', protected: false, protectionDetail: 'fixture main unprotected', checkedAt: d.nowIso(), error: null, checks: [], pulls: [], delivery: { registered: false, pollSeconds: 60, webhook: 'off', lastDeliveryAt: null } };
  const first = d.findings.link('unprotected_branch');
  d.config.code_host = { provider: 'github', repo: 'acme/other', host: 'api.github.com', activated: false, scopes: ['repo'], finding_issues: 'manual' };
  const second = d.findings.link('unprotected_branch');
  expect(second.item.id).not.toBe(first.item.id);
  d.state.codeHost = { ...d.state.codeHost, source: 'unconfigured' };
  expect(() => d.findings.link('unprotected_branch')).toThrow(/current scoped proof/);
});
