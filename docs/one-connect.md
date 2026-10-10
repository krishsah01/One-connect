# One Connect product architecture

## Confirmed product choices

One Connect is a Mac-first application that joins the development cycle across vendors. The Tauri/Rust shell, supervisor, official subscription harnesses and optional API harness run natively. Only the project being developed runs in Docker: its apps, services, databases, development tools and checks. Later Windows support shares the portable UI and core, with platform-specific process and permission validation.

Ask your docs means semantic search and grounded questions over the user's selected Obsidian folders. Jev means TypeSafe's System One model. Jev may recommend, classify urgency and decide when to escalate; it cannot record a human approval. Its metered connection remains disabled until the owner explicitly enables it. Mock design means editable interactive previews and a versioned design system that implementation and review must follow; Figma is outside the initial design scope.

### Dictionary intake

Every added project, whether cloned from Git or selected locally, receives a revision-bound project scan. Extract repository structure, language/framework inventory, manifest dependencies, declared checks and container services, source documentation and architecture references without executing project scripts. Exclude secrets, binary/generated/vendor files and symlinks; report indexing limits explicitly. Write cited notes into the selected Obsidian project folder (a private local markdown vault before an Obsidian connection is selected), index them with local embeddings when enabled, and build the Graphify graph from the same Git revision. Track each component's revision and freshness separately; Dictionary must flag a partial or stale scan rather than promise omniscience. Agents and the human query this same retrieval layer. Source changes refresh the derived notes/index/graph, not another independent copy of project truth.

### Designer defaults

The designer includes pinned Taste Skill and Vercel Web Interface Guidelines text, licensed DESIGN.md references, a scoped Playwright CLI integration guide, and original skills for accessible UI, responsive mocks and design-contract enforcement. Open Design (`nexu-io/open-design`) is a reviewed Apache-2.0 reference implementation; reuse selected resources with source commits and upstream MIT notices. Keep hosted plans, telemetry, media APIs and executable installations disabled. Load skill descriptions cheaply and detailed references on demand. Every project design system has validated tokens, rules, a version/hash, preview and DESIGN.md/CSS exports. Assignments freeze that revision so implementation and review see the same contract.

## Components and sources of truth

- Rust owns the native window, terminal, project registry, private daemon connection and OS integration. Keep the working TypeScript supervisor until measurements justify moving a specific hot path to Rust.
- Each project has an isolated SQLite event store, tracker binding, policies, worktrees, Docker Compose namespace, context index and dashboard. Git owns code; the tracker owns issue state; the event log owns actions, runs, messages and human decisions.
- The supervisor runs official vendor harnesses for subscriptions. API mode uses an independently licensed open-source harness behind the same adapter interface, never a subscription session token. Select and pin that harness after contract tests for streaming, approvals, tools, restart and container access.
- All clients share the same typed reducer and receive live event updates. Logs survive restarts. A complete message or test claim is never replaced by an attractive preview.

## Agent coordination

One project-scoped message bus carries targeted questions, replies, blockers and handoffs. Every message has a sender, recipients, issue/run references, optional reply link and durable acknowledgements. A dashboard shows the same messages agents see. Authenticated run tokens determine the sender; agents cannot impersonate another agent or read another project's inbox.

At dispatch, every agent receives a compact current team snapshot: agent roles, Now/Next, ownership and path scopes, pending decisions and its own unread message identifiers. During a run, agents pull `get_team` and `read_messages`, and use `send_team_message` when coordination is needed. Streaming harnesses receive a small inbox notification, not everyone else's transcripts. Harnesses without live input pull at tool boundaries; message state stays durable until acknowledged. A notification never creates an unapproved new run or paid call.

Shared state prevents stale ownership; dependency edges and independent review prevent simultaneous incompatible work. Agents communicate advice and evidence, not authority to override cost, security, path or release policies. The human can inspect and answer any thread. A coordinator coordinates through tools rather than driving other apps.

## Context and token efficiency

Combine scoped Obsidian retrieval with Graphify's code graph. Store content hashes and index incrementally. Retrieve small cited passages, load skill instructions only when used, and send event/state deltas rather than transcript broadcasts. Label character-derived token estimates as estimates; provider-reported token usage is separate. Quality is evaluated through acceptance checks, independent review and a retrieval evaluation set, never inferred from fewer tokens.

Evaluate QMD and permissively licensed Obsidian semantic-search implementations for local embeddings and hybrid retrieval. No unrelated vault folders, symlink escapes, remote embeddings or automatic model downloads. Ask your docs answers must cite retrieved note passages and say when no evidence was found.

## Phased delivery and verification

1. **Connected workspace:** One Connect identity, project-scoped durable communication, compact team snapshots, message dashboard, token/idle/run analytics and current-state evidence. Verify authenticated agent-to-agent exchange, replies, acknowledgement, redaction, bounded context, live UI updates and replay after restart.
2. **Build a team:** custom agents, shared provider capacity, skills and connector management, coordinated/independent workflow execution, multi-project registry and dashboards. Verify parallel worktrees, queue recovery, provider limits, connector isolation and workflow dependencies.
3. **Design and development:** interactive mock builder, design-system artifacts and enforcement, scoped semantic vault retrieval/Q&A, Graphify context metrics, official provider streaming/approval protocols and chosen API harness. Verify real tool runs and retrieval quality, not only fixture output.
4. **Review through release:** SHA-bound independent review, phone decisions, approved integration merges, post-merge checks, ordered release plans, infra health/drift and evidence-backed morning reports. Add Jev recommendations with explicit paid opt-in. Verify every approval and acceptance gate, failures/retries and restart recovery.
5. **Complete-product audit:** package a reproducible Mac application; run the original acceptance demo and the new cross-project, Docker DB, design, skill, connector and workflow scenarios. Preserve Apache-2.0, notices, DCO, security docs, license CI, no default telemetry and disabled live outbound integrations. Completion requires current evidence for every original and added requirement; these phases do not narrow the product goal.

## Visual direction

The interface should feel like one connected workbench. Use a quiet project sidebar, a persistent team/status rail and readable work surfaces. Palette: pearl `#f3f6f7`, white `#ffffff`, ink `#18343b`, teal `#087e8b`, mist `#dceef0`, amber `#a15c00`. Use the native system sans-serif for controls and reading, monospace only for commands and SHAs. A connected-agent diagram encodes real message links and status; it is the distinctive visual element. Left-aligned content, visible focus, sentence-case labels and responsive layouts carry the rest.
