# Mac application refinement

Keep the existing event-sourced TypeScript daemon and React UI. Add a Tauri 2 shell with a Rust PTY manager. The app loads only bundled UI assets; native commands proxy authenticated requests to its loopback daemon. Native commands are unavailable to external pages. The daemon starts with the app, survives closing its window, and stops on Quit (detached agent runners remain restart-safe).

1. Add a GitHub/Linear import preview with search, selected imports, provenance and duplicate detection. Connections stay disabled by default. The demo and automated tests use offline fixtures. Imported issues are local work items with a source link; importing never posts back to either service.
2. Add a native app, in-app project terminal, vendor-login terminals, and project-container status/logs. Docker start/stop/restart require a recorded, single-use approval for the exact container action. Container operations never pull images or start unrelated projects.
3. Package the existing daemon with Node and a reproducible resource preparation script. Verify the Rust crate, web UI, daemon and offline import paths. Exercise the app on macOS.
4. Retain structured agent output and chat/approval controls. Do not claim token streaming for adapters that only expose complete messages. Codex app-server integration remains a separate adapter milestone; relay-only vendors still require their vendor surface.

A Rust core reduces packaging and process-management friction. Agent response time remains dominated by vendor inference and tool execution; measure memory and latency before claiming improvements. Windows shares the PTY and UI design but needs its own build and system integration validation.
