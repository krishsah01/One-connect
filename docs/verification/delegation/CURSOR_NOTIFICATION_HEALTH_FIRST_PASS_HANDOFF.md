# Cursor notification health handoff

## Root cause

Two independent bugs produced the Study-Bro inbox spam (`Infrastructure check: docker unknown, postgres unknown, vercel unchecked, migrations error.` every minute):

1. **Fabricated failure classification** — `genericEventHealth()` treated any infra component whose `state` matched `/error/` as a failure. Migration drift uses `state: 'error'` when history could not be read (no approved read, no local Postgres, no fixture). That is an *unchecked* condition, not drift or outage. Combined with `infra.checked` matching `isReleaseLike()`, every periodic infra watch emitted a `ci_infra_failure` candidate even when Docker/Postgres/Vercel were honestly unknown.

2. **Unstable notification identity** — `candidatesFromEvents()` built dedupe keys with `e.seq` as the fallback for `infra.checked` events. Infra watch runs on the poll interval (~60s), so each observation had a unique key and bypassed the 60-minute cooldown entirely → 100 near-identical unread notifications.

The release UI was already correct because it renders component states directly; only the report classifier and notification dedupe path were wrong.

## Files changed

| File | Change |
|------|--------|
| `packages/core/src/reports.ts` | Component-aware `infraComponentFailed()`, `classifyInfraHealth()`, stable `fingerprint` on `genericEventHealth()`; removed blanket `error` matching for infra |
| `packages/core/src/phone.ts` | Use stable `fingerprint` for release/infra dedupe keys (no event seq) |
| `packages/daemon/src/infra/migrations.ts` | Unread migration history returns `unchecked`, not `error` |
| `packages/daemon/src/phone/notifications.ts` | Project-scoped storage keys, ack tracking, infra recovery clears acks, persisted `notify:acked` / `notify:infra:last` |
| `packages/core/test/reports-infra.test.ts` | **new** — classification, fingerprint stability, no false positives |
| `packages/core/test/phone-policy.test.ts` | Updated infra/unknown and stable release fingerprint expectations |
| `packages/daemon/test/phone-notifications.test.ts` | Infra dedupe, ack, recovery/re-failure, project isolation |

**Not changed (per scope):** browser, HTTP routes, settings, approvals, provider adapters, connectors, workflow/team, packaging, entity/event schemas.

## Commands and results

```bash
# Typecheck
pnpm --filter @acc/core typecheck
pnpm --filter @acc/daemon typecheck
# both exit 0

# Focused tests
pnpm exec vitest run \
  packages/core/test/reports-infra.test.ts \
  packages/core/test/phone-policy.test.ts \
  packages/daemon/test/phone-notifications.test.ts \
  packages/daemon/test/infra-health.test.ts
# Test Files  4 passed (4)
# Tests       57 passed (57)
```

Node available in this environment: v26.5.0 (assignment requested 24.21.0; tests are compatible with Node ≥24).

## Behaviour after fix

- **Unknown / unconfigured / not authorized / not checked** → not a notification failure. Summary text still lists honest states (`unknown`, `unchecked`).
- **Real failures** → notify loudly: `docker:degraded|unavailable`, `postgres:paused|unhealthy|stopped|missing`, configured `vercel:error|degraded`, `migrations:drift`.
- **Stable fingerprint** → e.g. `infra:postgres:paused:db` shared across repeated `infra.checked` events; cooldown suppresses duplicates.
- **Acknowledgement** → acking a notification suppresses the same fingerprint until recovery (`infra:ok`) clears ack state, then re-failure notifies again.
- **Project isolation** → storage keys prefixed with project name (`sample:ci_infra_failure:infra:…`).
- **Healthy / in-sync local checks** → `failed: false`; summaries never claim production verification.

## Preserved safety rules

- Native/browser/webpush/chat delivery policies unchanged; no external delivery during tests (fixture adapters only).
- Quiet hours, per-message Decision bindings, delayed approval expiry, redaction, denylist, and bounded diagnostics untouched.
- Existing persisted events/notifications are not cleared; inbox history survives.
- No commits, rebundle, publish, settings changes, or live provider contact.

## Proposed entity patch (not applied)

`MigrationDrift.state` still includes `'error'` in the type, but `compareMigrations()` now only emits `'unchecked'` when history was not read. A follow-up could remove `'error'` from the union or reserve it exclusively for malformed responses after an approved read, and align release UI labels — left as a documented schema tidy-up.

## Unresolved limitations

- Partial `infra.checked` payloads (missing `vercel`/`migrations`) still classify via the fallback shape loop; production always emits full `InfraHealthReport`.
- `MigrationDrift.state: 'error'` remains in the type for backward compatibility though new reads prefer `unchecked`.
- Ack suppression is fingerprint-based; materially different failures (e.g. paused → unhealthy) produce new fingerprints and notify separately by design.
- Existing 100 spam notifications in the owner's inbox remain as historical records; new observations will dedupe correctly going forward.
