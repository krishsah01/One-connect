// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM, type IntegrationMerge, type ReleaseStep } from '@acc/core';
import { describe, expect, it } from 'vitest';
import { allowedHosts } from '../src/egress.ts';
import { verifyWebhookDelivery, clampPollSeconds } from '../src/adapters/hosts/webhook.ts';
import { compareMigrations, migrationHash } from '../src/infra/migrations.ts';
import { allowlistedPush } from '../src/release/runner.ts';
import { makeConfig, makeRepo, startDaemon } from './helpers.ts';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

function merge(workItemId: string, sha: string, at: string): IntegrationMerge {
  return { id: `merge_${sha.slice(0, 4)}`, workItemId, decisionId: 'dec_merge', reviewId: 'rev_test', sourceBranch: 'feature', sourceSha: 'c'.repeat(40), target: 'integration', targetShaBefore: 'd'.repeat(40), mergeSha: sha, method: 'ref', at, postChecks: { status: 'passed', evidenceIds: [], at } };
}

function draft(step: ReleaseStep, patch: Partial<ReleaseStep> = {}) {
  const next = { ...step, ...patch };
  return { id: next.id, kind: next.kind, title: next.title, owner: next.owner, command: next.command, check: next.check, rollback: next.rollback, rollbackCheck: next.rollbackCheck, target: next.target, environment: next.environment };
}

describe('release execution and live probes', () => {
  it('requires separate confirmation for custom actions, records failure, and never automatically retries a verified rollback', async () => {
    const repo = makeRepo();
    const cfg = makeConfig(repo);
    cfg.project.checks = { action: 'false', verify: 'probe', rollback: 'restore', rollback_verify: 'restore-probe' };
    const h = await startDaemon(cfg, { probe: false, server: false });
    const seen: string[] = [];
    try {
      const item = h.d.createIssue({ title: 'Ship', description: '' });
      h.d.commit([{ type: 'merge.completed', workItemId: item.id, data: { merge: merge(item.id, SHA, h.d.nowIso()) } }]);
      const plan = h.d.releasePlans.create({ workItemId: item.id });
      h.d.releasePlans.update(plan.id, { steps: [draft(plan.steps[0], { kind: 'custom', target: 'local', command: 'check:action', check: 'check:verify', rollback: 'check:rollback', rollbackCheck: 'check:rollback_verify' }), draft(plan.steps[1], { kind: 'custom', target: 'local', command: 'check:rollback', check: 'check:verify' })] });
      h.d.releasePlans.projectCommand = async (command, sha, request) => {
        seen.push(command);
        expect(h.d.state.releases[plan.id].steps[0].status).toBe('running');
        const id = h.d.state.releases[plan.id].steps[0].decisionId!;
        expect(h.d.state.decisions[id].answer).toBe('approve');
        expect(JSON.parse(h.d.store.kvGet(`release:authorization:${id}`)!).status).toBe('reserved');
        return { status: command === 'false' ? 'failed' : 'passed', exitCode: command === 'false' ? 1 : 0, detail: 'result', sha, runtimeKey: plan.steps[0].environment, proof: request ? { ...request, ok: true, source: 'probe', detail: 'actual state checked', observedAt: new Date().toISOString() } : undefined };
      };
      const opened = h.d.releasePlans.requestStep(plan.id, plan.steps[0].id);
      expect(opened.decision.confirmOptions).toEqual(['approve']);
      await expect(h.d.releasePlans.resolve(opened.decision.id, 'approve')).rejects.toThrow(/confirmation/);
      expect(seen).toEqual([]);
      const prep = h.d.decisions.prepare(opened.decision.id, 'approve');
      const result = await h.d.releasePlans.resolve(opened.decision.id, 'approve', { nonce: prep.nonce });
      expect(result.status).toBe('failed');
      expect(seen).toEqual(['false', 'probe']);
      expect(() => h.d.releasePlans.requestStep(plan.id, plan.steps[1].id)).toThrow(/cannot be skipped/);
      const rollback = h.d.releasePlans.requestRollback(plan.id, plan.steps[0].id);
      const rp = h.d.decisions.prepare(rollback.decision.id, 'approve');
      const rolled = await h.d.releasePlans.resolve(rollback.decision.id, 'approve', { nonce: rp.nonce });
      expect(rolled.status).toBe('failed');
      expect(rolled.evidence.ok).toBe(true);
      expect(seen).toEqual(['false', 'probe', 'restore', 'restore-probe']);
      await expect(h.d.releasePlans.resolve(rollback.decision.id, 'approve', { nonce: rp.nonce })).rejects.toThrow(/missing|answered/);
      expect(h.d.state.releases[plan.id].steps[1].status).toBe('pending');
      expect(h.d.releasePlans.requestStep(plan.id, plan.steps[0].id).decision.answer).toBeNull();
    } finally { await h.close(); }
  });

  it('builds actual exact-SHA Git and PR commands for the integration source, with second confirmation on PRs', async () => {
    const h = await startDaemon(makeConfig(makeRepo(), { code_host: { provider: 'github', repo: 'acme/widgets' } }), { probe: false, server: false });
    try {
      const item = h.d.createIssue({ title: 'Ship', description: '' });
      h.d.commit([{ type: 'merge.completed', workItemId: item.id, data: { merge: merge(item.id, SHA, h.d.nowIso()) } }]);
      const plan = h.d.releasePlans.create({ workItemId: item.id });
      expect(plan.steps[0]).toMatchObject({ target: 'integration', command: allowlistedPush('github', 'acme/widgets', 'integration', SHA), check: 'remote-ref' });
      expect(plan.steps[1].command).toContain('--base main --head integration');
      expect(plan.steps[1].command).toContain('github.com/acme/widgets');
      h.d.releasePlans.update(plan.id, { steps: [draft(plan.steps[1])] });
      const opened = h.d.releasePlans.requestStep(plan.id, plan.steps[1].id);
      expect(opened.decision.confirmOptions).toEqual(['approve']);
      await expect(h.d.releasePlans.resolve(opened.decision.id, 'approve')).rejects.toThrow(/confirmation/);
    } finally { await h.close(); }
  });

  it('invalidates approval on command, environment, SHA, check, host/repo or config changes', async () => {
    const h = await startDaemon(makeConfig(makeRepo(), { code_host: { provider: 'github', repo: 'acme/widgets' } }), { probe: false, server: false });
    try {
      const item = h.d.createIssue({ title: 'Ship', description: '' });
      h.d.commit([{ type: 'merge.completed', workItemId: item.id, data: { merge: merge(item.id, SHA, h.d.nowIso()) } }]);
      const plan = h.d.releasePlans.create({ workItemId: item.id });
      h.d.releasePlans.update(plan.id, { steps: [draft(plan.steps[0], { kind: 'custom' })] });
      const opened = h.d.releasePlans.requestStep(plan.id, plan.steps[0].id);
      const prep = h.d.decisions.prepare(opened.decision.id, 'approve');
      h.d.config = { ...h.d.config, code_host: { ...h.d.config.code_host!, provider: 'github', repo: 'other/repo' } };
      await expect(h.d.releasePlans.resolve(opened.decision.id, 'approve', { nonce: prep.nonce })).rejects.toThrow(/configuration/);
      expect(h.d.state.decisions[opened.decision.id].answer).toBeNull();
      const fresh = h.d.releasePlans.requestStep(plan.id, plan.steps[0].id);
      h.d.releasePlans.update(plan.id, { steps: [draft(h.d.state.releases[plan.id].steps[0], { check: 'changed' })] });
      await expect(h.d.releasePlans.resolve(fresh.decision.id, 'approve')).rejects.toThrow(/missing|changed/);
      const again = h.d.releasePlans.requestStep(plan.id, plan.steps[0].id);
      h.d.config.project.check_runtime = { mode: 'docker', image: 'node:24', endpoint: 'unix:///var/run/docker.sock', cpus: 1, memory_mb: 512, pids: 128, workspace_mb: 1024, timeout_seconds: 900 };
      await expect(h.d.releasePlans.resolve(again.decision.id, 'approve')).rejects.toThrow(/environment changed/);
      h.d.commit([{ type: 'merge.completed', workItemId: item.id, data: { merge: { ...merge(item.id, SHA2, '2099-01-01T00:00:00.000Z'), id: 'new_merge' } } }]);
      await expect(h.d.releasePlans.resolve(again.decision.id, 'approve')).rejects.toThrow(/source SHA.*changed/);
    } finally { await h.close(); }
  });

  it('labels device attestation as unverified and records an interrupted decision before restart without replay', async () => {
    const cfg = makeConfig(makeRepo());
    cfg.project.checks = { action: 'write', verify: 'probe' };
    const h = await startDaemon(cfg, { probe: false, server: false });
    let calls = 0;
    try {
      const plan = h.d.releasePlans.create({ name: 'QA' });
      const qa = plan.steps.find(s => s.kind === 'device_qa')!;
      h.d.releasePlans.update(plan.id, { steps: [draft(qa, { command: 'attest:device' })] });
      const opened = h.d.releasePlans.requestStep(plan.id, qa.id);
      const attested = await h.d.releasePlans.resolve(opened.decision.id, 'approve');
      expect(attested).toMatchObject({ status: 'failed', executed: false, evidence: { ok: null, attestation: 'human' } });
      expect(h.d.state.releases[plan.id].status).toBe('active');
      const item = h.d.createIssue({ title: 'Write', description: '' });
      h.d.commit([{ type: 'merge.completed', workItemId: item.id, data: { merge: merge(item.id, SHA, h.d.nowIso()) } }]);
      const writing = h.d.releasePlans.create({ workItemId: item.id });
      h.d.releasePlans.update(writing.id, { steps: [draft(writing.steps[0], { kind: 'custom', command: 'check:action', check: 'check:verify', target: 'local' })] });
      const action = h.d.releasePlans.requestStep(writing.id, writing.steps[0].id);
      const prep = h.d.decisions.prepare(action.decision.id, 'approve');
      h.d.releasePlans.projectCommand = async () => {
        calls += 1;
        expect(h.d.state.decisions[action.decision.id].answer).toBe('approve');
        expect(h.d.state.decisions[action.decision.id].confirmedAt).toBeTruthy();
        h.d.closed = true;
        return { status: 'passed', exitCode: 0, detail: 'effect completed before process stopped' };
      };
      await h.d.releasePlans.resolve(action.decision.id, 'approve', { nonce: prep.nonce });
      expect(calls).toBe(1);
      expect(h.d.state.releases[writing.id].steps[0].status).toBe('running');
      h.d.closed = false;
      const dataDir = h.dataDir;
      await h.close();
      const restored = await startDaemon(cfg, { probe: false, server: false, dataDir });
      try {
        expect(restored.d.state.decisions[action.decision.id].answer).toBe('approve');
        expect(restored.d.state.releases[writing.id].steps[0].status).toBe('uncertain');
        expect(restored.d.store.kvGet(`release:authorization:${action.decision.id}`)).toContain('uncertain');
        expect(() => restored.d.releasePlans.requestStep(writing.id, writing.steps[0].id)).toThrow(/will not be run again/);
        await expect(restored.d.releasePlans.resolve(action.decision.id, 'approve')).rejects.toThrow(/missing|answered/);
        const inspect = restored.d.releasePlans.requestInspection(writing.id, writing.steps[0].id);
        restored.d.releasePlans.projectCommand = async () => ({ status: 'unavailable', exitCode: null, detail: 'no probe' });
        const inspected = await restored.d.releasePlans.resolve(inspect.decision.id, 'attested');
        expect(inspected.status).toBe('uncertain');
        expect(inspected.evidence.attestation).toBe('human');
        expect(calls).toBe(1);
      } finally { await restored.close(); }
    } finally { h.d.closed = false; await h.close().catch(() => undefined); }
  });

  it('verifies webhook deliveries without registering a hook and polls on a bounded interval', async () => {
    expect(clampPollSeconds(1)).toBe(15);
    expect(clampPollSeconds(9000)).toBe(300);
    const secret = 'webhook-secret-value';
    const body = JSON.stringify({ zen: 'ok', timestamp: Math.floor(Date.now() / 1000) });
    const headers = { 'x-github-delivery': 'delivery-1', 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, 'x-github-timestamp': String(Math.floor(Date.now() / 1000)) };
    const seen = new Map<string, number>();
    const ok = verifyWebhookDelivery({ provider: 'github', secret, body, headers, nowMs: Date.now(), limits: { maxSkewSeconds: 60, replayWindowSeconds: 300 }, seen: (id) => seen.get(id) ?? null });
    expect(ok.ok).toBe(true);
    if (ok.ok) seen.set(ok.id, Date.now() + 300_000);
    expect(verifyWebhookDelivery({ provider: 'github', secret, body, headers, nowMs: Date.now(), limits: { maxSkewSeconds: 60, replayWindowSeconds: 300 }, seen: (id) => seen.get(id) ?? null }).ok).toBe(false);
    expect(verifyWebhookDelivery({ provider: 'github', secret: 'other-secret-value', body, headers, nowMs: Date.now(), limits: { maxSkewSeconds: 60, replayWindowSeconds: 300 }, seen: () => null }).ok).toBe(false);
    const stale = verifyWebhookDelivery({ provider: 'github', secret, body, headers: { ...headers, 'x-github-delivery': 'delivery-2', 'x-github-timestamp': '100' }, nowMs: Date.now(), limits: { maxSkewSeconds: 60, replayWindowSeconds: 300 }, seen: () => null });
    expect(stale.ok).toBe(false);

    let called = false;
    const h = await startDaemon(makeConfig(makeRepo(), { code_host: { provider: 'github', repo: 'acme/widgets', poll_seconds: 30, webhook: { secret_account: 'github-webhook', max_skew_seconds: 60, replay_window_seconds: 300 } } }), {
      probe: false,
      server: false,
      baseEnv: { PATH: process.env.PATH ?? '', ACC_SECRET_GITHUB_WEBHOOK: secret },
      fetch: async () => { called = true; throw new Error('webhook code must not call the host'); },
    });
    try {
      const accepted = await h.d.hosts.acceptDelivery({ headers, body });
      expect(accepted.registered).toBe(false);
      expect(accepted.ok).toBe(true);
      expect(called).toBe(false);
      const replay = await h.d.hosts.acceptDelivery({ headers, body });
      expect(replay.ok).toBe(false);
      expect(replay.reason).toMatch(/already accepted/);
      const snap = await h.d.hosts.refresh();
      expect(snap.delivery).toMatchObject({ registered: false, pollSeconds: 30, webhook: 'configured' });
      expect(snap.delivery.lastDeliveryAt).toBeTruthy();
      expect(called).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('calls api.github.com only after activation and an allowlist entry, using an injected fixture token', async () => {
    const repo = makeRepo();
    const inactive = makeConfig(repo, { code_host: { provider: 'github', repo: 'acme/widgets', host: 'api.github.com', scopes: ['repo'], activated: false } });
    expect(allowedHosts(inactive)).not.toContain('api.github.com');
    let calls = 0;
    const off = await startDaemon(inactive, { probe: false, server: false, baseEnv: { PATH: process.env.PATH ?? '', ACC_SECRET_GITHUB: 'test-token-value' }, fetch: async () => { calls += 1; throw new Error('no call before activation'); } });
    try {
      const snap = await off.d.hosts.refresh();
      expect(calls).toBe(0);
      expect(snap.source).toBe('unconfigured');
      expect(snap.protected).toBeNull();
    } finally {
      await off.close();
    }

    const cfg = makeConfig(repo, { code_host: { provider: 'github', repo: 'acme/widgets', host: 'api.github.com', scopes: ['repo'], activated: true } });
    expect(allowedHosts(cfg)).not.toContain('api.github.com');
    const seen: { url: string; authorization: string | null }[] = [];
    const on = await startDaemon(cfg, {
      probe: false,
      server: false,
      baseEnv: { PATH: process.env.PATH ?? '', ACC_SECRET_GITHUB: 'test-token-value' },
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({ url, authorization: headers.get('authorization') });
        const pathName = new URL(url).pathname;
        if (pathName.endsWith('/protection')) return new Response('{"required_status_checks":{}}', { status: 200, headers: { 'x-oauth-scopes': 'repo' } });
        if (pathName.endsWith('/pulls')) return new Response('[]', { status: 200, headers: { 'x-oauth-scopes': 'repo' } });
        if (pathName.includes('/check-runs')) return new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }), { status: 200 });
        if (pathName.includes('/commits/')) return new Response(JSON.stringify({ sha: SHA }), { status: 200 });
        return new Response('{}', { status: 404 });
      },
    });
    try {
      on.d.connectors.save({ id: 'gh-read', name: 'fixture read', config: on.d.connectors.defaults().github }, null);
      const readDecision = on.d.connectors.requestActivation('gh-read', 'read').decision!;
      const prepared = on.d.decisions.prepare(readDecision.id, 'approve');
      await on.d.decisions.respond(readDecision.id, 'approve', { nonce: prepared.nonce });
      on.d.egress.allowed.splice(0, on.d.egress.allowed.length, ...on.d.egress.allowed.filter((host) => host !== 'api.github.com'));
      const blocked = await on.d.hosts.refresh({ live: true, connectorId: 'gh-read' });
      expect(seen).toHaveLength(0);
      expect(blocked.source).toBe('refused');
      expect(blocked.error).toMatch(/allowlist/);
      on.d.refreshEgress();
      const live = (await on.d.connectors.readRelease('gh-read')).result as import('@acc/core').CodeHostSnapshot;
      expect(live.source).toBe('live');
      expect(live.protected).toBe(true);
      expect(live.checks[0]).toMatchObject({ status: 'passed', sha: SHA });
      expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/widgets/branches/main/protection');
      expect(seen[0]?.authorization).toBe('Bearer test-token-value');
      expect(JSON.stringify(live)).not.toContain('test-token-value');
    } finally {
      await on.close();
    }
  });

  it('reads GitLab, Vercel and Supabase after explicit connector Decisions and reports hash mismatch', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'supabase/migrations'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'supabase/migrations/20240101120000_init.sql'), '-- init\n');
    const hash = migrationHash('-- init\n');
    const cfg = makeConfig(repo, {
      code_host: { provider: 'gitlab', project: 'acme/widgets', host: 'gitlab.example.com', scopes: ['read_api'], activated: true, finding_issues: 'rule' },
      infra: {
        finding_issues: 'rule',
        vercel: { project: 'app', host: 'api.vercel.com', scopes: ['deployments:read'], activated: true },
        supabase: { project_ref: 'ref', host: 'api.supabase.com', scopes: ['database:read'], activated: true },
      },
    });
    expect(allowedHosts(cfg)).toEqual(expect.not.arrayContaining(['gitlab.example.com', 'api.vercel.com', 'api.supabase.com']));
    const urls: string[] = [];
    const h = await startDaemon(cfg, {
      probe: false,
      server: false,
      baseEnv: { PATH: process.env.PATH ?? '', ACC_SECRET_GITLAB: 'gl-token-value', ACC_SECRET_VERCEL: 'vercel-token-value', ACC_SECRET_SUPABASE: 'supabase-token-value' },
      fetch: async (url, init) => {
        urls.push(url);
        const auth = new Headers(init?.headers).get('authorization');
        if (url.includes('gitlab.example.com') && auth !== 'Bearer gl-token-value') return new Response('{}', { status: 401 });
        if (url.includes('/protected_branches')) return new Response(JSON.stringify([{ name: 'main' }]), { status: 200 });
        if (url.includes('/merge_requests')) return new Response('[]', { status: 200 });
        if (url.endsWith('/repository/branches/main')) return new Response(JSON.stringify({ commit: { id: SHA } }), { status: 200 });
        if (url.includes('/pipelines')) return new Response(JSON.stringify([{ id: 3, status: 'failed', sha: SHA }]), { status: 200 });
        if (url.includes('api.vercel.com')) return new Response(JSON.stringify({ deployments: [{ uid: 'dpl_1', readyState: 'READY' }] }), { status: 200 });
        if (url.includes('api.supabase.com')) return new Response(JSON.stringify([{ version: '20240101120000_init', hash: 'not-the-file' }]), { status: 200 });
        return new Response('{}', { status: 404 });
      },
    });
    try {
      h.d.environment.status = async () => ({ availability: { engine: false, error: 'offline fixture' }, services: [] }) as unknown as Awaited<ReturnType<typeof h.d.environment.status>>;
      for (const kind of ['gitlab', 'vercel', 'supabase'] as const) {
        h.d.connectors.save({ id: kind, name: kind, config: h.d.connectors.defaults()[kind] }, null);
        const decision = h.d.connectors.requestActivation(kind, 'read').decision!;
        const prepared = h.d.decisions.prepare(decision.id, 'approve');
        await h.d.decisions.respond(decision.id, 'approve', { nonce: prepared.nonce });
      }
      const host = (await h.d.connectors.readRelease('gitlab')).result as import('@acc/core').CodeHostSnapshot;
      expect(host.source).toBe('live');
      expect(host.protected).toBe(true);
      expect(host.checks[0]?.status).toBe('failed');
      expect(urls.some((url) => url.startsWith('https://gitlab.example.com/api/v4/projects/acme%2Fwidgets/'))).toBe(true);
      await h.d.connectors.readRelease('vercel');
      const health = (await h.d.connectors.readRelease('supabase')).result as import('@acc/core').InfraHealthReport;
      expect(health.vercel).toMatchObject({ state: 'ready', source: 'live' });
      expect(health.migrations.state).toBe('drift');
      expect(health.migrations.hashMismatch).toEqual(['20240101120000']);
      expect(health.migrations.hashMismatch).not.toEqual([hash]);
      h.d.outbox.stop();
      h.d.findings.maybeAuto();
      const item = Object.values(h.d.state.workItems).find((w) => w.labels.includes('ci'));
      expect(item?.sync.status).toBe('pending');
      expect(h.d.store.pendingOutbox(h.d.nowIso()).some((row) => row.workItemId === item?.id && row.op === 'create_issue')).toBe(true);
      h.d.findings.maybeAuto();
      expect(Object.values(h.d.state.workItems).filter((w) => w.labels.includes('ci'))).toHaveLength(1);
      const drift = h.d.findings.link('migration_drift');
      expect(drift.sync).toBe('pending');
      expect(compareMigrations(['20240101120000_init'], ['20240101120000_init'], 'live', undefined, { repo: { '20240101120000_init': hash }, applied: {} }).detail).toMatch(/Hash comparison unavailable/);
    } finally {
      await h.close();
    }
  });
});
