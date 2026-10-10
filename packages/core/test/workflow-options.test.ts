// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { emptyState, normalizeWorkflow, validateWorkflow } from '../src/index.ts';

describe('workflow step options', () => {
  it('preserves graph options while old definitions stay valid', () => {
    const opts = { model: 'local-model', effort: 'high', skills: ['skill-one'], connectors: ['tools-one'], design: { artifactId: 'mock-one', rev: 2 }, context: 'Sources from One Ask', pickup: 'Next: implement the API', consults: ['peer'] };
    expect(normalizeWorkflow({ name: 'Graph', tasks: [{ id: 'a', ...opts }] }).tasks[0]).toMatchObject(opts);
    expect(normalizeWorkflow({ name: 'Old', tasks: [{ id: 'a' }] }).tasks[0].context).toBeUndefined();
  });
  it('rejects invalid bounds, effort, secrets and unavailable resources', () => {
    const state = emptyState();
    const codes = (options: object) => validateWorkflow(normalizeWorkflow({ name: 'Graph', tasks: [{ id: 'a', agentId: 'peer', ...options }] }), state).map(i => i.code);
    expect(codes({ context: 'x'.repeat(4001), effort: 'magic' })).toContain('task_options');
    expect(codes({ pickup: 'x'.repeat(2001) })).toContain('task_options');
    expect(codes({ context: 'Authorization: Bearer ghp_' + 'a'.repeat(36) })).toContain('secret');
    expect(codes({ skills: ['unknown'], connectors: ['unknown'], design: { artifactId: 'missing', rev: 1 }, consults: ['peer'] })).toEqual(expect.arrayContaining(['unknown_skill', 'unknown_connector', 'unknown_artifact', 'consult_self']));
  });
});
