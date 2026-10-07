// SPDX-License-Identifier: Apache-2.0
// Project-scoped SKILL.md skills. Versions are immutable; assignments freeze exact hashes.
import { z } from 'zod';
import type { Actor } from './entities.ts';

export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const SKILL_REFERENCE_RE = /^references\/[a-z0-9][a-z0-9_-]{0,62}\.(?:md|txt)$/;
export const SKILL_LIMITS = { instructions: 20_000, reference: 60_000, references: 12, total: 200_000 } as const;

export const SkillDraftSchema = z.object({
  id: z.string().regex(SKILL_ID_RE, 'skill id: 2–64 lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(10, 'describe when to use this skill (10+ characters)').max(400),
  instructions: z.string().trim().min(1).max(SKILL_LIMITS.instructions),
  references: z.array(z.object({
    path: z.string().regex(SKILL_REFERENCE_RE, 'references live at references/<name>.md or .txt'),
    content: z.string().min(1).max(SKILL_LIMITS.reference),
  })).max(SKILL_LIMITS.references).default([]),
}).superRefine((s, ctx) => {
  const seen = new Set<string>();
  for (const r of s.references) {
    if (seen.has(r.path)) ctx.addIssue({ code: 'custom', message: `duplicate reference ${r.path}`, path: ['references'] });
    seen.add(r.path);
  }
  const total = s.instructions.length + s.references.reduce((n, r) => n + r.content.length, 0);
  if (total > SKILL_LIMITS.total) ctx.addIssue({ code: 'custom', message: `skill is larger than ${SKILL_LIMITS.total} characters`, path: ['references'] });
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

export interface SkillFile { path: string; sha256: string; bytes: number }
export interface SkillVersion { id: string; version: number; hash: string; name: string; description: string; files: SkillFile[]; createdAt: string; by: Actor }
export interface ProjectSkill {
  id: string;
  name: string;
  description: string;
  latest: number | null;
  versions: SkillVersion[];
  draft: { hash: string; name: string; description: string; updatedAt: string } | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}
/** What an assignment froze: the exact version an agent may read, even after later edits. */
export interface SkillRef { id: string; source: 'builtin' | 'project'; version: string; hash: string; name: string; description: string }

const yamlScalar = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').trim());

/** Provider-compatible SKILL.md: YAML name/description frontmatter, then concise instructions. */
export function skillMarkdown(d: Pick<SkillDraft, 'id' | 'description' | 'instructions' | 'references'>): string {
  const refs = d.references.length ? `\n\n## References (load on demand)\n\n${d.references.map(r => `- ${r.path}`).join('\n')}\n` : '\n';
  return `---\nname: ${d.id}\ndescription: ${yamlScalar(d.description)}\n---\n\n${d.instructions.trim()}${refs}`;
}

/** Advisory only: skills should stay short and move detail into on-demand references. */
export function skillAdvice(d: SkillDraft): string[] {
  const out: string[] = [];
  if (d.instructions.length > 6000) out.push('Instructions exceed 6,000 characters. Keep SKILL.md concise and move detail into references the agent loads only when needed.');
  if (!/\b(use|when|for)\b/i.test(d.description)) out.push('Say when to use this skill in the description; agents see only descriptions until they load a skill.');
  for (const r of d.references) if (!d.instructions.includes(r.path)) out.push(`${r.path} is never mentioned in the instructions, so agents will not know when to load it.`);
  return out;
}
