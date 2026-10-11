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
                  handoff parser, redactor, preflight, assignment template, model ranking,
                  adapter profiles (adapterProfiles.ts), text and canonical-JSON helpers (text.ts)
packages/daemon   supervisor (`acc`):
  daemon.ts       composition root + facade: builds every service, owns start/shutdown, implements kernel.ts
  kernel.ts       the interfaces services depend on (Kernel, WorkCommands, AgentCommands, ConfigCommands)
  workService.ts  issues, assignments, pre-flight, dispatch, queues, lifecycle transitions
  agentService.ts agent builder saves, probes, model swaps
  decisions.ts    human decisions; decisionExecutors.ts lists every action that binds its own decision
  errors.ts       CommandError (never import it from daemon.ts)
  util/hash.ts    sha256 / sha256Canonical
  store/          SQLite event log (UPDATE/DELETE blocked by triggers), outbox, snapshots, tail offsets
  runner/         detached per-run runner + supervisor (spawn, tail, reattach, kill)
  adapters/agents claude · codex · cursor · opencode (+bridge) · generic · relay  (one VendorAdapter interface)
  adapters/trackers local · github (gh) · linear (GraphQL) (one TrackerAdapter interface)
  adapters/vcs    worktrees, diff, hooks, watcher, merge-tree conflicts
  context/        Obsidian vault notes + graphify code graph
  mcp/            the `acc` stdio MCP server every agent run gets; tools.ts names its tools
  rules.ts        auto-refill, stall, retry, usage limit, idle
  server/         http.ts (security boundary + ROUTE_MODULES), auth.ts, eventSocket.ts, one <domain>Routes.ts per API area
  phone/          remote access gate + tunnel adapters, notifications, Brief & Reports
  benchmark/      context-quality benchmark (disposable corpus, `acc bench context`)
packages/web      React UI: App.tsx gates sign-in, then shell/Shell.tsx (local) or shell/PhoneApp.tsx (paired phone)
```

## Code structure and extension points

The daemon is layered so that a part can be replaced without touching the rest:

1. **Core** (`packages/core`) is pure and shared with the browser. No Node APIs in its index.
2. **Kernel** (`kernel.ts`). Services see the daemon only through these interfaces: the event log
   and projected state, time, configuration, redaction, alerts and egress (`Kernel`), plus the command
   groups they call. `Daemon implements` all of them, so the compiler keeps the two in sync.
3. **Services.** Each declares what it needs as a type next to its class, for example
   `ProjectDockerDeps = Kernel & { readonly decisions: Decisions }`. A new dependency therefore shows
   up in the type (and in review), and a test can construct the service with a fake.
4. **Composition root** (`daemon.ts`). Builds the services, registers decision executors and run-stop
   hooks, starts and stops them (each shutdown step is isolated), and keeps facade methods
   (`createIssue`, `dispatch`, …) that the HTTP layer, the CLI and tests call.
5. **Delivery** (`server/`, `phone/gate.ts`, `cli.ts`). Talks to the facade. Each API area is one
   module; `http.ts` only enforces Host/Origin/auth and lists the modules.

Rules that keep it that way:

- Services import `CommandError` from `errors.ts` and types with `import type`; nothing but the
  delivery layer imports `daemon.ts` at runtime.
- Hash with `util/hash.ts` and canonicalize with `canonicalJson` (core). Approval bindings depend on
  both being identical everywhere.
- Validate request bodies with zod via `parseBody` (`server/route.ts`); unknown fields are dropped.

Recipes:

| To add | Do this |
|---|---|
| An API area | Write `server/<area>Routes.ts` exporting `register<Area>Routes(app, d)`, add it to `ROUTE_MODULES` in `http.ts`. |
| An action that needs the owner's approval | Bind it with `decisions.createBound(...)`, then add one entry to `decisionExecutors.ts` (the kv prefix it owns and how to resolve it). Plain answers are then refused and responses routed to it automatically. |
| An agent runtime | One `ADAPTER_PROFILES` entry in `core/adapterProfiles.ts` (name, login argv, capabilities, `runsHere`) and one `VendorAdapter` in `adapters/agents/` that spreads that profile. The web reads the profile; no UI edits needed. |
| An `acc` MCP tool | Register it in `mcp/server.ts`, add its name to `ACC_MCP_AUTO_APPROVED` or `ACC_MCP_PROMPTED` in `mcp/tools.ts` (a test fails otherwise), and handle it in `mcpBridge.ts`. |
| Cleanup before a run stops | `runs.onBeforeStop(hook)` from the composition root. |
| A service | A class taking `<Name>Deps`; construct it in `daemon.ts`; if it starts or stops, add it to `start()` and `shutdown()`. |

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

Each run gets the `acc` MCP server, authenticated with a per-run token from a `0600` file (never in argv). `mcp/tools.ts` lists every tool and whether a harness may call it without a prompt. Among them:

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
