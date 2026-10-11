---
name: responsive-layouts
description: "Use when making screens work at phone, tablet and desktop widths: flow layouts, grids, wrapping, size constraints and per-breakpoint overrides."
---

Design for the content, then let layout respond. Structured designs use flow layout by default; the same layers render at every width.

- **Breakpoints** come from the design settings (phone below about 600px, tablet below about 1024px). Check phone 390, tablet 820 and desktop 1280.
- **Rows that must fit** use `direction: "row"` with `wrap: true` so items drop to the next line instead of overflowing. Toolbars and action groups wrap; navigation may move below the brand on phones.
- **Grids** use `direction: "grid"` with `columns`, and override `responsive.tablet.columns` (usually 2) and `responsive.phone.columns` (1).
- **Widths:** `fill` for content that should take the available space, `hug` for controls and badges, numbers only with care. Fixed widths are capped to the container automatically; still prefer `maxWidth` for readable text (about 680px) and page sections (the container width).
- **Spacing shrinks on small screens:** reduce page padding and section gaps in `responsive.phone` (for example `paddingX: "space-4"`).
- **Type:** reduce display headings one or two steps on phones with `responsive.phone.fontSize`.
- **Hide sparingly:** `responsive.phone.hidden` is for decoration or duplicated content, never for actions or information people need.
- **Tables** scroll inside their own region; keep phone columns few, or offer a list layout for phones.
- **Touch:** targets at least 44px; don’t rely on hover for anything essential.

Use absolute positioning only for overlays and deliberate compositions, and check them at every width.
