# HANDOFF — workflow / independent review / merge (workflow-review worker)

Isolated workspace: `/private/tmp/one-connect-cursor-Bu9W8J/workflow-review`  
Branch: `codex/workflow-review` (uncommitted)  
Model: `composer-2.5` (owner-authorized; on-demand billing OFF)

## Summary

This worker delivers a typed workflow engine, SHA-bound independent reviews, human-decision-gated local merges, a phone-friendly Decisions page, Workflows editor, and honest shared subscription usage in agent cards/consoles. Behavior is proven with focused vitest integration tests (disposable git repos, fake agents). **Not a complete product** — see gaps below.

## Files changed / added

### Core (`packages/core`)
| File | Role |
|------|------|
| `src/workflows.ts` | Workflow types, validation (cycles, overlap, coordinator-only code, self-review), `readyTaskIds`, `deriveWorkflowStatus` |
| `src/reviews.ts` | Review records, merge gates (`evaluateMergeGates`), `mergeActionHash`, `reviewsForItem`, `currentApproval` |
| `src/entities.ts` | `Workflow`, `ReviewRecord`, `MergeRecord`, extended `Decision` (`kind`, `action`, `evidence`, `confirmOptions`, …) |
| `src/events.ts` | Workflow/review/merge/decision events |
| `src/reducer.ts` | Applies new events; decisions, workflows, reviews, merges in state |
| `src/models.ts` | `modelFamilyKey`, `selectNewestModel` — no cross-family version comparison |
| `src/capacity.ts` | `sharedUsageView` for multi-agent subscription honesty |
| `src/preflight.ts` | Blocks ambiguous multi-family model selection |
| `src/index.ts` | Exports workflows + reviews |
| `test/workflow-review.test.ts` | 13 tests (validation, gates, model selection, shared usage) |

### Daemon (`packages/daemon`)
| File | Role |
|------|------|
| `src/workflows.ts` | `WorkflowEngine`: save/validate/start/pause/resume/cancel/retry, evidence-based `observe`/`promote`, restart recovery |
| `src/reviewMerge.ts` | Reviews, merge request, `executeMerge` (local git, dirty worktree refusal, hooks preserved), post-merge checks, acceptance |
| `src/decisions.ts` | Human-only answers, 2-step confirm (nonce/TTL), `authorizes`, `history` |
| `src/daemon.ts` | Wires modules; `CommandError` optional `issues[]` |
| `src/runManager.ts` | Review worktrees, `onReviewRunEnded`, review runs skip lifecycle transitions |
| `src/server/http.ts` | REST routes (see API below) |
| `src/mcp/server.ts`, `mcpBridge.ts` | `submit_review` MCP tool |
| `src/adapters/agents/claude.ts` | Allows `submit_review` |
| `test/review-merge.test.ts` | 8 tests (reviews, decisions, disposable-repo merges) |
| `test/workflows.test.ts` | 4 tests (validation HTTP, collaborative flow, pause/restart, fail/cancel/retry) |
| `examples/fake-agent/fake-agent.mjs` | `review-approve`, `review-changes`, `review-handoff-approve`, `break-tests` scenarios |

### Web (`packages/web`)
| File | Role |
|------|------|
| `src/pages/Workflows.tsx` | List/editor, start/pause/resume/cancel/retry, live task progress |
| `src/pages/Decisions.tsx` | Phone-friendly decisions, evidence, risk/urgency, 2-step confirm sheet, audit history; Jev = recommendation only |
| `src/components/ReviewMergePanel.tsx` | Issue drawer: reviews, merge gates, request review/merge, acceptance |
| `src/App.tsx` | Routes `/workflows`, `/decisions`; nav badge for open decisions |
| `src/pages/MissionControl.tsx` | `sharedUsageView` note on agent cards |
| `src/pages/AgentConsole.tsx` | `sharedUsageView` note in usage section |
| `src/pages/WorkBoard.tsx` | Embeds `ReviewMergePanel` in item drawer |
| `src/lib/api.ts` | `ApiError.body` for structured validation errors |
| `src/styles.css` | Decisions/workflows mobile styles |
| `test/ui.test.tsx` | +Decisions 2-step confirm test; Mission Control shared-usage note |

## Behavior delivered

### 1. Workflows
- Typed durable definitions (`independent` / `collaborative`); tasks bind to existing issues + agents.
- Validation rejects cycles, missing items/agents, overlapping active writers, coordinator-only code tasks, self-review.
- Start goes through existing preflight/dispatch; shared subscription capacity respected (one agent Now at a time per vendor group).
- Task promotion from evidence: verified commit + daemon checks (code), typed review record (review), handoff receipt (coordination).
- Paused / failed / canceled / blocked survive daemon restart.
- UI: `/workflows` page with editor and controls.

### 2. Independent reviews
- Reviewer ≠ author; assignment carries exact target SHA.
- Findings + approve/request-changes are durable; new commit invalidates approval (`staleAt`).
- Follow-up issues created via tracker/outbox for findings with `createFollowUp`.
- MCP `submit_review` + HTTP `POST /api/work-items/:id/reviews` for human reviews.

### 3. Integration merge
- Human `Decision` bound to `mergeActionHash` (source SHA, target SHA, review id).
- Refuses: stale SHA, protected target, non-green gates, conflicts, missing approval.
- Local `git merge` only — **never push**; scope evidence on decision.
- Dirty target worktree refused without consuming decision; untracked path collision check.
- User hooks run as-is (known trust boundary — see gaps).
- Post-merge checks in host scratch worktree (`env: local`).
- Acceptance records evidence before `done` transition.
- Proven in `review-merge.test.ts` with disposable repos.

### 4. Decisions UI
- `/decisions` — large tap targets, evidence list, risk/urgency badges.
- Irreversible actions (merge) require prepare → confirm sheet with nonce.
- Audit history per decision; agent/Jev recommendations labeled as advice.

### 5. Shared usage / model selection
- `sharedUsageView` on mission cards and agent console.
- `selectNewestModel` / preflight block ambiguous picks across unrelated families.
- Tests in `workflow-review.test.ts`.

## HTTP API (new / extended)

```
GET  /api/workflows
POST /api/workflows, /api/workflows/validate
POST /api/workflows/:id/{start,pause,resume,cancel}
POST /api/workflows/:id/tasks/:taskId/retry

GET  /api/work-items/:id/reviews
POST /api/work-items/:id/review-request
POST /api/work-items/:id/reviews
GET  /api/work-items/:id/merge-gates
POST /api/work-items/:id/merge-request
POST /api/work-items/:id/acceptance

GET  /api/decisions/:id/history
POST /api/decisions/:id/prepare
POST /api/decisions/:id/answer
POST /api/merges/:decisionId/execute
```

## Shared files (coordinate with other workers)

- `packages/daemon/src/server/http.ts` — route block appended
- `packages/daemon/src/daemon.ts` — module wiring
- `packages/web/src/App.tsx` — nav + routes
- `packages/core/src/reducer.ts`, `events.ts`, `entities.ts` — shared state shape

## Verification commands (actual results)

```bash
set -o pipefail
cd /private/tmp/one-connect-cursor-Bu9W8J/workflow-review

pnpm typecheck
# Exit 0 — core, daemon, web all pass

npx vitest run --project core packages/core/test/workflow-review.test.ts
# 13 passed

npx vitest run --project daemon packages/daemon/test/review-merge.test.ts packages/daemon/test/workflows.test.ts
# 12 passed (review-merge 8, workflows 4)

npx vitest run --project web packages/web/test/ui.test.tsx
# 3 passed (Mission Control, Decisions confirm, Transcript)

npx vitest run --project daemon packages/daemon/test/workflows.test.ts
# 4 passed (after flaky cancel assertion fixed with waitFor)
```

Full daemon suite (`npx vitest run --project daemon`) was run once during handoff; 106+ tests with one timing flake fixed in `workflows.test.ts` line 184 (wait for run `exit.kind === 'stopped'` after cancel).

## Coordinator review notes (read-only)

From `REVIEW_NOTES.md` — items relevant to this worker:

| # | Note | Status |
|---|------|--------|
| 7 | Post-merge checks use host scratch worktree (`env: local`), not project Docker; user Git hooks run unmodified on merge — potential hidden outbound actions | **Open.** Documented here; merge decision evidence says local-only but does not separately approve hooks. Coordinator should route real project checks through Docker and assess hook trust boundary. |
| 4 | Subscription cost / unknown overage blocking | Partially addressed via existing billing probes; durable attestation flow is broader product work. |
| 5 | Node 24 strip-only / live provider proof | Vitest + fake agents only; no live Cursor/Claude runs in tests. |

Other notes (mock egress, design capture race, project context) belong to other workers.

## Remaining gaps / integration points

1. **Post-merge checks in Docker** — `reviewMerge.postMergeChecks` uses disposable host worktree; product requirement is project container (REVIEW_NOTES §7).
2. **Git hook policy** — merge executes with user hooks intact; no separate hook approval or disable path.
3. **Merge execute from web** — Decisions page answers approve merge; execution is `POST /api/merges/:decisionId/execute` (not wired as a one-tap button after confirm — may need coordinator UX pass).
4. **Workflow ↔ board coupling** — workflows visible on dedicated page; board cards do not show workflow membership.
5. **Protected branch config** — gates honor `policies.protectedBranches`; no UI to edit.
6. **Real agent review E2E** — only fake-agent + human HTTP paths tested.
7. **Full suite baseline** — worker did not re-run all 133+ baseline tests end-to-end after every change; focused suites above are green.
8. **No commit** — per task instructions.

## Unresolved decisions for coordinator

1. Should merge approval auto-call `executeMerge` after 2-step confirm, or keep explicit execute step?
2. Should post-merge checks block acceptance until Docker project check adapter exists?
3. Hook handling: disable for merge worktree, allowlist, or separate decision kind?

## Safety compliance

- No push/deploy/production DB writes.
- No new dependencies or lockfile changes.
- No API keys / on-demand billing enabled.
- Tests use workspace fixtures and disposable git repos only.
