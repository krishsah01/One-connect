---
name: design-system-implementation
description: "Use when implementing an approved design contract and mock in application code, or when mapping design tokens into a codebase's styling layer."
---

1. Pull `get_design_system` and confirm its version and hash match the approved identity in your assignment. If they differ, stop and ask with `ask_human`.
2. Map tokens once. Import `tokens.css`, or translate `tokens.json` into the project's existing styling layer (CSS variables, a theme object, a Tailwind config). Keep the `--design-*` names or a documented one-to-one mapping. No literal colors, sizes, radii or durations outside the token layer.
3. Build shared components from the DESIGN.md recipes before building pages: button, field, card, table or list, badge, tabs, dialog and notice. Each needs its documented states: hover, focus-visible, active, disabled, loading and invalid.
4. Rebuild each approved page with those components. The mock is a reference for structure, content and behavior, not code to copy. Wire real data paths with the same empty, loading, error and success states the mock shows.
5. Accessibility is part of done: semantic elements, labels, keyboard paths, focus management for dialogs and route changes, reduced motion and 200% zoom.
6. Verify and report actual results: the project's checks, a keyboard walkthrough, and phone, tablet and desktop screenshots or browser checks. Missing tooling means "pending", not "passed".
7. A deviation from the approved mock or contract is a design exception for a human to record, never a silent change.
