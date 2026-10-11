# Adding an agent adapter

An agent runtime is two pieces:

1. **Its profile** in `packages/core/src/adapterProfiles.ts`: the facts every package shares (display name, install page, login hint and argv, capabilities, and `runsHere: false` only for manual relay). The web reads it directly, so the setup page, login buttons and console hints need no edits.
2. **Its behavior**: one `VendorAdapter` in `packages/daemon/src/adapters/agents/` (interface in `types.ts`). Process supervision, durable logs, redaction, approvals, rules and the UI are shared, so the adapter only needs to know how to talk to its CLI.

```ts
// packages/core/src/adapterProfiles.ts  (and add 'my-cli' to ADAPTER_TYPES in config.ts)
'my-cli': {
  displayName: 'My CLI',
  installUrl: 'https://vendor.example/cli',
  loginHint: 'Run `my login` in a terminal',
  loginArgs: ['login'],                  // null when the runtime has no login of its own
  runsHere: true,
  capabilities: { headless: true, streamingInput: false, resume: true, hostApprovals: false, mcp: true },
},

// packages/daemon/src/adapters/agents/my.ts
export const myAdapter: VendorAdapter = {
  type: 'my-cli',
  ...ADAPTER_PROFILES['my-cli'],
  binaryNames: ['my'],
  knownLocations: () => ['/Applications/My.app/Contents/Resources/my'],  // app-bundled copies
  vendorHost: 'api.vendor.example',      // used for the connectivity check before a retry

  authStatus(p) {},      // { state: logged_in | expired | not_installed | unknown, fix }
  billingMode(p) {},     // { mode: subscription | metered | unknown, source, overage }
  listModels(p) {},      // from the CLI's own catalog when it has one
  usage(p) {},           // included-usage windows, or unknownUsage(…): never guess
  buildLaunch(ctx) {},   // argv / cwd / stdin mode / files (e.g. MCP config); no secrets in argv
  createParser(ctx) {},  // stdout/stderr line → Parsed[] (events, session, usage, final, failure, result)
};
```

Register it in `VENDOR_ADAPTERS` (`adapters/agents/index.ts`). If the CLI takes a tool allowlist, pre-approve the `acc` tools with `accToolPatterns()` from `mcp/tools.ts` rather than listing names.

## Rules for adapters

- **Subscription first.** `billingMode` must say `metered` whenever the tool would bill per token: an API key in use, a cloud provider, and so on. Add the tool's API-key variables to `METERED_ENV_VARS` in `env.ts` so they're stripped from runs.
- **Report the session.** If the stream exposes it, return `{ kind: 'session', apiKeySource }`; a non-subscription source stops the run. Report plan usage with `{ kind: 'plan_usage', overage }` when the vendor emits it.
- **Make it MCP-aware** when the CLI supports MCP. Pass `ctx.mcp` so the agent gets the `acc` tools, and keep the user's own MCP servers out where the CLI allows it.
- **Make sandboxed worktree commits work.** Grant write access to `ctx.gitCommonDir`; the git index for a worktree lives there.
- **Classify failures** with `classifyFailure` (network, usage limit, auth, model unsupported, sandbox denied), and add vendor phrasing to `failures.ts`.
- **Never put credentials or secrets in argv or in files you write.**

## Contract tests

1. Run one tiny real session with the vendor's CLI. Sanitize it (session ids, paths, account numbers) and commit it as `packages/daemon/test/fixtures/real/<vendor>.jsonl`.
2. Add a case to `packages/daemon/test/adapters.contract.test.ts`. The shared assertions check session, final answer, success, token usage and the assistant message.
3. Teach `examples/fake-agent/fake-agent.mjs` your output format, and add a `bin/<name>` wrapper, so the end-to-end suite can run failure scenarios for free.

## Harnesses that run a local server (OpenCode)

A vendor with a headless server instead of a CLI stream can still use this contract: the detached runner starts a small bridge that owns the server, prints one JSON line per event, and routes permission/question requests to One Connect with the per-run token in `mcp.json`. `opencodeAdapter` (`adapters/agents/opencode.ts`) is the reference: `encodeMessage` queues user messages, `encodeAbort` lets Stop/Pause abort cleanly before any signal, and a pinned protocol version fails visibly. Test it with a loopback fixture (`examples/fake-agent/fake-opencode.mjs`), never a live paid provider.
