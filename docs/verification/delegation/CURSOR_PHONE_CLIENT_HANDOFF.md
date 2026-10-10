<!-- SPDX-License-Identifier: Apache-2.0 -->
# Cursor phone client handoff — browser identity and live transcript (second pass)

Date: 2026-10-07. Work directory: `/private/tmp/one-connect-parallel-20261007/phone-client`.
**Owned web client changes are frozen here. The whole product goal remains incomplete.**

## Boundaries

Edited only owned web modules (`remote.ts`, `api.ts`, `store.ts`, `NotificationInbox.tsx`,
`Decisions.tsx`, `Phone.tsx`, `Remote.tsx`, focused tests, this handoff).
No primary checkout commit, native bundle, App/PhoneShell source edits, backend, daemon, release,
or outbound integration was performed. Parent-owned files below are **supplied snippets only**.

## Exact changed paths

| Path | SHA-256 |
|------|---------|
| `packages/web/src/lib/remote.ts` | `beb453cc276c8b4dc10509f5a17b7e482003f104a2251313bde44df2fdbbafcb` |
| `packages/web/src/lib/api.ts` | `9964667055bed04bf80ddbf9a476c66fa2531a666ad13b64e0bf1f2ad94abf90` |
| `packages/web/src/lib/store.ts` | `0fdd49e028439e0316318637a962a4bc26972ae347684f2a2c65f0b37a12d7e1` |
| `packages/web/src/components/NotificationInbox.tsx` | `a423eb01c3f448eb7018c333b973a0ebd751e1ef1dae791298bd6abfd62eb270` |
| `packages/web/src/pages/Decisions.tsx` | `4f6ff3e2ded65dc48d0a45e9e3485c31e3a33dd7c320c6b0f542b1a59ad18096` |
| `packages/web/src/pages/Phone.tsx` | `ea8c38e5f41af4b627fab72bd33a14a12f2526d505f098cf9f67bda9d19cdebe` |
| `packages/web/src/pages/Remote.tsx` | `dc7efe7855c28a56409f1929800c5c2e706f81b382112f4e4130ebaa5f3420ab` |
| `packages/web/test/phone-identity.test.tsx` | `85b4893aae478cf9d209d86f9f6f815eb83e6e835fc8ae726988632cff9b3d9b` |
| `packages/web/test/phone.test.tsx` | `da0dafb5bfadc4bf6036a6e41cf8c0c08f6cdf8d67b4c5cae73c23cc5ff0832d` |

## Second-pass review fixes implemented

### 1. Native Mac identity (`remote.ts`)

- Browser mode continues exact `403 { error: 'Not a phone session' }` at `/api/remote/session`.
- Native Mac uses `desktopRequest('/api/auth/identity', {})` and validates `{ mode: 'local', project: string }`.
- Never infers local from `isDesktop` alone or a failed bridge response.
- Stale bridge responses discarded via `identityGen` race guards.

### 2. Null session authority (`remote.ts`)

- `setRemoteSession(null)` defaults to `unauthorized`, not `local`.
- Paired `200` responses validated for full session shape before granting access.
- Malformed JSON classified as `unauthorized`.

### 3. Async identity race protection (`remote.ts`)

- `identityGen` incremented on clear/revoke/replace; stale async results discarded.
- In-flight deduplication keyed to current generation; settled loads allow refresh.
- Scope/id/project changes notify authority listeners and invalidate downstream state.
- Offline→unauthorized and scope narrowing clear cached mutation authority.

### 4. Complete project state drop (`store.ts`)

- `dropProjectState()` clears `state`, meta, run caches, live previews and conn on authority loss.
- Socket `onopen` awaits identity and blocks `hello`/subscriptions until `local` or `paired`.
- Unauthorized/offline/checking closes socket without marking `conn='live'`.
- `authGen` guards socket callbacks; old messages cannot repopulate after revocation.
- Project switch bumps both `gen` and `authGen`.

### 5. API mutation gates (`api.ts`)

- `hasMutationAuthority()` blocks browser/desktop mutations before transport when unauthorized.
- Pairing endpoint (`/api/remote/pairings`) intentionally exempt from general mutation gate.
- Native IPC transport loss uses uncertain-receipt wording for mutating calls.

### 6. UI safe states (`Remote.tsx`, `NotificationInbox.tsx`)

- Mac management mounts **only** in proven `local` mode.
- `checking`, `unauthorized`, and `offline` (without cached session) show explicit safe banners.
- Notification **Mark read** gated by `canMutate(session, 'read')`.

### 7. Decision confirmation binding (`Decisions.tsx`)

- Clears on offline, mode change, `identityRevision`, scope key, decision/closure/action-hash change, expiry.
- Deferred `prepare` responses discarded when binding changes (`prepareGen` guard).
- Removed trivial `useMemo` around action hash.

## Parent integration snippets (not applied)

### `App.tsx` — use `mode` and `canMutate` for top-bar kill switch

```ts
import { can, canMutate, useRemoteSession } from './lib/remote';

// inside App():
const { session, checked: remoteChecked, mode } = useRemoteSession();

// Kill switch button:
disabled={busy || !online || mode === 'offline' || mode === 'checking' || (Boolean(session) && kill)}
// ...
onClick={() => {
  if (!canMutate(session, 'kill_switch')) return;
  if (kill || window.confirm(`Stop ALL agent runs…`)) void run(() => post('/api/kill-switch', { engaged: !kill }));
}}

// Splash while checking (non-localhost phones):
if (!isDesktop && mode === 'checking' && !remoteChecked) return <div className="splash empty" role="status">Checking this browser's project access…</div>;
```

### `PhoneShell.tsx` — identity-aware tab bar

```ts
import { can, useRemoteSession } from '../lib/remote';

const { session, mode } = useRemoteSession();
const local = mode === 'local';
const available = (to: string) => local || (session && (to === '/decisions' ? can(session, 'decisions') : ['/', '/phone', '/reports'].includes(to) && can(session, 'read')));
```

### Parent patch 1 (`packages/daemon/src/server/http.ts`)

Still required for exact WS expiry enforcement before send — see
`docs/verification/delegation/PHONE-resumed-handoff.md` patch 1. Owned client handles `4001`
on close, drops full project state, and refreshes identity before reconnect subscriptions.

## Commands and results

Runtime: `/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` **v24.19.0**.

```sh
# cwd: /private/tmp/one-connect-parallel-20261007/phone-client
node node_modules/vitest/vitest.mjs run packages/web/test/phone-identity.test.tsx packages/web/test/phone.test.tsx
# exit 0 — 50 tests (32 identity/live + 18 existing phone)

node node_modules/typescript/bin/tsc -p packages/web/tsconfig.json --pretty false
# exit 0

# cwd: packages/web
node node_modules/vite/bin/vite.js build
# exit 0 — production bundle written to packages/web/dist (ignored)
```

## Test coverage (owned)

| Area | Covered |
|------|---------|
| Initial `checking` → `local` (403) or `paired` (200) | yes |
| Malformed paired 200 → `unauthorized` | yes |
| `setRemoteSession(null)` → `unauthorized` | yes |
| Revision emission on repeated checks | yes |
| Offline preserves display identity, blocks `canMutate` | yes |
| Revocation clears cached grants | yes |
| Stale async identity after clear/revoke | yes |
| Scope narrowing invalidates authority | yes |
| Native `/api/auth/identity` local proof (mocked bridge) | yes |
| Native malformed/failed bridge → `unauthorized` | yes |
| API uncertain receipt; pre-transport mutation block | yes |
| Pairing endpoint allowed without general authority | yes |
| Notification destinations + mark-read gate | yes |
| Live preview retirement vs older replay | yes |
| Authority loss clears preview and project state | yes |
| Decision confirmation: offline, deferred prepare, hash change | yes |
| Remote: local-only management; checking/unauthorized safe states | yes |
| Phone offline banner | yes |

## Implemented vs missing matrix

| Item | Status |
|------|--------|
| Explicit browser identity modes | implemented, tested |
| Native Mac identity via daemon bridge | implemented, mocked-bridge tested |
| Race-safe identity refresh | implemented, tested |
| Socket gated until authority proven | implemented, unit-level |
| Full project state drop on auth loss | implemented, tested |
| Uncertain mutation receipt wording | implemented, tested |
| Decision confirmation invalidation | implemented, tested |
| Scope-aware notification destinations | implemented, tested |
| Real Safari/iOS PWA navigation/input | **not verified** |
| Real Chrome/Android installed PWA | **not verified** |
| Live Tailscale Serve + secure cookies on phone | **not verified** |
| Parent WS patch 1 exact-expiry with real sockets | **not verified here** |
| Native Mac bundle/device acceptance | **parent** |
| Full monorepo daemon/core 93+9 suite | **not re-run** |
| Web Push, macOS banners, production release | **not verified** |

This checkpoint proves owned browser modules and rendered controls against local/injected fixtures only.
Do not describe it as a finished whole product or live integration release.
