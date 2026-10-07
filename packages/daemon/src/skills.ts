// SPDX-License-Identifier: Apache-2.0
// Project skills library: original SKILL.md skills with on-demand references, immutable published
// versions, per-assignment snapshots, provider exports into the assignment worktree and paged reads.
// Saving a draft never runs code, installs anything or calls a model.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  containsSecret, HUMAN, isActiveRun, SYSTEM, SkillDraftSchema, skillAdvice, skillMarkdown, SKILL_ID_RE,
  type AdapterType, type Assignment, type ProjectSkill, type SkillDraft, type SkillRef, type SkillVersion,
} from '@acc/core';
import { CommandError, type Daemon } from './daemon.ts';
import { builtinSkill, builtinSkillFile } from './designer.ts';
import { ensureExcluded } from './adapters/vcs/git.ts';

const exec = promisify(execFile);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DESIGN_LABEL = /^(design|ui|mock|frontend|branding)$/i;

/** Where each harness discovers repository skills. Relay runs have no worktree. */
export const SKILL_EXPORT_DIRS: Record<AdapterType, string | null> = {
  'claude-headless': '.claude/skills',
  'codex-cli': '.agents/skills',
  'cursor-agent-cli': '.cursor/skills',
  'generic-cli': '.agents/skills',
  relay: null,
};

interface StoredVersion { version: SkillVersion; files: { path: string; content: string }[] }
interface ExportRecord { worktree: string; root: string | null; at: string; written: { path: string; sha256: string }[]; skipped: { path: string; reason: string }[] }

function filesOf(d: SkillDraft) {
  return [{ path: 'SKILL.md', content: skillMarkdown(d) }, ...d.references.map(r => ({ path: r.path, content: r.content }))];
}
const filesHash = (files: { path: string; sha256: string }[]) => sha(files.map(f => `${f.path}\0${f.sha256}`).sort().join('\n'));

function frontmatterName(text: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const n = m && /^name:\s*["']?([a-z0-9][a-z0-9-]{0,63})["']?\s*$/m.exec(m[1]);
  return n ? n[1] : null;
}

export class SkillLibrary {
  readonly d: Daemon;
  constructor(d: Daemon) { this.d = d; }

  private skillsState(): Record<string, ProjectSkill> { return this.d.state.skills ?? {}; }

  /** Ids and export directory names owned by pinned built-ins; project skills may not shadow them. */
  private reservedNames(): Set<string> {
    const out = new Set<string>();
    for (const s of this.d.designer.skills()) {
      out.add(s.id);
      const name = frontmatterName(builtinSkillFile(s.id, 'SKILL.md'));
      if (name) out.add(name);
    }
    return out;
  }

  catalog() {
    return {
      builtin: this.d.designer.skills().map(s => ({ ...s, kind: 'builtin' as const, references: builtinSkill(s.id)!.files.map(f => f.path).filter(p => p !== 'SKILL.md') })),
      project: Object.values(this.skillsState()).sort((a, b) => a.id.localeCompare(b.id)),
      exportDirs: SKILL_EXPORT_DIRS,
    };
  }

  draft(id: string): SkillDraft | null {
    const raw = this.d.store.kvGet(`skill:draft:${id}`);
    return raw ? (JSON.parse(raw) as SkillDraft) : null;
  }

  stored(id: string, version: number): StoredVersion | null {
    const raw = this.d.store.kvGet(`skill:version:${id}@${version}`);
    return raw ? (JSON.parse(raw) as StoredVersion) : null;
  }

  detail(id: string) {
    const skill = this.skillsState()[id];
    if (!skill) throw new CommandError('Unknown project skill', 404);
    const draft = this.draft(id);
    const latest = skill.latest ? this.stored(id, skill.latest) : null;
    const editable: SkillDraft | null = draft ?? (latest ? this.toDraft(latest) : null);
    return { skill, draft, editable, advice: editable ? skillAdvice(editable) : [], usedBy: Object.values(this.d.state.agents).filter(a => a.config.skills?.includes(id)).map(a => a.id) };
  }

  private toDraft(v: StoredVersion): SkillDraft {
    const body = v.files.find(f => f.path === 'SKILL.md')!.content.replace(/^---\n[\s\S]*?\n---\n\n/, '').replace(/\n\n## References \(load on demand\)\n\n[\s\S]*$/, '').trim();
    return { id: v.version.id, name: v.version.name, description: v.version.description, instructions: body, references: v.files.filter(f => f.path !== 'SKILL.md').map(f => ({ path: f.path, content: f.content })) };
  }

  /** Validates and stores a draft. Expected is the previous draft hash (null for a new skill). */
  saveDraft(input: unknown, expected: string | null): { skill: ProjectSkill; advice: string[] } {
    const parsed = SkillDraftSchema.safeParse(input);
    if (!parsed.success) throw new CommandError(parsed.error.issues.map(i => i.message).join('; '));
    const draft = parsed.data;
    if (this.reservedNames().has(draft.id)) throw new CommandError(`"${draft.id}" is owned by a pinned built-in skill. Choose another id.`, 409);
    if (containsSecret(JSON.stringify(draft), { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from this skill. Skills are exported into worktrees and shown to agents.');
    const cur = this.skillsState()[draft.id];
    const currentHash = cur?.draft?.hash ?? null;
    if (expected !== currentHash) throw new CommandError('This skill changed. Reload before saving.', 409);
    const hash = sha(JSON.stringify(draft));
    if (hash !== currentHash) {
      this.d.commit([{ type: 'skill.draft_saved', actor: HUMAN, data: { id: draft.id, name: draft.name, description: draft.description, hash } }], [], () => this.d.store.kvSet(`skill:draft:${draft.id}`, JSON.stringify(draft)));
    }
    return { skill: this.skillsState()[draft.id], advice: skillAdvice(draft) };
  }

  /** Freezes the current draft as the next immutable version. */
  publish(id: string, expectedLatest: number | null): SkillVersion {
    const cur = this.skillsState()[id];
    if (!cur) throw new CommandError('Unknown project skill', 404);
    if ((cur.latest ?? null) !== expectedLatest) throw new CommandError('A newer version was published. Reload before publishing.', 409);
    const draft = this.draft(id);
    if (!draft || !cur.draft) throw new CommandError('Save a draft before publishing a new version.', 409);
    const parsed = SkillDraftSchema.parse(draft);
    if (containsSecret(JSON.stringify(parsed), { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from this skill.');
    const files = filesOf(parsed);
    const meta = files.map(f => ({ path: f.path, sha256: sha(f.content), bytes: Buffer.byteLength(f.content) }));
    const version: SkillVersion = { id, version: (cur.latest ?? 0) + 1, hash: filesHash(meta), name: parsed.name, description: parsed.description, files: meta, createdAt: this.d.nowIso(), by: HUMAN };
    const key = `skill:version:${id}@${version.version}`;
    if (this.d.store.kvGet(key)) throw new CommandError('Version already exists', 409);
    this.d.commit([{ type: 'skill.version_published', actor: HUMAN, data: { version } }], [], () => {
      this.d.store.kvSet(key, JSON.stringify({ version, files } satisfies StoredVersion));
      this.d.store.kvDelete(`skill:draft:${id}`);
    });
    return version;
  }

  setDisabled(id: string, disabled: boolean): ProjectSkill {
    const cur = this.skillsState()[id];
    if (!cur) throw new CommandError('Unknown project skill', 404);
    const users = Object.values(this.d.state.agents).filter(a => a.config.skills?.includes(id));
    if (disabled && users.length) throw new CommandError(`Remove this skill from ${users.map(a => a.config.name).join(', ')} before disabling it.`, 409);
    if (cur.disabled !== disabled) this.d.commit([{ type: 'skill.disabled', actor: HUMAN, data: { id, disabled } }]);
    return this.skillsState()[id];
  }

  /** Built-ins, or project skills with a published version that are not disabled. */
  assignable(id: string): boolean {
    if (this.d.designer.hasSkill(id)) return true;
    const s = this.skillsState()[id];
    return Boolean(s && !s.disabled && s.latest);
  }

  private builtinRef(id: string): SkillRef {
    const s = builtinSkill(id)!;
    return { id, source: 'builtin', version: s.version, hash: filesHash(s.files), name: s.name, description: s.description };
  }

  /** Exact versions an assignment may use, decided once at creation (and on agent reassignment). */
  freeze(agentId: string, workItemId: string): SkillRef[] {
    const cfg = this.d.state.agents[agentId]?.config, item = this.d.state.workItems[workItemId];
    const ids = new Set(cfg?.skills ?? []);
    if (item?.labels.some(l => DESIGN_LABEL.test(l))) for (const s of this.d.designer.skills()) ids.add(s.id);
    const refs: SkillRef[] = [];
    for (const id of ids) {
      if (this.d.designer.hasSkill(id)) { refs.push(this.builtinRef(id)); continue; }
      const s = this.skillsState()[id];
      const v = s && !s.disabled && s.latest ? s.versions.find(x => x.version === s.latest) : undefined;
      if (v) refs.push({ id, source: 'project', version: String(v.version), hash: v.hash, name: v.name, description: v.description });
    }
    return refs;
  }

  forAssignment(a: Assignment): SkillRef[] {
    return a.skills ?? this.freeze(a.agentId, a.workItemId).filter(r => r.source === 'builtin');
  }

  private filesFor(ref: SkillRef): { path: string; content: string }[] {
    if (ref.source === 'builtin') {
      const s = builtinSkill(ref.id);
      if (!s || s.version !== ref.version || filesHash(s.files) !== ref.hash) throw new CommandError('The pinned skill no longer matches this assignment’s snapshot', 409);
      return s.files.map(f => ({ path: f.path, content: builtinSkillFile(ref.id, f.path) }));
    }
    const v = this.stored(ref.id, Number(ref.version));
    if (!v || v.version.hash !== ref.hash) throw new CommandError('Snapshot version is missing', 409);
    for (const f of v.files) if (sha(f.content) !== v.version.files.find(m => m.path === f.path)?.sha256) throw new CommandError('Skill integrity check failed', 409);
    return v.files;
  }

  /** Descriptions-first listing for an agent: no instructions, only reference names. */
  listFor(a: Assignment) {
    return this.forAssignment(a).map(r => ({ ...r, references: this.filesFor(r).map(f => f.path).filter(p => p !== 'SKILL.md') }));
  }

  /** Paged read limited to the assignment's frozen snapshot. */
  readFor(a: Assignment, id: string, o: { file?: string; offset?: number; budget?: number } = {}) {
    const ref = this.forAssignment(a).find(r => r.id === id);
    if (!ref) throw new CommandError('This skill is not part of your assignment', 403);
    const file = o.file ?? 'SKILL.md';
    const entry = this.filesFor(ref).find(f => f.path === file);
    if (!entry) throw new CommandError('Unknown skill reference', 404);
    const text = entry.content;
    const offset = Number.isSafeInteger(o.offset) ? Math.max(0, o.offset!) : 0;
    const budget = Number.isFinite(o.budget) ? Math.min(12000, Math.max(1000, Math.floor(o.budget!))) : 6000;
    return { skill: ref, file, content: this.d.redactText(text.slice(offset, offset + budget)), nextOffset: Math.min(text.length, offset + budget), more: offset + budget < text.length, references: this.filesFor(ref).map(f => f.path).filter(p => p !== file) };
  }

  /** Human-side read of any published version (or built-in) for the library page. */
  readVersion(id: string, version: string | null, file = 'SKILL.md') {
    let ref: SkillRef;
    if (this.d.designer.hasSkill(id)) ref = this.builtinRef(id);
    else {
      const s = this.skillsState()[id];
      const v = s?.versions.find(x => String(x.version) === (version ?? String(s.latest)));
      if (!v) throw new CommandError('Unknown skill version', 404);
      ref = { id, source: 'project', version: String(v.version), hash: v.hash, name: v.name, description: v.description };
    }
    const entry = this.filesFor(ref).find(f => f.path === file);
    if (!entry) throw new CommandError('Unknown skill reference', 404);
    return { skill: ref, file, content: this.d.redactText(entry.content), files: this.filesFor(ref).map(f => f.path) };
  }

  exportStatus(assignmentId: string): ExportRecord | null {
    const raw = this.d.store.kvGet(`skills:export:${assignmentId}`);
    return raw ? (JSON.parse(raw) as ExportRecord) : null;
  }

  /**
   * Writes the frozen skills into the assignment worktree for its harness. Paths the repository
   * tracks, symlinks and directories not written by One Connect are skipped, never overwritten.
   */
  async exportTo(assignmentId: string): Promise<ExportRecord> {
    const a = this.d.state.assignments[assignmentId];
    if (!a) throw new CommandError('Unknown assignment', 404);
    if (!a.worktree || !fs.existsSync(a.worktree)) throw new CommandError('The assignment has no worktree yet', 409);
    const adapter = this.d.state.agents[a.agentId]?.config.adapter;
    const root = adapter ? SKILL_EXPORT_DIRS[adapter] : null;
    const prev = this.exportStatus(assignmentId);
    const owned = new Map((prev?.worktree === a.worktree ? prev.written : []).map(f => [f.path, f.sha256]));
    const rec: ExportRecord = { worktree: a.worktree, root, at: this.d.nowIso(), written: [], skipped: [] };
    if (!root) return rec;
    const wt = fs.realpathSync(a.worktree);
    const blocked = (rel: string): string | null => {
      let cur = wt;
      for (const part of rel.split('/')) {
        cur = path.join(cur, part);
        let st: fs.Stats;
        try { st = fs.lstatSync(cur); } catch { return null; }
        if (st.isSymbolicLink()) return 'path contains a symlink';
      }
      return null;
    };
    const tracked = async (rel: string) => (await exec('git', ['ls-files', '--', rel], { cwd: wt }).catch(() => ({ stdout: '' }))).stdout.trim().length > 0;
    for (const ref of this.forAssignment(a)) {
      const files = this.filesFor(ref);
      const name = ref.source === 'builtin' ? (frontmatterName(files.find(f => f.path === 'SKILL.md')!.content) ?? ref.id) : ref.id;
      if (!SKILL_ID_RE.test(name)) { rec.skipped.push({ path: `${root}/${name}`, reason: 'invalid skill name' }); continue; }
      const dir = `${root}/${name}`;
      const why = blocked(dir) ?? ((await tracked(dir)) ? 'the repository already tracks this path' : null);
      if (why) { rec.skipped.push({ path: dir, reason: why }); continue; }
      const foreign = files.map(f => `${dir}/${f.path}`).find(p => fs.existsSync(path.join(wt, p)) && !owned.has(p));
      const changed = files.map(f => `${dir}/${f.path}`).find(p => owned.has(p) && fs.existsSync(path.join(wt, p)) && sha(fs.readFileSync(path.join(wt, p), 'utf8')) !== owned.get(p));
      if (foreign || changed) { rec.skipped.push({ path: dir, reason: foreign ? `${foreign} exists and is not managed by One Connect` : `${changed} was edited in the worktree; not overwritten` }); continue; }
      for (const f of files) {
        const rel = `${dir}/${f.path}`;
        const why2 = blocked(rel);
        if (why2) { rec.skipped.push({ path: rel, reason: why2 }); continue; }
        const abs = path.join(wt, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (!fs.realpathSync(path.dirname(abs)).startsWith(wt + path.sep)) { rec.skipped.push({ path: rel, reason: 'resolves outside the worktree' }); continue; }
        const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
        try { fs.writeSync(fd, f.content); } finally { fs.closeSync(fd); }
        rec.written.push({ path: rel, sha256: sha(f.content) });
      }
      await ensureExcluded(wt, `/${dir}/`);
    }
    this.d.commit([{ type: 'skill.exported', actor: SYSTEM, assignmentId, agentId: a.agentId, workItemId: a.workItemId, data: { assignmentId, worktree: a.worktree, written: rec.written.map(f => f.path), skipped: rec.skipped } }], [], () => this.d.store.kvSet(`skills:export:${assignmentId}`, JSON.stringify(rec)));
    return rec;
  }

  /** Called before every launch. Export problems are recorded; agents can still page skills over MCP. */
  async exportForRun(assignmentId: string): Promise<void> {
    try { await this.exportTo(assignmentId); } catch (e) {
      const a = this.d.state.assignments[assignmentId];
      if (a?.worktree) this.d.commit([{ type: 'skill.exported', actor: SYSTEM, assignmentId, agentId: a.agentId, workItemId: a.workItemId, data: { assignmentId, worktree: a.worktree, written: [], skipped: [{ path: '*', reason: `export failed: ${(e as Error).message}` }] } }]);
    }
  }

  /** Human re-export; refused while a run is active so files never change under a running agent. */
  async reexport(assignmentId: string): Promise<ExportRecord> {
    if (Object.values(this.d.state.runs).some(r => r.assignmentId === assignmentId && isActiveRun(r))) throw new CommandError('Stop the active run before re-exporting its skills.', 409);
    return this.exportTo(assignmentId);
  }
}
