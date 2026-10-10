// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { HUMAN } from '@acc/core';
import { makeConfig, makeRepo, startDaemon, type Harness } from './helpers.ts';

const LINEAR_KEY = `lin_api_${'k'.repeat(32)}`;
let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

describe('connector activation phone confirmation', () => {
  it('requires confirmOptions approve binding through prepare and answerAtomic', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false, baseEnv: { ...process.env, ACC_SECRET_LINEAR: LINEAR_KEY } });
    const d = h.d;
    d.connectors.save({ id: 'eng-linear', name: 'Eng Linear', config: { kind: 'linear', team: 'ENG' } }, null);
    const req = d.connectors.requestActivation('eng-linear', 'import');
    expect(req.decision!.confirmOptions).toEqual(['approve']);
    await expect(d.connectors.resolve(req.decision!.id, 'approve')).rejects.toThrow(/confirm this irreversible action/i);
    const prep = d.decisions.prepare(req.decision!.id, 'approve');
    expect(prep.confirm).toBe(true);
    await d.connectors.resolve(req.decision!.id, 'approve', HUMAN, { nonce: prep.nonce });
    expect(d.state.decisions[req.decision!.id]).toMatchObject({ answer: 'approve', confirmedAt: expect.any(String) });
    await expect(d.connectors.resolve(req.decision!.id, 'approve', HUMAN, { nonce: prep.nonce })).rejects.toThrow(/already used/);
  });
});
