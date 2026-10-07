# Runtime choices for One Connect

Subscription agents keep their provider's official harness and login. One Connect supervises the process, adapts public events and routes supported input and approval protocols into its own console. It does not extract app sessions or impersonate a subscription through an API key. Project apps, tests and databases run in Docker; agent harnesses stay native, as the owner requested.

For API agents, choose **OpenCode** as the first additional open-source harness adapter. This is an implementation decision, not a claim that the adapter already exists. The current API configurations still use the existing Claude/Codex adapters until their migration is implemented and verified. Metered modes remain opt-in.

| Harness | Primary evidence | Fit |
|---|---|---|
| OpenCode | [MIT source license](https://github.com/anomalyco/opencode/blob/dev/LICENSE), [headless server](https://opencode.ai/docs/server/), [SDK](https://opencode.ai/docs/sdk/), [permissions](https://opencode.ai/docs/permissions/), [MCP](https://opencode.ai/docs/mcp-servers/) | First adapter: public sessions, event subscription and permission replies fit an in-app console, with provider-neutral API access. Pin and test a specific release. |
| Pi | [MIT source](https://github.com/earendil-works/pi), [coding-agent SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) | Suitable alternative for a smaller embedded agent loop. A host still needs to bind project tools, approval policy and persistent events. |
| OpenHands SDK | [MIT SDK source](https://github.com/OpenHands/software-agent-sdk), [SDK documentation](https://docs.openhands.dev/sdk/getting-started) | Useful later for specialized development agents. Evaluate the SDK separately from the platform's enterprise components and preserve the selected native-agent boundary. |

The MIT licenses permit use and modification in a commercial product, subject to retaining their required notices. Evaluate the exact release and its transitive dependencies before distribution. A permissive harness license does not change a model provider's terms or authorize subscription sharing.

The OpenCode adapter must implement the same runtime contract as subscription adapters: exact executable/version, model inventory, auth/billing/usage state, start/send/stream/pause/resume/stop, approvals and durable session identity. Each run needs an isolated worktree and project MCP identity. Permission events must reach the human before the action; queued reminders and reported progress are not evidence of completion. Provider keys come only from explicit Keychain connections and never appear in config, prompts or transcripts. Background discovery must not start paid inference, enable fallback, download a model or contact an unapproved remote MCP server.

All adapters need contract fixtures plus a live, approved provider check before being labelled verified. Supporting a CLI's print output alone is insufficient when it cannot accept questions or approvals inside One Connect. An adapter's in-app interaction limitations must be visible during agent creation and preflight.

## Jev

The owner's Jev requirement refers to TypeSafe's System One model. Its [official API quickstart](https://docs.typesafe.ai/introduction/quickstart) exposes choice, yes/no and score questions through `POST /v1/systemone`, with a model version and usage in the response. Use it to recommend and prioritize a human decision, retaining the evidence and model version with that recommendation. The human's answer is the approval record. Jev cannot answer an irreversible approval for the human.

The Jev connection and decision recommendation UI remain to be implemented. An API key, live endpoint and cost opt-in need an explicit connection action before any real call. Until then, use offline protocol fixtures and the existing human question inbox; do not label an ordinary agent suggestion as a Jev result.

## Portable skills and connectors

One Connect's integration unit is a reviewed skill bundle or MCP connector, scoped to a project and assigned agents. Installing a plugin in Codex does not automatically make it embeddable in this product. Track source, version, license, declared tools, required permissions, credentials and network destinations. Enabling a connector is separate from discovering it. A connector must start disabled, show a concrete permission/cost summary, and preserve per-action approval for writes.

The first catalog should cover GitHub/Linear work, Git/worktree tools, Docker project services, browser testing, code graph retrieval, document search, design-system checks, accessibility review, independent code review and security review. Each entry needs a tested adapter and license evidence; avoid a decorative catalog whose buttons do not execute a verified workflow.
