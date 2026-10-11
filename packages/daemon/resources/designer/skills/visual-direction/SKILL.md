---
name: visual-direction
description: "Use when shaping or changing a design's visual direction and foundations: palette, semantic colors, type, spacing, shape, elevation and motion."
---

A visual direction is a short promise about how the product feels, carried consistently by tokens. Decide it once, express it in foundations, and let components inherit it.

1. **Write the direction first.** One or two sentences: the feeling, the audience and what to avoid (for example “Calm and precise for finance teams; no playful illustration”). Propose it with `set-direction`.
2. **Palette, then roles.** Primitive scales (`brand-50`…`brand-950`, `neutral-*`, status scales) hold raw values. Semantic roles alias them for each theme with `alias` and `darkAlias`: `canvas`, `surface`, `surface-subtle`, `text`, `text-muted`, `border`, `border-strong`, `accent`, `on-accent`, `accent-subtle`, `focus`, `success`, `warning`, `danger`, `info` and their `-subtle` backgrounds. Components use roles only.
3. **Contrast is a constraint, not a check at the end.** Body text and labels need 4.5:1 on their surfaces in light and dark themes; large text and UI boundaries 3:1. Pick the accent step that passes on `surface`, and an `on-accent` that passes on the accent.
4. **Type.** One family for interface text, optionally a second for headings. A modular scale (`text-xs`…`text-4xl`) with a ratio of about 1.2 for dense products and 1.25–1.3 for expressive ones. Headings use `leading-tight` and slight negative tracking; body uses `leading-normal`.
5. **Space and shape.** A 4px-based spacing scale (`space-1`…`space-8`). Corner radii (`radius-sm`, `radius-md`, `radius-lg`, `radius-full`) express the tone: crisp (2–4px), gentle (6–10px), soft (12–20px). Shadows stay subtle; flat systems separate layers with borders.
6. **Motion.** Durations of about 120ms for feedback, 200ms for small transitions and 320ms for large ones, with standard easing. Every motion has a reduced-motion meaning (opacity only).

Propose foundation changes as `set-token` operations, and use `replace-token` when renaming or merging tokens so every reference moves with it. Never change the published system yourself: a person publishes foundations after reviewing them.
