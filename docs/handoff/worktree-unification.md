# Worktree unification (2026-10-10)

The app had drifted into eight checkouts. This records where each one went and how to finish landing everything on `main`.

## Where each copy went

| Checkout (branch) | State | Where its work is now |
|---|---|---|
| `Interface-canvas` (`codex/claude-canvas-ui`) | idle since 10 Oct 13:35 | On `main` (newer versions). Bundled models moved to `Interface/.desktop-cache/models`. |
| `Interface-codex-engine` (`codex/canvas-engine`) | idle since 10 Oct 12:07 | On `main` (newer versions). |
| `/tmp/Interface-canvas-continuation` (`codex/canvas-continuation`) | idle since 10 Oct 13:11 | On `main` (newer versions). |
| `/tmp/one-connect-claude/one-answer` (`codex/claude-one-answer-completion`) | idle since 7 Oct | Code on `main`, renamed Dictionary. Evidence: `docs/verification/dictionary-ui/`, `dictionary-*.json` (this branch). |
| `Interface-designer-studio` (`codex/claude-designer-studio`) | idle since 8 Oct | Code on `main` (newer, including the live-store ordering fix). Evidence and patches: `docs/verification/designer-studio/` (this branch). |
| `Interface-refactor` (`refactor/solid-foundations`) | committed, clean | Merged into this branch, up to `4cf93f3`. |
| `Interface-harness` (`claude/harness-setup-compliance`) | committed (`8db63b4`), clean | Merged into this branch. Its edits were moved to where the refactor put that code; the result matches `docs/handoff/resolve-harness-merge.py`. |
| `Interface` (`main`) | **in progress** (uncommitted Designer/brand work from live sessions) | Not touched. Merge recipe below. |

"Newer versions" was checked file by file: every file in those checkouts whose content `main` never had was compared, with the One Answer → Dictionary/One Ask rename normalized, against every historical version of that file on `main`. All remaining differences were older states of code `main` has since moved past. The one exception is `vitest.continuation.config.ts`, a helper with paths hard-coded to `/tmp`, which was intentionally dropped.

The full working tree of each retired checkout, including uncommitted and untracked files, is kept at `refs/backup/worktrees/<name>-2026-10-10`. To restore one:

```
git worktree add ../restored refs/backup/worktrees/canvas-ui-2026-10-10
```

## Landing on main

Once the sessions in the primary checkout have committed their work:

```
cp -R docs/verification/delegation ../delegation-backup   # the merge deletes the raw logs from disk
git checkout main
git merge unify/all-worktrees          # stops on six expected conflicts
python3 docs/handoff/resolve-designer-merge.py
pnpm -r typecheck && pnpm test
git commit
```

A dry run on a snapshot of `main`'s working tree (10 Oct, 21:05) hit six conflicts:

- `adapters/agents/claude.ts`, `daemon.ts` and `designer.ts`, from the refactor;
- `core/index.ts`, `core/preflight.ts` and `web/styles.css`, where the harness work and the Designer/brand work both add.

The script resolved all six and the result typechecked clean.

The harness branch is already merged here, so `resolve-harness-merge.py` is not needed for this landing.

**Raw logs.** The refactor's hygiene commit `9019e80` stops tracking the raw agent logs (`docs/verification/delegation/*.jsonl`, the status files and `interrupted/`). It also moves `CLAUDE_CANVAS_UI_HANDOFF.md` and `CODEX_NODE_WORKFLOW_HANDOFF.md` out of the root. A merge that stops tracking a file **deletes it from disk**, even though it is gitignored afterwards. Hence the `cp -R` before the merge; the logs can also be recovered from `6b1f1ca`. Purging them from public history is the separate owner decision O1 in `docs/architecture-review.md`.

## Removing the retired checkouts

They are redundant and fully backed up. From the primary checkout:

```
git worktree remove --force ../Interface-canvas
git worktree remove --force ../Interface-codex-engine
git worktree remove --force ../Interface-designer-studio
git worktree remove --force /private/tmp/Interface-canvas-continuation
git worktree remove --force /private/tmp/one-connect-claude/one-answer
git worktree prune
```

After `main` has landed this branch, `Interface-refactor` and `Interface-harness` are redundant too. Each belongs to its own session, so remove them only once those sessions are done.
