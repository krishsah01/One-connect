# Antigravity assignment: complete the multi-agent workflow engine

**Use Claude Opus 4.6 Thinking in Antigravity**, as requested by the owner. Keep the selected subscription mode and paid overage off. If that model or included capacity is unavailable, report it; do not switch models, buy credits or enable a paid fallback.

You are a senior engineer implementing **One Connect**, our Mac-first, local-first app that brings different coding agents into one development workspace. Your task is to make collaborative and independent agent workflows work reliably from the dashboard. Implement working code and evidence, not just a plan or a critique.

## Workspace and coordination

Primary repository for reference: `/Users/krishkumarsah/Docs/Projects/Interface`.

Your prepared isolated current-source checkout: `/private/tmp/one-connect-parallel-20261007/orchestration-current-20261008`.

Start by verifying that checkout exists and reading `docs/architecture.md`, `docs/one-connect.md`, the security docs, the existing workflow/team documentation and `docs/verification/delegation/workflow-review-handoff.md`. The current source includes many fixes newer than that historical handoff. There are substantial uncommitted changes in the primary repo; **do not edit, reset, stash, overwrite or commit that checkout**. If the prepared checkout is unavailable, create your own isolated copy containing the current working/new source, not just old HEAD. Use branch `codex/antigravity-orchestration` if needed. Preserve other workers' edits and do not merge or rebundle the Mac app yourself.

Current checkpoint: 658 workspace tests passed, four optional environment checks skipped; 23 native tests passed. Cursor connector/import, phone, alert, onboarding and Skills work has been integrated after review. Cursor finished two plugin passes, then returned resource_exhausted. A Codex worker now owns backend corrections for exact per-call plugin Decisions, while the coordinator owns its UI; that work is not yet integrated. Paid fallback remains off. Claude assignments cover One Answer/context and Designer/mocks; their completion is unconfirmed. The coordinator owns native integration, provider/runtime, phone and release validation. The older orchestration checkout was preserved untouched; use this refreshed snapshot for new work. Source and fixtures are not proof of finished live-provider acceptance. You own workflows and internal team coordination. Do not duplicate their tasks.

Own `packages/core/src/workflows.ts`, `packages/daemon/src/workflows.ts`, `packages/daemon/src/team.ts`, `packages/web/src/pages/Workflows.tsx`, `packages/web/src/pages/Team.tsx`, dedicated workflow/team components/styles, focused tests and workflow/team docs. Prefer dedicated modules. Shared changes in entities/events/reducers, provider capacity, rules, assignment/run manager, API/MCP routes or general navigation must be minimal additive integration patches documented for the coordinator; do not independently rewrite these shared systems. Do not edit native Rust/Swift, packaging, provider harnesses, costs, phone, release, tracker connectors, One Answer or Designer modules.

## Existing foundation

The app already has typed workflow definitions, issue-linked tasks, dependency validation, a persisted workflow engine, Now/Next assignment queues, review gates, shared subscription capacity logic, a durable Team inbox and authenticated agent MCP tools. Inspect the actual code and tests. Finish missing behavior and fix concrete defects without creating a second scheduler or source of truth. Work must always pass through existing preflight and dispatch policies.

## Deliverables

### 1. A usable workflow builder

Let a user build a collaborative dependency graph or run independent tasks in parallel. Each executable task references an existing issue, an enabled agent, allowed paths and required checks; show those choices clearly. Provide useful editable templates such as prototype → implement → test → independent review, and parallel research/implementation followed by review. Templates are drafts, not fabricated completed work. Show a readable dependency graph plus an accessible list alternative, validation errors and why a task is waiting.

Prevent cycles, missing issues/agents, unsafe path overlaps, impossible review relationships and coordinator-only code-writing tasks before launch. A review task must target the author's actual recorded SHA and use a different reviewer. Source changes invalidate stale reviews. The UI must explain whether pause prevents new dispatch or pauses running sessions; its buttons must match the implemented behavior. Cancel stops only this workflow's work and records each result honestly. Keep draft editing/version conflicts understandable.

### 2. Durable scheduling with practical concurrency

Make readiness, queued/running/verifying/blocked/failed/done states derive from recorded evidence. When a dependency finishes, enqueue its successor; when an agent finishes Now, Next starts if policy permits. Multiple agents from one provider can work simultaneously within configured concurrency and the real shared account limits. Do not treat agents using one subscription as separate unlimited budgets. Unknown vendor capacity remains unknown; do not invent remaining percentages, forecasts or savings. Never silently downgrade a model or turn on paid usage.

Prevent duplicate assignments or duplicate process starts across rapid events, retries, simultaneous workflow launches, restarts and conflicting manual queue changes. Preserve existing ownership and one-writer-per-worktree/path guards. Scheduling decisions must carry a concrete reason and references to their source events. Retry only an explicitly eligible failed task; do not replay irreversible actions or create hidden retry loops. Use ownership plus process state, not leases, receipt ceremonies or continuous coordinator-agent chatter.

### 3. Correct completion and independent review

A successful process exit or an agent saying 'done' is insufficient. Code tasks require the real handoff, exact commit/worktree identity and configured check evidence. Checks use the existing approved Docker runtime for real projects; disposable host fixtures must stay explicitly labelled. Review completion must use the independently recorded review verdict for that target SHA. Changes requested reopen the proper work and invalidate downstream readiness. A workflow must distinguish finished implementation from merged/deployed/verified work; do not close an issue without merge and acceptance evidence.

Handle a run finishing without a handoff, a check failing after a handoff, a base/SHA moving, a stale reviewer, a disconnected agent, unsupported live input, a pending human approval, an exhausted provider and a killed run. Integrate through the existing rules/Decisions mechanisms with explicit parent patches if needed. New product/security/cost/deploy decisions belong to the human, and Jev advice cannot resolve them.

### 4. Useful cross-agent awareness and communication

Every assigned agent should be able to retrieve a compact, project-scoped snapshot: other agents' roles and statuses, issue/path ownership, Now/Next, blocking dependencies and relevant handoffs/evidence. Reuse Team snapshots and authenticated tools. Do not broadcast full transcripts, unrelated vault text or secrets to all agents.

Complete durable internal questions, replies, blockers and handoffs addressed to the relevant peer. Preserve authenticated sender/run/issue identity; a run cannot impersonate another agent or acknowledge someone else's inbox. Make delivery, queued delivery, failed delivery and recipient acknowledgement distinct. Messages to a finished or non-streaming runtime remain available for its next supported turn; do not claim a live message was delivered when the adapter cannot accept it. Preserve message history through restart and make conversations understandable in the dashboard. These are internal project events, not permission for outbound Slack/email/provider-app messages.

### 5. Minimize wasted context without losing evidence

Provide bounded context packets and paged inbox retrieval, stable cursor/sequence semantics and deduplication. Load the details of relevant handoffs on demand. Connect to One Answer through its existing interface or a small documented adapter; do not implement another embedding/graph/search engine. Track actual supplied characters and provider-reported usage separately. If you estimate tokens, label the estimate. No unvalidated claim that summaries preserve quality or cut a specific percentage of tokens. Retain source evidence links so agents can verify a summary.

### 6. Restart recovery and clear live status

Persist workflow/task transitions and internal messages in the existing append-only event store. On restart, reconcile recorded assignments/runs with actual process state; reattach where supported or show orphaned/uncertain state. Never duplicate a run solely because a browser reconnected or a status observation timed out. A pending approval remains pending and must surface a stall alert through existing rules. A recorded finished task is not re-run merely to reconstruct UI state.

Show current owners, blockers, readiness, latest meaningful events and evidence links in Workflows and Team. Keep project identity obvious and preserve state when switching dashboards. Make keyboard and narrow-screen controls work with One Connect's design system. Avoid decorative dashboards that replace truthful empty/error/loading/unknown states with demo data.

## Acceptance demonstration

Use a disposable sample Git repository, the local tracker and real child-process protocol fixtures. Keep fixture evidence separate from real vendor acceptance.

1. Create/import existing issues and build a workflow with two parallel implementation tasks and an independent review dependency.
2. Dispatch into separate scoped worktrees; see both agents' actual full output and accurate Now/Next/process state.
3. Agent A asks Agent B a scoped question; B receives and acknowledges it, replies, and A retrieves the reply. Show queued delivery honestly for a runtime lacking live input.
4. Finish one Now task with a real handoff/check/SHA. Its Next and newly ready workflow tasks start through normal policy exactly once.
5. Move the author's SHA or request changes during review; the old approval cannot complete the workflow or unblock integration.
6. Exhaust a shared provider or leave a human approval pending. Stop unsafe dispatch, show the reason and preserve existing work. Never enable paid fallback or claim unknown capacity is exhausted/available with a fabricated number.
7. Interrupt/restart the daemon during queued/running/verifying states. Recover without duplicate work or lost evidence/messages.
8. Pause, resume, cancel and retry a specific workflow/task. Unrelated projects and workflows remain unaffected.
9. Show a finished workflow with linked evidence while its issue remains open until the real merge/acceptance gates are satisfied.

## Validation, safety and handoff

Write meaningful focused unit/integration/contract tests for concurrent event scheduling, Now/Next races, same-account capacity, path conflicts, cycles, self/stale review, changes requested, blocked approval, authenticated inbox scoping, delivery failure, unsupported live input, retry/cancel/restart and two-project isolation. Preserve direct Node 24 strip-only compatibility; daemon tests transformed by Vitest alone are insufficient. Run relevant typechecks and a web build. Record actual commands/results and rendered interactions if UI tools are available; no fabricated screenshots or passing claims.

Use existing dependencies and commercially compatible code. New source needs Apache-2.0 SPDX headers. No automatic installs/model downloads, live provider/tracker/infra/tunnel activation, credentials/session-token extraction, telemetry, paid modes, account changes, publish/deploy/push/production writes or outbound messages. Protected-branch/path safeguards and the kill switch remain intact. Use only official installed vendor harnesses when separately authorized; do not control unrelated apps/chats or weaken the native mock sandbox.

Deliver working code in the isolated checkout, an exact file/commit/patch list, any small shared-file integration patches, actual test results, updated docs and `ANTIGRAVITY_ORCHESTRATION_HANDOFF.md`. DCO-sign only your own commits. Map each acceptance item to implemented-and-verified, implemented-but-unverified or missing. State external prerequisites clearly. Freeze your source after handoff so the coordinator can integrate it. Do not declare the whole One Connect product complete.
