# Adding a tracker adapter

Implement **one interface**, `TrackerAdapter` in `packages/daemon/src/adapters/trackers/types.ts`:

```ts
interface TrackerAdapter {
  type: 'local' | 'github' | 'linear' | …;
  target: string;            // shown in the UI, e.g. "Jira project ENG"
  live: boolean;             // outbound adapters must do nothing until the owner sets live: true
  init(): Promise<void>;
  createIssue(i: NewIssue): Promise<TrackerIssue>;
  getIssue(id: string): Promise<TrackerIssue | null>;
  listIssues(o?: { updatedSince?: string | null }): Promise<TrackerIssue[]>;
  setStatus(id: string, category: TrackerCategory, lifecycle: LifecycleState): Promise<void>;
  comment(id: string, body: string): Promise<void>;
}
```

Notes:

- **Statuses.** The control center works in tracker-neutral categories (`backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`). Map them to your tracker's states, and let users override names in config (see Linear's `state_names`).
- **Acceptance criteria** travel inside the issue body as a `## Acceptance criteria` checklist. Use `composeBody` / `splitBody`.
- **Not live yet.** When `live` is false, throw `TrackerNotLiveError` from every outbound call. The outbox keeps those writes pending and the UI shows "dry run".
- **Credentials.** Prefer the user's own signed-in CLI (as GitHub does with `gh`). Otherwise read a key at runtime from the OS keychain or an env var, and pass it to `onSecret` so it's redacted. Never store it.
- **Delivery.** Writes are retried by the outbox. Make `setStatus` and `comment` safe to repeat where the tracker allows it.

## Wiring

1. Add the config shape to `TrackerConfigSchema` in `packages/core/src/config.ts`.
2. Construct it in `createTracker` (`adapters/trackers/index.ts`).

## Contract tests

Add a case to `packages/daemon/test/trackers.contract.test.ts` that runs against a fake (a shim binary like `fixtures/fake-gh.mjs`, or a mocked `fetch` like the Linear case). The shared contract covers create → get → list → status changes → comment.
