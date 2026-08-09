purpose: Today 运行卡（running）应把运行状态可见地呈现为单一 headline/status 行加进度条；失败场景是同一状态文本（`view.progress.label`）被渲染两次，用户看到语义重复的复制文本。
fails-when: 运行中 DOM 或截图里仍能同时看到两处相同可见状态文本，或进度条丢失 `aria-label` 无障碍消费时，本轮视为失败。

Loop:
Today duplicate status

Symptom:
Today 运行卡在 `running` 状态下，`view.progress.label` 的文本同时出现在两处：一处是主 headline/status 派生行，另一处是 `.today-command-run-meta` 内的紧凑可见 span。同一句运行状态文案在卡片上重复显示，视觉上像“说了两遍”。

Observation packet:
- url: Electron dev renderer via CDP，`http://127.0.0.1:27391/`
- viewport: 1600x960
- user action: 触发今日情报运行，观察 running 卡片的 headline/status 行、进度条与紧凑 meta 区
- expected: running 卡片只显示单一 headline/status 行与进度条，进度条以 `aria-label` 保留 `view.progress.label` 供无障碍消费
- actual before: `.today-command-run-meta` 内重复渲染可见 `view.progress?.label` span，与主状态行文本完全相同
- actual after: 运行卡 DOM `data-mode=running`、`metaText=''`、`visibleCompactSpan=[]`，进度条 `aria-label` 仍为 `view.progress.label`；后续 live DOM 复查 `compactSpans=[]`
- screenshot: `reports/2026-08-08-today-duplicate-status-after.png`，截图只显示单一 headline/status 行与进度条，无重复状态文案
- console: 无相关渲染错误
- network/ws: 不涉及外部网络；状态来自 renderer 的 `view` 状态
- dom selector: `.today-command-run-meta`、`.intelligence-bar`
- computed_style_layout: 不涉及布局样式缺陷；本轮验证可见文本唯一性
- state store snapshot: `view.progress.label` 唯一渲染点为 `.intelligence-bar` 的 `aria-label`；headline/stalled pill/进度条/detail/actions 均在源码 55-77 行保留

Hypotheses:
1. 紧凑 meta 文本来自独立数据源，可能与主状态行不一致。被推翻：两处文本都源自 `view.progress.label`，`aria-label` 仍消费同一值。
2. 同一 `view.progress.label` 被渲染两次——一次派生为主 headline/status 可见行，一次作为紧凑 meta 可见 span（render-guard/duplicate-render）。确认：移除冗余 span 后可见渲染只剩一处，`aria-label` 渲染保持不变。

Bug type:
duplicate-render（同一状态值被两次可见渲染，造成语义重复文案；无障碍消费未受影响）。

Chain traced:
`view` 状态（`view.headline` / `view.progress.label`）-> `today-command-run-title` headline 派生行 -> `today-command-run-meta` 紧凑 span（冗余可见渲染）-> `.intelligence-bar` `aria-label`（保留渲染）-> live DOM `.today-command-run-meta` / `.intelligence-bar` -> 截图。

Breakpoint:
`src/renderer/today-command-bar.tsx` 55-77 行运行卡区域：`.today-command-run-meta` 内曾渲染可见 `<span>{view.progress?.label}</span>`，与主状态行重复。

Root cause:
`view.progress.label` 被渲染两次：一次作为主 headline/status 派生行的可见文本，再一次作为紧凑 meta 可见 span。同一句运行状态文案因此语义重复出现两遍；`aria-label` 对 `view.progress.label` 的消费有效且予以保留。最小修复仅删除紧凑 meta 区那个冗余可见 span。

Files read:
`src/renderer/today-command-bar.tsx`（运行卡 55-77 行及周边）、`.ai/frontend-debug-loop/state.json`、`.ai/frontend-debug-loop/reports/2026-08-08-wmb-writer-completion-notification.md`（报告格式参照）。

Files changed:
- `src/renderer/today-command-bar.tsx`：仅删除 `.today-command-run-meta` 内冗余的可见 `view.progress?.label` span；`view.progress.label` 保留为 `.intelligence-bar` 的 `aria-label`；headline、stalled pill、进度条、detail、actions 均未改动。
- `.ai/frontend-debug-loop/reports/2026-08-08-today-duplicate-status.md`、`.ai/frontend-debug-loop/state.json`：本轮记录与状态更新。

Before/after gate:
- before: running 卡片同时显示两处相同状态文本（主 headline/status 行 + 紧凑 meta span）。
- after: 运行卡 DOM `data-mode=running`、`metaText=''`、`visibleCompactSpan=[]`，`.intelligence-bar` `aria-label` 保留 `view.progress.label`；截图只显示单一 headline/status 行与进度条；后续 live DOM 复查 `compactSpans=[]`；源码 55-77 行 headline、stalled pill、进度条、aria-label、detail 全部保留。
- proof: 截图 `reports/2026-08-08-today-duplicate-status-after.png` + 运行中与后续两轮 live DOM 事实（`metaText=''`、`visibleCompactSpan=[]`、`compactSpans=[]`、bar `aria-label` 保留）。

Owner check:
- user-blocked-on: 修复前运行卡状态文案重复显示，视觉冗余；修复后单一状态行 + 进度条。
- now-usable: running 卡片状态清晰唯一，无障碍标签未丢失。
- real-data-or-state: 真实 Electron renderer、真实 `view` 运行状态；非 mock。
- loading-empty-error-states: 未改动 loading/empty/error 分支；本轮只涉及 running 卡文本唯一性。
- v1-v2-baseline-preserved: headline、stalled pill、进度条、detail、actions 与 aria-label 语义均保留。
- regression-risk-checked: 移除的是纯冗余可见渲染，唯一渲染点为 aria-label，回归风险为单点且已由 DOM/截图双证。
- would-user-return-this: no。

Result:
Today 运行卡不再重复显示状态文案：单一 headline/status 行与进度条可见，`view.progress.label` 作为进度条 `aria-label` 保留，无障碍消费完整。

State update:
`state.json` 将 active loop 更新为 `today-duplicate-status`、status `complete`，记录 observation（`metaText=''`、`visibleCompactSpan=[]`、bar aria-label 保留）、确认的 render-guard/duplicate-render 假设、breakpoint、owner_check、attempts=1 与 DOM/截图 gate。

Clean completion: yes
Blocked reason: 无。
