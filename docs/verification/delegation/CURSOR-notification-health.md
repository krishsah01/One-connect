# Cursor assignment: make infrastructure alerts useful and truthful

## Parent review: finish these corrections on your existing first-pass changes

Continue in the same isolated checkout; do not reset your work. The first pass was reviewed and has not yet been promoted. Fix these concrete defects before handing off again:

1. Your `RELEASE_FAILURE` removed `error` globally, which now hides actual non-infra release/deploy events with `status: 'error'`. Restrict unknown handling to the infra component where it applies, and keep actual release/CI/deploy failures loud. Add regression coverage.
2. `compareMigrations(..., null, source, detail)` now converts every failure to `unchecked`, and `infraComponentFailed('migrations')` ignores every `error`. A missing/unapproved history read is unknown, but an actual approved Supabase/local-Postgres query failure must remain a recorded read failure and generate an alert. Use the existing source/binding semantics; do not fabricate a successful drift check. Inspect actual callers and test both absent configuration/refused read and a failed approved request.
3. Recovery currently clears `acked` but leaves `seen`, so re-failure within the cooldown remains suppressed. Also `infra:ok` is returned for all-unknown reports, so loss of observation can be mistaken for recovery. Detect recovery only from current positive evidence for the previously failed component, and reset the right suppression state so real recovery followed by re-failure immediately produces a new alert. Add fake-clock coverage without advancing past the cooldown, and a failure → unknown → same failure case.
4. Acknowledgement currently suppresses every notification kind forever, while only infra acknowledgements can recover. Keep other alert kinds' existing configured repetition behavior unless you implement and test their real lifecycle recovery. Preserve quiet hours and per-message permissions. Keep acknowledgement/seen storage bounded and restart-safe; do not clear the owner's existing inbox.
5. Project display names are not identities. Use the existing stable project/store ownership or a stable repo/config identity so same-name projects and project renames cannot share or reset alert suppression accidentally. Account for existing stored dedupe keys where necessary; no migrations that discard logs or notifications.

Your patch to `packages/core/src/phone.ts` is a shared-file change beyond the initial ownership list; document the exact small additive integration diff, and leave other shared modules untouched. Correct the inaccurate first-pass “no shared file changes” claim in the final handoff.

Run commands with an explicit Node24 PATH and verify the actual version; the first handoff reported Node26. The pinned binary is `/Users/krishkumarsah/Docs/Projects/Interface/.desktop-cache/node-v24.21.0-darwin-arm64/bin/node`. Record the actual commands. Preserve source hash manifests and give a new frozen handoff at the required docs path. No live calls or model changes.

## Original assignment

Work only in `/private/tmp/one-connect-parallel-20261007/notification-health`, the supplied current-source snapshot. Use the official Cursor CLI on Composer 2.5 and the owner's existing subscription. The owner confirmed on-demand billing is off. Do not enable metered usage, switch models silently, install packages, download models, contact integrations, change user settings or write to the primary checkout.

The freshly rebundled native One Connect app is connected to the saved Study-Bro project. In Phone & alerts the inbox contains 100 unread infra failure notifications, with identical descriptions appearing every minute: `Infrastructure check: docker unknown, postgres unknown, vercel unchecked, migrations error.` No infra read is approved, no local database is declared and no live infra target is configured. The release UI correctly explains those missing checks as unknown. Those observations are real rendered behavior, not a fixture diagnosis; find the actual cause before fixing it.

Own the pure candidate classification in `packages/core/src/reports.ts`, narrowly scoped infra classification in `packages/daemon/src/infra/**`, and notification deduplication in `packages/daemon/src/phone/notifications.ts`. Add focused tests and docs. Do not touch browser files, HTTP routes, settings, approvals, provider adapters, connectors, workflow/team code, packaging or other workers' modules. Shared entity/event changes should be documented as a proposed patch, not applied.

Inspect current code and fix concrete causes:

- Unknown/unconfigured/not authorized/not checked status must remain unknown and never become a fabricated health failure. Show real configured failures loudly, including paused databases, failed CI, unprotected production branches and a genuinely failed approved request.
- Repeated observations of the same unhealthy condition must share a stable, project-scoped fingerprint. Do not use each event's sequence/timestamp as its notification identity. Respect configured cooldown and acknowledgement semantics without suppressing a new or materially changed failure. Recovery followed by another failure must be detectable, and two projects must remain isolated.
- Keep native/browser notification and per-message push/webhook approval policies unchanged. Do not deliver anything externally during implementation or testing. Existing persisted events/notifications must survive; do not clear the owner's inbox or DB.
- Bounded diagnostics, configured denylist and redaction apply before notification text. Quiet hours, delayed approval expiry and exact payload/Decision bindings stay intact.

Use fake clocks and injected infra/notification fixtures to reproduce identical observations, changed failures, recovery/re-failure, cooldown, quiet hours, persisted restart and separate projects. Prove a declared healthy/no-services/absent-database state is not labeled as passed, unhealthy or a successful production verification. Run focused Vitest tests with the supplied Node 24.21.0 and relevant typechecks; do not fabricate a real provider or phone validation. Preserve direct Node strip-only compatibility.

Write `docs/verification/delegation/CURSOR_NOTIFICATION_HEALTH_HANDOFF.md` with files changed, actual commands/results, the root cause, preserved safety rules and unresolved limitations. Stop after this scoped task. Do not commit, merge, rebundle or publish.
