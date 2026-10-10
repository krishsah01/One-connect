// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { describe, expect, it } from 'vitest';
import { candidatesFromEvents, candidatesFromTick, defaultNotificationConfig, defaultRemoteConfig, inQuietHours, remoteRouteDecision, remoteDecisionAccess } from '../src/phone.ts';
import type { Decision } from '../src/entities.ts';
import { genericEventHealth } from '../src/reports.ts';

describe('remote access policy', () => {
  it('is off by default and allows only listed routes within granted scopes', () => {
    expect(defaultRemoteConfig().enabled).toBe(false);
    const all = ['read', 'transcript', 'decisions', 'kill_switch'] as const;
    expect(remoteRouteDecision('GET', '/api/state', all)).toMatchObject({ allow: true });
    expect(remoteRouteDecision('POST', '/api/decisions/d1/answer', all)).toMatchObject({ allow: true, mutation: true });
    for (const [m, p] of [['GET', '/api/assignments/a/diff'], ['GET', '/api/connections'], ['POST', '/api/remote/pairings'], ['POST', '/api/projects'], ['GET', '/api/context'], ['POST', '/api/issues'], ['GET', '/api/docker'], ['GET', '/api/state/../connections']] as const) {
      expect(remoteRouteDecision(m, p, all).allow, `${m} ${p}`).toBe(false);
    }
    expect(remoteRouteDecision('GET', '/api/runs/r1/events', ['read'])).toMatchObject({ allow: false });
    expect(remoteRouteDecision('GET', '/api/team', ['read'])).toMatchObject({ allow: true });
    expect(remoteRouteDecision('GET', '/api/team/messages', ['read'])).toMatchObject({ allow: false });
    expect(remoteRouteDecision('GET', '/api/team/messages', ['transcript'])).toMatchObject({ allow: true });
    expect(remoteRouteDecision('POST', '/api/kill-switch', all, { engaged: false })).toMatchObject({ allow: false });
    expect(remoteRouteDecision('POST', '/api/kill-switch', all, { engaged: true })).toMatchObject({ allow: true });
    expect(remoteRouteDecision('POST', '/api/kill-switch', ['read'], { engaged: true })).toMatchObject({ allow: false });
  });
  it.each(['question', 'merge', 'docker', 'environment', 'release', 'cost', 'settings', 'connector'])('permits exact project %s Decisions only with the decision grant', kind => {
    const dec = { kind } as Pick<Decision, 'kind'>;
    expect(remoteDecisionAccess(dec, ['read']).allow).toBe(false);
    expect(remoteDecisionAccess(dec, ['decisions']).allow).toBe(true);
  });
  it('requires a separate tunnel decision grant and distinguishes single messages from endpoint reviews', () => {
    expect(defaultRemoteConfig().scopes).not.toContain('remote_decisions');
    expect(remoteDecisionAccess({ kind: 'remote' }, ['decisions']).allow).toBe(false);
    expect(remoteDecisionAccess({ kind: 'remote' }, ['remote_decisions']).allow).toBe(false);
    expect(remoteDecisionAccess({ kind: 'remote' }, ['decisions', 'remote_decisions']).allow).toBe(true);
    expect(remoteDecisionAccess({ kind: 'notification' }, ['decisions'], true).allow).toBe(true);
    expect(remoteDecisionAccess({ kind: 'notification' }, ['decisions'], false).allow).toBe(false);
    expect(remoteDecisionAccess({ kind: 'other' } as unknown as Pick<Decision, 'kind'>, ['decisions']).allow).toBe(false);
  });

});

describe('notification policy', () => {
  it('has every external channel off by default and no email', () => {
    const c = defaultNotificationConfig();
    expect([c.channels.native.enabled, c.channels.browser.enabled, c.channels.webpush.enabled, c.channels.chat.enabled]).toEqual([false, false, false, false]);
    expect(Object.keys(c.channels)).not.toContain('email');
  });

  it('handles quiet hours across midnight and in a named zone', () => {
    const q = { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC' };
    expect(inQuietHours(q, new Date('2026-01-01T23:30:00Z'))).toBe(true);
    expect(inQuietHours(q, new Date('2026-01-01T03:00:00Z'))).toBe(true);
    expect(inQuietHours(q, new Date('2026-01-01T12:00:00Z'))).toBe(false);
    expect(inQuietHours({ ...q, timezone: 'Asia/Tokyo' }, new Date('2026-01-01T14:00:00Z'))).toBe(true); // 23:00 in Tokyo
    expect(inQuietHours({ ...q, enabled: false }, new Date('2026-01-01T23:30:00Z'))).toBe(false);
    expect(inQuietHours({ ...q, start: '08:00', end: '08:00' }, new Date('2026-01-01T08:00:00Z'))).toBe(false);
  });

  const state: any = { agents: { a: { id: 'a', config: { name: 'Codex' }, limitedUntil: null } }, runs: { r1: { id: 'r1', agentId: 'a', workItemId: 'w', state: 'stalled', exit: null } }, workItems: { w: { key: 'LOC-1', title: 'secret title sk-xxx' } }, approvals: {}, decisions: {}, alerts: {} };
  it('puts no issue titles, transcripts or free text in the outbound summary', () => {
    const [c] = candidatesFromTick(state, Date.now(), 30);
    expect(c).toMatchObject({ kind: 'stalled_run', dedupeKey: 'stall:r1' });
    expect(c.external).toBe('Run stalled on LOC-1');
    expect(c.external).not.toContain('secret title');
  });
  it('does not substitute a private issue title when the tracker key is absent', () => {
    const [c] = candidatesFromTick({ ...state, workItems: { w: { key: null, title: 'private issue title' } } }, Date.now(), 30);
    expect(c.external).toBe('Run stalled');
  });
  it('reads release and infra failures by shape and treats unknown shapes as recorded, not healthy', () => {
    const ev = (type: string, data: unknown, seq = 1) => ({ seq, type, agentId: null, runId: null, workItemId: null, data });
    const unknownInfra = {
      checkedAt: '2026-01-01T00:00:00Z',
      docker: { state: 'unknown', detail: '' },
      postgres: { state: 'unknown', service: null, detail: '' },
      vercel: { state: 'unchecked', source: 'unconfigured', detail: '' },
      migrations: { state: 'unchecked', source: 'none', repo: [], applied: [], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: '' },
    };
    expect(candidatesFromEvents(state, [ev('infra.checked', { health: unknownInfra })])).toHaveLength(0);
    expect(candidatesFromEvents(state, [ev('infra.checked', { health: { ...unknownInfra, docker: { state: 'unavailable', detail: 'down' } } })])).toHaveLength(1);
    expect(candidatesFromEvents(state, [ev('infra.checked', { health: { ...unknownInfra, docker: { state: 'ready', detail: '' }, postgres: { state: 'ready', service: null, detail: '' }, vercel: { state: 'ready', source: 'fixture', detail: '' }, migrations: { state: 'in_sync', source: 'none', repo: [], applied: [], missingInDatabase: [], extraInDatabase: [], hashMismatch: [], detail: '' } } })])).toHaveLength(0);
    const [failedRelease] = candidatesFromEvents(state, [ev('release.saved', { plan: { id: 'p', name: 'v1', status: 'active', steps: [{ status: 'failed' }] } })]);
    expect(failedRelease.dedupeKey).toBe('release:p:failed');
    expect(candidatesFromEvents(state, [ev('release.saved', { plan: { id: 'p', name: 'v1', status: 'active', steps: [{ status: 'failed' }] } }, 99)]).map(c => c.dedupeKey)).toEqual(['release:p:failed']);
    expect(genericEventHealth('release.mystery', { foo: 1 })).toMatchObject({ failed: false, summary: 'release.mystery recorded' });
    expect(candidatesFromEvents(state, [ev('ci.pipeline', { id: 'pipe-1', status: 'error', summary: 'CI pipeline failed.' })])).toHaveLength(1);
  });
});
