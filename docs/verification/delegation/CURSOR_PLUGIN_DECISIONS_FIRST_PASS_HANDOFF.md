# Cursor plugin-decisions handoff

**Isolated checkout:** `/private/tmp/one-connect-parallel-20261007/plugin-decisions`  
**Primary reference:** `/Users/krishkumarsah/Docs/Projects/Interface` (not modified)  
**Baseline snapshot:** `4349896e1f932b615d33666f98ef655df0a9b6b7`  
**Status:** Per-action MCP tool approvals implemented on fixture evidence. Not integrated into primary.

## Summary

MCP connection **activation** now approves only the reviewed command, tool inventory and read roots as *eligible*. It does not start a process or grant blanket execution. Every tool invocation creates a human **Decision** bound to exact connector ID, config hash, project identity, command/argv, tool name, canonical argument bytes, requester/run context, expiration and payload hash. Execution happens only after a second human confirmation through the specialized executor (`connector-tool:` KV binding + `resolveToolCall`); generic `answer()` cannot bypass it.

## Changed files

| Path | Role |
|------|------|
| `packages/daemon/src/connectorToolActions.ts` | **New.** Request / resolve / execute / poll for per-call MCP tool actions |
| `packages/daemon/src/connectors.ts` | Inventory activation wording; delegate tool calls; `revalidateToolBinding`; list tool-call Decisions |
| `packages/daemon/src/decisions.ts` | Route `connector-tool:` through `respond`; block generic `answer()` |
| `packages/daemon/src/server/libraryRoutes.ts` | `POST …/tools/:tool` → request; `GET …/tool-requests/:id` → poll |
| `packages/daemon/src/mcpBridge.ts` | `call_connector_tool` requests only; `get_connector_tool_result` polls |
| `packages/daemon/src/mcp/server.ts` | Register `get_connector_tool_result`; update tool descriptions |
| `packages/core/src/entities.ts` | `ConnectorToolAction` decision binding type |
| `packages/core/src/events.ts` | `connector.tool_requested` / `denied` / `executed` events |
| `packages/core/src/connectors.ts` | MCP descriptor copy: inventory vs per-call |
| `packages/core/src/libraryReducer.ts`, `reducer.ts` | Pass-through for new connector tool events |
| `packages/web/src/pages/Connectors.tsx` | Request action UI, status, Decisions link, polling |
| `packages/daemon/test/connector-tool-actions.test.ts` | **New.** Focused daemon safety tests |
| `packages/daemon/test/connectors.test.ts` | MCP test requires activation + per-call approval |
| `packages/daemon/test/fixtures/fake-mcp-tools.mjs` | `called:echo` marker on tool invocation |
| `packages/web/test/connectors-mcp.test.tsx` | **New.** Request → Decision link → poll result UI |

### Shared patches (other workers)

- **`packages/daemon/src/decisions.ts`** — `respond()` adds `connector-tool:` branch; `answer()` blocks `connector-tool:` prefix (same pattern as `connector:decision:`).
- **`packages/core/src/entities.ts`** — `DecisionAction` union extended with `ConnectorToolAction` (typed hash binding).

No changes to Skills `libraryRoutes` section, workflows/Team, One Answer/Designer, native, billing, or tracker import.

## Implemented behavior

1. **Activation (inventory)** — unchanged flow (`requestActivation` + `resolve`), updated consent text: eligible inventory only; each call still needs its own Decision.
2. **Request** — `requestToolCall` / `POST /api/connectors/:id/tools/:tool` validates JSON object args (size, depth, prototype keys, denylist secrets), creates irreversible Decision with evidence (command, roots, exact args, unmediated-program warning). No child process.
3. **Approve** — human-only via `decisions.respond` → `resolveToolCall`; fresh nonce required (`confirmOptions: ['approve']`). Binding consumed atomically before spawn; in-flight guard prevents duplicate execution.
4. **Execute** — revalidates connector/project/inventory/run after every MCP await (`connectGate` hook for tests); minimal argv-only stdio env preserved; transport closed on failure; bounded redacted output.
5. **Agents** — `call_connector_tool` returns `{ pending, requestId, decisionId }`; `get_connector_tool_result` polls durably; run-scoped auth rejects foreign runs.
6. **UI** — “Request action”, pending/running/succeeded/error/uncertain/denied status, link to Decisions, poll without overwriting on late/foreign responses; uncertain reopen does not resubmit.

## Verification (actual)

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
# → 4 files, 24 tests passed
```

Fixture evidence includes: no `started`/`called:` lines before human approval; stale config/disabled connector/revocation during `connectGate` → zero calls; duplicate concurrent resolves → one call; secrets redacted; pending survives restart; real `decisions.respond` routing.

**Sandbox note:** Initial vitest runs inside the worker sandbox failed with `EPERM` on `node_modules/.vite-temp`; re-run with full permissions succeeded. Coordinator may use the same PATH + commands above.

## Unresolved prerequisites

- Coordinator merge into primary `/Users/krishkumarsah/Docs/Projects/Interface` (explicitly out of scope here).
- Cross-worker integration with Skills `libraryRoutes` section (owned by another Cursor worker).
- Live plugin/provider smoke (explicitly forbidden; fixtures only).

## Limitations

- Per-call requests are stored in daemon KV (`connector-tool-req:*`, `connector-tool:*`); not mirrored in `ControlState` reducer (intentionally lean; poll reads KV).
- Timeout during execution marks `uncertain`; no automatic replay (by design).
- `toolsForAgents()` still lists inventory-approved tools; agents must poll after `call_connector_tool`.
- Jev cannot evaluate `connector_tool` decision actions (unsupported action kind; advisory only).

## Safety boundary (documented)

- Activation ≠ execution. Tool names and MCP `readOnly` annotations are untrusted and do not waive approval.
- Protocol read roots and argv-only launcher are **not** an OS sandbox; consent copy states unmediated local program behavior candidly.
- Human phone/dashboard uses existing prepare + nonce protocol; agents/system/Jev cannot approve tool calls.
