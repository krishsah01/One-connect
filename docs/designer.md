# Designer

Designer is One Connect's design studio. You describe an interface in one sentence; your design agent proposes screens on a canvas; you keep or discard each proposal, tweak what you select, and review a frozen release against your project's versioned design system before handing it to engineering.

## At a glance

The Designer has one start screen and one canvas.

- **Start** (`/designer`): one text box, the design agent, and a mode (new prototype or revise existing UI, which lets you point the agent at repository files to recreate read-only). **Start designing** creates a design document from the sentence and gives the agent a *generate* job. Starters and recent designs sit below.
- **Canvas** (`/designer?document=<id>`): every screen side by side at the chosen viewport (phone, tablet, desktop). Click a layer to select it; the panel appears only then. **Play** runs the prototype. The status word in the top bar is one of Draft, Agent working, Needs you, Needs attention, Ready for review, Approved.
- **Ask bar**: the only way to talk to the agent. A request becomes a focused job scoped to the selected layers (or the whole design) that the agent answers with proposals. Progress, questions (answered in place) and the transcript unfold above the box. Proposals land on the canvas next to the screens they change with **Keep** and **Discard**; nothing is applied otherwise.
- **Review** and **Design system** are sheets opened from the top bar (`?sheet=review|system`). Review groups findings, lists evidence, takes your checklist and approval, and prepares the engineering handoff. Design system shows this draft's foundations and publishes them as the project system; the full project contract editor is folded inside.
- Keyboard: ⌘Z / ⇧⌘Z, ⌘D duplicates, Delete removes, Escape closes the sheet or clears the selection.

The pinned skills table lives under **Settings → Designer skills**. The brief form, workflow strip and section tabs of earlier releases are gone; the sections below describe what happens underneath.

### The Design node on the canvas

A workflow's **Designer artifact** node attaches one finalized mock to the steps plugged into it. Its inspector lists every mock artifact in two groups: **Finalized** (a revision whose approval holds on the current project design system, including the independent review) with a **Use** button, and **Not finalized** with the reason (needs independent review, needs review, changes requested, not approved yet) and a link into the Designer's Review sheet or the Mocks page. Once attached, the inspector shows a miniature of that exact revision: the structured runtime for design releases, with chips to switch screens, or the sandboxed static render for HTML mocks, with page chips. **Detach** clears it; **Design a new mock** opens the Designer. The node's pill shows the attached mock's title and revision, and workflow validation keeps refusing a revision whose approval no longer holds.

## 1. Project design system

The **Design system** sheet (and its folded contract editor) edits the project contract. It holds:

- **Color roles**: canvas, surface, subtle surface, text, secondary text, accent, on accent, divider, focus ring, and success, warning, danger and information. There is a light and a dark palette. *Appearance* chooses light, dark, or both (following the viewer's system setting).
- **Typography**: system or serif-display pairing and a base size, using a fixed 1.2 scale.
- **Shape and density**: density (compact or comfortable), corner radius, border width and elevation (soft shadows or flat borders).
- **Layout, motion and accessibility**: maximum width and navigation style, motion (subtle or reduced), minimum target size and focus-ring width.
- **Text**: project component notes and rules.

Your edits are a **draft**. It is autosaved on this project's daemon, so it survives reloads, project switches and long agent runs. It is never the approved contract. The specimen beside the form renders buttons, fields, status badges, keyboard-operable tabs, a dialog that returns focus, a table and all four content states from the draft. You can view it in light or dark.

**Validate draft** parses and measures the draft on the daemon. You get errors, warnings, a SHA-256 and a readable field-by-field diff against the current version. Nothing is saved. **Save as vN** is enabled only for that exact validated draft. It records an immutable, human-authored revision with its hash, parent and an optional note. Blocking contrast failures in any active mode prevent saving. These cover body, secondary and status text, action labels, links, the focus ring and input boundaries. Contrast is necessary but never sufficient: keyboard, screen-reader, zoom and state behavior are judged on actual mocks.

Every revision generates, from one token table:

- `DESIGN.md`: roles, type, spacing, shape, layout, motion, accessibility rules, component recipes, measured contrast and engineering instructions.
- `tokens.css`: `--design-*` variables, a dark block when both modes are active, and a reduced-motion override.
- `tokens.json`: Design Tokens Community Group groups carrying the contract identity.
- A static component and state specimen.

**Versions** lists every revision, with its diff, comparison against any other revision and downloads.

Schema 1 contracts saved before this format remain readable. They render their original `tokens.css` byte-for-byte, so assignments frozen to them stay stable. A schema 1 revision is upgraded only when a human saves a new one.

Saving does not touch existing assignments or active runs. Each assignment keeps the revision frozen when it was created. Mocks built on an older contract show **contract drift**. Any approval made under the old contract becomes **stale** until a human records a drift exception or approves a revision built on the current contract.

## 2. Briefs and design jobs

Legacy design jobs (self-contained HTML mocks) are still created from the Mocks page for refinement and engineering handoff. A legacy brief covers:

- the mode: a new prototype, or a revision of existing UI that the agent studies read-only;
- the title, problem and audience;
- the screens, which map to `index.html` and one page per further screen;
- the states every data view must show: empty, loading, error and success, plus partial, permission and offline when needed;
- key interactions, plausible fixture data and the design agent.

The brief is autosaved as a draft.

The agent list shows each agent's eligibility. Relay agents and coordinator-only agents are excluded, because the studio never asks you to work in another app. Per-token logins are shown and blocked unless that agent has an existing, explicit metered configuration, which is never used as a fallback. Pre-flight remains the final check. That includes the included-plan confirmation in **Agents & sign-in**.

The job card shows the exact assignment prompt and the pre-flight results, and has **Dispatch**. The prompt's design section is bounded. It contains:

- the frozen contract version and hash;
- the deliverable folder `design/<slug>/` and exact page files;
- the required states and a visible state switcher;
- accessibility requirements;
- the isolated preview's runtime limits: no network, no storage (`localStorage`, `sessionStorage`, IndexedDB and cookies throw in the opaque sandbox), no new windows or real form submission, and the file types and sizes allowed;
- `ask_human` for questions;
- `register_design_mock` with a structured `handoff`.

Skills appear as one-line descriptions only; agents load them with `get_skill` when they apply.

After dispatch, the card streams the agent's real transcript from the durable run stream. Questions appear as approval cards you answer in place, as in Decisions. You can message the agent, stop the run or open the agent console.

A job is **captured** only when an immutable revision exists. A run that merely exits is not a mock:

- When a studio run completes without registering its folder, One Connect tries to capture `design/<slug>/` from the worktree.
- Every capture attempt is recorded, including rejections. A failed or interrupted job shows the reason and offers **Capture … now**.

## 3. Mock artifacts and revisions

**Mocks** shows captured artifacts with a static thumbnail, gate state, approved revision, stale approvals and older-contract markers. An *In progress and needing attention* list shows jobs that are drafting, running, waiting, failed or interrupted, or whose capture failed. You can still capture any `design/<slug>/` folder from an assignment worktree.

Each revision is immutable and content-addressed. It records:

- its issue and assignment (a refinement may continue the artifact on a new assignment);
- the git SHA, run and frozen contract;
- who captured it, and who authored the content: the agent for worktree captures, you for scoped edits.

Capture keeps every existing protection: contained, no-follow reads that use the native helper on macOS, exact-byte capture, symlink and changed-file refusal, size and type limits, secret refusal, allowed paths and SHA-256 blob storage. Files in `design/<slug>/evidence/` are screenshots and are never captured as mock content.

Static findings run at capture. They report:

- remote resources and network APIs;
- browser storage APIs;
- off-palette colors, and tokens that are unused or out of date;
- a missing viewport meta tag or document language;
- pages the brief asked for that are missing;
- a structured handoff that is missing, invalid, or contradicted by the captured files or the frozen contract.

Errors must be fixed. Warnings can be fixed or excepted by a human, with a written rationale.

The detail view keeps the selected **revision, page and viewport** in the URL. Its tabs are:

- **Compare** lists added, removed and changed files, shows a bounded line diff and renders two revisions side by side.
- **Source** keeps an autosaved draft per file. Saving writes the file through the scoped edit path and captures a new revision. *Restore this file from revision N* copies an older version into a draft. That is the undo: history is never rewritten.
- **Refine** sends a request for the latest revision. It continues the same assignment session when the harness can resume and the agent is free, keeping the same issue, worktree and frozen contract. Otherwise, or when you choose a new scoped task, it creates a child issue and a draft assignment. That assignment starts from the source branch, may write only the mock folder, freezes the current contract, and its captures continue the same artifact.

## 4. Preview

- **Desktop app.** *Open interactive preview* opens the revision in a separate native window with an engine-level WebRTC denial, a non-persistent website data store, network rules, navigation denial and a restrictive CSP. Every page of the revision is embedded in a trusted shell, so local links (`<a href="page.html">`) and `history.back()` work inside the window. A short status message explains anything that was blocked: external links, simulated form submissions, new windows and pages that are not part of the revision.
- **Browser dashboard.** Shows a **static layout render**: scripts, event handlers and links are removed, and the iframe is sandboxed with no permissions. It is labelled as a layout check, not the interactive mock. It does not provide the native window's isolation, so mock code never runs there.

## 5. Review, evidence and approval

Evidence is bound to one revision, and records that revision's content hash and contract. Each entry has a kind (command, screenshot or viewport check), what was done, the tool, the viewport, the page, a timestamp and a result.

- Unexecuted checks are recorded as *not run*.
- An agent's command is marked *observed* only when One Connect saw that command and exit code in the agent's own run transcript.
- Screenshots come from three places. A human can upload a PNG, JPEG or WebP of up to 5 MB. An agent can provide `design/<slug>/evidence/<name>.png` of up to 512 KiB, read through the same contained path. Or the image can be part of the revision. One Connect cannot tell what an image depicts; reviewers judge that.

The **review checklist** has five items: responsive layout, keyboard and focus, contrast, content states, and visual and token compliance. Each item records its result and its basis:

- *static*: measured from source;
- *browser*: an executed check, linked to passed evidence on this revision;
- *human*: you looked at the rendered mock.

Approval requires every item to pass and no open findings. Static checks can only pass contrast. Browser bases must link executed, passed evidence.

**Independence.** The author of a revision's content cannot be its only approver:

- A human approval of an agent-authored revision is independent.
- A revision produced by your own source edit needs an independent reviewer as well. **Request independent review** creates a read-only review issue and assignment for a different agent. That agent reads the revision with `get_design_mock` and submits `submit_design_review` with its own checklist (static or observed-browser bases). Its verdict is advisory; a human still makes the decision.

Approvals belong to exact revisions and never carry to a later one. A contract change makes them stale.

## 6. Handoff and engineering

The **Handoff bundle** is exported locally; nothing is published, pushed or sent. It contains:

- the exact files of the revision;
- a manifest with its identity, gate, approval checklist, reviews, exceptions, evidence and the agent's handoff claims;
- the evidence screenshots;
- `DESIGN.md`, `tokens.css`, `tokens.json` and the component specimen of its contract;
- `HANDOFF.md`.

*Require an approved revision* refuses any other revision.

**Prepare engineering task** works only for an approved revision built on the current contract. It creates an issue and a draft assignment that cite the artifact, revision, content hash and contract hash. The acceptance criteria cover tokens, states, keyboard and focus, phone, tablet and desktop evidence, and the project's checks. The assignment is frozen to that contract and gets the implementation skill set. Review and dispatch it like any task. A mock approval is not a passing implementation. Publishing and deploying keep their own per-action Decisions.

## 7. Skills

Pinned upstream skills:

- Taste Skill (MIT), for landing pages and redesigns only;
- Vercel Web Interface Guidelines (MIT);
- VoltAgent DESIGN.md reference analyses (MIT);
- a One Connect guide for an already-installed official Playwright CLI.

Original One Connect skills (Apache-2.0): design-system contract, accessible product UI, responsive mocks, product UI patterns, typography and content, design-system implementation, and visual critique.

Selected resources come from the owner-approved [Open Design](https://github.com/nexu-io/open-design) revision `53231d40b778d88eba23f35547bf99485d3ae9fc`, whose Apache-2.0 license is retained. Every file is pinned by SHA-256 in the designer manifest and verified on each read. Notices are in THIRD_PARTY_NOTICES.md. No hosted service, binary, vendor media API or telemetry is enabled.

How skills are selected:

| Task labels | Built-in skills |
|---|---|
| `design`, `ui`, `mock`, `frontend`, `branding` | The whole library |
| `design-implementation` | Implementation set |
| `design-review` | Review set |

**Skills and sources** shows the selection and each skill's purpose. Prompts carry descriptions only.

## Agent tools (MCP)

| Tool | Use |
|---|---|
| `get_design_system` | The frozen contract: DESIGN.md, tokens.css, checks. |
| `register_design_mock` | Capture `design/<slug>/` with an optional structured `handoff` (summary, pages, states, interactions, checks, limitations, questions, contract hash). |
| `record_mock_evidence` | Command, screenshot or viewport evidence with action, tool and page. |
| `get_design_mock` | Bounded read of a revision the agent produced or was asked to review. |
| `submit_design_review` | Independent, advisory review with checklist and bases. |

## Verification

The tests for this area are:

- `packages/core/test/design-studio.test.ts`: the contract, gate, compare, preview and job logic;
- `packages/daemon/test/designer-studio.test.ts`: end to end with the labelled fixture CLIs, covering dispatch, an in-app answer, capture, review, both kinds of refinement, drift, the bundle, the engineering task and restart; also capture failures, independent review over MCP, hostile evidence, project isolation and schema 1 contracts;
- `packages/daemon/test/designer.test.ts` and `mocks.test.ts`;
- `packages/daemon/test/designer.strip.test.mjs`: strip-only Node;
- `packages/web/test/designer.test.tsx` and `live-store.test.tsx`.

The real-engine preview isolation tests run with `ACC_MOCK_TEST_WEBKIT` and `ACC_MOCK_TEST_CHROMIUM`. Native window checks happen in the desktop app.
