# Current One Connect preview

Updated October 8, 2026. This is an unsigned macOS arm64 development preview. The full product goal remains active; fixture checks and a successful build do not prove live vendor, phone or deployment acceptance.

## Open the app

`/Users/krishkumarsah/Docs/Projects/Interface/dist/macos/One Connect.app`

The latest bundle contains the reviewed runtime checkpoint, phone and release continuations, Cursor connector/import and phone-client work, the alert fixes, and the One Answer stale-citation fix. Existing app projects, logs and notifications were preserved; the previous app bundle was retained separately. `rebundle-build.json` identifies the engine checksum and `rebundle-integrated-source-manifest.json` pins 220 input files. This exact bundle was opened and restored the active `one-connect` project with a live Mission Control dashboard. It showed three idle configured agents, unknown included capacity, one backlog issue and zero running or verified-done work items. One Answer remains explicitly partial and its graph AST-only. Both saved projects now report migrations as unchecked; their periodic observations have produced no new notifications since the bundle update. Historical notifications remain intact. See `notification-preview-observation.json`.

## New separately bundled source

`dist/macos/One Connect-skills.app` is the newer **Skills checkpoint**. It includes reviewed project skill import, three original templates, exact-draft publication, immutable JSON export with attribution and safe per-harness worktree export, plus terminal-stop ownership corrections. Build/Node24 extracted archive import/typechecks/license checks passed. The integrated workspace suite passed **658 tests, four optional environment checks skipped, zero failures**; native tests passed **23**. The subsequent published-editor badge correction passed 13 focused web tests and is included in this checkpoint. See `rebundle-skills-build.json`, `rebundle-skills-source-manifest.json`, `skills-portability-integration.json` and `skills-workspace-integration-results.json`.

A separate app with identifier `dev.oneconnect.skills-verification` exercised the native offline demo: seven pinned designer skills were visible; a template was loaded, saved and published as v1; both immutable skill and reference content were read; Export created the actual two-file JSON in Downloads. The export's per-file hashes and published-version hash were verified. That verification app predates the published-editor badge correction, which is fixed in the newer checkpoint. Native import/agent-assignment and live-provider journeys remain pending. The verification copy is `dist/verification/One Connect Skills Verification.app`; it has separate data from the owner's existing app. Original open apps and unsaved drafts were preserved.

The primary source now includes independently reviewed per-call MCP approvals, exact argument/configuration bindings, durable call receipts and stop/restart handling. Cursor completed two passes before its quota was exhausted; the Codex backend worker also reached its usage limit and was closed. The coordinator finished the corrections and integrated them. **709 workspace tests passed, four optional environment checks skipped, zero failures** across 78 files. Typechecks, SPDX (301 source files) and license compatibility (166 runtime dependencies) passed. This source has **not yet been newly bundled**; the Skills app remains its earlier checkpoint. See `plugin-actions-integration.json` and `plugin-workspace-integration-results.json`.

A connected disposable development journey passed against the authenticated HTTP/WebSocket daemon: issue creation, live agent text/questions, stall alert, Next auto-start, independent exact-SHA review, human-confirmed local integration merge and real post-merge checks, explicit acceptance, one network-failure retry, relay evidence boundaries, daemon restart/reattachment and evidence-linked reporting. It used repository-owned fake agent processes and local Git/check commands. It does not prove real vendor generation, paired-phone use, live trackers or deployment. See `development-journey-evidence.json`.

Claude's completed One Answer and Designer Studio handoffs have been found in their registered worktrees and copied to `delegation/CLAUDE_ONE_ANSWER_HANDOFF.md` and `delegation/CLAUDE_DESIGNER_HANDOFF.md`. One Answer is independently reviewed and integrated: **752 tests passed, four skipped, zero failed** across 82 files on Node 24.21.0, plus two direct Node contracts and the installed-local-tools demo. Its recovery, privacy-generation, packet-budget and stale-response corrections are recorded in `one-answer-integration.json`. It is not yet newly bundled. Designer Studio remains under review; its results remain worker-reported until reproduced against current source. The owner reports Antigravity ran out of quota. It is not being restarted; its workflow/Team work still needs completion or an identifiable partial implementation.

`dist/macos/One Connect-next.app` contains the reviewed provider-setup/native-terminal corrections and durable Docker mount fix. It was built offline, passed its extracted Node 24 CLI import check and is an unsigned arm64 development preview. **641 tests passed, zero skipped or failed**, across 72 test files, with real Graphify, disposable Docker/Postgres, Chromium and WebKit checks enabled. Native Rust: 22 passed. Typechecks, web build and SPDX (292 source files) passed. See `rebundle-next-build.json`, `rebundle-next-source-manifest.json`, `native-onboarding-integration.json` and `integration-workspace-with-local-engines-results.json`.

The original app above remains open and was left intact because it showed an unsaved Designer draft. Save that draft and quit the current app before opening the separate next bundle. The new native setup flow has source/component/PTY checks; rendered provider sign-in and live generation remain unverified.

## Earlier open-bundle verification

- Full Node 24.21.0 workspace suite: **612 passed, 4 skipped, zero failures** across 68 test files. See `integration-workspace-results.json`.
- All workspace typechecks passed; the daemon typecheck also passed after the last source corrections.
- **98 browser UI tests** are included in that full-suite result, including real HTTP/WebSocket client lifecycle fixtures, phone identity/scopes, expiry, offline state, reconnect and project changes.
- Native Rust: **16 tests passed** on unchanged native source, covering PTY output/lifecycle and mock-preview boundaries.
- Production web build and offline Tauri build passed. The app is a debug preview, unsigned.
- The actual packaged archive passed its isolated CLI import check using bundled Node 24. Packaging now extracts Node separately, and verified it did not change the host executable used by workers.
- SPDX check: 285 source files. License compatibility: 166 runtime dependencies; generated notices are current.

The four optional tests still skipped are real Graphify integration, a real disposable Docker/Postgres start/restart, Chromium mock-preview isolation, and WebKit mock-preview isolation. These have since been explicitly enabled and passed in separate real local checks; see [local-engines.md](local-engines.md). Those checks exposed a Docker mounted-secret lifetime bug, now fixed and tested in newer source. The open bundle still predates that fix; its unsaved Designer draft was preserved. No provider generation, paid mode, tracker/infra connection, tunnel or outbound notification was activated for these fixture checks.

## Changes accepted in this integration

| Area | Implemented and checked | Remaining acceptance |
| --- | --- | --- |
| Connectors | Draft/approval management; GitHub and Linear paged import; canonical source identities; stale preview and revoked-read refusal; local mirrors cannot publish tracker writes | Authorized live tracker round trip |
| Live browser/phone client | Verified native/paired identity, scoped actions, fresh per-action confirmation, initial connection, reconnect, expiry, revocation and project cache isolation | Real paired phone and authenticated tunnel |
| Release | Ordered exact-SHA steps, connector-read bindings, interruption inspection and rollback verification; local fixture release flow passed | Real CI, deployment and real-device verification |
| Agent runtime | OpenCode/Ollama and official CLI protocol fixtures; live text/questions, truthful failures, redaction and shared capacity guards | Full development acceptance with real subscription agents |
| Alerts | Unknown infra stays unchecked; real failures retain stable repo-scoped dedupe; only positive component recovery resets suppression; restart-safe bounded state; CI failures keep cooldown repetition | Real configured failure and recovery on a connected project |
| One Answer | Old citations cannot be relabeled with a newer indexed source revision; isolation, restart and context fixtures passed | Full semantic/Obsidian/Graphify quality completion |
| Designer | Existing pinned skills, design-system contracts and immutable mock pipeline included; current fixtures passed | Finished interactive creation/refinement/review acceptance |
| Terminal/Docker | Native PTY and guarded environment/database implementation included; fixture tests passed | Approved real Docker environment/database flow |

Earlier broad checks exposed stale fixture assumptions and a queue timing race; those fixtures now use the current confirmation protocol and deterministic outbox scheduling. One concurrent packaging run caused an OpenCode fixture child to fail with macOS EBADMACHO while the cached Node executable was being extracted over itself. Separate extraction fixes that hazard; the isolated contract and final full suite passed.

## Parallel assignments

- Cursor, official signed-in CLI on **Composer 2.5**: connectors, connector review, phone client and alert work are finished and integrated after parent review. Logs and exact status are under `delegation/cursor-*.jsonl` and `parallel-worker-workspaces.json`. The owner confirmed on-demand off; the CLI cannot verify that toggle or remaining included capacity independently.
- Cursor onboarding/terminal correction work finished on Composer 2.5, was reviewed and corrected by the coordinator, and is integrated in the separate next bundle. See `native-onboarding-integration.json` and `delegation/CURSOR_NATIVE_ONBOARDING_HANDOFF.md`.
- Antigravity, **Claude Opus 4.6 Thinking**: quota exhausted according to the owner; no restart or paid fallback. The workflow/Team assignment remains in `delegation/ANTIGRAVITY-opus-4.6-thinking-orchestration.md`.
- Claude: One Answer reviewed and integrated (752 workspace tests passed); Designer Studio review pending. Original handoffs and worker-reported results are preserved separately.

Source presence, fixture behavior, native rendered behavior and connected product acceptance are recorded separately. The preview is not a finished production release.
