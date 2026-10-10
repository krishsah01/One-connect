# Project skills

Project skills are reusable, versioned `SKILL.md` instructions stored in the control center. Agents see only each skill's one-line description in their assignment prompt until they call `get_skill` for the full instructions.

## Draft, publish, assign

1. **Draft** — edit in the Skills page or import from local files. Drafts are validated, secret-scanned and never run code or make outbound calls.
2. **Publish** — freezes the current saved draft as an immutable version. Publishing requires both the expected latest version number and the exact draft hash you reviewed.
3. **Assign** — add published skills to an agent in **Setup**. Assignments freeze the exact version and hash at creation time.

Built-in designer skills are pinned by hash with their license notices and cannot be edited or exported.

## Import and export

**Import** accepts:

- A `SKILL.md` file with YAML frontmatter (`name`, `description` only) plus optional `references/<name>.md` or `.txt` files selected in the browser.
- A One Connect JSON bundle (`format: one-connect-skill-bundle`).

Import preview validates paths, sizes, secrets, YAML safety and bundle SHA-256 hashes. Preview does not create drafts. Saving uses the normal optimistic draft save and cannot shadow a built-in id.

**Export** downloads an immutable project version as JSON with exact file bytes and per-file SHA-256. Hashes prove integrity, not trust. Attribution (`source`, `license`) is included when supplied; unknown remains unknown.

## Templates

The Skills page offers three original Apache-2.0 templates:

- **Evidence-first review** — independent review with cited evidence.
- **Local Docker and database work** — approved local compose/database changes within scope.
- **Cited Dictionary research** — `search_context`, `read_note` and graph tools with citations.

Templates load into the editor as new drafts. They are not auto-published or assigned.

## Provider export

When a run starts, frozen skills are written into the assignment worktree under the harness-specific directory (for example `.agents/skills` or `.claude/skills`). Paths the repository already tracks, foreign files, symlinks, hardlinked files and worktree edits are never overwritten.
