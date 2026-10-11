# Launch video — 45 seconds, storyboard for the full ElevenLabs connector

`teaser.mp4` (42.6s, 1920×1080) is the assembled teaser: storyboard cards, first-open sound, voiceover take 1 and the install chime. A generated-footage version needs the full ElevenLabs connector (https://api.elevenlabs.io/v1/mcp); this shot list and script drive that flow.

Format: 1920×1080 and 1080×1350. Night theme throughout. No music bed until the last five seconds. Voiceover: four takes recorded on the brand-sounds flow (node jCWHDM3HP2wmt4UBmxUo) with the library voice "Justin Case" (warm, plain-spoken product explainer). A designed brand voice can replace it once the owner supplies the line and the voice description. Mux the chosen take over `teaser-silent.mp4` with ffmpeg: `ffmpeg -i teaser-silent.mp4 -i vo.mp3 -c:v copy -c:a aac -shortest teaser.mp4`.

| t | Shot | Voice |
|---|---|---|
| 0–4s | Black. The mark's hub appears, then the two agents snap in with the struts (duration-slow, ease-spring). First-open sound. | — |
| 4–10s | Mission Control: three agents running, one badge "needs you". | You already pay for Claude Code. And Codex. And Cursor. |
| 10–17s | Work board: an issue dragged from Ready to an agent; Now/Next fills. | One Connect runs them as a team. Each one gets a worktree, a console and a queue. |
| 17–24s | A push approval arrives on the phone; thumb taps Approve. | Pushes come to you. Even on your phone. |
| 24–31s | The event log scrolling: run started, review opened, decision recorded. | Everything lands in one log that survives restarts. |
| 31–38s | Terminal: `pnpm demo`; scripted agents start. | Try it without spending a token. |
| 38–45s | Wordmark on ink. "Download for Mac". "Open source." Install chime. | One Connect. Your agents, your subscriptions, one log. |

Rules: no stock footage, no cursor zooms, no kinetic typography. Cuts on the beat of the UI, not of music. Captions always on.
