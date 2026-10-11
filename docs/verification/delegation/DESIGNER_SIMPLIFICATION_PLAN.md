# Designer simplification — plan (Claude, 2026-10-10)

**Status (same day):** Phases 2, 3 and 4 are done in the working tree; see `CLAUDE_DESIGNER_UPGRADE_PROGRESS.md` (evening update). Phase 1 (branch split, commit) and the Phase 0 decisions on the app mark and font remain the owner's call; Phase 5 waits.

Combines two sessions in this project:

- **Toggle Switch app marketing assets** → built the One Connect design system (artifact https://claude.ai/artifact/KPcR2C8E8rj9Hgk64MF4JQ, repo mirror `design/tokens.json` → `scripts/design-tokens.mjs` → `packages/web/src/tokens.css`, Appearance card in Settings, six themes). Owner narrowed scope: app UI first, ads/website/video/sound/logo later.
- **Designer UI skill simplification** → designed the prompt-first Designer (canvas https://claude.ai/artifact/7PC3T8tVCNGRikF2tL19V1, six screens: Start, Canvas, Selected, Agent working, Review sheet, Design system sheet). Removes the Studio/System/Skills tabs, the four-step strip, the ten-field brief form, the Layers/Components/Assets panel and the five right-side tabs.
- Underneath both: the Designer model/daemon upgrade already in the working tree (`CLAUDE_DESIGNER_UPGRADE_PROGRESS.md`): document schema 2, operations, starters, export/import, routes, 8 skill guides. Core 18/18 and daemon 11/11 pass; the web renderer test has 3 stale failures.

Everything from all three is **uncommitted on `main` in one working tree**.

## Two design systems, two jobs

Keep these apart in the UI and in the code:

| | One Connect brand system | Project design contract |
|---|---|---|
| What | The app's own look: aqua/coral/ink, six themes | The user's project tokens that the Designer freezes into jobs (`design.ts` contract schema 3) |
| Source | `design/tokens.json` → `tokens.css` | `state.design` via `ContractEditor` / `/api/designer/contract` |
| Where it shows | Every page, Settings › Appearance | The Designer's "Design system · vN" sheet |

The mockup's Design system sheet is the **project contract**, styled with the brand system.

## Phase 0 — Owner decisions (blocking)

1. **Commit split.** Two branches from the current tree: `design/brand-tokens` (tokens pipeline, Appearance, styles, shell css, pwa test, `.claude/launch.json`) and `designer/document-studio` (core/daemon/web designer files). Say yes and I split by path.
2. **Legacy Designer.** Delete `LegacyDesigner`, `BriefForm`, `JobCard`-in-studio and the `?tab=` URLs, or keep them behind `?legacy=1` for one release. Recommendation: delete; jobs stay visible in the ask-bar thread and on Mocks.
3. **Skills table** moves to Settings › Designer (read-only list with licences). Confirm.
4. **Brief schema.** `DesignBriefSchema` requires title, brief, audience, screens. The one-box start needs the agent to infer audience and screens. Recommendation: make them optional in core; the agent's first turn proposes screens on the canvas.
5. Still open from the Toggle session: recolour the app mark; self-host Bricolage Grotesque under `packages/web/public/fonts` (Tauri CSP blocks Google Fonts).

## Phase 1 — Land the foundation

- Split and commit per decision 1. Run `node scripts/design-tokens.mjs --check`, core/daemon/web typecheck, web tests.
- Rewrite `packages/web/test/design-document-renderer.test.tsx` for the new starter ids (the 3 known failures).
- Confirm `opencode-harness.test.ts` is pre-existing on a clean checkout.

## Phase 2 — Re-skin the mockups to the brand system (this session, ~1 hour)

The six artboards still use the old teal (`#087e8b` with white text). Update to the brand rules:

- Primary action: `accent #36dede` fill with `on-accent #001f26` ink, hover `accent-strong`. Never white on aqua.
- Ground `bg #f2f8f8`, cards `surface`, borders `border #d5e1e0`, text `#0f2b31` / `#425a60` / `#53676c`.
- Status: `-weak` ground + `-text` text for badges; "needs you" pairs with `warn-*`. Proposed screen outline uses `accent`; the agent's question card uses `sun-weak` ground (one pop fill per view).
- Start title in Bricolage Grotesque (welcome screen only); shell stays system-ui.
- Add a Night-theme board pair (pitch black) and a colour-blind safe variant of the Review sheet to prove the layout does not change between themes.
- Install the design system on the canvas (`project/ds/one-connect/tokens.json` + `designSystems` record) so the Theme menu shows named tokens.

## Phase 3 — Build the simplified Designer (web)

New files under `packages/web/src/components/designer/`, all styled with `tokens.css` variables, no hard-coded colours:

| Artboard | Component | Reuses |
|---|---|---|
| Start | `DesignerHome.tsx` | `DESIGN_STARTERS`, `/api/designer/documents` list + create, agent eligibility |
| Canvas | `DesignerCanvas.tsx` | `useDesignDocument`, `DocumentRenderer`, screens laid side by side, viewport switch, Play |
| Ask bar | `AskBar.tsx` | focused AI jobs (`/api/designer/documents/:id/...` assistant route), run stream (`useRunEvents`, `Transcript` collapsed), approvals as question cards, proposals as Keep/Discard on the canvas |
| Selected | `SelectionPanel.tsx` | `WorkspaceInspector` logic cut to: label, style, colour token, size, icon, one interaction, "more" details, Make reusable / Duplicate / Delete |
| Review sheet | `ReviewSheet.tsx` | `designDocumentFindings` grouped by severity, `mockGate`, `REVIEW_CHECKLIST` as evidence rows, approve → release + handoff |
| Design system sheet | `SystemSheet.tsx` | `ContractEditor` data, swatches with Light/Night toggle, type styles, spacing/shape, components chips, Save as vN, Import from code |

Remove: `LegacyDesigner`, `BriefForm`, `Tabs` on the page, `studio-steps`, `SkillsPanel` (→ Settings), left panel, right-panel tabs, canvas footer, `dw-*` palette in `workspace.css` (replace with token variables).

`Designer.tsx` becomes: no document → Home; document → Canvas + AskBar + whichever sheet/panel the URL or selection opens (`?document=…&sheet=review|system`). Drop the `VITE_DESIGNER_WORKSPACE` flag.

## Phase 4 — Verify

- Offline demo (`.claude/launch.json` from the Toggle session) across the six themes; phone width stacks panel under canvas.
- Keyboard: Tab reaches every control, Escape closes sheets and clears selection, ⌘Z/⇧⌘Z, Delete.
- Web tests green; update `docs/designer.md`; browser + native e2e per the upgrade doc.

## Phase 5 — After the app UI (owner's order)

Marketing site (Figma plugin), ElevenLabs brand audio/video, first-launch sound, logo re-cut, all on the brand system. Not before Phases 1–4 land.
