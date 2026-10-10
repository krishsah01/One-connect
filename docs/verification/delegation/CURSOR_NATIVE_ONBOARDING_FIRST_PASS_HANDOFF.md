# Cursor native onboarding handoff

Workspace: `/private/tmp/one-connect-parallel-20261007/native-onboarding`
Baseline: `d19277b125dc542dcd29e293880324d87aa8383a`
Reference source (read-only): `/Users/krishkumarsah/Docs/Projects/Interface`
Model harness: official Cursor subscription / Composer 2.5 (no paid-mode switches, no live vendor login during development)

## Changed files

| File | Rationale |
|---|---|
| `packages/desktop/src-tauri/src/terminal.rs` | Authoritative child `wait()` after PTY reads; honest exit line with code/signal or session-ended fallback; write/resize refused after exit; attach/list expose exit metadata; disabled-agent login guard; added PTY/exit/scoping/UTF-8/close tests |
| `packages/web/src/lib/nativeTerminal.ts` | **New.** Bounded early-output queue, scoped output acceptance, safe resize/write IPC, abandoned-session close helper |
| `packages/web/src/lib/onboarding.ts` | **New.** Shared login argv, auth labels, connection/stale-binary/vendor-login guidance, safe binary path selection |
| `packages/web/src/components/NativeTerminal.tsx` | Generation-scoped effect; closes late opens on unmount; bounded early events; caught resize/write errors; loading/exit/error UI with keyboard-accessible retry/close; login-exit recheck link |
| `packages/web/src/pages/AgentsSetup.tsx` | Uses shared helpers; distinct draft/missing/expired/unknown/stale-binary guidance; blocks vendor login before agent configuration; draft login blocked |
| `packages/web/src/pages/Workspace.tsx` | Probes agent before native login launch; uses canonical probed binary path; login-exit notice with setup recheck; session exit metadata |
| `packages/daemon/src/onboarding.ts` | `agentHasNewerBinary()` helper for stale-binary reporting |
| `packages/daemon/test/onboarding.test.ts` | **New.** `/api/onboarding`, vendor detection, newer-binary helper |
| `packages/web/test/onboarding-guidance.test.tsx` | **New.** Draft/missing/expired/unknown/stale/vendor-login guidance |
| `packages/web/test/native-terminal.test.tsx` | **New.** Transport scoping and bounded early-output helpers |
| `packages/web/test/native-terminal-transport.test.tsx` | **New.** Late-open abandonment, duplicate-seq handling, open-failure retry UI (xterm mocked) |

No changes to phone, release, connectors, billing policies, provider harnesses, workflows/Team, One Answer, Designer, packaging, or the primary Interface checkout.

## Product coverage

- **Provider setup:** detect installed copies, pin/probe canonical executable, fixed official login argv only, subscription-safety confirmation preserved (existing daemon tests untouched).
- **Honest states:** draft, missing CLI, expired auth, unknown verification, stale/newer binary, and “login detected ≠ ready to dispatch” each have distinct UI copy.
- **Unconfigured vendor:** installed-tool login blocked until an agent exists and is configured.
- **Login launch:** Workspace re-probes before opening native login; Rust `terminal_open` reads fresh daemon state and refuses disabled agents / missing binaries.
- **Native terminal:** bounded 256 KiB scrollback, UTF-8 decoding, project scoping, session reattach with seq dedupe, abandoned late-open cleanup, exited-session write/resize failures, exit metadata without invented codes.
- **Terminal exit ≠ login success:** NativeTerminal and Workspace offer re-check in setup; no auth.fix auto-execution.
- **Ordinary shells:** still human-opened; `initialInput` typed only, never auto-submitted.

## Verification (actual results)

Node: `/Users/krishkumarsah/Docs/Projects/Interface/.desktop-cache/node-v24.21.0-darwin-arm64/bin/node` (`v24.21.0`)

```text
# Focused web tests (8 passed)
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

# Rust (19 passed) — required local engine bundle copied from primary checkout for this run only
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

None required outside this owned surface. `terminal_open` already fetched live daemon state; changes are additive (exit metadata, guards, web transport hardening).

---

Source frozen for coordinator review. This handoff does **not** declare One Connect complete.
