# Ask your docs

Ask your docs is part of **Dictionary**. Project intake creates a private Markdown vault by default; connect an Obsidian vault or a markdown directory from **Dictionary → Connect Obsidian / Connection settings**. Pick the vault, list readable folders, and connect. The app's own folder has one subfolder per project. Unlisted folders, hidden files and symlinks below the vault root are excluded. Folder traversal is rejected. Selected folders are project settings stored in that project's local database; switching projects does not carry them over.

Keyword retrieval uses SQLite FTS5 and works without a model. Dictionary fuses it with optional semantic rankings, promotes sources the question names, expands to imported and dependent files, removes duplicates and packs passages into the budget; see [Dictionary › Retrieval](dictionary.md#retrieval). **Refresh index** or asking a question updates changed chunks and removes deleted notes. Every result has a vault-relative path, source lines and an excerpt. Expand the citation to read the source inside the app. Agent `search_context` uses the same scoped index; `read_note` returns redacted pages with cursors.

Optional semantic search uses the public [Ollama embedding API](https://docs.ollama.com/api/embed) on `127.0.0.1`. Enable it and name an already-installed embedding model. The app checks the installed model and its embedding capability, batches unchanged-aware embeddings, and combines vector and keyword rankings. It never pulls a model or contacts a remote embedding service. An unavailable model leaves keyword search usable and displays the error. The model digest is part of the embedding cache identity.

Embedding requests disable truncation. If the model rejects a passage as too long, the index retries with smaller complete passages, preserving source lines, and remembers that size for the model digest across restarts. An oversized question falls back to keyword retrieval with an explicit warning.

Every answer carries an evidence verdict, *supported* or *insufficient evidence*, computed from the cited excerpts. An optional local answer model can summarize retrieved passages. Every generated claim must cite a returned source ID; an invalid citation rejects the answer and exposes the original excerpts. This format check cannot prove factual entailment: answers are labelled AI interpretations, with sources next to them. Leave the answer model blank for source excerpts only. Notes are untrusted input and cannot grant tool permissions or replace a human approval.

The index is durable, local and redacted before content is stored or sent to the local model. The default source budget is 6,000 characters. Query counts and returned source characters appear in Analytics. These are retrieval measurements, not token savings. A controlled workload comparison is required before claiming reduced token usage or unchanged agent quality.

## Open-source evaluation

| Candidate | Evidence | Decision |
|---|---|---|
| QMD | [MIT license](https://github.com/tobi/qmd/blob/main/LICENSE), [SDK and local hybrid retrieval](https://github.com/tobi/qmd) | Suitable optional backend. Its native SQLite and llama.cpp dependencies and model download behavior require a separate packaged adapter. |
| Smart Connections | [Current custom Smart Plugins license](https://github.com/brianpetro/obsidian-smart-connections/blob/main/LICENSE) | Do not redistribute as if it were MIT. |
| One Connect local index | Node's existing SQLite runtime and public Ollama API | Current backend; no extra runtime dependency or remote service needed. |

QMD is a researched integration candidate, not an installed or bundled dependency. The current index implements scoped retrieval directly so raw, unrelated vault folders never need to be handed to a third-party indexer. A future QMD adapter must index only a redacted project snapshot and keep its model downloads explicit.

## Benchmark

`acc bench context [--graphify <bin>] [--embedding-model <installed model>] [--json]` builds a disposable corpus, runs the real intake, and compares several arms on labelled questions: lookups, multi-source, structural dependency, design contract, version change, deleted source, abstention and scope probes. The arms are:

| Arm | What it is | When it runs |
|---|---|---|
| Full-context | Every included file in the prompt. | Always; it measures size only. |
| Keyword-only | The keyword index without expansion. | Always. |
| Dictionary | Keywords + import-graph expansion. | Always. |
| Hybrid | Dictionary + local embeddings. | Only with an installed model; otherwise **pending**, never green. |
| Graphify | Graphify queries. | Only with a binary. |
| On-demand skills | Skill descriptions first, the body when chosen. | Always. |

Each arm reports the following:
- **Recall:** expected sources cited.
- **Retrieval accuracy:** expected sources and the fact present.
- **Citation integrity:** verbatim committed text at the cited lines, plus the file hash.
- **Abstention.**
- **Evidence-verdict accuracy.**
- **Bytes per question** and a bytes/4 token estimate.
- **Latency.**

The run also reports intake time and process memory. Provider-reported tokens stay null: no inference happens, so token savings are not claimed.

Recorded results on this machine (corpus v2, 41 files, 20 questions):

| Arm | Bytes/question | Accuracy | Recall | Citations | p50 latency |
|---|---|---|---|---|---|
| Full context | 43,042 | (by construction) | — | — | read only |
| Keyword-only | 945 | 92% | 94% | 100% | 12 ms |
| Dictionary (graph-assisted) | 975 | 100% | 100% | 100% | 14 ms |
| Hybrid (`all-minilm`, installed) | 1,876 | 100% | 100% | 100% | 38 ms |
| Graphify (installed, AST) | 733 | 1/1 structure question | — | — | 91 ms |

The keyword-only arm misses the structural question (D1) that import expansion answers. Expansion adds about 3% context, and hybrid roughly doubles context and latency on this corpus without improving accuracy. Sources:
- `docs/verification/dictionary-benchmark-local-tools.json` (real Graphify and Ollama `all-minilm`, loopback only, no download);
- `docs/verification/dictionary-benchmark-fixtures.json` (no tools).

The questions were written alongside the corpus, so this is a regression guard, not an independent evaluation.

## Verification

`packages/daemon/test/docs.test.ts` verifies scope, redaction, incremental deletion, durable settings, context budgets, local embedding protocol and citation rejection. The deterministic embedding fixture verifies the protocol, not real model quality.

Run `node scripts/check-doc-search.mjs all-minilm` for a real local retrieval check after installing that model yourself. It uses seven disposable English project notes, including a dense Markdown passage, writes `docs/verification/doc-search.json`, and never reads your vault or downloads models. The report measures top-1/top-3 retrieval on that small corpus. It does not establish answer quality, multilingual performance or token savings.
