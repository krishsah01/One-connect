// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { createHash } from 'node:crypto';
import type { SkillDraft } from './skills.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Stable hash of a draft's stored JSON (optimistic concurrency). */
export function draftHash(draft: SkillDraft): string {
  return sha(JSON.stringify(draft));
}

export function fileSha256(content: string): string {
  return sha(content);
}

export function filesHash(files: { path: string; sha256: string }[]): string {
  return sha(files.map(f => `${f.path}\0${f.sha256}`).sort().join('\n'));
}
