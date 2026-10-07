# Adding an agent adapter

A vendor adapter implements **one interface**, `VendorAdapter` in `packages/daemon/src/adapters/agents/types.ts`. Process supervision, durable logs, redaction, approvals, rules and the UI are shared, so the adapter only needs to know how to talk to its CLI.

```ts
export const myAdapter: VendorAdapter = {
  type: 'my-cli',                       // add it to ADAPTER_TYPES in packages/core/src/config.ts
  displayName: 'My CLI',
  installUrl: 'https://vendor.example/cli',
  loginHint: 'Run `my login` in a terminal',
  capabilities: { headless: true, streamingInput: false, resume: true, hostApprovals: false, mcp: true },
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
