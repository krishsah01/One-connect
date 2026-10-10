# HANDOFF — skills-portability second pass (Cursor / Composer 2.5)

Worker branch: `codex/cursor-skills-portability` in isolated workspace `/private/tmp/one-connect-parallel-20261007/skills-portability`.

First-pass handoff preserved at `docs/verification/delegation/CURSOR_SKILLS_PORTABILITY_FIRST_PASS_HANDOFF.md`.

Baseline snapshot: `aafc5b1aba818c39c25dd9f51dfecee69223e1da` (`CURRENT_SOURCE_SNAPSHOT.json`).

## Changed files

| File | Role |
|------|------|
| `packages/core/src/skills.ts` | Strict bundle/attribution Zod schemas; `generatedReferencesFooter` / `stripGeneratedReferencesFooter`; templates unchanged |
| `packages/core/src/skillHash.ts` | Node-only `draftHash` / `filesHash` / `fileSha256` (subpath export, not in web bundle) |
| `packages/core/package.json` | `./skillHash` export |
| `packages/core/test/skills.test.ts` | Hash stability and template size tests |
| `packages/daemon/src/skillImport.ts` | YAML AST inspection, strict bundle/frontmatter validation, aggregate byte limits, bundle display-name preservation, preview hashes from provided bytes |
| `packages/daemon/src/skills.ts` | `detail()` draft hash; publish hash guard; `exportVersion` integrity + secret refusal; descriptor-safe `safeWriteFile` (no pre-validation truncate, no double-close, skip unchanged owned files) |
| `packages/daemon/src/server/libraryRoutes.ts` | Import preview, version export, template, publish hash at HTTP boundary |
| `packages/daemon/test/skills.test.ts` | Parser/export/safe-write regressions, round-trip display name, preview non-mutation, hardlink/sentinel/race |
| `packages/daemon/test/mocks.test.ts` | Publish call updated for required draft hash |
| `packages/web/src/pages/Skills.tsx` | Generation guards, import UI (bundle JSON, preview button, reference contents, editable import id), conflict recovery preserving local edits |
| `packages/web/test/skills.test.tsx` | Successive saves, publish hash, conflict reload, import preview, late-response isolation, version read/export |
| `packages/web/test/library.test.tsx` | Catalog mock includes `templates` |
| `docs/skills.md` | User-facing skills portability documentation |

No changes to connectors, workflows, One Answer, Designer, native terminal, phone, release, billing, packaging, lockfiles, or the seven licensed designer built-ins.

## Second-pass fixes delivered

### Import parser and bundle validation
- Reject absolute/traversal/backslash reference paths (no leading-slash stripping).
- YAML frontmatter: AST walk for aliases/duplicate keys; `name`/`description` must be strings (no `String()` coercion of objects).
- Allow ordinary scalars with `&` (e.g. `design & accessibility`); reject real YAML aliases/anchors.
- Strip only the exact generated `## References (load on demand)` footer for known reference paths; preserve user trailing content.
- Strict `SkillBundleSchema` / `SkillAttributionSchema` (`.strict()`): reject unknown fields, non-string values, bad version/hash/date, hash/metadata mismatches.
- Bundle round-trip preserves `bundle.skill.name` (human display name), description, attribution and reference bytes.
- Plaintext import uses aggregate byte limits; preview file hashes identify actual provided bytes.
- Import errors do not echo denylisted secret values.

### Export integrity
- `exportVersion()` runs `filesFor()` integrity checks, refuses tampered/missing/extra files, hash mismatch and newly denied secrets.
- Blocks credential-bearing source URLs and private filesystem paths in export metadata.

### Provider export safety
- `safeWriteFile`: validate via `O_RDONLY|O_NOFOLLOW` / `O_RDWR|O_NOFOLLOW` / `O_CREAT|O_EXCL|O_NOFOLLOW` — never `O_TRUNC` before `fstat`, never double-close on refusal.
- Frozen owned files with matching bytes are verified and skipped without rewrite.
- Regression tests: outside sentinel unchanged on hardlink refusal; equal-byte hardlink race; mtime unchanged on re-export of matching owned files.

### Skills UI
- Generation guards and unmount invalidation for catalog, open, view, import preview, save, publish, disable, export.
- Import: one bundle JSON file, mixed-file errors, `File.size` checks, read/JSON failures surfaced, explicit Preview bundle button, reference contents in preview, editable import id, preview invalidated on input change.
- Conflict reload preserves local unsaved edits.

## Commands and results

```bash
export PATH="/Users/krishkumarsah/Docs/Projects/Interface/.desktop-cache/node-v24.21.0-darwin-arm64/bin:$PATH"
cd /private/tmp/one-connect-parallel-20261007/skills-portability

pnpm typecheck                    # pass (core, daemon, web)
pnpm vitest run \
  packages/core/test/skills.test.ts \
  packages/daemon/test/skills.test.ts \
  packages/web/test/skills.test.tsx \
  packages/web/test/library.test.tsx   # 18 passed
pnpm build                        # pass (production web build)
pnpm spdx:check                   # pass (296 files)
```

Node 24.21.0 used via prepended PATH. Vitest loopback HTTP tests required running outside the default sandbox (`EPERM` on `.vite-temp` otherwise). `@acc/core/skillHash` imported directly in daemon/core tests (not in web bundle).

## Shared patches (coordinator merge)

No edits to `packages/core/src/events.ts`, `libraryReducer.ts`, or `entities.ts`. Optional provenance remains on `SkillDraft` / `SkillVersion` KV payloads only.

## Acceptance evidence

| Requirement | Evidence |
|-------------|----------|
| Absolute path `/references/…` rejected | `rejects bad YAML…` Unsafe path test |
| YAML object description rejected | `must be a string` assertion |
| `design & accessibility` accepted | ampersand test in `rejects bad YAML…` |
| Trailing user References content preserved | `Keep trailing content` assertion |
| Malformed bundle (object name, NaN version, fake hash, unknown fields) rejected | `previewSkillImport` strict schema test |
| Bundle display name round-trip | `imports, exports and round-trips…` + `uses preview file hashes…` |
| Preview hashes from provided bytes | `uses preview file hashes from provided bytes` |
| Aggregate import byte limit | oversized import test |
| Export refuses tampered version / secrets | integrity + credentials tests in bundle export test |
| `safeWriteFile` no truncate-before-validate, no double-close | hardlink/sentinel + mtime skip + race tests in export test |
| Successive draft saves + `detail().draft.hash` | existing freeze test + web successive-save test |
| Stale/missing publish hash, no mutation on conflict | HTTP publish test + web publish-hash test |
| Import preview non-persistent | web import preview test (`saveCalls`/`publishCalls` stay 0 until save) |
| UI generation/unmount/late-response guards | web isolation + conflict-reload tests |
| Bundle JSON file selection + preview button | Skills.tsx implementation + import preview UI test |
| Version read + export download | web `reads version content and downloads export bytes` |
| Assignment snapshot after newer publication + restart | existing freeze/restart test |
| Built-in collision | existing reserved-name tests |
| Templates | `SKILL_TEMPLATES` + UI + core test |

## Limitations

- Web dirty-state uses `JSON.stringify` locally; server optimistic concurrency uses SHA-256 `draftHash`.
- Import preview does not verify license or source claims.
- Bundle hashes prove integrity, not trust (stated in UI and bundle `note`).
- No live vendor skill discovery is tested or implied.
- This handoff covers skills portability only; the wider product is not declared complete.
