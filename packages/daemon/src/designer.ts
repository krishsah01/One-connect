// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Project design contract (immutable human-authored revisions with exact hashes), its drafts,
// pinned designer skills and the bounded design section of assignment prompts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  blockingFailures, containsSecret, designChecks, designCss, designDiff, designJobPrompt, designMarkdown, designSpecimenHtml, designTokensJson,
  DESIGN_RUNTIME_LIMITS, DesignSystemSchema, HUMAN, isActiveRun, isLegacyDesign, reviewPrompt, upgradeDesignInput,
  type Assignment, type DesignRevision, type DesignSkill, type WorkItem,
} from '@acc/core';
import { CommandError, type Daemon } from './daemon.ts';
import { DesignStudio } from './designStudio.ts';
import { DesignDocuments } from './designDocuments.ts';

const ROOT = fileURLToPath(new URL('../resources/designer/', import.meta.url));
interface Skill extends DesignSkill { files: { path: string; sha256: string }[] }
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')) as { skills: Skill[] };
export const builtinSkill = (id: string): Skill | undefined => manifest.skills.find(s => s.id === id);
/** Reads one pinned file verbatim after checking its manifest hash. */
export function builtinSkillFile(id: string, file: string): string {
  const s = builtinSkill(id), entry = s?.files.find(f => f.path === file);
  if (!s || !entry) throw new CommandError('Unknown skill reference', 404);
  const text = fs.readFileSync(path.join(ROOT, 'skills', id, entry.path), 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== entry.sha256) throw new CommandError('Pinned skill integrity check failed', 409);
  return text;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const DESIGN_LABEL = /^(design|ui|mock|frontend|branding)$/i;
/** Built-in sets for design work other than mock generation. Design-labelled tasks get the whole library. */
export const SKILL_SETS = {
  implementation: ['design-system-implementation', 'react-design-export', 'design-system-contract', 'accessible-product-ui', 'web-design-guidelines', 'playwright-cli'],
  review: ['visual-critique', 'accessible-product-ui', 'web-design-guidelines', 'playwright-cli', 'design-system-contract'],
} as const;
/** What each built-in is for, in one line, so the studio can explain a task's selection. */
export const SKILL_PURPOSE: Record<string, string> = {
  'taste-skill': 'Visual direction for landing pages and redesigns only; product screens follow the contract.',
  'web-design-guidelines': 'Interface review rules: forms, focus, motion, copy, performance.',
  'design-references': 'Structural lessons from licensed DESIGN.md analyses when shaping a new system.',
  'design-system-contract': 'Read and enforce the frozen project contract; propose exceptions instead of drifting.',
  'accessible-product-ui': 'Keyboard, names, contrast, zoom and reduced motion.',
  'responsive-mocks': 'Self-contained interactive mocks that work inside the isolated preview.',
  'playwright-cli': 'Browser checks with an already-installed official Playwright CLI; pending if absent.',
  'product-ui-patterns': 'Dashboards, tables, forms, settings and their complete states.',
  'typography-content': 'Hierarchy, scanning, labels and microcopy for product screens.',
  'design-system-implementation': 'Implement an approved contract and mock in application code.',
  'visual-critique': 'Independent review of one exact mock revision with honest evidence.',
  'structured-design': 'Read structured designs in sections and propose typed changes for a person to apply.',
  'visual-direction': 'Direction, palette, type, spacing, shape and motion foundations.',
  'component-architecture': 'Reusable components with variants, states, props and slots, changed safely.',
  'responsive-layouts': 'Flow layouts and breakpoint overrides for phone, tablet and desktop.',
  'interaction-prototyping': 'Prototype flows, overlays, validation, sample data and motion.',
  'forms-navigation-data': 'Forms, navigation, tables, lists and charts with complete states.',
  'localization-readiness': 'Copy and layouts that survive translation and regional formats.',
  'react-design-export': 'Implement an approved structured release with its React/TypeScript package.',
};
const DRAFT_KEY = /^(?:system|brief|refine:[A-Za-z0-9_-]{1,64}|review:[A-Za-z0-9_-]{1,64}:[0-9]{1,6}|source:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9._/-]{1,200})$/;
const DRAFT_BYTES = 600 * 1024;
/** Draft keys name a kind and, for source drafts, a mock file path without dot segments. */
const validDraftKey = (key: string) => DRAFT_KEY.test(key) && !key.split(/[:/]/).some(p => p === '..' || p === '.' || (p.startsWith('.') && p.length > 0));

export interface DesignDraft { key: string; value: unknown; savedAt: string; base: string | null }

export class Designer {
  readonly d: Daemon;
  readonly studio: DesignStudio;
  readonly documents: DesignDocuments;
  constructor(d: Daemon) { this.d = d; this.studio = new DesignStudio(d); this.documents = new DesignDocuments(d); }

  skills(): DesignSkill[] { return manifest.skills.map(({ files: _files, ...meta }) => meta); }
  hasSkill(id: string) { return manifest.skills.some(s => s.id === id); }
  /** Built-in skill ids a work item receives by its labels. */
  defaultSkillIds(item: Pick<WorkItem, 'labels'> | undefined): string[] {
    const labels = item?.labels ?? [];
    // Structured design requests get a focused set chosen per request (see DesignDocuments.aiJob).
    const set = labels.some(l => /^design-implementation$/i.test(l)) ? SKILL_SETS.implementation : labels.some(l => /^design-review$/i.test(l)) ? SKILL_SETS.review : labels.some(l => /^design-document$/i.test(l)) ? ['structured-design', 'design-system-contract'] : labels.some(l => DESIGN_LABEL.test(l)) ? manifest.skills.map(s => s.id) : [];
    return set.filter(id => this.hasSkill(id));
  }
  selected(a: Assignment): DesignSkill[] {
    const cfg = this.d.state.agents[a.agentId].config, item = this.d.state.workItems[a.workItemId];
    const ids = new Set([...(cfg.skills ?? []), ...this.defaultSkillIds(item)]);
    return this.skills().filter(s => ids.has(s.id));
  }
  readSkill(id: string, o: { file?: string; offset?: number; budget?: number } = {}) {
    const s = manifest.skills.find(s => s.id === id); if (!s) throw new CommandError('Unknown designer skill', 404);
    const file = o.file ?? 'SKILL.md', text = builtinSkillFile(id, file);
    const offset = Number.isSafeInteger(o.offset) ? Math.max(0, o.offset!) : 0, budget = Number.isFinite(o.budget) ? Math.min(12000, Math.max(1000, Math.floor(o.budget!))) : 6000;
    return { skill: { id: s.id, name: s.name, version: s.version, license: s.license, source: s.source }, file, content: this.d.redactText(text.slice(offset, offset + budget)), nextOffset: Math.min(text.length, offset + budget), more: offset + budget < text.length, references: s.files.filter(f => f.path !== file).map(f => f.path) };
  }

  // ---- contract revisions ----------------------------------------------------------------------

  revision(hash = this.d.state.design?.hash): DesignRevision | null {
    if (!hash) return null;
    if (hash === this.d.state.design?.hash) return this.d.state.design;
    const saved = this.d.store.kvGet(`design:revision:${hash}`); return saved ? JSON.parse(saved) as DesignRevision : null;
  }
  /** Every saved revision, oldest first, from the durable event log. */
  history(): DesignRevision[] {
    const seen = new Map<string, DesignRevision>();
    for (const e of this.d.store.list({ types: ['design.system_saved'], limit: 5000 })) if (e.type === 'design.system_saved') seen.set(e.data.revision.hash, this.revision(e.data.revision.hash) ?? e.data.revision);
    return [...seen.values()].sort((a, b) => a.version - b.version);
  }

  /** Parse, measure and compare a draft without saving anything. */
  validate(input: unknown) {
    const parsed = DesignSystemSchema.safeParse(upgradeDesignInput(input));
    const current = this.d.state.design;
    if (!parsed.success) return { ok: false as const, errors: parsed.error.issues.map(i => `${i.path.join('.') || 'system'}: ${i.message}`), current: current ? { hash: current.hash, version: current.version } : null };
    const system = parsed.data;
    const errors: string[] = [];
    if (containsSecret(JSON.stringify(system), { denylist: this.d.denylist() }).length) errors.push('Remove credentials from the design rules or notes.');
    const checks = designChecks(system), blocking = blockingFailures(system);
    if (blocking.length) errors.push(`Text contrast is below the minimum: ${blocking.map(c => `${c.name} ${c.ratio.toFixed(2)}:1 (needs ${c.required}:1)`).join(', ')}`);
    const hash = sha(JSON.stringify(system));
    const olderActive = Object.values(this.d.state.runs).filter(r => isActiveRun(r) && this.d.state.assignments[r.assignmentId]?.designRevision && this.d.state.assignments[r.assignmentId]!.designRevision !== hash).length;
    return {
      ok: errors.length === 0, errors, system, hash, unchanged: hash === current?.hash, checks,
      warnings: [
        ...checks.filter(c => c.blocking === false && !c.passed).map(c => `${c.name}: ${c.ratio.toFixed(2)}:1. ${c.note ?? ''}`.trim()),
        ...(olderActive ? [`${olderActive} active run${olderActive === 1 ? '' : 's'} will keep the contract frozen at dispatch; saving does not change them.`] : []),
        'Contrast is measured here. Keyboard, screen-reader, zoom and state behavior still need review on actual mocks.',
      ],
      diff: designDiff(current?.system ?? null, system),
      current: current ? { hash: current.hash, version: current.version } : null,
    };
  }

  /**
   * Save a human-authored, immutable revision. Active runs and existing assignments keep the
   * revision frozen when they were created; approvals made under an older contract show drift.
   */
  save(input: unknown, expected: string | null, note = '') {
    const v = this.validate(input);
    if (!v.ok) throw new CommandError(v.errors.join(' '), 400);
    if (expected !== (this.d.state.design?.hash ?? null)) throw new CommandError('The design system changed. Reload before saving.', 409);
    if (v.hash === expected) return this.d.state.design!;
    const text = String(note ?? '').trim().slice(0, 500);
    if (text && containsSecret(text, { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from the note.');
    const revision: DesignRevision = { hash: v.hash, system: v.system, version: (this.d.state.design?.version ?? 0) + 1, createdAt: this.d.nowIso(), by: HUMAN, parent: this.d.state.design?.hash ?? null, ...(text ? { note: text } : {}) };
    this.d.commit([{ type: 'design.system_saved', actor: HUMAN, data: { revision } }], [], () => {
      this.d.store.kvSet(`design:revision:${v.hash}`, JSON.stringify(revision));
      this.d.store.kvDelete('designer:draft:system');
    });
    return revision;
  }

  diff(from: string | null, to: string) {
    const b = this.revision(to); if (!b) throw new CommandError('Unknown design revision', 404);
    const a = from ? this.revision(from) : null; if (from && !a) throw new CommandError('Unknown design revision', 404);
    return { from: a ? { hash: a.hash, version: a.version } : null, to: { hash: b.hash, version: b.version }, changes: designDiff(a?.system ?? null, b.system) };
  }

  /** Compact export for agents (MCP) and the legacy route. */
  exports(hash?: string) {
    const r = this.revision(hash);
    return r ? { revision: r, markdown: designMarkdown(r), css: designCss(r.system), checks: designChecks(r.system), schema: isLegacyDesign(r.system) ? 1 : r.system.schema } : null;
  }
  /** Everything generated from one revision, for the studio and handoff bundles. */
  fullExports(hash?: string) {
    const r = this.revision(hash); if (!r) return null;
    const parent = r.parent ? this.revision(r.parent) : null;
    return { ...this.exports(r.hash)!, tokens: designTokensJson(r), specimen: designSpecimenHtml(r), diff: designDiff(parent?.system ?? null, r.system), parent: parent ? { hash: parent.hash, version: parent.version } : null };
  }

  // ---- drafts: never approved, never frozen into assignments ------------------------------------

  draft(key: string): DesignDraft | null {
    if (!validDraftKey(key)) throw new CommandError('Unknown draft', 400);
    const raw = this.d.store.kvGet(`designer:draft:${key}`);
    return raw ? JSON.parse(raw) as DesignDraft : null;
  }
  saveDraft(key: string, value: unknown, base: string | null = null): DesignDraft {
    if (!validDraftKey(key)) throw new CommandError('Unknown draft', 400);
    const json = JSON.stringify(value ?? null);
    if (Buffer.byteLength(json) > DRAFT_BYTES) throw new CommandError('Draft is too large', 413);
    if (containsSecret(json, { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials before saving this draft.', 400);
    const draft: DesignDraft = { key, value, savedAt: this.d.nowIso(), base: base ?? null };
    this.d.store.kvSet(`designer:draft:${key}`, JSON.stringify(draft));
    return draft;
  }
  clearDraft(key: string): void {
    if (!validDraftKey(key)) throw new CommandError('Unknown draft', 400);
    this.d.store.kvDelete(`designer:draft:${key}`);
  }

  // ---- assignment prompt section ---------------------------------------------------------------

  prompt(a: Assignment) {
    const revision = a.designRevision ? this.revision(a.designRevision) : null, skills = this.d.skillLib.forAssignment(a);
    const job = this.studio.jobForAssignment(a.id);
    const designPaths = a.allowedPaths.some(p => p === 'design/**' || p.startsWith('design/'));
    if (!revision && !skills.length && !job) return '';
    const out: string[] = ['', '', '## Project design and skills'];
    if (revision) out.push(`Design contract: v${revision.version}, SHA-256 ${revision.hash}. Pull get_design_system before UI work; this frozen version applies to your assignment.`);
    if (job && (job.kind === 'generate' || job.kind === 'refine')) {
      const art = job.artifactId ? this.d.state.mocks?.[job.artifactId] : null;
      out.push(designJobPrompt(job, { contract: revision ? { version: revision.version, hash: revision.hash } : null, source: art?.revisions.find(r => r.rev === job.fromRev) ?? null }).trimStart());
    } else if (job?.kind === 'review') {
      const art = job.artifactId ? this.d.state.mocks?.[job.artifactId] : null, rev = art?.revisions.find(r => r.rev === job.fromRev);
      if (art && rev) out.push(reviewPrompt({ artifactId: art.id, dir: art.dir, revision: rev }).trimStart());
    } else if (job?.kind === 'engineering') {
      out.push('Implement only the approved design identity in the goal. Pull get_design_system for the frozen tokens and DESIGN.md recipes; keep tokens in one place; report keyboard, focus and phone/tablet/desktop evidence with the exact commands you ran.');
    } else if (designPaths) {
      out.push('Write self-contained mocks under design/<slug>/ (index.html plus local css/js/svg/png; no remote URLs, no network calls), then call register_design_mock with that folder so One Connect captures an immutable revision for review.');
      out.push(`Isolated preview limits: ${DESIGN_RUNTIME_LIMITS.map(l => l.split(':')[0]).join('; ')}. Keep state in memory and simulate form results.`);
    }
    if (skills.length) out.push('Available skills (descriptions only; load a skill with get_skill when it applies, and its references only when SKILL.md points to them):', ...skills.map(s => `- ${s.id}: ${s.description}`));
    return out.join('\n');
  }
}
