<!-- SPDX-License-Identifier: Apache-2.0 -->
# Release connector wiring

Owned implementation: `packages/core/src/connectors.ts`, `packages/daemon/src/connectors.ts`, `packages/daemon/src/adapters/hosts/*`, `packages/daemon/src/infra/*`, and the Connectors/ReleaseCockpit pages. Shared HTTP, Settings, daemon, Decisions, config and release runner files were not edited by this worker.

## Required HTTP route

Add alongside the existing connector routes in `packages/daemon/src/server/libraryRoutes.ts` (existing `R` type; no imports needed):

```ts
app.post('/api/connectors/:id/read', async (req: R<{ id: string }>) =>
  d.connectors.readRelease(req.params.id));
```

This is the only missing route required by the **Read now** buttons. Existing save, disable, local availability, activation and human Decision resolution routes already work. Without this snippet, the buttons return an HTTP error; the UI never reports success. Do not change import preview routes: `previewImport()` and its existing return type are preserved.

## Settings and release configuration

Settings stores base project config in `project:settings` and normalizes all remote `activated` flags to false. Connector saving includes a server-generated project/configuration binding; request and resolution both revalidate it. The readers obtain permissions from `releaseAccess()` and never use raw `activated` flags as authority. A current human Decision with consumed KV binding is required even if raw flags are true.

For shared release runner wiring that needs a config object, obtain a derived copy immediately before review/execution:

```ts
const readConfig = d.connectors.approvedReleaseConfig();
// Or, inside a ReleasePlans method:
const readConfig = this.d.connectors.approvedReleaseConfig();
```

Only matching stored read Decisions produce `activated: true` in this derived copy; `d.config` stays unchanged. Changing current project configuration, API host, repository/provider project, requested scopes, connector capabilities or disabling the connector makes the old authorization unavailable. This config is **read activation**, never permission to push, open a PR, deploy, mutate a DB or execute a command. Keep the release runner's separate exact per-action human approvals and transport checks.

Reject retained live evidence before using it to satisfy a release gate. The helper binds evidence to the actual provider read, connector hash, active Decision and current project settings:

```ts
const provider = readConfig.code_host?.provider;
const currentCi = provider && this.d.connectors.releaseReadCurrent(provider, 'checks:read');
const currentProtection = provider && this.d.connectors.releaseReadCurrent(provider, 'branch-protection:read');
const currentDeployments = this.d.connectors.releaseReadCurrent('vercel', 'deployments:read');
const currentMigrations = this.d.connectors.releaseReadCurrent('supabase', 'migrations:read');
```

These predicates express freshness and permitted capability; still check actual probe status, SHA, required checks and release target. They do not turn an unreadable probe into a pass. Background `hosts.refresh()` and `infra.refresh()` intentionally make no live-provider requests. An explicit `readRelease(connectionId)` probes only that connection, with a capability check immediately before and after every awaited provider request. The explicit read is never called by activation or polling.

## Egress cleanup in the shared egress file

`refreshEgress()` already includes `connectors.hosts()`. Remove the raw activation loop in `packages/daemon/src/egress.ts`:

```ts
// Remove this block; connector Decisions supply reviewed API hosts.
for (const c of [cfg.code_host, cfg.infra?.vercel, cfg.infra?.supabase]) {
  if (c?.activated && c.host && c.scopes.length > 0) hosts.add(c.host);
}
```

The owned readers enforce Decisions independently of the allowlist, so this cleanup is not a bypass in those readers. It prevents the generic allowlist from presenting YAML activation as authorization. Read connectors add only their reviewed API host, not Git transport hosts; any transport host needs separate release action review.

## Verified public primary API references

- [GitHub branch protection](https://docs.github.com/en/rest/branches/branch-protection): read Administration permission. Live HTTP 404 is resource-not-found evidence, so protection stays unknown. GitHub capability ceilings accept individually reviewed permission metadata or Settings' `repo:read`; neither proves actual token permissions.
- [GitLab protected branches](https://docs.gitlab.com/api/protected_branches/): wildcard rules are returned as patterns. Missing results from a paginated response do not prove the branch unprotected.
- [Vercel list deployments](https://vercel.com/docs/rest-api/deployments/list-deployments): manual live reads use GET `/v7/deployments?projectId=...&limit=5`. Existing local v6 fixtures remain compatible. `deployments:read` is reviewed local metadata, not verified token scope.
- [Supabase list migration history](https://supabase.com/docs/reference/api/v1-list-migration-history): GET `/v1/projects/{ref}/database/migrations`; OAuth `database:read` or fine-grained `database_migrations_read`. The response contains version/name, so unavailable content hash comparison is reported explicitly.
- [Supabase changelog](https://supabase.com/changelog): reviewed for relevant breaking changes. The markdown index was unavailable through the tool, so the official HTML changelog was used.

No vendor installs, real credentials, paid calls, production writes or live provider probes were used in implementation verification. The focused tests use in-process synthetic responses and repository loopback fixtures.
