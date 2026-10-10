<!-- SPDX-License-Identifier: Apache-2.0 -->
# Runtime adapter checkpoint — 2026-10-07

Source changes stopped after the focused checks below. Work was confined to `/private/tmp/one-connect-cursor-Bu9W8J/claude-final`; the resumed baseline was `26b945fc951721d97eae111a14bf9ef5c99a63b0`, which already contained the parent's promotion of the earlier adapter repairs. No commit, primary-checkout change, desktop/native build, bundle, install, model pull, live provider request, production action or real credential change was performed. Other workers' shared edits were preserved. This checkpoint does **not** establish whole-product or real-provider acceptance.

This document supersedes the runtime protocol assumptions and runtime test counts in the historical `CLAUDE-harness-phone-handoff.md`; that file's phone work remains outside this task. [Runtime status and primary sources](../../harnesses.md) and [shared integration snippets](../../adapter-protocols.md) describe the current implementation.

## Implemented and checked

**OpenCode:** accepts exactly `1.18.35`, local bridge protocol `opencode-server/2`. The inspected [release](https://github.com/anomalyco/opencode/releases/tag/v1.18.35), [generated SDK](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/sdk/js/src/v2/gen/sdk.gen.ts) and [wire types](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/sdk/js/src/v2/gen/types.gen.ts) establish current health, discovery, event, session, prompt, abort, permission and question operations. Permission replies use `/permission/{requestID}/reply` with `reply: once|reject`; no guessed session-permission fallback or version override remains. Runtime health and `/doc` operations must agree before prompting.

The bridge reconstructs actual delta events, preserves event IDs, routes permissions/questions through existing human/policy paths, and keeps child sessions, pause/resume, stop and reported usage. Lost/malformed streams, unknown delta parts, model mismatch and failed approval/question delivery fail the run. Failed terminal results preserve their cause without implicitly retrying an unreplayable stream. Missing tokens or command exits do not become fabricated zero usage or passing tests. Unsupported multiple-selection questions are rejected explicitly; successful delivery is only recorded after the server accepts the reply/rejection.

Source-inspected environment/download controls isolate home/config/cache/state, retain private per-agent session data, expose only the selected key, disable external config/plugins/skills/model fetching/LSP/FFF/updates, and force npm offline with an empty isolated cache/config and disabled scripts. Only the four inspected bundled provider SDKs are configured. Existing executable `rg` is required, and macOS managed preferences block startup because they cannot be isolated. The pinned upstream config may log an offline optional-dependency failure; the adapter does not seed fake dependencies or claim an install succeeded. Full upstream execution and download-prevention behavior remain pending live acceptance.

**Ollama:** local, signed-in daemon-cloud and direct API-cloud routes use validated origins. Direct API is exactly `https://ollama.com`; IDs are used verbatim, with no local-alias rewriting. Cloud detection uses remote metadata as well as recognized aliases. Identity, route and explicit tool metadata are required before selection and rechecked by the bridge. Public tags cannot authenticate a key, unknown `/api/me`/metadata responses remain unselectable, cloud prices/quota remain unknown, and probes never pull, infer or sign in. Contracts were inspected in [cloud docs](https://docs.ollama.com/cloud), [authentication](https://docs.ollama.com/api/authentication), [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [tags](https://docs.ollama.com/api/tags), [show](https://docs.ollama.com/api-reference/show-model-details), and official [Go client](https://github.com/ollama/ollama/blob/main/api/client.go)/[types](https://github.com/ollama/ollama/blob/main/api/types.go). Those Ollama source links track upstream main, inspected on the date above; this adapter gates capabilities, not a guessed Ollama version series. Hosted identity/show availability has not been demonstrated against a real cloud account; unavailable endpoints block acceptance rather than proving authentication through catalog success.

**Jev:** uses the [documented System One API](https://docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`, `model: jev-latest`, `state`, and named `questions.decision` with `type: choice` and stable option criteria. Typed responses require matching choice IDs, valid probabilities/confidence, reported model and nonnegative integer token usage. No invented flat response, prose rationale or price is accepted. The exact bounded/redacted envelope is previewed and hashed. Enable/request confirmations remain human-only; no advice answers or authorizes a decision. Evidence switches on merge/cost/settings/release/rollback/inspect, reads merge fields only for merge, includes full bounded SHAs and revision hashes, and refuses future unknown kinds. Requests reject duplicate in-flight work, stale/closed evidence and changed endpoint/enabled state. Response consumption is capped at 64 KiB and oversized streams are cancelled before advice is recorded. Only 2–8-option choice decisions are implemented.

**LM Studio:** OpenCode configuration now refuses this provider because no verified tool capability contract is available. The old unconditional `tool_call: true` has been removed from that path. This is an explicit runtime restriction, not a claim about LM Studio's own capabilities or another harness.

## Exact owned paths

The whole bounded adapter task produced or repaired these paths, including earlier work already promoted by the parent:

| Path | Resumed checkpoint change |
|---|---|
| `packages/daemon/src/adapters/agents/opencode.ts` | Preserve failed terminal causes; describe LM Studio restriction. |
| `packages/daemon/src/adapters/agents/opencode/protocol.ts` | Refuse unverified LM Studio; correct cloud routing comment. Earlier exact pin/config/env repairs retained. |
| `packages/daemon/src/adapters/agents/opencode/bridge.ts` | Fail failed question reply/rejection without claiming delivery. Earlier bridge protocol/isolation repairs retained. |
| `packages/daemon/src/adapters/agents/opencode/events.ts` | Earlier current event mapping retained; no resumed edit. |
| `packages/daemon/src/adapters/agents/ollama.ts` | Earlier fail-closed probes retained; no resumed edit. |
| `packages/daemon/src/adapters/agents/ollama-cloud.ts` | Earlier origin/capability helpers retained; no resumed edit. |
| `packages/daemon/src/jev.ts` | Bound response transport. Earlier discriminated evidence/System One repairs retained. |
| `packages/daemon/test/opencode-protocol.test.ts` | LM Studio refusal, preserved failed results and accurate replay wording. |
| `packages/daemon/test/opencode-harness.test.ts` | Failed question delivery regression and corrected fixture provenance comment. |
| `packages/daemon/test/fixtures/opencode-current.mjs` | Synthetic question delivery failure control; current source-verified wire shapes retained. |
| `packages/daemon/test/ollama.test.ts` | Align assertion with parent's stricter preflight; require exact catalog versions. |
| `packages/daemon/test/jev.test.ts` | Unknown action refusal and bounded stream cancellation regression. |
| `packages/daemon/test/runtime-adapters.strip.test.mjs` | New direct Node24 isolated import/entrypoint checks. |
| `docs/harnesses.md` | Authoritative runtime status, primary source references and final restrictions. |
| `docs/adapter-protocols.md` | Mark integrated snippets done; provide remaining parent-only snippets. |
| `docs/verification/delegation/runtime-adapters-handoff.md` | This durable checkpoint. |

No shared integration source was edited. In particular, parent's cost/settings modules, phone/connector/release work and native/desktop scripts were left to their owners.

## Actual checks

Installed Node24 used directly: `/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`, version **v24.19.0**. No runtime or dependency was downloaded.

1. `node_modules/.bin/tsc -p packages/daemon/tsconfig.json --pretty false` — exit 0. Daemon package typecheck includes the owned source/tests and their imports, using `erasableSyntaxOnly`; no repository-wide gate.
2. With the Node24 executable above: `node node_modules/vitest/vitest.mjs run packages/daemon/test/opencode-protocol.test.ts packages/daemon/test/opencode-harness.test.ts packages/daemon/test/ollama.test.ts packages/daemon/test/jev.test.ts --reporter=dot` — **66/66 passed**, 4 files: protocol 20, harness 17, Ollama 16, Jev 13. Synthetic loopback listeners required sandbox escalation. No vendor API or inference was used. The fixture is an authored, source-verified subset, not a captured real session or a complete upstream conformance suite.
3. With the same Node24 executable: `node --test packages/daemon/test/runtime-adapters.strip.test.mjs` — **7/7 passed**. Six modules each imported in a fresh process with isolated home/XDG/temp and no inherited credentials, network calls and child-process invocation guarded to fail. The executable bridge separately rejected an unknown protocol with an honest error/failure before any server startup. No Vitest/transpiler used in these seven checks.
4. Whitespace diff check passed. All authored source/test/doc files retain Apache-2.0 SPDX headers.

Earlier failures were repaired, not counted as passes: an Ollama assertion expected the old first preflight message after the parent added an earlier refusal; the first new Node import test parsed its own helper log as bridge JSON; the first full resumed fixture run was 65/66 because failed terminal results dropped the error detail. The final results above supersede those attempts. No broad tests/build/native bundle or real-runtime acceptance was run.

## Parent wiring and pending conditions

Already integrated by the parent: unknown/hidden/non-tool Ollama selection fails shared preflight; the harness catalog exposes `supportedVersions: ['1.18.35']`. The current owned bridge also performs a fresh Ollama check before prompting.

Remaining shared snippets are in [adapter integration notes](../../adapter-protocols.md): show `requestBody` in the Jev confirmation preview instead of only `payload`, remove unsupported urgency wording, and explain the LM Studio runtime block in shared preflight/catalog. Enforcement is already in owned source; UI integration was intentionally not edited across ownership boundaries. Graphify/settings configuration requires no protocol coupling.

Pending real acceptance, to be undertaken only in an independently authorized future task:

- A real installed **OpenCode 1.18.35** and existing `rg`, using already-installed tool-capable Ollama models: startup/isolation/offline dependency behavior, actual discovery/event sequence, one turn, permission/question approve and reject, failure delivery, pause/resume and SSE loss. Fixtures do not prove the real binary or dependency cache works.
- Actual Ollama daemon identity/remote metadata and direct cloud identity/show contracts. Public catalogs alone are insufficient; cloud models remain blocked if authentication or tools cannot be verified. No model pull or charge is implied by this checkpoint.
- API provider model availability/tool support and any metered acceptance require the existing explicit cost path. The bundled SDK mapping is source-verified, not proof of a successful provider call or included quota.
- A separately authorized TypeSafe request is needed to prove real System One acceptance. Current code must retain the exact preview/host/hash/human confirmations, typed-response validation and advisory-only authority boundaries.

The checkpoint is ready for the parent's review/promotion/rebundle. It remains a protocol-repaired implementation with synthetic checks, not a completed product or live provider certification.
