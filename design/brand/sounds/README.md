# Brand sounds

Generated with ElevenLabs Sound Effects v2 on the flow **One Connect — brand sounds**
(https://elevenlabs.io/app/flows/tkUDbRK2gmfzAdzPi6kv). Four takes of each were generated; the first take of each is saved here and in `packages/web/public/sounds/` (generation
ids below). Swap a take on the flow and re-save if another sounds better. The app plays them from `/sounds/` (see `packages/web/src/lib/sounds.ts`).

| File | Moment | Spec |
|---|---|---|
| `install-complete.mp3` (take 1: QLay7BRlrTza3QbpUzrO) | The app finished installing or updating (Tauri updater "ready"). | 1.2s, two marimba notes rising a fifth, short tail. |
| `first-open.mp3` (take 1: z8qXNdZTgHl1yjfdMzbt) | First launch only, with the welcome screen's mark reveal (see Motion: first run). | 2.0s, three-note glassy arpeggio resolving to one tone. |
| `needs-you.mp3` (take 1: vuTlANLHe5ciiHguN5Jd) | An approval, question or decision arrives. | 0.9s, one wooden bell tap and a two-note kalimba flick. |
| `run-done.mp3` (take 1: VrpBzJjRuBKFeOspblZ1) | An agent run finishes. | 0.7s, one rounded marimba note. |
| `alert.mp3` (take 1: YYMFeUhDO0EGBWTdR7ku) | A critical alert (stall, kill switch). | 0.8s, two low wooden knocks. |
| `toggle-tick.mp3` (take 1: ZATU8N7Q8880TC3hTeCa) | The toggle lands, on and off. Off by default; a Settings → Appearance switch enables UI sounds. | ≤0.5s, one soft felt click, no ring-out. |

Wiring: `packages/web/src/shell/Shell.tsx` plays needs-you / run-done / alert when the respective counts rise; the setup flow ticks between steps and plays first-open on finish.

Rules: no sound loops, nothing plays on every launch, every sound respects the system's "play user interface sounds" setting
and is silenced under reduced motion. Volume ceiling −14 LUFS short-term, peak −1 dBTP. Convert the picks to `.m4a` (AAC
128k) for the Tauri bundle and keep the `.mp3` as the source.

Brand kit in ElevenLabs: **One Connect** (palette, voice rules, colour rules) for any further generation.
Pending: a brand voice for the launch video, which needs the owner's own description of the voice and the exact line it should read.

The ElevenLabs brand kit cannot hold audio items, so the picks live on the flow; the storyboard video uses them from there.

`teaser-vo-take1.mp3` is take 1 of the teaser voiceover (library voice "Justin Case", 21.6s), muxed into `design/marketing/teaser.mp4`.
