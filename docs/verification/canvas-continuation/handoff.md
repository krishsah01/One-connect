# Canvas termination and continuation integration

Completed the chunk on `codex/canvas-continuation` in `/tmp/Interface-canvas-continuation`, based on the combined canvas/engine branch at `280ad03`. The latest committed typed canvas UI was already calling the engine's optional pickup hook. Engine commits and shared engine hunks were brought into the canvas checkout; another session began the same integration concurrently, so these follow-up fixes were isolated before any further source edits.

## Behavior

- Termination can capture the parsed MCP handoff staged before a run exits. Previously it listened only for exit-time `run.handoff`/`run.ended`, causing a full timeout and loss of the staged text when stopping cleared runtime context.
- `RunManager.stagedHandoff(runId)` exposes that pending parsed handoff without changing normal finalization, evidence verification, or issue transitions. Pickup capture observes the existing MCP receipt event and saves the candidate before stopping.
- Pickup text remains bounded/redacted. An unverified staged commit claim does not replace the actual branch commit or create verified evidence.
- Rebuilding a saved/continued graph preserves consult scopes, including peers with no unfinished step. Steps using the same agent with different scopes get separate agent nodes. Because consult edges are bidirectional, asymmetric scopes use peer-only avatars so graph recompilation cannot grant a reciprocal permission.
- Finished steps and evidence remain on the original workflow. Unfinished tasks compile, save and start with their model, effort, frozen skills, connector scope, context and pickup. This uses the existing prompt continuation path; vendor session reuse is unchanged.

## Delivery

Only the new tests and minimal edits to `core/src/canvas.ts` and engine-owned `daemon/src/workflowOptions.ts` are committed directly. Existing shared edits in this snapshot are not staged.

The additional five-line RunManager accessor is delivered separately in `docs/verification/canvas-continuation/run-manager.patch`, relative to the captured integration starting file. Apply it together with the chunk commit. The combined checkout still requires the existing engine/UI shared integration patches; this follow-up does not replace them.

The temporary `vitest.continuation.config.ts` is local verification setup, not a product change: it aliases `@acc/core` to the isolated core source because installed dependencies are symlinked from the canvas checkout. Ordinary integrated installs can run the tests using the normal Vitest config.

## Verification

- A new authenticated HTTP lifecycle test first reproduced the staged-handoff timeout, then reproduced lost consults after fixing capture.
- Both new daemon integration tests pass: staged handoff → terminate → graph compile → save → daemon restart → start continuation; and completed planning step retained with its recorded handoff while only unfinished work reopens.
- Two new core graph tests prove exact scope preservation for asymmetric and different same-agent scopes, and deduplication of reciprocal edges.
- Combined full core/web tests plus related canvas/engine daemon files: **299/299 pass across 40 files**.
- Core, daemon and web TypeScript checks pass.
- Production web build passes, **448 modules**.
- Only fixtures, loopback HTTP and disposable local repositories/data were used. Native desktop UX, live vendors/marketplaces and the full daemon suite were not run.

Commands and results are in `docs/verification/canvas-continuation/results.json`. Gates/chains UI synchronization, marketplace response-shape alignment and the known baseline workflow review regression remain separate chunks. The installed app was not rebuilt or changed.

Chunk commit: `960c2e3bd3f00d597c179e3d5af339e1aea9b481` on `codex/canvas-continuation`. To integrate into the combined canvas checkout, cherry-pick this commit, then apply `run-manager.patch`. The patch passed `git apply --check` against the active canvas checkout after verification.
