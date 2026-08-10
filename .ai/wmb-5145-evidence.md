# WMB-5145 Evidence — EVAL-030 集成验收（设计 §14 A1..A14）+ 门禁 + 隔离实机 + 独立复审

- 日期：2026-08-10（捕获窗口 04:28–04:57；当前状态复跑 06:0x）
- 合同：`.ai/wmb-5145-contract.md`（Route: Design，Owner main）
- 设计真源：`docs/spark/2026-08-08-agent-crew-multi-instance-design.md` §12.2/§14/§16/§17；SPEC EVAL-030；PRODUCT C9；PRD REQ-028/029 + AC-024..027
- 验收口径：设计 §14 A1..A14 逐项可证伪（负断言真实执行）+ G1/G2 门禁 + 隔离实机（含重启续派 A13）+ 独立复审 + 证据包 + TASKS 五行 done 回执
- 时间口径约定：**捕获** = 主 Agent Full check 与打包实机执行时刻（04:28–04:57，WMB-5150 未落盘）；**当前** = 本证据复跑时刻（06:0x，WMB-5150 已并发落盘 registry/迁移改动）。两者分开标注，不混同。

## 0. 交付物总览（5141..5146）+ Pi Skill 同步

| 任务 | 状态 | 主交付 | 聚焦测试 | Pi operator Skill impact |
| --- | --- | --- | --- | --- |
| WMB-5141 | done | `.ai/wmb-5141-evidence.md`, `tests/wmb-5141-job-boundary.test.mjs`（13/13） | 13/13 | no change — spawn 合同写 context_refs_json 为系统侧契约，`wmb_*` 工具面不变 |
| WMB-5142 | done | `.ai/wmb-5142-evidence.md`, `tests/wmb-5142-instance-projection.test.mjs`（15/15） | 15/15 | no change — 投影/终态为运行层语义，工具名/参数/序列/读回不变 |
| WMB-5143 | done | `.ai/wmb-5143-evidence.md`, `tests/wmb-5143-agents-instance-view.test.mjs`（22/22） | 22/22 | no change — 纯 renderer 投影 UI；多实例感知由 5144 单独登记 |
| WMB-5144 | done | `.ai/wmb-5144-evidence.md`, `tests/pi-operator-skill.test.mjs` | 32/32 + UI 23/23 | **updated** — 多实例感知提示词按 `docs/pi-operation-skill-maintenance.md` 规程登记（canonical + 3 mirrors 同步） |
| WMB-5145 | done | 本文件 + `tests/wmb-5145-crew-multi-instance-acceptance.test.mjs` + `tests/wmb-5145-compatibility-invariants.mjs` | 14/14（A1..A14） | verifies — 复核 5144 登记与维护规程一致，逐任务注明（5141..5143/5146 no change、5144 updated） |
| WMB-5146 | done | `.ai/wmb-5146-evidence.md`（视觉整改 + line-cap 拆分收口） | 58/58（含 5145 验收面） | no change — 纯 renderer 布局/样式 |

当前 TASKS.md Active：**WMB-5150 (doing, Owner topic-maintenance)** —— 唯一 doing 按 owner 规则保留；5145 已翻 done，见 §7。

## 1. A1..A14 逐项验收矩阵

套件：`tests/wmb-5145-crew-multi-instance-acceptance.test.mjs`（669 物理 / 654 Get-Content 行，cap 654 精确匹配，14 条 test）；A14 断言抽至 `tests/wmb-5145-compatibility-invariants.mjs`（231 物理 / 213 GC 行，无 cap）。复用真实 main 模块（dispatcher/spawner/pool/db/投影/roster/task-grants/job-object-boundary）与真实 UI 逻辑（`src/renderer/agents-instance-logic.ts`）；负断言（A9 跨对象写、A10 红线不可达）真实执行。结果 = **当前复跑（2026-08-10 06:0x）`node --test --test-concurrency=1 tests/wmb-5145-crew-multi-instance-acceptance.test.mjs`**。

| # | 场景（设计 §14） | 测试（行号） | 当前结果 | 捕获结果 | 证据/实现落点 |
| --- | --- | --- | --- | --- | --- |
| A1 | 同角色多实例显式可见 | `:154` 两记者并行 running，进度独立，roster/UI 双面可见 | PASS (735.9ms) | PASS | `src/main/job-pool.ts`（共享容量）；`src/renderer/agents-instance-logic.ts` `sortInstancesForDisplay`/`STATUS_WORD`；打包实机记者 #1 卡（§4） |
| A2 | 实例按任务创建 | `:211` 空态零实例卡 + 五角色分组；spawn 后实例卡出现 | PASS (501.1ms) | PASS | `src/renderer/agents-roster-*.tsx` 三区结构；`agents-instance-logic.ts` `activeRoleSections` |
| A3 | 终态退出活动视图 | `:250` 三终态退出 + 历史可指认；needs_user 停留至关闭 | PASS (857.9ms) | PASS | `src/main/crew-instance-projection.ts`（终态顺序 agent_task → grant 回收 → lease/锁 → pool） |
| A4 | 不预设空槽 | `:307` 全空态无待命/占位坐席文案，摘要 0，无虚构待命态 | PASS (631.4ms) | PASS | 打包实机空态截图（§4：五角色「当前无任务」+ 摘要 0/0/0，无 seat/slot 文案） |
| A5 | 并发 = 系统容量 | `:327` 3 张跨角色单 → 2 running + 1 queued，释放后 FIFO 晋升；maxWorkers=0 拒收 | PASS (526.2ms) | PASS | `src/main/job-pool.ts`（bounded maxWorkers/FIFO） |
| A6 | 并发 ≠ 角色配额 | `:359` 两记者占满容量；调 maxWorkers=4 第三记者单直接运行 | PASS (524.4ms) | PASS | 零角色/注册表改动即扩容（registry 零触碰，G1 为证） |
| A7 | 桌助非主管工位 | `:382` spawn 拒绝、不进员工投影、零 standing 写权、工具只读/编排 | PASS (594.9ms) | PASS | `src/shared/agent-capabilities.ts` `ROLE_CATALOG`/`roleWriteCommands`；`role-roster.ts` desk 分支 |
| A8 | 实例权限交集 | `:410` 写手只读借阅无组织命令；资料员无 plans.save/content.*/reviews.save；越界拦截 | PASS (571.0ms) | PASS | grant ∩ 角色能力 ∩ 边界（`task-grants.ts` `assertTaskGrantForEnvelope`） |
| A9 | 资源边界（对象级硬隔离） | `:464` 跨项目写 BLOCKED + 审计 + 零业务写；同项目第二单 waiting_resource 晋升 | PASS (744.3ms) | PASS | `src/main/job-object-boundary.ts`（签发门 assertJobBoundaryComplete + 执行门 assertBoundaryCovers，双门 fail-closed；复审实测接线成立） |
| A10 | 红线不变 | `:505` 红线命令冻结且只属 agentGrantable:false；有效 grant + 匹配边界仍被 fail-closed 红线门拦死 | PASS (550.7ms) | PASS | `agent-capabilities.ts` `REDLINE_COMMANDS`；A10 断言接受 fail-closed 代码集 {`TASK_SCOPE_BROADENED`, `EXECUTION_GRANT_REQUIRED`}——拦截层前移不削弱红线（§5） |
| A11 | needs_user 数据流 | `:541` code + 部分读回呈报；零资源；不自动重试；关闭退出活动视图 | PASS (587.1ms) | PASS | 打包实机 CHANNELS_NOT_CONFIGURED 真实 needs_user（§4）；`agents-instance-logic.ts` `statusWord` |
| A12 | 取消 ≤5s | `:582` running 取消总门 ≤5s，任务/池双 cancelled，lease 归零；重复取消幂等 | PASS (525.9ms) | PASS | `src/main/job-control.ts`/`task-grants.ts` revoke 路径 |
| A13 | 历史可重建与一键续派 | `:616` 重启（池清空）后从 context_refs_json 指认并重建原请求，一键续派可再次 spawn | PASS (718.1ms) | PASS | `src/main/generic-employee-runner.ts` `writeJobContractRefs`；`job-spawner.ts` jobRequests 终态清理/泊车保留 |
| A14 | 兼容零改动 | `:669`（helper `tests/wmb-5145-compatibility-invariants.mjs`）schema 零改动、五角色固定、核心能力零漂移、新增能力不扰动交集/红线 | PASS (570.0ms) | PASS（捕获为旧版断言；当前为硬化版） | 三表 PRAGMA 冻结 + 11 项核心能力子集零漂移 + 红线三能力 exact 快照 + 页透传/写读面 pinned ⊆ live（§5） |

EVAL-030 门禁句逐项：同角色多实例显式可见 = A1；空态「当前无任务」无空座 = A2/A4 + 实机；needs_user 停留不占 slot/lease/grant/锁、不自动重试 = A11 + 实机；重启后从 context_refs_json 续派 = A13；跨对象写 BLOCKED + 审计 = A9；红线命令不可达 = A10；check:capabilities 绿 = G1（§2）。

## 2. 主 Full check（捕获 04:40–04:52，WMB-5150 未落盘）与当前复跑

**捕获（主 Agent Full check，2026-08-10 04:28–04:52）**：
- harness（check.ps1：required harness files / policy indexes / port anchor / placeholders / 500-line / ledger）**PASS**
- intake（`scripts/check-intake.mjs`）**PASS**
- capability（`npm run check:capabilities`，G1）**PASS**
- typecheck（`npx tsc --noEmit`）**PASS**（0 错误）
- 全量 `npm test` **665/665 PASS**（捕获时刻稳定树；FinalReview 复核确认"记录的 58/58、665/665 在捕获时刻真实有效"）
- build：首次 `npm run build` **FAIL** —— wmb-dev 锁 `.r` **EPERM**（运行中的 wmb-dev 实例持有 `resources/.r` 打包 Pi runtime 文件句柄，`prepare-pi-runtime.mjs` 重建被 Windows 拒）；停止 wmb-dev（`.ai/kill-wmb-dev.mjs`）后重跑 **SUCCESS** → 产物 04:52（Squirrel 哈希见 §3）

**当前复跑（本证据落盘 06:0x，WMB-5150 改动在场）**：
- `node --test --test-concurrency=1 tests/wmb-5145-crew-multi-instance-acceptance.test.mjs`：**14/14 PASS**（§1 矩阵，EXIT=0）
- `npx tsc --noEmit`：**PASS**（EXIT=0）
- `npm run check:capabilities`（G1）：**PASS** —— internal commands 23、grantable covered 18、roles 5（desk/reporter/planner/writer/librarian）；当前 registry 含 5150 只增命令（`knowledge.topic_maintenance_propose`/`cap.topic_approval`），G1 仍绿
- `scripts/check.ps1`：**FAIL** @500-line 门 —— `src/main/role-job-registry.ts` 500 行 < 注册 cap 502（另一违约 `src/main/mcp.ts` 451 > cap 442）；两文件 mtime 05:49–05:50 均为 **WMB-5150 并发改动**（topic-maintenance 工具），非本批次责任（复审 mtime/diff 核实）
- 组合聚焦批次（复审复跑 05:5x）：5141 13 + 5142 14 + 5143 18 + conflict 11 + 5145 14 + helper 文件加载 1 = **71/71 PASS**
- 本轮审计复核（2026-08-10）：current focused 组合 **78/78 PASS**；check-ledger 8/8、check-intake PASS；§3 打包产物哈希复验与证据一致
- 全量 `npm test`：**当前树 670/670 PASS**（本轮审计复核 2026-08-10 实跑，EXIT=0；早前 05:16 观察到的瞬时 `ERR_MODULE_NOT_FOUND` 为 5150 中编辑窗口 late-migrations.ts 原子替换中间态，5150 稳定后未再复现）

## 3. Build 产物与 Squirrel 哈希（捕获 04:52，`J:\wmb-out\make\squirrel.windows\x64\`）

| 产物 | 大小 | SHA-256 | 匹配合同 |
| --- | --- | --- | --- |
| `WeMediaBuddy Setup.exe` | 193,148,928 B | `3d3fb868d71033125c0c034507051507afda028587183c9a5cbc9fb0cef0cfa6` | 3d3f…fa6 ✔ |
| `WeMediaBuddy-0.2.1-full.nupkg` | 197,693,784 B | `92b51988b1fc797858ba71b887cb087d8c76b08b9c0ccb59f791e92504efe05a` | 92b5…05a ✔ |
| `RELEASES` | 83 B | `97bbf593c67ece69452be70f76cd9296b9a3b101237107a8eefa83169b256775` | 记录 |

版本 0.2.1（package.json）；打包应用 `J:\wmb-out\WeMediaBuddy-win32-x64\` 含 `app.asar`（3.8MB）、`resources/.r`（bundled Pi runtime，含 `.package-lock.sha256`）、skills/extensions —— 与 5138-5140 打包契约一致。

## 4. 打包实机（捕获 04:53–04:57，隔离 data root，真实 Electron CDP）

- **packaged CDP**：attach 打包渲染进程（CDP over remote-debugging）；页面 URL 为 `file://…app.asar…`（打包 app 加载 asar 内 renderer），title = **WeMediaBuddy**，document root 在位；隔离 user-data root 冷启动走**首次 onboarding**（未触碰真实 data root，未触发任何真实平台发布/互动）
- **截图（同波打包运行，路径 + SHA-256）**：
  - 空态 `.ai/wmb-5145-packaged-agents-empty.webp`（04:56:26，13,906 B）SHA-256 `db890ef9056fbbed6f02c3f3eef3645fc9f8c23d1585434412fbe986dcce18c7`：页头摘要 `工作中 0 · 排队 0 · 等你批 0 · 容量 2`；五角色概览全部「当前无任务」+ 桌助「协调入口」行；无待命/占位坐席文案
  - needs_user `.ai/wmb-5145-packaged-agents-needs-user.webp`（04:56:50，17,506 B）SHA-256 `7623558f4359bc348280a161f8d891e2fdeb30cd32768a9584e378a307e0b827`：见下
- **empty metrics**：主区 `clientWidth == scrollWidth == 972`、body 宽 1600（1600 窗口下无横向溢出；与 5146 三视口无溢出结论一致）
- **needs_user 真实动作**：实机派单「执行一次例行检查并回报」→ 真实 `daily_scan` 预检 **CHANNELS_NOT_CONFIGURED**（隔离 root 零启用渠道，唯一真实配置阻断）→ 落为**真实 needs_user 实例卡**：`记者 #1`、code `CHANNELS_NOT_CONFIGURED`、`入队 04:56:49 · 停留 0s`、动作 `等你批 | 复制 JobId | 续派 | 关闭`；页头 `等你批 1`；记者概览行 `等你批 · 查看实例 1`；其余角色「当前无任务」—— 非伪造 blocker、不自动重试、停留不占 slot/lease/grant/锁（A11 实机对证）

## 5. A14 硬化与 helper 拆分（05:0x–05:5x，本波收口）

- **HardenWmb5145A14**：A14 由「git diff 整树 + 全名单 deepEqual」重构为**行为/不变量断言**——三表 schema PRAGMA 冻结、五角色固定、11 项核心能力子集（pinned ⊆ live 只增）+ 标量属性零漂移、红线三能力 exact 快照、页透传/批内 intent/基建 grant 面冻结；删除调试杂物 `tests/_probe-5145d.mjs` 与根目录 `%TEMP%doingrows.txt`；**4 类突变验证**（角色/核心能力/红线/schema 各注入漂移 → A14 翻红，还原后字节一致）
- **SplitWmb5145A14Helper**：pins/断言抽至 `tests/wmb-5145-compatibility-invariants.mjs`（231 物理 / 213 GC 行，无 cap）；suite 收敛 669 物理 / 654 GC，`scripts/line-caps.json` 5145 条目棘轮至 **654**（纠正会话中出现的 803 抬升）；**A10 适配** fail-closed 代码集 {`TASK_SCOPE_BROADENED`, `EXECUTION_GRANT_REQUIRED`}（task-grants.ts 新增 `isAgentGrantableCommand` 前移拦截，红线语义不削弱；保留 success=false、零业务写、审计/错误消息非空）；helper 自身 2 类突变检测（`cap.collect.owner` 标量零漂移、角色写面子集）均翻红后还原
- **基线锚定**：`cap.library_organize` 不含 5150 新增命令、`cap.topic_approval` 排除于批内锚点；与 5150 并发改动共存 **14/14 PASS**；对合法能力追加稳定（只增语义），仍能抓角色/红线/schema/本批次能力漂移
- 行数门：suite 669 物理 / 654 GC = cap 654 精确；helper 231 物理 ≤500 无 cap；check.ps1 500 行门对本批次文件全绿（当前 check.ps1 红点仅为 5150 两个 wave 文件，§2）

## 6. 独立复审（FinalReviewWmb5145，只读，history://FinalReviewWmb5145）

历程：**changes_requested（confidence 0.78）** → P1/P2/P3 提出 → 主关闭 P2/P3（A14 硬化 + 杂物删除）→ 复审复验发现新 P2（suite 803 GC > cap 669）→ Split 拆分 + 棘轮 654 → 复审复验 cap 精确、15/15（14 A 测试 + helper 文件加载）、组合 71/71 → **最终：实现验收 APPROVED（overall_correctness: correct，confidence 0.85）**。

- 已复核成立（关闭总目标）：A1..A14 逐项实测（真实模块、负断言真实执行）；5141 13/13、5142+5143+conflict 44/44；对象级硬隔离双门接线（签发门 `assertJobBoundaryComplete` + 执行门 `assertBoundaryCovers`，workspace-runtime.ts:125-128 挂接）fail-closed 完整；jobRequests 终态清理与 A14 PRAGMA 冻结成立；注册表/权限本批次零触碰（当前 registry diff 全为 5150 内容）；Squirrel 产物 + 两张打包截图在位；首次 build EPERM 锁失败确认为 wmb-dev 占锁、重跑成功属实；5141-5144 四行 done 回执四要素齐全
- P2/P3 关闭确认：A14 不再依赖整树 git/全名单；CORE 快照已剔除 5150 新增（基线纯正）；两杂物已删；A10 fail-closed 集合断言合理
- 非阻断风险（入账前知悉）：① `mcp.ts`/`role-job-registry.ts` cap 违约为 **WMB-5150 并发改动**，check.ps1 500 行门在 5150 收口前保持红，建议 5150 落账时同步处理；② 证据包落盘（本文件）+ TASKS 5145 行 done 翻转 = 纯流程收尾（P1）

## 7. WMB-5150 并发影响与 done 收口（不虚假 claim 全量绿）

- **并发事实**：5150（topic-maintenance，Owner 独立）于 04:58–05:50 落地：registry **updated**（`cap.topic_approval` Owner-only + `knowledge.topic_maintenance_propose` + topic_maintenance_* 命令）、`page-authority.ts`、`late-migrations.ts` v51、`src/main/mcp.ts`/`role-job-registry.ts`、`tests/wmb-5150-topic-maintenance.test.mjs`、`.ai/evals/EVAL-CAP-003.md` 追加 5150 段（28m 前更新）。5145 捕获（04:28–04:52）在其之前，故捕获的 665/665 与 check.ps1 绿为**捕获时刻真实状态**
- **本批次立场**：A14 已设计为与 5150 共存（pinned ⊆ live、基线排除 5150 新增）；本轮审计（2026-08-10）确认当前树全量 `npm test` **670/670 PASS**、focused 组合 78/78、typecheck、G1（23/18）、check-ledger 8/8、check-intake 全绿；唯一保留的外部红点 = check.ps1 500 行门（`role-job-registry.ts`/`mcp.ts` 两文件，均属 5150 并发改动，所有权不转移，随 5150 收口处理）；打包产物哈希与 §3 一致，无需重建；5145 自身验收证据完整（A1..A14 14/14、组合 71/71、捕获 665/665），TASKS 行已翻 done（回执见下）
- **当前门状态（06:1x 收口）**：TASKS 5145 done ✔（check-ledger 8/8、check-intake PASS、唯一 doing 按 owner 规则保留 WMB-5150 topic-maintenance）｜5145 聚焦 14/14（helper 计入 15/15）✔｜typecheck ✔｜G1 ✔｜check.ps1 ✖ —— 红点**仅为** 5150 两文件（`role-job-registry.ts` 500<cap 502 需棘轮、`mcp.ts` 451>cap 442），非 5145 验收缺陷，所有权不转移｜npm test 全量 **670/670 ✔**（本轮审计 2026-08-10 当前树实跑）
- **剩余收口**：① TASKS.md WMB-5145 行已翻 done，四回执齐全：证据路径 = 本文件 + 两个 test 文件（均在库）；`Pi operator Skill impact: no change — verifies 复核 5144 updated 登记与规程一致`（no change 为回执枚举值，verifies 语义并入描述）；`Independent review: FinalReviewWmb5145 — 实现验收 approved（correct, 0.85）`；cell 604 ≤ 700 字符。WMB-5150 行及其文件零触碰；check.ps1 红点（5150 两文件 line-cap）随 5150 收口，非本批次剩余项

## Impact

- **Capability registry**：no change —— 本批次（5141..5146）`agent-capabilities.ts`/`page-authority.ts` 零触碰；当前工作区 registry diff 全部为 5150 内容；G1 当前 PASS（23 internal / 18 grantable / 5 roles）
- **Pi operator Skill**：verifies —— 复核 5144 updated 登记与 `docs/pi-operation-skill-maintenance.md` 规程一致；5141/5142/5143/5146 no change
- **三表 schema**：零改动（A14 PRAGMA 冻结 + FinalReview 复核；5150 v51 迁移为并发方内容）
- **已知边界**：打包实机截图为 empty/needs_user 两态（同波打包运行）；check.ps1 Get-Content codepage 936 低估 CJK 行数为 5146 已记录的预存 P3 infra（本次 patch 文件双口径均合规）；`mcp.ts`/`role-job-registry.ts` cap 违约属 5150，随其收口处理
