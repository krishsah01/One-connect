# Handoff: harness-decisions (OpenCode adapter, Ollama both ways, Jev advisories)

Note: the coordinator's brief was not in the workspace; it was read from the read-only path
/Users/krishkumarsah/Docs/Projects/Interface/docs/verification/delegation/NEXT-harness-decisions.md after a mid-task correction. The original task text covered the same scope; the extra brief items (redirect refusal, SSE chunk/reconnect tests, model mismatch, retry once, restart recovery, redaction, evidence ids, audited cancel, loopback-only local endpoints, docs) were then added.

## What was built

### OpenCode adapter (`opencode-server`), default harness for API-key and local providers
- `packages/daemon/src/adapters/agents/opencode.ts` (VendorAdapter), `opencode/protocol.ts` (pinned protocol/version check, provider mapping, per-run config, isolation env, permission mapping), `opencode/events.ts` (pure SSE parser + event mapper), `opencode/bridge.ts` (owned loopback server per run).
- Architecture: the existing detached runner starts the bridge; the bridge spawns `opencode serve` on 127.0.0.1 (random port), per-run random password (env only; verified absent from argv, spec.json, config and every file under the run dir), `OPENCODE_CONFIG` per run, XDG storage under `providers/<agent>/home` (stable per agent so sessions resume), project config/plugins/autoupdate/share/LSP downloads disabled, redirects refused, enabled_providers limited to the run's provider.
- Events: full live text through the existing `live` path (ephemeral delta log), then complete `t.message`; commands, test results, file edits, tool calls/results, errors, usage (unknown stays unknown; cost only when reported and agent is metered), `model_mismatch` (existing model alert), child sessions.
- Permissions: each OpenCode permission request goes to `permission_prompt` through the per-run MCP token (same policy as Claude: in-scope edits auto, dangerous shell / webfetch / external_directory / unknown need a human approval), answer relayed as `once`/`reject` (never `always`). Questions become `ask_human` approvals. Forged/foreign-session events are ignored.
- Stop/Pause: new optional `VendorAdapter.encodeAbort`; `RunManager.stop` (plain stop/pause only) asks the bridge to abort the session first, then signals the process group. Pause keeps the session; Resume continues the same session id. Kill still goes straight to the group.
- Child sessions: new `run.child` control event + `Run.children` projection (they do not take agent slots); their commands/usage are recorded, their prose is not.
- Version pin: `SUPPORTED_SERIES = ['1.0']` is a PLACEHOLDER (no live OpenCode available); unknown/dev versions fail in probe, pre-flight (`binaryCheck`) and at runtime. `ACC_OPENCODE_SUPPORTED` is an owner override.
- Fixture: `examples/fake-agent/fake-opencode.mjs` (+`bin/opencode`), a loopback stand-in implementing the pinned subset (auth, health, SSE, sessions persisted on disk, prompt_async, abort, permissions, questions; scenarios by prompt marker).

### Ollama, both ways
- `adapters/agents/ollama.ts` (`ollamaStatus`), reconciled into `providers.ts`. New provider `ollama-cloud` (`ollama_route: daemon|api`) with billing `subscription`, usage unknown, shared capacity group `ollama`, owner overage confirmation via existing `subscriptionSafety`. `ollama` stays local/free; cloud-named models under `ollama` are a config error. Local endpoints must be loopback; the API route only `https://ollama.com`. Keychain connection names `ollama-cloud` and `jev` added (`providerSecretFor` replaces direct `PROVIDER_SECRET[...]` use in runManager/http).
- Honest states: server not running, not signed in (`/api/me` 401), sign-in unknown, key missing/rejected, no cloud model pulled, models without tool calling (new core pre-flight `tools` check blocks dispatch).
- codex `--oss` and Claude/Codex API paths remain valid alternatives; `PROVIDER_HARNESS` now lists `opencode-server` first (`defaultHarnessFor`).

### Jev advisory
- `packages/daemon/src/jev.ts`: disabled by default; enable needs cost+network+data confirmation and the exact host plus a Keychain key; per-request preview of the exact bounded (20 items / 6000 chars), redacted evidence + hash, then a fresh confirmation bound to that hash; result validated (must be one of the options, must report a model version), persisted on `Decision.advisory` (input hash, model, usage, evidence ids, confidence if reported, host); separate from `recommendation`; stale when the work item/decision evidence changes; closed decisions keep it as history; cancel is audited (`jev.cancelled`); the `jev` actor is refused by every answer path. Egress host added only while enabled. No live call.

### Wiring
- Daemon routes (`server/harnessRoutes.ts`): `/api/harnesses`, `/api/ollama/status`, `/api/jev`, `/api/jev/configure`, `/api/decisions/:id/advisory/{preview,cancel}`, `POST /api/decisions/:id/advisory`.
- UI: Agent builder (model source select, OpenCode default runtime, Ollama panel with states, harness capability/limit panel, paid sources blocked), Agents & connections (Ollama/Jev keys, Jev settings card, provider shown per agent), Agent console (OpenCode session card with child sessions), Decisions inbox (Jev advice with preview, three confirmations, stale/advisory labelling).
- Docs: harnesses.md, setup.md, adding-agent-adapter.md, architecture.md, THIRD_PARTY_NOTICES.md (OpenCode not bundled).

## Shared files touched (small)
core: config.ts (adapter/provider/harness table, ollama_route, validations), entities.ts (Run.children, Decision.advisory, JevAdvisory), events.ts (`run.child`, `decision.advisory`, `decision.advisory_invalidated`, `jev.configured`, `jev.cancelled`), reducer.ts, preflight.ts (`tools` check), capacity.ts (ollama group). daemon: daemon.ts (Jev instance + egress hosts), runManager.ts (providerSecretFor, child event, binaryCheck, graceful abort), server/http.ts (route registration, connections), probe.ts, secrets.ts, egress.ts, decisions.ts (history types), skills.ts, adapters index/env/failures/types/providers. web: AgentBuilder, AgentsSetup, AgentConsole, Decisions. Existing test edited: providers.test.ts (one error-message assertion).

## Tests run (exit 0 unless noted)
- `npx vitest run packages/daemon/test/opencode-protocol.test.ts` 15 passed
- `packages/daemon/test/opencode-harness.test.ts` 16 passed (stable over 4 repeated runs): normal turn/live/usage/handoff/isolation/password-not-on-disk, API-key env only, permission human-approve and deny, question, child sessions, pause+resume same session, stop, auth error, unsupported version (pre-flight) and runtime version drift, network timeout retried once via resume, model mismatch alert, secret redaction, daemon restart reattach + stop, Ollama cloud subscription confirmation gate
- `packages/daemon/test/ollama.test.ts` 13 passed; `packages/daemon/test/jev.test.ts` 9 passed; `packages/web/test/harness.test.tsx` 4 passed
- adjacent: providers, adapters.contract, agent-builder, subscription-safety, web ui.test all passed
- `pnpm -r typecheck` exit 0 (core, daemon, web). SPDX header check on all new/changed source files: none missing. Strip-only: bridge and adapter run under Node's type stripping in the e2e tests and via a direct import. Not run (per rules): full suite, web build, license/Rust gates.

## Unverified / outstanding real-runtime proof
- No real OpenCode run: the pinned series, endpoints (`/event`, `/session/:id/permissions/:id`, `/question/:id/reply|reject`, `prompt_async`, `abort`), event field names, and the `OPENCODE_*` isolation flags are from public docs/memory and fixtures only. Needs an approved live check (local Ollama first, no paid provider) and then setting the real `SUPPORTED_SERIES`.
- OpenCode may fetch its provider SDK from npm for local providers (outside daemon egress); confirm or pre-seed its cache.
- Ollama endpoints (`/api/me`, `/api/show`, cloud API listing) and Jev (`POST /v1/systemone` body/response shape, host `api.typesafe.ai`) verified against fixtures only. Jev supports choice questions only (yes/no, score not implemented).
- Paid API providers via the builder remain blocked by the existing cost-approval rule (`metered_opt_in` in yaml); no separate approval UI was added.
- Skill export dir for OpenCode is null (skills via `get_skill` MCP only).

---

# Handoff: phone, PWA, remote access, notifications, reports, context benchmark

Workspace: `/private/tmp/one-connect-claude/phone-reports`. Brief read from `docs/verification/delegation/NEXT-phone-reports.md` in the original checkout (read only).

## What was built

1. **Installable PWA + phone UI.** `packages/web/public/{manifest.webmanifest,sw.js,offline.html,icons/*.png}` (icons generated by `scripts/generate-pwa-icons.mjs`). The service worker precaches only the offline page, manifest and icons and handles nothing else (no runtime caching, no mutations, ignores api/ws/auth/pair/token URLs). Offline: `OfflineBanner`, `api()` refuses every mutation while offline (nothing queued), Decision/kill-switch buttons disabled. New pages: `/phone` (waiting-for-you, agents with status/usage, alerts, two-step kill switch), `/runs/:id` (full live readable transcript), `/reports`, `/remote` (Phone & alerts), `/pair` (fragment token redeemed once, removed from the URL). Bottom tab bar + project menu on narrow screens (`phone.css`, `components/PhoneShell.tsx`). `DecisionCard` is now exported and reused (second confirmation preserved).
2. **Authenticated remote access** (`packages/daemon/src/phone/{remote,gate,tunnel,routes}.ts`). Disabled by default; reviewable scopes (`read`, `transcript`, `decisions`, `kill_switch`); dry-run review; per-launch Decision bound to the plan digest with second confirmation (new `Decisions.createBound`, routing in `Decisions.respond`); Tailscale Serve adapter (argv only, never Funnel/wildcard, plan refused otherwise, detect/plan execute nothing) and a loopback `FixtureAdapter` (refused unless a test registers it). Expiring single-use fragment pairing, scoped `HttpOnly` cookie (`__Host-`/`Secure` over HTTPS, per-project name), CSRF header + exact Origin, WebSocket Origin and scope filtering, pairing/cookie brute-force bounds, session cap, idle/absolute timeout, revocation (closes sockets), project isolation, bounded audit events, honest tunnel/reachability state.
3. **Notifications** (`phone/notifications.ts`, rules in `core/src/phone.ts`). Local durable inbox always on; macOS banner (osascript), browser, Web Push-gateway and chat-webhook channels all off by default; endpoint activation needs a Decision per exact URL (24 h); dedupe + cooldown; quiet hours (wraps midnight, IANA zones); redaction; minimal outbound payload; alerts for stalled runs, aged approvals/Decisions, usage limits, check/infra failures (incl. generic release/infra/ci/deploy/code_host events), finished work. No email.
4. **Brief & Reports + Timeline** (`core/src/reports.ts`, `phone/reports.ts`). Event-derived only; filters by issue/agent/date/type; handoff cards, Now/Next, pending decisions, check/merge evidence, morning report and Markdown standup with `[#seq sha]` links; agent-reported vs recorded vs counted claims; gaps stated. Release/infra events consumed by shape (`release.saved`, `infra.checked`, `code_host.checked` from the release-infra worker, and generic prefixes).
5. **Context benchmark** (`packages/daemon/src/benchmark/*`, `core/src/benchmark.ts`, `ContextBenchmarkPanel` on the One Answer page, `acc bench context`). Disposable git repo + vault, real One Answer intake, labelled lookup/multi/version/abstain/scope/structure/skill questions; baseline vs One Answer vs Graphify (only when a binary is given) vs on-demand skills; bytes, bytes/4 estimates (provider tokens stay null), latency p50/p95, accuracy, citation integrity against committed blobs, abstention; regression gate. **Fixed**: One Answer notes embedded the commit SHA, invalidating one passage per file per commit (52/93 reused, now 88/93); added a benchmark guard. Scope probes (personal note, sibling project via listed managed parent) pass.

## Shared files touched (small)
`packages/core/src/{entities.ts (Decision.kind adds remote|notification), events.ts (remote.*, notification.*, benchmark.completed types), index.ts}`, `packages/daemon/src/{daemon.ts (4 modules wired, egress hosts), decisions.ts (createBound, respond routing, guard prefixes), cli.ts (bench), server/http.ts (remote gate before local auth, hooks/routes, WS scope filtering), context/one-answer.ts (note header, no SHA)}`, `packages/web/src/{App.tsx, main.tsx, lib/api.ts, lib/store.ts, pages/Decisions.tsx, pages/Docs.tsx}`, `packages/web/index.html`, `docs/{security,architecture}.md`, `SECURITY.md`. No reducer changes: all new state is daemon kv + events.

## Tests run
- `npx vitest run packages/daemon/test/phone-remote.test.ts` exit 0 (8)
- `... phone-notifications.test.ts` exit 0 (9), `... phone-reports.test.ts` exit 0 (4), `... context-benchmark.test.ts` exit 0 (5)
- `... packages/core/test/phone-policy.test.ts` exit 0 (5)
- `... packages/web/test/pwa.test.tsx packages/web/test/phone.test.tsx` exit 0 (13)
- regression spot check of shared edits: `one-answer.test.ts decision-actions.test.ts ui.test.tsx` exit 0 (13)
- `pnpm -r typecheck` exit 0; `node scripts/check-spdx.mjs` ok; `node packages/daemon/src/cli.ts bench context` (Node 24 strip-only) exit 0.
Not run (per rules): full suite, web build, license, Rust gates.

## Decisions made
- Daemon serves one project, so "project navigation" on a phone is the project's sections plus agents; a paired phone is bound to one project; switching projects is a desktop-shell function.
- Standing authorization for push/chat endpoints is per exact URL for 24 h with each delivery re-checked and audited (not a Decision per message).
- Phones cannot answer Docker, connector, environment, remote or notification Decisions (merge and plain questions only).
- Offline "shell" is a static offline page (no app-bundle caching) to guarantee nothing sensitive is stored.
- Tailscale HTTPS default port 8443 to avoid clobbering an existing 443 entry.
- `/api/benchmark/context/run` takes no binary from the request; it uses only the configured/discovered Graphify.

## Unverified / unfinished
- No real phone, browser install, VoiceOver/TalkBack, real Tailscale, macOS banner permission, browser Notification display, or push/chat provider was exercised. Web Push encryption/VAPID is not implemented (gateway POST only).
- Graphify arm validated only with the repository's fake CLI; embeddings arm not run.
- No web build or visual/browser check was run (rules); UI is typechecked and covered by jsdom tests only. Pairing QR code not offered (link + copy).
- Held-by-quiet-hours alerts are not re-sent as a digest after quiet hours end; they stay in the inbox.
- `docs/phone-access.md` and `docs/phone-verification.md` hold setup/security docs and the matrix; a HANDOFF in `docs/verification` was not written (that folder is outside the workspace).
