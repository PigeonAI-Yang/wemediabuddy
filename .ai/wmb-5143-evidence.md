# WMB-5143 Evidence — 智能体页实例驱动 UI（五角色分组 · 实例卡 · 页头摘要 · 历史折叠 + 续派）

- 日期：2026-08-09
- 合同：`.ai/wmb-5143-contract.md`（实施阶段）；设计真源 `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` §4/§7/§11/§12.2.4/§12.2.6/§14/§16、PRODUCT C9、PRD REQ-028/REQ-029 + AC-024..AC-027、SPEC §1.0 不变量 8/9 + CAP-027（EVAL-030）
- 改动文件（1 新建纯逻辑 + 1 视图重写 + 1 样式重写 + 1 只读投影 IPC + 1 preload 适配 + 1 类型适配 + 2 测试 + 本证据）：
  - `src/renderer/agents-instance-logic.ts`（**新建**：状态词/等待原因/过滤/续派输入/耗时的纯逻辑，测试可直接断言）
  - `src/renderer/agents-roster-view.tsx`（**重写**：槽位视图 → 实例驱动视图，676 → 474 行）
  - `src/renderer/styles-agents.css`（**重写**：删除席位/工单板样式，新增分组/实例卡/历史样式）
  - `src/main/ipc-today-studio-business.ts`（+9 行：只读投影 IPC `agents:crew-projection`，合同允许「新 IPC 仅限投影只读面」）
  - `src/preload/preload.ts`（+1 行：`getCrewInstanceProjection` 适配）
  - `src/renderer/global.d.ts`（roster 行类型补全 `instances` + 新增投影方法类型）
  - `tests/agents-roster-conflict.test.mjs`（DOM 门从席位断言改为实例驱动视图断言）
  - `tests/wmb-5143-agents-instance-view.test.mjs`（**新建**，12 条聚焦测试）
  - `scripts/line-caps.json`（agents-roster-view.tsx 675→476、P1 收口 476→467（均按 check.ps1 的 (Get-Content).Count 口径）、styles-agents.css 1106→830 只降、复查修复 830→836；global.d.ts 572→574 只升；测试文件 197 行 ≤500 无注册 cap）

## Background / 复现（Change 1）

实施前以最新源码与既有测试复现槽位 UI（合同要求「先复现」）：
- `tests/agents-roster-conflict.test.mjs` 原「roster view DOM gates」用例断言 `agents-seat-cell desk` 席位 DOM 与「主管席占用」危险态——即固定槽位 UI 的可执行复现（改前 8/8 绿）。
- 源码复核：`agents-roster-view.tsx` 渲染 `agents-seat-strip`（主管席 + 4 员工座，空角色显示「待命」）、`agents-seat-meter`（槽位格）、`agents-slot-pill`（槽位 N/M）、工单板三车道（执行中/排队中/终态）——同角色多实例无独立表达，历史依赖内存池 `jobs:list`。

## Implementation（Change 2-5）

**接线真实 API 形状（Change 2）**：
- 读取 `src/main/crew-instance-projection.ts` 的 CrewInstanceProjection DTO（jobId 一等身份 / roleId / brief / status / displayNumber / waitReason / progressLabel / progressRatio / phase / error / code / queuedAt / startedAt / finishedAt / source，active 含 needs_user、history 只从持久面重建、byRole 分组、summary）。
- 新增只读 IPC `agents:crew-projection`（`readCrewInstanceProjection` 直通，不经 dispatcher/池语义；合同「如需新 IPC 仅限投影只读面」）+ preload 适配 + `global.d.ts` 类型；roster 行类型补全 `instances`（WMB-5142 已在 API 层携带）。视图全部显示只来自投影（UI 单源 §12.2.6）。

**删除槽位语义与空角色卡（Change 3）**：
- 删除 `agents-seat-strip`/主管席/员工座/槽位格/`待命`/`agents-slot-pill`/工单板；`styles-agents.css` 重写无任何 seat/slot 样式。
- 五角色分组（主管/记者/策划/写手/资料员）始终可见：`data-role` 分组头 + 空角色「当前无任务」一行；不渲染虚构人物卡。
- 实例卡 = 名牌（角色 + 活动期编号「记者 #N」，displayNumber 仅活动期显示）+ 任务一句话 brief + 状态词/状态点双编码 + 进度（progressLabel N/M + 进度条）+ 当前步骤/等待原因（可读化，禁止裸「等资源」）+ 入队/开始/耗时；同角色实例组内并列（wrap 网格，auto-fit minmax）。
- 历史折叠区（每角色 `<details>`）：最近 5 条终态实例（状态 + 一句话 + 时间），jobId 可复制、一键续派；历史只来自投影 history（持久面重建，不与 active 双计——投影层已按 jobId 去重，视图直接消费）。

**状态语义 / 按钮（Change 4，按现有 handler）**：
- 状态词与状态点双编码（§11.1）：排队中/灰、等资源/灰（带原因）、工作中/琥珀（无脉冲）、等你批/蓝、已完成与部分完成/绿、失败/红、已取消/灰；`needs_user` 卡停留活动视图并带稳定 code + 原因，文案不说失败/等容量。
- 按钮：复制 jobId（`navigator.clipboard`，全部卡）；取消（queued/waiting_resource/running → `jobsCancel`）；续派（needs_user 卡与历史行 → `jobsSpawn(redispatchInput)`，重建 roleId/brief/businessDate/projectId）；关闭（needs_user 卡 → `jobsCancel`，WMB-5142 关闭路径）。
- 页头摘要「工作中 N · 排队 M · 等你批 K」+ 容量 maxWorkers（桌助不计容量——投影不含 desk，desk 分组不渲染实例卡）全部来自投影 summary，可点过滤（running/queued/needs_user，另附「显示全部」复位）；无实例时总量空态。
- 桌助分组 = 协调入口状态一行（running → 工作中；冲突——桌助 blocked 或员工工单资源占用 → 受阻；否则「当前无任务」+ summary）+ 提示文案；`resolveDeskConflict`（WMB-5137）驱动危险 callout、桌助状态点与状态词（deskState 以 deskConflict 优先）。

**空/错误/窄屏/a11y（Change 5）**：
- 加载态：「正在读取班组状态…」；错误态：既有「连接中断」banner + 重试；操作错误走 message 状态行（role=status）。
- 窄屏：分组网格 auto-fit（≤1280px 收窄列宽），卡片/摘要/派单条均可换行，无水平溢出。
- a11y：状态点 aria-hidden + 状态词文字（双编码达 WCAG AA）；进度条 role=progressbar + aria-valuenow；按钮/select/`<details>` 键盘可达（focus-visible 轮廓沿用）；running 状态点无脉冲动画，进度 transition 在 `prefers-reduced-motion` 下关闭。

## Commands / Results（Change 6-7）

- `node --test --test-concurrency=1 tests/wmb-5143-agents-instance-view.test.mjs tests/agents-roster-conflict.test.mjs`：**22/22 PASS**（12 + 10：wmb-5143 文件 12 条 = 10 条原 + 2 条 P3 回归门；conflict 文件 10 条 = 8 纯函数 + 2 DOM 门）
  - 新增 12 条：状态词无「待命」实例态；等待原因可读（RESOURCE_LOCK_CONFLICT/RESOURCE_LEASE_BUSY/RESOURCE_JUDGE_IN_FLIGHT → 人类可读，无裸「等资源」）；实例详情（谁/干什么/卡在哪 + 可操作收尾）；耗时锚点（已跑/已等/停留）；页头摘要只来自投影（null → 0）；状态过滤只影响卡片可见性；续派输入重建（roleId/brief/businessDate/projectId）；DOM 门（活动期编号渲染、动作按钮、五分组、空态文案、历史折叠、摘要文案、desk 不渲染实例卡、投影接线）；样式门（无 seat/slot 样式、running 无脉冲）。
  - `agents-roster-conflict.test.mjs` 10 条：纯函数行为 8 条原样保持绿；DOM 门 2 条改为实例驱动视图断言（callout/桌助状态点与状态词仍只由 deskConflict 驱动 + 全视图无 槽位/坐席/待命/agents-seat/slot 术语 + 空态「当前无任务」）。
- 回归：`tests/wmb-5142-instance-projection.test.mjs` + `job-pool-stress` + `job-pool`：**50/50 PASS**（投影合同 15/15 保持绿，UI 消费兼容零回归）。
- `npx tsc --noEmit`：PASS（0 错误）。
- line-cap（复查修复后）：`agents-roster-view.tsx` 按 check.ps1 的 (Get-Content).Count 口径为 467（该口径是合规唯一依据；wc -l 按换行符计数为 469，与 Get-Content 不等，不声称一致）、`styles-agents.css` 836、`global.d.ts` 574 → `scripts/line-caps.json` 登记同值（与 check.ps1 精确匹配门一致：注册 cap = (Get-Content).Count，只降不升；agents-roster-view.tsx 由 476 收紧到 467；css 因新增 blocked 规则 830→836 同步上调）；`agents-instance-logic.ts` 173、`tests/wmb-5143-agents-instance-view.test.mjs` 197、`tests/agents-roster-conflict.test.mjs` 113（均无注册 cap，≤500）。按合同跳过 formatter/lint/build/项目级全套/check.ps1（主 Agent 统一执行）。

## Acceptance 对照

- 合同 AC-024 / EVAL-030 空态：全空时五角色分组头始终可见、各显示「当前无任务」，页头摘要「工作中 0 · 排队 0 · 等你批 0」，全页无「待命」/占位坐席文案（wmb-5143 T9/T10 源码门 + agents-roster-conflict 术语门；实机 DOM 断言由主 Agent 验收）✓
- AC-024 / EVAL-030 多实例：同角色多张实例卡「记者 #1」「记者 #2」组内并列、各自进度/状态独立（displayNumber 渲染门 + 投影 byRole 消费）✓
- AC-025 / EVAL-030 终态退出与等你批：投影 active 只含 queued/waiting_resource/running/needs_user（WMB-5142 合同）；needs_user 卡停留活动视图带「等你批」+ code + 续派/关闭动作，其余终态只出现在历史（view 只渲染投影给定内容，无第二份标签）✓
- 实例卡内容：名牌 + 任务一句话 + 状态词/点双编码（WCAG AA）+ 进度 N/M + 入队/开始/耗时；等待原因可读、失败/等你批文案以可操作指引收尾（实例详情纯逻辑 T3）✓
- 页头摘要与过滤：工作中/排队/等你批全部来自投影 summary，可点过滤；无第二份手写标签（UI 单源 §12.2.6）✓
- 历史 + 一键续派：历史每角色最近 5 条从持久面投影（不依赖内存池），续派参数 = 重建 roleId/brief/businessDate/projectId（UI 侧；完整 RoleJobRequest 重建在 main 侧由 5141/5142 合同承担，A13 实机重启验证由主 Agent 统一执行）✓
- 桌助不计容量：desk 不进入员工投影、不渲染实例卡、不参与摘要计数；容量只显示 maxWorkers 摘要 ✓
- 门禁：typecheck 0（自验）；聚焦测试 22/22（复查修复后）+ 回归 50/50；`check:capabilities`（G1）由主 Agent 统一执行（本变更零触碰 registry 文件）✓

## 复查修复（ReviewWmb5143 + 收口 CloseWmb5143Evidence：三个 P3 关闭，2026-08-10）

ReviewWmb5143 复核出两个 P3 非阻断问题，收口复查又核实第三个 P3（桌助状态词双编码）与两处证据数字失实，本次全部修复：

**P3-1 桌助 blocked 状态点/词失去 danger 样式（styles-agents.css）**
- 视图在 `deskConflict` 时照常输出 `agents-status-dot status-blocked` + `agents-status-word status-blocked`（desk 分支状态一行），但 CSS 重写删除了全部 `.status-blocked` 规则 → 状态点为透明空圆、「等你批」回退默认墨色，WMB-5137 的双编码丢失。
- 修复：在 `styles-agents.css` 状态点/状态词区（danger 家族旁）补两条规则——`.agents-status-dot.status-blocked { background: var(--danger); }`、`.agents-status-word.status-blocked { color: var(--danger); }`。状态行字用的是 `agents-status-word` 类（非 `agents-status-line`），按 reviewer 指出的目标类补齐。红点 + 红字双编码恢复，与 `agents-callout danger seat-conflict` 红色警示一致，视觉系统无其他改动。

**P3-2 投影 IPC 单独失败永久 loading（agents-roster-view.tsx load()）**
- 原 `load()` 四路 fetch 各自 `.catch(() => null)`，`stale` 仅由外层 catch 置位：投影 IPC 失败而其余三路成功时 `projection` 为 null、`stale` 为 false，加载门 `projection === null && !stale` 永久成立，无「连接中断」banner 也无重试。
- 修复：load 结果 `proj` 为 null 时置错误态 `setStale(!proj)`（沿用既有 banner + 重试按钮，「成功后恢复」由下次成功 load 的 `setStale(false)` 承担）；同时引入 `latestSeq` 请求序号守卫——interval（3s）/onDataChanged 触发的重叠 load 只有最新请求落地，过期结果不覆盖新状态；unmount 仍由 `active` 保护，`refresh()`（派单/取消后的用户主动刷新）语义不变。渲染门保持 `projection === null && !stale` 才显示「正在读取班组状态…」，故投影失败时立即退到 banner + 可用数据（roster/容量），不再卡死。

**P3-3 桌助状态词未以 deskConflict 驱动（agents-roster-view.tsx）**
- 实景：员工工单资源占用（deskStatus='running' + RESOURCE_LOCK_CONFLICT/RESOURCE_LEASE_BUSY park，agents-roster-conflict.test.mjs:36-44 覆盖）时，状态行已输出 status-blocked 红点/红字，状态词却由 `deskRow?.status === 'blocked'` 决定 → 渲染为红色「工作中」，状态词/状态点双编码在该真实路径自相矛盾。
- 修复：deskState 以 deskConflict 优先——`deskOccupied ? (deskConflict ? '受阻' : '工作中') : '当前无任务'`；冲突（桌助 blocked 或员工资源占用）显示「受阻」，与红点/红字（status-blocked → var(--danger)）一致；非冲突占用保持「工作中」。
- 补充断言（agents-roster-conflict.test.mjs DOM 门内，不新增测试数）：deskState 表达式以 deskConflict 优先、状态词 span 渲染 deskState，与既有状态点门配套。
- 顺带行数压缩：agents-roster-view.tsx（renderRoleHead 头组件去重两处重复按钮/标题 JSX + 状态词分支简化），渲染行为不变；按 check.ps1 的 (Get-Content).Count 口径由 476 → 467（wc -l 换行符口径为 478 → 469，仅供对比、不用于合规判定）。

**回归门（tests/wmb-5143-agents-instance-view.test.mjs 新增 2 条，10 → 12；agents-roster-conflict.test.mjs DOM 门补充 deskState 词断言）**
- `styles gates: desk blocked state keeps danger double-encoding (WMB-5143 P3-1)`：断言 CSS 含 `.agents-status-dot.status-blocked { background: var(--danger) }` 与 `.agents-status-word.status-blocked { color: var(--danger) }`。
- `view load gates: null projection flips error state, stale requests dropped (WMB-5143 P3-2)`：断言 load 对 null proj 置错误态（`setStale(!proj)`）、加载门条件 `projection === null && !stale` 保留、并发守卫 `requestSeq !== latestSeq` / `requestSeq === latestSeq` 存在。

**验证（聚焦 + typecheck，按合同跳过项目级检查）**
- `node --test --test-concurrency=1 tests/wmb-5143-agents-instance-view.test.mjs tests/agents-roster-conflict.test.mjs`：**22/22 PASS**（12 + 10：wmb-5143 文件 12 条含 2 条 P3 回归门；conflict 文件 10 条 = 8 纯函数 + 2 DOM 门，纯函数 8 条原样绿，无回归）。
- `npx tsc --noEmit`：PASS（0 错误）。
- line-cap：`agents-roster-view.tsx` 按 check.ps1 的 (Get-Content).Count 口径为 467，`scripts/line-caps.json` cap 由 476 收紧到 467（wc -l 为 469，仅换行符口径、与 Get-Content 不等）、`styles-agents.css` 830→836（`scripts/line-caps.json` 同步）、`global.d.ts` 574 不变；`tests/wmb-5143-agents-instance-view.test.mjs` 197 行、`tests/agents-roster-conflict.test.mjs` 113 行（均 ≤500 无注册 cap）。修复范围仅 `src/renderer/agents-roster-view.tsx`、`src/renderer/styles-agents.css`、`tests/wmb-5143-agents-instance-view.test.mjs`、`tests/agents-roster-conflict.test.mjs`、`scripts/line-caps.json`、本证据，未触碰 registry/契约/其他行为。

**P1 收口（FinalApproveWmb5143 唯一 P1：cap ratchet 合规，2026-08-10）**
- 实景：复查修复压缩后 `agents-roster-view.tsx` 的 check.ps1 计量 `(Get-Content).Count` 为 467，而 `scripts/line-caps.json` 仍登记 476 → check.ps1 的 line-cap 阶段按「只降」ratchet 抛错（`below its legacy cap 476; tighten scripts/line-caps.json to 467`）。原证据「wc -l / awk NR / grep -c 三计数一致」失实：wc -l 按换行符计数为 469，与 Get-Content 467 不等（二者计量口径不同，不可互换）。
- 修复：`scripts/line-caps.json` 中 agents-roster-view.tsx cap 476 → 467（= check.ps1 实际 `(Get-Content).Count`，精确匹配门，只降）；本证据全部 cap 措辞统一为单一计量口径（check.ps1 的 `(Get-Content).Count`），删除/改写所有 wc 等价声称。本变更仅触碰 `scripts/line-caps.json` 与 `.ai/wmb-5143-evidence.md` 两文件，未改 tsx/测试/样式。
- 验证：复刻 check.ps1 line-cap 循环实测——agents-roster-view.tsx 467 = cap 467，不再低于注册值，line-cap 阶段不因该文件失败。

## Impact

- **Capability registry**：no change —— `agent-capabilities.ts`/`page-authority.ts` 零触碰（纯 renderer 投影 UI + 只读投影 IPC）。
- **Pi operator Skill**：no change —— 无提示词/工具面变更；Dock 收件人钉死桌助为既有 manager-as-primary-agent 契约（5144 单独登记多实例感知提示词）。
- **已知边界**：历史行以 `context_refs_json.jobId` 合同为锚（无合同旧卡无历史行，仅审计可追，与 WMB-5142 边界一致）；遗留 daily/页任务（不经 JobPool）在角色组内以「后台任务」状态一行投影（desk 零回归保留既有可见性），不渲染为实例卡。
