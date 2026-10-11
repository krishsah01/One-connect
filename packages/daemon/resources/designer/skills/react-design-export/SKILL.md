---
name: react-design-export
description: "Use when implementing an approved structured design release in an application, using its React/TypeScript source package."
---

An approved structured release includes a React/TypeScript package (read it with `get_design_mock` under `source/`) built from the same runtime and component definitions as the approved preview.

1. Confirm the identity: the artifact, revision and release hash in your assignment must match `get_design_mock`. If they don’t, stop and ask with `ask_human`.
2. Read `source/README.md` first: components with their props, variants, states and slots; screens; theming; data hooks.
3. Choose an approach and say which in your handoff:
   - **Adopt the package:** add it to the codebase, import components and screens, pass real data through `fixtures` or component props, and connect behavior through `onAction`. Keep `design.json` and the runtime unmodified so the implementation stays identical to the approved design.
   - **Rebuild natively:** implement the components in the project’s own component system, using `tokens.css` (or a one-to-one mapping into the existing theme) and the component definitions in `design.json` as the specification for variants, states, spacing and behavior.
4. Never change the design to fit the code. A deviation is an exception for a person to record.
5. Replace sample data with real data paths, and implement every designed content state (empty, loading, error, partial, permission, offline where present).
6. Verify: the project’s checks, a keyboard walkthrough, focus management for dialogs and drawers, phone/tablet/desktop renders in light and dark themes. Report exact commands and results; missing tooling is “pending”, not “passed”.

Edits to the package don’t flow back into Designer. Design changes need a new reviewed release.
