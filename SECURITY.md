# Security policy

## Reporting a vulnerability

Report privately through **GitHub private vulnerability reporting**: the "Report a vulnerability" button on this repository's Security tab. Do not open a public issue.

Include a description, the steps to reproduce, the affected version, and the impact. We aim to acknowledge reports within 3 working days.

Fallback contact: **TODO: security contact (set before the first public release)**.

## Supported versions

| Version | Supported |
|---|---|
| 0.x (latest minor) | ✅ security fixes |
| older | ❌ |

## Threat model: read this before you run it

**Agent Control Center runs AI coding agents that execute shell commands on your machine, with your user account's permissions.** Treat it like a CI runner on your laptop.

What it protects:

| Asset | Protection |
|---|---|
| Your money | API-key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`, …) are stripped from agent runs. Dispatch is blocked when detected billing is metered. A run is stopped if the vendor reports API-key billing or paid overage. |
| Vendor credentials | Never read, stored or proxied. Each vendor CLI handles its own login. |
| Tracker credentials | GitHub goes through your own `gh` login. The Linear key is read from the macOS Keychain or an environment variable at runtime, never written down, and redacted. |
| Secrets in output | Agent output is redacted (token patterns, configured env values, private keys) by the runner before it reaches disk, events, the UI, prompts or tracker comments. |
| Protected branches | Each agent worktree has a pre-push hook that rejects pushes to protected branches. The daemon never pushes. |
| Scope | A per-worktree pre-commit hook rejects commits outside the assignment's allowed paths. A live watcher flags out-of-scope edits. |
| Irreversible actions | Claude tool requests that look like push, deploy, migrate, publish or messaging are routed to you for approval. Approvals are recorded as auditable events. |
| Your unrelated data | Agent runs get only the `acc` MCP server: your personal MCP servers aren't inherited (Claude uses `--strict-mcp-config`; Codex uses `--ignore-user-config`). Only the configured vault folders are readable. |
| The control API | Binds to `127.0.0.1` only. Every request needs a session cookie (from a one-time code), the install token (`0600`) or a per-run token. Host and Origin headers are checked, which blocks DNS rebinding and cross-site requests. |
| Evidence | The event log is append-only (SQLite triggers) and stored in a durable app-data directory. Temp directories are refused. |
| Runaway agents | The kill switch (UI, API or `acc kill-all`) stops every runner process group, even with the daemon down. |

What it does **not** protect against:

- **A malicious or prompt-injected agent with shell access.** Vendor sandboxes (Codex `workspace-write`, the Cursor sandbox, Claude permission modes) are the main containment. Hooks are guardrails, not a sandbox: an agent can bypass git hooks with `--no-verify`. The daemon re-checks the diff scope after every run and flags violations. Re-checking before merge arrives with Review & Merge in Phase 2.
- **Other processes running as your user.** They can read the data directory, the same as any local tool.
- **Vendor-side behavior.** That includes overage you have enabled in a vendor account. The UI shows the overage state where vendors expose it and "unknown" where they don't. Turn paid overage off in each account.

## Hardening checklist

- Keep `tracker.live: false` until you have reviewed the integration.
- Set `allow_shell: false` for agents that don't need arbitrary commands.
- Protect `main` on your code host as well; the local hook is only a second line of defense.
- Put production credentials in `policies.redact_env`.

## Native desktop boundary

The desktop loads bundled local assets. Remote pages receive no native capabilities. Its install token stays in Rust; the renderer gets single-use, short-lived WebSocket tickets rather than that token. Each selected configuration has a separate state directory. The embedded shell runs as the human user and is not sandboxed; its login keystrokes/output are not saved. Docker writes require a recorded, single-use decision for an exact container in the configured Compose project. The preview is not yet a notarized public release.
