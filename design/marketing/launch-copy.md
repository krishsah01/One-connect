# One Connect — launch copy

All copy follows the brand book: sentence case, you not we, name the agent, no exclamation marks, no emoji, say the real thing.

## One-liners

- Your agents. Your subscriptions. One log.
- Run Claude Code, Codex and Cursor as a team, on the plans you already pay for.
- A local-first control center for a team of AI coding agents. Open source. Runs on your Mac.

## Site hero

**Your agents. Your subscriptions. One log.**
Run Claude Code, Codex and Cursor as a team on the plans you already pay for. Every run, decision and handoff lands in one event log on your Mac.
[Download for Mac] [View on GitHub]
Apache-2.0 with the Commons Clause · no API keys required · runs on 127.0.0.1

## GitHub README hero (replaces the first paragraph)

One Connect is a local-first control center that runs a team of AI coding agents from different vendors through the development cycle, on the subscriptions you already pay for. Each agent gets a live console. Issues, assignments, runs, branches, handoffs and your decisions are connected in one event log that survives restarts.

## Hacker News / Show HN

**Show HN: One Connect – run Claude Code, Codex and Cursor as a team on your existing subscriptions**

I kept running several coding agents at once and losing track: the coordinator did the work instead of coordinating, two agents edited the same files, one sat idle for an hour with work queued, and I had no record of who decided what.

One Connect is a macOS app (Tauri shell, TypeScript daemon, SQLite event log) that runs each vendor's official CLI under your own login, gives each agent a worktree and a Now/Next queue, routes pushes and deploys to you, and writes everything to one append-only log. It never stores vendor credentials and ships no vendor binaries; metered billing blocks dispatch by default.

It is open source under Apache-2.0 with the Commons Clause. There is an offline demo with scripted agents so you can try it without spending usage. Happy to answer questions about the adapter protocol, the kill switch, or why I chose a transactional outbox for tracker sync.

## Reddit (r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA)

Title: I built an open-source control center that runs Claude Code, Codex and Cursor as one team on the subscriptions you already have

Body: Same text as Show HN, plus: "What it is not: a model router, a paid proxy, or a way to pool accounts. One person, their own subscriptions, their own machine."

## X / Bluesky thread

1. Your agents. Your subscriptions. One log. One Connect is out: an open-source macOS control center for a team of AI coding agents.
2. Each agent runs through its vendor's official CLI with your login. Claude Code, Codex, Cursor, anything with a CLI. No API keys, no proxy.
3. Every agent gets a worktree, a live console and a Now/Next queue. When Now finishes, Next starts. Idle with work queued raises an alert.
4. Push, deploy, migrate and publish are routed to you. Answer from your phone. Every answer is recorded with its channel.
5. One append-only event log. Runs survive restarts. Tracker writes are transactional, so GitHub and Linear never drift from the board.
6. It is free and open source (Apache-2.0 with the Commons Clause). Try the offline demo first: pnpm demo. Link in the next post.

## Product Hunt

Tagline (60): Run your AI coding agents as a team on your own subscriptions
Description: One Connect is a local-first macOS control center for a team of AI coding agents. Claude Code, Codex and Cursor run through their official CLIs under your logins, each with a worktree, a live console and a Now/Next queue. Pushes and deploys come to you, even on your phone, and everything lands in one event log. Open source, no API keys, nothing shared or pooled.
First comment: the Show HN text, shortened to three paragraphs.

## Release notes voice (example)

**0.2 · Decisions on your phone**
Approvals, questions and cost decisions now reach the phone inbox. Each answer records which channel it came from. Codex handoffs keep their worktree. The kill switch now covers every project at once.

## Email to early testers

Subject: One Connect is ready for your Mac

You asked for a way to run several coding agents without babysitting them. This is it. Download the Mac app, open a repository, sign the vendor CLIs in, and give the first agent an issue. If something stalls, the app will tell you before you notice. Reply to this email with anything that surprised you; the log will tell us exactly what happened.

## Things we never say

"We", "our platform", "AI-powered", "revolutionary", "10x", "seamless", exclamation marks, emoji, any claim about speed without a measurement, any claim that it reduces vendor cost.
