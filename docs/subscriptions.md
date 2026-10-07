# Connect your subscriptions

The control center runs each agent through its vendor's **official** tool, signed in with **your** account. It never sees your credentials: it only asks the tool whether it is logged in.

**Check your own plan's terms for automated use.** This tool is meant for one person using their own subscriptions on their own machine. Never share, pool or resell access.

For every vendor:

1. **Install the official tool** from the vendor. Nothing is bundled here.
2. **Log in** with the vendor's own command.
3. **Verify the plan.** In the Agents page, Billing should say *included plan*.
4. **Turn paid overage off** in the vendor account: extra usage, on-demand billing, credits auto-recharge. The control center stops a run when a vendor *reports* overage in use, but it can't see every account setting.
5. **Record your confirmation** in Agents & subscriptions when the official CLI cannot expose those settings. Dispatch stays blocked until you check the signed-in account and confirm that paid overage, purchased credits and auto-recharge are off. This is your attestation; the vendor setting continues to display *unknown*. It applies only to this agent, its current runtime/login observations and this daemon session, for at most 12 hours. A fresh probe, changed runtime/login/configuration, restart or expiry requires confirmation again. Re-check after changing vendor accounts: providers that do not expose account identity cannot be monitored for a silent account switch.

## Claude (Pro / Max) → Claude Code

- **Install:** https://docs.claude.com/en/docs/claude-code/setup
- **Log in:** `claude auth login`, then check with `claude auth status` (`"authMethod": "claude.ai"` means subscription).
- **Overage:** claude.ai → Settings → Usage → *Extra usage*. Keep it off. During runs Claude Code emits `rate_limit_event` with the 5-hour and 7-day windows plus the overage status. The control center shows these as usage meters, and **stops the run if overage is in use** without `metered_opt_in`.
- `ANTHROPIC_API_KEY` and the Bedrock and Vertex variables are stripped from agent runs.

## ChatGPT (Plus / Pro / Team) → Codex CLI

- **Install:** https://developers.openai.com/codex/cli. The ChatGPT desktop app may bundle a newer `codex`; the onboarding shows every copy, and you pin one with `binary:`.
- **Log in:** `codex login` → *Sign in with ChatGPT*, then check with `codex login status` ("Logged in using ChatGPT").
- **Models:** read from `codex debug models`, which is the CLI's own catalog.
- **Usage:** 5-hour and weekly windows, read from the `rate_limits` Codex records in the session files of runs the control center started. Other sessions are never read.
- **Overage:** if you bought Codex credits, check that auto-recharge is off.

## Cursor (Pro) → Cursor agent CLI

- **Install:** https://cursor.com/cli
- **Log in:** `cursor-agent login`, then check with `cursor-agent status`. The plan tier comes from `cursor-agent about`.
- **Overage:** on-demand (usage-based) pricing is an account setting the CLI can't report, so it shows as *unknown*. Turn it off at cursor.com/dashboard. `CURSOR_API_KEY` is stripped from runs.

## Google AI Pro → Antigravity, Gemini app

These are desktop and chat apps, so use `adapter: relay`. The control center gives you a self-contained prompt; you paste it into the app, then paste the reply (with its handoff block) back. Gemini CLI can also be configured as `generic-cli`.

## Opting into metered billing (not recommended)

Set `billing: metered` and `metered_opt_in: true` on that one agent. The UI then shows a red *METERED* banner everywhere that agent appears, and pre-flight warns on every dispatch.
