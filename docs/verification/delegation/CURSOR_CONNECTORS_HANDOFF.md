# Cursor connectors handoff

**Isolated checkout:** `/private/tmp/one-connect-parallel-20261007/connectors`  
**Primary reference:** `/Users/krishkumarsah/Docs/Projects/Interface` (read-only; not modified)  
**Status:** Connectors and GitHub/Linear import are functionally complete on fixture evidence. Real-provider acceptance is still pending owner verification.

## Summary

The snapshot already contained substantial connector work (draft/save/disable, Decision-bound activation, release reads, GitHub/Linear preview/import, MCP tools, Docker reads, Obsidian knowledge, egress guard integration, and focused tests). This pass completed the remaining gaps:

1. **External-tracker import** — connector import no longer hard-requires `tracker.type: local`. When the authoritative tracker is GitHub or Linear, imported issues are **local mirrors only** (`sync.status: dry_run`, empty outbox). No silent outbound `create_issue` is queued.
2. **Preview pagination** — `previewImport()` accepts `page` / `pageSize`; the Connectors UI shows page counts and Previous/Next controls.
3. **Duplicate detection** — previews and imports skip issues already mirrored from the connector or already present in the authoritative tracker (`trackerId` / `url` / `origin` match).
4. **Unsupported relations** — parent dependencies that are not yet imported are reported in `unsupported[]` instead of failing silently.
5. **Test infrastructure** — copied `packages/daemon/resources/designer/` from the primary repo so daemon imports succeed in this isolated snapshot (Designer code was not edited).

## Changed paths (this pass)

| Path | Change |
|---|---|
| `packages/daemon/src/connectors.ts` | Paginated preview; mirror import; duplicate/parent handling |
| `packages/daemon/src/daemon.ts` | `buildIssue(..., { mirror: true })` skips outbox and marks `dry_run` |
| `packages/daemon/src/server/libraryRoutes.ts` | Pass `page` / `pageSize` to preview route |
| `packages/web/src/pages/Connectors.tsx` | Pagination controls; mirror import messaging |
| `packages/daemon/test/connectors.test.ts` | Pagination + external-tracker mirror import test |
| `packages/daemon/resources/designer/**` | Copied from primary (snapshot gap; required for daemon/tests) |

**Already present in snapshot (verified, not re-authored):**

- `packages/core/src/connectors.ts` — schemas, descriptors, `connectorAllows` / `connectorState`
- `packages/daemon/src/adapters/trackers/{github,linear,local}.ts`
- `packages/daemon/src/adapters/hosts/{github,gitlab}.ts`
- `packages/daemon/src/infra/{vercel,health,migrations}.ts`
- `packages/daemon/src/egress.ts` — raw `activated` loop removed; connector Decisions supply hosts
- `packages/daemon/src/server/libraryRoutes.ts` — `POST /api/connectors/:id/read` already wired
- `packages/web/src/pages/Connectors.tsx` — full connector management UI (draft/edit/disable/check/approve/preview/import/MCP/Docker)
- `packages/daemon/test/release-connectors.test.ts`, `packages/web/test/release-connectors.test.tsx`, `packages/daemon/test/trackers.contract.test.ts`

## Verification commands and results

```bash
cd /private/tmp/one-connect-parallel-20261007/connectors

# Focused connector suite (fixtures only; no live providers)
pnpm test \
  packages/daemon/test/connectors.test.ts \
  packages/daemon/test/release-connectors.test.ts \
  packages/daemon/test/trackers.contract.test.ts \
  packages/daemon/test/code-host.test.ts \
  packages/daemon/test/infra-health.test.ts \
  packages/web/test/release-connectors.test.tsx
# → 6 files, 25 tests passed

pnpm typecheck   # @acc/core, @acc/daemon, @acc/web — passed
pnpm build       # web production build — passed
```

**Not run (out of scope / requires owner):** real `gh auth login`, Keychain tokens, live GitHub/GitLab/Vercel/Supabase probes, production writes, desktop rebundle.

## Behavior reference

### Connector management

- **Save** validates config, binds release connectors to current project settings hash, never contacts a service.
- **Edit/disable** voids pending approvals and stale read proof (`connector:read:*` KV markers).
- **Check** is local-only (binary on PATH, key presence, folder existence).
- **Activate** creates a 15-minute Decision bound to `configHash`; human-only, single-use, expiring.
- **Secrets** rejected in config/acceptance; keys use existing Keychain/env boundaries.

### GitHub / Linear import

Flow: draft → check → request import Decision → approve → preview (paginated, filterable) → select issues → confirm acceptance criteria → import.

- Preview stores full issue list + `contentHash`; returns one page at a time.
- Import is atomic per issue (`buildIssue` + `origin` patch in one commit).
- **Local tracker:** outbox `create_issue` delivers to `local-tracker.sqlite`.
- **External tracker:** `mirror: true` — `sync.status: dry_run`, **no outbox row**; UI explains mirrors are local-only.
- Imported title/body/comments are **untrusted**; `promptNote()` appends agent guidance.
- Expired preview, config change, or disabled connector → import rejected with explicit error.

### Release / infra reads

- `approvedReleaseConfig()`, `releaseAccess()`, `releaseReadCurrent()` derive authority from consumed connector Decisions, not raw `activated` flags.
- `readRelease(id)` is explicit-only; revalidates binding before/after every await.
- Background `hosts.refresh()` / `infra.refresh()` without `live: true` make no provider requests.

### Tracker coherence

- Lifecycle transitions still commit tracker outbox rows atomically (unchanged).
- Connector import approval grants **read/import only** — not unlimited tracker-write permission.
- Mirror imports do not enqueue outbound tracker mutations.

## Parent wiring patches

Most parent wiring from `docs/release-connectors-parent-wiring.md` is **already applied** in this snapshot:

```ts
// packages/daemon/src/server/libraryRoutes.ts — present
app.post('/api/connectors/:id/read', async (req) => d.connectors.readRelease(req.params.id));
```

```ts
// packages/daemon/src/daemon.ts refreshEgress — present
this.egress.allowed.splice(0, this.egress.allowed.length,
  ...new Set([...allowedHosts(this.config), ...this.connectors.hosts(), ...this.jev.hosts(), ...(this.notifications?.hosts() ?? [])]));
```

```ts
// packages/daemon/src/egress.ts — raw activated loop already removed
```

**Release runner consumption (no change needed):**

```ts
const readConfig = d.connectors.approvedReleaseConfig();
const currentCi = provider && d.connectors.releaseReadCurrent(provider, 'checks:read');
// … branch-protection, deployments, migrations predicates
```

**Optional future patch — outbound import into a different authoritative tracker:**

If product later wants connector import to **create issues in** GitHub/Linear (not mirror), add a separate `ConnectorAction` (e.g. `import_publish`) with its own Decision bound to exact target tracker + scopes, and only then enqueue outbox `create_issue`. **Disabled by design in this pass.**

## Migration / compatibility

- **Preview API:** response now includes `page`, `pageSize`, `total`, `hasMore` (backward compatible; clients ignoring pagination still work on page 1).
- **Import API:** response adds `mirror: boolean` and `unsupported: string[]` when applicable.
- **`buildIssue` signature:** optional third argument `{ mirror?: boolean }`; existing callers unchanged.
- **Node 24 / Apache-2.0:** preserved; no dependency changes.

## Snapshot prerequisite

Copy designer resources before running daemon tests in a fresh isolated checkout:

```bash
cp -R "$PRIMARY/packages/daemon/resources/designer" \
      packages/daemon/resources/designer
```

Without this, `designer.ts` fails at import time (`manifest.json` missing). Designer **source** was not modified.

## Pending real integration prerequisites

| Prerequisite | Owner action |
|---|---|
| GitHub Issues import | Install `gh`, `gh auth login` for target repo |
| Linear import | Store Linear API key via existing Connections key store |
| Release reads (GitHub/GitLab/Vercel/Supabase) | Store provider tokens; approve read Decision per connection; click **Read now** |
| External-tracker mirror import | Understand imported items stay local (`dry_run`) until/unless outbound publish Decision is added |
| Production release gates | Release worker must still verify SHA, checks, protection, deployments, migrations independently of connector UI |
| Real-provider acceptance | One manual pass per provider after merging into primary |

## Sandbox / tool notes

- Vitest initially failed with `EPERM` writing `node_modules/.vite-temp/` under sandbox; reran with full permissions.
- No paid Cursor/API usage; Composer 2.5 only.

## Freeze declaration

Connector-owned behavior in this checkout is **frozen** for parent integration. This does **not** declare all of One Connect finished — workflows/Team, phone, release runner UI, runtime providers, One Answer, Designer, and desktop packaging remain owned by other workers.
