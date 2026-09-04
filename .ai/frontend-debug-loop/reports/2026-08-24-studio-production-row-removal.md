# Studio production-row removal — 2026-08-24

Category: layout / unauthorized chrome removal

## Symptom (user screenshot ground truth, 2026-08-24)
- View: 创作 → 正文 (Studio editor, project 6ce12d8a-d12d-449d-baca-fcdc55b0f3c8 “杨立昆真正质疑的，不是聊天机器人会不会说话”)
- Viewport: supplied screenshot shows full-width row directly under project header, containing `工作面 | 已批准 · 生产推进中 | 开始生产` (status text “已批准 · 生产推进中” + primary button “开始生产”).
- Expected prior structure (before unauthorized row): existing formatting toolbar (`StudioFormatBar` with 粗体/斜体/插入图片/清除格式 etc.) follows project header directly, no intermediate banner.
- Owner explicitly requires removal, not redesign, no relocation, no replacement copy/badge/button/card/banner/tooltip/abstraction.

## DOM / CSS selectors (pre-fix, confirmed via source + installed surface)
- `src/renderer/studio-view.tsx`:
  - Constants: `planningStatus = selected?.planningStatus`, `isDraft/isRejected/isReadyForReview/isApproved`, `versionCount`
  - Handler: `handleAdvance` (checks `planningStatus !== 'approved'`, builds `requestId: studio:advance:${selected.id}`, calls `window.wmb.advancePlanItem` via `plan_item.advance`, `setMessage('正在开始生产…')`, `await reload()`)
  - JSX: `<section className="studio-planning-banner" data-planning-status={planningStatus}>` containing 5 status spans (`draft / rejected / ready_for_review / approved 已批准 · 生产推进中 / none`), `studio-planning-version` v0 span, `button.studio-advance-button[data-testid="studio-advance"]` with “开始生产”, and `span.studio-active-tasks`
- `src/renderer/styles-studio.css` (WMB-5353 block):
  - `.studio-planning-banner` (flex, min-height 36px, border-bottom, `data-planning-status="approved"` / `"ready_for_review"` variants)
  - `.studio-planning-status` + `[data-status="draft|ready_for_review|approved|rejected"]`
  - `.studio-planning-version` (+ `[data-testid="studio-v0"]`)
  - `.studio-advance-button`
  - `.studio-active-tasks`
- No other file owns this row; `ProposalsView` and `TodayView` advance paths (`proposals-view.tsx: advance`, `proposal-ledger.ts: advancePlanItem`, IPC `plan-item:advance`, `advanceApprovedPlanItem` in `daily-content-article.ts`) are shared and must be preserved. LSP refs confirm handler/props are Studio-local.

## Existing behavior to preserve
- Design tokens, editor toolbar (`StudioFormatBar`), tabs (`StudioOutline` 工作面切换), draft content, Pi dock, `StudioIllustrationPanel`, `StudioHistoryModal`, `StudioAnnotationOverlay`, etc. untouched.
- Backend `advanceApprovedPlanItem` + `plan_item.advance` orchestration (Today/Proposals) untouched; only Studio-specific wiring removed.
- No new row/badge/button/card/banner/tooltip/copy/abstraction.

## Expected fix (bounded UI wave)
1. Remove entire `studio-planning-banner` container, status text and Start Production button from Studio — no empty replacement strip, toolbar occupies reclaimed vertical space.
2. Remove unused local `handleAdvance` state/props/imports and dead CSS selectors created solely for that row; preserve shared advance callbacks.
3. Smallest focused renderer/contract check: `npx tsc --noEmit` (covers Studio compilation/structure).
4. `npm run build` once → install `WeMediaBuddy Setup.exe` → launch installed (packaged-identical) app with CDP, navigate to 6ce12d8a..., verify same viewport: no row/text/button, toolbar/body still visible, no console runtime error. Save one after screenshot under `.ai/frontend-debug-loop/reports` and update loop report/state. Close verification browser/CDP, leave installed app running.

## Changes
- `src/renderer/studio-view.tsx`:
  - Deleted `planningStatus` / `isDraft` / `isRejected` / `isReadyForReview` / `isApproved` derived consts (kept `versionCount` and `anyDirty`).
  - Deleted `handleAdvance` (797-823) — Studio-local `plan_item.advance` caller.
  - Deleted `<section className="studio-planning-banner">…</section>` (930-945) — entire row.
- `src/renderer/styles-studio.css`:
  - Deleted 13 lines: `/* WMB-5353 策划状态横幅 */` + `.studio-planning-banner` (2), `.studio-planning-status` (4 variants), `.studio-planning-version` (2), `.studio-advance-button`, `.studio-active-tasks` (12-13 inc. comment). Kept `.studio-v0-empty` and layout constraints (`.studio-editor-view/grid/document/canvas`).

## Focused check
- `npx tsc --noEmit` in `J:/PigeonYang/WeMediaBuddy` — **pass, no output** (15.9s). Covers Studio compilation/structure; no full suite per contract.

## Package / Install
- `npm run build` — **pass**, 682.42s, artifacts at `J:/wmb-out/make` (exit 0). `J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar` 5.6M `fd7e4b1b7f8138050b11fafcccc699f74ebe5ab83d59cbce86899fba20a4601c`.
- Installer: `J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe` 747M `312576A861789EB1AB5268E057D19AE438B60A11`, installed to `C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar` hash **matches** fd7e… (verified via sha256sum), Squirrel Update.exe pid 917424 → installed exe 2.1M, exit 0. Existing app stopped only for reinstall.

## Verification (isolated packaged app, byte-identical to installed)
- Harness: `tests/e2e/harness.mjs` `launchApp({appPath: "J:/wmb-out/WeMediaBuddy-win32-x64"})` with isolated `userDataDir`/`dataRoot` copying real `J:/PigeonYang/WeMediaBuddyData/wmb.db` (project 6ce12d8a, plan_item 8342f64f `approved`, 1 version). `WMB_ACCEPTANCE_USER_DATA` isolated, `workspaceId` random, registry + onboarding + pi placeholder seeded, `app_meta.workspace_id` fixed to isolated id.
- Flow: `waitForAppReady` → `navigateTo(studio)` → `localStorage.setItem(wmb.workspace.${workspaceId}.studioSelectedId, 6ce12d8a...)` → `page.reload()` → `waitForAppReady` → `navigateTo(studio)` → `waitForSelector(.studio-document)` → DOM evaluate.
- DOM assertions (all **PASS**):
  - `startProductionAbsent` = `!hasStartProduction && !hasAdvanceButton` → true (no “开始生产”, no `[data-testid="studio-advance"]`)
  - `approvedStatusAbsent` = `!hasApprovedStatus && !hasBanner` → true (no “已批准 · 生产推进中”, no `.studio-planning-banner`)
  - `emptyStripAbsent` = `!hasBanner` → true (no empty replacement strip, banner rect null)
  - `toolbarVisible` = `formatBarVisible || anyToolbarButton` → true (`.studio-formatbar` height 87, top 128.5, buttons 粗体/斜体/插入图片 present)
  - `bodyVisible` = `.studio-canvas/.studio-paper` height >0 → true
  - `consoleErrors` = `pageerrors + errors` → **0** (evidence.console/errors/pageerrors all [])
  - Evidence: `toolbarRect {height:87, top:128.5}` vs previously banner 36px + toolbar, now toolbar directly under header (reclaimed space).
- Screenshot: `J:/PigeonYang/WeMediaBuddy/.ai/frontend-debug-loop/reports/2026-08-24-studio-production-row-removal.png` (91,155 bytes, 1280x800 viewport, fullPage false). Also `verify-result.json` beside it.
- Process: isolated verification app closed via `harness.closeApp` (exited, browser/CDP session closed). Installed-equivalent app left running via `hub` `wemediabuddy-pkg` (pid 918996, `J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`, 4 process tree, `tasklist` confirmed `WeMediaBuddy.exe 918996 194,600K` etc., `ps aux` shows `915616/917684/918996/927576` with real userData). Installed Squirrel stub at `C:/Users/yangda01/AppData/Local/WeMediaBuddy/WeMediaBuddy.exe` shares hash; `Update.exe --processStart` exits after spawning, so `wemediabuddy-pkg` is the correct running proof (byte-identical to installed). No linter/formatter/full suite run per contract.

## After — verification 2026-08-24 20:14 (Studio production-row removal)
- Packaged (installed-identical) Electron `J:/wmb-out/WeMediaBuddy-win32-x64` with real project 6ce12d8a: **no banner, no “开始生产”, no “已批准 · 生产推进中”, no empty strip**; toolbar 87px at top 128.5 directly under `StudioEditorTop`; body canvas/paper visible; consoleErrors 0; screenshot 91K.
- `npx tsc --noEmit` pass; `npm run build` + install + verification one wave; `Today/Proposals` advance handlers intact (not touched); design tokens/editor toolbar/tabs/draft/Pi dock preserved; no new UI.

## Remaining
- Verify installed Squirrel stub `C:/Users/yangda01/AppData/Local/WeMediaBuddy/WeMediaBuddy.exe` stays running after `Update.exe` spawn (currently `wemediabuddy-pkg` proves corrected binary is running; Squirrel stub exits by design, so pkg is the running proof).
