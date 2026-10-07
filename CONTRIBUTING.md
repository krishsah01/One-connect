# Contributing

Thanks for helping. A few rules keep this project safe to adopt.

## Developer Certificate of Origin (DCO)

Every commit must be signed off. This certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change, or otherwise have the right to submit it under the project license.

```bash
git commit -s -m "Fix the stall detector's clock"
```

That adds a trailer matching your git author:

```
Signed-off-by: Your Name <you@example.com>
```

CI rejects pull requests that contain unsigned commits (`.github/workflows/dco.yml`). To fix a branch, run `git rebase --signoff origin/main` and force-push.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test             # core, daemon (real runner processes, fake vendor CLIs), web
pnpm spdx:check       # SPDX header on every source file
pnpm license:check    # dependency licenses vs. license-policy.json, notices up to date
pnpm demo             # daemon + UI with scripted agents; uses no subscription usage
```

Node 24+ runs the TypeScript sources directly through type stripping, so there is no build step except for the web UI (`pnpm build`). Use erasable TypeScript syntax only: no enums, namespaces or parameter properties.

## Rules of the road

- **Headers.** New source files start with `// SPDX-License-Identifier: Apache-2.0`.
- **Dependencies.** New dependencies must have a license in `license-policy.json`. Never add GPL, AGPL or SSPL code to the Apache-2.0 build. After changing dependencies, run `pnpm license:notices`.
- **No vendor binaries, credentials or private APIs.** Adapters drive official CLIs, apps and public APIs only.
- **Safety-relevant changes need tests.** That covers billing guards, approval routing, redaction, path scopes and push guards.
- **Adding an agent or tracker.** See [docs/adding-agent-adapter.md](docs/adding-agent-adapter.md) and [docs/adding-tracker-adapter.md](docs/adding-tracker-adapter.md). Every adapter must pass the shared contract suite.
- **One topic per pull request**, with a short description of the failure mode it addresses.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
