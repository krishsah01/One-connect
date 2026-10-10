# Local engine acceptance, October 8, 2026

This records disposable local integration checks separately from the bundled preview and live provider/product acceptance. It does not enable a tracker, tunnel, notification endpoint, paid mode or production environment.

## Verified

- Installed Graphify: the real integration graph build, query for `mul()` and source explanation passed. This uses local AST extraction with no LLM, embedding download or API key. `integration-local-engines-results.json` contains the nine passing context tests alongside the initial failures below.
- Real local Docker/Postgres (`postgres:16-alpine` was already present): a generated database reached healthcheck readiness, stored a row, stopped and restarted with its named volume intact, and returned the stored row. Its disposable Compose project and volume were removed. No image was pulled. The successful rerun is in `integration-local-engines-recheck-results.json`.
- WebKit: the compiled local host passed interaction, parent/IPC isolation, fresh-realm WebRTC denial and resource/navigation/network refusal. See `integration-webkit-results.json`.
- Chromium: the installed headless browser passed interaction, parent/IPC isolation, denied resource/navigation attempts and allowed local-page navigation. See `integration-chromium-results.json`. This verifies the document boundary; generic browser execution remains disabled because this does not prove engine-level WebRTC denial.

## Defects exposed and corrected

The first Postgres start failed because the temporary action snapshot was removed while Compose still used its secret file as a bind mount. Sealed secrets/configs now live in private project app data, retain the exact approved bytes across command completion/restart, and are distinct from temporary build/env/approval snapshots. Old retained secret values remain redacted on restart. Retained mount copies are kept with project data: automatic age-based deletion would break stopped or externally restarted containers. No active user database was modified for this fix.

The optional Docker test now uses the actual fresh-confirmation flow for a destructive `down` action. Explicitly enabling the smoke test with a missing image fails with an actionable prerequisite instead of returning a false pass.

Chromium's previous test assumed every iframe was visible in the page's own renderer session. Current Chromium isolates opaque frames in separate processes. The test now attaches their own sessions without disabling process isolation. The trusted fixture host supplies an inline favicon and starts from `about:blank`; all hostile document requests still must be refused.

## Limits

These are engine/fixture checks, not live provider generation, a full agent-led development cycle, a real paired phone, deployment or production acceptance. The currently open Mac preview predates the retained-mount fix. Its Designer draft was preserved; the app was not quit or restarted. A separate `dist/macos/One Connect-next.app` now contains the fix and reviewed native onboarding. The integrated suite passed 641 tests with no skips/failures, including all four real local engine checks; native Rust passed 22 tests. See `rebundle-next-build.json`.
