<!-- SPDX-License-Identifier: Apache-2.0 -->
# Resumed phone handoff — One Connect

Date: 2026-10-07. Work directory: `/private/tmp/one-connect-cursor-Bu9W8J/claude-final`.
**Owned source is frozen at this handoff. The whole product goal remains incomplete.**

## Boundaries

Edited only `packages/daemon/src/phone/**` except `reports.ts`, `packages/core/src/phone.ts`,
`packages/web/src/pages/{Phone,Remote}.tsx`, focused phone tests/config and phone docs.
No primary checkout, native bundle, App, PhoneShell, shared egress, Decisions, server, daemon,
connector, release, runtime adapter, One Answer or Designer source was edited. No checkout
commit was made. Other workers' changes were present at entry and continued during this run;
they have been preserved. The delegated web build wrote only its ignored `packages/web/dist`.
No live integration, real notification, tunnel, provider, network request/listener, install,
download, paid usage, credential/key, production or outbound configuration action was performed.
Test project settings and disabled paid agent drafts exist only in disposable daemon fixtures.
The usual helper tests create disposable local Git fixture repos; the native fixture needs no
Git repository or commits and blocks subprocesses, sockets and global fetch during execution.

## Exact owned changes

- `projection.ts`: explicit agent/config/run/work-item status projections preserve declared
  billing, metered opt-in, budget, concurrency, enabled/on-demand and unknown usage. Strip
  execution instructions, assignment paths/check commands, tracker origin/management objects,
  raw work-item bodies, runtime pid/session/log directory, ungranted run prose/exit messages
  and future agent/run fields. Classify Decision visibility by specialized durable binding as
  well as kind; keep only granted Decisions. Explicit live/history envelopes cannot copy extra
  configuration fields. WS ordinary event batches still end with the current scoped snapshot.
- `projection.ts`, `routes.ts`: HTTP run history now shares WS filtering. Empty `phone.cursor`
  control rows preserve every hidden row's seq and page position: a 1000-row hidden page can
  advance to the next transcript page. Read-only phones receive no run history/live text.
  Issue-event responses use the safe report projection; they no longer expose arbitrary raw
  project controls.
- `routes.ts`: phone Brief, Timeline, Morning and JSON/Markdown Standup are rebuilt from
  scoped state/events without modifying parent-owned `reports.ts`. Unavailable Decisions,
  approvals, tunnel/session audit, benchmark internals and ungranted handoffs/tests/transcript
  claims are excluded. Recorded release/infra/check shapes retain status evidence without
  executable plan/configuration. Team status strips assignment paths and ungranted questions.
  Successful phone answer responses remain bounded and redacted; no executor config response
  is returned. HTTPS logout also expires the `__Host-` cookie with Secure.
- `core/src/phone.ts`: team status keeps `read`; peer message bodies now require `transcript`.
  Scope descriptions state the bounded redacted log and team-message access explicitly.
- New `logs.ts`, `routes.ts`: full and paged phone run logs redact the complete bounded input
  before splitting pages; a known credential straddling 128 KiB cannot escape in fragments.
  Incomplete live raw lines wait for newline. Files above 16 MiB fail with 413 and an honest
  Mac/structured-transcript alternative. Byte offsets and totals refer to the redacted view.
- `gate.ts`: reauthenticate after body parsing so concurrent revocation/scope reduction does
  not retain the initial principal. Positive merge, Docker, connector, tunnel, message, cost
  and settings answers require the Decision's second-confirmation binding. Endpoint reviews
  remain local. Actual current Docker/connector requests without that binding now fail closed
  on phone prepare/approve; denial preparation remains available. This is a concrete guard,
  not proof that those parent request factories are finished.
- `remote.ts`: permanent scope intersection is persisted to the pairing; removing/re-adding
  a config grant cannot silently restore it. Close captured-scope sockets before publishing
  the reduced config. Idle/absolute expiry revokes without waiting for another request; reduced
  session limits apply immediately. Added synchronous `socketAuthorized` for the parent guard.
  Throwing/missing probes progress to reconnecting/down. Loss/stop closes sockets and removes
  ingress. Stop invalidates pairing links immediately. Cancelled asynchronous starts cannot
  resurrect a disabled tunnel; overlapping launches/teardown are blocked and stale probe
  results ignored. Failed teardown retains its plan for retry and reports error honestly.
- `tunnel.ts`: a nonzero injected Tailscale teardown result is now an error, rather than success.
- `notifications.ts`: permit redemption rechecks the recorded human answer/confirmation,
  current claim, endpoint/channel and exact payload. Additional/invalid headers, credentials
  or explicit referrer are rejected; malformed headers burn the permit and return false.
  Retains exact URL/payload/config/revision/process/expiry/quiet-hour bindings, atomic answer
  and claim, one attempt, no redirect/retry, no standing approval and empty notification hosts.
- `Phone.tsx`: an armed kill switch resets on offline, grant loss or engagement. Existing
  DecisionCard confirmation and target scope checks are retained. `Remote.tsx` does not mount
  Mac management for a paired session, and does not mount its inbox without `read`.

## Completed checks

Installed runtime: `/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`,
**v24.19.0**. The default PATH node is v26.5.0; verification commands below explicitly used Node24.
No runtime/dependency installation was needed.

```sh
/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run packages/core/test/phone-policy.test.ts packages/daemon/test/phone-gate.test.ts packages/daemon/test/phone-notifications.test.ts packages/daemon/test/agent-costs.test.ts packages/daemon/test/settings.test.ts packages/web/test/phone.test.tsx packages/web/test/pwa.test.tsx
/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test packages/daemon/test/phone-resumed.strip.test.mjs
/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --pretty false
/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc -p packages/daemon/tsconfig.json --pretty false
/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc -p packages/web/tsconfig.json --pretty false
# cwd: this delegated checkout/packages/web
/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vite/bin/vite.js build
```

All final commands exited 0: **93 focused tests across 7 files**, **9 native Node24 tests**,
all three package typechecks, delegated Vite build. Scoped `git diff --check` also exited 0.
Logs: `PHONE-resumed-tests.log`, `PHONE-resumed-node24.log` alongside this document (ignored logs).

The 17 phone gate tests include actual injected HTTP → gate → shared Decisions.respond → owned
projection chains: exact disabled cost configuration and project settings saves, and a bound
release custom step through injected action/probe functions. They verify required confirmation,
phone/human provenance and replay refusal. Docker/connector tests use their actual shared request
factories with an injected Docker list; current positive requests are correctly refused because
the factories omit confirmation. No Docker command or connector import is executed.

Coverage also includes a full hidden history page followed by the next transcript page; raw-log
page/secret boundary and size limit; HTTP/WS parity; scoped reports/issue events/Markdown/team;
scope reduction then re-addition; idle and reduced absolute limits; socket revocation signals;
throwing probes; delayed launch cancellation; failed teardown and retry; offline arming reset;
CSRF, exact Origin, session and management-route refusals; notification denial/restart/expiry,
quiet-hour/config change-and-revert invalidation, payload/URL mutation, concurrent claim/replay,
rejected endpoints, bad permits on normally allowed hosts and request-header/credential tampering.

Native tests directly import seven owned daemon .ts modules plus core phone policy in fresh Node24
processes with IO forbidden. A further native test directly imports and exercises actual Daemon,
phone modules, Fastify injection, Decision dispatch, history/live projections, single-message
permit egress and expiry. It never calls a transpiler, server listen, vendor CLI or real fetch.
The frozen runtime/shared modules successfully import transitively. Source behavior is proven
against these local/injected fixtures; this is not connected real-phone acceptance.

## Required parent patches — supplied, not applied

The existing awaited `resolveEndpoint`, `projectMessages` fanout and permit verifier are present
in shared Decisions/server/daemon/egress. Keep them; notification hosts must stay absent from the
broad egress allowlist. Shared DecisionCard already uses factual notification audit wording.

### 1. Enforce exact expiry before WS send and client commands

In the shared WS handler in `packages/daemon/src/server/http.ts`, after principal is captured:

```ts
const phoneAuthorized = () => {
  if (!principal) return true;
  if (d.remote.socketAuthorized(principal.session.id, principal.scopes)) return true;
  socket.close(4001, 'session no longer authorized');
  return false;
};
const send = (message: unknown) => {
  if (!phoneAuthorized()) return;
  const messages = principal ? d.remote.projectMessages(message, principal.scopes) : [message];
  for (const m of messages) if (socket.readyState === 1) socket.send(JSON.stringify(m));
};
// First statement of the existing socket.on('message', ...) callback:
if (!phoneAuthorized()) return;
```

Owned periodic expiry emits the existing revocation event, including while no HTTP request
arrives. Without this parent guard an already-open socket has up to the 30-second tick interval
at expiry; it must not be claimed to enforce exact boundaries. Verify upgrade, hello/reconnect,
subscribe_run pagination, live delivery, revocation, expiry and tunnel loss using the actual
shared handler with socket injection or separately approved loopback/phone checks.

### 2. Docker request confirmation and original project binding

In parent-owned `packages/daemon/src/docker.ts`, add `confirmOptions: ['approve']` and an
`expiresAt` to newly created Docker Decisions. Store the original project/Compose namespace
alongside the exact container/action; reject old unbound records. For example:

```ts
const namespace = this.d.config.project.docker_project ?? this.d.config.project.name;
const expires = this.d.now().getTime() + 120_000;
// Add to the new Decision:
confirmOptions: ['approve'], expiresAt: new Date(expires).toISOString(),
// Private pending record:
{ id, action, project: this.d.config.project.repo, namespace, expires, consumed: false }
// Extend the pending record type, and validate before target(), then again after awaiting it:
if (a.project !== this.d.config.project.repo ||
    a.namespace !== (this.d.config.project.docker_project ?? this.d.config.project.name)) {
  throw new Error('Docker project changed. Request a fresh Decision.');
}
// Use the injected daemon clock for expiry as well:
if (a.consumed || a.expires <= this.d.now().getTime()) throw new Error('Approval expired or consumed');
```

Keep the existing ID/Compose-label target check, concurrent-answer recheck and atomic claim.
Create new requests after the patch; current records intentionally remain refused by the phone.
Retest no-confirmation, foreign project/namespace, expiry, drift, concurrent approval and replay
with an injected Docker executor. No real container operation is authorized by this handoff.

### 3. Connector request confirmation

In parent-owned `packages/daemon/src/connectors.ts`, add `confirmOptions: ['approve']` to the
Decision created in `requestActivation`. Keep its exact config/action/project hash and expiry
checks and its existing `answerAtomic`. When reusing a pending Decision, return it only if
`this.d.decisions.needsConfirmation(existingDecision, 'approve')`; otherwise retire it as
`superseded` and create a fresh request. This supplies the nonce used by current prepare/respond.
Retest actual phone activation/denial with an injected connector executor after the parent patch.
No notification send authority may be derived from any connector activation.

### 4. Browser auth identity, cached scope and disconnected state

Current shared `web/src/lib/remote.ts` collapses local 403, unpaired/revoked 401, all other failures
and network loss to `session = null`, while `can(null, scope)` returns true. Its subscription
snapshot is only `session`, so changing `checked` with null → null cannot notify React.
Server gates still refuse unauthorized operations, but client management/navigation can look local.
Add explicit `checking|local|paired|unauthorized|offline` identity and publish a revision snapshot:

```ts
let revision = 0;
const emit = () => { revision++; for (const l of listeners) l(); };
// Inside useRemoteSession, subscribe using () => revision, not () => session.
// Return { session, checked, mode }.
// loadRemoteSession classification after reading response JSON:
if (res.ok) { session = body; mode = 'paired'; }
else if (res.status === 403 && body.error === 'Not a phone session') {
  session = null; mode = 'local'; // authenticated local-only handler response
} else { session = null; mode = 'unauthorized'; }
// On fetch failure: mode = 'offline'; preserve last paired identity/grants for display only.
// Every branch sets checked and calls emit; 401/403/429 action responses refresh auth identity.
```

Shared `can` must allow local actions only for proven local identity; all mutation UI stays
blocked while checking/offline/unauthorized. On socket 4001, discard phone state, run/live caches
and cached grants before reauthentication; ordinary socket close/reconnect must also refresh
session/scopes before reconnecting. Do not cache credentials or approvals in storage/service worker.
Phone/Remote pages should use that revised identity to show auth/offline state and withhold actions.
Test the initial null snapshot, pairing after mount, expiry/revocation and scope reduction/reconnect,
403 local identification, unreachable daemon and previously paired offline state.

The shared API mutation-fetch catch currently says “Nothing was sent” even when a response was
lost after acceptance. Use factual uncertain-receipt wording, e.g.:

```ts
throw new ApiError('Could not confirm the result. Receipt is unknown and nothing is queued. Reload Decisions before trying again.', 0);
```

Do not automatically retry. In shared DecisionCard, clear prepared confirmation on going offline,
authorization loss, Decision change/closure or action hash change; keep daemon expiry/nonce checks.

### 5. Shared inbox navigation and completed live previews

Primary PhoneShell is reported corrected by the parent: paired phones hide forbidden routes,
and local desktop narrow navigation retains all local routes. It was left unchanged. If porting
to this delegated tree, preserve that parent implementation. NotificationInbox currently has its
own unconditional Open links. Replace its helper with scope-aware destinations and use the new
auth identity to distinguish paired/unpaired/offline/local:

```ts
// n is NotificationRecord; session is the validated paired RemoteSession.
const destination = (n: NotificationRecord) => {
  if (mode !== 'local' && mode !== 'paired') return null;
  if (n.refs.decisionId || n.refs.approvalId) return !session || session.scopes.includes('decisions') ? '/decisions' : null;
  if (n.refs.runId) return !session || session.scopes.includes('transcript') ? `/runs/${n.refs.runId}` : null;
  return !session && n.refs.agentId ? `/agents/${n.refs.agentId}` : null;
};
```

`web/src/lib/store.ts` says live text clears when the message lands, but current `ingest` never
clears `liveText`. In its event loop, retire a completed assistant preview only if its final event
is at least as recent as the preview; historical replay must not clear newer in-progress text:

```ts
if (e.runId && e.type === 't.message' && e.data.role === 'assistant') {
  const preview = this.liveText.get(e.runId);
  if (preview && Date.parse(e.ts) >= Date.parse(preview.at)) {
    this.liveText.delete(e.runId);
    touchedRuns.add(e.runId);
  }
}
```

Also clear preview/cache on authorization loss/project switch. Test full live text, message
completion, a newer preview during old history replay, multi-page reconnect and seq ordering.
Owned projection tests verify grants, safe envelopes and snapshot ordering; they do not prove
this shared browser cache/UI lifecycle.

## Pending real conditions

No full suite, real shared WS acceptance, native/Rust packaging or license gates were run here.
The prior 43-test checkpoint is context, not substituted for the final 93+9 results above.
Real Safari/iOS and Chrome/Android installed PWA use, narrow-screen navigation and all input
controls, scrolling/transcript paging, screen-reader accessibility, offline/reconnect and session
identity/revocation remain unproven. Real Tailscale install/version/Serve configuration/HTTPS
termination, exact Host/Origin forwarding, secure cookies, teardown, provider status vs actual
Serve availability and independent phone reachability require separately authorized validation.
The current Tailscale probe reports backend state; it is not proof of an actual served port.
macOS permission/banner display, browser notification display, remote JSON gateway/chat receipt,
Web Push encryption/VAPID, paid/providers/keys and production/release connectivity are untested.
HTTP endpoint acceptance from an injected function proves neither external delivery nor human
receipt. Endpoint reviews grant no send permission. No held message is sent when quiet hours end.

## Source freeze

`PHONE-resumed-source.sha256` records the exact owned source/tests frozen after successful checks,
including the unchanged excluded `phone/reports.ts` as a reference. No source edits follow that
manifest. A parent patch changes the corresponding shared files and requires fresh integration
checks; do not describe this checkpoint as a finished whole product or live integration release.
