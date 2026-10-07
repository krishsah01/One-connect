# Mac app preview

The desktop app uses Tauri 2: a Rust native shell, the existing React dashboard, and the existing TypeScript supervisor with SQLite. Rust manages the app lifecycle and real PTYs. The supervisor keeps ownership of assignments, vendor processes, evidence, and tracker synchronization. This preserves the tested engine while adding native system access.

Rust helps with native process management and avoids shipping a separate Chromium runtime. It does not make vendor inference faster. Transcript pages render at most 200 events at a time, large logs use 128 KiB pages, and the terminal code loads only when opened. Performance claims beyond these design choices need measurements on representative projects. Windows remains a later validation target; the current resource packager and the project and folder pickers support macOS only.

## Build and launch

Build prerequisites: Node 24+, pnpm, Rust, git, and Apple’s developer tools. Users accept Apple’s tool license themselves. The prepared engine pins Node 24.21.0 and verifies its archive checksum against the official release. It bundles no vendor agent tools or account credentials.

```sh
pnpm install --frozen-lockfile
cargo fetch --manifest-path packages/desktop/src-tauri/Cargo.toml --locked
pnpm license:check
pnpm desktop:prepare
pnpm desktop:dev
```

For a packaged app:

```sh
pnpm desktop:build
open 'packages/desktop/src-tauri/target/release/bundle/macos/Agent Control Center.app'
```

On a machine with an unaccepted full Xcode installation and working standalone command line tools, prefix Cargo/Tauri build commands with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`. This selects those tools; it does not accept a legal agreement.

The app starts one daemon per project and authenticates to each locally through native IPC. `acc open` is still used for standalone browser access, but the app itself does not need a pasted sign-in link. Closing the window hides it; Quit asks every project's daemon to shut down gracefully and closes native terminals. Detached agent runs retain their restart-safe behavior.

State lives under `~/Library/Application Support/dev.agentcontrolcenter.desktop/`. Each project has a separate directory named by the hash of its configuration path (`projects/<id>/state`), holding its event database, worktrees, One Answer index, generated database files and secrets. The offline demo has its own `demo/` directory. The engine is unpacked to a versioned `runtimes/` directory, preserving dependency links. Startup failures are recorded in `daemon.log`.

## Projects

`projects.json` (owner-only) is the durable project registry: name, configuration, exact repository root, onboarding scan, the open project and which engines were running. A corrupt registry is kept aside, not overwritten; a `selected-config` file from earlier builds is migrated. One repository maps to one project.

**Projects → Add a local repository** opens the macOS folder picker and scans the chosen repository root without running its scripts: Git state, frameworks, package manager, declared checks, Compose services and Dockerfiles. A subfolder of a repository, the home folder, system folders and credential folders are refused. If the repository has a `control-center.yaml` whose `project.repo` resolves to the same root, it is used; otherwise a private configuration is generated under `project-configs/` and nothing is written into the repository. A folder without Git gets a reviewable `git init` step that runs only after approval; a repository without commits is added with “needs first commit”, and uncommitted changes are reported as excluded, so One Answer never claims to have indexed work that is not at a Git revision.

**Clone from a Git URL** prepares the exact `git clone` command (hooks, submodules, credential helpers and `ext::` transports disabled). It reaches the network only after the human approves that command; the approval is bound to its digest, expires after two minutes and works once. URLs with embedded credentials are refused. SSH URLs may use the user's SSH agent; HTTPS credential helpers and prompts are off, so private HTTPS repositories need an SSH URL.

Switching projects changes which engine the window shows. Other projects' supervisors and agent runs keep going; returning shows their live dashboard and logs. Every native request names its project and is routed to that project's own connection and token; a response that arrives after a switch is dropped. Per project, **Stop runs** engages that project's kill switch and **Stop engine** shuts its daemon down. **Kill switch: all projects** engages every running project's kill switch. Engines that were running at Quit restart on the next launch and reattach their detached runs. Before each start the app re-checks that the configuration still points at the registered repository and that the daemon serves it. A daemon left by a crash is stopped only if its command line proves it is that project's engine.

Without an added project, the app starts a sample repository with **scripted fake agents** and GitHub/Linear import fixtures. These model names, output and usage reports are examples. This mode does not spend subscription usage or connect to either tracker. The demo stays available from the project switcher.

## Issue imports

The Board’s **Import issues** dialog previews open GitHub or Linear issues, searches their titles/keys/labels, and imports selected issues with provenance and duplicate detection. Imported items get local tracker keys and retain their original source keys and links. Their status changes stay local. The current import flow requires `tracker.type: local`; using an external tracker as the owning tracker is a separate setup.

Configuration declares sources; they remain disabled unless deliberately enabled:

```yaml
tracker: { type: local, key_prefix: ACC }
import_sources:
  - { id: github, name: GitHub, type: github, repo: owner/repository, enabled: false }
  - { id: linear, name: Linear, type: linear, team: ENG, enabled: false }
```

Do not enable a live connection during the offline demo. A live preview uses the user-installed official `gh` CLI or Linear’s public API with a separately configured tracker credential. Vendor subscription credentials are never extracted. The preview currently searches the latest 200 open GitHub issues or 100 Linear issues. Slack import is deferred.

## Work inside the dashboard

Agent Console contains messages, commands, edits, tests, questions, approvals, diffs and durable logs. Claude and Cursor adapters support incremental text where the vendor stream exposes it. Codex’s current `exec` adapter records complete message events; native token streaming and vendor approval handling through Codex app-server remain a separate adapter milestone. Active-run messages for adapters without live input are queued for the next turn. Relay agents still need their vendor surface; they cannot currently satisfy an entirely in-dashboard workflow.

Workspace contains a project/worktree shell and official vendor-login terminals. The terminal is an interactive shell running as the user, not an agent sandbox. Each terminal belongs to one project and starts only in that project's repository or one of its own agent worktrees; calls naming another project are refused. Terminals keep running when you switch projects and reattach with up to 256 KiB of in-memory scrollback; stopping a project closes them. Terminal output and keystrokes are never written to disk, especially during login. Structured agent-run logs remain durable and redacted. The vendor’s browser OAuth flow may open a browser during sign-in.

**Project Docker** works only on the project's Compose binding: `docker compose --project-name <docker_project or name> --project-directory <repo> -f <repo compose file> [-f <generated database file>]`. A container is controlled only if both its Compose project label and its working directory match this repository; others with the same name are listed as not controlled. Set `project.docker_project` if it differs from `project.name`. The workbench reports whether Docker is installed, running and local, and reports readiness from real healthchecks (`ready`, `starting`, `unhealthy`, `running · no healthcheck`, `stopped`, `not created`). It also shows missing images, host-port conflicts with other containers or processes, and the latest 300 log lines (at most 128 KiB, redacted). Start (`up --no-deps --no-build --pull never`), stop, restart, build, pull and down (volumes kept) each run once after a two-minute approval, with an audit event. The approval binds the Compose bytes, scoped service settings, Dockerfile, context paths, context entry hashes and executable bits, and explicit env/config/secret file bytes. Changing an image, command, mount, port, Dockerfile, context or env file invalidates the request before execution. The binding is checked again after the local-engine check; execution uses only the captured buffers in a private read-only snapshot outside the repository. Repository changes in the subsequent build window cannot change those inputs. Pull and build explicitly require network approval; start never builds or pulls. Actions are refused when Docker points at a non-local endpoint. Any command can be typed into the project terminal for review instead.

The workbench supports a conservative Compose subset. Build contexts and Dockerfiles must be local, within the repository and context respectively, with no included symlinks, hard links or special files. Across the context and auxiliary inputs, limits are 2,000 entries and 64 MiB; traversal stops at 20,000 entries; individual context files are at most 8 MiB and Compose/Dockerfile/env/config/secret files at most 256 KiB. Empty directories and executable bits are retained. `.dockerignore` supports root-relative literals, `*`, `?`, `**` and ordered `!` rules; character classes and backslash patterns are refused. Dockerfile-specific ignore files take precedence. Included credential/env files, private folders, key/database files and detected secret content are refused; exclude them explicitly or use a narrower context. Secret scanning is conservative, not a guarantee that arbitrary source files contain no sensitive data.

Only the selected services and their used resource declarations enter the executable snapshot. Actions without an explicit service list retain the default inactive-profile behavior; host `COMPOSE_PROFILES` cannot expand the scope. Dependencies must be selected explicitly; start/restart never add them implicitly. Relative build, bind and env-file paths resolve against the original repository directory. Env/config files are copied into the private snapshot; repository bind mounts retain their original live paths and read/write mode, while named volumes retain the project namespace. Bind paths must exist within the repository, without symlink ancestors or nested symlinks/special files, with traversal bounded to 20,000 entries; host roots, sockets, private paths, external volumes, volume drivers, host namespaces, devices, additional capabilities and privileged services/builds are refused. Remote/additional build contexts, SSH/secret forwarding, cache exporters, includes and extends are also refused. Compose interpolation and inherited environment/build arguments are refused: use literal values and explicit env files. An empty explicit CLI env file and a restricted Docker subprocess environment prevent implicit repository `.env` and host Compose overrides from changing execution. Escaped container variables (`$$VAR`) remain supported.

Snapshots are removed on completion, failure, timeout and shutdown. Restart removes abandoned snapshots and durably marks previously running jobs `interrupted`, with an unknown exit code and an instruction to check service status; actions are never replayed. Stopping the Docker client cannot attest that the engine stopped work, so interruption never claims container/build success.

**Local databases** generates a project-owned Postgres service (or a SQLite file) in the project's private data folder: a Compose file, a random password file (mode 0600, passed via Docker secrets) and a named volume, so data survives restarts and `down`. The plan preview lists the files, the pull and start commands and connection details. Nothing is written before **Create these files**, and nothing is pulled or started before each step's approval. The password is never displayed, logged, put into prompts or sent to the tracker; connection info shows `<password>` and the password file path. Database names containing “prod” are refused, and the port binds to `127.0.0.1` only.

## Validation

The offline TypeScript suite covers imports, duplicate provenance across restart, scoped container actions, single-use approvals, native WebSocket tickets, complete large Unicode logs, and transcript history beyond 5000 events. Rust tests cover IPC path restrictions, isolated project directories, PTY execution/resize, split Unicode output, the project registry (persistence, permissions, migration, corruption), digest-bound single-use intake approvals, per-project connections, and project-owned terminals and directories. Project intake, clone, Docker workbench and database tests use local Git repositories and a scripted Docker protocol fixture; an opt-in smoke test (`ONE_CONNECT_DOCKER_SMOKE=1`) uses a real local engine only when `postgres:16-alpine` is already present, in a disposable `ocsmoke…` Compose project that it removes. Mac CI builds the app and runs these checks. This preview is not a notarized public release.

During the local app smoke test, a GitHub fixture was imported, dispatched to the packaged fake Cursor adapter in its own worktree, and finished with a parsed handoff and verified `node --test` evidence. The project terminal also ran the sample repo’s two tests successfully. Live tracker writes, paid model calls and Docker mutations were not used in that test.
