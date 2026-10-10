# Designer studio handoff (Claude)

Branch `codex/claude-designer-studio` in the worktree `/Users/krishkumarsah/Docs/Projects/Interface-designer-studio`.

The worktree contains HEAD `5543b43` plus every uncommitted and new file from the primary checkout. It was last refreshed against the primary on **2026-10-08**, while another worker was mid-change on connector tool approvals. I did not edit, stage, reset or stash anything in the primary checkout except this handoff copy in `docs/verification/delegation/`. I did not touch its native bundle. I committed nobody else's changes.

This is not a claim that One Connect is complete. The coordinator owns native rebundling and final product acceptance.

## Start here (Codex)

1. Merge every commit on the branch after `5543b43` (`git log 5543b43..codex/claude-designer-studio`). All are DCO-signed with a `Co-Authored-By: Claude` trailer:

   | Commit | Content |
   |---|---|
   | `4cfb706` | Core and daemon: contract v2, studio jobs, capture, refinement, review and handoff; 4 original skills; fixture scenario; tests. |
   | `3c9824b` | Studio UI (Designer and Mocks pages, `components/designer/*`) and web tests. |
   | `391104b` | `docs/designer.md`, this handoff, and `docs/verification/designer-studio/` (patches, rendered evidence, check scripts). |
   | `bf6b8ab` | Returns `packages/daemon/test/mocks.test.ts` to its HEAD content. Another worker has uncommitted edits there, so my assertions moved into the shared patch. |
   | `63c7c99` | Web tests load local-dashboard authority first (the newer phone-authority gating requires it). |
   | Latest | This handoff refreshed and the shared patch regenerated (2026-10-08). |

   The commits only touch files nobody else had uncommitted changes in at refresh time, so they should merge without conflicts.

2. Apply `docs/verification/designer-studio/patches/shared-integration.patch` with plain `git apply` from the repo root. It holds my hunks in **11 files** that other workers are also editing (72 changed lines; contracts below). It was regenerated against the primary's working tree on 2026-10-08 and `git apply --check` passed.
   - If those files move again, use `git apply -C1` or `git apply --3way`. Every hunk is small and anchored on designer-specific lines.
   - The branch does not compile without this patch: `daemon/designStudio.ts` commits the new `design.studio` event type.

3. Leave `docs/verification/designer-studio/patches/harness-owner-claude-allowed-tools.patch` for the Claude harness owner. It adds `get_design_mock` and `submit_design_review` to Claude Code's MCP allowlist. Not applied; it applies cleanly.

4. Still to check in the rebundled desktop app (I could not):
   - Open a revision in the native interactive preview at phone, tablet and desktop sizes. Tab through it, open and close the dialog, follow local page links, and try an external link.
   - Switch projects with a studio draft open and confirm it is still there afterwards.

### Shared-file contracts (`shared-integration.patch`)

| File | Change | Contract |
|---|---|---|
| `core/src/events.ts` | `'design.studio': DesignStudioEvent` (type import) | One discriminated event type owned by `designStudio.ts`: `job_created`, `job_updated`, `capture_recorded`. |
| `core/src/reducer.ts` | `case 'design.studio'` calls `applyDesignStudioEvent` | Pure; no other state is touched. |
| `core/src/entities.ts` | `designStudio?: DesignStudioState` | Optional; absent until the first studio event. Snapshots stay compatible. |
| `core/src/index.ts` | `export * from './designStudio.ts'` | |
| `daemon/src/server/http.ts` | `registerDesignerRoutes(app, d)` after the library routes | All new routes are under `/api/designer/*` and `/api/mocks/*`, and inherit Host/Origin/auth. Remote phone sessions stay deny-by-default. The evidence upload route has an 8 MB body limit. |
| `daemon/src/skills.ts` | `freeze()` calls `d.designer.defaultSkillIds(item)`; the local `DESIGN_LABEL` is removed | Same result for `design/ui/mock/frontend/branding` labels (the whole pinned library). `design-implementation` and `design-review` labels get the narrower sets in `designer.ts`. |
| `daemon/src/mcp/server.ts` | `register_design_mock.handoff`; `record_mock_evidence.action/tool/page`; new `get_design_mock` and `submit_design_review` | The daemon validates everything. Handoffs are stored as claims. |
| `daemon/src/mcpBridge.ts` | Passes `handoff`; evidence access goes through `d.mocks.assertAgentAccess`; new cases for the two tools | Access widens only to revisions the run's own assignment produced or continues (refinement). Reviews require a recorded review job for that exact artifact and revision. |
| `web/src/lib/store.ts` | Dedupe control events by sequence, not "older than the newest seen" | Fixes stale live state (see below). Regression test: `web/test/live-store.test.tsx`. |
| `daemon/test/mocks.test.ts` | Guard text; owner-edited revision now needs a checklist and an independent approver | Three-way merged with the other worker's `skillLib.publish(…, draftHash)` change, which is kept. |
| `THIRD_PARTY_NOTICES.md` | Four rows for the new original skills | Byte-identical to what `scripts/licenses.mjs --write` generates for those rows. |

**Live-state bug found while testing.** It is still present in the refactored store as of 2026-10-08; the fix is re-applied there. Runs could show as still running in the dashboard until a reload. The cause is in shared code. Bus listeners such as `phone/notifications.ts` commit synchronously while an earlier batch is still being broadcast, so the browser can receive seq N+k before seq N. The old guard `if (control && e.seq <= s.seq) continue` then dropped `run.ended`. The patch fixes the client. Owners may also want the daemon to emit nested commits in sequence order.

## Acceptance status

| # | Item | Status | How it was shown |
|---|---|---|---|
| 1 | Save a project design system and verify its immutable revision | **Implemented and verified** | Demo UI: validate, then save v1 (`2acadffa…`) and v2 (`7f3d998e…`) with notes and diffs; restart keeps both. Tests: drafts never frozen, secret refusal, contrast blocking, schema 1 byte-stability, history, diff. |
| 2 | Multi-screen brief with states; eligible subscription agent; exact scoped assignment preview | **Implemented and verified** | Demo: 3 screens; 4 states; relay shown as ineligible with the reason; exact prompt (7,640 characters) and pre-flight shown before dispatch. The included-plan confirmation blocked dispatch until the owner attestation was recorded, as designed. |
| 3 | Dispatch through existing machinery, observe child output, answer a question in One Connect | **Implemented and verified (fixture)** | The labelled fixture CLI (`examples/fake-agent`, "Fixture design agent: no model is called") ran as a real child process over the real MCP bridge. Its `ask_human` question appeared in the job card and was answered there; the answer changed the mock (failures listed first). No official provider was invoked. |
| 4 | Capture from the worktree; exercise interactions at phone/tablet/desktop **through the native boundary** | Capture: **verified**. Interactions: **verified in browsers**. Native window: **pending** | Agent registration with a structured handoff; automatic capture on completion; recorded capture failures (test). Interactions were executed in headless Chrome 154 (all states at 390/820/1280, real-key Tab → Enter → Escape with focus return) and in the built-in browser pane, both on the trusted preview shell over loopback. The **Tauri native window was not exercised**: the desktop app is being rebundled by the coordinator. The real-engine WebKit isolation harness passed with the modified shell. |
| 5 | Refine part of the mock; compare immutable revisions; stale approval and drift visible | **Implemented and verified** | Demo: same-session refine produced rev 2; Compare showed the line diff and side-by-side renders. Saving v2 made rev 1's approval stale (banner, gallery badge, "needs review"). A new-assignment refine produced rev 3 on v2 in the same artifact. |
| 6 | Independent review with actual check evidence; approve the exact revision; export the bundle | **Implemented and verified** | Demo: checklist bases browser/browser/static/browser/human with linked evidence on rev 1 and rev 3. The approved-only bundle for rev 3 contains files, manifest, checklist, 12 evidence entries, 10 screenshots, DESIGN.md, tokens and `published:false`; rev 2 was refused (409). Tests: the author cannot be the sole approver, and an independent agent review over MCP completes the gate. |
| 7 | Engineering assignment bound to the approved identity; switch projects and restart without leakage | Engineering and restart: **verified**. Project switch: **verified at the daemon level; desktop switcher pending** | Demo: DSN-3 bound to rev 3, content `186dd80e…`, contract v2; implementation skill set; draft only. A restart snapshot was byte-identical. Tests: two projects with separate data dirs share no jobs, drafts or contract, and drafts survive a restart. |
| 8 | Hostile navigation/network/IPC, path escapes, changed files, symlink swap, oversize, secrets | **Guards retained and tested**. Native proof **pending** | Existing tests pass unchanged (`mocks.test.ts`, `mock-capture-race.test.ts`), plus new hostile-evidence tests: symlinked or non-image screenshots, traversal paths, draft-key traversal, invalid or contradicting handoffs, oversize uploads. Both real-engine isolation harnesses **pass** with the modified preview shell: WebKit, and Chromium 154 after its owner fixed the harness to attach to out-of-process sandboxed frames. |

## Tests run (worktree after the 2026-10-08 refresh, Node 26.5)

| Check | Result |
|---|---|
| `npx tsc -p` core / daemon / web | All pass |
| `npx vite build` (web) | Passes |
| `node scripts/check-spdx.mjs` | 319 files pass |
| `node scripts/licenses.mjs --check` | Passes: manifest hashes verified and notices up to date, with my four rows. |
| `node --test packages/daemon/test/designer.strip.test.mjs` | 1/1 pass (strip-only TypeScript) |
| `npx vitest run --project core --project web` | 225/225 pass |
| Focused designer and mock tests (11 files across core, daemon and web) | 42/42 pass |
| `git apply --check` of both patches on the primary checkout | Pass |
| `npx vitest run --project daemon` (with `ACC_MOCK_TEST_WEBKIT` and `ACC_MOCK_TEST_CHROMIUM` set) | 480 pass, 16 fail, 2 skipped (54 files). All 16 failures are in `opencode-harness.test.ts` and are **pre-existing**: they fail the same way on the current primary checkout without my changes. Both real-engine preview isolation harnesses (WebKit and Chromium 154) pass. |

New and updated tests:

- `core/test/design-studio.test.ts` (14 tests);
- `daemon/test/designer-studio.test.ts` (6, including the full end-to-end flow with the fixture CLIs);
- `daemon/test/designer.strip.test.mjs`;
- `web/test/designer.test.tsx` (3) and `web/test/live-store.test.tsx` (1);
- `daemon/test/mocks.test.ts` was updated (now delivered in the shared patch). Its old exact text `window.open=()=>null` became the new guard text. Approval of the owner-edited revision now asserts `needs_independent_review` plus a checklist, then completes with an independent agent review. These are behavior changes the brief requires, not hidden defects.

## Behavior changes the coordinator should know

- **Saving the contract during active runs is now allowed.** It was blocked before. Runs and assignments keep their frozen revision; mocks show drift.
- **Approval needs a passing checklist and an independent approver.** The old `/review` route still records "changes requested". Approving through it without a checklist now returns 409 with an explanation; the UI uses `/decision`.
- **Preview.** `preview()` returns a trusted shell carrying every page of the revision, plus a script-free `static` document. The shell gained a viewport meta tag. Without it, mobile emulation laid the frame out at 980px; found and fixed during the browser check. It also gained a polite status line and `history.back()` routing. The CSP, sandbox, IPC denial and native host code are unchanged.
- **Static lint.**
  - It no longer treats `data = …` or `src = …` *in scripts* as unquoted HTML attributes; that was a false positive real agents would hit.
  - It adds `storage-api` warnings.
  - For studio jobs it adds handoff and brief-page findings.
  - `design/<slug>/evidence/` is excluded from capture.
- **Guard script.** `window.open` still returns `null`, and now also tells the shell why nothing opened.

## Rendered evidence (`docs/verification/designer-studio/`)

- `ui/01–09`: the dashboard during the demo:
  - contract v1 saved, with contrast and diff;
  - the draft job's exact prompt and pre-flight;
  - the agent question with the live transcript;
  - the phone static render;
  - compare;
  - drift and the stale approval;
  - the final studio, gallery and contract v2 specimen.
- `browser-rev1/`, `browser-rev3/`: headless Chrome renders of every state and viewport, with `report.json`. `browser-rev3` adds the real-key keyboard path. Produced by `scripts/cdp-states.mjs`, network blocked except loopback.
- `pane-keyboard-rev1/`: built-in browser pane walkthrough (filter by keyboard, dialog focus in and return, local page routing).
- `scripts/upload-evidence.mjs` attached these images through the same API the Evidence tab uses. Each entry names its tool and says it is **not the native isolated window**. The rev 1 tool label for the Chrome images is cut at the field's 120-character limit; evidence is immutable, so it stays.

Screenshots of the dashboard were taken in the Claude built-in browser. The browser automation could not drive a native `<select>` popup, so the state switcher was exercised through the DevTools protocol instead. I did not claim it was exercised by hand.

## How the demo ran (reproducible)

1. Make a disposable copy of `examples/sample-repo` as a git repo (`main` and `integration`), with the host-fixture marker.
2. Write a config with the fixture `codex` and `claude` binaries plus a relay agent, a local tracker and port 7391.
3. Start the daemon:

   ```bash
   ACC_ALLOW_TEMP_DATA_DIR=1 ACC_DATA_DIR=<dir>/state ACC_NATIVE_FILE_HELPER=<rustc-built mock_file.rs> ACC_DEMO_FIXTURES=1 node packages/daemon/src/cli.ts daemon --config <dir>/control-center.yaml
   ```

4. Open the one-time sign-in link, then:
   - Designer → Design system: validate, save.
   - Studio: brief, then Create reviewable task.
   - Agents & sign-in: fixture billing attestation (fixture only; it expires on restart by design).
   - Re-run pre-flight, Dispatch, answer the question.
   - Mocks: review, refine, compare.
   - Save contract v2, refine with a new task, dispatch, review rev 3.
   - Handoff: bundle, engineering task.
5. Restart the daemon.

`ACC_NATIVE_FILE_HELPER` was built with `rustc` from `packages/desktop/src-tauri/src/mock_file.rs`, as the tests do. The WebKit harness was built with the Command Line Tools' `swiftc`. `/usr/bin/swiftc` needs the Xcode license accepted; I did not accept it.

## Not done or pending

- **Native window proof:** open revisions at 390, 820 and 1280 in the rebundled desktop app, tab through, check blocked-navigation messages and project switching. Pending until the coordinator's rebundle.
- **Playwright:** no Playwright CLI is installed and none was installed. Agents get guidance (`playwright-cli` skill), and their commands are verified against the run transcript only if they run one.
- **Claude Code allowlist:** real Claude Code runs need the harness-owner patch to call `get_design_mock` and `submit_design_review`. The Codex, Cursor and OpenCode adapters pass no per-tool MCP allowlist in their launch arguments (checked by grep). The fixture CLIs ignore allowlists, so the tests do not prove vendor-side tool permission.
- **Event ordering:** daemon-side sequence ordering of nested bus commits is left for its owners; the client is fixed.
- **Pre-existing failures:** see the test table. They are in other workers' areas and fail the same way on an untouched copy of the primary.
