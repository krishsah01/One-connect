# Cursor notification health handoff

## Root cause

Two independent bugs produced the Study-Bro inbox spam (`Infrastructure check: docker unknown, postgres unknown, vercel unchecked, migrations error.` every minute):

1. **Fabricated failure classification** — `genericEventHealth()` treated any infra component whose `state` matched `/error/` as a failure. Migration drift uses `state: 'error'` when history could not be read (no approved read, no local Postgres, no fixture). That is an *unchecked* condition, not drift or outage. Combined with `infra.checked` matching `isReleaseLike()`, every periodic infra watch emitted a `ci_infra_failure` candidate even when Docker/Postgres/Vercel were honestly unknown.

2. **Unstable notification identity** — `candidatesFromEvents()` built dedupe keys with `e.seq` as the fallback for `infra.checked` events. Infra watch runs on the poll interval (~60s), so each observation had a unique key and bypassed the 60-minute cooldown entirely → 100 near-identical unread notifications.

The release UI was already correct because it renders component states directly; only the report classifier and notification dedupe path were wrong.

## Parent-review corrections (second pass)

1. **Release `status: 'error'` restored** — `RELEASE_FAILURE` no longer matches `error` inside `infraComponentFailed()`, but generic release/deploy/CI events still fail on `status === 'error'`.
2. **Migration read semantics** — `compareMigrations(..., null, source, detail)` now emits `unchecked` only for `source: 'none'`; approved/configured reads that fail return `state: 'error'` and alert. `infraComponentFailed('migrations')` treats `error` as failure.
3. **Recovery truthfulness** — All-unknown observations fingerprint as `infra:unknown`, not `infra:ok`. Recovery clears both `acked` and `seen` only when positive evidence shows the prior failure component is healthy. Re-failure after recovery or after an unknown gap notifies again without waiting out cooldown.
4. **Ack scope** — Only `ci_infra_failure` acknowledgements suppress repeats until recovery; other kinds keep cooldown-based repetition.
5. **Stable project identity** — Dedupe storage keys use `projectNamespace(repo)` (canonical repo SHA-256). Display names are legacy read-only fallbacks for existing KV entries; new writes use the stable scope only.

## Files changed

| File | Change |
|------|--------|
| `packages/core/src/reports.ts` | Component-aware infra classification, `infra:unknown` / `infra:healthy` fingerprints, migration `error` failures, release `status:error`, recovery helpers |
| `packages/core/src/phone.ts` | **Shared additive integration** — stable `fingerprint` dedupe for release/infra candidates (see below) |
| `packages/daemon/src/infra/migrations.ts` | `null` applied + `source !== 'none'` → `error`, not `unchecked` |
| `packages/daemon/src/infra/health.ts` | Approved Supabase read failures return `compareMigrations(..., null, 'live', …)` |
| `packages/daemon/src/phone/notifications.ts` | Repo-scoped keys, infra-only ack, truthful recovery, legacy key read fallback |
| `packages/core/test/reports-infra.test.ts` | Classification, release error, migration error, recovery evidence |
| `packages/core/test/phone-policy.test.ts` | CI `status:error` regression |
| `packages/daemon/test/phone-notifications.test.ts` | Dedupe, ack scope, recovery/re-failure, stable project identity |
| `packages/daemon/test/infra-health.test.ts` | Local Postgres read failure → `error` |

**Not changed (per scope):** browser, HTTP routes, settings, approvals, provider adapters, connectors, workflow/team, packaging, entity/event schemas.

### Shared-file integration diff (`packages/core/src/phone.ts`)

This is the only shared-module change beyond the original ownership list. It is additive and narrowly scoped to dedupe identity:

```diff
-    } else if (isReleaseLike(e.type) && genericEventHealth(e.type, d).failed) {
+    } else if (isReleaseLike(e.type)) {
       const g = genericEventHealth(e.type, d);
-      out.push({ kind: 'ci_infra_failure', ..., dedupeKey: `${e.type}:...:${g.summary.slice(0, 60)}`, ... });
+      if (!g.failed) continue;
+      const dedupeKey = g.fingerprint ?? `${e.type}:${String(d.plan?.id ?? d.id ?? d.releaseId ?? d.name ?? 'event')}`;
+      out.push({ kind: 'ci_infra_failure', ..., dedupeKey, ... });
```

No entity/event schema changes were applied.

## Commands and results

```bash
export PATH="/Users/krishkumarsah/Docs/Projects/Interface/.desktop-cache/node-v24.21.0-darwin-arm64/bin:$PATH"
node --version
# v24.21.0

pnpm --filter @acc/core typecheck
pnpm --filter @acc/daemon typecheck
# both exit 0

pnpm exec vitest run \
  packages/core/test/reports-infra.test.ts \
  packages/core/test/phone-policy.test.ts \
  packages/daemon/test/phone-notifications.test.ts \
  packages/daemon/test/infra-health.test.ts
# Test Files  4 passed (4)
# Tests       61 passed (61)
```

`CURRENT_SOURCE_SNAPSHOT.json` is preserved unchanged.

## Behaviour after fix

- **Unknown / unconfigured / not authorized / not checked** → not a notification failure. Summary text still lists honest states (`unknown`, `unchecked`).
- **Real failures** → notify loudly: `docker:degraded|unavailable`, `postgres:paused|unhealthy|stopped|missing`, configured `vercel:error|degraded`, `migrations:drift|error` (after an approved/configured read fails).
- **Stable fingerprint** → e.g. `infra:postgres:paused:db` shared across repeated `infra.checked` events; cooldown suppresses duplicates.
- **Acknowledgement** → only infra acks suppress until positive recovery evidence; other kinds repeat on cooldown.
- **Recovery** → `infra:healthy` with component-level positive evidence clears infra ack + seen; `infra:unknown` does not masquerade as recovery.
- **Project isolation** → storage keys prefixed with `projectNamespace(repo)`; same display name on different repos does not share suppression.
- **Healthy / in-sync local checks** → `failed: false`; summaries never claim production verification.

## Preserved safety rules

- Native/browser/webpush/chat delivery policies unchanged; no external delivery during tests (fixture adapters only).
- Quiet hours, per-message Decision bindings, delayed approval expiry, redaction, denylist, and bounded diagnostics untouched.
- Existing persisted events/notifications are not cleared; inbox history survives.
- No commits, rebundle, publish, settings changes, or live provider contact.

## Unresolved limitations

- Partial `infra.checked` payloads (missing `vercel`/`migrations`) still classify via the fallback shape loop; production always emits full `InfraHealthReport`.
- Legacy display-name KV keys remain readable for restart migration but are no longer written; very old inboxes may need one more observation to migrate suppression state.
- Ack suppression is fingerprint-based; materially different failures (e.g. paused → unhealthy) produce new fingerprints and notify separately by design.
- Existing 100 spam notifications in the owner's inbox remain as historical records; new observations will dedupe correctly going forward.
