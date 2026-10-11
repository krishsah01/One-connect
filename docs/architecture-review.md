# Architecture review, 2026-10-10

This review covers `packages/core`, `packages/daemon` and `packages/web` at `6b1f1ca`: about 46,000 lines of TypeScript, the HTTP and WebSocket surface, the event store, the agent adapters and repository hygiene. The fixes are on branch `refactor/solid-foundations`. The uncommitted Designer upgrade in the main checkout was left alone; [How to merge](#how-to-merge) explains how the two combine.

**Baseline before changes** (main checkout, including the uncommitted Designer work): typecheck clean. 855 tests passed and 19 failed, all of them known: `opencode-harness` needs a real `rg` binary on `PATH`, and the Designer WIP renderer test still uses old starter ids.

**After:** typecheck, SPDX and license checks are clean. The full suite has no new failures; the only failures are the 16 `rg`-dependent ones. 16 tests were added, each pinning one of the fixes below.

## Summary

The core design is sound. An append-only event log feeds one shared reducer used by both the daemon and the browser. Typed events, decisions bound to exact actions, and an egress allowlist are the right foundations.

The problems were in how the code around that core was organized:

- **One god object.** `Daemon` was the composition root, the event kernel, the lifecycle owner and the home of about 25 commands. All 34 services received the whole `Daemon` as a service locator, so any service could reach any other.
- **Shotgun surgery.** A new bound action needed edits in two routers. A new agent runtime needed edits in about 40 `=== 'relay'`-style checks across three packages. A new MCP tool needed a hand-kept allowlist.
- **Copy-paste helpers.** There were about 25 `sha256` wrappers and five canonical-JSON functions with different semantics.

There were also real bugs:

- sessions never expired on the server;
- clients could set internal assignment fields;
- several "latest N" reads returned the oldest rows;
- shutdown could abort and leave the store open;
- the reducer slowed down linearly with run history.

## Fixed on this branch

### Bugs and security

| # | Finding | Impact | Fix | Test |
|---|---|---|---|---|
| 1 | Browser sessions never expired on the server; only the cookie's `Max-Age` limited them. | A copied session cookie stayed valid forever. | `server/auth.ts` enforces the 30-day lifetime and deletes expired sessions. | `http-hardening.test.ts` (fails on old code) |
| 2 | `POST /api/assignments` and `PATCH /api/assignments/:id` passed the raw body through. | A client could set `kind`, `review`, `workflowId`, `worktree`, `agentId` or `position`. | zod schemas in `server/workRoutes.ts` accept only the command's fields and drop the rest. | `http-hardening.test.ts` (fails on old code) |
| 3 | A missing body crashed reassign, queue, Docker requests and imports with a 500. `POST /api/agents/:id/model` stored the model `"undefined"`. | 500s, plus a broken agent config. | `parseBody()` returns a 400 that names the field. | `http-hardening.test.ts` |
| 4 | `EventStore.list()` returns the oldest rows, capped at 10,000. Notifications, the phone-access audit, decision history, a run's last message and its recorded commands all wanted the newest. | On a long-lived install new notifications disappeared and `ack()` failed; audit and history went stale. | `order: 'desc'`, an exact `containsAny` prefilter, and a bound `LIMIT` that ignores NaN. | `infra.test.ts` |
| 5 | `kvKeys()` used `LIKE`. | `_` and `%` in a prefix acted as wildcards. | Literal prefix match. | `infra.test.ts` |
| 6 | Shutdown awaited 18 closes with no isolation. | One throwing service left the store open and unsnapshotted, with `closed` still false. | Each step is isolated; failures are reported together after the store closes. | `daemon-lifecycle.test.ts` |
| 7 | Agents had `find` and `git branch` pre-approved (`Bash(find:*)`, `Bash(git branch:*)`). | `find . -delete`, `find -exec rm` and `git branch -D` on refs shared with the repository ran with no prompt. | Both removed; the rule is documented on `SAFE_BASH`. | `daemon-lifecycle.test.ts` fails if a destructive prefix comes back. |
| 8 | Three canonical-JSON helpers sorted keys with `localeCompare`. | A bound approval hash could change with `LANG` (CLI, desktop and tests). | One `canonicalJson` in core, sorted by code unit. | `shared-helpers.test.ts` |
| 9 | `answer()` and `respond()` kept separate lists of bound-action executors. | An executor added to only one list would let a plain answer consume its approval without running the action. | One registry (`decisionExecutors.ts`). | `decision-actions.test.ts` |
| 10 | `create()` and `createBound()` built decisions with different defaults. | Only `create()` made irreversible decisions confirm. | One builder. | `decision-actions.test.ts` |
| 11 | The shared reducer rescanned every run on every agent-affecting event: 10 µs per event at 100 runs, 83 µs at 1,000, 1 ms at 10,000. | The daemon and the browser both slowed down as history grew. | Incremental tracking, about 1 µs per event at any size. | `domain.test.ts` checks equality with a full scan after every event. |
| 12 | About 20 MB of raw agent session logs and worker status files were tracked and published, though `.gitignore` says they are private. | Unintended publication. No credentials were found in them (scanned for common key formats). | Removed from the index (local copies stay); ignore rules now cover subfolders. **Still in public history**, see O1. | — |
| 13 | The console said OpenCode messages are "delivered as the next turn". | Wrong hint: OpenCode streams input, so they are delivered live. | The hint now reads the adapter's capability. | — |
| 14 | In the canvas shell, every agent console and run-output drawer showed "Unknown agent" or "Unknown run". The drawers open from the URL without a page route, so `useParams()` was empty (Mocks had the same problem). Found by running the demo on this branch; it is also on `main`. | Agent consoles and run output were unusable in the main UI. | `DrawerBody` gives those drawers a route context. | `shell.test.tsx` (also stubs `ResizeObserver`, which jsdom lacks, so the file no longer depends on test order) |
| 15 | Smaller issues: `/api/health` hard-coded the version, expired sign-in codes were never purged, a malformed cookie threw, the socket accepted NaN cursors. | — | Fixed in the HTTP split. | — |

### Structure (SOLID and refactoring.guru names)

| Smell or principle | Before | After |
|---|---|---|
| **God object, service locator** (SRP, DIP) | `Daemon`: 900 lines with four jobs; every service took the whole `Daemon`. | `kernel.ts` defines `Kernel`, `WorkCommands`, `AgentCommands` and `ConfigCommands`. Each service declares `<Name>Deps` with exactly what it uses. Commands moved to `WorkService` and `AgentService`; `Daemon` (490 lines) is the composition root and a stable facade. |
| **Import cycle** | 47 modules imported `CommandError` from `daemon.ts` at runtime. | `errors.ts` and `version.ts`; `daemon.ts` re-exports them for compatibility. |
| **Large class / mixed concerns** (SRP) | `server/http.ts`: security boundary, about 95 routes in a dozen domains, socket and static UI. | `http.ts` keeps the boundary and one `ROUTE_MODULES` list. Each domain is a module (`work`, `agent`, `run`, `control`, `workflow`, `release`, `connection`, `context`, `state`, `mcp`), plus `auth.ts` and `eventSocket.ts`. |
| **Switch statements → Chain of Responsibility** (OCP) | Decision routing was an if-chain over 11 kv prefixes. | `DecisionExecutor` registry: a new bound action is one entry. |
| **Replace conditional with polymorphism / data** (OCP) | About 40 `adapter === 'relay'`-style checks in core, daemon and web; the web kept its own login table. | `core/adapterProfiles.ts` (`ADAPTER_PROFILES`, `isManualRelay`). `VendorAdapter` extends the profile; the web reads it. |
| **Shotgun surgery** | The MCP tool allowlist was hand-copied in `claude.ts`. | `mcp/tools.ts`; a test spawns the server and fails on drift. |
| **Monkey patching** | The constructor wrapped `runs.stop`. | `runs.onBeforeStop(hook)` (Observer). |
| **Duplicate code** | About 25 sha256 wrappers, 5 canonical-JSON functions, 6 clip variants, 3 `asRecord`, 2 `shellQuote`; the web imported a utility from a UI component. | `core/text.ts` and `daemon/util/hash.ts`. |
| **Dead code** | `App.tsx` kept the old desktop workbench for phone sessions: 22 lazy imports, 25 unreachable routes, branches that could not be true. | `App.tsx` is a gate; `shell/PhoneApp.tsx` has the five granted routes; `shell/ProjectSwitcher.tsx`; `needsAgentConnection()` replaces two copies. |
| **Repository clutter** | Handoff notes and a 62 KB prompt at the root; two root files byte-identical to copies in `docs/`. | Moved under `docs/`. |

## Open findings

These are not changed here, most important first.

### P1: security and correctness

- **O1. Raw agent logs are still in the public history.** Commit `5543b43` on `origin/main` contains `docs/verification/delegation/*.jsonl`, about 20 MB of session transcripts with local paths. The scan found no API keys or tokens. Removing them needs a history rewrite (`git filter-repo --path-glob 'docs/verification/delegation/*.jsonl' --invert-paths`) and a force-push, which breaks every clone and open branch. This is the owner's call.
- **O2. Read-only release tools prompt every time.** `get_release_status` and `get_infra_health` are registered MCP tools that only read, yet they are not pre-approved, so each call asks the owner. That looks unintended. If so, move them to `ACC_MCP_AUTO_APPROVED` in `mcp/tools.ts`.
- **O3. Backslashes in Keychain secrets.** `setSecret()` escapes `"` but not `\` in the `security -i` command line, so an API key containing a backslash may be stored wrong. Verify against a throwaway keychain on macOS, then escape `\` before `"`.
- **O4. Other routes still check bodies by hand.** Phone, designer, marketplace, library, release and team routes mostly use `String(req.body?.x ?? '')` and casts (10 `as never`). Move them to zod with `parseBody()`, as `designDocumentRoutes.ts` (in the WIP) and `workRoutes.ts` do. Then share the schemas with the web client: `Decisions.tsx` types the answer response by hand today.
- **O5. Decision ownership lives in 12 kv-prefix conventions** (`settings:decision:`, `docker:` and so on). The registry now centralizes routing, but ownership is still inferred from key names. A `decision_bindings(decision_id, executor, payload)` table, written in the same transaction as `decision.created`, would make ownership one indexed lookup and survive renames.

### P2: maintainability

- **O6. No formatter or linter.** 1,820 lines are over 200 characters, and dense (`const a=…;if(…)`) and spaced styles are mixed. Adopt Biome or Prettier plus a linter, with `noUnusedLocals` and an import-cycle rule so nothing but the delivery layer imports `daemon.ts`, and add it to CI. Reformat in one commit after the parallel branches merge.
- **O7. God components in the web.** `pages/Canvas.tsx` is 1,149 lines and 92 KB; the WIP's `DocumentRenderer.tsx` is 720. Split them into hooks (state, persistence, keyboard) and presentational parts.
- **O8. Flat daemon folder.** `daemon/src` has 41 files at its root. A domain layout is proposed below. Move the files in one mechanical commit, by script, once the in-flight branches have merged; moving them now would conflict with every open branch.
- **O9. Startup is not declarative yet.** `start()` and `shutdown()` still list services by hand. Next step: a `Lifecycle` interface (`start` and `stop`) and an ordered list in `daemon.ts`, started in order and stopped in reverse.
- **O10. The reducer is still one switch.** It is about 300 lines with 70 cases. `libraryReducer.ts` and `designStudio.ts` already show the slice pattern. A typed handler map per domain (agents, work items, runs, decisions, workflows) would let a feature own its events end to end.
- **O11. A flaky web test.** `skills.test.tsx` ("refuses publish with stale hash…") failed once in about five full runs under load, then passed every time on its own. It is timing-sensitive; give its `waitFor` calls an explicit timeout.
- **O11b. Test environment and speed.** `opencode-harness` needs a real ripgrep. Put a stub `rg` on `PATH` in the test, or document `brew install ripgrep` in CONTRIBUTING. The daemon suite takes about 7 minutes; tag the e2e and process-spawning tests so `pnpm test:unit` runs in seconds.
- **O12. Dead CSS.** 31 selectors in `styles.css` have no users, including the Designer WIP: `brand`, `sep`, `sidebar-team`, `sidebar-status`, `workspace-next-step`, `connector-question`, `designer-layout`, `designer-page`, `designer-skills`, `token-grid`, `skill-grid`, `skill-tile`, `finding-spacer` and the `mock-*` rules (`mock-preview`, `mock-card`, `mock-stage` and the rest). Remove them after the theme work in flight lands; the pruning script is in this branch's history (`bfa816b`).
- **O13. Wall-clock time inside the daemon.** `saveSnapshot`, `markDelivered`, the egress log and session times use `new Date()` instead of the injected clock, which limits deterministic tests.
- **O14a. Run output "Back" link.** Inside the desktop drawer, the run view's Back link goes to `/phone` (it was written for the phone layout). Close the drawer instead when it is not a phone session.
- **O14. Version is defined twice.** `VERSION` in `version.ts` and the `package.json` versions are separate. Read one from the other at build time.

## Recommended upgrades and features

- **Typed API contract.** Export the route zod schemas from the daemon, generate an OpenAPI document and a typed client for `web/lib/api.ts`. That removes hand-typed responses and keeps phone, web and CLI in sync.
- **Event versioning.** Events have no schema version, and the reducer absorbs legacy shapes with `?? {}` defaults on every event. Add a `v` field and upcasters applied while loading, and drop the per-event normalization from `applyEvent`.
- **Diagnostic logging.** Fastify runs with `logger: false`. Add a redacting structured logger (pino through `redact()`) for daemon diagnostics, separate from the audit log.
- **Prepared-statement cache in EventStore.** Each call re-prepares its SQL; cache the statements per instance.
- **Per-agent run index in state.** With the incremental reducer in place, a `runIdsByAgent` projection would make `sessionIdsFor()` and `activeRunFor()` O(1). They still scan all runs.
- **Health and metrics endpoint.** Report run counts by state, outbox lag, snapshot age and event-log size for the desktop status bar.

## Proposed daemon layout (for O8)

| Folder | Files |
|---|---|
| `kernel/` | `daemon.ts`, `kernel.ts`, `errors.ts`, `version.ts`, `paths.ts`, `config.ts`, `egress.ts`, `secrets.ts`, `exec.ts`, `util/` |
| `work/` | `workService.ts`, `rules.ts`, `outbox.ts`, `imports.ts`, `checks.ts` |
| `agents/` | `agentService.ts`, `agentCosts.ts`, `probe.ts`, `subscriptionSafety.ts`, `localModels.ts`, `adapters/agents/` |
| `runs/` | `runManager.ts`, `runner/`, `mcpBridge.ts`, `mcp/` |
| `decisions/` | `decisions.ts`, `decisionExecutors.ts`, `jev.ts`, `settings.ts` |
| `workflows/` | `workflows.ts`, `workflowLinks.ts`, `workflowOptions.ts`, `reviewMerge.ts`, `team.ts` |
| `design/` | `designer.ts`, `designStudio.ts`, `mocks.ts`, `designDocuments.ts` (WIP) |
| `library/` | `skills.ts`, `skillImport.ts`, `connectors.ts`, `connectorToolActions.ts`, `marketplace/` |
| unchanged | `environment/`, `infra/`, `release/`, `context/`, `phone/`, `projects/`, `benchmark/`, `server/`, `store/` |

## How to merge

The branch is `refactor/solid-foundations` (worktree `../Interface-refactor`).

1. **Untracked logs.** `main` still tracks the raw agent logs, so merging the hygiene commit **deletes them from `main`'s working tree**: `.gitignore` does not protect files a merge stops tracking (checked in a scratch repository). To keep local copies, first run:
   ```bash
   cp -R docs/verification/delegation ../delegation-backup
   ```
   Copy the `.jsonl`, `.status.json` and `registry.json` files back after the merge; they stay ignored. Or leave commit `9019e80` out of the merge.
2. **The Designer upgrade.** When it is committed, `git merge refactor/solid-foundations` stops on `claude.ts`, `daemon.ts` and `designer.ts`. `python3 docs/handoff/resolve-designer-merge.py` resolves all three:
   - it keeps the refactor side;
   - it adds the Designer's four MCP tools to `mcp/tools.ts`;
   - it moves the `designBinding` pre-flight line into `WorkService.preflight`.

   This was checked on a snapshot of the uncommitted work: the merged tree passes typecheck and the core, MCP tool, design document, designer and e2e suites.
3. **The harness branch** (`claude/harness-setup-compliance`, at `8db63b4`) edits code this branch moved, so merging it stops on `daemon.ts`, `server/http.ts` and `AgentsSetup.tsx`. `python3 docs/handoff/resolve-harness-merge.py` re-applies its additions where that code now lives:
   - the account watch in `daemon.ts`, with a step-isolated stop;
   - the signature refresh in `AgentService.probe`;
   - the account-terms and signature checks in `WorkService.preflight`;
   - the account-terms routes in `agentRoutes.ts`;
   - the key-age bookkeeping in `connectionRoutes.ts`.

   Run it after this branch is on `main`. Checked against `8db63b4`: typecheck is clean, and core, web and the account-compliance, adapter, e2e, HTTP and lifecycle suites pass. If that branch changes before it lands, the script stops at the first anchor it cannot find.
4. **The theme session in flight** (`styles.css`, `theme.ts`, `common.tsx` and others) merges without conflicts; `styles.css` was left untouched on this branch for that reason.
5. **New code from in-flight branches** that still writes `constructor(d: Daemon)` keeps working, because `Daemon` satisfies every `<Name>Deps`. Narrow it to a `<Name>Deps` type when convenient.
