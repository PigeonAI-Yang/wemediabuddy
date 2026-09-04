# WMB-5348 Studio 信息密度整改 — Evidence (R2 回归修复)

## 回归根因（用户真实截图 1568x843 长正文）
- 长正文 + 真实 dual 数据使底部 studio-dual-ledger 被推出视口，仅约 1px 边线位于全局 status-bar 上方，主/衍生产物入口不可点。
- 上一验收仅断言元素声明高度（summary 44、ledger row 44x2=88 ≤104）与 overflowX=0，未断言 getBoundingClientRect().bottom 与 statusBar.top 的 viewport 相对位置，也未在长正文 scrollHeight>clientHeight 下验证 ledger.bottom <= statusBar.top。
- 结构根因：studio-document / studio-canvas 链路后段被复写为 flex:1 1 auto; min-height:420px（失去 min-height:0 与显式 flex:none 的 footer/ledger 约束），且 ledger 为两行 88px 纵向 grid，长正文使纸张撑高，容器随内容生长把 ledger 推至视口外被 status-bar 遮挡。

## 变更 (R2)
- 顶部保持：单条 44px studio-illustration-summary-bar（状态·完成/总数·统一比例·张数·主操作/详情入口），聚合 completed/total 与 hasRunning，空/loading/error 均显式，逐项状态进 StudioIllustrationDetailModal。
- 底部：studio-dual-panel 双大卡 190px → **单条 44px 横向两段** studio-dual-ledger（左主产物/右衍生产物），display:flex 横向，height/min/max 44px, flex:none；每段 .studio-dual-ledger-row flex:1 1 0, height 44px, border-right 分割，type/name/status/version 完整，整行或“查看详情”进 DualDetailModal（AppModal, Escape/焦点返回/aria-labelledby）。窄容器 @media(max-width:900px) 可退为 88px 两行 column，但 1568x843 与 1366x768 保持一行。
- 版式链路强制约束：studio-editor-view / studio-editor-grid / studio-document 均 min-height:0 + overflow:hidden + display:flex 垂直列；studio-canvas flex:1 1 auto; min-height:0; overflow:auto（正文内部滚动）；studio-writing-status 与 studio-dual-ledger flex:none；不使用 fixed/absolute 覆盖正文。
- 仅 styles-foundation.css tokens + 既有 4/8 间距，无品牌 token 变更，无新依赖，无 main/DB/Writer policy 改动。

## 文件
- src/renderer/styles-studio.css — R2 ledger 单行 44px flex + canvas 链路 min-height:0/overflow:auto 约束 + 900px 断点回退
- src/renderer/studio-derivative-panel.tsx — 保持两段 row 结构（data-kind article/derivative），CSS 侧改为横向两段，无 JS 逻辑改动，复用 AppModal
- src/renderer/studio-view-research.tsx — summaryBar 保持
- src/renderer/studio-view.tsx — 保持
- tests/wmb-5348-studio-density.test.mjs — 10/10（原 7 + 新增 3：R2 单行 flex/R2 chain/R2 viewport 合约）
- scripts/verify-wmb-5348-long.mjs — 长正文双视口真实 Electron 校验（新增）

## 测试
- node --test tests/wmb-5348-studio-density.test.mjs **10/10 PASS**
  - R2 ledger is single 44px flex row with two segments（display:flex height44 flex:none，row flex:1 1 0 border-right，@media 900 回退 88 column）
  - R2 canvas chain enables internal scroll and pins footer/ledger（editor-view/grid/document min-height0 overflow hidden，canvas flex1 min0 overflow auto，footer/ledger flex none，无 fixed/absolute）
  - R2 ledger viewport visibility contract（ledger 44 单行、row 44、isSingleRow、overflow hidden 保证视口可见）
- 二次聚焦合同同 10/10，typecheck 0
- 长正文 E2E 双视口验证 **通过**（见下）

## 真实 DOM 尺寸（隔离 Electron + 长正文项目 WMB-5348 长正文回归项目，coreV2 40节·每节2段+列表·约2万px纸张）
- 1568x843：summary **44px** ledger **44px**（单条，row 44px×2 并列 isSingleRow true），ledger width 748px（row 373.5 + 372.5），ledger bottom 792px < statusBar top 809px **+17px 间隙**，overflowX **0**，canvas height 441.5px，canvas scrollHeight **20372px** > clientHeight **442px**（内部滚动），paper 20282px，doc min-height 0px display:flex overflow hidden，ledger display flex flex 0 0 auto。
- 1366x768：ledger **44px** isSingleRow true，row 367.5+366.5，bottom 717px < statusBar top 734px **+17px 间隙**，overflowX **0**，canvas 366.5px scrollHeight 20372 > clientHeight 367，paper 20282px。
- 对比 R1（两行 88px，容器 49px 含边框，canvas 436px paper 644px，短正文）：R2 单行节省额外 44px，且长正文下仍保持 ledger 完整可见，不被 status-bar 覆盖。
- console/pageerror：**pageerrors=[]**，errors=[]（base ./ 重建后，仅 Electron Security Warning，无业务错误；之前 logo/x 绝对路径错误已通过 base 修复消除）
- 交互：1568 与 1366 下分别点击 主产物“查看详情”与衍生产物“查看详情” → DualDetailModal 打开（含 dl/ol/script/decision/alignment/stale 版本列表），Escape 关闭，focus 返回 ledger 按钮（aria-label 查看主产物详情/查看衍生产物详情，tag BUTTON insideLedger true）。
- 截图（肉眼可见完整单行产物栏）：
  - studio-ledger-long-1568x843.png（125KB）— 顶部 summary 44，中间纸张长文可滚动，底部单行双段 ledger 完整，无横溢，17px 上距 status-bar
  - studio-ledger-long-1366x768.png（101KB）— 同上，736px 宽 ledger 双段并列
  - 历史短正文截图仍保留：studio-density-1568.png / studio-density-1366.png（62-63KB）

## 进程回收
- 隔离验证 wmb-5348-long（tests/e2e/.runtime/run-*）与 debug-launch 均已 app.close()，通过 Get-CimInstance 查询 J:/PigeonYang/WeMediaBuddy\node_modules\electron 进程已退出（无残留）；WeMediaCreator 残留 electron 为无关项目。
- WeMediaBuddy.exe 常驻（wmb-out-5348 packaged, AppData\Roaming\WeMediaBuddy）保持 4 进程（主/GPU/renderer/utility）正常运行，未被关闭；wemediabuddy-user 数据隔离未触碰。
- 关闭验证以 app.process exitCode/killed 与 CimInstance 双重确认 exited。

## 验收
- 两个目标视口（1568x843 与 1366x768）均看到完整单行 44px 产物栏（左主产物/右衍生产物各显示 name/status/version，可点击打开详情），长正文在 studio-canvas 内部滚动（scrollHeight > clientHeight），不把产物栏推出主列，ledger.bottom 严格高于全局 status-bar top，无重叠/裁切/横溢，无 fixed/absolute 覆盖；二次聚焦测试 10/10 与 E2E 双视口验证通过。
