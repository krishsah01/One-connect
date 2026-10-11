---
name: component-architecture
description: "Use when creating or changing reusable components: what deserves a component, variants versus states, props, slots and safe changes to shared definitions."
---

Components keep a design consistent. Make one when the same structure appears twice or will clearly repeat; keep one-off layouts as plain frames.

- **Variants** are deliberate alternatives a designer chooses (primary, secondary, ghost, danger; default, highlighted). **States** are conditions the interface enters (hover, disabled, loading, error, selected). Both are property overrides keyed by inner layer id.
- **Props** name the few things each use changes: label, value, help text, an image. Map each to one inner layer field. Prefer three meaningful props over ten granular ones.
- **Slots** hold content the component doesn’t own (a card body, dialog content, toolbar actions). An instance fills a slot with child layers whose `props.slot` is the slot layer id.
- **Nesting:** components may contain instances of other components (a dialog uses buttons). Avoid deep chains; never create cycles.
- **Naming:** plain, specific names (“Metric card”, not “Card 2”). Layer names inside describe their role (“Title”, “Value”, “Actions”).

Changing a shared component changes every instance. Before proposing:

1. Read `get_design_components` and check which screens use it (the summary lists instances per screen through findings and screen reads).
2. Keep inner layer ids stable so instance overrides survive. Removing a layer, variant, state or slot that instances use breaks them; say so in the summary and update those instances in the same proposal (`update-node` on the instance overrides or variant).
3. Use `make-component` with `replace` to convert repeated copies into instances in one step, preserving their differing text as overrides.
4. Document `usage` (when to use it, when not) and `accessibility` (keyboard, names, announcements) on the component with `set-component`.
