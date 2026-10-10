# Local plugin tools

One Connect connects to a local MCP server through its stdio protocol. Install and review the server yourself; One Connect does not download a server, extract another app's login or supply API keys. Each project has its own connection configuration and results.

## Two separate approvals

In **Connectors**, add a draft with an exact executable path, separate arguments, allowed tool names and read roots. Saving the draft contacts nothing. Request its inventory approval and review it in **Decisions**. Approving makes that exact configuration eligible; it does not start the server or authorize later tool calls.

To use an eligible tool, choose its name, enter JSON arguments and select **Request action**. This creates a new Decision for one exact call. Review the command, arguments, roots, project configuration, requester, issue/run/assignment when present, expiry and program-access warning. Approval requires a fresh second confirmation. Denial starts nothing. Agents, Jev and system recommendations cannot approve.

The approved call starts a fresh owned server process, checks its tool inventory and invokes the reviewed tool once. Polling its receipt never starts it again. The standard Decisions inbox supports the same confirmation from an authorized phone browser; phone access and scopes must be set up separately.

## What the receipt means

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for the owner; no process has started. |
| `running` | Approval has been consumed and execution is underway. |
| `succeeded` | The server returned a tool result without an error, with the authorization still valid. This is a recorded protocol result, not proof of deployment or acceptance. |
| `error` | The tool reported an error, or execution failed before invocation. Inspect the recorded details. |
| `uncertain` | Invocation may have happened, but connection loss, timeout, interruption or changed authorization prevents a trustworthy outcome. Inspect the external state before requesting another action. |
| `denied` | The owner refused the call. |
| `expired` / `invalidated` | An unexecuted request expired or its original project, configuration or requester is no longer valid. Request a new reviewed action if still needed. |

**Connectors** shows the current receipt and bounded returned text. Output is untrusted data. A changed input or configuration clears the old receipt from that form; it does not relabel an old result with new arguments. Recorded Decisions and audit events remain available.

## Access and cost boundaries

Read roots are MCP protocol hints. They are **not an operating-system sandbox**. The executable runs with the current user's permissions and can reach files or networks outside those roots. Tool names and `readOnly` annotations cannot establish that a call is harmless. Only approve a program you trust and an action you intend to perform.

External billing is controlled by that program and is unknown to One Connect. A connector's displayed unknown cost is not a guarantee of included subscription usage. Paid agent fallbacks remain off; plugin approval does not change an agent's billing configuration. Review the server's own terms and billing before authorizing it.

The launcher uses separate executable/argv fields, an isolated plugin home and a minimal environment. It does not expand a shell command or inherit the owner's API keys. Arguments must be bounded, ordinary JSON: nested arrays and objects work; cycles, getters, proxies, exotic values, unsafe keys, excessive nesting and oversized UTF-8 payloads are rejected. Credential patterns and the project's current denylist are checked before execution, around asynchronous boundaries and when displaying results. This does not make an arbitrary executable safe.

## Revocation, stopping and restart

Changing the command, inventory, roots, project binding or activation approval prevents an old request from running. A changed denylist or ended/reassigned requesting run also invalidates it. The owner can still deny an intact pending request after its connector is disabled or changed. A response arriving after revocation during invocation is uncertain, rather than a passing result.

Stopping the requesting run closes that run's owned active plugin calls. The kill switch closes all active calls owned by that project engine, including human-created calls. Project shutdown closes its transports. These actions preserve other projects and processes that One Connect does not own. Stopping cannot undo an external action that already occurred.

On restart, unexecuted requests remain subject to their original bindings and expiry and require a fresh confirmation. Consumed/running calls whose completion was not recorded become uncertain and are never replayed automatically.

## Agent access

Run-authenticated agents use `list_connector_tools`, `call_connector_tool` and `get_connector_tool_result`. The request is bound to that exact agent, active run, assignment and issue. Another run cannot retrieve its result. The owner can inspect the durable receipt after its requesting run finishes. Polling alone is not evidence of completion.

The verification suite uses local fake MCP child processes with actual start/call/exit markers, authenticated HTTP and run MCP routing. It proves the supervisor and approval protocol behavior. It does not establish compatibility or acceptance for an untested real plugin or provider.
