# Cursor implementation batches

The owner authorized Cursor workers and confirmed on-demand billing is off. The official Cursor CLI uses its own subscription login. Selected account-available model: claude-opus-5-5-high; fast variants, API keys and paid fallback stay off.

Update: Cursor reported the Opus allowance exhausted, with a reset on October 10, 2026. The owner replied "use cursor model". The coordinator selected Cursor's own `composer-2.5` (standard mode), preserved interrupted code/check records under interrupted/, and resumed the same three vendor sessions. This is an explicit recorded model change; on-demand and paid fallback remain off. Both review queues now use Composer. The original Opus model and failure evidence remain in registry.json and the archived status records.

Baseline: 133 tests pass across 16 test files; typecheck and 133-file SPDX checks pass. License inventory needs a normal-permission cache check: sandboxed pnpm searched an empty project store. Latest One Answer/designer source has not yet been repackaged/rendered after its final changes.

Each worker has an isolated Git worktree created from a complete source snapshot in a scratch repository, with installed dependencies linked read-only. Workers never edit the original checkout. Full task briefs, transcript paths, status records and the baseline SHA are in registry.json.

First batch:

1. workflow-review: durable collaborative/independent workflows, SHA-bound independent review, approved integration merge, phone decisions, shared usage and safe model-family selection.
2. projects-docker: durable multi-project native registry/supervisors, onboarding, project-scoped terminal/Docker, approved local database creation and health.
3. designer-library: versioned per-agent skills, project connector manager, sandboxed editable mock artifacts and design-contract gates.

The coordinator watches state, reviews scope and tests, and gives repair/integration briefs. Integration uses reviewed diffs against the common baseline; overlapping edits require deliberate reconciliation. Worker handoffs do not prove completion by themselves.

Following batches preserve the full product goal: permissive OpenCode API harness and contract tests; Jev recommendations with paid activation off; ordered release cockpit, code-host/CI/protection and read-only infra/drift adapters; authenticated phone/PWA and notifications; evidence-backed reporting; controlled context/token quality benchmarks; final packaging/native UX and original/new acceptance scenarios. No release, paid infrastructure, live outbound integration or production write is authorized by this delegation.

Second-batch implementation briefs are prepared in NEXT-harness-decisions.md, NEXT-release-infra.md and NEXT-phone-reports.md. A separate queue waits for the first independent integration reviewer to finish and provide passing check evidence with no unresolved critical finding. If checks are missing or fail, it stops for coordinator inspection. If they pass, it starts three new isolated Cursor worktrees plus a second independent integration review, using the same subscription model and confirmed on-demand-off setting. This permits further isolated development only; the coordinator still reviews and verifies before promoting code to the original checkout. Durable logs, handoffs, check records and the reviewed first-batch patch stay in this folder.

REVIEW_NOTES.md records concrete issues observed during implementation for the first reviewer to reassess against final patches, including mock navigation egress and capture races.

The owner subsequently authorized the latest Grok model. Pending independent integration and the next isolated batch use the newest Grok family entry in Cursor’s current inventory, `grok-4.7-xhigh` (standard non-fast mode). The active designer Composer session is allowed to finish. Both completed handoffs are copied here; first integration must repair their acknowledged safety/flow gaps before its verified gate.
