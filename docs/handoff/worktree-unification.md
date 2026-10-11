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
| `Interface-refactor` (`refactor/solid-foundations`) | committed, clean | Fast-forwarded into this branch. |
| `Interface-harness` (`claude/harness-setup-compliance`) | **in progress** (Agent management architecture session) | Not touched. Merge it when that session commits. |
| `Interface` (`main`) | **in progress** (uncommitted Designer/brand work from live sessions) | Not touched. Merge recipe below. |

"Newer versions" was checked file by file: every file in those checkouts whose content `main` never had was compared, with the One Answer → Dictionary/One Ask rename normalized, against every historical version of that file on `main`. All remaining differences were older states of code `main` has since moved past. The one exception is `vitest.continuation.config.ts`, a helper with paths hard-coded to `/tmp`, which was intentionally dropped.

The full working tree of each retired checkout, including uncommitted and untracked files, is kept at `refs/backup/worktrees/<name>-2026-10-10`. To restore one:

```
git worktree add ../restored refs/backup/worktrees/canvas-ui-2026-10-10
```

## Landing on main

Once the sessions in the primary checkout have committed their work:

```
git checkout main
git merge unify/all-worktrees          # stops on three expected conflicts
python3 docs/handoff/resolve-designer-merge.py
pnpm -r typecheck && pnpm test
git commit
```

A dry run on a snapshot of `main`'s working tree (10 Oct, 20:50) hit exactly the three conflicts (`adapters/agents/claude.ts`, `daemon.ts`, `designer.ts`). The script resolved them and the result typechecked clean.

Merging `refactor/solid-foundations` untracks the raw agent logs (`9019e80`). They stay on disk because they are gitignored, but back them up before any history rewrite (owner decision O1 in `docs/architecture-review.md`).

Then merge `claude/harness-setup-compliance` once its session has committed it.

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
