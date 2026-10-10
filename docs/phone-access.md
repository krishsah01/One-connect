<!-- SPDX-License-Identifier: Apache-2.0 -->
# Phone access, install and alerts

One Connect's dashboard is an installable web app (PWA) that you can open from your phone through a **private, authenticated tunnel**. Remote access and outbound channels are off until you enable them. Tunnel launch requires an exact human Decision; notifications require a separate exact human Decision for each message.

## What you get on a phone

- **Now** (`/phone`): what needs you, every agent's status and included-usage meters, alerts, the kill switch.
- **Questions and Decisions** with their evidence. Anything irreversible asks for a second confirmation.
- **Live transcript** (`/runs/:id`): the full redacted run transcript, readable on a narrow screen. Reading only.
- **Brief & Reports** (`/reports`): Brief, Timeline, morning report and an exportable standup.
- A bottom tab bar and a project menu. A paired phone is bound to this one project; each project has its own daemon, cookie and pairing.

## Install as an app

The page ships a manifest, icons and an offline page. Your browser decides whether it is installed: on iPhone use Share, Add to Home Screen; in Chrome or Edge use the install icon. The Phone & alerts page shows only what the browser reports (running as an installed app, or in a tab). It cannot confirm an installation made elsewhere.

**Offline behavior.** The service worker (`packages/web/public/sw.js`) precaches only `offline.html`, the manifest and the icons. It handles nothing else, writes nothing at runtime, never sees mutations, and ignores `/api`, `/ws`, `/auth`, `/pair` and any URL carrying a token. So no API or event response, transcript, prompt, source, evidence, credential, cookie, pairing link or sign-in link is stored on the device. Offline, the app says so, every change is refused (not queued) and nothing is replayed later. The service worker never runs inside the Mac app, so the native origin/IPC boundary is untouched.

## Turn on remote access

1. Open **Phone & alerts** on the Mac and switch Remote access on. This opens nothing.
2. Review the **scopes** and limits. A phone may get: status and reports; run transcripts (which can quote source); project Decisions; engaging (never releasing) the kill switch. The project Decisions scope allows exact merge, Docker, environment, release, cost, security settings, connector and individual notification actions. Tunnel Decisions additionally require `remote_decisions`, off by default. No decision grant opens source diffs, connection or Docker management, credential access, the vault, project management or configuration routes. Adding a scope requires a new pairing; narrowing takes effect immediately and closes stale sockets.
3. **Review exact plan (dry run)** shows the commands, what is exposed, teardown, warnings and a digest. Nothing is executed.
4. **Request tunnel launch** creates a Decision bound to that exact plan (expires in 10 minutes, voided if settings change, single use). Approving needs the second confirmation. Only then does the adapter run.
5. **Create single-use pairing link**, open it on the phone. Revoke any phone or all phones at any time; disabling remote access revokes everything and stops the tunnel.

### Adapter: Tailscale Serve (private)

The adapter runs `tailscale status --json` then `tailscale serve --bg --https=<port> http://127.0.0.1:<daemon port>` and removes exactly that entry with `tailscale serve --https=<port> off`. It never uses Funnel or any public or wildcard listener (the plan is refused if it would). It changes this Mac's Serve configuration for that HTTPS port only: no ACL, key or device changes, and One Connect never installs or signs in to Tailscale. Port 8443 is the default to avoid clobbering an existing 443 entry; each project daemon needs its own port. Which of your devices can reach it is decided by your Tailscale ACLs, which One Connect cannot see.

## Security model

| Guard | How |
|---|---|
| Disabled by default | `remote.enabled` is false; no listener beyond `127.0.0.1` exists. |
| Per-launch Decision | Each launch needs a human Decision bound to the plan digest, with a second confirmation. A phone can answer only with both the project Decisions and the explicit tunnel Decisions scope. Pairing and remote management stay on the Mac. |
| Private only | The plan is validated: no `funnel`, no wildcard, forward target must be the loopback daemon. |
| Separate credentials | A request whose Host is a live tunnel name is authenticated only by a paired session. The Mac's session cookie, install token, ws tickets and run tokens are never accepted over it. |
| Pairing | 256-bit single-use token in the URL **fragment** (never sent, logged or put in Referer), expires in minutes, removed from the address bar before use, consumed once. |
| Session cookie | 256-bit, stored hashed, `HttpOnly; SameSite=Strict`, `__Host-` and `Secure` over HTTPS, named per project, session and idle timeouts, capped number of phones. |
| CSRF and Origin | Changes need `x-acc-csrf` (derived from the cookie, unreadable cross-site) and an exact Origin; sockets need the exact Origin. |
| Brute force | 5 failed pairings in 10 minutes lock pairing for 15 minutes; repeated bad cookies are rate limited. Creating a link on the Mac clears the lock. |
| Scope | Route allowlist per granted scope; narrowing applies to live sessions immediately. Project action Decisions are allowed under `decisions`; tunnel Decisions need the additional `remote_decisions` grant. Endpoint reviews remain local. Target checks also guard prepare, answer and audit history. |
| Project isolation | Sessions record the project namespace; another project's daemon does not know the cookie, and a mismatched session is refused. |
| Revocation and audit | Revoking closes open sockets. Events record config changes, launches, pairings, failures, revocations and refused requests (bounded), never tokens. |
| Honest status | Tunnel state (down, starting, up, reconnecting, error), local-daemon readiness and reachability are shown separately. "Up" is never shown as reachable until a paired phone connects. |

## Notifications

Alerts are derived from recorded events and state: stalled runs, aged approvals and Decisions, usage limits, check or infrastructure failures (including generic `release.*`, `infra.*`, `ci.*`, `deploy.*`, `code_host.*` events) and finished work. They are deduplicated per condition with a cooldown, redacted, and written to a **durable local inbox** (events). No email.

| Channel | Default | Notes |
|---|---|---|
| Local inbox | always on | Event log; survives restarts. |
| macOS banner | off | Uses `osascript` with text passed as arguments. macOS does not report permission; the page says "permission unknown" and the test button shows what ran. |
| Browser | off | The dashboard shows the alert **title** when the browser granted permission; the page shows unknown, denied or granted honestly. |
| JSON push gateway / chat webhook | off | A minimal JSON POST (id, kind, severity, short title, time). Enabling creates pending message Decisions and never sends automatically. Each outbound message needs an exact human approval and second confirmation, valid for one attempt within ten minutes. Endpoint review is local setup only. No Web Push encryption, subscriptions or VAPID is implemented; `webpush` remains the legacy storage/API key. |

Each pending message persists its channel, notification ID, exact payload and SHA-256, URL hash, full configuration hash/revision, expiry and process binding. The human answer and single-delivery claim commit atomically through `Decisions.respond` before transport. Denial, any settings change (even a change then revert), changed payload/URL, quiet hours at confirmation, expiry, replay and restart fail closed. An interrupted attempt has unknown receipt and is never resumed or retried automatically. The audit records the human answer, confirmation, result and action hash. Endpoint HTTP acceptance is not proof that a person received the message. Legacy 24-hour grants provide no authority.

Quiet hours (local or an IANA zone, may wrap midnight) hold banners, browser notifications and outbound messages; the inbox records them. Leaving quiet hours never sends held messages. On the Mac, request a fresh message Decision for a held or failed alert; a phone with project Decisions may answer that exact request. Payloads use issue keys only, never issue-title fallbacks, transcripts, prompts, source or secrets. Webhook paths stay in private pending storage, with destination host and URL fingerprint in Decision evidence.

The transport redeems an opaque one-use permit at shared egress for the exact POST. It never adds an entire notification host to the allowlist and never follows redirects. HTTP and WebSocket status projections retain actual billing, metered opt-in, on-demand, concurrency, budgets and unknown usage values while withholding executable config, assignment paths and connector management.

Protocol references: [Node fetch and AbortSignal](https://nodejs.org/docs/latest-v24.x/api/globals.html), [Fetch redirect modes](https://fetch.spec.whatwg.org/#concept-request-redirect-mode), [Web Push encryption (RFC 8291)](https://www.rfc-editor.org/rfc/rfc8291). This implementation is a JSON gateway, not RFC 8291 Web Push.

## Brief & Reports

`/api/reports/brief|timeline|morning|standup` read only the project's event log and state. No model is called. Each claim shows its basis (recorded by One Connect, agent-reported and unverified, or counted from events) and links event numbers, commands and SHAs. Absence is stated: no check results, no deploy evidence and no release events are shown as gaps, never as success. Release and infrastructure events from other modules are read by shape (plans with step statuses, health reports with component states, `status`/`ok` fields) without importing their types.

## Context-quality benchmark

`acc bench context [--graphify <bin>]` or the Dictionary page builds a disposable repo and vault, runs the real intake, and compares Dictionary retrieval, Graphify and on-demand skills with a full-context baseline on labelled questions (lookups, multi-source, version changes, abstention, scope probes). It reports bytes, **estimated** tokens (bytes/4), latency, retrieval accuracy, citation integrity and abstention, and fails on any regression. It calls no model, downloads nothing and only uses local embeddings if you pass `--embedding-model` for an already installed model. Bytes are not provider-reported tokens and a byte ratio is not proof of token savings or general quality.
