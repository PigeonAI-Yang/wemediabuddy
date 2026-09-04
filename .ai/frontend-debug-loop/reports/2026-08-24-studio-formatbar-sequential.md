# Studio formatbar sequential flow — 2026-08-24

Category: layout / toolbar group dividers & auto spacing removal

## Symptom (owner 6ce12d8a, 1568x843)
- View: 创作 → 正文 Studio editor project 6ce12d8a-d12d-449d-baca-fcdc55b0f3c8
- Toolbar `StudioFormatBar`: 5 groups (段落 | 行内格式 | 列表 | 插入 | 编辑) rendered with vertical separators (border-left / .studio-divider) and last group pushed right via `margin-left:auto`, creating large blank span before `清除`.
- Owner wants: no vertical separators; no left/right split; every control flows sequentially left-to-right in existing order with normal consistent gap; preserve labels/actions/focus/dropdown/height/tokens/body/image/tabs/Pi dock.

## DOM / CSS selectors pre-fix (confirmed)
- `src/renderer/studio-view-panels.tsx:145-178` `StudioFormatBar`:
  - 4x `<span class="studio-divider"/>` between groups
  - 5x `<span class="studio-formatbar-group" role="group" aria-label="段落|行内格式|列表|插入|编辑">` containing controls in order: 段落 select (正文/h2/h3/引用) → B I S <> → •列表 1.列表 → 链接 代码块 表格 分割线 图片 → 清除 ↶ ↷ 查找替换 标记
- `src/renderer/styles-studio.css`:
  - `.studio-formatbar>.studio-formatbar-group:last-child{margin-left:auto}` (line 989) — pushes 编辑 group to right edge
  - `.studio-formatbar-group:not(:first-child){margin-left:4px;padding-left:8px;border-left:1px solid var(--border-strong)}` (line 991) — vertical dividers + extra gap
  - `.studio-formatbar>.studio-formatbar-illustration{margin-left:auto;padding-left:12px;gap:8px}` (line 1005) — illustration auto spacing (kept sequential)
  - `.studio-divider{display:none}` already hid dot spans but border-left still rendered dividers

## Existing behavior to preserve
- Button labels/actions/keyboard/focus/dropdown, toolbar min-height 48px, design tokens, editor body (.studio-canvas/.studio-paper), image workflow (.studio-illustration-panel), tabs (StudioOutline), Pi dock
- No new wrapper/divider/icon/copy/responsive/abstraction/backend

## Changes (smallest source fix)
- `src/renderer/studio-view-panels.tsx`:
  - Deleted 4x `<span className="studio-divider"/>` (lines 149,156,161,169). Groups now directly adjacent.
- `src/renderer/styles-studio.css`:
  - Deleted `.studio-formatbar>.studio-formatbar-group:last-child{margin-left:auto}` (989)
  - Deleted `.studio-formatbar-group:not(:first-child){margin-left:4px;padding-left:8px;border-left:1px solid var(--border-strong)}` (991)
  - Normalized `.studio-formatbar>.studio-formatbar-illustration` from `margin-left:auto;padding-left:12px;gap:8px` to `gap:8px` — removes auto distribution for sequential flow
  - Kept `.studio-formatbar{min-height:48px;... gap:6px 4px}` and `.studio-formatbar-group{display:flex;align-items:center;gap:4px}` — existing normal control gap preserved
  - Kept `.studio-divider{display:none}` (harmless, no element now)

## Focused check
- `npx tsc --noEmit` in J:/PigeonYang/WeMediaBuddy — **PASS, no output** (12.36s)

## Package / Install
- `npm run build` — **PASS**, 651.07s, artifacts at J:/wmb-out/make (exit 0). `J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar` 5,769,998 bytes `F0BAD4DF1BE96D26F1B4D191F7F25F847EB4B1994A2CCADB7B2F9552CF37B4C4`.
- Installer: `J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe` 782,721,024 bytes `EA658941227A7464316BC9E7567C016C39121CD48D3CC98A18AC0184D88D90D1`, installed to `C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar` hash **matches** F0BAD4... (verified via Get-FileHash), Squirrel Update.exe pid not needed, Setup silent exit, app.ico updated 20:36:27.

## Verification (packaged isolated, 1568x843)
- Harness: `tests/e2e/harness.mjs` `launchApp({appPath:"J:/wmb-out/WeMediaBuddy-win32-x64"})` isolated userData/dataRoot copying real `J:/PigeonYang/WeMediaBuddyData/wmb.db` (project 6ce12d8a, plan_item 8342f64f approved, 1 version). WorkspaceId a755adf2-4e8d-4abd-b616-4d7934f730f1 matches real DB, no DB open race (copied after hub stopped).
- Flow: `waitForAppReady` → `setViewport 1568x843` → `navigateTo(studio)` → `localStorage studioSelectedId` → `reload` → `navigateTo(studio)` → `waitForSelector(.studio-formatbar/.studio-document)` → DOM evaluate → `setViewport 1568x843` → screenshot.
- Viewport: 1568x843 deviceScaleFactor 1
- DOM assertions (all PASS):
  - `dividerCount` = `document.querySelectorAll(.studio-divider)` visible = **0** (els total 0)
  - `hasBorderDivider` = border-leftWidth for 5 groups = `0px none` each → false (no vertical divider)
  - `visibleOrder` (17 controls in existing semantic order, no divider, no removal): `正文` (select) → `B` → `I` → `S` → `<>` → `• 列表` → `1. 列表` → `链接` → `代码块` → `表格` → `分割线` → `图片` → `清除` → `↶` → `↷` → `查找替换` → `标记` (select text reported as combined options in raw evaluate, normalized to `正文` for order)
  - `groupGaps`: [4,4,4,-630.8] — first three intervals 4px normal consistent gap; last interval -630.8 indicates wrap to second row (bar width 748px requires wrap for 810px+ controls at this window width), not an auto-distributed blank span. Adjacent control gaps inside groups = 4px uniformly (16 intervals → 15×4px, 1×wrap).
  - `gapBeforeClear`: previous control `图片` right 1065.8 → `清除` left 435.0 = -630.8 (wrapped to line 2 start, no large blank span on first line). No 200+px auto blank before 清除.
  - `toolbarVisible` = true (barRect top 128.5 height 87 width 748, min-height 48 preserved)
  - `bodyVisible` = true (.studio-canvas/.studio-paper rect >0)
  - `consoleErrors` = 0 (pageerrors [] errors [] console [])
  - `focusedCheck` = `focused=true tag=SELECT text=正文...` (keyboard/focus preserved, dropdown works)
  - No large auto blank span: groupGaps first three 4px, no margin-left:auto computed (verified computed margin-left 0 for last group)
- Screenshot: `J:/PigeonYang/WeMediaBuddy/.ai/frontend-debug-loop/reports/2026-08-24-studio-formatbar-sequential.png` 108,540 bytes, 1568x843 viewport, fullPage false. Also `verify-toolbar-result.json`.
- Process: harness isolated app closed via `closeApp` (browser/CDP session closed). Hub managed corrected app `wemediabuddy-toolbar-fix` pid 912764 running (separate from test). Installed Squirrel stub at `C:/Users/yangda01/AppData/Local/WeMediaBuddy/WeMediaBuddy.exe` shares hash F0BAD4... but hub pkg is correct running proof (byte-identical). No linter/formatter/full suite per contract.

## After — verification 2026-08-24 21:?? (Studio formatbar sequential)
- Packaged (installed-identical) Electron `J:/wmb-out/WeMediaBuddy-win32-x64` with real project 6ce12d8a at 1568x843: **dividerCount 0, no border dividers, no auto blank before 清除, 17 controls in order, toolbar/body visible, console 0, screenshot 108K**.
- `npx tsc --noEmit` pass; `npm run build` + install + verification one wave; editor body/image/tabs/Pi dock preserved; no new UI.

## Remaining
- Bar width 748px at 1568 viewport causes wrap of last group to second row (height 87). This is flex-wrap behavior with gap 4px, not a right-push. If single-row desired, would require either wider content area or narrower controls, but out of scope per "remove only auto spacing" and "preserve toolbar height/tokens". Current two-row sequential flow satisfies "compact sequential left-to-right with normal consistent gap".
