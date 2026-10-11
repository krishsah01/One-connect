# one-connect website — brief for the Figma mock

Goal: a clean, fast, non-generic single page that gets a developer to download the macOS app, says "open source" plainly, and hints at a web version without promising a date.

## Structure (desktop 1440, phone 390)

1. **Nav**: wordmark left; "Docs", "GitHub" right; one primary button "Download for Mac". Sticky, `surface` at 88% with blur, hairline `border` below.
2. **Hero** on `bg`: `display-xl` headline, one sentence of body in `text-2`, primary "Download for Mac (Apple silicon)" + ghost "View on GitHub". Right: the app in night mode, real screenshot of Mission Control, in a `radius-xl` frame with `shadow-3`. One pop block (`coral`) peeks behind the frame; nothing else decorative.
   - Headline: **Your agents. Your subscriptions. One log.**
   - Body: Run Claude Code, Codex and Cursor as a team on the plans you already pay for. Every run, decision and handoff lands in one event log on your Mac.
3. **Proof strip**: three short facts in `caption`/`overline`: "Apache-2.0 with Commons Clause" · "No API keys required" · "Runs on 127.0.0.1".
4. **Why** section: the README's failure-mode table reduced to four cards (`Card`, `radius-md`): The coordinator did the work · Silent stalls · Tracker drift · Usage-limit surprises. Each: one line of the failure in `text-2`, one line of what One Connect does in `text`.
5. **Bring your own subscriptions**: a row of vendor chips (`Chip`, grape when selected): Claude Code, Codex, Cursor, Antigravity, any CLI. Copy: "Official CLIs, your logins. One Connect never stores vendor credentials."
6. **Open source** block on `surface-2`: the repo card (stars, licence, last commit) and the quick-start command in `mono` inside a `radius-md` code block. Button "Star on GitHub" (secondary). One line: "Built in the open. Issues and PRs welcome."
7. **Phone**: half-width image of the phone inbox; copy: "Answer approvals from your phone."
8. **Download** section: large primary button, requirements (macOS 12+, Node 24+, pnpm, git), and the soft hint in `text-3`: "Web version: in the works." No date, no waitlist form yet.
9. **Footer**: wordmark mono, Docs, GitHub, Licence, Security. No social icons wall.

## Tokens to use

Grounds `bg`/`surface`/`surface-2`; text `text`/`text-2`/`text-3`; primary `accent` + `on-accent`; one `coral` block in the hero; `sun` only as the "new" marker on the download button; `radius-xl` for frames, `radius-md` for cards; spacing `space-12` between sections on phone, `space-16` on desktop. Night and light both; night is the default screenshot theme.

## Not in the mock

No testimonials, no logos of companies, no pricing (it's free), no animated hero. Motion limited to the toggle demo if one appears.
