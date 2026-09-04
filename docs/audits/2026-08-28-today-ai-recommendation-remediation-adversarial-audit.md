# Today「AI 主推荐主席台」整改方案 v2 对抗性审计

日期：2026-08-28  
审计对象：[整改方案 v2](../spark/2026-08-28-today-ai-recommendation-remediation-plan.md) 及其引用的当前实现  
独立审计原始结论：**not ready for implementation**

> 主 Agent 裁决（2026-08-28）：本文件保留独立审计原文。F-01、F-02、F-05、F-06 引用了审计对象原始草案中并不存在、由审计过程自行扩写的 `dispatch_pending`、`projectionRevision` 和批量 repair 合同，不能作为对原始方案的事实性否决。F-03、F-04、F-07、F-08 有当前代码证据，已回填整改 Plan。F-01 暴露的真实事务风险通过“批准与进程内 Agent 派工解耦”处理，而不是在本整改新增持久派工系统。最终实施权威以整改 Plan 最新内容为准。

## 1. 审计范围与方法

这是对方案“是否正确、是否能经受现实失败”的独立审计，不是代码验收。审计过程未修改代码、数据库或任务台账，但生成了 v2 Plan 草案和本审计报告；随后由主 Agent 对新增条款逐项裁决。

规模估计：方案约 1,195 个词、10 个以上独立实现单元；风险信号包括 SQLite 事务、IPC/MCP、外部 Worker、跨进程恢复、旧数据修复。因此按 Deep 深度执行五类检查：前提挑战、假设暴露、决策压力测试、简化压力、替代方案盲点。

现场基线：已有旧测试聚焦运行结果为 53/53 通过；这只证明旧合同未回归，不证明本方案新增合同成立。方案新增的 today-recommendation-projection.test.mjs、today-approval-flow.test.mjs、today-data-repair.test.mjs 当前尚未存在。

## 2. 阻断级 Findings

### F-01｜P0｜持久派工意图没有可执行的落点

**证据**

- 方案 §5.2 要求在 BEGIN IMMEDIATE 内“写入确定性 jobId 的派工意图和 command_receipts 回执，状态为 dispatch_pending”；§5.3 又要求提交后由派工泵读取并“写回 dispatch_started/queued 或 dispatch_failed”。
- 当前 src/main/command-dispatcher.ts:102-124 的顺序是：开始事务 → 执行 handler → 由 Dispatcher 创建并插入回执 → 提交；异常则回滚并另写 not_started 错误回执。当前没有 dispatch_pending 意图的结构、读取器、更新器或恢复入口。
- 当前 JobSpawner/JobPool 的 job、handle、request 都是进程内 Map/数组；没有持久队列可在进程重启后恢复。

**反例**

批准事务提交成功后，进程在 spawn() 前退出。重启后数据库只有一个普通 plan_item.approve 回执；方案没有定义如何从其中还原 Reporter/Writer 的完整 RoleJobRequest、如何保证两种角色不重复派发，也没有定义如何原子更新回执 JSON 与 side_effect_state。即使把 dispatch_pending 塞进 data，仍缺少派工泵协议和启动接线。

**影响**

方案无法同时兑现“无 schema”“提交后派工”“跨崩溃恢复”“不伪造 Worker 成功”四项要求。若直接开始实现，最可能再次把外部 spawn 放回事务，或把普通审批成功误报成派工成功。

**需要回填**

在实现前冻结一种真实持久模型：例如使用现有 command_receipts 作为不可变 intent log（明确 data 中的完整角色请求、确定性 jobId、状态转换命令、重试/租约/幂等规则和启动 reconcile），或使用现有 agent_tasks 作为 durable queue。必须给出进程退出点实验和成功/失败回执的精确 schema；不能只写状态字符串。

置信度：100。当前 Dispatcher 的事务顺序和缺失的持久派工协议可以直接由代码读回确认。

### F-02｜P0｜projectionRevision 只有名字，没有防旧卡批准的算法

**证据**

- 方案 §3.2、§4、§5.1、§8.2 要求传递并校验 projectionRevision/runGeneration。
- 方案没有定义 revision 的输入集合、序列化方式、是否包含 businessDate/asOf、候选 ID/分数/生命周期、运行任务版本，或服务端在什么事务内重算。
- 当前 src/main/ipc-today-studio-business.ts:621-648 的批准路径只校验 planItemId + expectedRevision，当前 preload/global 类型也没有 projectionRevision 字段。

**反例**

用户打开 A 为主推荐；随后 B 评分完成且变成新的第一名，或新一轮运行替换了候选集合。旧页面仍发出 A 的 expectedRevision，只要 A 本身 revision 没变，当前实现即可批准 A。方案的字段名并不能阻止该动作。

**影响**

主卡可能批准的不是用户看到的当前 AI 主推荐；运行中旧卡保护和“批准顺序”验收都无法证伪。

**需要回填**

定义规范化 Projection fingerprint：至少包含 businessDate、asOf 规则、runGeneration、primary/eligible 的 planItemId、revision、score、planDate、carry/project 状态，定义稳定排序和 hash；批准事务内按同一快照重算并在不相等时返回 PROJECTION_STALE。补一个“改变 B 后旧 A 仍点批准”的负例。

置信度：75。缺口已由当前代码确认，具体 hash 形式仍需实现前冻结。

### F-03｜P1｜“唯一批准入口”没有覆盖现存 advance 绕行面

**证据**

- 方案 §5.1 只禁止“推荐批准路径”直接调用 createProjectFromPlanItem，并要求 UI/MCP 使用唯一批准函数。
- 当前 src/renderer/today-view.tsx:389-393 的 carry plan_item 分支仍直接调用 createProjectFromPlanItem；src/preload/preload.ts:505 仍暴露 today:create-project，其 IPC 在 src/main/ipc-today-studio-business.ts:258-264 调用 plan_item.advance。
- 当前 src/main/daily-content-article.ts:406-416 的 advanceApprovedPlanItem 仍把项目推进与外部派工绑在一起。

**反例**

主卡路径修好后，用户从 carry 或旧页面触发另一个入口；该入口绕过 projectionRevision、唯一业务函数和新的提交后派工泵，仍执行旧 advance。系统再次出现同一 plan item 多路径、不同回执和旧事务边界。

**影响**

主推荐页面的局部修复不能证明业务闭环已统一；重复项目、重复 Worker 或旧行为复活仍可能发生。

**需要回填**

逐一列出 createProjectFromPlanItem、plan_item.advance、advanceApprovedPlanItem 的所有生产调用者。明确：外部入口是拒绝/转发到唯一函数，还是仅保留一个内部幂等 advance；为 carry、Proposal Ledger、Today 主卡和 MCP 各跑一次同合同测试。

置信度：100。当前调用者和 IPC 路径可直接读回。

### F-04｜P1｜“完整方案”仍只是非空字段，不足以阻止换皮的只有标题

**证据**

- 方案 §2.3 将完整方案门定义为字符串 trim 后非空、数组非空。
- 方案 §8.1 只测试缺字段，不测试“方向”“待核验”等占位字段或与 source 无关的内容。
- 当前 src/main/planning.ts:96-103 的 saveCurrentPlan 只强制 priority、source 和模板指纹；完整字段校验集中在另一条 planning-stage 路径，说明写入路径确实存在分叉。

**反例**

Planner 发送标题以及 whyNow:“窗口”、angle:“角度”、pointOfView:“观点”、titleGuidance:“标题”、openingGuidance:“开头”、structureGuidance:“结构”。形式上满足 v2 的非空门，仍然没有可执行的选题方案；若评分合法，就能成为 primary。

**影响**

用户看到的“不是只有标题”可能只是多了七个空壳字段，问题从空白变成伪完整。

**需要回填**

二选一并写进成功标准：把目标收窄为“结构完整”，并明确不保证内容质量；或增加可确定验收的最低质量门（字段长度、具体读者场景、期望动作、窗口与错过成本、来源证据引用、标题钩子兑现），并在 plans.save、plan_item.submit、恢复和导入入口共用。不能用“字段存在”代替内容完成度。

置信度：75。字段门的行为可从方案和当前写入路径反推出，语义质量阈值需产品冻结。

### F-05｜P1｜invalid 只有计数，没有可操作对象和恢复通道

**证据**

- 方案 Projection 只有 counts.invalid，没有 invalid 项目列表、原因结构或 repair 命令。
- §4 要求显示“继续修复评分”，§6 要求 dry-run/正式 repair，但 §7 的 preload/global 类型清单没有具体修复桥接，现有 Proposal Ledger tabs 也没有 invalid tab。

**反例**

三个 ready_for_review 记录因 legacy score 或缺 titleGuidance 被归为 invalid。Today 显示一个数字，但用户无法知道是哪三条、为什么、怎样按 frozen revision 重试；自动修复失败后只能反复显示数字。

**影响**

“不进主推荐”虽然成立，但“可恢复、不死锁、用户有下一步”不成立；无声丢失会继续被误认为 AI 没有选题。

**需要回填**

定义 invalidItems[] 或明确把 invalid 纳入带原因的“待修复”台账；规定 item ID、原因码、revision、dry-run/repair bridge、失败后的终态和计数口径。增加真实点击/命令读回测试。

置信度：75。

### F-06｜P1｜旧数据修复的“幂等”没有判定条件

**证据**

- 方案 §6 说 repair 可重复执行、追加 provenance，并对 approved 降为 draft、ready_for_review 降为 draft。
- 没有定义 repair marker、批次 requestId、revision 条件、已修复行的跳过规则或正式 run 的事务边界。

**反例**

同一安装态重启后再次运行 repair：同一条 approved legacy 记录再次尝试降级、revision 再增、provenance 再追加；或者第一轮只写了一半，第二轮无法区分已完成与待完成，导致评分恢复重复提交。

**影响**

数据修复不可审计、不可安全重试，可能把用户已批准但未建项目的条目反复改写。

**需要回填**

定义无需新表的幂等标记（例如 provenance 中稳定的 repair version/reason）、每行 expectedRevision、dry-run 与正式写入的原子边界、失败重跑规则和逐项 readback。为“全成功、半失败、再次执行”各建 fixture。

置信度：75。

### F-07｜P1｜“同一时间锚点”无法跨独立 IPC 调用自然成立

**证据**

- 方案 §3.4 要求 Today、Ledger、Pool、metrics 共享同一 businessDate + asOf。
- 当前 src/renderer/global.d.ts:391-486 和 preload 分别暴露 getToday(planDate)、getTodayOverviewMetrics(planDate)；Proposal Ledger 另有独立读取入口。当前 getToday() 内部还自行以当日结束时间构造 Pool 时间，而 metrics/ledger 可用不同 new Date()。

**反例**

在某条热点的 expiry 瞬间，Today 调用先拿到未过期，metrics/ledger 随后拿到已过期；两个页面同时出现 primary 与 0 条待批准。

**影响**

即使每个函数内部使用同一个 asOf，跨调用仍会漂移；“数字完全一致”验收无法由当前 API 形状保证。

**需要回填**

选择并写死一种边界：让 getToday 返回 metrics/ledger summary 的同一快照；或由 renderer 首次取 snapshotId/asOf 并把它传给所有读接口；或把所有读放在一个后端 projection command。增加 expiry 临界点的串行 IPC 测试。

置信度：75。

### F-08｜P1｜静态高分压过今日低分的决策缺少现实反证门

**证据**

- 方案 §3.4 明确“跨日高分允许压过今日低分”，并把 score 定义为持久传播价值。
- 方案只用 timeliness expiry 排除旧条目，没有 freshness decay、来源证据新鲜度或最低可信度门。

**反例**

昨天的长期候选 score=92、仍未过期；今天刚发生但证据尚未充分的候选 score=70。系统必然推荐昨天的 92，即使用户的“现在”意图更偏向今日窗口。

**影响**

投影可以完全确定、所有结构测试全绿，但主席台回答的仍可能不是用户真正此刻应做的题。

**需要回填**

用真实历史样本冻结“持久价值优先”的产品判据，或改为显式 freshness/窗口分层排序；至少加入高分旧候选与今日窗口候选的验收 fixture。不能把“目前选择了这个排序”当作“选择正确”的证据。

置信度：75。

### F-09｜P1｜确定性投影不等于正确推荐，成功标准缺少独立质量证据

**证据**

- 方案 §1.3 的成功条件主要是字段完整、状态合法、计数一致、批准递补和安装态读回。
- 评分校验验证的是六项结构、边界和总分，不验证来源事实是否真实、评分理由是否支持分数，方案又明确不改情报抓取和评分权重。

**反例**

一个事实错误但格式完整的 Planner 输出获得合法 score=95；它成为 primary。所有 v2 结构测试、Projection 测试和批准闭环都通过，用户仍被引导做错误选题。

**影响**

本整改能修复“混乱/空白/绕过批准”，但不能证明“AI 最推荐”本身变对；方案目标与验收证据存在错位。

**需要回填**

明确这是“推荐投影一致性整改”而非“推荐质量整改”；若仍要声称解决 AI 推荐质量，增加独立来源证据和人工标注的 golden set，不能只用数据库 fixture。

置信度：75。

## 3. 其他重要观察

### O-01｜简化压力：仍保留两个可能分叉的候选表示

方案一方面要求 Recommendation Projection 成为 SSOT，另一方面仍保留 getToday().pool、eligible[]、Proposal Ledger 的独立分页构建和 today-pool-view 适配。若 pool 仍被旧组件消费，SSOT 只是新增一层而不是收敛。实现前应明确 pool 是 Projection 的只读别名、完全删除，还是只允许用于非业务展示，并加静态调用者检查。

### O-02｜规模假设未量化

方案取消资格前的 200/2000 截断是正确性修复，但同步读取全量条目后还会逐条解析 JSON、查询项目/carry、计算趋势。201 条 fixture 只验证“没有截断”，没有验证 10x/100x 的耗时、内存或 Electron 主线程可用性。需要一个可接受的候选规模和测量门；否则“全量”可能把一致性问题换成页面超时。

### O-03｜空状态枚举缺少组合态算法

emptyReason 有 run_active/scoring_active/scoring_incomplete/invalid_needs_repair/clean_empty/not_started，§4 有优先级，但没有规定当运行中同时存在 pending、invalid 和旧 primary 时由哪个后端字段胜出，也没有规定 primary=null 且 eligible=[] 时是 clean_empty 还是 invalid_needs_repair。应把优先级写成纯函数并做组合 fixture。

## 4. 五类审计结论

### 4.1 前提挑战

“一个确定性 primary 能回答 AI 现在最推荐做什么”只在上游评分/证据正确、且旧高分的时间语义正确时成立。当前方案证明了状态一致性，却没有证明推荐质量或低置信度时应当空置主席台；F-08、F-09 使产品目标至少需要收窄或增加独立质量门。

### 4.2 技术假设

方案依赖：既有回执可充当 durable outbox、外部派工可在提交后安全重试、跨 IPC 可共享单一 asOf、无 schema 仍能记录完整 dispatch 状态、全量读取在目标规模内不会阻塞。这些条件目前都没有现场证据，F-01、F-06、F-07、O-02 需要在实现前验证。

### 4.3 关键决策压力测试

| 决策 | 反证条件 | 反转代价 | 当前判定 |
|---|---|---:|---|
| receipt 充当派工意图 | 重启后不能还原完整 RoleJobRequest 或状态不能原子更新 | 高 | P0，未冻结 |
| primary 使用 projectionRevision | 旧卡可在候选排序变化后批准 | 中高 | P0，算法未冻结 |
| 跨日总分优先 | 历史高分在用户急需今日窗口时持续抢占 | 中 | P1，需样本 |
| 不改 schema | 现有表无法表达 pending intent/retry/readback | 高 | P0，需比较替代实现 |
| source overlap 不排除不同题 | 同源不同题产生重复生产 | 中 | 需要真实样本与产品判据 |

### 4.4 简化压力

最小可行版本应先证明一个纯 Projection：完整候选、唯一分类器、排序/去重、计数一致；随后再接批准闭环和 durable dispatch。当前方案把旧数据修复、全量投影、Renderer、事务拆分、恢复泵和安装验收同时冻结，若 F-01 的持久模型尚未选定，批次 D 会成为无法客观验收的“大改”。

### 4.5 替代方案盲点

方案没有比较三种派工架构：

1. 复用 command_receipts 作为不可变 intent log + 独立 dispatch 状态命令；
2. 复用现有 agent_tasks 作为持久队列，JobSpawner 只做内存执行器；
3. 新增 outbox 表/迁移，换取最清晰的状态机。

方案直接选择“无 schema + receipts”，但没有证明它在崩溃、重试、receipt replay 和审计不可变性上优于前两者。至少要在设计里记录排除理由和最小崩溃实验。

## 5. 结论与放行条件

当前结论：**not ready for implementation**。不是因为旧测试失败，而是因为 F-01/F-02 使核心批准—派工—恢复合同仍不可执行，F-03/F-04/F-05/F-06/F-07 使绕行、空壳方案、不可恢复数据和计数漂移仍有现实路径。

放行前至少要回填并复审：

1. durable dispatch intent 的具体载荷、状态机、重试/崩溃恢复和 ok/sideEffectState 语义；
2. projection fingerprint/generation 的服务端重算与 stale 拒绝；
3. 全部 advance/create 调用者的收敛和 carry 入口合同；
4. 方案完整度的质量边界及 invalid item 的可操作修复面；
5. repair 幂等规则与跨 IPC 的统一快照时间锚点；
6. 跨日排序和“推荐质量是否在本方案范围内”的产品决定。

在这些合同未补齐前，不得创建实施 Goal、删除失败测试、打包发布或宣布整改完成。
