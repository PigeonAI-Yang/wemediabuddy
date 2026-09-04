# WMB-5340 evidence

Date: 2026-08-23

## Delivered

- Today first screen is now one `TodayOverview` card with four database-backed metrics: today's intelligence, content opportunities, active projects, and publications in the last seven local business dates.
- Each metric carries an explicit zero/unknown state, previous-window change text, and a seven-point micro-trend without invented data.
- The existing actions remain: `重新侦察`, `查看资料`, `去创作`; `去创作` is the only primary action.
- `TodayDailyCycle` moved to Settings → 每日自动化. `TodayYesterdayIteration` moved to Results → 复盘.
- Today no longer renders either migrated component or a placeholder. Existing lower-page work content, `TodayRunView`, sidebar, Pi dock, permissions, publishing boundaries, storage schema, and brand tokens are unchanged.
- Added the read-only `getTodayOverview` IPC/preload contract and renderer route intents for filtered drill-downs.

## Focused contract proof

`node --test tests/wmb-5340-today-overview.test.mjs`

Result: **8 passed / 0 failed**. Covers metric SQL semantics, zero/unknown/divide-by-zero/insufficient-trend handling, three actions, approved drill-down targets, and new ownership of the two migrated components.

`npm run typecheck`

Result: **passed / 0 TypeScript errors**.

## Real Electron proof

Isolated package output:

`WMB_OUT_DIR=J:/wmb-out-5340 npm run package`

Result: **passed**, including production Vite bundles, Forge packaging, packaged skill mirror check, and packaged media-runtime gate.

Packaged executable scenario:

`WMB_E2E_APP_PATH=J:/wmb-out-5340/WeMediaBuddy-win32-x64 node tests/e2e/runner.mjs --file tests/e2e/.runtime/wmb-5340-compact.mjs --scenario wmb-5340-compact`

Result: **1/1 passed** at the product-supported minimum window size `1100×720`; Today, Settings → 每日自动化, and Results → 复盘 rendered without document-level horizontal overflow or page errors. Artifact: `tests/e2e/.artifacts/wmb-5340-compact-On72QM`.

Common desktop scenario at `1600×960`: **1/1 passed**. Artifact: `tests/e2e/.artifacts/wmb-5340-visual-DawExO`; screenshots include Today, Settings automation, and Results review.

## Viewport contract correction

A diagnostic emulation at `910×480` exposed the pre-existing product invariant `BrowserWindow.minWidth=1100`, `minHeight=720` (`src/main/app-window.ts`) and `body min-width:1100px` (`styles-foundation.css`). Changing those global shell contracts would violate this task's explicit boundary not to redesign the sidebar, Pi dock, or global foundation. The design document now distinguishes the `910×480` Today **content-area density envelope** from the packaged application's supported minimum window, which is verified at `1100×720`.
