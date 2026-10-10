# HANDOFF — skills-portability (Cursor / Composer 2.5)

Worker branch: `codex/cursor-skills-portability` in isolated workspace `/private/tmp/one-connect-parallel-20261007/skills-portability`.

Baseline snapshot: `aafc5b1aba818c39c25dd9f51dfecee69223e1da` (`CURRENT_SOURCE_SNAPSHOT.json`).

## Changed files

| File | Role |
|------|------|
| `packages/core/src/skills.ts` | Attribution fields, bundle types, three Apache-2.0 templates, import preview types |
| `packages/core/src/skillHash.ts` | Node-only `draftHash`/`filesHash`/`fileSha256` (subpath export, not in web bundle) |
| `packages/core/package.json` | `./skillHash` export |
| `packages/core/test/skills.test.ts` | Core hash/template unit tests |
| `packages/daemon/src/skills.ts` | `detail()` draft hash, publish requires `expectedDraftHash`, import/export, hardlink-safe `exportTo`, templates in catalog |
| `packages/daemon/src/skillImport.ts` | YAML frontmatter + bundle parse/validate for import preview (no persistence) |
| `packages/daemon/src/server/libraryRoutes.ts` | Import preview, version export, template, publish hash guard at HTTP boundary |
| `packages/daemon/test/skills.test.ts` | Extended integration: successive saves, stale publish hash, import/export round-trip, hardlink refusal |
| `packages/daemon/test/mocks.test.ts` | Publish call updated for required draft hash |
| `packages/web/src/pages/Skills.tsx` | Import UI, export download, templates, unsaved/saved badges, generation guards, conflict recovery, publish hash |
| `packages/web/test/skills.test.tsx` | Save notice persistence, template load |
| `packages/web/test/library.test.tsx` | Catalog mock includes `templates` |
| `docs/skills.md` | User-facing skills portability documentation |

No changes to connectors, workflows, One Answer, Designer, native terminal, phone, release, billing, packaging, lockfiles, or the seven licensed designer built-ins.

## Behavior delivered

### Editor and publishing
- `detail()` returns `draft: { ...SkillDraft, hash }` using the authoritative reducer hash.
- `publish(id, expectedLatest, expectedDraftHash)` and `POST /api/skills/:id/publish` reject missing/stale draft hashes with 409; no events committed on conflict.
- Skills UI keeps save/publish notices (no longer cleared by `open()`), tracks saved vs unsaved edits, blocks publish until saved, and uses generation guards against late responses.

### Import / export / templates
- Browser-local import: SKILL.md paste/file pick, optional `references/*`, or JSON bundle preview via `POST /api/skills/import/preview`.
- Validates YAML (LF/CRLF, quoted/multiline scalars, duplicate keys, aliases, unsupported keys), paths, secrets, sizes, bundle SHA-256; preview is untrusted and non-persistent.
- Optional `source`/`license` attribution preserved through draft, publish, export, re-import.
- `GET /api/skills/:id/versions/:version/export` returns portable JSON; built-ins rejected with explanation.
- Three original Apache-2.0 templates (`evidence-review`, `local-docker-db`, `one-answer-research`) via `GET /api/skills/templates/:id`.

### Provider export safety
- `exportTo` refuses to truncate hardlinked or non-regular owned files; per-file skip without touching outside sentinels.
- Tracked/foreign/worktree-edited paths still skipped; scope semantics unchanged.

## Commands and results

```bash
export PATH="/Users/krishkumarsah/Docs/Projects/Interface/.desktop-cache/node-v24.21.0-darwin-arm64/bin:$PATH"
cd /private/tmp/one-connect-parallel-20261007/skills-portability

pnpm typecheck                    # pass (core, daemon, web)
pnpm vitest run \
  packages/core/test/skills.test.ts \
  packages/daemon/test/skills.test.ts \
  packages/web/test/skills.test.tsx \
  packages/web/test/library.test.tsx   # 11 passed
pnpm build                        # pass
pnpm spdx:check                   # pass (296 files)
```

Loopback HTTP tests in `skills.test.ts` use the install token (`authorization: Bearer …`) like other daemon integration tests. Vitest required running outside the default sandbox (`EPERM` on `.vite-temp` otherwise).

## Shared patches (coordinator merge)

No edits to `packages/core/src/events.ts`, `libraryReducer.ts`, or `entities.ts` were required. Optional provenance is carried on `SkillDraft` / `SkillVersion` objects and KV payloads only.

If other workers touch `packages/web/src/styles.css`, optional additive classes: `.skill-import`, `.skill-import-preview` (not added; existing `.skill-*` styles suffice).

## Acceptance evidence

| Requirement | Evidence |
|-------------|----------|
| Successive draft saves + `detail().draft.hash` | `skills.test.ts` HTTP + library paths; `skills.test.tsx` save notice |
| Stale/missing publish hash, no mutation on conflict | `skills.test.ts` `rejects stale publish hash over HTTP` |
| Import round-trip + attribution | `imports, exports and round-trips attribution` |
| Bad YAML/path/hash/secret/bundle rejection | `rejects bad YAML…` |
| Built-in collision | existing reserved-name tests unchanged |
| Assignment snapshot after newer publication + restart | existing freeze/restart test |
| Hardlink refusal + outside sentinel | export test with `SENTINEL.txt` |
| UI preview non-persistent until save | import preview API + UI flow |
| Version JSON download | export route + Skills Export button |
| Templates | `SKILL_TEMPLATES` + UI + core test |

## Limitations

- Web dirty-state uses `JSON.stringify` comparison locally; server optimistic concurrency uses SHA-256 `draftHash`.
- Import preview does not verify license or source claims.
- Bundle hashes prove integrity, not trust (stated in UI and bundle `note`).
- No live vendor skill discovery is tested or implied.
- This handoff covers skills portability only; the wider product is not declared complete.
