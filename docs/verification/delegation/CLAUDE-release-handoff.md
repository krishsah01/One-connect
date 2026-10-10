# Subagent handoff — release-infra (second pass)

## What was built

The release cockpit from the first pass stays. This pass makes an approved step do real work, and makes a live host call possible only after the owner turns the connection on.

- **Activation.** GitHub, GitLab (including a self-hosted hostname), Vercel, and Supabase are read only when config sets `activated` with a host and at least one scope, the host is on the egress allowlist, and a token is available from `ACC_SECRET_<NAME>` or the macOS Keychain (`packages/daemon/src/secrets.ts`). Before that, refresh records `unconfigured` or `refused` and does not call `fetch`. Live reads use `https://api.github.com`, `https://<gitlab-host>/api/v4`, `https://api.vercel.com`, and `https://api.supabase.com`. A non-loopback `fixture_base` is still refused.
- **Execution.** An approved step runs through `packages/daemon/src/release/runner.ts`. Project commands use the existing check runtime (`packages/daemon/src/checks.ts`). Push and pull-request steps use an exact `gh` or `glab` argument list only, with a stripped environment and no API token in the child. Production and protected-branch pushes are refused and recorded as failed evidence with rollback text. A failure blocks every later step. Rollback is a separate `release_rollback` decision and always needs its own second confirmation.
- **Approval binding.** The decision hash covers kind, step, order, command, target, environment, rollback, check, and source SHA. Editing any of those consumes the open decision. On process start, a step left `running` (or marked in-flight) becomes `uncertain`. It is never run again; a person attests after inspection.
- **Webhooks.** Delivery checks are HMAC (GitHub) or token (GitLab), plus a delivery-id replay window and timestamp skew. The daemon accepts a delivery only on the local authenticated API. `registered` is always false. Polling stays the fallback and uses `poll_seconds` clamped to 15–300. Nothing is registered with the host.
- **Findings.** Failing CI, an unprotected branch, and migration drift can open a tracker issue through the existing outbox (`manual` one-click, or `rule`). Sync stays `pending` until that outbox delivers. Duplicate findings are not filed twice.
- **Human attestation.** Device QA is labelled human attestation. It does not execute a command and is not treated as device evidence.

## Files

- Core: `packages/core/src/release.ts`, `packages/core/src/config.ts`
- Hosts and probes: `packages/daemon/src/adapters/hosts/{http,github,gitlab,index,webhook}.ts`, `packages/daemon/src/infra/{health,vercel,migrations}.ts`, `packages/daemon/src/egress.ts`, `packages/daemon/src/secrets.ts`
- Release: `packages/daemon/src/release/{plans,runner,findings}.ts`, `packages/daemon/src/decisions.ts`, `packages/daemon/src/daemon.ts`, `packages/daemon/src/rules.ts`, `packages/daemon/src/server/http.ts`, `packages/daemon/src/mcpBridge.ts`
- UI: `packages/web/src/pages/ReleaseCockpit.tsx`, `packages/web/src/pages/Decisions.tsx`
- Tests: `packages/daemon/test/release-second-pass.test.ts`, `packages/daemon/test/release-plans.test.ts`, `packages/daemon/test/code-host.test.ts`, `packages/daemon/test/infra-health.test.ts`, `packages/web/test/release.test.tsx`

## How it connects

`POST /api/release/plans` stores the ordered plan. `POST /api/release/plans/:id/steps/:stepId` opens a `release` decision bound to the current command, target, environment, and merge SHA. Answering that decision calls `ReleasePlans.resolve`, which writes `running` before any write step, then `runChecks` or the allowlisted `gh`/`glab` command. Evidence is stored on the step and commented through the tracker outbox. `ReleasePlans.recover` runs when the daemon loads state. `POST /api/release/deliveries` verifies a webhook locally. `POST /api/release/findings` (and `finding_issues: rule` during infra watch) calls `daemon.buildIssue`, so the issue stays unsynced until the outbox worker delivers it. The cockpit shows attestation, uncertain/inspect, rollback, finding buttons, and the unsynced badge.

## Tests

From `/private/tmp/one-connect-claude/release-infra`:

- `npx vitest run packages/daemon/test/release-second-pass.test.ts packages/daemon/test/release-plans.test.ts packages/daemon/test/code-host.test.ts packages/daemon/test/infra-health.test.ts packages/web/test/release.test.tsx` — exit 0 (15 tests). Re-run of the two release files after the type fixes — exit 0 (8 tests).
- `pnpm -r typecheck` — exit 0 (`@acc/core`, `@acc/daemon`, `@acc/web`).

The second-pass file covers command execution and blocked successors, allowlisted `gh` push versus a refused production push, invalidated approval on command/target/environment/SHA, human attestation, an interrupted write becoming `uncertain`, webhook accept/replay/skew with no host registration, no fetch before activation, a live GitHub read after allowlisting, and live GitLab/Vercel/Supabase reads with hash mismatch and a pending tracker issue.

## Unverified

- No request was sent to api.github.com, gitlab.com, api.vercel.com, or api.supabase.com. Live paths were exercised with an injected `fetch`. Real-provider validation is pending.
- `gh` and `glab` were not executed. Tests replace `releasePlans.exec`.
- Docker and Postgres were not started. Project commands in tests replace `releasePlans.projectCommand`.
- The cockpit was not opened in a browser.
- The full vitest suite, web build, license gate, and Rust checks were not run.
- The Keychain was not written. Token tests use `ACC_SECRET_*`.
