# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added: harness setup and own-account compliance

- Setup step 1, *Choose your harness*: Claude Code, Codex CLI, Cursor Agent CLI and OpenCode, with each vendor's official install commands. On the Mac they are prepared in the project terminal and run only when you press Return. Each harness offers *Use my own plan* or *Use an API key instead*.
- Own-account confirmation for subscription logins, once per vendor login. It is audited, kept across restarts, and expires after `policies.accounts.terms_max_age_days`. It breaks when the linked vendor terms revision or the signed-in account changes. Dispatch is blocked without it.
- `policies.accounts.mode: api-keys-only` for shared, hosted or team use. It refuses every subscription login.
- macOS code-signature check of the Claude Code and Codex binaries. A foreign or broken signature blocks dispatch.
- Background watch: expired logins, confirmations due within 14 days, and API keys older than `api_key_rotation_days`.
- `cursor-api` provider: the Cursor CLI with a Cursor API key from the Keychain.
- Account fingerprints: the daemon keeps only a hash and a masked label. Credential files are never read.

### Added: Mac app preview

- Tauri 2 desktop shell with a bundled, checksummed Node runtime, private native API proxy, single-use WebSocket tickets and per-project durable state.
- GitHub/Linear issue preview and selected local imports with provenance and duplicate detection; offline fixtures for both sources.
- Native PTY project/worktree and vendor-login terminals, plus scoped Docker status/logs and audited approvals for container start/stop/restart.
- In-app durable log viewing, complete transcript history pagination, bounded event rendering, and native dependency license notices/source availability.
- Mac build CI and native tests. Windows and notarized distribution remain future work.

### Added: Phase 1

**Daemon and runs**
- Supervisor daemon with an append-only SQLite event log, a shared reducer for the daemon and the UI, snapshots, and restart-safe replay.
- Detached per-run runner: secrets are redacted before anything reaches disk, logs are durable, and runs survive a daemon restart (reattached with a PID identity check, or marked orphaned).

**Agent adapters**
- Claude Code (headless stream-json), Codex CLI (`exec --json`), Cursor agent CLI (stream-json), generic CLI and relay (copy/paste).
- All of them pass a contract suite built on real captured streams.
- Subscription-first billing guard:
  - API-key environment variables are stripped from agent runs.
  - Dispatch is blocked when detected billing is metered.
  - A run is stopped when the vendor reports API-key billing or paid overage (Claude `rate_limit_event`).
- Binary pinning across PATH and app bundles; newest-model selection; served-model mismatch detection; usage meters (Codex rate limits, Claude rate-limit events).

**Shared state and approvals**
- The `acc` MCP server for agents: `get_assignment`, `post_handoff`, `report_finding`, `ask_human`, `permission_prompt`, `get_brief`, `search_context`, `read_note`, `query_graph`, `graph_path` and `explain_node`.
- Claude tool permissions route to the human as pending approvals.

**Git**
- One worktree per assignment, with branches named `<agent>/<KEY>-<slug>`.
- Per-worktree pre-commit (path scope) and pre-push (protected branches) hooks that chain to your existing hooks.
- Live diff and early overlap and conflict detection.

**Evidence and rules**
- The daemon re-runs the required checks after each run and records verified evidence with the SHA.
- Handoff claims are cross-checked against recorded commands.
- Rules:
  - auto-refill (Now → Next);
  - stall and pending-approval detection;
  - network failure retry, once, resuming the session;
  - usage-limit handling;
  - handoff enforcement with a generated skeleton;
  - idle-with-work alerts.

**Trackers**
- Local tracker, GitHub Issues through `gh`, and Linear through GraphQL.
- Transactional outbox with loud out-of-sync alerts, plus polling for changes made in the tracker.
- Outbound trackers stay in dry run until `live: true`.

**Shared context**
- Obsidian vault notes: team contract, live brief, issues, handoffs and decisions. The official Obsidian CLI is used for search when it's available, scoped to configured folders.
- graphify code graph of the integration branch: AST only, no LLM, rebuilt when the branch moves.

**Web UI**
- Mission Control, Agent Console (live transcript, controls, approvals, diff, tests, handoff, history), Work Board (dispatch with pre-flight, drag-and-drop Now/Next queues) and Agents setup. Works at phone width.

**Security and open source**
- Local-only API with one-time-code sign-in, Host and Origin checks, and a kill switch (UI, API and `acc kill-all`).
- Apache-2.0 license, NOTICE, generated third-party notices with a license-compatibility gate, SPDX headers, DCO, Code of Conduct, a security policy with a threat model, and CI.
