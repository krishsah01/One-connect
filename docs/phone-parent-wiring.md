<!-- SPDX-License-Identifier: Apache-2.0 -->
# Parent wiring for phone Decisions and message delivery

All changes below are snippets for shared files. The phone worker edits only its owned files.

## Decisions.respond

The existing `notify:decision:` binding handles endpoint reviews and individual messages. It must be awaited:

```ts
if (this.d.notifications.isEndpointDecision(id)) {
  const notification = await this.d.notifications.resolveEndpoint(id, answer, actor, o);
  return { decision: this.d.state.decisions[id], notification };
}
```

`isDeliveryDecision(id)` distinguishes individual messages for the phone gate. Legacy standing approvals are refused. The dispatcher atomically answers and claims the binding before any await, consumes it after the attempt, and never retries. Endpoint reviews consume locally without sending or granting a host. The phone gate now accepts project kinds `question`, `merge`, `docker`, `environment`, `release`, `cost`, `settings`, `connector`, and exact notification deliveries under `decisions`. Only `remote` requires both `decisions` and `remote_decisions`. Endpoint review Decisions remain local.

Keep `agent-cost:` and `settings:decision:` in the bound-action router and missing-binding guard. Keep credentials and remote management out of settings action approvals; the phone grant authorizes an exact project security decision, not these broader operations. Do not fall through to an ordinary question answer for any missing specialized binding.

## Exact notification egress

Do not add notification hosts to `egress.allowed`. `Notifications.hosts()` deliberately returns an empty array. The JSON adapter passes an opaque `notificationPermit` with the exact POST. Add this optional verifier to shared egress:

```ts
export type Fetch = (url: string, init?: RequestInit & {
  notificationPermit?: string;
}) => Promise<Response>;

export interface Egress {
  // existing fields ...
  authorizeNotification?: (token: string, url: string, init?: RequestInit) => boolean;
}
```

Inside `createEgress`, keep the returned object in a variable so the fetch closure reads the current verifier. A provided permit MUST be verified even for an otherwise configured host; an invalid permit cannot fall back to ordinary host permission.

```ts
const egress: Egress = { fetch: guarded, allowed, log };
// Within guarded, before audit and underlying fetch:
const token = init?.notificationPermit;
const ok = token !== undefined
  ? Boolean(egress.authorizeNotification?.(token, url, init))
  : isAllowed(u);
// Record the existing log entry with ok and purpose `notification delivery` for a permit.
if (!ok) throw new EgressDenied('Outbound request is not authorized');
const { notificationPermit: _permit, ...request } = init ?? {};
return underlying(url, { ...request, redirect: 'error' });
```

After constructing Notifications (or when recreating egress), wire:

```ts
this.egress.authorizeNotification = (token, url, init) =>
  this.notifications.takeEgressPermit(token, url, init);
```

`takeEgressPermit` deletes the opaque permit before checking it, then verifies process, pending claim, config revision/hash, URL, method, content type, exact payload and quiet hours. It never authorizes a second request or another URL. Until this shared wiring is applied, unconfigured gateway hosts fail closed under the original egress guard. Loopback fixtures can still exercise the existing guard without any live network.

## Shared Decisions UI

Phone.tsx already wraps cards in target-level scope checks. Apply the same check on the shared `/decisions` page if it is used by a phone. Prefer using the server-projected state below, which removes inaccessible Decisions. For the notification result, replace “Endpoint decision recorded” with a factual message such as “Notification Decision recorded. See its audit outcome for the delivery result.”

## Shared WebSocket projection

HTTP state and answer/history projections are already wired by the owned phone hooks. Raw WebSocket snapshots/control events in `server/http.ts` need this parent edit. In the socket's `send` helper, project each message before serialization (use the effective scopes already captured in `principal`; scope reductions now close sockets so reconnect reauthenticates):

```ts
const send = (message: unknown) => {
  const messages = principal
    ? d.remote.projectMessages(message, principal.scopes)
    : [message];
  for (const m of messages) {
    if (socket.readyState === 1) socket.send(JSON.stringify(m));
  }
};
```

This replaces the earlier single-snapshot snippet. `projectMessages` preserves approved live transcript and local notification events (which the browser banner listener needs) and then sends the current safe snapshot. It never replays arbitrary control/configuration events. Sending the snapshot last also preserves the current sequence after a transcript history batch.

Keep the existing transcript grant on `live` and `subscribe_run`. A phone must never receive raw config or connector events, including initial snapshots and reconnect replay. The projection emits status, scoped Decisions and bounded queue/run state; credentials, executable agent/config fields, vault/context and connector management remain hidden. Phone hooks also strip specialized configuration objects returned by action executors.

## Shared PhoneShell navigation (outside phone worker write scope)

The onboarding worker requested this shared menu follow-up; PhoneShell.tsx remains untouched by the phone worker. Paired phones should expose only their granted home/phone, Decisions, Reports and run views. Preserve all routes on the narrow desktop/local menu, including `/release`, `/settings`, `/designer`, `/mocks`, `/skills`, `/connectors` and `/projects` (add these to the current MENU if absent).

In PhoneTabBar, derive and use filtered lists instead of directly mapping TABS/MENU:

```tsx
const phoneRoute = (to: string) => !session || (
  (['/', '/phone', '/reports'].includes(to) && session.scopes.includes('read')) ||
  (to === '/decisions' && session.scopes.includes('decisions')) ||
  (to.startsWith('/runs/') && session.scopes.includes('transcript'))
);
const tabs = TABS.filter(t => phoneRoute(t.to));
const menu = MENU.filter(([to]) => phoneRoute(to));
// map tabs and menu; suppress the agent detail links for session !== null.
// Optionally add recent run links from state.runs only with transcript scope.
```

Phone.tsx now shows agent names as plain status labels for paired sessions, with direct run links only under `transcript`. NotificationInbox.tsx is also shared: its Open link should use the same grants (Decision links only with `decisions`; run links only with `transcript`; agent detail links only when no phone session). A phone may still acknowledge alerts with `read`.
