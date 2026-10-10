<!-- SPDX-License-Identifier: Apache-2.0 -->
# Cursor phone client handoff — browser identity and live transcript

Date: 2026-10-07. Work directory: `/private/tmp/one-connect-parallel-20261007/phone-client`.
**Owned web client changes are frozen here. The whole product goal remains incomplete.**

## Boundaries

Edited only owned web modules (`remote.ts`, `api.ts`, `store.ts`, `NotificationInbox.tsx`,
`Decisions.tsx`, frozen `Phone.tsx` / `Remote.tsx` adaptations, focused tests, this handoff).
No primary checkout commit, native bundle, App/PhoneShell source edits, backend, daemon, release,
or outbound integration was performed. Parent-owned files below are **supplied snippets only**.

## Exact changed paths

| Path | SHA-256 |
|------|---------|
| `packages/web/src/lib/remote.ts` | `a1a7a639900ff96fb9201afda74a7fad64cd326e1dece79c1b381479e5cfd02e` |
| `packages/web/src/lib/api.ts` | `75946ee2a475c07417b133d07913ac1adbc60e1aa49fcba852b37f65707f9fee` |
| `packages/web/src/lib/store.ts` | `7398741d5b7ad9b0c08691c7b52f074088d83776c3aca6b4983283f5d76af9ce` |
| `packages/web/src/components/NotificationInbox.tsx` | `2383ef31493cf7731f096eae2e9be5b05546436e18d894cd6c326d6c4f7acb0d` |
| `packages/web/src/pages/Decisions.tsx` | `8b51445f79b437f10383b35db54b1fd7069253366a6b63c272855abc62bc9ef7` |
| `packages/web/src/pages/Phone.tsx` | `ea8c38e5f41af4b627fab72bd33a14a12f2526d505f098cf9f67bda9d19cdebe` |
| `packages/web/src/pages/Remote.tsx` | `0303839e6dc5210a550f6fe79505893f6262f476cc4ddc6dab2ac31219e1315a` |
| `packages/web/test/phone-identity.test.tsx` | `74b41b739f8d5d3bb76a1fe3abca124ffad5f0554eeca4f42fead48778ead1e2` |

## What was implemented

### Browser identity (`remote.ts`)

- Explicit `checking | local | paired | unauthorized | offline` modes with reactive `revision` snapshot.
- Only exact `403 { error: 'Not a phone session' }` proves local mode; null session alone does not.
- Offline fetch loss preserves `displaySessionCache` for factual labels/routing only; `canMutate` stays false.
- Revocation/unauthorized clears cached grants; they are not restored from storage.
- `can` / `canMutate` separate navigation display from mutation authority.
- `clearPhoneAuthority` + `onPhoneAuthorityCleared` hook; no credentials in storage/service workers.

### API (`api.ts`)

- Mutating transport failures: `Could not confirm the result. Receipt is unknown…` (never “Nothing was sent”).
- No automatic retry; `401/403/429` responses call `loadRemoteSession()` once.

### Live store (`store.ts`)

- Socket `4001` → `clearPhoneCaches()` (authority + run/live caches) then reauthentication.
- Ordinary reconnect awaits `loadRemoteSession()` before `hello` / `subscribe_run`.
- `ingest` retires assistant preview only when final `t.message` timestamp ≥ preview `at`.
- Authority loss and project switch clear preview/cache.

### UI

- `NotificationInbox`: scope-aware `notificationDestination`; no phone links to local-only routes.
- `DecisionCard`: clears prepared confirmation on offline, auth loss, decision/closure/action-hash change, expiry.
- `Phone` / `Remote`: identity banners; `canMutate` for kill switch; paired vs local vs offline display.

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

// Route guard already uses can(session, scope); keep phonePageAvailable unchanged.
// Splash while checking (non-localhost phones):
if (!isDesktop && mode === 'checking' && !remoteChecked) return <div className="splash empty" role="status">Checking this browser's project access…</div>;
```

### `PhoneShell.tsx` — identity-aware tab bar

```ts
import { can, useRemoteSession } from '../lib/remote';

const { session, mode } = useRemoteSession();
const local = mode === 'local';
const available = (to: string) => local || (session && (to === '/decisions' ? can(session, 'decisions') : ['/', '/phone', '/reports'].includes(to) && can(session, 'read')));
const runs = session && can(session, 'transcript') ? … : [];
// Hide /team and Mac-only MENU entries when mode === 'paired' (parent already filters forbidden routes).
```

### Parent patch 1 (`packages/daemon/src/server/http.ts`)

Still required for exact WS expiry enforcement before send — see
`docs/verification/delegation/PHONE-resumed-handoff.md` patch 1. Owned client now handles `4001`
on close and refreshes identity on reconnect.

## Commands and results

Runtime: `/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` **v24.19.0**.

```sh
# cwd: /private/tmp/one-connect-parallel-20261007/phone-client
node node_modules/vitest/vitest.mjs run packages/web/test/phone-identity.test.tsx packages/web/test/phone.test.tsx
# exit 0 — 34 tests (16 new identity/live + 18 existing phone)

node node_modules/typescript/bin/tsc -p packages/web/tsconfig.json --pretty false
# exit 0

# cwd: packages/web
node node_modules/vite/bin/vite.js build
# exit 0 — production bundle written to packages/web/dist (ignored)
```

## Test coverage (owned)

- Initial `checking` → `local` (403) or `paired` (200)
- `unauthorized` after pairing clears cached grants
- Offline preserves display identity, blocks `canMutate`
- API uncertain receipt wording; identity refresh on 401 without mutation retry
- Notification destinations: scoped paired, local agent console, hidden when checking
- Live preview retirement vs older history replay
- Authority loss clears preview cache
- Decision confirmation cleared on offline
- Phone offline banner; Remote Mac management only in `local` mode

## Honest gaps — not proven here

- Real Safari/iOS or Chrome/Android installed PWA navigation and input controls
- Live Tailscale Serve reachability, secure cookies, Host/Origin on a real phone
- Shared WS handler patch 1 exact-expiry injection acceptance with real sockets
- Web Push, macOS banners, provider keys, production release connectivity
- Full monorepo suite (daemon/core 93+9 checkpoint from prior handoff not re-run here)
- End-to-end paired phone answering Docker/connector Decisions after parent patches 2–3

This checkpoint proves owned browser modules and rendered controls against local/injected fixtures only.
Do not describe it as a finished whole product or live integration release.
