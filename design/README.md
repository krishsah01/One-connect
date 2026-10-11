# Design tokens

`tokens.json` is the One Connect design system (colour, type, spacing, radius, shadow, duration, easing) in the
Design System artifact format. It is the single source for the app's CSS custom properties:

```sh
node scripts/design-tokens.mjs          # writes packages/web/src/tokens.css
node scripts/design-tokens.mjs --check  # fails when tokens.css is stale
```

Theme ids map onto `<html>` attributes set by `packages/web/src/lib/theme.ts`:

| Attribute | Values | Theme ids |
|---|---|---|
| `data-theme` | absent (follow system), `light`, `dark` | `light`, `dark` |
| `data-vision` | `cb` | `cb-light`, `cb-dark` (Okabe & Ito status colours) |
| `data-contrast` | `high` | `hc-light`, `hc-dark` (7:1 text, 3:1 borders, no shadows) |

Rules of use are in the system's brand book (README, Accessibility and Motion sections). The short version: bright
tokens (`accent`, `ok`, `warn`, `info`, `coral`, `sun`, `grape`) are fills that carry `on-accent` ink; `crit` carries
`on-crit`; every status dot, icon, outline or text uses the `-text` variant; focus is the two-ring `--focus-ring`.
