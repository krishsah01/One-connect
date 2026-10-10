# Workflows and shared agent context

A workflow references existing project issues and agents. Independent tasks run in parallel; collaborative tasks use a dependency graph. Each task goes through the normal assignment, preflight, worktree and provider-capacity checks. The event store owns workflow state; Git and recorded check/review evidence own readiness.

Completion is conditional on current evidence. A code task needs a verified commit and the required checks at its current branch SHA and configured check runtime. A review needs an independent verdict for that exact target. Completed workflows continue to observe invalidations and reconcile on restart. Changed source, failed checks or a stale review must remove completion and block dependent readiness. Existing runs may finish, but their output cannot bypass an invalid upstream dependency. The owner explicitly retries the affected task and its dependents; reconciliation never silently re-runs finished work.

Agents pull a bounded project snapshot and inbox through authenticated tools. Peer messages, acknowledgements and replies are durable project context. An inbox reminder is not proof that an agent read a message; only its authenticated acknowledgement is. Messages cannot grant approvals or contact people outside the project.

## Continuation plan

1. Correct completion invalidation and current check-runtime binding. Verify moved SHAs, stale approvals, failed checks, queued/running dependents and restart without duplicate runs.
2. Finish delivery-state, paging and cancellation/retry acceptance for internal messages and workflows, using real child-process fixtures and direct Node 24 contracts.
3. Exercise the connected parallel workflow in the native dashboard, then validate separately with authorized live subscription agents. Fixture success does not establish live provider capacity or deployment acceptance.

The latest shipped checkpoint and pending acceptance are recorded in `verification/current-preview.md`. Antigravity's quota-interrupted assignment remains in `verification/delegation/ANTIGRAVITY-opus-4.6-thinking-orchestration.md`; its prepared checkout is not treated as a completed implementation.
