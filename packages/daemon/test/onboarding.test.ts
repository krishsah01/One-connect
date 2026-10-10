// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BinaryInfo } from '@acc/core';
import { agentHasNewerBinary, detectVendors } from '../src/onboarding.ts';
import { makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const binary = (path: string, version: string | null, source: BinaryInfo['source'] = 'path'): BinaryInfo => ({
  path,
  version,
  prerelease: false,
  source,
});

describe('onboarding report', () => {
  it('exposes installed vendors and configured agent ids without performing login', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const token = fs.readFileSync(h.d.paths.installToken, 'utf8').trim();
    const r = await (await fetch(`${h.url}/api/onboarding`, { headers: { authorization: `Bearer ${token}` } })).json() as {
      vendors: { adapter: string; configuredAgents: string[]; candidates: BinaryInfo[] }[];
      agents: { id: string; auth: { state: string } }[];
    };
    expect(r.vendors.some(v => v.adapter === 'cursor-agent-cli')).toBe(true);
    expect(r.agents.map(a => a.id)).toContain('cursor');
    expect(r.vendors.find(v => v.adapter === 'cursor-agent-cli')?.configuredAgents).toContain('cursor');
  });

  it('reports when a probed agent has a newer installed binary than its pin', () => {
    const newer = agentHasNewerBinary({
      binary: binary('/old/cursor-agent', '1.0.0', 'config'),
      binaryCandidates: [binary('/old/cursor-agent', '1.0.0', 'config'), binary('/new/cursor-agent', '1.2.0')],
    });
    expect(newer?.path).toBe('/new/cursor-agent');
    expect(agentHasNewerBinary({ binary: binary('/only', '2.0.0'), binaryCandidates: [binary('/only', '2.0.0')] })).toBeNull();
  });

  it('detects vendors for configured and unconfigured adapters', async () => {
    const vendors = await detectVendors([{ adapter: 'cursor-agent-cli', id: 'cursor' }]);
    expect(vendors.find(v => v.adapter === 'cursor-agent-cli')?.configuredAgents).toEqual(['cursor']);
    expect(vendors.find(v => v.adapter === 'codex-cli')?.configuredAgents).toEqual([]);
  });
});
