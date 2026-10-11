# Connect your subscriptions

The control center runs each agent through its vendor's **official** tool, signed in with **your** account. It never sees your credentials: it only asks the tool whether it is logged in.

**Check your own plan's terms for automated use.** This tool is meant for one person using their own subscriptions on their own machine. Never share, pool or resell access.

## Personal use or API keys only

Vendors let a person sign in to their own, unmodified CLI with their own plan. Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says so explicitly. It also says that products must not route other people's requests through a Free, Pro or Max plan, and must not collect or store Claude.ai credentials or session tokens.

Settings → *Accounts & vendor terms* sets `policies.accounts.mode`:

| Mode | Use it when | Subscription logins |
| --- | --- | --- |
| `personal` (default) | Only you use this install, on your own Mac | Allowed after your own-account confirmation |
| `api-keys-only` | Other people use it, you host it, or you run it for customers | Refused at dispatch; each agent uses its vendor's API key, billed to the key owner |

```yaml
policies:
  accounts:
    mode: personal            # or api-keys-only
    terms_max_age_days: 90    # re-confirm own-account use this often
    api_key_rotation_days: 90 # reminder to rotate stored keys (never blocks)
```

## Own-account confirmation

Before the first dispatch, a subscription agent needs your confirmation, once per vendor login, in Agents & sign-in. You confirm that:

- the login is your own, and you signed in through the vendor's own flow;
- only you use it through One Connect, and any paired phone is your own device;
- you run the vendor's CLI unmodified, and nobody copies its login tokens;
- you read the linked vendor terms, and your use fits them.

The confirmation is recorded as an audited event and is kept across restarts. It stops counting when:

- it is older than `terms_max_age_days` (a reminder appears 14 days before);
- the vendor terms revision One Connect links to changes;
- a different account signs in to that CLI, for CLIs that report the account (Claude Code, Cursor);
- you withdraw it, or the workspace is set to `api-keys-only`.

One Connect stores only an opaque fingerprint of the signed-in account and a masked label (for example `kr…@gmail.com`). It never reads the CLI's credential files or tokens. It can only be done at the Mac: a paired phone cannot record or withdraw it.

On macOS, each probe also checks the CLI's code signature: Anthropic PBC for Claude Code, OpenAI for Codex. A broken signature, or one from another developer, blocks dispatch. An unsigned launcher, such as an npm shim, only warns. Cursor ships its CLI unsigned, so it is not checked.

Every 15 minutes, a background watch asks each idle subscription CLI whether it is still signed in, and re-checks the agent when the login or the account changed. An expired login raises an alert and blocks dispatch.

## Setup steps

For every vendor:

1. **Choose a harness and install it from the vendor.** Agents & sign-in lists each vendor's official install commands. On the Mac app, *Prepare in terminal* puts the command in your project terminal, and nothing runs until you press Return. One Connect never bundles or downloads a vendor tool.
2. **Log in** with the vendor's own command, or choose *Use an API key instead*.
3. **Verify the plan.** In the Agents page, Billing should say *included plan*.
4. **Turn paid overage off** in the vendor account: extra usage, on-demand billing, credits auto-recharge. The control center stops a run when a vendor *reports* overage in use, but it can't see every account setting.
5. **Confirm own-account use** (see above), then **record your payment confirmation** in Agents & subscriptions when the official CLI cannot expose those settings. Dispatch stays blocked until you check the signed-in account and confirm that paid overage, purchased credits and auto-recharge are off. This is your attestation; the vendor setting continues to display *unknown*. It applies only to this agent, its current runtime/login observations and this daemon session, for at most 12 hours. A fresh probe, changed runtime/login/configuration, restart or expiry requires confirmation again. Re-check after changing vendor accounts: providers that do not expose account identity cannot be monitored for a silent account switch.

## Claude (Pro / Max) → Claude Code

- **Install:** `curl -fsSL https://claude.ai/install.sh | bash` (or `brew install --cask claude-code`, or `npm install -g @anthropic-ai/claude-code`). See https://code.claude.com/docs/en/setup.
- **Log in:** `claude auth login`, then check with `claude auth status` (`"authMethod": "claude.ai"` means subscription).
- **Overage:** claude.ai → Settings → Usage → *Extra usage*. Keep it off. During runs Claude Code emits `rate_limit_event` with the 5-hour and 7-day windows plus the overage status. The control center shows these as usage meters, and **stops the run if overage is in use** without `metered_opt_in`.
- `ANTHROPIC_API_KEY` and the Bedrock and Vertex variables are stripped from agent runs.
- **API key route:** model source *Anthropic API key*, with the key stored under API keys (Keychain).

## ChatGPT (Plus / Pro / Team) → Codex CLI

- **Install:** `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (or `brew install --cask codex`, or `npm install -g @openai/codex`). The ChatGPT desktop app may bundle a newer `codex`; the onboarding shows every copy, and you pin one with `binary:`.
- **Log in:** `codex login` → *Sign in with ChatGPT*, then check with `codex login status` ("Logged in using ChatGPT").
- **Models:** read from `codex debug models`, which is the CLI's own catalog.
- **Usage:** 5-hour and weekly windows, read from the `rate_limits` Codex records in the session files of runs the control center started. Other sessions are never read.
- **Overage:** if you bought Codex credits, check that auto-recharge is off.
- **API key route:** model source *OpenAI API key*, billed separately from ChatGPT.

## Cursor (Pro) → Cursor agent CLI

- **Install:** `curl https://cursor.com/install -fsS | bash` (installs to `~/.local/bin`).
- **Log in:** `cursor-agent login`, then check with `cursor-agent status`. The plan tier comes from `cursor-agent about`.
- **Overage:** on-demand (usage-based) pricing is an account setting the CLI can't report, so it shows as *unknown*. Turn it off at cursor.com/dashboard. `CURSOR_API_KEY` from your shell is stripped from subscription runs.
- **API key route:** model source *Cursor API key* (`provider: cursor-api`, `metered_opt_in: true`). Create the key under API Keys in your Cursor dashboard and store it under API keys. Only that agent's runs and probes receive it, as `CURSOR_API_KEY`.

## Google AI Pro → Antigravity, Gemini app

These are desktop and chat apps, so use `adapter: relay`. The control center gives you a self-contained prompt; you paste it into the app, then paste the reply (with its handoff block) back. Gemini CLI can also be configured as `generic-cli`.

## Opting into metered billing (not recommended)

Set `billing: metered` and `metered_opt_in: true` on that one agent. The UI then shows a red *METERED* banner everywhere that agent appears, and pre-flight warns on every dispatch.
