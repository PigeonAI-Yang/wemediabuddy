# WMB-5273 — Agent detail avatar and live-run correction

Date: 2026-08-15

## Delivered

- `src/renderer/agents-detail-modal.tsx` and `agents-roster-view.tsx`: detail consumes the same authoritative roster row as the role card. A running/blocked legacy Pi task without `projection.byRole.active` now renders its real task identity, phase, progress, events, and dock transcript, with event-driven refresh plus 5s reconciliation.
- Removed the eyebrow and explicit avatar-setting button. The large current avatar is the only setting entry and remains keyboard accessible.
- `src/renderer/agent-avatar-crop.tsx`: the picker preloads the saved avatar through `wmb-asset://`; `crossOrigin = anonymous` keeps the canvas readable/exportable under the registered CORS-enabled asset protocol. Replacement save returns to the same detail immediately.
- `src/renderer/styles-agents.css`: 88px avatar control with foundation tokens and existing modal hierarchy.
- `tests/e2e/agents.test.mjs`: added `AG-008-agents-legacy-task-avatar`, including live SQLite task update, current-avatar pixel readback, replacement, persistence, focus return, and page health.

## Verification

- `npm run typecheck`: PASS.
- `node --test tests/design-tokens-drift.test.mjs`: 3/3 PASS.
- Real Electron `WMB-5251-agents-detail-modal`: 1/1 PASS.
- Real Electron `AG-008-agents-legacy-task-avatar`: 1/1 PASS (22.3s), covering card/detail status agreement, real 25%→50% update, task events and transcript, no whole-modal empty state, existing-avatar preload, replacement save, immediate detail/card refresh, focus return, and page errors 0.

## Boundaries

No Agent execution protocol, database schema, Capability, permission, dependency, or foundation brand-token changes.
