// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { describe, expect, it } from 'vitest';
import { draftHash, filesHash, fileSha256 } from '../src/skillHash.ts';
import { skillMarkdown, SKILL_TEMPLATES, SkillDraftSchema } from '../src/skills.ts';

describe('skills core helpers', () => {
  it('builds stable draft hashes and bundle file hashes', () => {
    const draft = {
      id: 'demo-skill',
      name: 'Demo',
      description: 'Use when demonstrating hash stability in tests.',
      instructions: 'Do the thing.',
      references: [{ path: 'references/notes.md', content: 'notes' }],
      source: 'test',
      license: 'Apache-2.0',
    };
    expect(SkillDraftSchema.parse(draft).id).toBe('demo-skill');
    const h1 = draftHash(draft);
    const h2 = draftHash({ ...draft });
    expect(h1).toBe(h2);
    const md = skillMarkdown(draft);
    expect(fileSha256(md)).toHaveLength(64);
    const meta = [{ path: 'SKILL.md', sha256: fileSha256(md) }, { path: 'references/notes.md', sha256: fileSha256('notes') }];
    expect(filesHash(meta)).toHaveLength(64);
  });

  it('ships three original templates under 6000 characters', () => {
    expect(SKILL_TEMPLATES).toHaveLength(3);
    for (const t of SKILL_TEMPLATES) {
      expect(t.draft.description.toLowerCase()).toMatch(/use when/);
      expect(t.draft.instructions.length).toBeLessThan(6000);
      expect(t.license).toBe('Apache-2.0');
    }
  });
});
