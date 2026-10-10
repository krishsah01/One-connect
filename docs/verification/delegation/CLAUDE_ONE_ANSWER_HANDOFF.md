# One Answer completion: handoff

**Worktree:** `/private/tmp/one-connect-claude/one-answer`
**Branch:** `codex/claude-one-answer-completion`

The main checkout and the Mac app bundle were not touched. The base commit `7c18eb8` is a snapshot of the main checkout's working files (HEAD `5543b43` plus every uncommitted and untracked file) at the start. Commits are DCO-signed.

```
7c18eb8 snapshot: main checkout working files at start of One Answer work
e267aaf One Answer: durable incremental intake, structure graph, hybrid retrieval, agent context packet
14265fb One Answer benchmark: keyword-only, graph-assisted and hybrid arms; dependency, design and deleted-source questions
25e548f One Answer page, structure fixes, end-to-end demo and evidence
(final) docs, handoff, overview patch, final evidence
```

**Integrate:**

```bash
git -C /private/tmp/one-connect-claude/one-answer diff 7c18eb8 HEAD > one-answer.patch
```

Then apply it to the main checkout. Only the files listed below change, and no file outside them was edited.

## What was built

| Area | Paths |
|---|---|
| Ingestion manifest | `packages/daemon/src/context/manifest.ts` (new) |
| Intake job, generations, stages | `packages/daemon/src/context/one-answer.ts` (rewritten in place; same class and API) |
| Git blob batch reader, limits, manifests | `packages/daemon/src/context/extract-project.ts` |
| Declarative structure parser | `packages/daemon/src/context/structure.ts` (new) |
| Hybrid retrieval policy, evidence | `packages/daemon/src/context/retrieval.ts` (new), `docs.ts` (hooks, search options, verbatim long-line chunks) |
| Incremental generated-note patching | `packages/daemon/src/context/vault.ts` (`patchGenerated`, `generatedNotes`) |
| Staged, re-armable Graphify build | `packages/daemon/src/context/graph.ts` (`buildSnapshot`, `cancel`) |
| Agent context packet | `packages/daemon/src/context/packet.ts` (new) |
| Commit polling with or without Graphify; queries never force a rebuild | `packages/daemon/src/context/sync.ts` |
| HTTP routes | `packages/daemon/src/server/oneAnswerRoutes.ts` (new) |
| Benchmark arms and questions | `packages/daemon/src/benchmark/contextBenchmark.ts`, `corpus.ts` |
| UI | `packages/web/src/components/OneAnswer.tsx`, `one-answer.css` (new), `packages/web/src/pages/Docs.tsx` |
| Demo | `scripts/one-answer-demo.mjs` |
| Docs | `docs/one-answer.md`, `docs/ask-your-docs.md` |

## Shared-file integration points

All are minimal and additive.

1. **`packages/core/src/entities.ts`.**
   - `OneAnswerStatus`: new state `'cancelled'`, plus optional `job`, `stages`, `changes`, `generation` and `structure`.
   - New types: `OneAnswerStage`, `OneAnswerStageName`, `OneAnswerJob`, `OneAnswerChanges`, `DocEvidence`.
   - Optional fields: `DocSearchResult.retrieval`, `DocAnswer.evidence`, `DocCitation.via`.
   - The reducer is unchanged; it already stores `context.answer` as published.
2. **`packages/core/src/benchmark.ts`.**
   - New question kinds `dependency`, `design`, `deleted`; new arm ids `keyword_only`, `hybrid`; arm status `'pending'`.
   - Optional fields: `recall`, `answerSupport`, `resources`, `tradeoffs`, and per-row `arm`/`recall`/`support`.
   - `benchmarkRegressions` also flags graph-assisted recall falling below keyword-only.
3. **`packages/daemon/src/server/http.ts`.**
   - Imports and registers `registerOneAnswerRoutes(app, d)` (two lines).
   - Removes the 409 that blocked `/api/context/docs/ask` while an intake runs. Queries now answer from the last published generation.
4. **`packages/daemon/src/mcpBridge.ts`.**
   - New `get_project_context` case.
   - `ask_project` uses `ensureFresh()` instead of forcing `refresh()`.
5. **`packages/daemon/src/mcp/server.ts`.** Registers the `get_project_context` tool, before `ask_project`.
6. **`ContextSync`** (owned) exposes `packets: PacketBuilder`.
7. **Overview (not applied).** `docs/handoff/one-answer-overview.patch` replaces Mission Control's one-line intake summary with the reusable `OneAnswerStatusCard compact` (live progress and cancel/retry). Apply with `git apply docs/handoff/one-answer-overview.patch`.
8. **Not edited, but worth updating** (shared docs outside my scope):
   - `docs/context-sharing.md` still says graph polling happens "every minute when auto_update". One Answer now polls every 30 s regardless of Graphify, and rebuilds the graph as part of intake.
   - The assignment template could tell agents to call `get_project_context` first. It wasn't changed (it's an assignment-template file); a one-line addition to the "Shared context" section is suggested.

## Commands and actual results

All run in the worktree on Node 26.5. All were exit 0 except the one pre-existing failure noted.

| Command | Result |
|---|---|
| `pnpm -r typecheck` | core, daemon, web: Done |
| `node scripts/check-spdx.mjs` | 284 files carry SPDX Apache-2.0 |
| `npx vitest run` on `test/one-answer-incremental.test.ts`, `one-answer.test.ts`, `context-isolation.test.ts`, `docs.test.ts`, `context.test.ts`, `context-benchmark.test.ts` and `one-answer-structure.test.ts` (from `packages/daemon`) | **53 passed, 1 skipped** (the skip is the pre-existing live-Graphify opt-in) |
| `node --experimental-strip-types --test test/one-answer.strip.test.mjs` | 2 passed. The process takes about 20 s to exit; this also happens on the untouched snapshot. |
| `npx vitest run --project web` | 50 passed, **1 failed**: `harness.test.tsx` › "local Ollama is free; pay-per-token sources cannot be saved from the builder". It fails identically on the untouched snapshot `7c18eb8`; it's agent-builder/provider code, outside my ownership, and not touched. |
| `node packages/daemon/src/cli.ts bench context --json` | No regressions. Graph-assisted recall 100% vs keyword-only 94%; 1,110 vs 1,077 bytes per question. Recorded in `docs/verification/one-answer-benchmark-fixtures.json`. |
| `... bench context --graphify ~/.local/bin/graphify --embedding-model all-minilm --json` | No regressions. All arms measured, including hybrid and Graphify. 46 loopback requests and 0 off-machine. Recorded in `docs/verification/one-answer-benchmark-local-tools.json`. |
| `node scripts/one-answer-demo.mjs --graphify ~/.local/bin/graphify --embedding-model all-minilm` | All six stages current at v1 and v2. The v2 intake was incremental: 2 modified, 1 deleted, 1 renamed, 2 blobs read. 0 stale passages and 0 stale blobs remain. The deleted-doc question returns *insufficient evidence*. After restart, citations are identical with 0 re-reads, and 0 requests went off-machine. Recorded in `docs/verification/one-answer-demo.json`. |
| UI against a real daemon (in-app browser) | Screenshots in `docs/verification/one-answer-ui/`: all stages current, cited search, file viewer at cited lines, structure explorer, an automatic incremental update after a live commit (detected by polling with no click), and the agent packet preview. |

The real-tool runs used only the user's already-installed Graphify (AST mode, LLM keys stripped) and the already-installed `all-minilm` on `127.0.0.1`. Nothing was downloaded, and no project or vault of the user's was read; every corpus was disposable.

## Verified vs pending

**Verified** (by tests and the runs above):
- incremental add/modify/delete/rename;
- a policy change forcing a full rebuild and purge;
- an embedding-model change (no old vectors mixed in);
- coalescing (6 concurrent requests run 2 jobs);
- cancel mid-Graphify, with the old graph kept as stale;
- partial-stage failure and recovery without re-reading Git;
- interrupted-intake resume after restart;
- verbatim citations for wrapper and long lines, and idempotent re-citation;
- forged and stale citations;
- hostile, secret and symlink inputs;
- a 2,040-file repository bounded to 2,000 with partial status;
- same-name projects in a shared vault (existing tests plus the packet test);
- authenticated routes, and a 401 when unauthenticated;
- the MCP packet with a run token, and a forged token refused.

**Pending or limits:**
- The structure graph is regex-based. Unusual import forms are missed: dynamic paths, `tsconfig` path aliases, Python `sys.path` tricks, Rust `#[path]` and `super::` uses. A missed edge only costs expansion recall.
- Renames are detected by identical content only; edited renames appear as delete + add.
- Notes are patched file by file with an atomic rename, and the registry is committed last. A reader mid-update sees some notes newer than the registry, and those lose attribution until the commit; this is safe but briefly partial.
- Graphify always runs `update . --force` on a full staged snapshot. It isn't incremental inside Graphify.
- The evidence verdict is lexical coverage. It can call paraphrased support "insufficient" (a local answer model can establish support through valid citations).
- The packet's run-basis diff and own-work listing use Git on the main repository and the run's worktree. Both are bounded, but they are not cached for runs with a worktree.
- The benchmark questions were written with the corpus. They are a regression guard, not an independent evaluation. Token savings are not claimed; there are no provider-reported tokens.
- The Mission Control status integration is provided as a patch, not applied.
- Real Obsidian app behavior with patched notes (live reload) was not exercised. The notes are plain files, as before.

## Migration and performance notes

- **First run after upgrade:** a full rebuild into `context/one-answer.sqlite`. `answer:source-key` and `answer:overview-hash` are deleted; `answer:sources` stays as a mirror.
- **No user content touched:** no unrelated vault content is read or changed, and legacy folders behave as before.
- **Blob reads:** one `git cat-file --batch` process per batch (96 files or 4 MiB), instead of one process per file.
- **Measured times:**
  - 2,040-file intake inside the test suite: about 15 s, dominated by notes and the keyword index;
  - fixture-corpus intake: 119 ms;
  - incremental update: 51 ms;
  - with real Graphify and embeddings: 1,823 ms intake and 440 ms incremental (recorded `resources`).
- **Steady state:** the commit poll is one `rev-parse` every 30 s. An unchanged revision does no Git blob reads.
