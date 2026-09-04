# Studio formatbar flatten — 2026-08-24

Category: layout / atomic flex group flatten (display:contents)

## Symptom (owner 6ce12d8a, 1568x941)
- View: 创作 → 正文 Studio editor project 6ce12d8a-d12d-449d-baca-fcdc55b0f3c8
- Before: `.studio-formatbar-group` wrappers were atomic flex items (display:flex flex:none). Last wrapper (`编辑`, 240px) wider than remaining row space (93px), so all five final controls (清除, ↶, ↷, 查找替换, 标记) wrapped together to row 2, leaving large unused blank at right of row 1.
- Owner expects: each control participates independently so row 1 fills before later controls wrap; no group-sized blank remainder; wrap between individual controls in exact order. Preserve exact order/labels/handlers/focus/keyboard/dropdown, normal 4px control gap, editor, illustration row, tabs, Pi dock. No shrinking, no horizontal scroll, no absolute positioning, no width magic.

## DOM / CSS selectors pre-fix (confirmed 1568x941)
- `src/renderer/studio-view-panels.tsx:145-173` StudioFormatBar: 5 groups (段落 | 行内格式 | 列表 | 插入 | 编辑) containing 17 controls in order: 正文 select → B I S <> → •列表 1.列表 → 链接 代码块 表格 分割线 图片 → 清除 ↶ ↷ 查找替换 标记. Dividers already removed (dividerCount 0).
- `src/renderer/styles-studio.css:989` `.studio-formatbar-group{display:flex;align-items:center;gap:4px;flex:none}` – atomic flex item (width 92,144.78,118.03,264,240). Parent `.studio-formatbar` is `display:flex flex-wrap:wrap gap:6px 4px` with `barRect width 748 inner 724`.

## Existing behavior to preserve
- Button labels/actions/keyboard/focus/dropdown, toolbar min-height 48px, design tokens, editor body (.studio-canvas/.studio-paper), illustration row (.studio-illustration-summary-bar 44px), tabs (StudioOutline), Pi dock. No new wrapper/divider/icon/copy.

## Changes (smallest flattening solution)
- `src/renderer/styles-studio.css:989`:
  - ` .studio-formatbar-group{display:flex;align-items:center;gap:4px;flex:none}` → `.studio-formatbar-group{display:contents}`
  - Mechanism: `display:contents` removes the group box; children (select + buttons) become direct flex participants of `.studio-formatbar`. DOM retained (role=group aria-label preserved, still in accessibility tree under Chromium), no presentational wrapper removed, no JS change. Parent `gap:4px` provides normal consistent gap between all controls. Semantics/accessibility preserved because element keeps role="group" and is still exposed with display:contents in Electron Chromium. Alternative (remove wrappers) would lose grouping, so display:contents is smallest.
- No change to `src/renderer/studio-view-panels.tsx`; order/handlers/focus/dropdown untouched.
- No shrinking: button heights 32px, widths unchanged (min-width 32), no horizontal scroll (max-width 100% + flex-wrap), no absolute positioning, no width magic.

## Focused check
- `npx tsc --noEmit` in J:/PigeonYang/WeMediaBuddy — **PASS, no output** (12.62s)

## Package / Install
- `npm run build` — **PASS**, 614.94s, artifacts at J:/wmb-out/make (exit 0). `J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar` 5,601,?? bytes `0825F01D25946BC56B6F2CD7A4561438CFA80C2AD65F752B073270EE37E186EA`.
- Installer: `J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe` 747,?? bytes `747M`, installed to `C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar` hash **matches** 0825F01D... (verified via Get-FileHash), Setup exit 0, app updated 21:14.

## Verification (packaged isolated, 1568x941)
- Harness: `tests/e2e/harness.mjs` `launchApp({appPath:"J:/wmb-out/WeMediaBuddy-win32-x64"})` isolated userData/dataRoot copying real `J:/PigeonYang/WeMediaBuddyData/wmb.db` (project 6ce12d8a, plan_item 8342f64f approved, 1 version). WorkspaceId a755adf2-4e8d-4abd-b616-4d7934f730f1 matches real DB, no DB open race.
- Flow: `waitForAppReady` → `setViewport 1568x941` → `navigateTo(studio)` → `localStorage studioSelectedId` → `reload` → `navigateTo(studio)` → `waitForSelector(.studio-formatbar/.studio-document)` → DOM evaluate → `setViewport 1568x941` → screenshot.
- Viewport: 1568x941 deviceScaleFactor 1
- Before (captured 1568x941 via before-flatten.json):
  - barRect 748w inner 724w. Groups: 段落 92w, 行内格式 144.78w, 列表 118.03w, 插入 264w, 编辑 240w. GroupsTotal 874.81, remaining -126.81 overflow.
  - Row1: 12 controls [正文(435,w92) B(531,w32) I(567,w32) S(603,w32) <>(639,w37) •列表(680,w54) 1.列表(738,w60) 链接(802,w44) 代码块(850,w58) 表格(912,w44) 分割线(960,w58) 图片(1022,w44)] used 630.81, **unused 93.1875px** blank at right.
  - Row2: 5 controls [清除(435,w44) ↶(483,w32) ↷(519,w32) 查找替换(555,w72) 标记(631,w44)] – entire 编辑 group wrapped atomically, gap 图片→清除 -630.8.
- After (flatten, 1568x941 via verify-flatten-result.json):
  - barRect same 748w inner 724w. `groupStyles` all `display:contents width 0`, `groupGaps` null (no box), `hasBorderDivider` false, `dividerCount` 0.
  - **Row1**: 14 controls [正文(435,w92) B(531,w32) I(567,w32) S(603,w32) <>(639,w37) •列表(680,w54) 1.列表(738,w60) 链接(802,w44) 代码块(850,w58) 表格(912,w44) 分割线(960,w58) 图片(1022,w44) 清除(1070,w44) ↶(1118,w32)] **used 714.81, unused 9.1875px** – fills row 1 through as many as fit, no group-sized blank remainder (93→9px).
  - **Row2**: 3 controls [↷(435,w32) 查找替换(471,w72) 标记(547,w44)] – wrap occurs **between individual controls** ↶→↷ (gap -714.81, row boundary), not at group boundary. Control gaps otherwise 4px consistent (16 gaps: 15×4px, 1×wrap).
  - Ordered 17 controls exactly: 正文 → B → I → S → <> → •列表 → 1.列表 → 链接 → 代码块 → 表格 → 分割线 → 图片 → 清除 → ↶ → ↷ → 查找替换 → 标记 (normalized, select text 正二级… mapped to 正文).
  - `autoMargin` false (group marginLeft 0px, no margin-left:auto), `dividerCount` 0 (0 els), `borderLefts` 5×0px none.
  - `toolbarVisible` true (bar 87px top128.5 width748), `bodyVisible` true (.studio-canvas/.studio-paper rect >0), `consoleErrors` 0 (pageerrors [] errors []), `focusedCheck` "focused=true tag=SELECT text=正文二级标题三级标题引用".
  - Screenshot: `2026-08-24-studio-formatbar-flatten.png` 109,950 bytes, viewport 1568x941, fullPage false. Also `verify-flatten-result.json` + `before-flatten.json`.
  - Process: harness isolated app closed via `closeApp` (browser/CDP session closed, `browserClosed true`). Hub managed corrected app `wemediabuddy-flatten-group` pid 912916 running (separate from test). Installed Squirrel stub shares hash 0825… but hub pkg is correct running proof.

## After — verification 2026-08-24 21:15 (Studio formatbar flatten)
- Packaged (installed-identical) Electron `J:/wmb-out/WeMediaBuddy-win32-x64` with real project 6ce12d8a at 1568x941: **dividerCount 0, no border dividers, no auto margin, 17 controls in order, first row uses 714.8/724 (unused 9.19), wrap between ↶↷ (individual), toolbar/body visible, console 0, screenshot 109K**.
- `npx tsc --noEmit` pass; `npm run build` + install + verification one wave; editor body/illustration/tabs/Pi dock preserved; no shrinking/scroll/absolute/width magic.

## Remaining risk
- `display:contents` on `role=group` is runtime safe in Electron Chromium (96+) where flex item flatten preserves accessibility node; verified `groupStyles` 5×display:contents and keyboard focus on SELECT still works. If future AT required box, fallback is to remove wrappers via fragment, but current preserves semantics with smallest CSS change.
