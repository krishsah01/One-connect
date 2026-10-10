# Architecture

## Sources of truth

| Concern | Owner | Everything else is a view |
|---|---|---|
| Issues and their statuses | The work tracker (local, GitHub Issues or Linear) | Work items mirror them |
| Code | Git (one worktree per assignment) | Diffs and evidence point to SHAs |
| Runs, handoffs, approvals, decisions, alerts | The control center's **append-only event log** | Projections and UI |

## Components

```
packages/core     pure, shared by the daemon and the browser:
                  config schema, entities, lifecycle FSM, typed events, THE reducer,
                  handoff parser, redactor, preflight, assignment template, model ranking
packages/daemon   supervisor (`acc`):
  store/          SQLite event log (UPDATE/DELETE blocked by triggers), outbox, snapshots, tail offsets
  runner/         detached per-run runner + supervisor (spawn, tail, reattach, kill)
  adapters/agents claude · codex · cursor · opencode (+bridge) · generic · relay  (one VendorAdapter interface)
  adapters/trackers local · github (gh) · linear (GraphQL) (one TrackerAdapter interface)
  adapters/vcs    worktrees, diff, hooks, watcher, merge-tree conflicts
  context/        Obsidian vault notes + graphify code graph
  mcp/            the `acc` stdio MCP server every agent run gets
  rules.ts        auto-refill, stall, retry, usage limit, idle
  server/         REST + WebSocket, local auth
  phone/          remote access gate + tunnel adapters, notifications, Brief & Reports
  benchmark/      context-quality benchmark (disposable corpus, `acc bench context`)
packages/web      React UI: Mission Control, Agent Console, Work Board, Agents setup
```

## Event flow

Every state change follows the same path:

```
command (UI / CLI / rule / agent via MCP)
  → validate against current state
  → typed events (+ tracker outbox rows, + tail offsets) in ONE SQLite transaction
  → applyEvent() (packages/core/src/reducer.ts)
  → broadcast over WebSocket → the browser applies the SAME reducer
```

- **Event kinds.** Control events (lifecycle, runs, agents, alerts) go to every client. Transcript events go only to consoles subscribed to that run; other clients receive the updated run projection instead.
- **Audit.** Every event carries an `actor` (human, agent or system), so the log doubles as the audit log.
- **Boot.** On start the daemon loads the latest snapshot and replays the tail. `acc rebuild` replays everything.

## Runs

Starting an assignment works like this:

1. `startAssignment` creates the worktree `<data>/worktrees/<project>/<agent>-<KEY>` on branch `<agent>/<KEY>-<slug>` from the integration branch. It installs per-worktree hooks: pre-commit enforces path scope, pre-push blocks protected branches, without chaining repository hooks. App-owned Git operations suppress executable repository/global configuration; merges enforce path and branch guards explicitly.
2. The vendor adapter builds the launch spec: argv, cwd, stdin mode, MCP config. The child environment is sanitized: API-key variables are stripped.
3. A **detached runner** (`runner/runner.ts`) spawns the CLI in its own process group. It redacts each output line *before* writing `stdout.jsonl` and `stderr.log`, forwards `inbox.jsonl` to stdin (live `send` for Claude), and writes `exit.json`.
4. The supervisor tails those files from offsets stored in SQLite, in the same transaction as the resulting events. The vendor parser turns lines into typed events, sessions, usage, failures and the final text.
5. On exit, `finalize`:
   1. classifies the outcome;
   2. collects commits (verified evidence);
   3. finds the handoff: from MCP, then the final message, then a commit body;
   4. verifies its evidence against the commands it actually recorded;
   5. moves the lifecycle;
   6. lets the rules react: refill, retry or pause;
   7. re-runs required checks in the configured local offline Docker runtime from Git blobs at the exact SHA, records runtime/image-bound evidence, and fails closed if unavailable;
   8. posts the handoff with verification to the tracker.

**Restart safety.** Runners outlive the daemon. On boot, a run is either reattached (only if `ps` shows its runner command line, so a reused PID is never mistaken for ours), collected (it exited while the daemon was down), or marked **orphaned** with an alert.

## Agents talk to the control center, not to each other

Each run gets the `acc` MCP server, authenticated with a per-run token from a `0600` file (never in argv). Its tools:

- `get_assignment`
- `post_handoff`
- `report_finding`
- `ask_human` (blocks until you answer)
- `permission_prompt`: Claude's tool approvals, auto-allowed when clearly in scope, otherwise a pending approval
- Shared context: `get_brief`, `search_context`, `read_note`, `query_graph`, `graph_path`, `explain_node`

Claude runs use `--strict-mcp-config` and Codex runs use `--ignore-user-config`, so your personal MCP servers are not exposed to agents.

## Lifecycle

`Backlog → Selected → Assigned (Next) → Assigned (Now) → Running → Handoff received → In review → Changes requested ↺ → Approved → Merged → Release candidate → Deployed → Verified (Done)`

Side states: Blocked (on human, issue or agent), Stalled, Failed, Canceled.

- When there's no direct edge, a transition walks the shortest valid path, so every intermediate state is recorded.
- **Done requires verified merge AND acceptance evidence**, plus production or device evidence when the item requires it.

## Trackers

A lifecycle change and its tracker write are committed together; the write sits in the outbox. A worker delivers outbox rows in order per issue, with backoff. Two failed attempts raise a critical "out of sync" alert. Polling ingests edits made in the tracker and flags drift: closed in the tracker without evidence, or in progress there without a live run.

GitHub and Linear do nothing (dry run) until `live: true`. Enabling that is recorded as the owner's standing approval for issue, status and comment writes to that tracker.

## Data directory

The data directory is `~/Library/Application Support/AgentControlCenter` on macOS and `$XDG_STATE_HOME/agent-control-center` on Linux, or `ACC_DATA_DIR`:

```
acc.sqlite            event log, outbox, snapshots, tail offsets, sessions
local-tracker.sqlite  the local tracker (if used)
runs/<run>/           spec.json, runner.json, stdout.jsonl, stderr.log, exit.json, checks/*.log, mcp.json (0600)
worktrees/<project>/  one per assignment
hooks/<assignment>/   per-worktree hooks + scope.json
context/<project>/    detached integration worktree with graphify-out/
secrets/install-token (0600)
```
