// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Model inventory helpers: newest-model selection, model classes and quality floors.
// Vendors name models inconsistently, so everything here is pattern-based and overridable
// from policy config. Unknown models are reported as unknown, never guessed into a class.
import { EFFORTS, type Effort } from './config.ts';
import type { ModelInfo } from './entities.ts';

const NUMERIC = /^\d{1,3}(?:\.\d{1,3})*$/;
const PREFIXED = /^[a-z]{1,2}(\d{1,3}(?:\.\d{1,3})*)$/; // o3, v2
const DATE = /^\d{8}$/;

export interface ParsedModel {
  id: string;
  version: number[];
  date: number;
  effort: Effort | null;
  fast: boolean;
  /** id with effort / speed suffixes removed, e.g. gpt-5.3-codex-high-fast → gpt-5.3-codex */
  base: string;
}

export function parseModelId(id: string): ParsedModel {
  const tokens = id.toLowerCase().split(/[-_/\s]+/).filter(Boolean);
  const version: number[] = [];
  let date = 0;
  let started = false;
  let done = false;
  for (const t of tokens) {
    if (DATE.test(t)) {
      date = Number(t);
      continue;
    }
    const n = NUMERIC.test(t) ? t : PREFIXED.exec(t)?.[1];
    if (n && !done) {
      version.push(...n.split('.').map(Number));
      started = true;
    } else if (started) done = true;
  }
  let rest = [...tokens];
  let fast = false;
  let effort: Effort | null = null;
  while (rest.length > 1) {
    const last = rest[rest.length - 1];
    if (last === 'fast') {
      fast = true;
      rest = rest.slice(0, -1);
    } else if ((EFFORTS as readonly string[]).includes(last)) {
      effort = effort ?? (last as Effort);
      rest = rest.slice(0, -1);
    } else if (last === 'thinking' || DATE.test(last)) {
      rest = rest.slice(0, -1);
    } else break;
  }
  return { id, version, date, effort, fast, base: rest.join('-') };
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export function matchesAny(id: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => globToRegExp(p).test(id));
}

export function matchesFamily(id: string, family: string | undefined): boolean {
  if (!family) return true;
  const f = family.toLowerCase();
  const lid = id.toLowerCase();
  if (f.includes('*')) return globToRegExp(f).test(lid);
  // Token boundaries only: "claude-opus-4" must not match "claude-opus-45".
  return lid === f || lid.startsWith(f + '-') || lid.startsWith(f + '.') || lid.includes(`-${f}-`) || lid.endsWith(`-${f}`);
}

/**
 * Model line without version, date, effort or speed: claude-opus-5-thinking-high → claude-opus,
 * gpt-5.6-sol-high → gpt-sol, o3 → o. Versions are only comparable inside one line.
 */
export function modelFamilyKey(id: string): string {
  const base = parseModelId(id).base;
  const out = base
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((t) => (NUMERIC.test(t) || DATE.test(t) ? '' : PREFIXED.test(t) ? t.replace(/[\d.]+$/, '') : t))
    .filter((t) => t && t !== 'thinking' && t !== 'latest' && t !== 'preview');
  return out.join('-') || base;
}

export interface ModelSelection {
  model: ModelInfo | null;
  /** Distinct model lines among the eligible candidates. */
  families: string[];
  reason: 'single_family' | 'vendor_priority' | 'allowlist_order' | 'none' | 'ambiguous';
  message: string;
}

/**
 * Newest model without comparing version numbers across unrelated lines (gpt-5.6 is not "newer"
 * than claude-opus-5). Several lines are only resolved by vendor priority on every candidate or by
 * the order of the configured allowlist; otherwise the selection is ambiguous and blocks.
 */
export function selectNewestModel(models: readonly ModelInfo[], o: PickOptions = {}): ModelSelection {
  const cands = eligibleModels(models, o);
  if (cands.length === 0) return { model: null, families: [], reason: 'none', message: 'no eligible model' };
  const inner: PickOptions = { effort: o.effort, allowFast: true };
  const byFamily = new Map<string, ModelInfo[]>();
  for (const m of cands) byFamily.set(modelFamilyKey(m.id), [...(byFamily.get(modelFamilyKey(m.id)) ?? []), m]);
  const families = [...byFamily.keys()];
  if (families.length === 1) return { model: pickNewest(cands, inner), families, reason: 'single_family', message: `newest ${families[0]}` };
  if (cands.every((m) => typeof m.priority === 'number')) {
    const top = Math.min(...cands.map((m) => m.priority!));
    const best = cands.filter((m) => m.priority === top);
    if (new Set(best.map((m) => modelFamilyKey(m.id))).size === 1) return { model: pickNewest(best, inner), families, reason: 'vendor_priority', message: `vendor's preferred model (priority ${top})` };
  }
  for (const pattern of o.allowed ?? []) {
    const hit = cands.filter((m) => matchesAny(m.id, [pattern]));
    if (hit.length === 0) continue;
    const fams = new Set(hit.map((m) => modelFamilyKey(m.id)));
    if (fams.size === 1) return { model: pickNewest(hit, inner), families, reason: 'allowlist_order', message: `first allowed line (${pattern})` };
    break;
  }
  return {
    model: null,
    families,
    reason: 'ambiguous',
    message: `several model lines are eligible (${families.join(', ')}); set model_family, an ordered allowed_models list, or a literal model so a weaker line is never picked by version number`,
  };
}

/** Newest model in the same line as `model`, if the inventory has that line. */
export function newestInFamily(model: string, models: readonly ModelInfo[], o: PickOptions = {}): ModelInfo | null {
  const key = modelFamilyKey(model);
  return pickNewest(eligibleModels(models, { ...o, family: undefined }).filter((m) => modelFamilyKey(m.id) === key), { effort: o.effort, allowFast: true });
}

export const effortRank = (e: Effort | null | undefined): number => (e ? EFFORTS.indexOf(e) : -1);

export interface PickOptions {
  family?: string;
  effort?: Effort | null;
  allowed?: readonly string[];
  denied?: readonly string[];
  /** "Fast" variants spend more included usage; excluded unless asked for. */
  allowFast?: boolean;
}

export function eligibleModels(models: readonly ModelInfo[], o: PickOptions = {}): ModelInfo[] {
  return models.filter(
    (m) =>
      !m.hidden &&
      m.id !== 'auto' &&
      matchesFamily(m.id, o.family) &&
      (!o.allowed || o.allowed.length === 0 || matchesAny(m.id, o.allowed)) &&
      !matchesAny(m.id, o.denied) &&
      (o.allowFast || !parseModelId(m.id).fast),
  );
}

/** Newest eligible model: highest version, then vendor priority, then closest effort match. */
export function pickNewest(models: readonly ModelInfo[], o: PickOptions = {}): ModelInfo | null {
  const cands = eligibleModels(models, o);
  if (cands.length === 0) return null;
  const want = effortRank(o.effort ?? null);
  const scored = cands.map((m) => ({ m, p: parseModelId(m.id) }));
  scored.sort((a, b) => {
    const v = compareVersions(b.p.version, a.p.version);
    if (v !== 0) return v;
    if (b.p.date !== a.p.date) return b.p.date - a.p.date;
    const pa = a.m.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.m.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    if (want >= 0) {
      const da = a.p.effort ? Math.abs(effortRank(a.p.effort) - want) + (effortRank(a.p.effort) < want ? 0.5 : 0) : 10;
      const db = b.p.effort ? Math.abs(effortRank(b.p.effort) - want) + (effortRank(b.p.effort) < want ? 0.5 : 0) : 10;
      if (da !== db) return da - db;
    }
    return a.m.id.localeCompare(b.m.id);
  });
  return scored[0].m;
}

/** True when `model` is (one of) the newest eligible models: same version line as the pick. */
export function isNewest(model: string, models: readonly ModelInfo[], o: PickOptions = {}): { newest: boolean; best: string | null } {
  const best = pickNewest(models, o);
  if (!best) return { newest: true, best: null };
  if (!models.some((m) => m.id === model)) return { newest: false, best: best.id };
  const a = parseModelId(model);
  const b = parseModelId(best.id);
  return { newest: compareVersions(a.version, b.version) >= 0 && (b.date === 0 || a.date >= b.date), best: best.id };
}

// ---- classes & quality floors -------------------------------------------------------------

export const CLASS_RANK: Record<string, number> = {
  lite: 0,
  standard: 1,
  'sonnet-class': 2,
  'pro-class': 2,
  strong: 2,
  'opus-class': 3,
  frontier: 3,
};

export const DEFAULT_MODEL_CLASSES: { class: string; pattern: string }[] = [
  { class: 'lite', pattern: '(^|[-_.])(lite|mini|nano|haiku)([-_.]|$)' },
  { class: 'standard', pattern: 'flash' },
  { class: 'opus-class', pattern: '(^|[-_.])(opus|fable|astra)([-_.]|$)|^gpt-6|deep-?research|(^|-)pro(-|$)' },
  { class: 'sonnet-class', pattern: '(^|[-_.])(sonnet|codex|composer|grok|gemini|sol|terra|luna)([-_.]|$)|^gpt-5|^o[34]' },
];

export function modelClass(model: string, classes = DEFAULT_MODEL_CLASSES): string | null {
  const id = model.toLowerCase();
  for (const c of classes) if (new RegExp(c.pattern, 'i').test(id)) return c.class;
  return null;
}

export function parseFloor(floor: string): { cls: string | null; effort: Effort | null } {
  const parts = floor.trim().toLowerCase().split(/\s+/);
  const effort = (parts.find((p) => (EFFORTS as readonly string[]).includes(p)) as Effort | undefined) ?? null;
  const cls = parts.find((p) => p in CLASS_RANK) ?? null;
  return { cls, effort };
}

export interface FloorCheck {
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export function checkQualityFloor(model: string, effort: Effort | null, floor: string | undefined, classes = DEFAULT_MODEL_CLASSES): FloorCheck {
  if (!floor) return { status: 'pass', message: 'no quality floor for this work' };
  const f = parseFloor(floor);
  const cls = modelClass(model, classes);
  const eff = parseModelId(model).effort ?? effort;
  if (f.cls) {
    if (!cls) return { status: 'warn', message: `can't classify ${model}; floor is ${floor} (add a model_classes pattern)` };
    if (CLASS_RANK[cls] < CLASS_RANK[f.cls]) return { status: 'fail', message: `${model} is ${cls}, below the ${floor} floor` };
  }
  if (f.effort) {
    if (!eff) return { status: 'warn', message: `effort unknown; floor needs ${f.effort}` };
    if (effortRank(eff) < effortRank(f.effort)) return { status: 'fail', message: `effort ${eff} is below the ${floor} floor` };
  }
  return { status: 'pass', message: `${model}${eff ? ` @ ${eff}` : ''} meets ${floor}` };
}

/** Category of a work item for quality floors: first configured category whose labels match. */
export function workCategory(labels: readonly string[], categories: Record<string, string[]>): string {
  const lower = labels.map((l) => l.toLowerCase());
  for (const [cat, ls] of Object.entries(categories)) if (ls.some((l) => lower.includes(l.toLowerCase()))) return cat;
  return 'code';
}
