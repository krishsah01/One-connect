# Cursor assignment: make infrastructure alerts useful and truthful

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
