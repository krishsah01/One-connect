# Claude task: finish the One Connect Designer studio

Build the **complete mock-design workflow** inside One Connect: a user describes a product screen, chooses a design agent, gets an interactive mock, refines it, checks it, and hands an approved, versioned design system to engineering. This is a substantial product implementation task, separate from the One Answer work assigned elsewhere.

## Start from the actual project

Repository: `/Users/krishkumarsah/Docs/Projects/Interface`.

Read repository instructions, `docs/architecture.md`, `docs/designer.md`, the mock documentation, `packages/core/src/{design,mocks,skills}.ts`, `packages/daemon/src/{designer,mocks,skills}.ts`, `packages/daemon/src/server/libraryRoutes.ts`, and `packages/web/src/pages/{Designer,Mocks,Skills}.tsx`. Inspect the current tests and bundled designer skill manifest. There is already a saved design contract, pinned skills, issue/assignment-based design dispatch, content-addressed mock capture and a hardened native preview boundary. Finish and connect those pieces; do not create a second designer or replace them with sample screens.

The coordinator is rebundling the Mac app. Other agents are finishing provider, phone, release, connector and onboarding work. **You are not alone in this repository.** Preserve all existing changes. Work in an isolated checkout/worktree containing the current working source, including uncommitted/new files, rather than HEAD alone. Use `codex/claude-designer-studio` if a branch is needed. Do not reset/stash/revert or commit anyone else's changes. Do not edit the primary checkout or its native bundle while working.

## Ownership and boundaries

Own `packages/daemon/src/designer.ts`, `packages/daemon/src/mocks.ts`, dedicated new designer/mock modules, `packages/core/src/design.ts`, `packages/core/src/mocks.ts`, `packages/web/src/pages/Designer.tsx`, `packages/web/src/pages/Mocks.tsx`, dedicated designer components/styles, focused designer/mock tests and documentation. Preserve all native mock sandbox and filesystem protections.

Small shared-file integrations into skill selection, core entities/events/reducer, API/MCP routes, assignment generation, agent handoff hooks, Work Board or App navigation should be supplied as explicit minimal patches/snippets with contracts for the coordinator. Do not edit One Answer/context/Obsidian/Graphify modules, general App navigation/onboarding, vendor harnesses, costs, Decisions authorization, phone, release, Docker safety, native Rust/Swift sandbox or desktop packaging. If a shared integration is essential, explain it precisely rather than bypassing its owner.

## Deliver the product flow

### 1. A useful design brief and generation flow

Turn the existing Designer page into a clear studio with a short brief, audience, desired screens/states, project design system, selected agent and a visible generation job. Support a pilot/prototype as well as revising an existing project UI. Generate a reviewable issue and assignment using the existing dispatch/preflight system; every actual agent run remains linked to that issue, its own worktree and a frozen design contract. The agent's full running text, questions, approvals and errors must be available from the studio through the same durable run stream, not a fake progress animation. Preserve official subscription harnesses and existing included-plan checks; do not invent an API-only generator or ask the user to work in another agent app/CLI.

Give the agent an exact bounded design prompt: deliver self-contained HTML/CSS/JS under `design/<slug>/`, use the frozen tokens, cover meaningful empty/loading/error/success states, include accessible interactions, and return a structured handoff with artifact paths, contract identity, checks and limitations. Skills should be loaded on demand instead of dumping all reference text into every prompt. Clearly show unsupported runtime capabilities and route questions through existing in-app mechanisms. Paid API generation stays off unless an existing per-agent approved configuration enables it.

### 2. Versioned project design systems agents must follow

Expand the existing contract into practical semantic color roles, typography, spacing, radius, borders, elevation, layout, motion, component recipes and interaction/accessibility rules. Keep defaults coherent with One Connect's ink/pearl/teal visual language. Support useful light/dark and density settings without multiplying arbitrary options. Editing and saving produce immutable human-authored versions with exact hashes and readable diffs. Preview a draft, validate it, then save; do not present an unsaved draft as the approved contract.

Keep assignments frozen to their original contract. Changing the current project contract must invalidate relevant current-design approvals or show drift explicitly; it cannot silently rewrite active runs. Generate consistent `DESIGN.md`, `tokens.css` and machine-readable tokens from one representation. Provide focused component/state examples and clear handoff instructions so engineering agents can implement the approved system. Record exceptions with evidence and human authorship. Contrast checking alone cannot pass the whole design or accessibility gate.

### 3. Default designer skills, honestly attributed

Preserve the bundled, pinned Taste Skill, Vercel Web Interface Guidelines, VoltAgent awesome-design-md references and Microsoft Playwright CLI guidance requested by the owner. Keep their exact source attribution, hashes, licenses and notices. Add useful original skills for product UI, typography/content hierarchy, responsive interaction, accessibility, design-system implementation, visual critique and browser verification where there are actual gaps. Expose what is selected for a design task and make rules understandable. Store only compact capability/skill summaries in prompts; retrieve bounded selected details when needed.

The owner approved inspecting/reusing `https://github.com/nexu-io/open-design.git`. This repo already pins approved text resources from revision `53231d40b778d88eba23f35547bf99485d3ae9fc`; inspect that integration first. Reuse more code only if needed, commercially compatible, license-preserving and compatible with the existing safe local architecture. Do not blindly clone a second app, copy vendor logos, enable hosted media services, install a binary/plugin, add a paid provider or claim upstream attribution for new original text. Any new dependency requires primary-source license/provenance review and notices. Do not change the owner's Apache-2.0 choice.

### 4. Capture, compare and iterate actual mock artifacts

Connect successful design handoffs to the existing validated artifact capture flow. Show generated artifacts and their run/issue/worktree/SHA/contract identity; surface capture failures rather than losing the output. Do not mark a mock generated because a run merely exited. Support multiple pages and meaningful interactions using local fixture data, phone/tablet/desktop viewports, revision history and comparison. Include editable source or a scoped patch/refine flow, draft versus captured-revision distinction, and undo/history. A refine request should create or reuse a properly scoped issue-linked assignment, not silently mutate immutable artifacts or run arbitrary host shell commands.

Preserve the current self-contained asset validation, size limits, secret redaction, allowed paths, immutable content-addressed storage, symlink/hardlink defenses and exact-read capture behavior. Every revision must remain reproducible after daemon restart. Avoid destroying drafts when switching projects, opening another mock or waiting for an agent. Make the artifact gallery useful when empty, generating, failed, interrupted or containing old-contract revisions.

### 5. Functional local preview without a security regression

Use the existing native preview boundary and honest browser fallback. Generated JavaScript can implement mock interactions but cannot reach dashboard auth, daemon APIs, native IPC, host files, another mock or external network. Preserve separate website data storage, navigation guards, process/filesystem isolation and restrictive CSP. Do not relax them to make a demo work; adapt artifacts to the approved self-contained format. Do not claim a browser iframe provides the same guarantees as the isolated native preview. Link/form/navigation behavior must be understandable to the user and remain contained.

Provide accurate selected-page, viewport and revision state. Make keyboard interactions, focus and reduced motion work in the studio itself. A static image is not an interactive mock. Screenshots of source text or browser-control code are not rendered evidence.

### 6. Review and engineering handoff with real proof

Provide a design review checklist tied to a specific artifact revision and contract: responsive layout, keyboard/focus, contrast, content states and visual/token compliance. Distinguish static checks from executed browser checks and human visual review. Attach actual screenshot/check evidence with action, viewport, artifact identity, timestamp, result and tool. Use already-installed official Playwright tooling if available and authorized; do not install it automatically or fabricate evidence if unavailable. Independent review must remain independent; the author cannot be the sole reviewer.

Approval must be invalidated when the reviewed artifact changes. Exports should contain the exact approved artifact, versioned design contract/tokens and handoff evidence. Engineering tasks must reference that identity and include appropriate implementation checks. Do not claim a finished product or passing implementation just because a mock was approved. Exporting locally is distinct from publishing; publishing/deploy/outbound actions require their existing per-action Decisions.

## Acceptance demonstration

Make this end-to-end flow work on a disposable local project:

1. Choose/save a project design system and verify its immutable revision.
2. Enter a nontrivial multi-screen brief with loading/empty/error states; select an eligible subscription agent and preview its exact scoped assignment.
3. Dispatch through existing machinery. Observe actual child-process output and answer an agent question inside One Connect. Official providers must not be invoked live without authorization; an actual fixture child-process protocol is acceptable but must be labelled.
4. Capture the generated self-contained mock from the assignment worktree. Open and exercise its interactions at phone/tablet/desktop widths through the native boundary.
5. Refine part of the mock and compare immutable revisions; stale approval/contract drift must be visible.
6. Record independent design review and actual check evidence, approve the exact revision, and export a coherent artifact + `DESIGN.md` + tokens + evidence bundle.
7. Prepare an engineering assignment bound to the approved design identity. Switch projects and restart the daemon; state, artifacts and evidence survive without leakage.
8. Try malicious navigation/network/IPC references, path escapes, changed capture files, symlink replacement, oversized files and secret-bearing artifacts. Existing guards must continue refusing them. Tests cannot substitute for actual native isolation proof; record any unrun native checks as pending.

## Validation and handoff

Write meaningful focused unit, integration and contract tests for real generation/capture/refinement/review transitions, revision/contract invalidation, source edits, multi-page preview navigation, project isolation, restart persistence, pinned skill selection, bounded prompt context and hostile artifacts. Keep direct Node 24 strip-only runtime checks where the daemon uses TypeScript without transpilation. Run the relevant existing tests, typechecks, production web build, SPDX and touched-resource notice/hash checks. Do not run unrelated broad gates repeatedly or modify expectations to hide implementation defects.

Use the current design system and existing frontend design skill if available. Record real rendered interactions/screenshots when UI tools are available. No telemetry, live network integrations, downloads, account changes, paid infrastructure, provider/model fallback, publishing, production writes or outbound messages. The coordinator owns native rebundling and final product acceptance.

Deliver your code in the isolated checkout, exact changed-file and commit/patch list, focused test commands/results, real rendered evidence where available, any minimal shared-file integration patches, updated designer/mock docs and `CLAUDE_DESIGNER_HANDOFF.md`. Mark each acceptance item implemented-and-verified, implemented-but-unverified or still missing. DCO-sign only your own commits. Do not declare all of One Connect complete. Continue independent work when a tool is unavailable; clearly document external prerequisites without silently enabling them.
