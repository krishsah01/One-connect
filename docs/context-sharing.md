# Shared context: Obsidian and graphify

Agents from different vendors need the same picture of the project without copy-pasting instructions around. The control center keeps two shared sources current and gives every agent the same tools to read them.

## Obsidian vault

```yaml
knowledge:
  vault: ~/Documents/Obsidian/Work
  folder: Agent Control Center          # the control center owns <folder>/<project>/
  context_folders: [Projects/example-app]
  obsidian_cli: auto                    # auto | on | off
```

The control center writes plain markdown into `<folder>/<project>/` and rewrites it from live state on every change (debounced). Notes use wikilinks and frontmatter, so they work in Obsidian's graph, backlinks and Dataview.

| Note | Contents |
|---|---|
| `Team Contract.md` | The one shared copy of the team instructions: ground rules, team table, checks, approval-required actions, handoff format. Generated from `control-center.yaml`. |
| `Brief.md` | Each agent's Now/Next, questions waiting on you, open alerts, work in flight, recent handoffs with *verified* or *claimed* checks. |
| `Issues/<KEY>.md` | State, acceptance criteria, evidence (verified or claimed), runs. |
| `Handoffs/<when> <KEY> <agent> <id>.md` | The handoff plus what the control center verified. |
| `Decisions/<date> <question>.md` | Every answered question or approval: who answered, when, through which channel. |
| `Graph Report.md` | graphify's report for the integration branch. |

Agents read the vault through MCP tools:

- `search_context(query)`: notes and code graph together.
- `read_note(path)`
- `get_brief()`

**Privacy.** Only `<folder>/<project>` and the `context_folders` you list are readable. Everything else in your vault is invisible to agents, and path traversal and symlink escapes are refused.

**Official Obsidian CLI.** Obsidian 1.12.4+ has a CLI; enable it under Settings → General → *Command line interface*. When it's installed and Obsidian is already running, search goes through `obsidian vault=<name> search query=… path=… format=json`, so results match Obsidian's own search. The CLI launches Obsidian if it isn't running, so in `auto` mode the control center falls back to its local markdown search instead of opening your app. Writes are always plain file writes, which Obsidian picks up live, so nothing depends on the app running. *Open brief* in Mission Control uses an `obsidian://` link.

## graphify code graph

```yaml
graphify:
  enabled: true
  auto_update: true      # rebuild when the integration branch moves (AST only, no LLM, no cost)
  semantic: false        # LLM extraction uses a paid API: requires semantic_opt_in: true
```

Dictionary reads the exact committed integration tree, redacts it and stages a private source snapshot in app data. Installed Graphify runs AST extraction there with LLM keys stripped. The integration revision is checked every 30 seconds even when Graphify is off. A successful, readable graph replaces the prior snapshot; failures preserve the prior graph with its older revision. Your own checkout and assignment worktrees are never used as Graphify input.

Agents query it through MCP:

| Tool | graphify command |
|---|---|
| `query_graph(question, budget?, mode?)` | `graphify query` (BFS/DFS over the graph, token-capped) |
| `graph_path(from, to)` | `graphify path` |
| `explain_node(name)` | `graphify explain` |

The assignment prompt tells headless agents to start with `get_project_context`, a bounded packet containing cited source, revision freshness, their base and other agents’ ownership. They can query Graphify and read additional scoped source when needed. Context size is measured; included-token savings require provider usage evidence.

**Zero extra spend.** Dictionary always strips LLM API-key variables and uses AST extraction. A configured semantic opt-in does not silently switch this intake to paid extraction.

**Install graphify:** `uv tool install graphifyy` (or `pipx install graphifyy`). If it isn't installed, Mission Control shows the graph as *unavailable*; nothing else breaks.
