# WMB-5268 evidence

Date: 2026-08-15

## Change

- `src/renderer/styles-studio.css`
  - `.studio-outline` and `.studio-outline-section--outline` now consume `var(--panel-bg)`.
  - The creation outline area no longer keeps an isolated `var(--app-bg)` strip above the platform-content section.
  - No foundation token, DOM, interaction, IPC, schema, permission, capability, or dependency change.
- `tests/e2e/studio.test.mjs`
  - ST-001 now asserts the article-outline and platform-content sections resolve to the same background color and captures the real Electron frame.

## Verification

- `npm run e2e -- --file tests/e2e/studio.test.mjs --scenario ST-001-studio-project-normal`: PASS 1/1.
- Real Electron evidence: `tests/e2e/.artifacts/ST-001-studio-project-normal-9x7zkU/studio-outline-unified-background-screenshot.png`.
- `node --test tests/design-tokens-drift.test.mjs`: PASS 3/3.
