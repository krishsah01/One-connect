# Security model: mechanisms

The threat model and reporting policy are in [SECURITY.md](../SECURITY.md). This page explains how each guard works and where it lives.

| Guard | How | Code |
|---|---|---|
| Local-only API | Binds `127.0.0.1`. Host header must be a local address on the daemon's port (stops DNS rebinding). A cross-origin `Origin` is refused, and state-changing requests without an `Origin` (and without the bearer token) are refused. | `server/http.ts` |
| Sign-in | `acc open` asks the daemon, using the `0600` install token, for a one-time code. `/auth?code=` swaps it for an HttpOnly, SameSite=Strict session cookie. Sessions are stored hashed. | `server/http.ts`, `cli.ts` |
| Per-run MCP auth | Each run gets a random token in `runs/<id>/mcp.json` (`0600`). The MCP bridge only accepts that token, and only for its own run. | `runManager.ts`, `mcpBridge.ts`, `mcp/server.ts` |
| Redaction | Token patterns (GitHub, Anthropic, OpenAI, Linear, Slack, AWS, Google, Stripe, JWT, Bearer, URL credentials, key=value secrets, PEM blocks) plus exact values from `policies.redact_env` and tracker keys. Applied in the runner before disk, on every event, on outbox payloads and on prompts (pre-flight fails on a hit). | `core/redact.ts`, `runner/runner.ts`, `daemon.ts` |
| Billing | API-key variables are stripped from child environments. A pre-flight billing check runs against the vendor's own login status. The run is stopped on an `apiKeySource` that isn't the subscription, or on paid overage in use. | `adapters/agents/env.ts`, `core/preflight.ts`, `runManager.ts` |
| Path scope | Per-worktree `core.hooksPath` (`extensions.worktreeConfig`). The pre-commit hook rejects staged files outside the allowed globs, then chains to your own hook. A live watcher raises `scope_violation`. | `adapters/vcs/git.ts`, `hook.ts`, `runManager.ts` |
| Protected branches | The pre-push hook rejects any ref to a protected branch. The daemon never pushes. | `adapters/vcs/hook.ts` |
| Tool approvals | Claude's `--permission-prompt-tool` sends requests to the control center. In-scope edits and non-dangerous shell commands (when `allow_shell`) are auto-allowed. Push, deploy, migrate, publish and messaging go to you as pending approvals with stall alerts. | `mcpBridge.ts` |
| Privacy | `--strict-mcp-config` (Claude) and `--ignore-user-config` (Codex) keep your personal MCP servers out of agent runs. Vault reads are limited to configured folders. Codex usage is read only from sessions the control center started. | adapters, `context/vault.ts` |
| Durability | Data directories under temp paths are refused. The event log is append-only (SQLite triggers). Offsets are stored atomically with events. | `paths.ts`, `store/eventStore.ts` |
| Kill switch | Signals every runner process group (SIGTERM, then SIGKILL). `acc kill-all` works with the daemon down by verifying runner PIDs from their run directories. | `daemon.ts`, `runner/supervisor.ts` |
