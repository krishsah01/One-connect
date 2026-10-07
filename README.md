# One Connect

A local-first control center that runs a team of AI coding agents from different vendors through the development cycle, on the subscriptions **you already pay for**. Every agent gets a live console. Issues, assignments, runs, branches, handoffs and your decisions are connected in one event log.

> **Status: Phase 1.** Built: the daemon, event store, agent adapters, Mission Control, Agent Console, Work Board, trackers (local, GitHub, Linear) and shared context (Obsidian and graphify). Review & Merge, Decisions, Release Cockpit and infra adapters come next; see [docs/plan.md](docs/plan.md).

The **Mac app preview** adds a Tauri shell, an embedded project/login terminal, GitHub/Linear import previews and scoped Docker controls. It opens an offline demo by default and authenticates its local dashboard automatically. See [docs/desktop.md](docs/desktop.md) for build instructions and current streaming limits.

The expanded One Connect architecture is in [docs/one-connect.md](docs/one-connect.md). Subscription agents stay native; Docker runs the project being developed. Team workspace adds durable, scoped agent conversations and acknowledgements; Analytics reports recorded sessions, usage and evidence. [One Answer](docs/one-answer.md) indexes redacted committed project sources, local docs and Graphify at an explicit revision. [Designer](docs/designer.md) includes a versioned design-system editor, interactive token mock and seven default skills. Custom agents can be saved as disabled drafts with shared subscription capacity. Full workflow execution, generated design artifact editing and release milestones remain in progress. Existing `acc` commands and the app-data identifier are retained so prior projects and logs remain accessible.

## Why

Each of these happened in a real multi-agent project. The control center makes each one impossible or loud:

| Failure mode | What the control center does |
|---|---|
| The coordinator did the work instead of coordinating | `mode: coordinator-only` agents can't take code-writing assignments. Agents pull their work; nobody drives other apps' UIs. |
| No shared state; stale copies of instructions | One event log. Agents call `get_assignment` for the current text. A generated **team contract** and **live brief** sit in your Obsidian vault. |
| Agents sat idle | Now/Next queues per agent: when Now finishes, Next starts automatically. Idle time is a metric, and "idle with work queued" raises an alert. |
| Silent stalls | No events for N minutes, or an approval pending for M minutes, raises a critical alert. Approvals go to your phone-friendly inbox. |
| Lost evidence | Runs write durable, redacted logs in the app-data directory (temp directories are refused). Runs survive daemon restarts. |
| Tracker drift | Each status change is committed together with its tracker write (transactional outbox). Failed syncs alert. Polling catches edits made in the tracker. Agents file findings as issues. |
| Wrong models | Newest-model check at dispatch, quality floors, binary pinning (an app can bundle a newer CLI than PATH), and an alert when the vendor served a different model than requested. |
| Usage-limit and cost surprises | API-key variables are stripped from runs and metered billing blocks dispatch. A run is stopped when the vendor reports paid overage. Usage meters show where vendors expose them. Hitting a limit triggers a reassignment suggestion and never a paid fallback. |
| Unsafe reach | Per-worktree pre-push hook on protected branches, path scopes enforced at commit time, push/deploy/migrate/publish routed to you, a kill switch. |
| Ceremony instead of progress | No leases or receipts: ownership (issue ↔ agent) plus live process state. |
| The human is away from the desk | A responsive UI: answer questions and approvals from your phone. Every answer is recorded with its channel. |

## Bring your own subscriptions

Each agent runs through its vendor's **official** CLI or app, signed in with your account:

| Agent | Adapter | Sign-in |
|---|---|---|
| Claude Code | `claude-headless` | `claude auth login` (Claude Pro / Max) |
| OpenAI Codex | `codex-cli` | `codex login` → Sign in with ChatGPT |
| Cursor | `cursor-agent-cli` | `cursor-agent login` (Cursor Pro) |
| Antigravity, Gemini app, desktop IDE agents | `relay` | copy the prompt in, paste the reply back |
| Any other CLI | `generic-cli` | the tool's own login |

The control center **never sees, stores or proxies your credentials**, and ships no vendor binaries. **You are responsible for following your own plan's terms for automated use.** It is designed for one person using their own subscriptions on their own machine, never shared, pooled or resold. Turn paid overage, on-demand billing and auto-recharge off in each vendor account. See [docs/subscriptions.md](docs/subscriptions.md).

## Quick start

Requires Node 24+, pnpm, git, and the vendor CLIs you want to use.

```bash
pnpm install
pnpm build                       # web UI
pnpm acc onboard                 # finds vendor CLIs, versions, login commands
cp examples/control-center.yaml ./control-center.yaml   # then edit it
pnpm acc daemon                  # prints a one-time sign-in link
pnpm acc open                    # later: sign a browser in again
```

Try it without spending any usage. The demo runs scripted agents against a sample repo:

```bash
pnpm demo
```

## How it fits together

```
 vendor CLIs (your logins)          acc daemon (127.0.0.1)                     you
 claude / codex / cursor  ◀─ runner ─┤ event log (SQLite, append-only)  ├─ WebSocket ─▶ Mission Control
      │  stdout/stderr → redact → durable logs → typed events          │              Agent Console
      └─ acc MCP server ────────────▶ assignments · approvals · findings ├─ REST ─────▶ Work Board
                                     │ rules: refill · stall · retry · limits           phone
 git worktree per assignment ◀──────┤ outbox → GitHub / Linear / local tracker
 Obsidian vault · graphify ◀────────┤ shared context (contract, brief, code graph)
```

More: [docs/architecture.md](docs/architecture.md).

## Docs

- [Setup](docs/setup.md) · [Connect your subscriptions](docs/subscriptions.md) · [Shared context: Obsidian + graphify](docs/context-sharing.md)
- [Mac app, issue imports, terminal and containers](docs/desktop.md) · [Desktop refinement plan](docs/desktop-plan.md)
- [Adding an agent adapter](docs/adding-agent-adapter.md) · [Adding a tracker adapter](docs/adding-tracker-adapter.md)
- [Security model](SECURITY.md) · [Licensing](docs/licensing.md) · [Architecture](docs/architecture.md) · [Phased plan](docs/plan.md)

## Not affiliated

Agent Control Center is an independent open-source project. It is **not affiliated with, endorsed by, or sponsored by** OpenAI, Anthropic, Google, Anysphere (Cursor), GitHub, Linear, Obsidian or any other vendor. Product names are used only to identify compatible tools, and no vendor logos are included.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Contributions require a [DCO sign-off](CONTRIBUTING.md).
