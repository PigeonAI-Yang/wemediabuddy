# Today「AI 主推荐主席台」整改方案

状态：整改合同已冻结，可进入“先写失败测试”的实施阶段；独立审计原始结论及主 Agent 裁决见 [审计报告](../audits/2026-08-28-today-ai-recommendation-remediation-adversarial-audit.md)  
版本：v2 · 2026-08-28  
性质：实施合同与验收合同，不是完成回执

## 1. 范围、现场事实与目标

### 1.1 范围

本方案覆盖 Today 首页主推荐、选题台账分类、评分资格、旧数据可恢复投影、批准后建项目与递补、Today Renderer、指标和安装态验收。

不改情报渠道抓取质量、六维评分权重、品牌 Token、发布流程、Reporter/Writer 持久派工架构或无关 Studio 功能；不新增数据库表或迁移，不批量改写旧数据。

### 1.2 已确认的根因

当前并不存在一个单一的主推荐真源：

| 断点 | 当前事实 | 直接后果 |
|---|---|---|
| 主卡入口 | `src/renderer/today-view.tsx` 的 `create()` 直接调用 `createProjectFromPlanItem` | 用户批准动作没有先完成 `plan_item.approve`，批准和跳转脱节 |
| 批准实现 | UI IPC 与 MCP 各自复制批准、carry、advance 逻辑，并吞掉部分异常 | 两条入口可能得到不同状态，失败仍可能返回成功 |
| 外部派工 | `advanceApprovedPlanItem()` 在数据库事务内调用 `JobSpawner.spawn()` | SQLite 回滚不能回滚已启动的 Worker，形成半完成状态 |
| 方案资格 | `plans.save` 可在缺少 `titleGuidance`、`whyNow`、角度、观点、结构等内容时写入 `ready_for_review` | “只有标题”的方案进入可推荐集合 |
| 评分口径 | `planning.ts`、`planning-stage.ts`、`agent-runner.ts`、shared validator 和 Renderer Ledger 不完全同源，仍接受 legacy 别名 | 同一条数据在不同入口的状态可能不同 |
| 旧数据 | v77 后存在 `approved + 无有效评分`；恢复逻辑只扫 `draft/rejected` | 旧条目既不能推荐，也不能恢复评分 |
| 投影边界 | 未来日期未排除；Pool 预截断 200 条；Ledger 与 Pool 使用不同上限/时间锚点 | “全候选最高分”及数字一致性不成立 |
| 生命周期 | 空结果会保留旧 `latestPlan`；批准链没有稳定完成 carry | 新一轮空结果可能复活旧主卡，批准后原条目仍留在开放集合 |

### 1.3 目标

Today 首页唯一回答：

> AI 现在最推荐我做哪个选题，为什么？

完成后必须满足：

1. 只有完整方案、规范六维评分、开放生命周期和有效时效的条目能成为唯一 `primary`。
2. 顶部数字、台账分类、主卡、空状态和指标都来自同一个 Recommendation Projection。
3. 用户点击批准后，先执行批准命令，再读回项目；批准成功后原条目退出推荐集合并立即递补下一条。
4. 数据库提交与外部派工边界明确；任何失败都不能伪造“已启动/已完成”。
5. 运行中、评分未完成、非法旧数据、真实空结果和历史数据各有可解释状态，不再产生空白或死锁。

## 2. 冻结的产品语义

### 2.1 状态定义

| 术语 | 唯一含义 | 是否可成为主推荐 |
|---|---|---|
| 待评分 | `draft/rejected` 且评分缺失、pending 或不完整 | 否 |
| 非法待修复 | `ready_for_review` 但完整方案门或规范评分门失败；修复后才可重新送审 | 否 |
| 今日待批准 | 合法 `ready_for_review`，`plan_date = businessDate`，未终结且未过期 | 是 |
| 跨日待批准 | 合法 `ready_for_review`，`plan_date < businessDate`，未终结且未过期 | 是 |
| 已采纳 | 已批准且项目已建立，或对应 carry 已完成 | 否 |
| 已否决 | `rejected` 或 carry 为 `dismissed` | 否 |
| 已过期 | 时效窗口已结束，或 carry 为 `expired` | 否 |
| AI 主推荐 | 全部合法今日/跨日待批准候选经统一排序、去重后的第一条 | 唯一一条 |

`approved`、`draft`、旧 `priority` 和只有标题的记录都不能绕过资格门进入主推荐。`非法待修复`必须有 `invalidCount` 与修复动作/原因，不得被误报为“可批”。

### 2.2 评分分类器

建立一个共享、纯函数、三态分类器，生产和读取路径都使用它：

```ts
type RecommendationQualification = 'eligible' | 'pending' | 'invalid';
```

- `eligible`：状态为 `ready_for_review`、完整方案字段通过、评分为规范六维且总分正确。
- `pending`：状态为 `draft/rejected`，评分尚未完成或仍为 pending；进入“待评分/继续评分”。
- `invalid`：评分结构非法、使用 legacy 别名、`ready_for_review` 缺完整方案字段或数据元信息无法验证；进入“待修复”，绝不能批准。
- `approved` 等终态不参加开放候选分类；其数据健康度由修复报告单独记录。

规范评分必须是唯一六项：
`reader_immediacy_benefit(20)`、`tension_curiosity_gap(20)`、`why_now_window(20)`、`save_share_comment_motive(20)`、`evidence_credibility(15)`、`account_fit(5)`。每项分数在边界内，`score` 等于六项之和且在 0–100；legacy 字段只可被识别为 `invalid`，不得静默映射。

### 2.3 完整方案资格门

以下字段必须存在且去除首尾空白后非空：

`title`、`whyNow`、`timeliness`、`targetAudience`、`angle`、`pointOfView`、`titleGuidance`、`openingGuidance`、`structureGuidance`、`effortEstimate`；`platforms`、`formats`、`sourceIds` 必须为非空数组。`availableMaterials`、`missingMaterials`、`reviewIds`、`methodFindingIds` 若存在必须是数组。

`plans.save`、`plan_item.submit`、评分恢复、任何导入/兼容入口都必须调用同一个完整方案验证器。新写入验证失败只能保持 `draft` 并携带稳定原因，不能写成 `ready_for_review`；`invalid` 是读取投影分类，不新增存储枚举。

非空只是第一层，第二层必须阻止“字段换皮但仍然只有标题”：`whyNow` 要包含触发事件、当前窗口和错过成本；`targetAudience` 要包含具体人群与场景；`angle` 与 `pointOfView` 不得互相复制或仅重复标题；`structureGuidance` 至少包含三个可识别段落/步骤；来源必须能通过 `sourceIds` 读回。已知占位值（如“角度”“观点”“结构”“待补充”）直接判 `invalid`。该门只承诺结构完整，不把机器规则夸大成内容质量证明。

规范评分增加 `scoredAt`。跨日候选距 `scoredAt` 超过 24 小时，或旧评分缺少 `scoredAt`，进入 `score_stale` 并走现有继续评分路径；不允许昨天的静态高分无限期回答“现在最推荐”。

## 3. 唯一工作流与 Recommendation Projection

### 3.1 权威工作流

```text
扫描资料
  → Planner 写入完整候选（draft）
  → 评分器写入规范六维评分
  → 完整方案 + 合法评分 → ready_for_review
  → Recommendation Projection 过滤/排序/去重
  → 用户批准
  → DB 事务提交批准、项目、初始版本和 carry 终态
  → 读回项目
  → 原候选退出推荐集合，重新投影并递补
```

### 3.2 投影契约

后端 `getToday()` 必须一次返回以下事实；字段名可按现有类型约定调整，但语义不可改变：

```ts
type TodayRecommendationProjection = {
  primary: OpportunityPoolItem | null;
  eligible: OpportunityPoolItem[];
  counts: {
    todayReady: number;
    carriedReady: number;
    scoringPending: number;
    invalid: number;
  };
  repairable: Array<{
    planItemId: string;
    revision: number;
    reasonCode: 'score_pending' | 'score_invalid' | 'proposal_incomplete' | 'score_stale';
    reason: string;
  }>;
  context: {
    businessDate: string;
    asOf: string;
  };
  emptyReason:
    | 'has_recommendation'
    | 'run_active'
    | 'scoring_active'
    | 'scoring_incomplete'
    | 'invalid_needs_repair'
    | 'clean_empty'
    | 'not_started';
};
```

主卡、顶部数字、Proposal Ledger、空状态、指标和批准按钮只消费该投影；禁止再分别用 `todayItems.length`、`pool.length`、`Boolean(todayPlan)` 或 `planning_status='approved'` 推断同一事实。

### 3.3 候选筛选

投影对每个候选依次执行：

1. 取每个 `plan_date` 最新的非空方案，但只纳入 `plan_date <= businessDate`；未来方案永不进入 Today。
2. 使用共享分类器和完整方案门；只有 `eligible` 继续。
3. 以精确 `plan_item_id` 项目绑定和对应 carry 状态排除已采纳/终结项。仅共享 source 不得排除另一个不同选题；同故事由显式 story 去重处理。
4. 用同一个 `asOf` 判断爆点/热点时效。`created_at` 或日期不可解析的条目按 `invalid` 处理，不得无限期开放。
5. 查询决策不得在资格过滤和最终排序前使用 200/2000 等不同硬上限；需要分页时只能在完整排序、计数和选出 `primary` 后分页展示。

### 3.4 排序和去重

最终候选排序固定为：

1. 已通过 24 小时评分新鲜度门；
2. `score.total DESC`；
3. `plan_date DESC`；
4. `priority ASC`；
5. `sort_order ASC`；
6. `plan_item_id ASC`。

先按完整排序，再按 `sameStory` 保留每组第一条；不能先按 `priority/createdAt` 选 keeper，否则可能丢掉传播分更高的候选。发布降权只做展示标记，不改变上述主推荐顺序。

跨日高分允许压过今日低分，但必须同时通过原时效窗口和 24 小时评分新鲜度门；本整改不暗改六维权重，而是要求陈旧候选重新评分。

`asOf` 为一次请求入口捕获的真实当前时间，测试注入固定时钟；Today、Ledger、Pool、指标和过期判断必须共享同一 `businessDate + asOf`，不得一个用当日结束时间、另一个用真实墙钟。

## 4. 运行中与空结果状态

状态优先级：

1. 启动/扫描/判断：展示真实阶段，隐藏旧主卡的批准/否决操作。
2. 评分运行中：展示评分进度和当前批次。
3. 评分未完成：展示具体原因和“继续评分”。
4. 存在 `primary`：展示完整主卡、“批准并开始创作”和“否决”。
5. 合格空结果：展示“本轮没有达到推荐标准的选题”。
6. 尚未开始：展示“开始今日情报”。

任何 `primary === null` 状态必须有非空标题、说明和可执行下一步。`showOpportunityEmpty` 不得与文案条件分离；Renderer 使用穷尽式状态联合，不允许布尔组合产生空白。

当前轮没有候选时，`latestPlan` 只能作为历史信息显示，不能回填 `primary`、Pool 或批准按钮。真实零结果不能复活旧主推荐。

运行中隐藏旧主卡的批准/否决动作。对象本身仍使用 `planItemId + expectedRevision` 做乐观并发控制；用户从台账批准任意仍合法的待批准项不受“当前是否仍排第一”限制。

## 5. 批准、项目、carry 与外部派工合同

### 5.1 唯一批准入口

新增/抽取唯一业务函数，例如 `approvePlanItemAndCreateProject()`；Today、Proposal Ledger、carry 和 MCP 的批准入口都只负责权限/Envelope 适配并调用它，禁止复制业务逻辑。

首页主卡动作必须严格执行：

```text
approvePlanItem({ planItemId, expectedRevision })
  → 检查回执 ok 与 projectId
  → 读回 plan_item/project/version/carry/projection
  → projectId 和完整读回成立后 openStudio(projectId)
```

`today-view.tsx` 的推荐批准路径不得再直接调用 `createProjectFromPlanItem`。没有 `projectId`、读回不完整或版本冲突时，停留 Today，显示稳定错误，绝不无条件跳转空 Studio。

### 5.2 DB 事务边界

CommandDispatcher 已提供外层 `BEGIN IMMEDIATE`。批准命令内只做可回滚的本地事实：

1. 校验 `ready_for_review`、完整方案、规范评分、`expectedRevision` 和开放生命周期；
2. 将条目转为 `approved`；
3. 创建/复用唯一 `content_projects.plan_item_id`；
4. 写入非空初始内容版本，至少包含标题、why-now、受众、角度、观点、结构和来源指针，不能只写标题；
5. 将对应 carry 按精确 `plan_item_id` 和 fingerprint 置为 `done`；
6. 读回上述本地事实后提交。

任一步失败必须回滚为零本地写，并由 Dispatcher 返回稳定错误；UI/MCP 不得 `catch {}` 后拼接成功回执。

### 5.3 Agent 派工边界

批准成功只承诺数据库内的批准、项目、初始版本和 carry 闭环，不承诺 Reporter/Writer 已启动。当前 `advanceApprovedPlanItem()` 会在数据库事务内调用进程内 `JobSpawner.spawn()`，该副作用不可被 SQLite 回滚，因此必须从批准事务移出。

本整改不新增 durable outbox 或新的派工恢复系统。批准提交后如需启动研究/写作，继续通过已有独立 `plan_item.advance` 动作执行并返回自己的真实状态；派工失败不能反向伪造批准失败，也不能在批准回执中声称员工已启动。

批准成功的最低读回：

- `planItem.planning_status = approved` 且 revision 已递增；
- `projectId` 非空，且对应 `content_projects.plan_item_id`；
- 初始内容版本存在且正文非空；
- carry 已为 `done` 或不存在可开放 carry；
- 再读 Recommendation Projection，原 `planItemId` 不存在；
- 仍有候选时新 `primary` 等于冻结排序后的下一条，否则返回明确空状态。

## 6. 旧数据可恢复投影与防死锁

本整改不批量降级或改写旧记录。旧数据按同一分类器 fail closed：

- `approved + 有项目/carry done` 保持终态，不重新打开；
- `approved + 无项目` 作为批准链遗留异常单独列出，不自动降为 draft；
- `ready_for_review + 缺完整方案/非法评分/缺 scoredAt` 进入 `repairable`，携带对象 ID、revision、稳定原因码和说明；
- `draft/rejected + pending` 继续走现有评分/策划恢复路径。

UI 必须能从 `repairable` 打开对应条目并执行“继续评分”或“重新策划”；失败后保留原因，不得只显示一个 invalid 数字。`getTodayPlanExhaustion()` 的 unresolved 口径必须与 Projection 同源，非法 ready 不得被漏算造成永久 deadlock，也不得被算成可批准。

## 7. 代码整改清单

### 7.1 Shared / Main

- `src/shared/propagation.ts`：提供规范评分解析、完整方案门、`eligible/pending/invalid` 分类；删除跨模块 legacy 别名接受路径。
- `src/main/planning.ts`、`src/main/planning-stage.ts`：所有写入共用完整方案门和评分分类；非法输入不得写 `ready_for_review`。
- `src/main/agent-runner.ts`：评分/重新策划只处理用户明确触发的 repairable 项，保留 plan/item 身份和 revision，不做批量旧数据降级。
- `src/main/proposals.ts`、`src/main/workbench.ts`：抽取唯一候选资格、日期、时效、排序、去重和 Projection；Ledger 与 Pool 只消费同一实现；取消决策前硬截断。
- `src/main/ferment-read.ts` / `src/main/ferment.ts`：推荐排除按 exact plan item；共享 source 不得误杀不同选题；批准链明确 `markCarryDoneForPlanItem`。
- `src/main/workbench.ts`：`getTodayOverviewMetrics`、exhaustion、Proposal summary 统一读取 Projection 和同一时间锚点；历史 `latestPlan` 不参与主推荐。
- `src/main/ipc-today-studio-business.ts`、`src/main/mcp-business-commands.ts`：只调用唯一批准函数；移除批准/项目/carry 的吞异常分支；返回稳定失败回执。
- `src/main/daily-content-article.ts`、`src/main/content.ts`：盘点 `createProjectFromPlanItem`、`advanceApprovedPlanItem`、`plan_item.advance` 全部生产调用者；批准路径只做 DB 闭环，独立 advance 才可启动 Agent。

### 7.2 Renderer / 类型

- `src/renderer/today-view.tsx`：主卡直接消费 `recommendation.primary`，批准先走 `approvePlanItem`，完整读回后才 `openStudio`；运行中隐藏旧主卡动作。
- `src/renderer/today-run-view.ts`：只接受 Projection 事实，移除 `hasTodayPlan => 有可批` 和 `showOpportunityEmpty` 分裂推断。
- `src/renderer/today-pool-view.ts`：只做卡片适配和 badge，不裁决资格、排序或终结。
- `src/renderer/proposal-ledger.ts`、preload、`global.d.ts`：同步 Projection、三态分类、计数和稳定错误类型。
- 不改 foundation 品牌 Token；若确需 CSS，只复用现有 Today 变量并运行设计 Token gate。

## 8. 最小可证伪测试矩阵

### 8.1 资格、投影与排序

1. 只有标题 + 合法评分：不是 `eligible`，不进 `primary`，无批准动作。
2. 缺 `whyNow/angle/pointOfView/titleGuidance/openingGuidance/structureGuidance` 任一字段：不能写入 `ready_for_review`。
3. `draft + pending`：只计入 `scoringPending`。
4. `ready_for_review + 非法总分/缺维度/legacy 别名`：计入 `invalid`，不展示批准。
5. 合法 `ready_for_review`：进入候选；`approved`、已有 project、carry `done/dismissed/expired`：不进入。
6. 未来日期：不进入；`created_at` 无法解析：invalid，不永久开放。
7. 今日 0、跨日 4：主推荐为跨日合法最高分；今日 2、跨日 4：六条统一按冻结排序。
8. 同故事不同分数/priority：先排序再去重，保留最终排序第一条；同 source 的不同 story 不互相排除。
9. 201 条以上候选：排序、计数和 top 不能受旧 200 条截断影响。
10. 同一 `asOf` 下 Today、Ledger、Pool、metrics 计数完全一致；过期边界前后结果可重复。

### 8.2 运行、空状态和指标

1. `hasTodayPlan=true + primary=null`：显示非空原因、说明和下一步，不声称有可批选题。
2. 当前轮真实零结果但存在旧 plan：不回填旧 primary，只显示 clean empty；历史数据独立展示。
3. 运行中旧 primary：批准/否决隐藏或只读；对象 revision 变化时命令返回冲突。
4. 评分未完成/invalid：显示原因和“继续评分/修复评分”，无批准按钮且不造成死锁。
5. 跨日主推荐显示“跨日待批”；顶部数字、台账三类计数等于 Projection。

### 8.3 批准闭环和事务

使用真实临时 SQLite：

1. 通过 UI 主卡可观测到 `approvePlanItem` 在 `openStudio` 之前调用；推荐路径零 `createProjectFromPlanItem`。
2. A/B 两条合法候选初始 primary=A；批准 A 后读回 approved、唯一 project、非空初始版本、carry done，Projection primary=B。
3. 批准 B 后 primary=null，空状态非空；A/B 不再出现。
4. 旧 revision 返回冲突，零额外项目、零重复版本。
5. DB 任一步失败：批准/项目/版本/carry 零写；批准命令不会启动 Worker。
6. Today、Proposal Ledger、carry 与 MCP 的批准入口得到同一数据库结果。

### 8.4 旧数据可恢复投影

1. 读取 Projection 不改写旧数据；每个 repairable 项都有对象、revision、原因码和下一步。
2. `approved + no project` 被报告为遗留异常但不自动降级；有项目的 approved 不被重新打开。
3. invalid-ready 不阻塞新一轮，也不会进入 primary；恢复失败仍保留明确人工动作。
4. 跨日评分超过 24 小时或缺 `scoredAt` 进入 `score_stale`；重新评分后才重新竞争主推荐。

## 9. 实施批次与必跑 Gate

### 批次 0：冻结失败证据

先新增上述负例并在当前实现上稳定失败，尤其是“只有标题仍成为主推荐”“推荐动作绕过批准直接建项目”“批准事务触发进程内 spawn”“旧空计划复活主卡”“201+ 候选被截断”。没有稳定失败证据不得开始修复。

### 批次 A：统一资格和旧数据可恢复投影

先实现 shared classifier、完整方案门、规范评分 parser 和 repairable 原因投影，再接入所有写入/读取路径。通过 8.1、8.4 后才进入 Projection。

### 批次 B：统一 Recommendation Projection

实现完整候选读取、未来日期/时效、最终排序前去重、同源不同 story、统一 `asOf` 和计数；Today、Ledger、Pool、metrics 迁移到同一实现。

### 批次 C：收敛 Renderer 状态

Today 只消费 Projection；实现穷尽式空状态、运行中版本保护、跨日 badge 和明确台账入口。

### 批次 D：批准闭环与入口收敛

抽取唯一批准函数；完成事务内批准、项目、初始版本、carry done，并收敛 Today、Ledger、carry、MCP 入口。Agent advance 保持独立动作，不扩建派工恢复系统。

### 批次 E：打包、安装和真实验收

开发态 focused tests、全量 typecheck/gate 通过后重新打包、安装、启动。安装态必须使用正确 data root 完成：

1. 首页主卡等于数据库当前最高分合法待批准项；
2. 顶部数字、台账和指标与 Projection 一致；
3. 主卡完整显示 why-now、受众、角度、观点、结构和来源，不是只有标题；
4. 点击批准先产生批准回执，再进入对应创作项目；
5. 返回首页原项消失，下一条递补或显示明确空状态；
6. 批准回执不伪造 Reporter/Writer 已启动；
7. 截图、Renderer 读回、数据库读回和安装包版本共同存档。

必跑命令：

```text
node --test tests/scoring-recovery.test.mjs
node --test tests/proposals-compact-ledger.test.mjs
node --test tests/today-run-view.test.mjs
node --test tests/today-desk-display.test.mjs
node --test tests/today-pool-score-grades.test.mjs
node --test tests/today-recommendation-projection.test.mjs
node --test tests/today-approval-flow.test.mjs
node --test tests/today-repairable-projection.test.mjs
npm run typecheck
```

若修改 CSS，再运行 `node --test tests/design-tokens-drift.test.mjs`；安装态验收不能被开发态截图、构建成功或单个 API 200 替代。

## 10. 禁区、失败处理与完成条件

- 不新增 schema，不删除历史评分或旧回执，不用旧 `priority` 冒充传播分。
- 不恢复“Pool 为空时使用最近 Plan”的主卡 fallback，不把共享 source 当成不同选题的采纳证据。
- 不在批准事务中调用外部 spawn；不吞影响批准完整性的异常；不以批准 `ok=true` 伪装 Agent 已启动。
- Projection 与 Ledger 不一致时 fail closed：隐藏批准动作，显示“选题状态需要刷新”，记录差异 ID；禁止前端猜测 fallback。
- 不清理、覆盖或回滚当前工作区的其他改动；实现任务只能修改本方案列出的文件和新增聚焦测试/修复脚本。

只有以下条件全部成立才可将本整改标记为 `accepted`：

1. 8.1–8.4 负例/闭环全部通过，失败测试没有被删除或跳过；
2. `npm run typecheck` 与项目要求的 gate 通过；
3. UI IPC、MCP、Renderer 和数据库真实读回一致；批准回执不混入未经验证的派工成功；
4. 安装态正确版本/正确 data root 完成 9.E 的批准→项目→递补闭环；
5. 截图、命令输出、回执和数据库查询形成可追溯证据。

## 11. 对抗性审计裁决

独立审计原文保存在 [对抗性审计报告](../audits/2026-08-28-today-ai-recommendation-remediation-adversarial-audit.md)。主 Agent 按现场代码裁决如下：

1. **接受 F-03**：必须盘点并收敛 `createProjectFromPlanItem`、`plan_item.advance`、`advanceApprovedPlanItem` 的生产调用者，不能只修 Today 主卡。
2. **接受 F-04**：完整方案门不能只检查非空；已增加结构完整度、占位值、重复标题和来源读回规则。
3. **接受 F-07**：Today 推荐和计数必须来自同一次 `getToday()` 后端快照，不依赖多个 IPC 的不同时间锚点。
4. **接受 F-08/F-09 的边界提醒**：增加 `scoredAt + 24h` 重评分门，并明确本整改保证投影一致与结构完整，不把它夸大为内容质量已被证明。
5. **转化 F-01**：事务内 spawn 的风险成立；解决方式是把 Agent 派工从批准成功合同中拆出，而不是在本任务新增未经证明的 durable outbox。
6. **不接受 F-02**：用户可从台账批准任意仍合法的待批准项，不要求它在点击瞬间仍排名第一；`expectedRevision` 负责对象并发，运行中则隐藏主卡动作。
7. **不接受批量 repair 扩张**：旧数据不自动降级；以 repairable 投影和用户明确触发的评分/策划恢复闭环处理。

经上述回填，Plan 可以进入批次 0 的失败测试阶段；这不代表代码已经实施或产品已经修复。
