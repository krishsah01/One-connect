---
name: product-ui-patterns
description: "Use when designing dashboards, tables, forms, settings, detail pages or other product screens, including their empty, loading, error, partial and success states."
---

Start from the user's task, not the layout. For each screen write one sentence: who is here, what they need to decide or do, and what done looks like. Put that primary action where the eye lands first and demote everything else.

Screen recipes (adapt them to the project contract):

- Overview or dashboard: a short status line that answers "is anything wrong?", then three to six key figures with labels and units, then the list of things that need attention. No decorative charts. Every chart has a title, axis labels and a text equivalent.
- List or table: search and filters above, sortable columns with clear headers, right-aligned numbers, row actions at the end of the row, bulk actions only once rows are selected. On phones, stack rows as cards of label and value pairs.
- Detail: title and status first, the primary action beside the title, sections in reading order, history and activity last.
- Form: one column, labels above fields, required or optional marked once, inline validation after blur or submit, and on submit an error summary at the top that links to each field. Only disable submit when you also explain why.
- Settings: grouped by consequence. Destructive settings come last and are confirmed with the object's name.

Design every state with real copy:

- Empty: what will appear here, why it is empty now, and the first action.
- Loading: skeletons that match the final layout; announce completion politely; never a bare spinner for more than a few seconds.
- Error: what failed, whether the user's input was kept, and how to retry. Never only a toast.
- Partial: show what loaded and mark what did not.
- Success: confirm what changed and what happens next.
- Permission and offline, when the brief asks: who can grant access, or what still works.

Interactions: every control has a visible label or an accessible name. Prefer undo over confirmation for reversible actions. Long operations show progress and can be left. Give reviewers a visible, keyboard-operable way to switch between states in a mock.

Use fixture data that looks like the product's real data, including edge cases: very long names, zero values, one item and many items. Never use real customer data or secrets.
