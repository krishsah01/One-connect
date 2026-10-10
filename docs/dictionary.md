# Dictionary

Dictionary is the project's shared intelligence. Humans and every assigned agent use it to get the same cited context. It joins committed code, project docs, the design contract, team notes, a declarative import graph, optional local semantic vectors and an optional Graphify code graph. It supplies evidence with exact sources. It can't guarantee an answer, and it never overrides a human decision.

## What happens when a project is added

Opening a configured repository starts an **intake job**. Projects added from **Projects** in the Mac app (a local folder or an approved clone) do the same as soon as their engine starts. The job runs these stages:

1. **Committed source.** It resolves the integration branch to an exact commit, or uses `HEAD` if that branch doesn't exist. It lists the tree and reads only the blobs not already cached for the current redaction policy, through a single `git cat-file --batch` process per batch.
   - It never checks out, fetches, runs hooks, installs or runs a project command.
   - Uncommitted and untracked work is never indexed.
2. **Notes.** One generated Markdown note is written per included file, plus `Overview.md`, in the project's own vault folder. After the first intake, only the notes of changed files are rewritten.
3. **Import graph.** A declarative, regex-based parse extracts:
   - symbols and file-to-file imports for TypeScript/JavaScript (including workspace packages), Python (including relative imports), Rust (`mod`/`use crate::`), Go (modules, including a nested `go.mod`) and Swift (SwiftPM targets);
   - doc-to-code path mentions;
   - manifests: npm, Cargo, pyproject/requirements, go.mod, Package.swift, Gemfile, Dockerfile, Compose.

   Nothing is executed or evaluated. This is an import/mention graph, not a call graph, and not Graphify.
4. **Keyword index.** Local SQLite FTS5. It works without any model.
5. **Semantic vectors** (optional). An already-installed local Ollama embedding model on `127.0.0.1` provides these. Nothing is ever downloaded.
6. **Graphify** (optional). Your installed Graphify runs AST extraction only on the same redacted snapshot, in a private staging directory. LLM keys are stripped and the paid semantic mode is never used.

Every stage records the revision it was built from. The page and `/api/context` show each stage separately. The overall state is **Ready** only when every stage matches the indexed revision and nothing was truncated. A stage that is off, missing or failed makes the state **Partial**, with the reason in text. Malformed output and failed publication renames retain the last verified graph; restart restores its backup after an interrupted swap. A failed Graphify build leaves the previous graph in place, labelled **Stale** with its own older revision; it is never shown as current.

### Incremental updates and job control

- **Commit detection:** a cheap `rev-parse` runs every 30 seconds, with or without Graphify. An intake starts only when the integration revision moved. A failed intake is retried after 5 minutes.
- **What changed:** each intake records what was added, modified, deleted and renamed (renames are detected by identical content), how many blobs were read from Git, and how many were reused. A redaction-policy, limits or pipeline-version change forces a full re-extraction and says why.
- **Purging:** content of deleted files and content redacted under an older policy is removed from:
  - the private blob cache,
  - the keyword and vector index,
  - the vault's generated notes.
- **Bursts:** requests that arrive during an intake fold into exactly one follow-up run.
- **Cancel:** this stops the running job, including a Graphify build or embedding requests. The last published generation keeps serving.
- **Restart:** an intake interrupted by a shutdown is marked interrupted and resumes on the next start. Blobs it already read are reused.
- **Queries** never force a rebuild. They answer from the last published generation, and only a never-indexed project waits for its first intake.

### Bounds

| Limit | Value |
|---|---|
| Files | 2,000 |
| Per file | 64 KiB |
| Total | 16 MiB |

Docs and manifests go first, then source, then tests and fixtures. A repository beyond these limits is indexed partially and labelled **PARTIAL** everywhere.

Excluded:
- symlinks, submodules, hidden folders (except `.github`/`.gitlab`);
- credential, env, key and certificate files;
- binaries, lockfiles, generated and vendor trees (`node_modules`, `target`, `dist`, `.build`, `Pods`, virtualenvs and so on).

## One immutable snapshot

A **generation** is identified by: exact revision + redaction policy (denylist, limits, pipeline version) + vault scope.

Its snapshot, structure and identity are published in one SQLite transaction, in the private `context/dictionary.sqlite` (mode 0600). Readers see either the previous generation or the new one, never a mixture.

Redaction happens before anything is persisted: blob cache, notes, Graphify input, keyword rows and embeddings. Raw repository paths are never stored. Rows use a hash of the path as the key and the redacted, alias-safe path for display.

Citations come only from the daemon's registry of that generation, and a citation keeps committed-source attribution only when:
- the note's bytes still match their recorded hash;
- the excerpt is current text at the cited lines;
- the generation is the current one.

Arbitrary frontmatter, forged excerpts, edited notes and older revisions lose attribution. Unchanged text cited before a commit may carry the new revision, because the bytes are identical.

Excerpts are verbatim committed text. The note wrapper and fence are removed, and very long lines are never split with invented line breaks. Each citation names the exact file, revision, content hash and line range.

### Ownership, isolation and repair

The managed namespace is `<knowledge.folder>/project-<SHA-256 of canonical project.repo>`:

- **Identity:** display-name changes and repository symlink aliases keep the same namespace.
- **Isolation:** two repositories with the same name stay isolated in a shared vault. Selecting the managed parent folder grants no access to sibling projects.
- **Ownership markers** bind the folder and its generated-note registry to that identity.
- **User notes:** intake refuses to overwrite an unowned folder or an unregistered user note, and never reads, adopts or deletes user additions.
- **Repair:** missing, edited or symlink-replaced generated notes, and a changed overview, are detected and rebuilt.

## Retrieval

The keyword ranking and, when configured, the local semantic ranking are combined as follows:

1. **Fusion:** the two rankings are combined by reciprocal-rank fusion.
2. **Boosts:** sources named in the question by path, file name or identifier (found through the symbol table) are promoted. Derived summaries (overview, Graphify report) rank just below committed sources of equal relevance.
3. **Expansion:** the strongest sources pull in their imports and dependents from the import graph, marked *related by imports*.
4. **De-duplication:** near-duplicates and overlapping passages are removed, with at most two passages per source.
5. **Budget:** passages are packed into a hard budget (6,000 characters by default).

Each citation says how it was found: keyword, semantic or graph.

**Evidence.** Each answer carries an evidence verdict: the coverage of the question's meaningful terms by the cited excerpts.
- *Insufficient evidence* is shown as such, with the missing terms.
- A local answer model may establish support for a paraphrase, but only through claims that cite returned sources.
- The verdict is advisory and can miss paraphrased support.

Retrieved text is untrusted data, never instructions.

## Agents

| Tool | Returns |
|---|---|
| `get_project_context` | One compact packet for the run's assignment (see below). |
| `search_context` | Cited passages plus optional Graphify context. |
| `ask_project` | The dashboard's search, with the evidence verdict and intake status. |
| `read_note` | Redacted pages. |
| `query_graph`, `graph_path`, `explain_node` | Graphify. |

Every tool is authenticated by the per-run token and scoped to this project.

The packet from `get_project_context` contains:
- the indexed integration revision and every stage's freshness;
- how the run's base SHA relates to it, and which files differ;
- the agent's **own** in-scope uncommitted work, labelled as not evidence;
- entry points, most-imported modules, packages and the design contract;
- other agents' status and declared ownership (never transcripts, prompts, worktrees or unfinished code);
- daemon-verified evidence and recent merges;
- cited retrieval for the issue.

It is bounded (9,000 characters by default; 3,000 to 16,000). Its sections are trimmed in a stated order. Source blobs and generations are cached; each packet is assembled from fresh team state, evidence and privacy rules. The reported size includes the complete serialized JSON and its size field. Optional sections are trimmed repeatedly until the packet fits. If its assignment scope and exact identities cannot fit, the request is refused with a larger-budget/get_assignment suggestion; scope is never silently shortened. Without an issue or a question it does no retrieval; the architecture section is the overview. The **Agent context** tab previews exactly this packet for any issue.

## The page

**Dictionary** shows:
- the intake state, revision, per-stage freshness, live progress, the coalesced follow-up count, and cancel / retry / re-index;
- the last change report;
- cited search with the evidence verdict and how each source was found, opening the committed file at the cited lines;
- the import-graph explorer (entry points, most-imported modules, packages, and per-file imports, dependents and symbols), with Graphify's status listed separately;
- the agent packet preview;
- an installed-local-model check (loopback only), the notes index and packages;
- the context benchmark.

`DictionaryStatusCard` (compact) is reusable on the overview. See `docs/handoff/dictionary-overview.patch`.

## HTTP

These routes sit beside the existing `/api/context` routes. All require the same session or install-token authentication.

| Route | Purpose |
|---|---|
| `POST /api/context/answer/refresh` | Start an intake (existing). |
| `POST /api/context/answer/cancel` | Cancel the running intake. |
| `POST /api/context/answer/search` | Cited search with an evidence verdict. |
| `GET /api/context/answer/file?path=` | Committed, redacted file of the current generation. |
| `GET /api/context/answer/structure[?file=]` | Import graph overview or one file's neighbors and symbols. |
| `GET /api/context/answer/models` | Installed models of the local model service (loopback only). |
| `GET /api/context/answer/packet?workItemId=` | Agent packet preview. |

## Migration from the v3 registry

The first intake after upgrading is a full rebuild into the manifest, because the pipeline version is part of the policy:

- **Registry:** the old `answer:source-key` and `answer:overview-hash` keys are removed. `answer:sources` stays as a read-only mirror of the attribution registry; the manifest is authoritative.
- **Notes:** generated notes are regenerated in the same owned collection, and unrelated vault content is never touched.
- **Legacy folders:** display-name folders from v2 are handled as before. They are left untouched, never read and never used for retrieval. Their old wikilinks are not redirected.

## Verification

| Evidence | Covers |
|---|---|
| `packages/daemon/test/dictionary-incremental.test.ts` | Add/modify/delete/rename with a minimal Git re-read; policy change purge; embedding-model change; coalescing; cancel during Graphify; failed-stage honesty and recovery without re-reading; restart resume; verbatim long-line citations; hostile, secret and symlink inputs; a 2,040-file repository bounded to 2,000; authenticated routes and an assignment-scoped MCP packet with a sibling project in the same vault. |
| `packages/daemon/test/dictionary-structure.test.ts` | The declarative parser across languages and hostile input. |
| `dictionary.test.ts`, `context-isolation.test.ts`, `docs.test.ts` | Pre-existing behavior; still passing. |
| `packages/daemon/test/dictionary.strip.test.mjs` | Runs directly with `node --experimental-strip-types --test`, including the incremental path, packet and restart. |
| `packages/web/test/dictionary.test.tsx` | The page components. |
| `node scripts/dictionary-demo.mjs [--graphify <bin>] [--embedding-model <installed>]` | Disposable multi-language end-to-end run. Result in `docs/verification/dictionary-demo.json`. |
| `docs/verification/dictionary-ui/` | Screenshots of the page against a real daemon with real local tools. |
| `acc bench context` | Retrieval quality and size. See [Ask your docs](ask-your-docs.md#benchmark). |

Cited-file views request the exact cited revision. If intake has replaced that revision, the viewer asks for a fresh search instead of opening newer code at the old line numbers. Late file and issue-packet responses are discarded after a selection change. Switching the knowledge folder drains the old index and closes its manifest before attaching the new folder.
