---
name: interaction-prototyping
description: "Use when wiring a prototype: screen flows, dialogs and drawers, menus and tabs, validation, sample-data updates, conditional visibility and motion."
---

A prototype should let someone complete the main journey and see what happens when things go wrong. Interactions are “when this happens → do this” rules on layers.

1. **Map the journey first.** List the screens of the main flow and how people move between them. Every screen except the first should be reachable (the checks warn otherwise). Provide a way back.
2. **Navigation:** `navigate` to a screen, `back` to return. For navigation bars and tabs, use change events with `match` set to the item label.
3. **Overlays:** dialogs and drawers are screens with `kind: "dialog"` or `"drawer"`, opened with `open-overlay` and closed with `close-overlay` (Escape and the close button also close them). Focus moves inside and returns to the trigger.
4. **Forms:** mark required fields `required`, give each an `errorText`, and put `validate` before the submit action in the same click. Validation stops the chain and focuses the first invalid field.
5. **Sample data:** fixtures hold values the prototype changes. `set-value` updates one (from the event value when `value` is omitted); `bind` shows a fixture in a layer; `visibleWhen` and `when` make layers and rules conditional.
6. **State and feedback:** `show`/`hide`/`toggle` reveal confirmations; `set-state` switches a data view to empty, loading, error, partial, permission or offline; `set-variant` changes a component instance (for example a button to its loading state).
7. **Motion:** `fade` for most changes, `slide` for moving forward through steps or drawers, `scale` for dialogs. Keep it quick; reduced-motion users get opacity only.

Design the unhappy paths too: an error on submit, an empty list, a slow load. Describe the flow in your proposal summary so a reviewer can try it.
