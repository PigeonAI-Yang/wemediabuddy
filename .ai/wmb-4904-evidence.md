# WMB-4904 evidence — Today cross-day fact consistency

Date: 2026-08-06

## Reproduction

Current workspace had no current-day plan or sources, while the latest historical plan contained 4 opportunities and the fermenting rail contained 5 items. The UI previously rendered an action sentence claiming the 4 opportunities were produced from ingested materials, while the source drawer said today had no ingested materials.

## Repair

- `src/renderer/today-view.tsx`: separates `todayPlan`/`todayItems` from `latestPlan`/`displayItems`; Today stats count only current-day plan and sources; historical plan remains visible only under an explicit `最近方案 · <date>` label; recent source fallback gets an explicit date notice.
- `src/renderer/today-run-view.ts`: adds `hasRecentPlan`; historical-plan idle state says `今日方案尚未生成`; stats are explicitly `今日新资料` and `今日内容机会`; internal error codes are mapped to user-facing fallback copy.
- `src/renderer/today-view-parts.tsx`: source drawer labels current vs recent source dates truthfully; retired competing `formatTodayActionLine` removed.
- `src/renderer/styles-workflow-today.css`: compact recent-source context style.
- `tests/today-run-view.test.mjs`: historical-plan boundary and internal-code redaction fixtures.

## Verification

- `npm run typecheck` → pass.
- `node --test --test-concurrency=1 tests/today-run-view.test.mjs` → 13 passed, 0 failed.
- `node scripts/smoke-renderer.mjs` → `[wmb-smoke] ok http://127.0.0.1:27391/`.
- Cold-started Electron with acceptance CDP and read the real Today DOM.
- Initial live state showed: `今日方案尚未生成`, `今日新资料 0`, `今日内容机会 0`, `最近方案 · 2026-08-05`, `仍在发酵 · 5`, `今日资料 · 0`.
- Current partial state live assertion showed no `已根据入库资料整理出`, no `WMB_`/`COMMAND_DISPATCH`/`requestId`/`revision`, current-day counts remained 0, fermenting remained 5, and there was no horizontal overflow.
- Screenshot: `J:/Users/yangda01/Temp/omp-sshots-154c6740acc1c665.webp`.

## Remaining risk

The real task is partial because the backend recorded `WMB_WRITE_REQUIRES_COMMAND_DISPATCH`. WMB-4904 prevents that internal code from leaking and keeps the Today facts consistent; it does not repair the separate backend write-routing failure.

## Pi operator Skill impact

No change — renderer fact projection, labels, and user-facing error copy only.
