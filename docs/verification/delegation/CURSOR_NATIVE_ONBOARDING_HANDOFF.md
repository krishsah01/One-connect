# Cursor native onboarding handoff (second pass)

Workspace: `/private/tmp/one-connect-parallel-20261007/native-onboarding`
Baseline: `d19277b125dc542dcd29e293880324d87aa8383a`
Reference source (read-only): `/Users/krishkumarsah/Docs/Projects/Interface`
Model harness: official Cursor subscription / Composer 2.5 (no paid-mode switches, no live vendor login during development)

## Coordinator review fixes (2026-10-08)

| # | Finding | Fix |
|---|---|---|
| 1 | `NativeTerminal.retry()` changed ref/state without effect dependency | Added `attempt` state in effect deps; `openFresh` ref forces new open on retry; `onRetry` callback keeps parent list/selection consistent |
| 2 | Rust held `child` mutex during blocking `wait()` after PTY errors | `clone_killer()` for shutdown; `poll_child` without holding output mutex; distinct `outputEnded`/`readFailed` vs process exit |
| 3 | `exit_code`/`exit_signal` snake_case vs TS `exitCode`/`exitSignal` | `#[serde(rename_all = "camelCase")]` on `SessionView`, `Attached`, `Output`; test asserts JSON shape |
| 4 | Early output capped at 128 with no attach scrollback on open | After `terminal_open`, immediately `terminal_attach` for scrollback + seq boundary; `shouldBufferEarly` filters by project/id |
| 5 | `listen()` resolving after unmount left active listener | Stale path calls `stop()` immediately; staleness checked after resize/write async ops |
| 6 | Native login preferred stale `binary.path` over `config.binary` | `login_binary()` prefers pin, refuses mismatched pin/probe; TS `loginBinaryStaleReason()` mirrors guard |
| 7 | Draft guidance said sign in before enabling while login blocked | Draft copy now: configure → enable → then sign-in preparation unlocks |

## Changed files

| File | Rationale |
|---|---|
| `packages/desktop/src-tauri/src/terminal.rs` | Killer-based shutdown; nonblocking child poll; camelCase exit metadata; `outputEnded`/`readFailed`; stale-pin login guard; PTY close regression test |
| `packages/web/src/lib/nativeTerminal.ts` | `shouldBufferEarly`; `outputEnded`/`readFailed` on transport types |
| `packages/web/src/lib/onboarding.ts` | `loginBinaryStaleReason()`; draft guidance order; pin-preferring `loginBinaryPath()` |
| `packages/web/src/components/NativeTerminal.tsx` | `attempt` retry dep; open-then-attach scrollback; listen stale cleanup; `onRetry` callback |
| `packages/web/src/pages/AgentsSetup.tsx` | Stale-binary message; draft login blocked with consistent guidance |
| `packages/web/src/pages/Workspace.tsx` | camelCase session metadata; stale login guard; `onRetry` clears selection/opens fresh |
| `packages/web/test/native-terminal.test.tsx` | Buffer scoping, camelCase metadata |
| `packages/web/test/native-terminal-transport.test.tsx` | Retry opens once; exited-session fresh open; listen-after-unmount; >128 early chunks via attach |
| `packages/web/test/onboarding-guidance.test.tsx` | Draft order; stale-pin refusal |

## Product coverage

- **Retry / re-open:** clicking Retry or "Open another terminal" increments `attempt`, forces a new `terminal_open` (not reattach to dead ID), and notifies parent via `onRetry`.
- **PTY lifecycle:** authoritative process exit code/signal only on `ProcessExit`; `outputEnded` and `readFailed` are distinct; close/kill uses `ChildKiller` clone, never blocks on `child.wait()` while holding session locks.
- **Transport schema:** Rust emits `exitCode`, `exitSignal`, `outputEnded`, `readFailed` (camelCase).
- **Early output:** open → attach scrollback → replay early events with seq > attach boundary; project/id filtering before buffer.
- **Stale binary:** pin/probe mismatch refused at Rust `terminal_open` and TS login path; Workspace re-probes then validates before launch.
- **Draft agents:** guidance says enable first; login action remains blocked until enabled. Billing confirmations unchanged.

## Verification (actual results)

Node: `/Users/krishkumarsah/Docs/Projects/Interface/.desktop-cache/node-v24.21.0-darwin-arm64/bin/node` (`v24.21.0`)

```text
# Focused web tests (15 passed)
node node_modules/vitest/vitest.mjs run --project web \
  packages/web/test/onboarding-guidance.test.tsx \
  packages/web/test/native-terminal.test.tsx \
  packages/web/test/native-terminal-transport.test.tsx

# Typecheck
node node_modules/typescript/bin/tsc -p packages/web/tsconfig.json

# Web build
pnpm --filter @acc/web build

# Daemon onboarding + subscription safety (6 passed)
node node_modules/vitest/vitest.mjs run --project daemon \
  packages/daemon/test/onboarding.test.ts \
  packages/daemon/test/subscription-safety.test.ts

# Rust (22 passed)
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
CARGO_NET_OFFLINE=true \
CARGO_TARGET_DIR=/private/tmp/one-connect-cursor-Bu9W8J/cargo-target \
~/.cargo/bin/cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --locked
```

All commands above exited 0 in this workspace on 2026-10-08.

## Not verified here

- **Native rendered UI:** no Mac app / daemon was launched; PTY behavior is covered by Rust unit tests and mocked web transport tests only.
- **Live vendor login/model calls:** intentionally not performed.
- **`engine.tar.gz`:** absent in the isolated checkout; copied from primary `packages/desktop/src-tauri/resources/engine.tar.gz` locally to satisfy `cargo test` build input. Not added to git.

## Remaining live prerequisites (coordinator / owner)

1. Open a real project in the Mac app and walk Agents & sign-in → Workspace login → re-check flow against installed CLIs.
2. Confirm subscription-safety confirmation still binds to probe/config/restart in production UI.
3. Promote `engine.tar.gz` (or run `desktop:prepare`) before packaging this delta.

## Shared patches

None required outside this owned surface.

---

Source frozen for coordinator review. This handoff does **not** declare One Connect complete.
