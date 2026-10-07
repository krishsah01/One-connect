# Designer

Open Designer to edit a project's visual direction, role-based colors, typography, spacing, radius, motion and component rules. The interactive token mock responds to changes, tab navigation and review controls. It is sample content, not a generated application or verified review result.

Save design contract validates text contrast and records a human-authored version with a SHA-256 identity. Export DESIGN.md and tokens.css. New assignments freeze that identity; existing assignments retain their earlier contract. Active UI/code runs prevent replacing the design contract. Assignments load the exact contract using `get_design_system`. Token compliance and complete browser accessibility still need implementation/review checks; contrast validation alone cannot prove them.

Create a design task makes a tracker issue and draft assignment with a reviewable scope. The human dispatches from Work Board. Generated mock artifact editing/export beyond the current token mock remains in progress.

## Default skills

The library includes Taste Skill, Vercel Web Interface Guidelines, licensed Linear/Notion DESIGN.md reference analyses, an original design-contract skill, accessible product UI, responsive mocks, and a scoped Playwright CLI guide. Design-labelled tasks receive the default library; custom agents can select individual skills. Only names and descriptions enter the assignment prompt. `get_design_skill` loads verified, pinned files and paged references as needed.

Selected text resources were reused from the user-approved [Open Design](https://github.com/nexu-io/open-design) revision `53231d40b778d88eba23f35547bf99485d3ae9fc`. Its Apache-2.0 license is retained, along with upstream MIT licenses for Taste Skill and Vercel guidelines. VoltAgent reference analyses retain their MIT notice. File hashes and sources live in the designer manifest; CI verifies them and includes notices in THIRD_PARTY_NOTICES.md. No hosted Open Design service, vendor media API, binary, telemetry or third-party installation is enabled.

Taste Skill's imported scope targets landing pages and redesigns. Product dashboards follow the project contract and Vercel guidelines. Brand analyses inform an original system; they do not grant rights to vendor logos. The Playwright entry is a guide for the official installed CLI, not a bundled executable. A tool being available never proves a browser check passed.

`packages/daemon/test/designer.test.ts` verifies contract validation, human attribution, immutable assignment revisions, restart persistence and pinned skill integrity. Native verification additionally checks save state, visual contrast and interactive controls.
