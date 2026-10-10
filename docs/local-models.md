# Bundled local models

One Connect ships two small open models so the summary agent and One Ask's semantic search work offline and for free, without sending anything off the Mac.

| Role | Model | File | Size | License |
|---|---|---|---|---|
| Summary agent (plain-language One Ask answers) | Qwen3-1.7B | `Qwen3-1.7B-Q8_0.gguf` | 1.83 GB | Apache-2.0 |
| Embeddings (One Ask semantic search) | Qwen3-Embedding-0.6B | `Qwen3-Embedding-0.6B-Q8_0.gguf` | 639 MB | Apache-2.0 |
| Runtime | llama.cpp `llama-server`, build b11540, macOS arm64 | `llama-b11540-bin-macos-arm64.tar.gz` | 12 MB | MIT |

## How they run

- **Verification.** The desktop app passes the folder to the engine as `ACC_LOCAL_MODELS_DIR`. Each model's SHA-256 is checked before it is first loaded.
- **Servers.** `llama-server` starts on demand on a random 127.0.0.1 port with a random key, and stops after 10 quiet minutes.
- **Bridge.** An Ollama-compatible bridge on `127.0.0.1:11435` (`/api/tags`, `/api/show`, `/api/embed`, `/api/generate`) lets One Ask use them unchanged. It refuses requests that carry a browser `Origin` header or a non-loopback `Host`.
- **Summaries.** `POST /api/local-models/summarize` powers the One Ask dock and the canvas Summary node.
- **No downloads or fallbacks.** Nothing is downloaded at run time. If the files are missing or fail verification, the summary features say so; no other model is used.

## Building the app with them

The files are downloaded once into `.desktop-cache/models/` (ignored by git), pinned by SHA-256. Then:

1. `tar xzf .desktop-cache/models/llama-b11540-bin-macos-arm64.tar.gz -C .desktop-cache/models/llama` (create the `llama` folder first)
2. `node scripts/desktop-models.mjs` verifies the files and stages them into `packages/desktop/src-tauri/resources/models/`.
3. Build with a resources map that adds `resources/models/` next to `resources/engine.tar.gz` (see `docs/verification/delegation/CLAUDE_CANVAS_UI_HANDOFF.md`).

To use the embedding model for One Ask's semantic search, set the project's `context.docs` to `endpoint: http://127.0.0.1:11435` and `embedding_model: qwen3-embedding:0.6b`, then turn semantic search on.
