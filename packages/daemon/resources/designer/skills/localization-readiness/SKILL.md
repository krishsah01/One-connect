---
name: localization-readiness
description: "Use when content, labels or layouts must work across languages, scripts, regions and formats."
---

Design copy and layout so translation doesn’t break them.

- **Room to grow:** translated text is often 30–50% longer (and short labels can double). Prefer flow layouts with wrapping; avoid fixed widths on buttons, tabs and badges; don’t truncate essential labels.
- **No text in images.** Keep words in text layers so they can be translated and read by assistive technology.
- **Whole sentences:** don’t build sentences from fragments or rely on word order. Avoid idioms, puns and culture-specific references in interface copy.
- **Formats:** dates, numbers and currency follow the content guide’s formats and should be shown as examples of a locale, not hard-coded assumptions. Use unambiguous dates (“Oct 10, 2026”).
- **Names and addresses** vary: a single “Full name” field is more inclusive than first/last; don’t assume postal code formats.
- **Right-to-left:** layouts mirror; icons that imply direction (arrows, progress) flip; numbers and brand names don’t.
- **Plurals and gender:** write copy that works for one and many (“3 files”, not “3 file(s)”), and avoid gendered language for people.

Keep terminology consistent with the design’s content guide (`content.terms`), and update the guide with `set-content` when you introduce a new term.
