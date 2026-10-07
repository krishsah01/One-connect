# Phased plan

## Phase 1: done

Daemon, event store, CLI adapters, Mission Control, Agent Console, Work Board, trackers, shared context.

| Area | Delivered |
|---|---|
| Daemon | Event-sourced state with a shared reducer, snapshots and replay. Detached runners with durable, redacted logs. Reattach or orphan detection on restart. Kill switch, including with the daemon down. |
| Agent adapters | Claude Code, Codex CLI, Cursor agent CLI, generic CLI and relay. Auth, billing, model and usage probes. Binary pinning. Failure classifier. Contract suite on real captured streams. |
| Billing guard | API-key variables stripped. Metered billing blocks dispatch. Runs stop when the vendor reports API-key billing or paid overage. |
| Agents ↔ control center | `acc` MCP server: assignment, handoff, findings, ask_human, permission prompts, shared context. |
| Git | Worktree per assignment, branch naming, per-worktree scope and push hooks, live diff, overlap and conflict checks. |
| Evidence | Required checks re-run by the daemon; handoff claims verified against recorded commands and commits. |
| Rules | Auto-refill, stall and approval-pending detection, network retry (once, resuming the session), usage limit, handoff enforcement, idle-with-work. |
| Trackers | Local, GitHub (`gh`) and Linear (GraphQL). Outbox, polling and drift alerts. Dry run until `live: true`. |
| Shared context | Obsidian vault (contract, brief, issues, handoffs, decisions), with the official CLI for search when available. graphify code graph of the integration branch (no LLM). |
| UI | Mission Control, Agent Console, Work Board (dispatch, pre-flight, drag-and-drop queues), Agents setup, phone layout. |
| Open source | Apache-2.0, NOTICE, generated third-party notices with a license gate, SPDX, DCO, Code of Conduct, a security policy with a threat model, CI. |

**Acceptance demo coverage.** Steps 1, 2, 3, 5, 6 and 8 run in `packages/daemon/test/e2e.test.ts` and in the browser demo. Step 4 (review and merge) is Phase 2 and step 7 (morning report) is Phase 3.

## Phase 2: review, decisions, rules

- **Review & Merge:** diff at a SHA with tests and CI; reviewer picker that enforces author ≠ reviewer; findings; approve or request changes; merge to integration in one click with post-merge checks; tracker updated automatically.
- **Decisions (phone-first):** options, recommendation, evidence and risk; a second confirmation for irreversible actions; an audit trail. Agent `ask_human` already feeds this.
- **Screens:** Dispatch Composer and Timeline as their own pages.
- **Full rules engine:** tracker reconciliation (merged but not updated, in progress without a live run, findings without an issue), infra watch, and acting on reassignment suggestions.
- **Trackers:** GitHub Projects v2 status field, and webhooks behind an authenticated tunnel (asks the owner first).
- **Protection check:** production-branch protection status from the code host, with a loud warning when unprotected.

## Phase 3: release, infra, reach

- **Release Cockpit:** ordered steps with owner, command, check, rollback and approval, including a migration-drift checker.
- **Infra adapters (read-only by default):** Vercel, Supabase/Postgres and workers. Paused databases, runtime errors, migration drift, env flags.
- **Other adapters:** OS-automation (opt-in, scoped per app); notification adapter (web push, optional chat).
- **Remote access:** PWA polish, and remote access over an authenticated secure tunnel.
- **Reporting:** Usage & Models screen; Brief & Reports: a morning report built only from evidence, and an exportable standup.
