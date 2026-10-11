# Designer upgrade — progress handoff (Claude, 2026-10-10)

Continues Codex's first pass of the "complete UI design studio" plan. All work is uncommitted in the primary checkout on `main`.

## Done and tested
- **Model (core):** `designDocumentTypes.ts`, `designFoundations.ts` (typed tokens with strict value grammars, light/dark aliases, settings, content guide, foundation generator), `designDocument.ts` (schema 2 + v1 migration, copy-on-write ops incl. insert-tree, wrap/unwrap, add/replace/remove-component, detach-instance, replace-token, set-libraries; history patches; findings with screen/component locations; where-used), `designStarters.ts` (19-component library, 5 multi-screen starters with flows, `proposeDesign`), `designExport.ts` (React/TS package + zip), `designImport.ts` (HTML → editable design). Contract schema 3 in `design.ts`. Preflight `design_binding` check.
- **Daemon:** `designDocuments.ts` rewritten (patch history, conflicts/proposals, assets, focused AI jobs, kits with reviewable updates, foundations with required replacements, hashed releases in content-addressed storage, handoff, dispatch-time binding check, rebuild from mock); `designDocumentRoutes.ts`; MCP tools registered before `connect`; mocks/workflowOptions updated; 8 new pinned skill guides.
- **Web:** new `DocumentRenderer.tsx` runtime (all kinds, slots, variants/states, overlays with focus trap, validation, menus, tabs, charts, data states), `useDesignDocument.ts` (optimistic queue, rebase, reload recovery), `controls.tsx`.
- Tests: core 18/18, daemon 11/11 passing. Typecheck passes for core, daemon, web.

## Left to do
1. Rewrite `packages/web/test/design-document-renderer.test.tsx` (3 failures: old starter ids).
2. Build the new workspace UI on top of `useDesignDocument` + controls: Canvas (overlay, resize, drag-reorder, keyboard), Layers, Library, Inspector (responsive, component edit mode with affected-instance preview), Prototype panel, Flow map (@xyflow), Assistant, Review (grouped findings, browser checks as evidence, approval, handoff/adopt), System builder, Home (three entry paths). Replace Codex's `DesignerWorkspace.tsx`/`WorkspaceInspector.tsx`; rework `workspace.css` onto app theme variables; update `StructuredStage.tsx` to `/api/designer/releases/:id/:rev` bundle (`assets` map).
3. Legacy URLs: show legacy Designer when `?tab=` is present; Mocks page “Rebuild as editable design” button (`POST /api/designer/mocks/:id/:rev/rebuild`).
4. Update `docs/designer.md`; browser + native e2e; full suite.
5. `opencode-harness.test.ts` fails 16/17 even alone — appears pre-existing; confirm on a clean checkout.

## Update 2026-10-10 (evening): simplified Designer UI built

Replaces item 2 of "Left to do". The three-panel `DesignerWorkspace.tsx`, `WorkspaceInspector.tsx`, `workspace.css`, `BriefForm.tsx` and the legacy tabbed `Designer.tsx` are gone. The new UI lives under `packages/web/src/components/designer/studio/`:

- `DesignerHome.tsx` (one-sentence start, starters, recent), `DesignerStudio.tsx` (canvas, top bar, Play, proposals with Keep/Discard, keyboard), `AskBar.tsx` (requests → focused AI jobs → dispatch; thread with status, questions as ApprovalCards, transcript), `SelectionPanel.tsx` (appears only on selection), `ReviewSheet.tsx` (findings, evidence, release, checklist approval, independent review, handoff), `SystemSheet.tsx` (document foundations, publish as project system, folded ContractEditor), `model.ts`, `studio.css` (brand tokens only).
- Skills table moved to Settings (`DesignerSkills.tsx`). Mocks links point at `/designer`. `docs/designer.md` has an "At a glance" section.
- Tests: `designer.test.tsx` rewritten (3 cases), `design-document-renderer.test.tsx` fixed to real starter ids. Web suite 177/177, web typecheck clean.
- Verified live in a private offline demo (daemon on 7319 + vite on 5174 via `.claude/launch.json` entry `web-designer`): start → canvas with 4 screens → select → publish foundations → release → approve (gate then asks for an independent review, shown as such). Dispatch of the fake Codex agent was refused by the demo's billing pre-flight; the banner explains it and the thread keeps a Start button.

Still open: items 3–5 above; the mockup canvas at https://claude.ai/artifact/7PC3T8tVCNGRikF2tL19V1 is re-skinned to the brand tokens with the design system installed.

### Later the same evening
- Mocks page: each revision has **Open in Designer** (structured) or **Open as editable design** (legacy HTML mock → `POST /api/designer/mocks/:id/:rev/rebuild`, then `/designer?document=`). Closes item 3's Mocks half; `?tab=` legacy URLs are simply gone.
- Ask bar: a request prepared before the tracker confirms its issue now re-checks pre-flight and dispatches itself once the key arrives (test: "starts a prepared request by itself"). The demo's billing pre-flight still blocks dispatch until the owner confirms billing in Agents & subscriptions.
