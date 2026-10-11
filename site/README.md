# one-connect site

Static landing page built on the design system: React 18 and Framer Motion 11 load as pinned UMD scripts from the CDN,
`app.js` renders the page with no build step, and `tokens.css` is a copy of `packages/web/src/tokens.css`
(regenerate with `node scripts/design-tokens.mjs` and copy). Serve the folder from any static host, or run

```bash
python3 -m http.server 8787 -d site
```

What moves, and why: the hero plays a scripted event log with one approval you can answer; the how-it-works path draws
itself on scroll; the four guard tiles loop a small, slow illustration of the failure they prevent; the Feel section is
the house toggle in its three presets. Everything respects `prefers-reduced-motion`, nothing animates on load, and the page
is complete at rest.

Published copy for sharing: https://claude.ai/artifact/9JsvNL7uoKKf2ssYqxwmAw (rebuild with the script in the session
notes: inline CSS, data-URI assets, same CDN scripts). For Figma, open the page and use html.to.design.
