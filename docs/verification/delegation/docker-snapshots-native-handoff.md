# Docker build approval TOCTOU follow-up

Workspace: `/private/tmp/one-connect-cursor-Bu9W8J/projects-docker`
Starting/current HEAD: `4b54d7cf3d71879a11562ac86df5ca599480295b`
No commit, installs, real Docker commands/images, network integrations, publishing or agent spawning. All source edits are in this isolated workspace. `HANDOFF.md` and the original coordinator `docs/verification/delegation/REVIEW_NOTES.md` were read only; the pre-existing intent-to-add `HANDOFF.md` is not part of this delta.

## Changed files

- `packages/daemon/src/environment/workbench.ts`
  - Approval digest includes scoped context paths, entry hashes, executable bits/empty directories and auxiliary env/config/secret file hashes. Buffers captured once are used for hashing and snapshot materialization; Docker never reopens repository build inputs.
  - Recheck binding before Docker availability calls and again after their awaits. Snapshot only the approved services/resources; preserve the repository project directory/identity, project named volume namespace and repository-relative bind/env/build resolution.
  - Read-only private snapshots relocate contexts, custom Dockerfiles and explicit env/config/secret files. Empty CLI env file and a restricted subprocess environment disable implicit `.env`, Compose overrides/profiles and inherited settings. `up`/`restart` use `--no-deps`; `up` remains `--no-build --pull never`. Default service scope excludes inactive profiles.
  - Fail closed for path escapes, included symlinks/hardlinks/special files/secret inputs, unbounded contexts, unsafe host mounts, nested bind symlinks/sockets/special files, host namespaces, privileged settings, capabilities/devices, external volume/network drivers, and unresolved/unsupported input sources. Build/pull retain explicit network approval; a build cannot forward SSH/secrets, extra contexts, caches or insecure entitlements.
  - Local endpoint check observes `DOCKER_CONTEXT` precedence over `DOCKER_HOST`.
  - Snapshot cleanup on success/failure/timeout/abort, concurrency guard during resolution, task-aware close, durable restart interruption state and abandoned snapshot removal. Aborted clients have unknown exit code and never claim Docker engine success; no action is replayed.
- `packages/daemon/src/environment/compose.ts`
  - Bounded descriptor capture with `O_NOFOLLOW`, inode/metadata checks before/after reads and ancestor checks; `readBounded` now uses it.
  - Scoped path validation, a conservative documented `.dockerignore` matcher and private build path filter.
- `packages/daemon/test/environment.test.ts`
  - 64 direct protocol-fixture tests. Covers image/command/mount/port/env mutations, Dockerfile/context content/add/delete/mode/path/ignore mutations, replacement during descriptor open, harmless repository mutation at the actual execution boundary, relative custom Dockerfile/env/bind/volume semantics, default profiles, no dependency widening, secret/escape/resource limits, local endpoint controls, concurrent resolution, engine failure, throw/timeout cleanup, Postgres private secret snapshots, SQLite, shutdown and crash recovery.
  - Fixes fixture setup to always use a disposable explicit data directory and `server:false`; it needs neither app-data writes nor a listener.
- `packages/daemon/test/fixtures/environment-node24.mjs` (new)
  - Direct strip-only runtime fixture, bypasses Vitest transformation. Imports the real daemon/environment, prepares/approves a build against an in-process Docker protocol fixture, changes harmless repo files at execution, verifies exact approved bytes and cleanup. No Docker subprocess or listener.
- `docs/desktop.md`
  - Documents captured inputs, limits, supported Compose/ignore subset, path and live bind semantics, explicit network approval and honest interrupted state.
- `SUBAGENT_HANDOFF.md` (this file)

`database.ts` is unchanged; the current local Postgres/SQLite wizard, 0600 original password files, loopback ports, namespace and project identity remain.

## Verification

Installed Node 24 runtime: `/Users/krishkumarsah/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` (`v24.19.0`). All commands explicitly ran with the assigned workspace as `workdir`.

- Node 24 `node_modules/vitest/vitest.mjs run --project daemon packages/daemon/test/environment.test.ts --project web packages/web/test/workbench.test.tsx`: **2 files / 69 tests passed** (64 daemon, 5 web).
- Node 24 `node_modules/typescript/bin/tsc -p` for `packages/core/tsconfig.json`, `packages/daemon/tsconfig.json`, `packages/web/tsconfig.json`: **all passed**. Final daemon check also passed after the last safety changes.
- Actual Node 24 `packages/daemon/src/cli.ts help`: **passed**.
- Actual Node 24 `packages/daemon/src/cli.ts project inspect --dir /private/tmp/one-connect-cursor-Bu9W8J/projects-docker`: **passed**, JSON `ok:true`, correct root/HEAD/branch.
- Actual Node 24 `packages/daemon/test/fixtures/environment-node24.mjs`: **passed**, strip-only approval/build race/cleanup. The existing daemon shutdown timeout keeps the process alive briefly after the fixture prints; it exits normally.
- `git diff --check`: **passed**.

An initial fixture run exposed the old helper's `dataDir:undefined` default and unnecessary local server; sandbox rejected app-data chmod/listen. The environment test setup above fixes this, and final runs require no escalation. No real Docker smoke was run (explicit task constraint); fixture results do not attest live Docker/BuildKit behavior.

## Integration with parent's Decisions / phone routing delta

Parent owns optional fourth `AnswerOptions` on `resolve`, `Decisions.answerAtomic`, decision `kind:'environment'` and `confirmOptions:['approve']` for down/pull/build. This isolated baseline does not contain that new Decisions API. Preserve/add those fields during integration; do not replace parent's approval work with the older three-argument/direct-commit API in this delta.

Inside `resolve`, replace the remaining direct `decision.answered` commit and its bound `env-action:<id>` update with parent's atomic answer API, retaining the captured `execution` record and `consumed:true` in the same atomic transaction. Keep the two binding checks, local endpoint/expiry/closing checks, resolution guard, and snapshot ownership `try/finally`. A refusal/atomic-answer error must remove any materialized snapshot; only a successfully answered action hands cleanup to `runJob`. Adapt fixture confirmations to the parent's added AnswerOptions requirements if enforced. Parent handles merge conflicts; no original checkout was edited here.

## Supported limits / boundaries

The workbench intentionally refuses unsupported Compose interpolation/inherited environment/build arguments rather than evaluate mutable host values. Explicit literal env files retain Compose parsing; `format:raw` and escaped container variables work. `.dockerignore` supports root-relative literals, `*`, `?`, `**`, ordered `!`; unsupported classes/backslashes fail closed. Dockerfile-specific ignore policy wins. Combined context/auxiliary cap: 2,000 entries / 64 MiB, 8 MiB per context file; configuration/Dockerfile/auxiliary files 256 KiB each; traversal bounded at 20,000 entries. Broad contexts must explicitly ignore private directories/files or be narrowed. Secret detection is conservative and cannot prove arbitrary source has no sensitive information.

Runtime repository bind mounts remain live, with their original read/write semantics, as requested. The immutable boundary covers executable configuration and build/auxiliary input bytes; it does not snapshot bind-mounted application data or attest Docker engine completion after client interruption.
