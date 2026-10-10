// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { describe, expect, it } from 'vitest';
import type { AgentState, BinaryInfo } from '@acc/core';
import {
  agentNewerBinary,
  connectionGuidance,
  findNewerBinary,
  loginBinaryPath,
  loginBinaryStaleReason,
  vendorLoginBlockedReason,
} from '../src/lib/onboarding';

const binary = (path: string, version: string | null): BinaryInfo => ({
  path,
  version,
  prerelease: false,
  source: 'path',
});

const baseConfig = {
  id: 'cursor',
  name: 'Cursor',
  role: 'engineer',
  adapter: 'cursor-agent-cli',
  provider: 'subscription',
  model: 'newest',
} as AgentState['config'];

const agent = (overrides: Partial<AgentState> = {}): AgentState => ({
  id: 'cursor',
  config: { ...baseConfig, ...(overrides.config ?? {}) },
  status: 'idle',
  auth: { state: 'unknown' },
  billing: { mode: 'subscription', source: 'fixture', overage: 'unknown' },
  binary: binary('/opt/cursor-agent', '1.0.0'),
  binaryCandidates: [binary('/opt/cursor-agent', '1.0.0'), binary('/usr/local/bin/cursor-agent', '1.2.0')],
  models: { available: [{ id: 'composer' }], current: null, newest: 'composer', checkedAt: null },
  usage: { windows: [], status: 'unknown', checkedAt: '', source: 'fixture' },
  limitedUntil: null,
  queue: { now: null, next: [] },
  activeRunIds: [],
  idleSince: null,
  idleMsTotal: 0,
  idleWithWorkSince: null,
  pausedReason: null,
  probedAt: null,
  ...overrides,
});

describe('onboarding guidance', () => {
  it('distinguishes draft, missing, expired, unknown and stale-binary guidance', () => {
    expect(connectionGuidance(agent({ config: { ...baseConfig, enabled: false } }))).toContain('enable the runtime');
    expect(connectionGuidance(agent({ config: { ...baseConfig, enabled: false } }))).not.toContain('Sign in to the installed tool');
    expect(connectionGuidance(agent({ auth: { state: 'not_installed' } }))).toContain('Install the official runtime');
    const pinnedOnly = agent({ binaryCandidates: [binary('/opt/cursor-agent', '1.0.0')] });
    expect(connectionGuidance({ ...pinnedOnly, auth: { state: 'expired' } })).toContain('official sign-in command');
    expect(connectionGuidance({ ...pinnedOnly, auth: { state: 'unknown' } })).toContain('not been verified');
    expect(connectionGuidance(agent())).toContain('newer CLI is installed');
  });

  it('blocks vendor login until an agent is configured', () => {
    expect(vendorLoginBlockedReason({ adapter: 'cursor-agent-cli', candidates: [binary('/bin/cursor-agent', '1.0.0')], configuredAgents: [] }))
      .toContain('Create an agent');
    expect(vendorLoginBlockedReason({ adapter: 'cursor-agent-cli', candidates: [], configuredAgents: ['cursor'] }))
      .toContain('Install this runtime');
    expect(vendorLoginBlockedReason({ adapter: 'cursor-agent-cli', candidates: [binary('/bin/cursor-agent', '1.0.0')], configuredAgents: ['cursor'] }))
      .toBeNull();
  });

  it('finds newer binaries and rejects unsafe login paths', () => {
    expect(findNewerBinary(binary('/old', '1.0.0'), [binary('/old', '1.0.0'), binary('/new', '1.2.0')])?.path).toBe('/new');
    expect(agentNewerBinary(agent())?.path).toBe('/usr/local/bin/cursor-agent');
    expect(loginBinaryPath(agent(), null)).toBe('/opt/cursor-agent');
    expect(loginBinaryPath(agent({ binary: null, config: { ...baseConfig, binary: '/safe/path' } }), null)).toBe('/safe/path');
    expect(loginBinaryPath(agent({ binary: null, config: { ...baseConfig, binary: 'bad\npath' } }), null)).toBeNull();
  });

  it('refuses stale pinned binaries until a fresh probe refreshes the binding', () => {
    const stale = agent({
      config: { ...baseConfig, binary: '/new/pinned' },
      binary: binary('/old/probed', '1.0.0'),
    });
    expect(loginBinaryStaleReason(stale)).toContain('pinned to a different binary');
    expect(loginBinaryPath(stale, null)).toBeNull();
    const fresh = agent({
      config: { ...baseConfig, binary: '/new/pinned' },
      binary: binary('/new/pinned', '1.2.0'),
    });
    expect(loginBinaryStaleReason(fresh)).toBeNull();
    expect(loginBinaryPath(fresh, null)).toBe('/new/pinned');
    expect(loginBinaryPath(agent({ binary: null, config: { ...baseConfig, binary: '/pinned-only' } }), '/vendor/default')).toBe('/pinned-only');
  });
});
