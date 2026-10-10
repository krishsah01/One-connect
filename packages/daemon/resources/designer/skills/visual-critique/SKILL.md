---
name: visual-critique
description: "Use when independently reviewing one exact design mock revision against its frozen contract and the review checklist."
---

Review the revision named in your assignment and nothing else. You are independent: you did not author it, and you do not edit it.

1. Read the file list, findings and handoff with `get_design_mock`, then the relevant files in bounded pages. Read the frozen contract with `get_design_system`.
2. Assess each checklist item and record what you actually based it on:
   - responsive: layouts at 390, 820 and 1280 px wide. From source you can check breakpoints and overflow risks (static). Only a browser check you ran proves rendering.
   - keyboard: focus order, visible focus, Escape and arrow handling, focus return. Static inspection finds missing handlers; it does not prove behavior.
   - contrast: compare the token pairs in use with the contract's measured table. Literal colors are findings.
   - states: every data view has empty, loading, error and success states with real copy and a way to see each one.
   - tokens: colors, type, spacing, radius and motion come from `var(--design-*)`.
3. Prefer specific, located findings ("index.html: the Delete button has no confirmation") over general taste. Rank them by user impact.
4. Submit with `submit_design_review`. Approve only if every item passes on the basis you can honestly claim; otherwise request changes and say exactly what to fix. Your review is advisory; a human makes the final approval.
