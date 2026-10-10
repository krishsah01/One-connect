# Release resumed handoff

Status: release slice finished and frozen in `/private/tmp/one-connect-cursor-Bu9W8J/claude-final`. No shared-work commit, reset, stash, revert, outbound push, promotion or native rebuild was performed. Commits and Git upload occurred only in disposable fixture repositories. Other workers' edits were preserved. `/Users/krishkumarsah/Docs/Projects/Interface` was not modified.

## Exact changed paths

1. `packages/core/src/release.ts`
2. `packages/daemon/src/release/plans.ts`
3. `packages/daemon/src/release/runner.ts`
4. `packages/daemon/src/release/findings.ts`
5. `packages/web/src/pages/ReleaseCockpit.tsx`
6. `packages/daemon/test/release-safety.test.ts`
7. `packages/daemon/test/release-second-pass.test.ts`
8. `packages/daemon/test/release-typecheck.tsconfig.json`
9. `packages/daemon/test/release-ordered.test.ts` (new)
10. `packages/daemon/test/release-findings.test.ts` (new)
11. `packages/web/test/release-resumed.test.tsx` (new)
12. `docs/verification/delegation/RELEASE-resumed-handoff.md` (new)

Connector-owned files, daemon/server/Decisions/shared events/egress, App/Workspace/onboarding, runtime adapters and phone sources were not edited by this worker. Vite generated ignored `packages/web/dist` output within this scratch checkout.

## Resulting behavior

- The default ten-step plan is push → PR → CI → migration dry-run → backup → migrate → environment flags → deploy → routes → device QA. SHA targets use the full recorded merge SHA. Device QA now uses `check:release_device_qa` plus `check:release_device_qa_verify`; the legacy `attest:device` action remains explicitly unverified and cannot advance the plan. Commands are configuration references, not implicit provider operations. Unconfigured checks fail closed.
- Each configured action and its verifier are distinct commands. Verification requires exit 0 **and** an actual challenge-bound proof for the exact SHA, target, runtime, kind, phase, fresh timestamp and unique request ID. Backup requires an artifact; device QA requires an independently supplied device session/artifact and `source: real_device`, `acceptanceEnvironment: device`. CI green, hosting READY, text claims and human attestation never replace step verification.
- The ordinary committed-source executor remains local/offline. It replaces `{release_sha}` with the exact SHA and `{release_verification}` with one shell-quoted JSON challenge. The verifier emits exactly one `ONE_CONNECT_RELEASE_PROOF <JSON>` line after checking its effect. Local output is forcibly classified `source: probe`, `acceptanceEnvironment: local`; printing production/device claims cannot promote that scope. Accepted evidence retains only the defined proof fields and redacts/truncates human-readable content.
- Durable human answer, confirmation when required, exact action receipt and in-flight plan reservation commit together before any action dispatch. Per-child guards recheck the receipt, action fields, SHA/merge binding, config and running reservation before/after awaits. Duplicate answers cannot execute. Material edits include rollback verifier, merge identity, PR title, source, target, environment and order; removed pending rows and open recovery decisions are consumed. Connector availability/log updates alone no longer invalidate an unchanged approval; connector configuration, approval and disable changes do.
- Exact SHA Git upload still runs from an isolated bare repo using read-only local objects. Production transport uses the exact approved HTTPS repository and non-force refspec, no repository remotes/URL rewrites/hooks/helpers, no redirects, and no custom transport helper. Credentials are scoped to that exact repository path; gh/glab get disposable home/config directories. Fixture tests substitute a local bare endpoint only inside the injected test executor, never production code/config.
- Both push and PR require fresh named branch-protection reads: protected production base, explicitly unprotected integration/release head. The connector capability ceiling is enforced for those reads and PR reads. PR checks bind exact repository/head/base/SHA before and after creation; GitLab additionally checks the scoped project identity and numeric source/target project IDs. Production/protected/malformed heads, foreign commands, forced refspecs and unknown protection are refused.
- `running` reservations become `uncertain` after restart; old decisions are consumed and the write is never replayed. Inspection performs only fresh host reads or the exact verification command. An unavailable/failed inspection remains uncertain until a successful probe or an explicit human `failed` answer. Inspection retains the original run/rollback phase and original merge even if newer work merges. It cannot turn a successfully inspected rollback into forward success.
- Rollback has its own Decision, second confirmation and `rollbackCheck`. Defaults add `check:release_<action>_rollback_verify`. Missing verification prevents the rollback action from dispatching. A successful rollback remains a failed forward step, blocks successors and never retries the original action. If the work item was deployed, verified restoration moves it back to release candidate so it does not retain deployment acceptance.
- Lifecycle uses existing events/outbox only: first approved release progress → release candidate; fresh scoped deploy proof → deployed; only a completed ordered plan plus matching merge, deploy/routes acceptance and the item's production/device requirement → verified/Done. Local proof cannot satisfy a production-required item. Tracker comments/status writes remain through the existing local/outbox contract.
- Live findings use `approvedReleaseConfig()` and `releaseReadCurrent(kind, capability)` for the specific fact. They cannot borrow another capability's snapshot or survive a Settings/evidence change. Partial checks-only reads may file a CI finding while protection stays unknown. Deduplication is keyed by repository/project/production-branch scope; sync remains pending until outbox delivery.
- The cockpit selects a recorded merged work item when creating a plan, blocks approval of unsaved edits, freezes editing during running/uncertain actions, asks the daemon for a current Decision on every approval attempt, serializes the confirmation interaction, exposes the rollback verifier, and shows verified rollback as a failed step. Retained live facts are filtered per approved capability. Configured device checks are not labelled human attestation.

## Verification actually run

All commands ran in this scratch checkout using existing dependencies. No installation/download occurred.

```sh
node node_modules/vitest/vitest.mjs run \
  packages/daemon/test/release-ordered.test.ts \
  packages/daemon/test/release-findings.test.ts \
  packages/daemon/test/release-plans.test.ts \
  packages/daemon/test/release-safety.test.ts \
  packages/daemon/test/release-second-pass.test.ts \
  packages/daemon/test/release-connectors.test.ts \
  packages/web/test/release-resumed.test.tsx \
  packages/web/test/release.test.tsx \
  packages/web/test/release-connectors.test.tsx
```

Result: **9 files, 46 tests passed; exit 0** (2026-10-07, final run started 15:49:19 as reported by Vitest; duration 6.04 s).

- Full ordered acceptance uses repository-owned fake Claude/Codex processes, an authenticated loopback fixture server, actual independent SHA review/integration merge/post-checks, a disposable bare Git repo with actual newly local commit-object upload, real committed-source fixture actions, and independent local probes of their effects. It checks all ten steps, confirmations, no skipped successors/replays, release candidate/deployed/verified transitions, exact SHA artifacts, eleven terminal release comments (including failed local device QA), and local tracker Done.
- Ordinary device QA first fails as required. Completing the fixture then uses an **explicitly injected synthetic device session protocol**, checking its stored SHA/runtime and context. Its device evidence exists only in the disposable test daemon; this is contract verification, not real-device/product acceptance.
- Failure/stale/restart coverage includes expired/missing confirmation, changed configuration/action payload/source/runtime/check, removed pending decisions, failure blocking, missing capability before dispatch, unavailable inspection staying uncertain, push/PR restart inspection without writes, newer merge while inspecting the original effect, rollback restart using only the restoration probe, successful rollback remaining failed, and clearing deployment lifecycle after restoration.
- Safety coverage includes real Git object transport under hostile repository hooks/helpers/URL rewrite/proxy config, protected/production/malformed target refusal, wrong post-write SHA, moved PR head, exact GitLab scope, and challenge/result SHA/runtime/phase/freshness/artifact/source/detail/exit-status failures for CI and every configured step kind.
- UI tests cover merge binding, unsaved approval blocking, rollback verifier serialization, fresh Decision selection after failure, frozen uncertain plans, truthful rollback/device labels, and checks-only capability filtering. Existing connector contracts were run without modifying their owned test/source files.

Additional results:

- `pnpm -r typecheck` — **exit 0**, core/daemon/web all passed.
- `pnpm --filter @acc/web build` — **exit 0**, 270 modules; Vite built in 545 ms.
- Focused source/test `git diff --check` — **exit 0**.
- The sandbox initially refused loopback binding (`listen EPERM 127.0.0.1`); the final focused fixture suite ran with approved sandbox escalation. No automatic approval rejection remains.

## Minimal parent-owned integration snippets

### HTTP request typing (runtime already forwards the JSON field)

At `packages/daemon/src/server/http.ts`'s release-plan update request type, add the optional field:

```ts
steps?: {
  id?: string;
  kind: ReleaseStepKind;
  title: string;
  owner: string;
  command: string;
  check: string;
  rollback: string;
  rollbackCheck?: string; // new optional owned contract
  target?: string;
  environment?: string;
}[];
```

No new route or event type is required. Existing `/api/release/plans/.../decision|inspect|rollback` routes and the canonical `Decisions.respond` action router remain authoritative. If shared Decisions UI translates inspection options, display `attested` as “Inspect and verify”; it requests a probe and does not itself attest acceptance.

### Independently verified production/device protocols (pending; do not enable live by default)

The owned callback now supplies a fourth, optional `ReleaseCommandContext` argument: `decisionId`, `planId`, `stepId`, `kind`, `target`, `environment`, `phase`, `configHash`. Existing three-argument overrides remain compatible. It is supplied only under the durable reservation/guards; the default callback stays local. A parent-owned protocol should use exact reviewed dispatch selection and repeat authorization around its own awaits:

```ts
const local = d.releasePlans.projectCommand;
d.releasePlans.projectCommand = async (command, sha, request, context) => {
  if (!context) return local(command, sha, request);
  const config = d.connectors.approvedReleaseConfig();
  if (!protocol.handlesExact(command, context, config)) {
    return local(command, sha, request, context);
  }
  const assertReserved = () => {
    const decision = d.state.decisions[context.decisionId];
    const raw = d.store.kvGet(`release:authorization:${context.decisionId}`);
    const receipt = raw ? JSON.parse(raw) : null;
    if (d.closed || decision?.consumedAt || !decision?.answeredAt ||
        decision.answeredBy?.type !== 'human' ||
        receipt?.status !== 'reserved' ||
        receipt.action?.hash !== decision.action?.hash ||
        receipt.action?.configHash !== context.configHash ||
        receipt.action?.sha !== sha ||
        receipt.action?.target !== context.target ||
        receipt.action?.environment !== context.environment ||
        (d.decisions.needsConfirmation(decision, decision.answer!) && !decision.confirmedAt)) {
      throw new Error('Exact durable release authorization is unavailable');
    }
    // Parent protocol must revalidate the current authoritative config and its
    // separately approved repo/host/project/branch/environment/egress ceiling.
    protocol.assertExactReviewedScope(d.connectors.approvedReleaseConfig(), command, context);
  };
  assertReserved();
  const result = request
    ? await protocol.probe({ command, sha, request, context, assertReserved })
    : await protocol.execute({ command, sha, context, assertReserved });
  assertReserved();
  return result;
};
```

`protocol` above is an integration placeholder, not implemented/live code. `probe` must independently verify the actual effect, return the exact request fields and actual observed SHA/runtime with exit 0, and supply production/device scope only from that external/device observation. It must never rerun the write during inspection. Any retained provider evidence used by shared surfaces must use `releaseReadCurrent(kind, capability)`; a raw activated flag, approved read without a current read, CI success or hosting READY is insufficient.

## Pending/live conditions

- No live code-host/provider/tracker/tunnel/infra request, outbound message, production operation, real key change, model pull, paid flag, install/download, outbound push or publish was performed. Tokens used by read contract tests are injected fixture strings only. No live write permissions were validated.
- Actual GitHub/GitLab authentication/scopes/branch protection/remote writes and gh/glab process behavior against real hosts remain unverified. Their protocol contracts and exact SHA object upload are verified locally.
- Actual backups/restores, migrations, flags, deployment/routes, installed Docker runtime and real-device QA remain unverified. The default local executor deliberately cannot manufacture those production/device claims; parent must supply independently authorized, scoped protocols and real acceptance evidence when live work is later permitted.
- No primary native app was rebuilt/opened and no browser/native manual acceptance was performed in this turn. Parent must promote this new source snapshot and rerun its native/product acceptance as appropriate; the earlier promoted build predates these changes.
- Full repository vitest, Rust/native checks and release/publishing acceptance were not run. Passing the focused suite/typecheck/webbuild does not establish full product acceptance.
- Existing saved approvals are invalidated by the stronger action digest when requested/resolved; request a fresh Decision. Existing rollback rows without `rollbackCheck` stay non-executable until explicitly configured and approved. Uncertain rows require inspection; no migration replays them.

Changes are frozen after this handoff. No shared integration files were modified to implement the snippets above.
