# Canvas engine handoff: brief items 1–3

Implemented on `codex/canvas-engine` in `/Users/krishkumarsah/Docs/Projects/Interface-codex-engine`, 2026-10-10. The workflow canvas is intended to become the main page; this delivery supplies the execution and import contracts its typed nodes need. The Phase 2 canvas UI remains Claude's lane.

## Delivery and integration

Engine-owned commits, in order:

- `7d33209` — step options, scoped assignments and pickup capture.
- `1076ee7` — durable workflow chains and owner-configured gates.
- `18cc3f9` — pinned skill previews/imports and disabled connector drafts.
- `bcdee47` — project defaults, pinned engineering identity, partial-start recovery and authenticated HTTP tests.

All are signed off and carry the required Codex co-author trailer. Only engine-owned files were staged. The existing in-flight work in this worktree remains untouched by these commits.

Shared changes are delivered separately in `docs/verification/canvas-engine/shared-integration.patch`, generated against `refs/canvas-engine/baseline` (`30eaab7472dbecd85f9bc4d066b4147a6a9da0ba`). It contains only engine additions to the 16 shared core/daemon files listed in `results.json`. One line of context deliberately avoids depending on the Phase 1 canvas imports absent from the primary checkout. `git apply --check` succeeds against `/Users/krishkumarsah/Docs/Projects/Interface`; the patch was not applied there.

To integrate, bring over the engine-owned commits above, then review and apply the shared patch. Do not copy whole shared working-tree files or merge this worktree's unrelated edits. Claude's canvas commits and Phase 2 graph changes need their own integration. The core workflow options commit imports `mockGate`, so integrate atop the primary's existing Designer/mock work.

`legacy-canvas-pickup-test.patch` changes only the Phase 1 core canvas assertion that expected workflow normalization to discard pickup text. Apply it where that old test exists; the primary currently lacks it, and Claude's newer graph test may supersede it. It is separate from the shared source patch.

## 1. Workflow step options

`WorkflowTaskDef`, normalization and validation retain `model`, `effort`, `skills`, `connectors`, `design`, `context`, `pickup` and `consults`. Invalid values produce validation problems instead of being silently dropped. Context is at most 4000 characters and pickup at most 2000, with secret refusal. Existing definitions remain valid.

At assignment promotion the engine rechecks resources and applies:

- Model and effort overrides; null uses the configured assignment value.
- Published selected skills frozen together with agent/Designer defaults.
- Connector ids scoped to this assignment, plus explicit project defaults. Attachment does not grant connector approval. MCP tool listing and invocation enforce the scope.
- Consult agent ids enforced through authenticated run identity in Team messaging. Existing assignments outside workflows retain their existing behavior.
- The exact approved mock revision and content hash, its frozen design contract, and an ordinary engineering DesignStudio job bound to that assignment. The agent can read the pinned mock identity; binding grants no artifact mutation permission.
- Bounded context and pickup sections in the regenerated assignment prompt, including review prompts and worktree preparation.

Project connector defaults use authenticated `GET /api/workflow-defaults` → `{ connectors: string[] }` and `POST /api/workflow-defaults { connectors }` → the same shape. Only known enabled connector ids are accepted. Defaults are durable and affect future assignments; normal connector Decisions remain required.

### Terminate contract

```ts
d.workflows.terminateWithPickup(id, actor = HUMAN): Promise<Record<string, string | null>>
```

The engine pauses promotion first. Active streaming-input adapters receive a bounded request for a handoff; listeners are installed before sending, with a maximum 60-second wait across all runs in parallel. It then cancels the workflow and returns redacted pickup points from the recorded handoff/transcript plus the last branch commit. Non-streaming adapters use recorded state without a model call. Finished tasks return null.

Claude must replace the direct cancel call in `canvasRoutes.ts` with this method and pass the returned map into `continuationSketch(..., pickups)`. That UI-owned route was not edited.

Continuation uses the pickup prompt rather than vendor session reuse. `RunManager.resume` binds the old assignment/worktree; a new continuation may change skills, connectors, consults or design identity. Reusing that session would require a separate scoped resume contract. The brief explicitly permits this prompt path when session reuse does not fit cleanly. No provider/model fallback was added.

## 2. Durable workflow links and gates

The new core `WorkflowLink` includes the brief's fields and durable `decisionId`, target definition versions, per-target start receipts, `jevAttempted` and `reason`. Full link records replay through `workflow_link.saved` events; older snapshots with no link map remain valid.

Authenticated routes:

| Request | Response |
|---|---|
| `GET /api/workflow-links` | `{ links }` |
| `POST /api/workflow-links { id?, from, to, gate }` | `{ link }` |
| `POST /api/workflow-links/:id/decide { option }` | `{ link }` |
| `POST /api/workflow-links/:id/cancel` | `{ link }` |

Caller-generated ids are supported so canvas chain/gate ids can be mirrored. Only waiting links are editable. Targets must already be saved, valid drafts; duplicate targets, cycles and overlapping pending ownership are refused. Gate labels must be unique and map exactly once to each candidate target. Gates have 2–8 options; chains can have 1–8 targets.

Example chain:

```json
{ "id": "canvas-chain-1", "from": "frontend-workflow", "to": ["backend-workflow"], "gate": null }
```

Example human gate:

```json
{
  "from": "frontend-workflow",
  "to": ["backend-workflow", "review-workflow"],
  "gate": {
    "kind": "human",
    "question": "Which workflow should continue?",
    "options": [
      { "label": "Build backend", "to": "backend-workflow" },
      { "label": "Review frontend", "to": "review-workflow" }
    ]
  }
}
```

Source completion starts a chain's targets or opens a bound low-risk question Decision. App/phone answers through `Decisions.respond` execute the same link choice; generic `Decisions.answer` refuses to bypass the bound executor. Human answer, link choice and Decision consumption commit together. Target start and its receipt commit atomically, so restart skips already-started targets, including a chain interrupted between targets. A target edited since confirmation cannot start through that link; `reason` asks the owner to cancel and reconfigure. Canceling the source cancels pending links and consumes their open Decisions. Already-started workflows are canceled directly.

### JEV policy

For a JEV advisory, set `kind: "jev"` and include `jev: { autoDecide, host, maxEvidenceBytes, confirmedAt, confirmedBy }`. `host` is the exact configured endpoint host including any port; the evidence byte limit is 1–24000. The UI must display the host/limit and make policy save an explicit owner action. Required confirmation fields are accepted in the input, then stamped server-side with the authenticated owner/time.

With `autoDecide: false`, JEV advises and the human chooses. With true, only an exact predefined routing label may start its saved target. Configuration must already have JEV enabled and cost/network/data confirmations. The engine verifies the bound question, source completion, target versions, host, byte limit and evidence hash; it records the exact request preview before sending and rechecks late responses. `jevAttempted` is persisted before the request, preventing duplicate metered requests after restart.

Disabled, unconfigured, failed, mismatched or oversized JEV requests leave the human Decision open. A JEV gate without a confirmed policy remains human-only. Automatic routing consumes that bound routing Decision without fabricating a generic human answer. `Decisions.requireHuman` and approvals for merge, release, publish, connectors, tools, cost and other irreversible actions remain unchanged.

## 3. Marketplace imports

These authenticated owner-triggered routes are registered by the shared HTTP patch. No background refresh is added, and no catalog host is added to general agent/provider egress. Exact one-shot GET permits are minted only inside the route handlers; redirects are refused.

| Request | Behavior |
|---|---|
| `POST /api/marketplace/github/preview { url }` | Resolves and pins a full commit, returns the catalog and hashes. |
| `POST /api/marketplace/github/import { url, commit, paths }` | Requires a matching prior preview, refetches the pinned archive, compares hashes, saves selected portable skills as drafts. |
| `GET /api/marketplace/anthropic-skills` | Uses the GitHub path, pins the commit on the first explicit request and reuses it thereafter. |
| `GET /api/marketplace/mcp?q=...` | Returns and records official Registry search previews. |
| `POST /api/marketplace/mcp/draft { name, version }` | Rechecks previewed metadata and saves a disabled connector draft. |

GitHub preview returns `{ url, repo, commit, license, licenseSha256, licensePath, licenseText, archiveSha256, skills, untrusted: true }`. Skill rows expose name, description, path, `SKILL.md` SHA-256, the complete file hash/byte manifest, `draft`, `problems` and `omittedMetadata`. Import paths are the preview's `SKILL.md` paths. Attribution records repo, commit, license and file hashes; a skill's own LICENSE takes precedence in its draft. Unknown frontmatter metadata is shown as omitted rather than silently interpreted. Existing owner-edited drafts are never overwritten. Review/publish remains a separate owner action.

Bounds: HTTPS GitHub URLs only, safe paths, compressed archives at most 8 MiB, expanded archives 32 MiB, at most 2048 files, 512 KiB per file and 512000 bytes per skill and 64 skills. Archives are parsed in memory without extracting or executing files; traversal, link entries and special files are refused. Upstream licensing is preserved.

The existing portable skill library supports instructions and up to 12 `references/*.md` or `references/*.txt` references. Skills requiring executable scripts/assets outside that representation return `draft: null` with problems and cannot be imported. This deliberately exposes the compatibility limit instead of silently discarding those resources.

Registry rows expose exact name/version, canonical server metadata SHA-256 and the metadata. This pins catalog metadata, not a downloaded package's bytes. A supported fixed-version npm stdio entry uses local `npx` when present; other transports produce an inert, disabled setup-required draft. The runtime currently supports local stdio, so remote/non-npm entries need owner configuration. No package is downloaded or server spawned during import. Draft tools start empty; activation is blocked until the owner configures the actual tool inventory, then the normal connector approval applies. Re-import preserves existing owner configuration.

## Verification

All checks ran locally against the engine working tree, including the shared integration edits, with fixtures and disposable repositories/data. No live GitHub, MCP Registry, paid provider or production data calls were made.

| Check | Result |
|---|---|
| Core, daemon and web TypeScript projects | All pass |
| Five new test files (options, links, routes, marketplace) | 27/27 pass |
| Full core + web projects | 264/264 pass, 33 files |
| Related daemon regression files | 92/93 pass; one known baseline failure |
| Web production build | Pass, 445 modules |
| Shared patch against primary (`git apply --check`) | Pass; no primary mutation |

Commands and failure detail are recorded in `docs/verification/canvas-engine/results.json`.

Known failure: `packages/daemon/test/workflows.test.ts:178`, “failed checks, changes requested and cancel are durable states; retry reruns through dispatch”, expects `changes_requested` but receives `blocked`. The same targeted failure was reproduced in an untouched extraction of `refs/canvas-engine/baseline` at `/tmp/canvas-engine-baseline-check`. It also appears in Claude's earlier handoff. This delivery does not claim the full daemon suite is green; only the related regression files were run.

## Remaining integration

- Claude's Phase 2 typed graph UI, workflow main-page interactions, import previews, inspectors, bottom panel and One Ask strings.
- Mirror saved canvas chains/gates to the link routes; surface link status/reason and owner-confirmed JEV policy controls.
- Wire canvas termination to `terminateWithPickup` and pass the map into continuation creation.
- Apply the shared patch alongside the engine commits and rerun checks in the combined graph/UI checkout. The core/web result above covers the engine's Phase 1 canvas snapshot, not Claude's uncommitted Phase 2 graph.
- Validate live upstream API compatibility and native desktop UX separately when authorized. They were not exercised here.
- Resolve the existing workflow review regression in its owning lane.

Item 4 (relicensing) was outside the user's request for items 1–3 and was not implemented or run. No web source, `core/src/canvas.ts` or `server/canvasRoutes.ts` was edited by this delivery.
