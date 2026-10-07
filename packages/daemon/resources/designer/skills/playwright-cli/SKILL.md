---
name: playwright-cli
description: Verify local mock or application flows using Microsoft's installed Playwright CLI and save visual evidence.
---

Use the installed official `playwright-cli`; inspect its `--help` to confirm the pinned version's commands. Do not auto-install packages or browsers. Open only the approved project preview URL in a dedicated session. Capture a fresh snapshot before choosing element references, perform the intended flow, and record screenshots, console errors and the result. Test desktop and phone widths, keyboard focus, long content and reduced motion. Keep traces and screenshots in durable project evidence, with a link in the handoff. Credentials and unrelated browser sessions are outside scope.

CLI availability and recorded checks are separate: if it is missing, report that verification is pending. Use the in-app terminal to install it only after the human approves the exact install command. Never publish screenshots or invoke outbound messages from this skill.

Source: https://github.com/microsoft/playwright-cli (Apache-2.0). This is a One Connect integration guide, not a bundled vendor executable.
