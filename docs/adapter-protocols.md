<!-- SPDX-License-Identifier: Apache-2.0 -->
# Adapter integration notes

See [runtime status and primary sources](harnesses.md) for the authoritative protocol details. Source inspection and synthetic fixtures are distinct from a live vendor check.

The changes in this task are confined to OpenCode/Ollama/Jev adapters, their tests/fixtures and these documents. The parent owns shared preflight, routes and UI. The parent already integrated unknown-capability Ollama preflight and exact `supportedVersions` in the harness catalog. Those snippets are retained below as the integration contract, not outstanding work.

```ts
// packages/core/src/preflight.ts: alongside the existing tools === false check.
// Unknown Ollama capability/authentication must block even a manually typed model.
if ((agent.config.provider === 'ollama' || agent.config.provider === 'ollama-cloud') &&
    (!info || info.hidden || info.tools !== true)) {
  add({ id: 'tools', label: 'Tool calling', status: 'fail',
    message: 'Ollama model, route, authentication or tool support is unverified; re-probe.' });
}
```

The owned bridge also performs this check against fresh Ollama metadata before a prompt. Neither check grants permission or triggers inference.

```ts
// packages/daemon/src/server/harnessRoutes.ts: report exact accepted patches.
import { SUPPORTED_VERSIONS } from '../adapters/agents/opencode/protocol.ts';
// Alongside supportedSeries and protocol in the OpenCode catalog entry:
// supportedVersions: [...SUPPORTED_VERSIONS]
// Optional wording refinement; current catalog correctly says live acceptance is pending:
// verification: 'Official 1.18.35 SDK/source checked; synthetic loopback contracts tested; live check pending.'
```

Remaining shared changes (provided as snippets; no shared source was edited):

```ts
// packages/core/src/preflight.ts: fail early with the same owned runtime restriction.
if (agent.config.adapter === 'opencode-server' && agent.config.provider === 'lmstudio') {
  add({ id: 'tools', label: 'Tool calling', status: 'fail',
    message: 'LM Studio tool capabilities are unverified for OpenCode; no coding prompt can run.' });
}
// packages/daemon/src/server/harnessRoutes.ts: add to OpenCode LIMITATIONS:
// 'LM Studio is blocked until its tool capability contract is verified.'
```

The owned `providerSetup` already refuses LM Studio before config/server startup. Its previous unconditional `tool_call: true` was not evidence of capability. Parent preflight/catalog changes improve the earlier explanation but are not needed to enforce the runtime block. No other LM Studio harness is being verified by this task.

Jev previews return `requestBody`, the exact bounded System One envelope whose hash the human confirms. Existing `payload` remains the redacted evidence preview. The current parent UI displays `payload`; use the returned envelope instead:

```tsx
// packages/web/src/components/Jev.tsx: add to interface Preview:
// requestBody: unknown;
// Replace JSON.stringify(preview.payload, null, 2) inside the existing <pre> with:
JSON.stringify(preview.requestBody, null, 2)
// Settings prose: Jev suggests one answer; remove the unsupported urgency claim.
```

No graph/settings protocol coupling is needed. Jev reads the discriminated settings action `{kind: 'settings', repo, hash}` as evidence only. For final checks, exact paths and pending acceptance conditions, see [the runtime handoff](verification/delegation/runtime-adapters-handoff.md).
