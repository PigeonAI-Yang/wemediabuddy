# WMB-5300 — Studio investigation activity indicator truthfulness

## Problem

The Studio sidebar investigation dot used a coarse ready/not-ready signal. It could imply live investigation when no reporter job was running and exposed no equivalent non-color status.

## Decision

- Added `studioInvestigationIndicator(model)` as the single renderer projection from the authoritative `StudioInvestigationModel`.
- Green (`active`) only when `model.status === 'researching'` and `model.reporter.status === 'running'`.
- Red (`error`) for `outline_rejected`, project `failed`, or reporter `failed`.
- Gray (`idle`) for missing data and every other state, including queued, waiting-resource, needs-user, completed, abandoned, and approval states.
- The investigation tab exposes the same semantic label through `title` and `aria-label`; color is supplemental.
- Initial state hydrates from the selected project's investigation read model. Panel reads, mutations, periodic reconciliation, and data-change refreshes all publish the updated projection.

## Verification

- `npm run typecheck` — PASS.
- `node --test tests/studio-investigation-indicator.test.mjs` — 3/3 PASS; focused green/gray/red contract.
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 PASS.
- Real Electron, production workspace, 1365×768 CSS viewport:
  - Failed investigation project: `data-state="error"`, label `调查，记者调查报错`, visible 7×7 dot, computed red `rgb(229, 99, 111)`; opening the tab rendered the real failed investigation archive.
  - Project without an active investigation: `data-state="idle"`, label `调查，当前无记者调查`, visible 7×7 dot, computed gray `rgb(118, 118, 118)`.
  - Studio page horizontal overflow: `0`.

No IPC, database schema, permission, Capability, dependency, or foundation-token changes.
