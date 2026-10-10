# Current One Connect preview

Updated October 9, 2026. The latest checkpoint is **One Connect Studio**, an unsigned macOS arm64 debug app with separate application data. The full product goal remains active.

## Open the latest app

[One Connect Studio.app](../../dist/macos/One%20Connect%20Studio.app)

This checkpoint contains the reviewed Claude One Answer and Designer Studio handoffs, parent integration corrections, per-action MCP plugin approvals, skills portability and terminal ownership fixes. Existing bundles and the owner's open app and unsaved draft were preserved. `rebundle-studio-build.json` pins the engine and executable; `rebundle-studio-source-manifest.json` records 254 source inputs.

The engine SHA-256 is `fb1fa06d7b286395925417c97a1f03add1b736e21c6e00643c65fec728aa7aca`.

## Verified in this checkpoint

- Integrated Node 24.21.0 workspace: **787 passed, 4 optional checks skipped, 0 failed**, across 89 files. See `designer-primary-workspace-results.json`.
- Native Rust: **24 passed, 0 failed**. The native authenticated HTTP bridge now supports Designer draft PUT requests. A macOS PTY early-EOF fixture was corrected without changing production terminal behavior.
- All workspace typechecks, production web build, extracted Node 24 engine import and offline locked app build passed. SPDX checked 333 source files; generated notices cover 166 compatible runtime dependencies.
- Actual installed Chromium and offline WebKit isolation checks passed separately. The four optional checks skipped by the broad suite are not claimed as executed in that suite.
- Real native Designer fixture journey: saved and restored a brief, validated and saved contract v1, created the issue/assignment, dispatched a repository-owned fake agent, answered its live question in the dashboard, observed executed checks and captured immutable revision 1. Desktop, phone and tablet isolated previews rendered. The failure filter, confirmation dialog, Escape focus restoration, local page navigation and Overview content states were exercised. Approval remains disabled with an unchecked review checklist.
- Real native One Answer: truthful partial/semantic-off status, scoped keyword retrieval, measured source characters and exact cited Git source viewing. This does not prove general semantic quality or provider token savings.

Native observations and exact fixture IDs/hashes are in `studio-native-observation.json`. No live model, provider subscription, cloud tracker, tunnel, paid mode or outbound integration was activated.

## Current completion boundaries

| Area | Working evidence | Still to verify or finish |
| --- | --- | --- |
| Designer | Versioned contracts, project-scoped drafts, streamed jobs/questions, capture/refine/review/handoff backend/UI fixtures; native save/generate/capture/preview | Native project switch/restart/refine/independent-review/export; real provider design quality |
| One Answer | Incremental committed intake, local Obsidian notes, Graphify, bounded/cited retrieval; native keyword source viewing | General retrieval quality, real Obsidian app reload, fully connected project acceptance |
| Plugins/skills | Reviewed per-call human Decisions, exact argument/config bindings, durable receipts; portable published skills | Native plugin approval journey and authorized live connector/tool checks |
| Development workflow | Authenticated local HTTP/WebSocket journey with real child fixtures, Git worktrees, exact-SHA independent review, local merge/checks and restart | Live subscription agents, paired-phone approval and GitHub/Linear round trip |
| Workflows/Team | Existing engine and shared project context; source/fixture evidence exists | Finish the quota-interrupted orchestration assignment and connected multi-agent acceptance |
| Terminal/Docker/release | Native PTY checks, local Docker/Postgres checks from earlier checkpoint, guarded ordered release fixtures | Native real project environment/database journey; real CI/deploy/real-device acceptance |

## Workers

Claude's One Answer and Designer Studio handoffs are independently reviewed, integrated and included in Studio. Their original records are in `delegation/CLAUDE_ONE_ANSWER_HANDOFF.md` and `delegation/CLAUDE_DESIGNER_HANDOFF.md`.

Cursor completed several assignments; its plugin continuation then exhausted quota. The Codex backend worker also hit its included-usage limit and was closed. Partial work was preserved and completed by the coordinator. Antigravity's quota is exhausted according to the owner; it is not being restarted and no paid fallback is enabled. Its prepared orchestration checkouts contain no identified implementation changes. See `delegation/parallel-worker-workspaces.json`.

## Earlier checkpoints

`dist/macos/One Connect.app`, `One Connect-next.app`, `One Connect-skills.app` and the separate Skills Verification app remain preserved. Studio uses its own identifier `dev.oneconnect.studio-checkpoint` and does not migrate the owner's original application data. Historical results and observations are retained in `current-preview-before-studio-2026-10-09.md` and their individual verification records. Use Studio to see the newly accepted source.
