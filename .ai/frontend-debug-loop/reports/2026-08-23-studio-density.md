# Studio information density debug observation — 2026-08-23

Category: layout / information hierarchy

## Symptom (user screenshot ground truth)
- View: 创作 → 正文 (Studio editor, selected project with revisions)
- Viewport: 1568×843
- Top area: from "运行 running" through multiple "配图 completed/generating/pending" occupies ~180px. It is a stacked, scrolling block (`studio-illustration-panel` max-height 168px + formatbar illustration group). Dense list of per-image states takes vertical space from body.
- Bottom area: two large cards "主产物 文章主稿" and "衍生产物 视频文案" occupy ~190px as a side-by-side grid (`studio-dual-panel` with two `studio-dual-output` cards, dl+ol+script). Pushes canvas down.
- Result: body (`studio-paper` / `studio-canvas`) is compressed; primary editing surface is not the visual protagonist despite being the core task.

## DOM / CSS selectors (pre-fix)
- Top: `.studio-formatbar-illustration` (ratio + count + 定稿配图 button) + `section.studio-illustration-panel[aria-label="配图运行"]` containing `.studio-illustration-run` / `.studio-illustration-item` per item. CSS: `.studio-illustration-panel{max-height:168px; overflow:auto; border-bottom:1px solid var(--border-soft); background:var(--panel-bg); padding:8px 12px}`.
- Bottom: `section.studio-dual-panel` (`display:grid; grid-template-columns: repeat(2,minmax(0,1fr))`) with two `article.studio-dual-output` (padding 14px 16px, dl 3 cols). Whole panel `margin-top:14px; border:1px solid var(--border); border-radius:10px; overflow:hidden`.
- Tokens: only `styles-foundation.css` tokens and existing spacing are allowed; existing components and `AppModal` pattern must be reused.

## Existing data / behavior to preserve
- Generation: `illustrationRuns: IllustrationRun[]`, `illustrationRatio`, `illustrationMaxGenerated`, `illustrationBusy`, `illustrationRequest`, handlers `startIllustrationRun`, `retryIllustrationItem`, `regenerateIllustrationItem`, `undoIllustrationItem`.
- Derivative: `window.wmb.getStudioDualProjection(projectId)` → `Dual { article, derivative, compare, readiness, isStale }`, versions, formatDecision, alignment, stale flag.
- Editor, version select, Pi dock, theme, foundation tokens, main/DB/Writer research policy untouched.

## Expected fix
- Top: single ~40–48px summary bar showing aggregate run status, completed/total, unified ratio, image count, single primary action / detail entry. Per-image state, selectors, single regenerate moved into detail modal. Empty / loading / error must still have explicit summary.
- Bottom: two ~40–48px ledger rows (合计 ≤104px) with at least type, name, status, version/latest identity. Whole row or "查看详情" opens a modal bearing all previous card details + version lists. Modal reuses `AppModal` (Escape, focus return, aria-labelledby). Modal is not default first screen. No horizontal overflow; keyboard/ARIA/Escape/focus-return works; different states remain readable.

## Acceptance (from contract)
- Real page top ≤56px; two product records total ≤104px; detail can open and shows original info, closes with focus return; generation/regeneration entry still exists; body area increased; 1366×768 no overflow, no pageerror.

## Evidence pointers
- `.ai/frontend-debug-loop/state.json` will be updated to active_loop `2026-08-23-studio-density`.
- Focused tests: `tests/wmb-5348-studio-density.test.mjs`.
- Visual proof: before/after DOM heights, overflow, console/pageerror, screenshots captured via isolated Electron surface using real current project data (创作→正文). Process exit evidence captured without closing `wemediabuddy-user`.
- Final ledger: TASKS.md WMB-5348 doing→done, plus `.ai/wmb-5348-evidence.md`.

## Hypotheses
1. Height is structural, not data-driven: CSS max-height + per-item grid creates linear growth with item count; summary computation can be derived from runs without enlarging chrome.
2. Bottom cards encode version history linearly; ledger + modal can achieve O(1) chrome with O(n) detail on demand, using AppModal's proven focus trap.
3. Token-only CSS can achieve 44px bars using 4/8px scale without brand changes; risk is accidental hard-coded values or arbitrary px.

## Next checks
- Measure `.studio-illustration-summary-bar` and `.studio-dual-ledger` heights at 1568×843 and 1366×768.
- Verify `AppModal` Escape / focus return / aria-labelledby holds for both new modals.
- Confirm busy/loading/empty/error summary text is explicit.
- Confirm no horizontal scroll at both viewports.

## After — verification 2026-08-23 14:50 (WMB-5348)
- 隔离 Electron (dev, .vite 修复后) + 真实项目 “WMB-5348 密度验证项目” (workspace da279c82-37ab-4acf-bceb-d11846dda7e7)
- 1568×843: summary **44px** (≤56) `0/0 暂无配图` · ratio select + count input + 定稿配图; ledger **row 44px×2 合计88px** (≤104, container 49px含边框) · overflowX **0** · canvas **436.19px** paper **644px** · hasRatio/hasCount/hasStart true
- 1366×768: summary **44px** row **44×2** overflow **0** canvas **420px**
- before 180+190=370px → after 44+88=132px **节省238px**，正文显著增高
- console `pageerrors=[]` (唯一 ERR_FILE_NOT_FOUND 为 logo 绝对路径历史遗留，已修复 index.html 相对路径后 ST-001 1/1 PASS)
- 截图：`2026-08-23-studio-density-1568.png` (96K) / `2026-08-23-studio-density-1366.png` (77K) / `.ai/wmb-5348-evidence/*.png` (62-63K)，正文为视觉主角，无横向溢出/遮挡
- 详情弹窗：illustration 空态时查看详情隐藏符合预期，ledger 行 `role=button` + `查看详情` 按钮进 AppModal，aria-label/键盘 Enter/Space 可达，Escape 关闭，焦点返回（AppModal previouslyFocused）
- 聚焦测试 **7/7 PASS**，`ST-001-studio-project-normal` **1/1 PASS** (10s)，`.vite` 白屏根因（绝对路径 `/assets/...` → `./assets/...`）微修后通过
- 证据：`.ai/wmb-5348-evidence.md` + `measurements.json` + 截图；进程 `electron.exe` 已回收，用户 `WeMediaBuddy.exe` 5 进程常驻未动

## Regression 2026-08-23 R2 — 长正文 viewport 遮挡回归（用户真实截图 ground truth）

**用户观测为事实，不重新证明 before：**
- 视口 1568x843，真实项目+长正文（body 超长， scrollHeight > clientHeight）时，底部 studio-dual-ledger 被推出视口，仅约 1px 边线位于全局状态栏 .status-bar / .app-shell 底边上方；主产物/衍生产物两入口不可点、不可见。
- 上一验收（2026-08-23 14:50）仅断言了元素声明高度（summary 44px、ledger row 44x2=88px ≤104）与 overflowX=0、canvas 高度，未断言 getBoundingClientRect().bottom 相对 viewport 与全局状态栏 top 的位置关系，也未在长正文下验证 ledger.bottom <= statusbar.top 与段落可见性。
- 根因假设：studio-document/studio-canvas 链路缺少 min-height:0/overflow:auto 约束，且 studio-canvas 被后段 CSS 复写为 flex:1 1 auto; min-height:420px（失去 min-height:0 与显式 flex:none 的 footer/ledger 约束），长正文使纸张高度撑大，grid/flex 容器随内容生长而把 ledger 推至视口外，被状态栏遮挡；同时 ledger 为两行 88px 纵向堆叠，未实现合同要求的“单条 44px 横向两段”。

**本次回归修复合同（WMB-5348 R2）：**
- ledger 改为真正单条 44px display:flex 横向两段（左主产物/右衍生产物），各段含 type/name/status/version 且整段/按钮可点打开既有 DualDetailModal（AppModal, Escape/焦点返回）；窄容器若既有断点需要可退为两行 88px，但 1568x843 与 1366x768 保持一行；
- 正文链路补齐 min-height:0 与内部 overflow:auto：studio-editor-view/studio-editor-grid/studio-document 均 min-height:0/overflow:hidden，studio-canvas flex:1 1 auto; min-height:0; overflow:auto，正文内部滚动，studio-writing-status 与 studio-dual-ledger flex:none，不使用 fixed/absolute 覆盖正文；
- 回归测试新增：长正文 fixture 下两段 getBoundingClientRect() 完整位于 Studio 主列且 ledger.bottom <= statusbar.top，旧双行/无约束实现应在该用例失败；
- 真机双视口验证：1568x843 与 1366x768 下 ledger height 44、两 segment 可见、ledger.bottom <= statusbar.top、overflowX=0、正文 scrollHeight > clientHeight 且内部滚动、pageerror=[]，分别打开两详情并 Escape 关闭、焦点返回；截图需肉眼可见完整单行产物栏；测试进程/标签回收，不关闭 wemediabuddy-user。

**验证计划（与主任务第 4 步一致）：**
- 启动隔离真实 Electron（--user-data-dir 临时、真实长正文项目、真实 dual 投影），固定视口 1568x843 与 1366x768；注入长正文后测量 studio-dual-ledger、两 studio-dual-ledger-row[data-kind]、studio-canvas、.status-bar 的 rect 与 overflow；断言见验收；交互打开详情/Escape；截图至 .ai/wmb-5348-evidence/；进程级确认 exited。

## After — verification 2026-08-23 R2 长正文回归（WMB-5348 R2）
- 隔离 Electron (file 模式, base ./ 重建后) + 长正文项目 “WMB-5348 长正文回归项目” (coreV2 40节长文，paper 20282px)
- 1568x843: ledger **44px** 单条 isSingleRow true (row 373.5 + 372.5)，ledger bottom 792 < statusBar top 809 **+17px**，overflowX 0，canvas 441.5px scrollHeight 20372 > clientHeight 442，paper 20282px，doc min-height 0 display:flex overflow hidden，ledger display flex flex 0 0 auto
- 1366x768: ledger **44px** isSingleRow true (367.5+366.5)，bottom 717 < statusBar 734 **+17px**，overflowX 0，canvas 366.5px scrollHeight 20372 > 367
- 修复前 ledger 为两行 88px grid 且 canvas min-height 420 无 min0 约束，长正文纸张撑高把 ledger 推至视口外仅 1px；修复后单行 44 flex + 链路 min0/overflow:auto，内部滚动，footer/ledger flex:none，无 fixed/absolute
- console pageerrors=[] errors=[]（仅 Security Warning），无业务错误；base ./ 后 logo/x 资源 404 已消除
- 交互：两视口分别点击主产物/衍生产物“查看详情” → DualDetailModal 打开（含旧卡片全部 dl/ol/script/decision/alignment/stale），Escape 关闭，focus 返回按钮（BUTTON insideLedger true）
- 截图：studio-ledger-long-1568x843.png (125KB) / studio-ledger-long-1366x768.png (101KB) — 肉眼可见完整单行双段，无横溢，距 status-bar 17px
- 聚焦测试 **10/10 PASS**，长正文 E2E 双视口验证 **通过**，.vite base ./ 重建后白屏修复
- 证据：.ai/wmb-5348-evidence.md (R2)、measurements-long.json、截图、loop 报告本段；进程 Get-CimInstance 确认 wmb-5348-long electron 已退出，WeMediaBuddy.exe 4 进程常驻未动
