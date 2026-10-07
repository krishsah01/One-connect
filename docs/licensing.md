# Licensing

## Current choice: Apache License 2.0

The license lives in one place: the root `package.json` `"license"` field. Everything else is derived from it and checked in CI:

- `LICENSE` and `NOTICE`;
- the SPDX header on every source file (`pnpm spdx:check`);
- the `license` field of every package manifest;
- the dependency compatibility gate and generated `THIRD_PARTY_NOTICES.md` (`pnpm license:check`, allowlist in `license-policy.json`).

The inventory also includes the native Cargo dependency tree, and CI checks the Rust manifest and SPDX headers. Run `cargo fetch --manifest-path packages/desktop/src-tauri/Cargo.toml --locked` before generating notices on a fresh checkout.

Some native dependencies use MPL-2.0. Mozilla explicitly permits combining MPL and Apache code, with source availability obligations for the MPL portions. The engine bundle includes these crates’ unchanged sources and original notices, and the inventory links their exact upstream versions. See [Mozilla’s MPL FAQ, Q8 and Q13](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). GPL/AGPL and unknown runtime licenses remain outside the Apache allowlist. License expressions are checked with both AND and OR semantics.

To switch before the first public release:

```bash
node scripts/set-license.mjs MIT
node scripts/set-license.mjs AGPL-3.0-only --text agpl-3.0.txt
pnpm license:notices && pnpm license:check && pnpm spdx:check
```

## Trade-offs

| | Apache-2.0 (default) | MIT | AGPL-3.0 |
|---|---|---|---|
| Permissive (use in closed products) | yes | yes | no: modified versions offered over a network must publish source |
| Explicit patent grant from contributors | **yes** | no | yes (GPLv3 patent clause) |
| Patent retaliation (sue → lose license) | yes | no | yes |
| NOTICE and change-marking duties | yes (light) | no | yes |
| Keeps hosted forks open | no | no | **yes** |
| Corporate adoption friction | low (well understood) | lowest | high (many companies ban AGPL) |
| Compatible dependencies | permissive; no GPL/AGPL in the build | permissive | permissive + GPL/AGPL |

**Why Apache-2.0 here.** The tool is meant to be adopted by individuals and companies. The patent grant matters for a project that wraps many vendors' tools. Apache-2.0 is permissive like MIT, and the explicit patent terms are what corporate legal reviews look for.

**When to choose AGPL instead.** If the priority is that anyone hosting a modified control center as a service must share their changes, choose AGPL, and accept that many companies won't use it.

**When to choose MIT instead.** The shortest and most familiar license, but no patent grant.

## Contributions

Contributions come in under the project license with a DCO sign-off (see [CONTRIBUTING.md](../CONTRIBUTING.md)). There is no CLA, so relicensing later needs agreement from contributors. That's another reason to settle the license before the first public release.
