# Codex task: the canvas engine for One Connect

You are working in parallel with Claude. Claude builds the ComfyUI-style canvas UI on branch `codex/claude-canvas-ui` (worktree `../Interface-canvas`). You build the engine it needs, on branch `codex/canvas-engine`, in this worktree (`/Users/krishkumarsah/Docs/Projects/Interface-codex-engine`).

Read `CLAUDE_CANVAS_UI_HANDOFF.md` first. It explains the canvas, the owner's decisions, and how shared files are delivered.

## Ground rules (from the owner and the project)

- **Ownership.** Edit only the files you own (listed below). Never edit `packages/web/**`, `packages/core/src/canvas.ts` or `packages/daemon/src/server/canvasRoutes.ts`; those are Claude's.
- **Commits.** Commit your own new files on this branch with `git commit -s` and a `Co-Authored-By: Codex <noreply@openai.com>` trailer. Never commit other people's uncommitted changes. This worktree contains many in-flight edits from other workers.
- **Baseline.** That in-flight state is snapshotted as `refs/canvas-engine/baseline`. For files that other workers also edit (`core/src/entities.ts`, `events.ts`, `reducer.ts`, `index.ts`, `daemon/src/daemon.ts`, `server/http.ts`, `daemon/src/workflows.ts`, `decisions.ts`, `jev.ts`, `skills.ts`, `connectors.ts`, `runManager.ts`, `mcp/*`), keep your hunks minimal. Deliver them as `docs/verification/canvas-engine/shared-integration.patch`, generated from that baseline (see how Claude did it in the handoff), and check it with `git apply --check` against the primary checkout `/Users/krishkumarsah/Docs/Projects/Interface`.
  - `packages/core/src/workflows.ts` is clean at HEAD, so you may commit it directly.
- **No network, no live services.** No live network, no paid or live provider calls, and no downloads. Tests use fixtures. Network features must run only when the owner triggers them in the app.
- **No fallback.** Never add a provider or model fallback.
- **Keep every safety rule.** Pre-flight, allowed paths, secret refusal, Decisions requiring a human for gated actions, and JEV's preview and host confirmation all stay in force. The only exception is the explicit, owner-configured JEV gate policy described in item 2.
- **Tests.** Add focused vitest tests for each item. Before you finish, run `npx tsc -p packages/core`, `npx tsc -p packages/daemon`, and the related tests. Run vitest from the repo root.
- **Report.** When done, write `CODEX_CANVAS_ENGINE_HANDOFF.md` covering: what's done, contracts, test results, the shared patch, and what's left. Commit it. Never claim untested behavior works.

## 1. Workflow step options (the canvas attaches these to step nodes)

Extend `WorkflowTaskDef` in `packages/core/src/workflows.ts` with these optional fields, keeping old definitions valid:

```ts
model?: string | null;            // from the Agent node; else the agent's configured model
effort?: Effort | null;           // from the Agent node
skills?: string[];                // skill ids from Skill nodes; frozen into assignment.skills on top of the defaults
connectors?: string[];            // connector ids from Connector nodes; the step's agent may use only these plus project defaults
design?: { artifactId: string; rev: number } | null;  // Designer node: an approved mock revision to follow
context?: string | null;          // One Ask / summary text attached to the step (bounded, ≤ 4000 chars, secret-checked)
pickup?: string | null;           // pickup point carried from a terminated attempt (≤ 2000 chars)
consults?: string[];              // agent ids this step's agent may message (agent↔agent edges)
```

- `normalizeWorkflow` and `validateWorkflow` validate them. Add new issue codes as needed: unknown skill, connector, artifact or revision, revision not approved, consult with self, and so on.
- The daemon's assignment creation for workflow tasks passes them on:
  - model and effort onto the assignment;
  - skills frozen as `SkillRef` (like `Skills.freeze`);
  - design → `designRevision` plus the mock binding Designer's `prepareEngineering` uses (look at `daemon/src/designStudio.ts`);
  - context and pickup appended to the assignment prompt in a bounded section;
  - consults recorded so the Team messaging bridge (`daemon/src/team.ts`, MCP `send_message`) allows exactly those pairs for that assignment.
- **Pickup on terminate.** Before a workflow is canceled from the canvas (`daemon/src/server/canvasRoutes.ts` calls `d.workflows.cancel`), give `Workflows` a method `terminateWithPickup(id)`:
  - For runs whose adapter has `capabilities.streamingInput`, send a bounded "write a pickup point in the handoff format" message, then wait up to 60 s for a handoff.
  - Then cancel.
  - For other adapters, build the pickup point from the transcript and last commit, without calling a model.
  - Return the pickup points per task id. Claude will call it from `canvasRoutes.ts`; document its signature in your handoff.
- **Resume.** When a continued task has `pickup` and its previous run has a resumable `sessionId` (`capabilities.resume`), resume that session instead of starting fresh, if that fits `runManager` cleanly. Otherwise put the pickup point in the prompt.

## 2. Linking workflows into one big workflow, with gates

Add a durable `WorkflowLink` (new `packages/core/src/workflowLinks.ts`, new `packages/daemon/src/workflowLinks.ts`, events through the shared patch):

```ts
interface WorkflowLink {
  id: string;
  from: string;                    // workflow id
  to: string[];                    // candidate next workflow ids (one when there's no gate)
  gate: null | {
    kind: 'human' | 'jev';
    question: string;              // ≤ 500 chars
    options: { label: string; to: string }[];   // each option starts one workflow
    jev?: { autoDecide: boolean; host: string; maxEvidenceBytes: number; confirmedAt: string; confirmedBy: string } | null;
  };
  status: 'waiting' | 'open' | 'decided' | 'started' | 'canceled';
  decision: { option: string; by: 'human' | 'jev'; at: string; advisoryId?: string } | null;
}
```

- Routes: `GET /api/workflow-links`, `POST /api/workflow-links` (create or update while `waiting`), `POST /api/workflow-links/:id/cancel`, `POST /api/workflow-links/:id/decide` (human, `{ option }`).
- When `from` completes:
  - no gate: start every `to` workflow (they must be saved drafts; validate on link save);
  - human gate: raise a Decision with the gate's options (kind `question`), linked to the link;
  - JEV gate: request a JEV advisory through `daemon/src/jev.ts`.
- **JEV autonomy.** The owner chose both "JEV recommends, you approve" and "JEV decides low-risk choices".
  - Default `autoDecide: false`: show JEV's recommendation, and a human picks.
  - With `autoDecide: true`, set by the owner per gate with a recorded confirmation of host and evidence limit (`confirmedAt`/`confirmedBy`), JEV's answer may pick one of the gate's options and continue the flow.
  - It may only choose among those predefined "start workflow X" options. It never answers a Decision that authorizes merge, release, publish, connector or tool access, cost, or anything irreversible. `Decisions.requireHuman` stays as it is for those.
  - If JEV is disabled, unconfigured, errors, or its answer doesn't match an option exactly, fall back to the human Decision. No other model is ever used.
- **Restart and cancel.** Survive daemon restarts, including a link waiting on a decision. Canceling `from` cancels its links.

## 3. Import skills and connectors from marketplaces (the owner picked these three)

Add new modules under `packages/daemon/src/marketplace/` and routes in a new `server/marketplaceRoutes.ts`. Every import shows a preview and is pinned before it's added:

- **Any GitHub repo.** `POST /api/marketplace/github/preview { url }` resolves the default branch to an exact commit SHA and lists the `SKILL.md` skills found under the URL's path, with name, description, path and SHA-256 of the files. `POST /api/marketplace/github/import { url, commit, paths }` imports them as draft skills through the existing skill library (`skillImport.ts`, `skills.ts`), with attribution: repo, commit and license detected from the repo's LICENSE. Use the public GitHub REST API and codeload tarballs; no token required.
- **The Anthropic skills repo.** `GET /api/marketplace/anthropic-skills` gives a catalog from `github.com/anthropics/skills` at a pinned commit, using the same import path.
- **The official MCP Registry.** `GET /api/marketplace/mcp?q=` searches `registry.modelcontextprotocol.io`. `POST /api/marketplace/mcp/draft { name, version }` creates a connector draft through the existing connector configuration. It is never enabled without the owner's normal connector approval (see `daemon/src/connectors.ts` and the Connectors page).
- **Limits.** Bound sizes and counts and validate URLs (https, github.com only for the GitHub source). Refuse secrets. Make network calls only from these route handlers. All tests use recorded fixtures with an injected fetch.

## 4. Relicense script (don't run it across the tree)

The owner chose **Apache-2.0 + Commons Clause** ("companies can use it and build things, but no one can sell it").

- Write `scripts/relicense.mjs`, idempotent, with a `--check` mode:
  - SPDX headers → `SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0`;
  - `LICENSE` keeps the Apache-2.0 text, prefixed by the Commons Clause License Condition v1.0 (Software: One Connect; License: Apache 2.0; Licensor: the copyright holder in `NOTICE`);
  - a `LICENSES/LicenseRef-Commons-Clause-1.0.txt` file;
  - `NOTICE`, README license section ("source-available, not OSI open source"), `package.json` `license` fields;
  - `scripts/check-spdx.mjs` accepts the new identifier.
- Third-party files and pinned upstream skills keep their own licenses. Never rewrite those headers.
- Commit the script and the new license texts only. The coordinator runs it once at integration so it doesn't conflict with every in-flight file. Show in your handoff that `--check` and a dry run on a temp copy work.

## Order

Do 1, then 2, then 3, then 4. Commit after each with tests passing. If you run out of usage, commit what passes and write the handoff with exactly what's left.
