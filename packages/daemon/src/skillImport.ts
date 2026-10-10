// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Parse SKILL.md frontmatter and portable skill bundles for import preview. No persistence.
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { z } from 'zod';
import {
  SKILL_BUNDLE_FORMAT, SKILL_BUNDLE_VERSION, SKILL_ID_RE, SKILL_IMPORT_MAX_BYTES, SKILL_LIMITS, SKILL_REFERENCE_RE,
  SkillAttributionSchema, SkillBundleSchema, SkillDraftSchema, generatedReferencesFooter, skillAdvice,
  stripGeneratedReferencesFooter, type SkillAttribution, type SkillBundle, type SkillDraft, type SkillImportPreview,
} from '@acc/core';
import { fileSha256, filesHash } from '@acc/core/skillHash';
import { CommandError } from './daemon.ts';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const ALLOWED_FRONTMATTER = new Set(['name', 'description']);

export interface ImportFilesInput {
  skillMd: string;
  references?: { path: string; content: string }[];
  id?: string;
  source?: string | null;
  license?: string | null;
}

const ImportFilesSchema = z.object({
  skillMd: z.string().max(SKILL_IMPORT_MAX_BYTES, 'SKILL.md exceeds the byte import limit'),
  references: z.array(z.object({ path: z.string().max(100), content: z.string().max(SKILL_LIMITS.reference) }).strict()).max(SKILL_LIMITS.references).optional(),
  id: z.string().regex(SKILL_ID_RE).optional(),
  source: SkillAttributionSchema.shape.source,
  license: SkillAttributionSchema.shape.license,
}).strict();
const ImportRequestSchema = z.object({ files: ImportFilesSchema.optional(), bundle: z.unknown().optional() }).strict()
  .refine(input => Boolean(input.files) !== (input.bundle !== undefined), 'Provide exactly one SKILL.md input or bundle');

function assertAggregateBytes(label: string, bytes: number): void {
  if (bytes > SKILL_IMPORT_MAX_BYTES) throw new CommandError(`${label} exceeds the ${SKILL_IMPORT_MAX_BYTES} byte import limit`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new CommandError(`SKILL.md frontmatter ${field} must be a string`);
  return value;
}

function walkYaml(node: unknown, visit: (n: unknown) => void): void {
  const pending = [node];
  let count = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    if (++count > 2048) throw new CommandError('YAML frontmatter is too complex');
    visit(current);
    if (YAML.isMap(current)) for (const pair of current.items) pending.push(pair.key, pair.value);
    if (YAML.isSeq(current)) pending.push(...current.items);
    if (YAML.isPair(current)) pending.push(current.key, current.value);
  }
}

function inspectFrontmatterAst(rawFm: string): void {
  if (rawFm.includes('\0')) throw new CommandError('Invalid YAML frontmatter');
  const doc = YAML.parseDocument(rawFm, { strict: true });
  if (doc.errors.length) throw new CommandError('Invalid YAML frontmatter: keys must be unique and the document must be valid');
  if (!YAML.isMap(doc.contents)) throw new CommandError('SKILL.md frontmatter must be a mapping');
  const keys: string[] = [];
  for (const pair of doc.contents.items) {
    if (!YAML.isScalar(pair.key) || typeof pair.key.value !== 'string') throw new CommandError('SKILL.md frontmatter keys must be strings');
    keys.push(pair.key.value);
  }
  if (keys.length !== new Set(keys).size) throw new CommandError('Duplicate YAML frontmatter keys are not allowed');
  let aliases = 0;
  walkYaml(doc.contents, n => { if (YAML.isAlias(n) || Boolean(n && typeof n === 'object' && 'anchor' in n && n.anchor)) aliases += 1; });
  if (aliases) throw new CommandError('YAML aliases are not allowed in SKILL.md frontmatter');
}

function parseFrontmatterMap(rawFm: string): Record<string, unknown> {
  inspectFrontmatterAst(rawFm);
  try {
    const parsed = YAML.parse(rawFm, { maxAliasCount: 0, strict: true });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CommandError('SKILL.md frontmatter must be a mapping');
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError(`Invalid YAML frontmatter: ${(e as Error).message.split('\n')[0]}`);
  }
}

function normalizeRefPath(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new CommandError('Reference path is required');
  if (raw.includes('\\') || raw.startsWith('/')) throw new CommandError(`Unsafe reference path: ${raw}`);
  const name = raw.trim();
  if (name.includes('..') || name.startsWith('references/../')) throw new CommandError(`Unsafe reference path: ${raw}`);
  if (SKILL_REFERENCE_RE.test(name)) return name;
  const base = name.replace(/^references\//, '');
  if (!/^[a-z0-9][a-z0-9_-]{0,62}\.(?:md|txt)$/.test(base)) throw new CommandError(`Unsupported reference file: ${raw}. Use references/<name>.md or .txt`);
  return `references/${base}`;
}

function parseFrontmatter(text: string, referencePaths: string[]): { identifier: string; description: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const m = FRONTMATTER.exec(normalized);
  if (!m) throw new CommandError('SKILL.md must start with YAML frontmatter (---)');
  const rawFm = m[1];
  if (/\n---\s*\n/.test(rawFm) || /^---/m.test(rawFm)) throw new CommandError('SKILL.md must contain a single frontmatter block');
  const map = parseFrontmatterMap(rawFm);
  const keys = Object.keys(map);
  const unsupported = keys.filter(k => !ALLOWED_FRONTMATTER.has(k));
  if (unsupported.length) throw new CommandError(`Unsupported frontmatter key(s): ${unsupported.join(', ')}`);
  const identifier = requireString(map.name, 'name').trim();
  const description = requireString(map.description, 'description').trim();
  if (!identifier) throw new CommandError('SKILL.md frontmatter requires name');
  if (!description) throw new CommandError('SKILL.md frontmatter requires description');
  const body = stripGeneratedReferencesFooter(m[2] ?? '', referencePaths);
  if (!body.trim()) throw new CommandError('SKILL.md instructions cannot be empty');
  return { identifier, description, body };
}

function parseReferences(input: ImportFilesInput): { path: string; content: string }[] {
  const refs = (input.references ?? []).map(r => {
    if (typeof r.path !== 'string' || typeof r.content !== 'string') throw new CommandError('Each reference needs a string path and content');
    const content = r.content;
    if (!content.trim()) throw new CommandError(`Reference ${r.path} cannot be empty`);
    return { path: normalizeRefPath(r.path), content };
  });
  const paths = new Set<string>();
  for (const r of refs) {
    if (paths.has(r.path)) throw new CommandError(`Duplicate reference path: ${r.path}`);
    paths.add(r.path);
  }
  if (refs.length > SKILL_LIMITS.references) throw new CommandError(`At most ${SKILL_LIMITS.references} reference files are allowed`);
  return refs;
}

function draftFromParts(parts: {
  id: string;
  name: string;
  description: string;
  instructions: string;
  references: { path: string; content: string }[];
  source?: string | null;
  license?: string | null;
}): SkillDraft {
  if (!SKILL_ID_RE.test(parts.id)) throw new CommandError('Skill id must be 2–64 lowercase letters, digits and dashes');
  const attribution = SkillAttributionSchema.safeParse({ source: parts.source ?? null, license: parts.license ?? null });
  if (!attribution.success) throw new CommandError(attribution.error.issues.map(i => i.message).join('; '));
  const parsed = SkillDraftSchema.safeParse({
    id: parts.id,
    name: parts.name,
    description: parts.description,
    instructions: parts.instructions,
    references: parts.references,
    source: attribution.data.source ?? null,
    license: attribution.data.license ?? null,
  });
  if (!parsed.success) throw new CommandError(parsed.error.issues.map(i => i.message).join('; '));
  return parsed.data;
}

function draftFromSkillMd(input: ImportFilesInput): SkillDraft {
  const refs = parseReferences(input);
  const { identifier, description, body } = parseFrontmatter(input.skillMd, refs.map(r => r.path));
  const id = (input.id?.trim() || identifier).toLowerCase();
  return draftFromParts({
    id,
    name: identifier.length <= 100 ? identifier : id,
    description,
    instructions: body,
    references: refs,
    source: input.source,
    license: input.license,
  });
}

function validateBundleFiles(files: { path: string; sha256: string; content: string }[]): void {
  const paths = new Set<string>();
  for (const f of files) {
    if (typeof f.path !== 'string' || typeof f.content !== 'string' || typeof f.sha256 !== 'string') {
      throw new CommandError('Each bundle file needs string path, content and sha256');
    }
    const path = f.path;
    if (!path || !f.content || !f.sha256) throw new CommandError('Each bundle file needs path, content and sha256');
    if (path.includes('\\') || path.startsWith('/') || path.includes('..')) throw new CommandError(`Unsafe bundle path: ${path}`);
    if (path !== 'SKILL.md' && !SKILL_REFERENCE_RE.test(path)) throw new CommandError(`Unsupported bundle file: ${path}`);
    if (paths.has(path)) throw new CommandError(`Duplicate bundle path: ${path}`);
    paths.add(path);
    if (fileSha256(f.content) !== f.sha256) throw new CommandError(`Hash mismatch for ${path}`);
  }
  if (!paths.has('SKILL.md')) throw new CommandError('Bundle must include SKILL.md');
}

function parseBundle(raw: unknown): SkillBundle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CommandError('Bundle must be a JSON object');
  assertAggregateBytes('bundle', Buffer.byteLength(JSON.stringify(raw), 'utf8'));
  const parsed = SkillBundleSchema.safeParse(raw);
  if (!parsed.success) throw new CommandError(parsed.error.issues.map(i => i.message).join('; '));
  const bundle = parsed.data;
  validateBundleFiles(bundle.files);
  const meta = bundle.files.map(f => ({ path: f.path, sha256: f.sha256 }));
  if (filesHash(meta) !== bundle.skill.hash) throw new CommandError('Bundle skill hash does not match file hashes');
  const skillMd = bundle.files.find(f => f.path === 'SKILL.md')!;
  const refs = bundle.files.filter(f => f.path !== 'SKILL.md');
  const { identifier, description: fmDescription, body } = parseFrontmatter(skillMd.content, refs.map(r => r.path));
  if (identifier !== bundle.skill.id) throw new CommandError('Bundle skill id does not match SKILL.md frontmatter name');
  if (fmDescription !== bundle.skill.description) throw new CommandError('Bundle skill description does not match SKILL.md frontmatter');
  const footer = generatedReferencesFooter(refs.map(r => r.path));
  if (footer && !skillMd.content.endsWith(footer)) throw new CommandError('Bundle SKILL.md is missing the generated references footer');
  return {
    ...bundle,
    files: bundle.files.map(f => ({ path: f.path, sha256: f.sha256, content: f.content })),
  };
}

function previewFilesFromInput(input: ImportFilesInput, draft: SkillDraft): { path: string; sha256: string; bytes: number }[] {
  const skillMdBytes = Buffer.byteLength(input.skillMd, 'utf8');
  const files = [{ path: 'SKILL.md', sha256: fileSha256(input.skillMd), bytes: skillMdBytes }];
  for (const r of input.references ?? []) {
    const content = typeof r.content === 'string' ? r.content : '';
    files.push({ path: normalizeRefPath(String(r.path ?? '')), sha256: fileSha256(content), bytes: Buffer.byteLength(content, 'utf8') });
  }
  assertAggregateBytes('import', files.reduce((n, f) => n + f.bytes, 0));
  return files;
}

function previewFilesFromBundle(bundle: SkillBundle): { path: string; sha256: string; bytes: number }[] {
  const files = bundle.files.map(f => ({ path: f.path, sha256: f.sha256, bytes: Buffer.byteLength(f.content, 'utf8') }));
  assertAggregateBytes('bundle', files.reduce((n, f) => n + f.bytes, 0));
  return files;
}

export function previewSkillImport(raw: { files?: ImportFilesInput; bundle?: unknown }): SkillImportPreview {
  const parsedInput = ImportRequestSchema.safeParse(raw);
  if (!parsedInput.success) throw new CommandError(parsedInput.error.issues.map(i => i.message).join('; '));
  const input = parsedInput.data;
  let draft: SkillDraft;
  let attribution: SkillAttribution;
  let files: { path: string; sha256: string; bytes: number }[];
  if (input.bundle !== undefined) {
    const bundle = parseBundle(input.bundle);
    const skillMd = bundle.files.find(f => f.path === 'SKILL.md')!;
    const refs = bundle.files.filter(f => f.path !== 'SKILL.md');
    const { body } = parseFrontmatter(skillMd.content, refs.map(r => r.path));
    draft = draftFromParts({
      id: bundle.skill.id,
      name: bundle.skill.name,
      description: bundle.skill.description,
      instructions: body,
      references: refs.map(r => ({ path: r.path, content: r.content })),
      source: bundle.attribution.source ?? null,
      license: bundle.attribution.license ?? null,
    });
    attribution = bundle.attribution;
    files = previewFilesFromBundle(bundle);
  } else if (input.files) {
    if (typeof input.files.skillMd !== 'string') throw new CommandError('SKILL.md content must be a string');
    const refs = parseReferences(input.files);
    assertAggregateBytes('import', Buffer.byteLength(input.files.skillMd, 'utf8') + refs.reduce((n, r) => n + Buffer.byteLength(r.content, 'utf8'), 0));
    draft = draftFromSkillMd(input.files);
    attribution = { source: draft.source ?? null, license: draft.license ?? null };
    files = previewFilesFromInput(input.files, draft);
  } else {
    throw new CommandError('Provide SKILL.md content or a bundle');
  }
  return {
    draft,
    advice: skillAdvice(draft),
    attribution,
    files,
    untrusted: true,
    note: 'Imported instructions are untrusted guidance. Saving creates a draft only; nothing runs until you publish and assign the skill.',
  };
}

export function buildSkillBundle(version: {
  id: string; name: string; description: string; version: number; hash: string; createdAt: string; source?: string | null; license?: string | null;
}, files: { path: string; content: string }[]): SkillBundle {
  const bundleFiles = files.map(f => ({ path: f.path, content: f.content, sha256: fileSha256(f.content) }));
  const meta = bundleFiles.map(f => ({ path: f.path, sha256: f.sha256 }));
  if (filesHash(meta) !== version.hash) throw new CommandError('Version hash does not match stored files');
  const attribution = SkillAttributionSchema.parse({ source: version.source ?? null, license: version.license ?? null });
  return SkillBundleSchema.parse({
    format: SKILL_BUNDLE_FORMAT,
    bundleVersion: SKILL_BUNDLE_VERSION,
    skill: {
      id: version.id,
      name: version.name,
      description: version.description,
      version: version.version,
      hash: version.hash,
      publishedAt: version.createdAt,
    },
    attribution,
    files: bundleFiles,
    note: 'SHA-256 hashes prove bundle integrity, not that the instructions are safe or licensed for your use.',
  });
}
