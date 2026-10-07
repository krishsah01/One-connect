# HANDOFF — designer-library (skills, connectors, design mocks)

Worker branch: `codex/designer-library` in isolated workspace `/private/tmp/one-connect-cursor-Bu9W8J/designer-library`.

## Changed files

### Core (`packages/core/src/`)
| File | Role |
|------|------|
| `skills.ts` | Project skill draft schema, limits, `skillMarkdown` / `skillAdvice`, types |
| `connectors.ts` | Typed connector descriptors (GitHub, Linear, Obsidian, Docker, MCP), config unions, `connectorAllows` / `connectorState` |
| `mocks.ts` | Mock limits, types, `mockGate`, preview CSP/sandbox constants |
| `libraryReducer.ts` | Event reducer for `skill.*`, `connector.*`, `design.mock_*` |
| `entities.ts` | `ControlState.skills/connectors/mocks`, `Assignment.skills`, `WorkItem.origin` provenance fields |
| `events.ts` | Library event types |
| `reducer.ts` | Delegates library events to `applyLibraryEvent` |
| `index.ts` | Re-exports |

### Daemon (`packages/daemon/src/`)
| File | Role |
|------|------|
| `skills.ts` | `SkillLibrary`: draft/publish/disable, assignment freeze, MCP read, worktree export |
| `connectors.ts` | `Connectors`: draft save, local check, human activation decisions, import preview/accept, gated MCP `callTool`, Docker list |
| `mocks.ts` | `DesignMocks`: capture (single-read buffers), lint, sandboxed preview assembly, edit/export/review/evidence |
| `server/libraryRoutes.ts` | HTTP routes for skills, connectors, mocks; `onSend` `frame-src 'self'` for non-API HTML |
| `daemon.ts` | Constructs `skillLib`, `connectors`, `mocks`; `refreshEgress()`, assignment skill freeze |
| `runManager.ts` | `skillLib.exportForRun` before model start |
| `mcpBridge.ts` | `list_skills`, `get_skill`, `register_design_mock`, `record_mock_evidence`, `list_connector_tools`, `call_connector_tool`; `get_design_system` includes mocks |
| `mcp/server.ts` | Registers new MCP tools |
| `adapters/agents/claude.ts` | Allows new tools (not `call_connector_tool` — stays permission-gated) |
| `designer.ts` | `builtinSkill` helpers; prompt mentions `get_skill` and `register_design_mock` |
| `context/sync.ts` | Writes `Design artifacts.md` when mocks exist |
| `server/http.ts` | `registerLibraryRoutes(app, d)` |

### Web (`packages/web/src/`)
| File | Role |
|------|------|
| `pages/Skills.tsx` | Project skills editor, built-in catalog, publish/disable, advice |
| `pages/Connectors.tsx` | Connection manager, activation inbox, import preview/accept, Docker/MCP panels |
| `pages/Mocks.tsx` | Mock browser, sandboxed srcdoc iframe, review gate, evidence, source edit, export |
| `App.tsx` | Routes `/skills`, `/connectors`, `/mocks`, `/mocks/:id` + nav links |
| `pages/Designer.tsx` | Links to mocks/skills; preserves baseline mock preview |
| `pages/AgentBuilder.tsx` | Loads project skills from `/api/skills` for assignment checkboxes |
| `styles.css` | Library page layout, mock iframe stage, explicit `h3` mock color role |

### Tests & examples
| File | Role |
|------|------|
| `packages/daemon/test/skills.test.ts` | Validation, versions, freeze, export, restart |
| `packages/daemon/test/connectors.test.ts` | Draft/no-egress, activation, Linear/GitHub import, Obsidian, Docker, MCP fixture |
| `packages/daemon/test/mocks.test.ts` | E2E design-mock, preview security, capture buffer regression, drift/review |
| `packages/daemon/test/fixtures/fake-mcp-tools.mjs` | Local MCP server fixture |
| `packages/web/test/library.test.tsx` | Skills teaching copy, mocks empty state |
| `examples/fake-agent/fake-agent.mjs` | `[fake:design-mock]` scenario |

## Behavior delivered

### 1. Project skills library
- Draft → publish immutable versions; drafts never run code or make outbound calls.
- IDs, reference paths, secrets, duplicate refs validated; built-in ids/names reserved.
- Assignments freeze `SkillRef[]` at creation/queue move; agents see descriptions only in prompt.
- MCP `list_skills` / `get_skill` with assignment scope and paged reads.
- Export to provider dirs (`.agents/skills`, `.claude/skills`, etc.) skipping tracked/foreign/symlink paths.
- UI at `/skills` teaches concise skills and on-demand references.

### 2. Connector manager
- Typed descriptors with cost/credential/availability; per-project isolation.
- Draft connections make **no** network/process calls; `check` is local only.
- Action-specific human decisions bound to `configHash`; edit voids approvals.
- Linear (injected fetch + `ACC_SECRET_LINEAR`), GitHub (`fake-gh`), Obsidian knowledge connect, Docker list, MCP execute after approval.
- Import preview with acceptance criteria, provenance (`untrusted`, `contentHash`), dedupe.
- UI at `/connectors`.

### 3. Design mock artifacts
- Agents write `design/<slug>/`; `register_design_mock` captures immutable revision.
- **Capture fix (review #2):** each file read once via `O_RDONLY|O_NOFOLLOW` into a buffer; lint/hash/store use that buffer (no second `readFileSync`).
- Preview: all local assets inlined, `MOCK_PREVIEW_CSP`, iframe `sandbox="allow-scripts"` (no same-origin).
- **Navigation fix (review #1):** guard blocks `window.open`, link/form navigation, `location.href` setter, `location.assign`/`replace`. UI copy does **not** claim zero egress.
- Review gate: findings, human exceptions (not errors), approval, contract drift detection.
- Evidence: `not_run` unless executed; agent commands `verified` only from run transcript.
- Export bundle with frozen DESIGN.md/tokens.css.
- UI at `/mocks` with phone/tablet/desktop widths.

### 4. Designer usability (preserved)
- Saved-state badge, mock color roles (`--mock-*` + explicit `h3` color), keyboard tabs, loading/empty states unchanged.

## Commands and results

```bash
cd /private/tmp/one-connect-cursor-Bu9W8J/designer-library
pnpm typecheck          # core, daemon, web — pass
set -o pipefail && pnpm test   # 20 files, 143 tests — pass (133 baseline + 10 new)
npx vitest run packages/daemon/test/skills.test.ts packages/daemon/test/connectors.test.ts packages/daemon/test/mocks.test.ts
```

Focused integration coverage: skill scope/snapshots/export/restart; connector draft/approval/import/MCP; mock preview CSP/inlining/navigation guard strings, capture single-read, drift gate, MCP token scope, HTTP auth.

**Note:** An earlier session accidentally ran `pnpm -r --filter @acc/daemon typecheck` from the linked original repo (`/Users/krishkumarsah/Docs/Projects/Interface`) before `working_directory` was set; that was read-only (`noEmit`) and made no writes. All verification above used this workspace path.

## Gaps / honest limits

| Gap | Detail |
|-----|--------|
| Desktop Tauri CSP | Parent CSP `frame-src 'none'` blocks srcdoc script execution in the desktop shell (fails safe). Web daemon UI works. |
| Preview egress | CSP blocks resource loads; guard blocks common navigation APIs. Not a formal browser security proof—host-dependent. |
| Vite dev server | `frame-src` hook only on daemon-served HTML, not Vite dev index. |
| MCP read roots | Passed to MCP server via roots capability; not kernel-sandbox enforced. |
| Obsidian disconnect | Disabling connector does not disconnect knowledge (no disconnect API). |
| MCP retry loop | Existing `mcp/server.ts` retries 60× at 2s (unchanged). |
| Review notes 3–7 | Stable vault namespaces, subscription attestation, compose approval binding, git hooks — **out of scope** for this worker; other workers own those. |

## Shared-file integration points (coordinator merge)

These files were edited and may conflict with other workers:

- `packages/core/src/entities.ts`, `events.ts`, `reducer.ts`, `index.ts`
- `packages/daemon/src/daemon.ts`, `runManager.ts`, `server/http.ts`, `mcpBridge.ts`, `mcp/server.ts`, `adapters/agents/claude.ts`, `context/sync.ts`, `designer.ts`
- `packages/web/src/App.tsx`, `styles.css`, `pages/AgentBuilder.tsx`, `pages/Designer.tsx`
- `examples/fake-agent/fake-agent.mjs`

New modules (low conflict): `skills.ts`, `connectors.ts`, `mocks.ts`, `libraryReducer.ts` (core); `skills.ts`, `connectors.ts`, `mocks.ts`, `server/libraryRoutes.ts` (daemon); `pages/Skills.tsx`, `Connectors.tsx`, `Mocks.tsx` (web).

HTTP write routes use **POST** (not PUT) for Tauri desktop bridge compatibility (`daemon_request` supports GET/POST/PATCH/DELETE only).

## API surface added (all authenticated like existing routes)

- `GET/POST /api/skills…`, `GET/POST /api/connectors…`, `GET/POST /api/mocks…` — see `libraryRoutes.ts`
- MCP: `list_skills`, `get_skill`, `register_design_mock`, `record_mock_evidence`, `list_connector_tools`, `call_connector_tool`

Existing APIs unchanged; project intake preserved.
