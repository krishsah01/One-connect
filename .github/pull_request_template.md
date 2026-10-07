## What and why

## Failure mode addressed

## Checklist
- [ ] Commits are signed off (`git commit -s`), per the DCO
- [ ] `pnpm typecheck && pnpm test` pass
- [ ] New source files have an SPDX header; `pnpm spdx:check` passes
- [ ] Dependency changes: `pnpm license:notices` run and `pnpm license:check` passes
- [ ] Safety-relevant changes (billing, approvals, redaction, scopes, push guards) have tests
