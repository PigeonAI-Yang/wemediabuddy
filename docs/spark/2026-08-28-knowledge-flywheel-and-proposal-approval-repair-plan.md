# 知识飞轮与选题审批完整修复方案

- 日期：2026-08-28
- 状态：待实施（方案冻结，可直接施工）
- 范围：知识路由、跨日证据召回、Planner 覆盖合同、自动评分硬门、选题审批详情
- 权威边界：本文件是实施 Plan，不替代 `TASKS.md`、`SPEC.md`、`PRD.md` 或既有知识编译协议；实施时仍以权威任务台账与现行产品合同为准。
- 现场结论：当前问题不是单纯提示词或传播评分问题，而是知识进入选题前存在结构性断链，同时审批 UI 把完整方案压缩成了标题行。

---

## 1. 核心完成标准

> 每条进入本轮判断范围的资料，最终必须处于 `selected / excluded / unresolved / blocked` 之一，禁止静默消失。

完整目标链路：

```text
资料入库
→ 正文归档
→ 赛道判断
→ Entity / Topic 路由
→ 知识编译
→ 跨日证据包
→ Planner 完整覆盖判断
→ 自动评分
→ 完整方案审批
→ 创作与发布
→ 结果复盘重新进入知识库
```

每一层必须具备持久状态、失败原因、幂等身份和可执行重试入口。

---

## 2. 已确认问题与根因

### 2.1 知识编译存在循环依赖

当前运行顺序实际是：

```text
Source 保存
→ 仅查询已经存在的 topic_source_links
→ 没有 Topic 则直接结束
→ Source 只有在后续入选方案时才可能建立 Topic
→ 没入选的 Source 永远无法被编译和跨日召回
```

现场证据：

- `100T 免费额度` Source 已入库，但 Topic 关联、知识编译操作和回执均为 0。
- `Ox Alpha = GLM-5.3 Flash` Source 已入库，同样没有 Topic、编译操作或回执。
- 系统已有 `Ox Alpha` Entity，但 aliases 为空，没有与 `GLM-5.3 Flash` 建立身份关系。
- `knowledge-compile-trigger.ts` 只读取既有 `topic_source_links`，不创建或解析关系。
- `planning.ts` 通常在方案保存后才建立 Topic 与 Source 关系，但关系建立后没有统一重新触发知识编译。
- 当前 backfill 同样要求 Source 已有活跃 Topic，历史孤立资料仍会被提前排除。

### 2.2 跨日知识没有进入 Planner 的证据边界

- `EditorialBrief` 的增量主体只读取 watermark 之后的新 Source。
- 旧 Source 只有进入 watching、发酵池或既有 Topic 后才可能成为存量上下文。
- 普通 `active` 且没有 Topic 的旧 Source 对下一轮 Planner 不可见。
- Planner 当前只能引用简报增量块中的 Source ID，即使知道旧事实也不能合法引用旧证据。

因此，8 月 22 日的 `Ox Alpha + 100T` 与 8 月 27 日的 `Ox Alpha = GLM-5.3 Flash` 没有机会进入同一个冻结证据包。

### 2.3 当前没有“为何没入选”的选题决策回执

`source_lane_judgments` 只回答资料是否属于当前赛道，不能回答：

- 是否被 Planner 选中；
- 为什么被排除；
- 是否因证据不足而待处理；
- 是否被其他选题覆盖；
- 是否因为系统失败而未判断。

结果是计划成功保存后，未引用的资料可以完全静默消失。

### 2.4 审批页不是完整决策界面

当前 `plan_items` 已保存完整字段：

- 为什么现在；
- 目标受众；
- 表达角度；
- 核心观点；
- 标题、开头、结构指导；
- 已有材料和缺失材料；
- 来源；
- 六维评分及理由。

但审批页始终使用 `Opportunity` 的非 `primary` 投影，只显示紧凑标题行、简短 whyNow 和标签。点击仅改变 selected 样式与 Pi 焦点，不会切换到完整详情。

---

## 3. 修复知识飞轮

### 3.1 Source 入库后先执行 Topic / Entity 路由

将运行顺序改为：

```text
Source 保存
→ 创建持久化 knowledge_route_source job
→ 读取正文、已有 Entity、别名、Topic 和有界相关旧 Source
→ 输出严格路由候选
→ 建立或确认 Topic 关系
→ 创建 knowledge_compile_source job
→ 编译 Knowledge ChangeSet / Wiki / Receipt
```

复用现有通用 `jobs` 表，不新增平行队列系统。建议 job kind：

- `knowledge_route_source`
- `knowledge_compile_source`
- `knowledge_reactivate_sources`

幂等键：

```text
sourceId + sourceRevision + stage
```

状态复用现有 jobs 能表达的：

- `pending`
- `running`
- `succeeded`
- `failed`
- `needs_user`

通过 payload / error 明确补充 `awaiting_body`、`unresolved` 和 `stale` 原因，不为状态名称另造第二套任务表。

应用重启、Pi 暂不可用、Source revision 变化或并发保存都不能丢任务。

### 3.2 统一 Topic 关系写入

以下路径必须经过一个统一关系服务：

- `recordKnowledgeBatch`；
- 方案保存；
- Topic maintenance 批准；
- 正文归档完成后的重新路由；
- IPC / MCP 中现有关系写入；
- 任何直接写 `topic_source_links` 的生产路径。

统一服务的事务不变量：

1. 校验 Source、Topic 与 revision；
2. 幂等写入 `topic_source_links`；
3. 同事务创建或刷新知识编译 job；
4. 提交后唤醒 Worker；
5. 失败必须传播和记录，禁止空 `catch`。

### 3.3 有界实体消歧

匹配顺序固定为：

1. 外部稳定身份；
2. canonical URL、账号或产品 ID；
3. 已确认别名；
4. 规范名称 + Entity 类型 + 组织/产品上下文；
5. 有界模型候选。

规则：

- 强身份依据可以自动合并；
- 只有名称相似时不得自动合并；
- 多个合理候选时进入 `needs_user / unresolved`；
- 模型只输出候选、证据 locator 和理由，不能绕过服务直接写关系；
- 所有正式 Claim 必须能回指原始 Source 或冻结知识版本。

GLM 案例应拆成不同知识对象：

- Entity：`GLM-5.3 Flash`；
- Alias：`Ox Alpha`；
- Claim：Command Code 声称每天提供 100T 免费容量；
- Claim：相关 Agent 任务或成本实测；
- Evidence Gap：100T 是否由国产算力集群提供，目前缺可靠证据。

“国产算力集群提供 100T”不能因为语义上合理就自动成为事实。

### 3.4 身份变化触发旧证据重激活

强证据确认 `Ox Alpha = GLM-5.3 Flash` 后：

1. 固定 Entity 新版本和已确认 alias；
2. 使用 alias 做有界历史查询；
3. 找出旧 Source 中明确出现该 alias 的记录；
4. 将可信匹配关系写入受影响 Topic；
5. 重编译 Topic Wiki；
6. 生成 Knowledge Receipt；
7. 将受影响 Topic 和旧 Source 标记为本轮 reactivated evidence。

禁止全库无界扫描，也不引入向量数据库。查询范围必须有数量、时间、关系跳数和正文长度上限。

### 3.5 修复历史回填

现有回填不得再在 SQL 层要求 Source 已有 Topic。新的受控回填集合：

- 未归档；
- 有正文或可用摘要；
- 没有 Topic 或没有对应 revision 的知识编译回执；
- 具有明确价值信号。

每条回填必须形成一种结果：

- 已关联并编译；
- 一次性信息，保留但不创建长期 Topic；
- 待消歧；
- 低价值排除；
- 失败并带错误码。

Source revision 变化后，旧任务必须变为 stale，禁止旧内容写入新 revision。

---

## 4. 修复 Planner 输入与覆盖合同

### 4.1 编辑简报增加连续性证据包

Planner 输入调整为：

```text
当日增量
+ 本轮重新激活的跨日证据包
+ 持续关注 Topic 与当前 Wiki
+ 最近发布、复盘和知识缺口
```

跨日证据包至少包含：

- Topic ID 与当前 Wiki version；
- 受影响 Entity 和 alias；
- 新旧 Source ID、标题、作者、URL、摘要和核验状态；
- 正式 Claim、争议、适用范围和证据缺口；
- 最近 Knowledge Receipt；
- 为什么本轮重新激活。

Planner 合法引用集合调整为：

```text
本轮增量 source IDs
∪ 明确注入的 reactivated evidence source IDs
```

不能开放任意全库 Source 引用。

### 4.2 增加资料决策台账

新增最小表 `plan_source_decisions`，用于记录 Planner 对本轮每条候选资料的最终处理：

```text
plan_id
source_id
source_revision
decision        selected | excluded | unresolved | blocked
reason_code
reason
plan_item_id
created_at
```

唯一键：

```text
plan_id + source_id + source_revision
```

这是必要的新状态：现有赛道判断不能表达编辑选择结果；把它塞入 task checkpoint 会失去稳定查询、逐条审计和数据库级 coverage 校验能力。

### 4.3 Planner 输出必须完整覆盖

输出合同增加：

```json
{
  "selectedSources": [],
  "excludedSources": [],
  "unresolvedSources": [],
  "blockedSources": [],
  "items": []
}
```

服务端校验：

- 本轮每个候选恰好出现一次；
- `selected` Source 必须被至少一个 plan item 引用；
- `excluded` 必须有 reasonCode 和具体原因；
- `unresolved` 必须说明缺失证据或消歧条件；
- `blocked` 必须绑定真实运行阻塞；
- 不能引用冻结允许集合之外的 Source；
- coverage 不完整时不得推进 judge watermark；
- coverage 不完整时不能把本轮标为成功；
- 不允许用“纯模型公告”一条规则机械丢弃身份揭晓、额度、成本和独立实测资料。

这样即使 GLM 资料最终不入选，也必须留下可见的排除或待核实回执。

---

## 5. 自动评分与审批硬门

沿用现有六维评分，不另建评分器：

```text
plan item 保存
→ pending
→ 自动评分一次
→ scored / invalid / failed
```

六维仍为：

- `reader_immediacy_benefit`
- `tension_curiosity_gap`
- `why_now_window`
- `save_share_comment_motive`
- `evidence_credibility`
- `account_fit`

硬门：

- 只有六维结构、权重、分项范围和总分全部合法，才能进入 `ready_for_review`；
- `pending / invalid` 永远不能批准；
- 正常链路不得要求用户点击“继续评分”；
- “继续评分”只作为自动评分失败、partial、needs_user 或异常中断后的恢复入口；
- 自动评分不得替换当前计划、修改来源或重新扫描；
- 评分未完成时不得显示在“今日可批”。

---

## 6. 把审批页变成真正的决策界面

### 6.1 审批交互

- “今日可批”第一条默认展开；
- 点击其他卡片切换唯一展开项；
- “查看详情”和“设置 Pi 焦点”拆成两个动作；
- 批准、驳回按钮放在完整详情区域；
- 已批准、已否掉、已过期仍可只读查看当时完整方案；
- 终态列表可保持紧凑，但必须提供明确的“查看完整方案”。

### 6.2 审批详情内容

完整详情必须展示：

- 标题与传播等级；
- 为什么现在；
- 目标读者；
- 表达角度；
- 核心观点；
- 标题、开头和结构指导；
- 已有材料；
- 缺失材料；
- 预计工作量；
- 六维评分及每项理由；
- Source 标题、作者、URL、发布时间、核验状态；
- 跨日历史证据；
- unresolved / Evidence Gap；
- 当前 planning status 和 revision。

缺字段时显示真实数据错误，禁止使用假文案补齐后允许批准。

### 6.3 审批专用读模型

新增统一只读接口：

```text
getProposalDetail(planItemId)
```

Main 一次返回完整、可追溯的审批快照，避免 renderer 自己拼多次查询和产生 N+1：

```text
plan item
+ score reasons
+ source evidence
+ topic/wiki context
+ planner source decisions
+ provenance/revision
```

不能只给现有 `Opportunity` 传 `primary=true` 就宣布完成，因为当前 primary 投影仍缺来源详情、已有/缺失材料、评分明细和证据缺口。

---

## 7. 实施顺序

### Wave 0：冻结复现

1. 复现无 Topic Source 入库后：知识编译操作数、回执数均为 0。
2. 复现 Topic 后关联 Source 后：当前不会稳定自动补编译。
3. 复现跨日身份揭晓：旧 Source 不进入新一轮 Planner 合法引用集合。
4. 复现审批卡：数据库字段完整，但 DOM 没有完整详情。

根因复现未成立前不得猜测性修补。

### Wave 1：持久化知识路由与编译

1. 使用 `jobs` 增加知识路由、编译与重激活 job kind。
2. 实现统一 Topic 关系服务。
3. 所有 Source 保存、正文 ready 和 Topic 后关联路径接入。
4. 写入完整幂等、stale、重试和失败证据。

### Wave 2：实体别名与历史重激活

1. 增加强身份证据 alias 处理。
2. 增加有界旧 Source 影响扩散。
3. 重编译受影响 Topic。
4. 实现无 Topic Source 的受控历史回填。

### Wave 3：Planner coverage 与跨日简报

1. 新增 `plan_source_decisions` migration。
2. 扩展 EditorialBrief 连续性证据包。
3. 扩展 Planner 输出 schema。
4. 原子保存 plan items 与 source decisions。
5. coverage 完整后才推进 watermark。

### Wave 4：自动评分硬门

1. 接回现有自动评分路径。
2. 验证正常路径不需要按钮。
3. 验证失败时原计划保留、人工恢复可用。

### Wave 5：审批详情

1. 增加 `getProposalDetail` Main/IPC/preload 类型与实现。
2. 实现唯一展开审批卡。
3. 展示来源、评分、材料和证据缺口。
4. 将详情动作与 Pi 焦点分离。

### Wave 6：真实回填、打包与部署

1. 仅对冻结范围内的历史孤立资料运行回填。
2. 先跑 focused tests、typecheck、相关 E2E，再跑项目 gate。
3. 使用独立输出目录打包。
4. 启动 packaged Electron，绑定真实数据根进行端到端读回。
5. 通过后再部署；保留旧包作为可恢复版本。

---

## 8. 可证伪验收

### 8.1 知识路由与编译

- Source 先入库、Topic 后关联，最终只产生一次编译 Receipt。
- Topic 先存在、Source 后入库，同样只编译一次。
- 并发重复提交不创建重复关系、知识版本或回执。
- 编译中退出应用，重启后 job 能恢复或得到明确失败终态。
- Source revision 变化时旧任务 stale，不能写旧知识。
- 无 Topic Source 不再静默结束，必须得到一次性、待消歧、排除或失败状态。

### 8.2 GLM 跨日真实场景

- `Ox Alpha` 与 `GLM-5.3 Flash` 只有在强身份证据下归一。
- 身份归一后，旧 `Ox Alpha + 100T` Source 被有界重新激活。
- 两条跨日 Source 进入同一冻结 Evidence Pack，或明确进入 unresolved。
- “国产算力集群提供 100T”保持待核实，不被自动写成 supported Claim。
- Knowledge Receipt 能说明新增身份、旧证据重激活和仍存在的证据缺口。

### 8.3 Planner coverage

- 本轮所有候选都有 `selected / excluded / unresolved / blocked` 回执。
- 同一 Source 不得同时处于多个决策状态。
- coverage 不完整时不推进 watermark。
- Planner 只能引用增量和冻结历史证据包中的 Source。
- 未入选资料可以读回具体排除原因。

### 8.4 评分与审批

- 正常方案保存后自动完成评分，不依赖按钮。
- `pending / invalid` 不能批准，也不能进入“今日可批”。
- 自动评分失败后保留原计划与条目，显示真实错误和恢复入口。
- 审批 DOM 真实显示完整方案、Source、材料缺口和六维评分。
- UI 展示值与 SQLite 逐字段一致。
- “查看详情”不会隐式改变 Pi 焦点；设置焦点也不会代替详情展开。

### 8.5 Packaged Electron

使用隔离数据根跑通：

```text
入库
→ Topic / Entity 路由
→ 知识编译
→ 跨日重激活
→ Planner coverage
→ 自动评分
→ 完整审批详情
```

验收必须读回：

- jobs 终态；
- `topic_source_links`；
- Knowledge Receipt；
- Entity alias；
- `plan_source_decisions`；
- `plan_items` 和 score reasons；
- Electron 审批 DOM；
- 实际安装包哈希和运行进程。

---

## 9. 明确不做

- 不针对 GLM、Ox Alpha、100T 写硬编码规则。
- 不引入向量数据库或无界全库 Agent。
- 不让模型凭名称相似直接合并正式 Entity / Topic。
- 不把未经证实的“国产算力集群提供 100T”写成事实。
- 不用 `priority` 冒充传播等级。
- 不允许 `pending / invalid` 乐观进入审批。
- 不新增平行评分器、平行知识库或平行任务系统。
- 不把完整方案塞进 task checkpoint 代替可审计业务状态。
- 不只修改提示词、CSS 或按钮文案来掩盖运行机制缺口。
- 不顺带扩展到与本方案无证据关系的其他超时、发布或产品重构。

---

## 10. 主要落点（实施导航）

- `src/main/knowledge-compile-trigger.ts`：持久化路由/编译调度与无 Topic 终态。
- `src/main/knowledge.ts`：统一 Topic 关系服务与 `recordKnowledgeBatch` 接入。
- `src/main/knowledge-backfill.ts`：无 Topic Source 回填入口。
- `src/main/knowledge-candidates.ts` / `src/main/knowledge-compiler.ts`：冻结候选、实体消歧和知识编译。
- `src/main/editorial-brief.ts`：跨日 Evidence Pack 与知识缺口投影。
- `src/main/agent-runner.ts`：Planner coverage、允许 Source 边界、水印推进和自动评分。
- `src/main/planning.ts`：原子保存方案与 source decisions；关系写入复用统一服务。
- `src/main/proposals.ts`：审批详情读模型。
- `src/main/db/migrations.ts`：`plan_source_decisions` 最小 migration。
- `src/main/index.ts` / preload / renderer typings：审批详情 IPC。
- `src/renderer/proposals-view.tsx` / `today-view-parts.tsx`：完整审批详情与 Pi 焦点分离。
- focused tests：知识触发、历史回填、Planner coverage、评分硬门、审批详情 DOM。

本方案的最终判断标准不是“新代码或新表已经存在”，而是上述真实跨日场景在 packaged Electron 中闭环，并且任何资料都不再无声消失。
