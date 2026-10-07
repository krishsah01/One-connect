# Setup

## Requirements

- macOS or Linux, **Node 24+** (it runs TypeScript directly), pnpm, git 2.38+.
- The official CLIs of the vendors you want to use, each signed in. See [subscriptions.md](subscriptions.md).
- Optional: `gh` (GitHub tracker), an Obsidian vault, and `graphify` (`uv tool install graphifyy`).

## Install

```bash
git clone <this repo> agent-control-center && cd agent-control-center
pnpm install
pnpm build            # builds the web UI the daemon serves
pnpm acc onboard      # lists vendor CLIs, every copy found (PATH + app bundles), versions, login commands
```

## Configure

Copy [examples/control-center.yaml](../examples/control-center.yaml) next to your project, or anywhere you like and pass `--config`. Set at least:

- **`project.repo`:** a git repo. The integration branch is created from your first protected branch if it doesn't exist.
- **`project.checks`:** commands the daemon re-runs from committed source after every agent run.
- **`project.check_runtime`:** a local Docker Unix endpoint and already-installed project check image (see below). Missing configuration/runtime/image fails checks and blocks merge/acceptance gates.
- **`agents`:** one entry per subscription and role. Use `model: newest` with `model_family` to always pick the newest eligible model.
- **`tracker`:** `local` to start. Switch to `github` or `linear` with `live: false` first, then flip to `live: true` once you've reviewed it.

## Project checks in Docker

Official vendor harnesses and the supervisor run natively. Production project apps, tests and development tools belong in Docker. Required checks and post-merge checks use the configured Docker runtime; they never fall back to the host. The project Environment panel handles separately approved app/service operations. Native harness shell behavior still depends on vendor permissions; the check runner does not sandbox arbitrary vendor-issued shell commands.

Provision Docker and a project toolchain/dependency image yourself before configuring checks. One Connect does not install Docker, build an image, install dependencies or pull missing images. The image must have `/bin/sh`, `cp`, the toolchain and all dependencies the commands need. Checks run offline as UID/GID 65534 with a read-only root. Use world-readable toolchain/dependency paths in your image; declared Dockerfile `VOLUME`s are refused. Host `node_modules`, `.env`, `.git`, user homes and Docker sockets are never mounted.

For example, with a locally installed Node toolchain image whose dependencies are baked into `/opt/check-deps/node_modules`:

```yaml
project:
  name: example-app
  repo: ~/code/example-app
  checks:
    test: cp -R /opt/check-deps/node_modules ./node_modules && npm test
    typecheck: cp -R /opt/check-deps/node_modules ./node_modules && ./node_modules/.bin/tsc --noEmit
  required_checks: [test, typecheck]
  check_runtime:
    mode: docker
    endpoint: unix:///var/run/docker.sock
    image: example-app-checks:local
    cpus: 1
    memory_mb: 512
    pids: 128
    workspace_mb: 1024
    timeout_seconds: 900
```

Replace the endpoint with the actual local socket. Docker Desktop on macOS commonly exposes `unix:///Users/<you>/.docker/run/docker.sock`; do not select a remote TCP/SSH context. The configured `--host` overrides inherited context settings. An optional absolute `binary` pins the installed Docker CLI. Arbitrary Docker flags, mounts, privileges and network settings are not accepted.

After committing the source to check, run this without starting an agent or a daemon:

```bash
node packages/daemon/src/cli.ts check --config /path/to/control-center.yaml --sha HEAD --log-dir /path/to/check-logs
# Select a configured check, or another worktree of the same repository:
node packages/daemon/src/cli.ts check --config /path/to/control-center.yaml --worktree /path/to/worktree --only test
```

The JSON result identifies the exact source SHA, installed image ID, runtime configuration, exit proof, timeout and private log path. Exit status is nonzero for failed or unavailable checks. The daemon records equivalent evidence after a run and at the merge SHA; switching runtime configuration requires fresh source check proof. A zero Docker CLI attach exit is insufficient: the stopped container's process exit must be confirmed. Cleanup failure also fails the proof.

Each command receives a fresh writable copy of committed Git blobs on container tmpfs. Uncommitted/untracked files are excluded. Tracked symlinks, submodules, unsafe paths, sources above 10,000 files or 128 MiB and images with volumes are reported unavailable. Provision dependencies into the image rather than fetching them. Output is bounded to 256 KiB and redacted using known secret values and token patterns; this does not prove arbitrary committed secrets are absent. The runner removes only its own uniquely named container and source directory, including on command timeout. If cleanup cannot reach Docker, the failed proof reports that an owned container may remain; it never prunes unrelated resources.

## Git execution policy

App-owned Git reads, worktree operations, conflict previews and local merges suppress repository/global hooks and fsmonitor, clean/smudge/process filters, external diff/textconv drivers, credential helpers and lazy fetching. Configured custom merge drivers make conflict previews and merges unavailable until the project uses supported built-in merging. Signing programs and submodule recursion are also disabled for app-owned operations. A merge approval authorizes the local merge of the recorded SHAs; it does not approve repository hook code. Run intended quality checks as named Docker commands.

Assignment worktrees keep app-owned pre-commit path and pre-push protected-branch guards without chaining repository hooks. The daemon separately checks committed path scope and protected target policy before a merge. Native agents and user-initiated Git outside the app retain their vendor/host permission boundary; this policy is not a general sandbox for all host processes.

## Run

```bash
pnpm acc daemon --config path/to/control-center.yaml
pnpm acc open         # opens a one-time sign-in link in your browser
pnpm acc status       # agents, Now/Next, open alerts
pnpm acc kill-all     # stop every run now (works even if the daemon is down)
```

The UI is at `http://127.0.0.1:7317` by default; set `server.port` to change it. Agent runs keep going if you stop the daemon, and are reattached on the next start.

## Development

```bash
ACC_DATA_DIR=/tmp/acc-dev ACC_ALLOW_TEMP_DATA_DIR=1 pnpm acc daemon --config …
pnpm dev:web          # Vite on :5173, proxied to the daemon (set ACC_DAEMON_URL if not :7317)
pnpm test
```

`ACC_ALLOW_TEMP_DATA_DIR=1` is for development only. Normally the daemon refuses temp directories, because the OS wipes them and run evidence would be lost.

## Demo (no subscription usage)

```bash
pnpm demo             # sample repo, scripted vendor CLIs, local tracker, vault, graphify
pnpm demo --reset
```

The generated demo prints `HOST FIXTURE (unsandboxed; disposable tests/demo only)` and explicitly configures `mode: host-fixture` with the exact demo `fixture_repo`. It also writes an opt-in `one-connect-disposable-host-fixture` marker in that repository's Git common directory. Both are required; the environment variable used by fake agents alone never enables host checks. Fixture checks still execute committed-source copies, but are not a security sandbox. Do not mark a real project as a fixture.

Markers in an issue description drive the fake agents:

| Marker | What the fake agent does |
|---|---|
| `[fake:network-fail]` | network failure on every attempt |
| `[fake:network-fail-once]` | network failure once, then succeeds |
| `[fake:usage-limit]` | hits a usage limit |
| `[fake:ask-human]` | calls `ask_human` |
| `[fake:hang]` | stops producing events |
| `[fake:no-handoff]` | finishes without a handoff |
| `[fake:out-of-scope]` | edits outside the allowed paths |
| `[fake:overage]` | reports paid overage in use |
