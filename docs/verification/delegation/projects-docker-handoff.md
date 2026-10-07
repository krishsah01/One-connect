# HANDOFF — projects-docker worker

Isolated workspace: `/private/tmp/one-connect-cursor-Bu9W8J/projects-docker` (branch `codex/projects-docker`). No commit created.

## What shipped

### 1. Durable project registry and Mac-first project UI
- **`packages/desktop/src-tauri/src/projects.rs`**: `projects.json` registry (0600, atomic write, corrupt-file quarantine, `selected-config` migration), one-repo↔one-project, running-set for restart recovery, digest-bound single-use approval gate (120s) for clone/git-init.
- **`packages/desktop/src-tauri/src/main.rs`**: one engine per project (`HashMap` of `Connection` + child), `desktop_bootstrap` / `daemon_request(project, …)` routing, folder picker + `acc project` CLI bridge, add/activate/start/stop/remove/kill-all/clone/init commands, background restore of engines that were running at quit, stale-daemon cleanup by verified command line, no refusal to switch while other projects have active runs.
- **`packages/daemon/src/projects/*`**: `inspect` (frameworks/checks/compose/dockerfiles/git state, safe paths), `prepare` (generated config outside repo), `clone`/`git-init` plan+execute with digest re-plan, `command.ts` CLI JSON contract.
- **`packages/web/src/pages/Projects.tsx`**, **`App.tsx`** sidebar switcher, **`lib/desktop.ts`** project-bound IPC, **`lib/store.ts`** generation guard + `openProject()`.

### 2. Concurrent projects, bound IPC, terminals
- Switching projects changes the active WebSocket only; other engines keep running and reattach detached runs on return.
- Every `daemon_request` and terminal invoke carries `project`; stale responses after switch throw `ProjectSwitched`.
- **`terminal.rs`**: sessions tagged by project; write/resize/close refused cross-project; scrollback (256 KiB) + `terminal_list` / `terminal_attach` for reattach after switch.

### 3. Docker workbench + local database wizard
- **`packages/daemon/src/environment/compose.ts`**: declarative compose parse (ports, healthcheck, named volumes).
- **`packages/daemon/src/environment/database.ts`**: Postgres/SQLite wizard files (0600 secrets, `127.0.0.1` bind, refuses `prod` names).
- **`packages/daemon/src/environment/workbench.ts`**: availability, bound vs foreign containers, readiness from `State.Health`, port/image conflicts, gated compose actions, DB plan/create.
- **`packages/daemon/src/server/project-routes.ts`**: `/api/project/onboarding`, `/api/environment*`, database plan/create.
- **`packages/web/src/components/DockerWorkbench.tsx`**, **`Workspace.tsx`** terminal + workbench.

### 4. Content-bound Docker approvals (coordinator fix)
Approvals previously hashed only `argv` (paths unchanged when image/command/mount edits). Now:
- Digest covers project, repo, action, services, **SHA-256 of each Compose file**, **scoped service YAML**, and **Dockerfiles** for build services in scope.
- On approve: binding is **re-read**; mismatch → `409 Compose content changed`.
- Execution uses an **immutable snapshot** under `<data>/environment/approval-snapshots/<decisionId>/` (verified bytes, private 0600 files); snapshot removed after the job finishes.
- Regression: `environment.test.ts` — evil image + host mount with unchanged `compose.yaml` path refuses before `docker compose` runs.

## Files (new / materially changed)

| Area | Paths |
|------|-------|
| Daemon projects | `packages/daemon/src/projects/{safe-git,inspect,prepare,clone,command}.ts` |
| Daemon environment | `packages/daemon/src/environment/{compose,database,workbench}.ts` |
| Daemon server | `packages/daemon/src/server/project-routes.ts`; one-line hooks in `http.ts`, `daemon.ts`, `cli.ts` |
| Daemon tests | `packages/daemon/test/{projects,environment,docker-smoke}.test.ts` |
| Rust shell | `packages/desktop/src-tauri/src/{projects,main,terminal}.rs` |
| Web | `packages/web/src/{lib/desktop,lib/store,App,pages/Projects,pages/Workspace,components/DockerWorkbench,components/NativeTerminal}.tsx` |
| Web tests | `packages/web/test/{projects,workbench}.test.tsx` |
| Docs | `docs/desktop.md`, `docs/one-answer.md` |

## Commands run (this session, `set -o pipefail`)

```sh
pnpm typecheck
# Scope: 3 packages — all Done

npx vitest run --project daemon packages/daemon/test/environment.test.ts
# 9 passed (includes new Compose-content regression)

npx vitest run
# Test Files  20 passed | 1 skipped (21)
# Tests       160 passed | 1 skipped (161)

DEVELOPER_DIR=/Library/Developer/CommandLineTools \
CARGO_TARGET_DIR=/private/tmp/one-connect-cursor-Bu9W8J/cargo-target \
TAURI_CONFIG='{"build":{"frontendDist":"/private/tmp/one-connect-cursor-Bu9W8J/cargo-dist"},"bundle":{"resources":[]}}' \
cargo test --offline --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
# 14 passed (registry, gate, IPC, PTY, scrollback, project-bound terminals)

pnpm build
# web dist built successfully
```

Skipped unless opted in: `ONE_CONNECT_DOCKER_SMOKE=1` real-docker smoke (`packages/daemon/test/docker-smoke.test.ts`) — requires local `postgres:16-alpine`, disposable `ocsmoke*` project, cleaned with `down -v`.

## Shared-file integration points (for other workers)

| File | Touch |
|------|-------|
| `packages/daemon/src/server/http.ts` | `await registerProjectRoutes(app, d);` before imports routes |
| `packages/daemon/src/daemon.ts` | `readonly environment: ProjectEnvironment`; `await this.environment.close()` in shutdown |
| `packages/daemon/src/cli.ts` | `case 'project':` dynamic import + JSON stdout |
| `packages/desktop/src-tauri/src/main.rs` | multi-engine, registry commands, `mod projects` |
| `packages/web/src/App.tsx` | Projects route, switcher, project-keyed Suspense |
| `packages/web/src/lib/desktop.ts` | all Tauri invoke wrappers take/return project identity |

Preserved: One Answer pipeline, Designer, tracker adapters, custom agents, `dev.agentcontrolcenter.desktop` identifier, existing `/api/docker*` container-ID routes.

## Remaining gaps / follow-ups

1. **Coordinator items not in this worker scope** (see `REVIEW_NOTES.md`): mock navigation egress, design capture race, stable vault namespace by registry id, subscription overage attestation, workflow-review Docker checks / hook gating.
2. **`build` TOCTOU on Dockerfile**: digest includes Dockerfile hash and re-checks at approve; execution still reads Dockerfile from repo at build time (compose snapshot does not relocate build context). A hostile swap in the narrow window after verify could still affect `build` only — tighter fix would snapshot build context or copy Dockerfile into snapshot context.
3. **macOS-only** folder/config pickers; Windows/Linux need alternate UI.
4. **Packaged engine path** assumes `pnpm desktop:prepare` or bundled `resources/engine.tar.gz`.
5. **Real Docker smoke** not run in this handoff session (opt-in only).
6. **Full license CI / Node 24 strip-only CLI import** — coordinator collecting separately.

## Safety notes

- Clone/git-init gated through native `Gate` + daemon digest re-plan; tests use local bare repos / `file://`.
- Docker mutations refused on non-local endpoints; `up --pull never`; no automatic image pulls.
- Database passwords in 0600 secret files only; redacted in logs/events/UI.
- No commits, pushes, package installs, or live tracker/API usage in this work.
