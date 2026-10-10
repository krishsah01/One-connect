# Cursor connectors review handoff

**Isolated checkout:** `/private/tmp/one-connect-parallel-20261007/connectors-review`  
**Status:** Parent review defects closed on fixture evidence. Connector-owned source frozen for integration.

## Summary

Closed all five concrete review defects while preserving release reader interfaces (`approvedReleaseConfig`, `releaseAccess`, `releaseReadCurrent`), exact capability/config bindings, and no auto live polling.

| # | Requirement | Status |
|---|---|---|
| 1 | Preview revalidation around awaits; binding to config/project/approval/expiry | **Closed** |
| 2 | Stable snapshot paging; page/pageSize validation; cross-page selections | **Closed** |
| 3 | Canonical source identity; sanitization; source revision + redacted hash | **Closed** |
| 4 | Mirror safety through lifecycle; authoritative bind when source matches tracker | **Closed** |
| 5 | `confirmOptions: ['approve']`; DecisionCard prepare+answer; phone/contract tests | **Closed** |

## Changed paths and SHA-256

| Path | SHA-256 |
|---|---|
| `packages/daemon/src/connectors.ts` | `c735ba5a0c691b11e95e25040d3200a2a38e21e38960beaacc2888dfdedf315f` |
| `packages/daemon/src/daemon.ts` | `f6bd86acebf22a524c2dab2fae218f30fd0fd4fad43f0147cbb8e0f0fb1c1d00` |
| `packages/daemon/src/outbox.ts` | `f170ea0cc99291104aafac3acac8ff51d2dd849fb0566c14f8ee70fbff0b47f0` |
| `packages/daemon/src/server/libraryRoutes.ts` | `4f30daed40ad83f02228f8e74970ff86250822dcfc45896da86d623c2eeb9d7e` |
| `packages/web/src/pages/Connectors.tsx` | `729d81251188ef2419b8cbab43f4f28f6faa3274451b40982af3850ad4b01528` |
| `packages/core/src/entities.ts` | `c5cb856c2ccd4bf1afb3c09aafbb5565c95b071039b07ba7933eb0ff98d52404` |
| `packages/daemon/test/connectors.test.ts` | `d131bac7504310325a35f0a20a4db4be0a4c5ef257e421ae87585003f047db14` |
| `packages/daemon/test/connector-phone.test.ts` | `c63ccbc3f2ec4a20007cf6716646aac3fd6e7af742887ee621f55151c6da6454` |
| `packages/daemon/test/release-connectors.test.ts` | `70feaa31e6708b7dfa8f6d032762483d92ded6fd08eef87efb0b6652b9c4b544` |
| `packages/web/test/release-connectors.test.tsx` | `c990aad80efa01015b08e2e2fb2089ea8ce90adeb4c6d29d9c33df10e14e537b` |

## Behavior by requirement

### 1. Preview binding and revalidation

- `previewImport` captures `ImportBinding` (`connectorId`, `configHash`, `approvalDecisionId`, `projectHash`) before any provider work.
- `assertImportBinding()` re-runs after every await (key lookup, provider fetch) and before publishing snapshot pages.
- Disabled connector, config/project change, or superseded approval aborts without further provider calls.
- Import approval grants read/import only; no write authority is derived from approval.

### 2. Stable snapshot paging

- First preview creates a bounded snapshot (`snapshotHash`, `expiresAt`); later pages pass `token` and slice locally—no refetch.
- `page` / `pageSize` reject NaN, infinity, fractional, and out-of-range integers (400).
- Out-of-range pages return `outOfRange: true` with navigation preserved.
- UI keeps `token` across pages and shows expiry.

### 3. Canonical source identity

- `sourceScope` on `origin` (`repo` or `team`/`project`).
- Duplicate/parent matching scoped by `sourceScope` + `issueId`/`url`, not bare keys.
- All imported fields sanitized/redacted; `sourceRevision` + redacted `contentHash` stored.
- Unsupported parent relations reported in `unsupported[]` and `warnings[]`.

### 4. Mirror lifecycle safety

- `transition()` skips tracker outbox when `readOnly`/`dry_run` without `trackerId`.
- Outbox deliver skips `set_status`/`comment` for mirrors but still delivers enqueued `create_issue` for local tracker imports.
- When connector source exactly matches authoritative tracker (`github` repo or `linear` team/project), imports **bind** existing tracker identity (`trackerId`, `key`, `sync: synced`) instead of mirroring.
- Cross-tracker sources remain explicit local mirrors until a per-action publish Decision exists.

### 5. Second confirmation for activation

- Connector activation Decisions include `confirmOptions: ['approve']`.
- Pending reuse requires that binding; legacy pending records without it are retired.
- Connectors approval UI uses exported `DecisionCard` (prepare → confirm → answer).
- `connector-phone.test.ts` exercises prepare+nonce; release/connector tests updated (no fabricated answered records).

## Parent patches (minimal shared rules)

**`packages/daemon/src/daemon.ts` — `transition()`**

```ts
const trackerWritable = !(item.origin?.readOnly && !item.trackerId) && !(item.sync.status === 'dry_run' && !item.trackerId);
if (trackerWritable && DEFAULT_TRACKER_CATEGORY[item.state] !== DEFAULT_TRACKER_CATEGORY[to]) {
  outbox.push({ workItemId: itemId, op: 'set_status', payload: { category: DEFAULT_TRACKER_CATEGORY[to], lifecycle: to } });
}
```

**`packages/daemon/src/outbox.ts` — deliver guard**

```ts
if (row.op !== 'create_issue' && ((item.origin?.readOnly && !item.trackerId) || (item.sync.status === 'dry_run' && !item.trackerId))) {
  d.store.markDelivered(row.id);
  return true;
}
```

**`packages/daemon/src/daemon.ts` — `buildIssue()` optional bind**

```ts
buildIssue(input, actor, o?: { mirror?: boolean; bind?: { trackerId: string; key: string; url: string | null; trackerStatus: WorkItem['trackerStatus'] } })
```

**Preview route** — pass `token` in body: `{ query?, page?, pageSize?, token? }`.

## Verification commands and results

```bash
cd /private/tmp/one-connect-parallel-20261007/connectors-review

pnpm test \
  packages/daemon/test/connectors.test.ts \
  packages/daemon/test/connector-phone.test.ts \
  packages/daemon/test/release-connectors.test.ts \
  packages/daemon/test/trackers.contract.test.ts \
  packages/daemon/test/code-host.test.ts \
  packages/daemon/test/infra-health.test.ts \
  packages/web/test/release-connectors.test.tsx
# → 7 files, 26 tests passed

pnpm typecheck   # @acc/core, @acc/daemon, @acc/web — passed
pnpm build       # web production build — passed
```

### Connector-phone snippet (fixture)

```ts
const prep = d.decisions.prepare(req.decision!.id, 'approve');
expect(prep.confirm).toBe(true);
await d.connectors.resolve(req.decision!.id, 'approve', HUMAN, { nonce: prep.nonce });
expect(d.state.decisions[req.decision!.id].confirmedAt).toBeTruthy();
```

## Requirement gaps / out of scope

| Item | Notes |
|---|---|
| Live provider acceptance | Still requires owner `gh auth login`, stored Linear key, manual read per provider |
| Outbound publish to different tracker | Still disabled by design; needs separate `import_publish` Decision (documented in prior handoff) |
| Phone-gate E2E | Parent owns `phone-gate.test.ts`; connector-phone covers connector binding only |
| Shared Decisions page | Unchanged; Connectors embeds `DecisionCard` only |

## Freeze declaration

Connector-owned behavior in this checkout is **frozen** for parent integration. Other workers (browser auth/store, Docker/WebSocket backend, workflows, Designer, One Answer, desktop packaging) remain unchanged.
