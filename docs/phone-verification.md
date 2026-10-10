# Phone, reports and benchmark: verification matrix

Verified means an automated test in this repository passed against loopback fixtures. Nothing below was exercised on a real phone, a real tailnet, or a real push or chat provider.

| Area | Verified here (fixture) | Not verified |
|---|---|---|
| Remote access off by default, dry run, per-launch Decision with second confirmation | `phone-remote.test.ts` | Real Tailscale Serve start/stop on a live tailnet; Tailscale ACL behavior |
| Single-use expiring pairing, brute-force lock, session cap, scope enforcement, CSRF/Origin, WebSocket Origin, revocation closing sockets, project isolation, idle timeout, tunnel loss, audit without secrets | `phone-remote.test.ts` | Real browsers' cookie handling over HTTPS (`__Host-`/`Secure`); real network latency |
| Tailscale adapter argv, no Funnel, detect/plan never execute | `phone-remote.test.ts` (fake exec) | The real CLI's output format across versions |
| PWA manifest, real PNG icons, offline page, service worker caches nothing but the shell | `pwa.test.tsx` | Installation on iOS/Android/desktop browsers; display of icons; real offline behavior on a device |
| Offline refuses changes, CSRF header, two-step kill switch, Decision second confirmation, fragment token removed and posted once | `phone.test.tsx` | Touch ergonomics, VoiceOver/TalkBack, safe-area rendering on devices |
| Notification derivation, dedupe/cooldown, quiet hours, redaction, minimal payload, endpoint Decision, rejection and expiry | `phone-notifications.test.ts`, `phone-policy.test.ts` | Real macOS banners (permission unknown), browser Notification display, real push/chat providers |
| Brief, Timeline, morning report, standup: filters, event/SHA links, agent-reported vs recorded, gaps, release/infra events by shape | `phone-reports.test.ts` | Real release-cockpit events beyond the shapes read here |
| Context benchmark: accuracy, citation integrity, abstention, scope probes, version change, incremental invalidation, API run | `context-benchmark.test.ts`, CLI run | Real Graphify (only a fake CLI was used), local embeddings, large real projects, answer quality judged by a model |

Fixes found while building the benchmark: Dictionary notes embedded the commit SHA in every file's first passage, so every commit invalidated one passage per file (52 of 93 reused); the SHA now lives only in the registry and status (88 of 93 reused, guarded by a benchmark check). The managed parent folder listed as a context folder and a sibling project's notes stay unreadable, and the benchmark keeps probing that.
