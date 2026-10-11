# One Connect marks

Re-cut of the app's original mark (one hub, two agents, two struts) in the design-system palette. Geometry is shared by
every file; only the inks change.

| File | Use |
|---|---|
| `one-connect-mark.svg` | Mark on light grounds. Aqua hub, sun and coral agents, ink struts and rings. 32px or larger. |
| `one-connect-mark-on-dark.svg` | Same mark for night grounds: paper struts and rings. |
| `one-connect-mark-mono.svg` | Single-ink outline, inherits `currentColor`. Menu bar, favicon fallback, print. |
| `one-connect-app-icon.svg` | macOS app icon, 1024: ink squircle, mark at 70%. Export to `.icns` via `packages/desktop/src-tauri/icons`. |
| `one-connect-app-icon-aqua.svg` | Alternative icon: aqua squircle with ink hub. Louder; the "dopamine" option. |
| `one-connect-wordmark.svg` | Horizontal lockup. The text layer expects Bricolage Grotesque 700; outline it before shipping. |
| `one-connect-favicon.svg` | 32px favicon with simplified strokes. Replace the inline data-URI icon in `packages/web/index.html`. |

Rules: never recolour the mark in CSS (it is an `<img>`); never place it inline with text at 16px; clear space equals the
hub radius on every side; the hub is always aqua and the agents are always sun then coral, top to bottom.

Known tension: the hub-and-two-nodes silhouette resembles the generic "share" glyph. The colour triad and the heavy ink
rings are what distinguish it; if that is not enough, the next cut adds a third agent (grape) behind the hub.
