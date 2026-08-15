# 情报→选题 Agent 化设计：滚动机会池与编辑简报

日期：2026-08-06

状态：Owner 已确认方向与节奏（方向 A、触发方式甲、第 5 段修订），待 review 后实施

范围：情报采集编排、增量判断（Pi daily prompt 与上下文组装）、机会池模型与今日页投影、受控深挖。不重做发布链路、grants、绑定体系。

## 1. 问题

Owner 对当前「情报→选题」的三点定性反馈（2026-08-06）：

- **B 没依据**：看不出 AI 凭什么判断一个题值得做；
- **C 断档**：选题和库存资料、过去写过的内容完全连不上；
- **D 卡死**：流程在扫描/授权/状态那里就断了，根本到不了选题。

另有时效性补充：自媒体一天可能多次更新作品，"按天批次 + 次日注入反馈"是报纸思维，不可接受。

### 1.1 代码级根因（已核实）

| 症状 | 根因 | 位置 |
| --- | --- | --- |
| D | 扫描与判断绑在同一任务；X List 走浏览器，绑定 unverified/needs_user 时整链停摆；判断本身不依赖浏览器却被拖死 | `src/main/agent-runner.ts`、`src/main/intelligence-channels.ts` |
| B | dailyPrompt 未注入 workspace 的 audience/contentGoal/editorialBrief；Agent 只拿到 watching 20 + fermenting 5 + trend 20 的压缩 JSON；prompt 七条规则六条是禁令，零条定义"对这个用户什么是好题" | `src/main/agent-runner.ts` `dailyPrompt` |
| C | schema 已有 `topicId/reviewIds/methodFindingIds`，skill 已有 `wmb_get_knowledge_context`，但 dailyPrompt 从未指令 Agent 使用；复盘结论（reviews）不回读进判断上下文 | `src/main/planning.ts`、`src/main/agent-runner.ts` |
| 时效 | 任务按 `businessDate` 一天一批；plan 按 plan_date 绑定；反馈想进下一轮只能等"明天" | `src/main/agent-tasks.ts`、`src/main/workbench.ts` |

### 1.2 既有资产（不改的部分）

- 渠道采集模块（W0 X List / W1 官网源）与入库管道；
- `plan_items` 证据字段（sourceIds/whyNow/angle/pointOfView/topicId/reviewIds/methodFindingIds/availableMaterials/missingMaterials）；
- ferment/carry 跨天续命池（`src/main/ferment.ts`）；
- `createProjectFromPlanItem` 采纳路径；
- TodayRunView 投影层（WMB-4901）；
- checkpoint 机制（`agent_tasks.checkpoint`，天然支持增量水印）。

## 2. 目标

把「情报→选题」从**按天批次任务**改为**滚动机会池**，把 Agent 从**被禁令拴住的裁判**改为**带着完整编辑简报工作的主编助理**。

### 2.1 用户叙事

```text
滚动采集 → 增量判断 → 机会池（跨天、有时效、可否决）
→ 你选题 → 创作 → 发布 → 复盘落库
→ 下一次任何判断调用时复盘已生效（无注入时点）
```

### 2.2 三条可验收体验

1. X 渠道缺席时，官网源照常、判断照常，页面上只有一条"X 渠道缺席：重新验证"横幅，不再整链卡死；
2. 池里每个机会都能回答四问：为什么是现在、为什么是你、你的独特说法、证据在哪；证据链 UI 可点；
3. 20:00 复盘落库，20:05 的任何一次判断（不管谁触发）上下文里已含该复盘。

## 3. 非目标

- 不重做发布链路、precise grants、浏览器绑定体系；
- 不引入第二 Agent / 双 Agent 分工（终态方向 C，本设计不做）；
- 不放开无约束自主发现（方向 B 全量版不做；只收编其"受控深挖"部分）；
- 不改 `plan_items` 表结构（复用现有字段；池状态由 ferment/carry 状态机承载，见 §4.2）；
- 不做评分系统、爬虫平台、定时任务框架。

## 4. 节奏模型：滚动机会池（替代"今日方案"）

### 4.1 三层节奏

**采集层（滚动）**

- 官网源（纯 HTTP）：默认每 2 小时定时 + 手动"立即扫描"；
- X List（浏览器）：每日 2-3 次定时 + 手动；浏览器不可用时仅该渠道缺席；
- 三个触发入口汇入同一采集编排器。

**判断层（增量）**

- 不再全量重出"今日方案"；每轮采集后只评估新入库资料：值得进池的进池，不值得的带原因丢弃；
- 已评估水印存 `agent_tasks.checkpoint`；
- 池内老机会同时做时效检查：爆点 ~24h、热点 2-3 天、长青常驻；
- 发布某主题后，同主题机会即时降权。

**反馈层（即时，无注入时点）**

- 上下文在每次 Agent 调用时从库里实时组装（§5.1）；
- 复盘 keep/stop/change、发布记录、指标流速落库即生效；
- 不存在"注入"机制、定时器或批次边界。

### 4.2 机会池语义

池 = 跨日期未终结 plan_items 的并集，**池状态由 ferment/carry 状态机承载**（`setCarryState`/`CarryState` 已有状态机与写路径），`plan_items` 只存内容不动结构。终结三态：

1. **已采纳**：经 `createProjectFromPlanItem` 进入创作（现有路径）；
2. **已过期**：按时效分类自动降级为 carry 的 expired 态，归档可见；
3. **被否决**：用户在机会卡上点"否掉"，写 carry 的 dismissed 态+原因，供后续判断降权。

时效分类由 Agent 在判断时输出（爆点/热点/长青），系统按分类执行过期检查；ferment 的 `DEFAULT_WATCH_DAYS/DEFAULT_ACTIVE_DAYS` 语义升级为池的时效基线。

### 4.3 触发方式（Owner 已拍板：甲）

每轮采集完成且有新入库 → 自动触发增量判断。

- 判断单例运行；运行期间新到资料排队入下一轮；
- 空结果存空 delta（成本可忽略）；
- 不做"轻筛+完整判断"两级模型（避免把简单事做复杂）。

## 5. 设计分段

### 5.1 上下文组装：`assembleEditorialBrief(db)`

纯函数，每次 Agent 调用时实时拼装四块，替代现有 `dailyPrompt` 的压缩 JSON：

| 块 | 内容 | 来源 |
| --- | --- | --- |
| 身份 | audience、contentGoal、editorialBrief | `workspace-profiles`（现有，从未进过 prompt） |
| 历史 | 近 30 天已发布项目标题+主题；最近 3 条 final 复盘的 keep/stop/change；方法库结论 | `content_projects`/`reviews`/`method_findings` 直读 |
| 存量 | 发酵池、观察中、趋势流速 | 现有 `refreshWorkCarry`/`listWatchingSources`/`listXPostTrends` |
| 增量 | 本轮新入库资料的完整摘要 | `source_items` 按水印查询 |

判断指令从"禁令清单"换成**四问必答**：

1. 为什么是现在（具体事实 + 时效分类）；
2. 为什么是你（必须引用 topicId/历史内容/库存资料的具体关系）；
3. 你的独特说法是什么；
4. 证据在哪（sourceIds + 事实点）。

答不出四问的线索不许进池。

### 5.2 解耦与降级

- 采集编排器按渠道隔离失败：官网源永不依赖浏览器；X List 失败记"缺席+原因"继续；
- 判断任务零浏览器依赖；
- UI：渠道缺席显示单条横幅（可点去修复），替代整页 needs_user。

### 5.3 证据链与关联落地

- 判断时强制查重：每个候选进池前必须调 `wmb_get_knowledge_context` 查同主题历史，把与库存/历史内容的关系写进机会卡；
- 池的"被否决"态与原因由 ferment/carry 状态机承载（复用 `setCarryState` 写路径）；
- 今日页机会卡渲染证据链：来源标题可点→原文、关联主题可见、引用复盘可见；
- 不改 `plan_items` 既有字段语义。

### 5.4 受控深挖（模型原生搜索，Owner 修订版）

- **主通道 = 云端模型自带联网搜索能力**：Agent 在增量判断中对"值得深挖"的候选直接调用模型内建搜索；
- 硬约束：搜索发现的材料必须入库为 `source_items`（canonicalUrl、标题、摘要、采集时间必填）才可被机会引用——搜索结果不是业务事实，入库后才是；
- 当前 preset 模型/网关未开搜索时，降级走现有 HTTP collector；Pi 配置页标识该 preset 是否带搜索能力；
- 浏览器自动化边界不动：仍只属于 X 渠道采集与发布环节。

### 5.5 今日页投影改造

在 TodayRunView（WMB-4901）上扩展池视图：

- 列表 = 机会池（优先级 + 时效排序），非"今日 plan"；
- 每条机会：新增标记、时效标记（"还剩 ~20h"/"长青"）、证据链入口；
- 渠道缺席横幅；
- "否掉"操作（写状态+原因）。

## 6. 实现映射

| 改动 | 位置 | 性质 |
| --- | --- | --- |
| `assembleEditorialBrief` 纯函数 + fixtures | `src/main/`（新模块） | 新增 |
| dailyPrompt 改用简报 + 四问指令 | `src/main/agent-runner.ts` | 修改 |
| 采集编排器渠道失败隔离 | `src/main/intelligence-channels.ts` / 采集调度处 | 修改 |
| 增量水印读写 | `src/main/agent-tasks.ts` checkpoint | 复用 |
| 池视图查询（跨日期未终结并集） | `src/main/workbench.ts` `getToday` | 修改 |
| 机会时效检查与降级 | `src/main/ferment.ts` | 扩展 |
| "被否决"态 + 写路径 | `src/main/ferment.ts` `setCarryState` + dispatcher 路由 | 复用扩展 |
| 定时采集调度（官网 2h / X 每日 2-3 次） | main 进程调度 | 新增 |
| 深挖入库约束（canonicalUrl 必填） | `src/main/sources.ts` 写路径校验 | 修改 |
| 今日页池视图投影 | `src/renderer/today-run-view.ts` 等 | 扩展 |
| Pi 配置页"模型带搜索"标识 | `src/renderer/settings-view.tsx` + pi 配置保存 | 小改 |

## 7. 验收标准

1. X 渠道缺席场景：官网源照常入库，判断照常出池，页面仅一条缺席横幅（fixture + 实机）；
2. 简报组装：种子库注入复盘/发布历史/发酵池，断言 `assembleEditorialBrief` 输出四块齐全（unit fixtures）；
3. 增量水印：连续两轮采集，第二轮只评估新资料（fixture）；
4. 复盘即时生效：复盘落库后 5 分钟内触发判断，简报中可见该复盘结论（实机或集成）；
5. 深挖入库：Agent 引用未入库来源写机会被拒绝，入库后接受（fixture）；
6. 池视图：跨日期机会并集、时效标记、否掉写状态（投影测试 + 实机截图）；
7. 判断质量抽查：实机一轮，池内每个机会四问齐备、证据链可点（人工验收）。

## 8. 风险与开放问题

- **判断频次成本**：方式甲一天 8-12 次增量判断，DeepSeek Flash 单次成本可忽略；若换 preset 需重新评估；
- **模型搜索能力的网关差异**：不同 preset/网关对原生搜索的暴露方式不一，需先验证当前 OpenCode Go 通道是否透传；不透传则首轮用 HTTP collector 降级，标识留到配置页；
- **"被否决"的降权学习**：第一版只记录原因进简报，不做模型级训练；
- **时效分类误判**：Agent 把长青判成爆点会过早降级；第一版允许用户在池视图手动改时效（小操作，可后置）。

## 9. 后续（本设计不做，仅记录）

- 方向 C：Scout/Editor 双 Agent 分工（等本循环跑顺后评估）；
- 创作循环与复盘循环的同构 Agent 化（复用 `assembleEditorialBrief` 模式）；
- 多工作空间的池隔离验证（UK root）。
