# Canvas UI handoff (Claude → Codex)

Branch `codex/claude-canvas-ui` in the worktree `/Users/krishkumarsah/Docs/Projects/Interface-canvas`.

On 2026-10-09 the worktree was cut from the primary checkout's HEAD `5543b43`, plus every uncommitted and new file in the primary at that moment. That includes the Designer studio work, which had already been merged there. A snapshot of that starting point is kept as the ref `refs/canvas/baseline`; diff against it to see only this work. I committed only my own files. I did not edit, stage or reset anything in the primary checkout except this handoff copy in `docs/verification/delegation/`.

This is not a claim that One Connect is complete.

## What the owner asked for

The owner asked to simplify a cluttered UI without losing any feature. In their words, it should be "node based as in how comfy ui works, a blank canvas where you should be able to add the architect or design you just generated", so that you can "create a node based issue with all the available features in this app".

Their requirements:
- **Hiding.** "once one workflow is finalized you can hide it from the canvas and only show when your input is needed (configurable with easy ui)".
- **Locking.** "finalized workflow cannot be modified further unless you terminate the agent".
- **Terminating.** Terminating "should still persist the context and before force terminating it will write a small pickup point to pickup from when run again".
- **Many workflows.** "you can make multiple node workflow for multiple agents".
- **Settings.** "settings should be a different popup not on the main screen".
- **Navigation.** The "categorized nav has too many options which could be consolidated into 1 page".

Their answers to my questions:

| Question | Answer |
|---|---|
| Main screen | Dev-cycle node canvas, ComfyUI-style |
| Interactivity | Fully editable graph |
| Canvas library | Add React Flow (`@xyflow/react`, MIT); download approved |
| Settings popup | Agents and sign-in, Connectors, Skills, Projects, Phone and alerts, plus Settings and policies. The owner wants to "talk more about connectors and skills" (see Phase 2). |
| Skills and connectors | The library lives in Settings; they attach on nodes, and a step gets only what's attached plus project defaults. |
| After terminate | Only unfinished steps become editable. Finished steps stay locked with their evidence. |
| Remaining pages | "Decide for me." I chose a List view toggle (work board), an Insights panel (overview, reports, analytics, release), an agent drawer (console plus team conversations), and terminals in a drawer reached from a node or ⌘K. |
| Where to build | "Build on top" of the in-flight changes. Codex continues if I don't finish. |

## Start here (Codex)

1. Merge the branch commits after `5543b43` (`git log 5543b43..codex/claude-canvas-ui`). All are DCO-signed with `Co-Authored-By: Claude`.
2. From the repo root, run `git apply docs/verification/canvas-ui/shared-integration.patch`. It touches four files other workers are also editing; `git apply --check` passed against the primary on 2026-10-09. If the files drift, use `-C1` or `--3way`.

   | File | Change |
   |---|---|
   | `core/src/index.ts` | `export * from './canvas.ts'` |
   | `daemon/src/server/http.ts` | Import and call `registerCanvasRoutes(app, d)` after the designer routes. |
   | `web/src/App.tsx` | Import `Shell`. For the local dashboard (`!session`), return `<Shell …/>` right after the remote checks. `ProjectSwitcher` is now exported. The paired-phone layout below it is unchanged. |
   | `THIRD_PARTY_NOTICES.md` | Generated rows for `@xyflow/react`, `@xyflow/system`, `d3-*`, `zustand`, `classcat` and their type packages (MIT, ISC, BSD-3-Clause). |

3. Run `pnpm install` (the lockfile is committed) and then the checks below.

## What's built (Phase 1)

**Shell** (`web/src/shell/Shell.tsx`, `shell.css`, `icons.tsx`)
- **Top bar:** brand, live dot and project switcher, Canvas/List toggle, Ask or jump (⌘K), Inbox (with count), Insights, Settings and Stop all. The kill-switch behavior is copied from `App.tsx`.
- **Every old route still works** and opens over the canvas (`surfaceFor()` maps them):
  - The **Settings dialog** opens for `/settings`, `/setup`, `/agents/new`, `/agents/:id/edit`, `/connectors`, `/skills`, `/projects`, `/remote` and `/phone`. Its left nav keeps the existing pages unchanged.
  - A **drawer** opens for `/inbox` (new), `/decisions`, `/insights` (new, with tabs Overview (MissionControl), Brief and reports, Analytics and Release), `/docs`, `/designer`, `/mocks(/:id)`, `/agents/:id` (console plus a Team tab), `/team`, `/workspace`, `/runs/:id` and `/workflows`.
  - `/board` is the List view.
- **Inbox:** unresolved approvals (`ApprovalCard`), the Decisions page when decisions are pending, and alerts.
- **⌘K palette:** every tool, settings section and agent, plus "Ask One Answer: …". That entry only opens One Answer; `Docs` has no query parameter, so prefilling the question is Phase 2.
- **Overlays:** focus moves in on open and back to the opener on close; Escape closes.
- **Unchanged:** the paired phone keeps its old layout and permissions untouched.

**Canvas** (`web/src/pages/Canvas.tsx`, `shell/canvas.css`)
- **Frames.** Each workflow is a frame of nodes:
  - issue nodes;
  - step nodes: Plan (coordination), Build (code) and Review;
  - edges for issue→step (`workItemId`), step→step (`dependsOn`), and dashed "reviews" edges (`reviewOf`).
- **Adding nodes.** + Add node, or double-clicking the canvas, opens a palette: plan, build and review steps; a new empty workflow; "Design a screen" (opens Designer); existing issues; and "Create an issue…", which uses the existing dialog and then places the node.
- **Editing.**
  - Drafts and unsaved sketches are edited in place: drag to connect, Delete to remove.
  - The inspector edits title, step kind, agent, issue or review target, allowed paths and "Starts after" checkboxes (the keyboard path for dependencies).
  - Validation uses the core `validateWorkflow` and shows live counts.
- **Finalize and run.** Saves through `POST /api/workflows`, then starts the workflow. The frame locks, and the engine already refuses edits to non-drafts.
- **Live status.** Running frames show per-step status, Pause/Resume, Retry for failed steps, and links to runs, the agent and the terminal.
- **Hide.** Hiding happens in the inspector's "On the canvas" section. The owner chooses what brings a workflow back: it needs my input, something fails or blocks, it finishes. The default is input plus failure. Hidden workflows sit in a "Hidden N" tray, and a frame shown because of a condition says so.
- **Terminate.** Calls `POST /api/canvas/workflows/:id/terminate`. That cancels through the workflow engine, so runs stop while transcripts, sessions, branches and evidence are kept. It then creates a continuation sketch with only the unfinished steps, each carrying `pickup` text from its last run's handoff (done, next, blocked, last commit) or its exit message.
- **Saving the layout.** Positions, frames, visibility and sketches are saved through `PUT /api/canvas`, debounced.

**Model and daemon**
- `core/src/canvas.ts`: `normalizeCanvas` (bounded and sanitized), `sketchDefinition`, `sketchFromWorkflow`, `isWorkflowLocked`, `workflowAttention`, `frameVisible`, `pickupPoint`, `continuationSketch`.
- `daemon/src/server/canvasRoutes.ts`: `GET` and `PUT /api/canvas`, stored in the kv store under `canvas:layout` with a revision number.
  - A stale revision gets a 409.
  - Payloads over 256 KiB get a 413.
  - Anything that looks like a credential gets a 400.
  - Terminate returns 409 for drafts.

## Verified

| Check | Result |
|---|---|
| `tsc` for core, daemon and web | Pass |
| `vite build` (web) | Pass |
| `vitest --project core --project web` | 262/262 pass, including the new `core/test/canvas.test.ts` (5) and `web/test/shell.test.tsx` (3) |
| `daemon/test/canvas.test.ts` | 2/2 pass: storage, sanitization, stale write, secret refusal, restart, terminate continuation, engine lock |
| `scripts/check-spdx.mjs` | 344 files pass |
| `scripts/licenses.mjs --check` | Passes with the patch applied |
| Full daemon suite | 522 pass; 17 failures, all also failing on the primary (see "Daemon suite") |

I ran the flow by hand in the built-in browser against a disposable offline demo (temp data dir, port 7396):
1. Created a workflow and named it.
2. "Create an issue…" from the palette made DEMO-1 and placed it.
3. Added a step and set the agent and issue in the inspector. The core's real coordinator-label rule rejected a Plan step without a coordination label.
4. Switched it to Build (Codex) and added a Review (Cursor) wired as "reviews".
5. Finalize and run locked the frame. Pre-flight blocked Build on the billing confirmation, as designed, and the inspector showed the reason with Retry.
6. Hide kept the frame visible "because it needs you" (blocked). Turning off "fails or blocks" moved it to the tray; Show restored it.
7. Terminate canceled the workflow and created "Checkout speedup (continued)" with both steps editable.
8. The Settings dialog, Inbox and Insights all opened over the canvas.

Not done: the native Tauri app was not checked; the coordinator rebuilds it. For the browser checks, `window.confirm` was stubbed in that test tab only.

## Phase 2: what's left, with contracts

1. **Pickup point written by the agent before a force-stop.** This is daemon work in `workflows.ts` and `runManager.ts`, both shared.
   - For adapters with `streamingInput` (Claude Code, OpenCode): send "write a pickup point in the handoff format", wait a bounded time (say 60 s) for a handoff, then stop.
   - For Codex and Cursor: stop cleanly, then build the pickup point from the transcript and diff. Spend no model turn.
   - Store it on the continuation (today `pickupPoint()` uses only what's already recorded).
   - When the continuation runs again: if the adapter has `capabilities.resume` and a `sessionId` exists, resume that session (`runManager.resume`); otherwise put the pickup point in the new assignment's prompt. That needs an optional `pickup` or `resumeFrom` field on `WorkflowTaskDef`, passed into assignment creation.
2. **Skills and connectors on nodes** (owner's choice). The owner wants to "talk more", so confirm the details with them first.
   - Add `skills?: string[]` and `connectors?: string[]` to `WorkflowTaskDef`, validated against the skill library and connector grants.
   - Freeze them into `assignment.skills` and scope connector tool access to the step, plus project defaults.
   - UI: a Library section in the palette; drag a chip onto a step node, shown as chips on the node.
   - Connector approval requests already land in Inbox and Decisions. Badge the requesting node.
3. **Design and mock nodes.**
   - An "Approved mock" input node: choose an approved mock revision and wire it into a Build step. That binds `designRevision` and the mock artifact and revision into the assignment, with the same semantics as Designer's `prepareEngineering`.
   - A "Design job" step: a `design` task kind backed by `DesignStudio.createJob`.
   - "Design a screen" currently only opens Designer.
4. **Gate, merge and release nodes.**
   - A `gate` task kind that waits for owner approval. `Approval.kind` already allows `'gate'`.
   - Merge and Release nodes that wrap the existing Review & merge flow and the Release cockpit. Their per-action Decisions stay unchanged.
5. **Polish.**
   - Pages rendered in drawers still show their own `<h1>`.
   - Prefill One Answer from ⌘K.
   - Count warning alerts in the Inbox badge if wanted; today only critical ones count.
   - Saved positions for nodes of a newly saved workflow carry over by re-keying from the sketch id (done). Check this with multiple windows open.
6. **Native app check.** In the rebuilt desktop app, test the canvas, the Settings dialog, project switching and the drawer at phone, tablet and desktop widths.

## Daemon suite

`npx vitest run --project daemon` on this branch: 522 pass, 17 fail, 4 skipped (61 files). Both failing files fail the same way on the untouched primary checkout, so neither comes from this work:
- `opencode-harness.test.ts`: 16 failures, already known.
- `workflows.test.ts` › "failed checks, changes requested and cancel are durable states": it expects `changes_requested` and gets `blocked`. I reproduced it in the primary on 2026-10-09; it belongs to whoever is changing the workflow engine.

The new `canvas.test.ts` passes.

## Local app rebundle (2026-10-09, at the owner's request)

- **What was built.** At the owner's request I rebuilt the desktop app from this branch's working tree (shared patch included). The build was an unsigned debug arm64 app, built offline with `--locked`, using the Command Line Tools SDK via `DEVELOPER_DIR`; the Xcode license is not accepted, and I did not accept it.
- **Identity.** The app keeps the original identity, One Connect / `dev.agentcontrolcenter.desktop`, so it opens the owner's real projects (one-connect, study-bro). The owner wants exactly one app on the machine.
- **Location.** `dist/macos/One Connect Latest.app`. Engine SHA-256 is `8b2c175be6bf422a2dac7bb618bd169e4173499bc1773c35af902a457a4fd3f0`, and the bundle embeds the canvas web assets. It is installed and running.
- **Data backup.** Before first launch, the project data (without engines) was copied to `~/Library/Application Support/dev.agentcontrolcenter.desktop.backup-2026-10-09`.
- **Old builds.** The owner asked to delete the old bundles and packages, but moving them to the Trash was blocked by the permission classifier. A script for the owner to run moves them to the Trash and renames Latest to `One Connect.app`. Until it runs, the old bundles, the Studio and Skills Verification checkpoints, and the old engines are all still present.
