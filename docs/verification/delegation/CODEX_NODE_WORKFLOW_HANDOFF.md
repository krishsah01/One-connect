# Node-based workflow canvas: handoff for Codex

Date: 2026-10-10. Author: Claude. This covers only the node-based workflow work. Everything else (license, themes, the bundled model runtime, the app rebuild and cleanup) is tracked separately.

- **Code location.** Branch `codex/claude-canvas-ui`, worktree `/Users/krishkumarsah/Docs/Projects/Interface-canvas`.
- **Engine worktree.** Branch `codex/canvas-engine`, worktree `/Users/krishkumarsah/Docs/Projects/Interface-codex-engine`. It is ready and has a brief, but nothing has been done there yet.
- **Earlier context.** `CLAUDE_CANVAS_UI_HANDOFF.md` covers the shipped Phase 1 canvas. The engine contract is in `CODEX_CANVAS_ENGINE_BRIEF.md`, items 1–3, in the engine worktree.

> **Check before editing.** A Claude session may still be working in `Interface-canvas`. Run `git status` before you edit `packages/core/src/canvas.ts`, `packages/web/src/pages/Canvas.tsx`, `packages/web/src/shell/*` or `packages/daemon/src/server/canvasRoutes.ts`, and don't overwrite uncommitted work there.

## What the owner asked for (node-workflow items)

1. **Copy ComfyUI's node-editor UX, adapted to this app.**
   - Double-clicking the canvas opens a node search.
   - A collapsible bottom panel with **Terminal** and **Logs**, like ComfyUI.
2. **Every workflow starts with an agent config node** (which agent).
3. **A workflow can contain any number of nodes**, and anything can be a node. For example, a Designer node lets the owner pick an artifact they made for the work to follow.
4. **Multiple ports per node, depending on its type.** An agent node can connect to another agent node so they can talk, for example about design choices.
5. **One Answer is renamed One Ask,** and it lives on the canvas so the owner can ask whatever they're confused about.
6. **A small summary agent** turns One Ask's results into plain language.
7. **A JEV decision node.**
8. **Several workflows connect into one big workflow.** Example: when the frontend workflow finishes, the backend workflow starts. Nodes can sit between workflows, such as a JEV decision that picks which workflow continues.
9. **Skills and connectors come from GitHub and other marketplaces** and are added to Skill and Connector nodes.
10. **One UI for everything.**

## Owner decisions that apply

- **JEV gate: both modes.**
  - Default: JEV recommends and a human picks the option (from the app or phone).
  - Optional, set per gate by the owner: `autoDecide`. With it on, JEV's answer may pick one of that gate's predefined "start workflow X" options and continue.
  - It must never answer Decisions that authorize merge, release, publish, connector or tool access, cost, or anything irreversible. `Decisions.requireHuman` stays as it is.
  - If JEV is off, errors, or its answer doesn't match an option exactly, the gate falls back to a human decision. No other model is ever used.
- **Import sources:** any GitHub repo, the official MCP Registry, and the `anthropics/skills` repo. Every import shows a preview and is pinned to an exact commit or version plus SHA-256.
- **Summary node:** uses the small local model bundled with the app. The runtime is tracked separately; the node calls whatever local summary endpoint that work exposes, and never falls back to a paid model.
- **One Ask:** rename the user-facing strings only. Internal names (`oneAnswer`, `/api/context/answer/*`) stay as they are.

## Current state

### Shipped and committed (Phase 1, see `CLAUDE_CANVAS_UI_HANDOFF.md`)

- Shell: top bar, Settings dialog, drawers, ⌘K.
- React Flow canvas with workflow frames, issue and step nodes, inspector, Finalize and run (locks the workflow), hide and show rules, and Terminate with a continuation draft.
- `/api/canvas` routes and tests.
- Commits `9ff751f` through `ccb944d`.

### In progress, not yet committed in `Interface-canvas`: the graph model, version 2

`packages/core/src/canvas.ts` has been rewritten to a ComfyUI-style typed graph:

- **`NODE_SPECS`.** The node catalog with typed input and output ports:

  | Node | Inputs | Outputs |
  |---|---|---|
  | `agent` | `skills`, `tools`, `consult` (multi) | `agent`, `consult` |
  | `issue` | none | `issue` |
  | `step` | `agent`, `issue`, `after` (multi), `design`, `skills` (multi), `tools` (multi), `context` (multi) | `done` (flow) |
  | `design` | none | `design` |
  | `skill` | none | `skill` |
  | `connector` | none | `tools` |
  | `ask` | none | `context` |
  | `summary` | `context` (multi) | `context` |
  | `note` | none | none |

  Port types are `agent`, `issue`, `flow`, `design`, `skill`, `tools`, `context` and `consult`. An edge must join an output to an input of the same type. A single-value input keeps only its latest edge.
- **Sketches.** A sketch is now `{ …, graph: { nodes, edges } }`. Node data is sanitized by `nodeData()`. Node positions stay in `layout.nodes['<frameId>/<nodeId>']`.
- **Layout version 2** adds two maps:
  - `gates`: `{ id, x, y, from, kind: 'human'|'jev', question, options: [{ label, to }], autoDecide }`;
  - `chains`: `{ id, from, to }`.
  `normalizeCanvas()` migrates version 1 sketches (`tasks` and `issues`) into graphs.
- **`compileSketch(sketch)`** returns `{ definition, problems }`.
  - Steps become tasks. The agent comes from the connected Agent node, and the issue from the Issue node. `after` edges become `dependsOn`, except that a Review's first Build becomes `reviewOf`.
  - It also emits the per-task extras: `model` and `effort` (from the Agent node); `skills` and `connectors` (from the step plus its agent); `design`; `context` (One Ask answers and summaries); `pickup`; and `consults` (agent↔agent edges).
  - `problems` lists what blocks saving, such as "Connect an Agent node to this step."
- **`deriveGraph(tasks)` and `sketchFromWorkflow()`** draw saved workflows back as the same graph. `continuationSketch(w, state, id, at, pickups?)` takes optional pickup points from the engine.
- **Status.** `packages/core/test/canvas.test.ts` passes 8/8 and `tsc -p packages/core` passes. These still use the version 1 model and do not compile yet:
  - `packages/web/src/pages/Canvas.tsx` (42 type errors; it still reads `sketch.tasks` and `sketch.issues`);
  - `packages/daemon/test/canvas.test.ts` (3 errors, same cause).

### Engine branch `codex/canvas-engine`

- The brief is written and the worktree is ready. Its baseline is `refs/canvas-engine/baseline`, it was installed offline, and it's identical to the canvas branch plus the primary's in-flight files.
- The automated Codex run never started (OpenAI returned 401 from Claude's shell), so **no engine work exists yet**.
- Start it from your own session:

  ```bash
  codex -C /Users/krishkumarsah/Docs/Projects/Interface-codex-engine "Read CODEX_CANVAS_ENGINE_BRIEF.md and CODEX_NODE_WORKFLOW_HANDOFF.md, then do brief items 1–3."
  ```

## What's left

### A. UI: `Canvas.tsx` rewrite on graph version 2 (Claude's lane unless reassigned)

1. **Typed nodes and ports.** Render nodes from `NODE_SPECS` with colored, labeled ports. Allow only same-type connections (`isValidConnection`). Single-value inputs replace their old edge.
2. **ComfyUI interactions.**
   - Double-clicking the canvas opens the node search: a keyboard-navigable list, grouped by category, where Enter adds the node at the cursor.
   - Releasing a dragged link on empty canvas opens the search filtered to compatible ports, then auto-connects. Use React Flow `onConnectEnd` when the connection is invalid.
   - A collapsible node library sidebar with drag-to-canvas.
   - Right-click menus:
     - canvas: add node, new workflow, paste, fit;
     - node: duplicate, delete;
     - frame: rename, hide, finalize, terminate.
   - Copy and paste nodes.
3. **Agent first.** A new workflow places an Agent node first, and every step needs an `agent` edge (the compile problems already say so). Agent↔agent `consult` edges show as dashed "talks with" links.
4. **Node inspectors.**
   - Agent: agent picker, plus model and effort.
   - Designer artifact: list approved mock revisions from `/api/mocks` and store `artifactId` and `rev`.
   - Skill and Connector: library picker, plus "Import from GitHub, Anthropic skills or MCP Registry" using the marketplace routes in B3.
   - One Ask: a question box that calls `POST /api/context/answer/search {query}` and stores the answer and sources snapshot.
   - Summary: calls the local summary endpoint once it exists; until then it shows the setup state.
   - Note.
5. **Between workflows.**
   - Each frame gets a workflow-in port ("start") and a workflow-out port ("finished").
   - Dragging finished → start creates a `chain`. Dropping onto empty canvas offers "JEV decision" or "Your decision", which creates a `gate` node whose option ports connect to other frames' start ports.
   - The gate inspector has the question, the options, and "Let JEV decide low-risk choices" (`autoDecide`), with a clear note on what JEV may and may not do.
   - Target workflows must be saved first, because options reference workflow ids.
6. **One Ask on the canvas.** A docked "Ask anything" box (bottom right) that also works without a node, plus an "Add to canvas" action that creates an `ask` node. Rename user-facing "One Answer" to "One Ask" across `web/src` (`Docs.tsx`, `components/OneAnswer.tsx`, MissionControl, Settings, ⌘K). Those files belong to other workers, so deliver string-only hunks in the shared patch.
7. **Bottom panel.** Collapsible and resizable, toggled with a top-bar button and Ctrl+`.
   - **Terminal:** reuse `ProjectTerminals` from `pages/Workspace.tsx`. It needs an `export` (shared patch). Desktop only; the browser shows a note linking to `/workspace`.
   - **Logs:** a new `GET /api/canvas/logs?after=<seq>&limit=<n>` in `canvasRoutes.ts`, built on `d.store.list({ afterSeq, kind: 'control', limit })` plus transcript `t.system` events. Return bounded, compact `{ seq, ts, type, agentId, runId, workItemId, text }` rows. Poll it, with filter and search.
8. **Fix tests** that still use version 1: `daemon/test/canvas.test.ts` and `web/test/shell.test.tsx` (if affected). Add web tests for typed connections, link-drop search, gates and chains.

### B. Engine (`codex/canvas-engine`; brief items 1–3, Codex's lane)

1. **Step options.** Accept the extras that `compileSketch` already emits (`model`, `effort`, `skills`, `connectors`, `design`, `context`, `pickup`, `consults`) in `WorkflowTaskDef`, `normalizeWorkflow` and `validateWorkflow`, and apply them to assignments. Today `normalizeWorkflow` silently drops them, so they're lost on save.
   - Add `Workflows.terminateWithPickup(id)`, which returns `Record<taskId, string | null>`. `canvasRoutes.ts` will pass its result into `continuationSketch(…, pickups)`.
2. **Workflow links.** A durable `WorkflowLink`:
   - Each canvas `chain` maps to `{ from, to: [to], gate: null }`.
   - Each `gate` maps to `{ from, to: options.map(o => o.to), gate: { kind, question, options, jev: autoDecide ? { autoDecide: true, … } : null } }`.
   - Routes: `GET`/`POST /api/workflow-links`, `POST …/:id/decide`, `POST …/:id/cancel`. The canvas syncs its gates and chains to these on save.
   - The daemon starts the next workflow when `from` completes, survives restarts, and enforces the JEV rules above.
3. **Marketplace routes** for the Skill and Connector node imports:
   - `POST /api/marketplace/github/preview` and `/import`;
   - `GET /api/marketplace/anthropic-skills`;
   - `GET /api/marketplace/mcp?q=` and `POST /api/marketplace/mcp/draft`.
   Network calls happen only when the owner acts, and tests use fixtures.

## Contracts the UI relies on

| UI piece | Expects |
|---|---|
| Save or Finalize | `POST /api/workflows { id, definition: compileSketch(s).definition, expectedVersion }`. The extras must survive (B1). |
| Terminate | `POST /api/canvas/workflows/:id/terminate` → `{ layout, rev, sketchId }`. The continuation carries engine pickups once B1 lands. |
| Gates and chains | `layout.gates` and `layout.chains` stored through `PUT /api/canvas`. The engine mirror is `/api/workflow-links` (B2). |
| Designer node | `/api/mocks` (artifacts and approved revisions), existing |
| One Ask node | `POST /api/context/answer/search`, existing |
| Skill and Connector import | `/api/marketplace/*` (B3) |
| Logs tab | `GET /api/canvas/logs` (A7, in `canvasRoutes.ts`) |

## Rules

- **Ownership and commits.** Claude owns `packages/web/**`, `core/src/canvas.ts` and `daemon/src/server/canvasRoutes.ts`. Codex owns the engine files listed in the brief. Never commit other workers' uncommitted changes. Deliver hunks in shared files as a patch from the branch's baseline ref, and check it with `git apply --check` against `/Users/krishkumarsah/Docs/Projects/Interface`.
- **Commit format.** `git commit -s` with a `Co-Authored-By` trailer.
- **No live services.** No live provider calls, no downloads, and no paid fallback. Keep pre-flight, allowed paths, secret refusal and per-action Decisions.
- **Verify before claiming.** Run `tsc` for core, daemon and web; vitest from the repo root; then the web build. Write results into the handoff, and never claim untested behavior.
