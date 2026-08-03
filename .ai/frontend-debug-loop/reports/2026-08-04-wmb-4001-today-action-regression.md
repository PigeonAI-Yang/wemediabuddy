purpose: Today is the information-first creation surface; this loop restores one creation action per carry-over item after the X MCP package rebuild exposed legacy management controls.
fails-when: The same packaged UK workspace still shows Continue, Observe or Dismiss, or a carry-over row lacks its creation action.

Loop: WMB-4001 Today action regression
Symptom: Rebuilding for X MCP work brought back Continue and Observe controls on Today.
Observation packet: Current packaged app at CDP 9371 showed two `.fermenting-row` elements, six management buttons and zero `[aria-label="开始创作"]`; receipt `.ai/wmb-4001-today-before.json`.
Hypotheses: Packaging consumed the whole dirty renderer tree and therefore exposed the legacy `FermentingRail` action set. Confirmed by exact live DOM labels and source trace; X MCP has no Today dependency.
Bug type: render-guard / wrong action presentation.
Chain traced: packaged renderer -> `TodayView` -> `FermentingRail` -> `.fermenting-actions`.
Breakpoint: `src/renderer/today-view-panels.tsx` rendered three management actions on every carry-over row.
Root cause: The Today component still owned background carry-over management actions; the X rebuild merely made that existing code visible again.
Files read: `src/renderer/today-view.tsx`, `src/renderer/today-view-panels.tsx`, `src/renderer/today-view-parts.tsx`, current package DOM and commit history.
Files changed: `src/renderer/today-view.tsx`, `src/renderer/today-view-panels.tsx`, `tests/today-creation-actions.test.mjs`.
Before/after gate: Before 2 rows / 6 management labels / 0 creation actions. After 2 rows / 0 management labels / 2 creation actions in the same packaged workspace; screenshot `.ai/wmb-4001-today-after.png`.
Owner check: The Today hierarchy and real data remain unchanged; only first-screen management actions were removed. Empty/loading/error states were not changed.
Result: Restored creation-first behavior and restarted the package.
State update: complete.
Clean completion: yes
Blocked reason: none for this UI loop; WMB-4001 X platform acceptance remains active separately.
