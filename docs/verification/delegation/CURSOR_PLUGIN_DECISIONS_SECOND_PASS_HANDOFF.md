# Cursor plugin-decisions handoff

**Isolated checkout:** `/private/tmp/one-connect-parallel-20261007/plugin-decisions`  
**Primary reference:** `/Users/krishkumarsah/Docs/Projects/Interface` (not modified)  
**Baseline snapshot:** `4349896e1f932b615d33666f98ef655df0a9b6b7`  
**Status:** Second-pass repairs on fixture evidence. Not integrated into primary.

## Summary

MCP connection **activation** approves only the reviewed command, tool inventory and read roots as *eligible*. It does not start a process or grant blanket execution. Every tool invocation creates a human **Decision** bound to exact connector ID, config hash, project identity, command/argv, tool name, canonical argument bytes, requester/run/issue context, expiration and payload hash. Execution happens only after a second human confirmation through the specialized executor (`connector-tool:` KV binding + `resolveToolCall`); generic `answer()` cannot bypass it.

## Second-pass repairs (this freeze)

| Finding | Repair |
|---------|--------|
| `resolve()` wrote `running` outside the approval transaction | `answerAtomic` now commits consumed binding, `running` request state and `connector.tool_execution_started` in one SQLite transaction before any async work |
| Restart left `running` forever | `recoverInterrupted()` marks in-flight `running` requests `uncertain` on daemon start; no auto-replay |
| `assertBinding()` omitted requester/run/issue/expiry and canonical integrity | Action hash binds all request fields; `assertBinding` recomputes hash, verifies decision action, canonical bytes vs hash, active run/agent/issue |
| Denylist only at request time | `recheckDenied()` before spawn and after every MCP await; `get()` re-redacts with current denylist |
| Weak JSON validation | Rejects cycles, functions, undefined, non-finite numbers, exotic objects, unsafe keys; caps UTF-8 bytes |
| Connection loss treated as safe replay | Tracks `invocationStarted`; post-invocation errors are `uncertain`; pre-invocation failures stay honest `error` |
| UI race on polls/requests | Generation + active request ID guards; stale polls cannot overwrite; succeeded output hidden when args change |
| Tests claimed coverage they lacked | Added restart-after-consume, tampered/changed arguments, nonce-free rejection, denial/expiry, denylist-after-request, tool-error vs uncertain, run scoping, MCP routing, UI deferred-response tests |

## Changed files

| Path | Role |
|------|------|
| `packages/daemon/src/connectorToolActions.ts` | Atomic resolve, binding integrity, JSON validation, denylist recheck, restart recovery, invocation uncertainty |
| `packages/daemon/src/connectors.ts` | Inventory activation wording; delegate tool calls; `revalidateToolBinding` |
| `packages/daemon/src/decisions.ts` | Route `connector-tool:` through `respond`; block generic `answer()` |
| `packages/daemon/src/server/libraryRoutes.ts` | `POST …/tools/:tool` → request; `GET …/tool-requests/:id` → poll |
| `packages/daemon/src/mcpBridge.ts` | `call_connector_tool` requests only; `get_connector_tool_result` polls |
| `packages/daemon/src/mcp/server.ts` | Register `get_connector_tool_result`; update tool descriptions |
| `packages/daemon/src/store/eventStore.ts` | `kvKeys(prefix)` for restart recovery scan |
| `packages/core/src/entities.ts` | `ConnectorToolAction` decision binding type |
| `packages/core/src/events.ts` | `connector.tool_requested` / `denied` / `execution_started` / `executed` |
| `packages/core/src/connectors.ts` | MCP descriptor copy: inventory vs per-call |
| `packages/core/src/libraryReducer.ts`, `reducer.ts` | Pass-through for connector tool events |
| `packages/web/src/pages/Connectors.tsx` | Request action UI, generation/request guards, status, Decisions link, polling |
| `packages/daemon/test/connector-tool-actions.test.ts` | **New/expanded.** 15 focused daemon safety tests |
| `packages/daemon/test/connectors.test.ts` | MCP test requires activation + per-call approval |
| `packages/daemon/test/fixtures/fake-mcp-tools.mjs` | `called:echo` / `called:fail` markers |
| `packages/web/test/connectors-mcp.test.tsx` | **New.** 3 UI tests (request→Decision→poll, changed args, stale request id) |

### Shared patches (other workers)

- **`packages/daemon/src/decisions.ts`** — `respond()` adds `connector-tool:` branch; `answer()` blocks `connector-tool:` prefix.
- **`packages/core/src/entities.ts`** — `DecisionAction` union extended with `ConnectorToolAction`.
- **`packages/core/src/events.ts`** — `connector.tool_execution_started` event (additive).

No changes to Skills `libraryRoutes` section, workflows/Team, One Answer/Designer, native, billing, or tracker import.

## Implemented behavior

1. **Activation (inventory)** — unchanged flow (`requestActivation` + `resolve`), updated consent text: eligible inventory only; each call still needs its own Decision.
2. **Request** — validates real JSON object args (UTF-8 byte size, depth, prototype keys, cycles, exotic types, denylist secrets), creates irreversible Decision with evidence (command, roots, exact args, unmediated-program warning). No child process.
3. **Approve** — human-only via `decisions.respond` → `resolveToolCall`; fresh nonce required (`confirmOptions: ['approve']`). Binding consumed atomically with `running` state and execution-start event before spawn; in-flight guard prevents duplicate execution.
4. **Execute** — revalidates connector/project/inventory/run/binding/denylist after every MCP await; minimal argv-only stdio env preserved; transport closed on all paths; bounded redacted output; post-invocation interruption → `uncertain`.
5. **Restart** — pending unconsumed requests survive if bindings still valid; `running` → `uncertain`; never replayed.
6. **Agents** — `call_connector_tool` returns `{ pending, requestId, decisionId }`; `get_connector_tool_result` polls durably; run-scoped auth rejects foreign runs and ended runs at approval.
7. **UI** — “Request action”, pending/running/succeeded/error/uncertain/denied status, link to Decisions, generation/request-id poll guards, scoped polling errors; succeeded output not shown under edited args; uncertain reopen does not resubmit.

## Verification (actual, second pass)

Node **v24.21.0** prepended to PATH. All commands run in the isolated checkout.

```bash
export PATH="/Users/krishkumarsah/Docs/Projects/Interface/.desktop-cache/node-v24.21.0-darwin-arm64/bin:$PATH"
cd /private/tmp/one-connect-parallel-20261007/plugin-decisions

pnpm typecheck          # @acc/core, @acc/daemon, @acc/web — passed
pnpm build              # web production build — passed
pnpm spdx:check         # 295 files Apache-2.0 — passed
node --experimental-strip-types -e "import('./packages/daemon/src/connectorToolActions.ts').then(() => console.log('node24 import ok'))"
# → node24 import ok

pnpm exec vitest run \
  packages/daemon/test/connectors.test.ts \
  packages/daemon/test/connector-tool-actions.test.ts \
  packages/daemon/test/decision-actions.test.ts \
  packages/web/test/connectors-mcp.test.tsx
# → 4 files, 34 tests passed
```

### Fixture evidence (second pass)

- No `started`/`called:` before human approval; nonce-free `approve` rejected with 428
- Tampered canonical args and edited connector config/disabled/revocation during `connectGate` → zero calls
- Denial and expired bindings → zero calls
- Denylist added after request → zero calls at approve
- Exact approval executes once; concurrent duplicate resolves → one call
- Restart before consume → pending survives; restart after consume/`running` → `uncertain`, no replay
- Tool-reported error → `error`; connection loss after invocation started → `uncertain`
- Run-scoped poll rejects foreign run; ended run rejected at approval
- MCP `call_connector_tool` / `get_connector_tool_result` routing with live run token
- Secrets redacted on write and on every read; cyclic/deep/UTF-8-byte fixtures rejected
- UI: request→Decision link→poll; changed args hide stale output; late poll for wrong request id ignored

**Sandbox note:** vitest needs full permissions (`EPERM` on `node_modules/.vite-temp` in sandbox). Coordinator may re-run with the commands above.

## First-pass handoff (preserved)

The first freeze claimed 24 tests and listed similar behavior before second-pass repairs. Gaps addressed in this pass included: non-atomic `running` write, missing restart-after-consume tests, binding hash omitting run/requester fields, no canonical-byte verification, denylist not rechecked after request, weak JSON validation, connection loss not marked uncertain, UI poll races, and a mislabeled “edited arguments” test (connector config only). First-pass evidence is superseded by the 34-test run above; do not treat the first-pass “all verified” claim as complete.

## Unresolved prerequisites

- Coordinator merge into primary `/Users/krishkumarsah/Docs/Projects/Interface` (explicitly out of scope here).
- Cross-worker integration with Skills `libraryRoutes` section (owned by another Cursor worker).
- Live plugin/provider smoke (explicitly forbidden; fixtures only).

## Limitations

- Per-call requests are stored in daemon KV (`connector-tool-req:*`, `connector-tool:*`); not mirrored in `ControlState` reducer (intentionally lean; poll reads KV).
- Timeout during execution marks `uncertain`; no automatic replay (by design).
- `toolsForAgents()` still lists inventory-approved tools; agents must poll after `call_connector_tool`.
- Jev cannot evaluate `connector_tool` decision actions (unsupported action kind; advisory only).
- Foreign-run MCP poll rejection is covered; full two-run concurrent MCP poll race not fixture-tested separately from direct API scoping.
- `recoverInterrupted()` scans KV on `ConnectorToolActions` construction only (daemon start path).

## Safety boundary (documented)

- Activation ≠ execution. Tool names and MCP `readOnly` annotations are untrusted and do not waive approval.
- Protocol read roots and argv-only launcher are **not** an OS sandbox; consent copy states unmediated local program behavior candidly.
- Human phone/dashboard uses existing prepare + nonce protocol; agents/system/Jev cannot approve tool calls.
