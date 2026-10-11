# Brand sounds

Generated with ElevenLabs Sound Effects v2 on the flow **One Connect — brand sounds**
(https://elevenlabs.io/app/flows/tkUDbRK2gmfzAdzPi6kv). Four takes of each; the owner picks one and saves it here under the
file name below. Nothing in the app plays until the file exists, so the pick is the only blocking step.

| File | Moment | Spec |
|---|---|---|
| `install-complete.mp3` | The app finished installing or updating (Tauri updater "ready"). | 1.2s, two marimba notes rising a fifth, short tail. |
| `first-open.mp3` | First launch only, with the welcome screen's mark reveal (see Motion: first run). | 2.0s, three-note glassy arpeggio resolving to one tone. |
| `toggle-tick.mp3` | The toggle lands, on and off. Off by default; a Settings → Appearance switch enables UI sounds. | ≤0.5s, one soft felt click, no ring-out. |

Rules: no sound loops, nothing plays on every launch, every sound respects the system's "play user interface sounds" setting
and is silenced under reduced motion. Volume ceiling −14 LUFS short-term, peak −1 dBTP. Convert the picks to `.m4a` (AAC
128k) for the Tauri bundle and keep the `.mp3` as the source.

Brand kit in ElevenLabs: **One Connect** (palette, voice rules, colour rules) for any further generation.
Pending: a brand voice for the launch video, which needs the owner's own description of the voice and the exact line it should read.
