# 知乎热题驱动的每日文章 × 视频文案闭环 PLAN

- 日期：2026-08-22
- 状态：Owner 已批准方案，等待拆分进入 `TASKS.md`
- 目标里程碑：M-5330
- 计划任务：WMB-5330～WMB-5338
- 适用能力：CAP-001、CAP-002、CAP-014、CAP-025、CAP-026、CAP-027、CAP-028
- 产品边界：知乎只作为热门问题情报源；本阶段不经营知乎、不新增知乎回答编辑器或发布链

## 1. 问题与决策

### 1.1 问题

WeMediaBuddy 已有“情报 → 今日方案 → 研究 → 核心内容 → 平台版本 → 发布 → 复盘”的主链，但还缺少一条低决策成本、可每日重复、能把昨日经验直接带回今日生产的内容循环：

1. 现有情报渠道没有知乎热榜，无法稳定使用真实热门问题降低选题成本；
2. `daily_scan` / `daily_judge` 能形成今日方案，但创作侧没有“每日目标、缺口、顺延、完成口径”；
3. 当前核心内容以文章版本为中心，没有独立、可版本化、能追溯来源文章版本的视频文案产物；
4. Review 的 Keep / Stop / Change 能沉淀结论，但没有显式生成“昨日内容迭代”工单；
5. 已有知乎账号识别、专栏准备和平台版本能力，不等于本需求要经营知乎。若把“热榜选题源”误写成“知乎回答发布”，会把产品目标带偏。

### 1.2 决策

采用“嵌入现有闭环”的路线，不建立第二套半佛工作台：

- 知乎热榜是新的 intelligence module；热榜问题规范化为现有 `source_items`；
- 复用 Today、Plan、Proposal Ledger、Content Project、Research Gate、Studio、Results 和现有 Agent 班组；
- 每个入选热题建立一个 Content Project，文章继续使用不可变 `content_versions`；
- 文章定稿后，再生成一等、不可变、引用具体文章版本的 `video_script` 衍生产物；
- 新增最小的“每日周期 / 每日目标”和“衍生产物 / 衍生版本”持久化，不泛化重构全部内容模型；
- 每天默认完成 2 条新内容目标；昨日迭代是独立队列，不占用这 2 条；
- 目标是指导生产，不是硬性考勤。数量不足时显示缺口，禁止降低质量阈值凑数；
- 只有“文章定稿且视频文案就绪”才计为完成；发布不是完成前提；
- 最终平台发布、线上内容更新、外部平台变更继续遵守既有 Owner 红线。

### 1.3 为什么不选其他路线

#### 不做通用 Artifact 大重构

把文章、视频文案和全部平台版本统一迁移为 Artifact 图，长期模型更整齐，但会扩大到现有 Studio、发布、指标、复盘、知识引用和历史数据迁移。该重构不是完成本目标的必要条件。

#### 不做独立“半佛工作台”

独立页面、专用表、专用 Agent 链能快速演示，但会复制 Today、Proposal、Studio 和 Results 的职责，形成第二套业务真源，与 Electron modular monolith、active-root dispatcher 和 clean cutover 原则冲突。

## 2. 成功状态

一个工作区在一个 business date 内可以完成以下可观察闭环：

1. Reporter 通过绑定浏览器读取知乎热榜，冻结真实热门问题及当次榜位证据；
2. Planner 对问题评分，高分自动入选，边界分进入 Proposal Ledger，低分留档不生产；
3. Daily Cycle 建立 2 条新内容目标；不足 2 条时显示真实缺口；
4. 每条目标经过研究证据门，生成文章主稿并定稿；
5. Writer 根据文章内容决定合适的视频表达形态，再生成引用该文章定稿版本的视频文案；
6. 文章定稿且视频文案就绪后，目标计为完成；
7. 次日首先处理昨日未发布草稿和已发布内容的迭代队列；
8. 已发布内容的本地新版本不触发线上更新；真实平台发布或更新仍由 Owner 最终签发；
9. 重复启动、应用重启、Agent 重试不会重复创建 source、plan item、project、target 或 derivative version；
10. 全部业务写入通过现有 CommandEnvelopeV1 和 active-root dispatcher，可审计、可恢复、数据根隔离。

## 3. 范围

### 3.1 本阶段包含

- 知乎热榜渠道配置、绑定浏览器读取、登录/挑战检测、DOM 解析、证据冻结；
- 热榜问题去重、来源落库、每日观察记录；
- Planner 可解释评分、自动阈值、边界阈值和 Proposal 流转；
- 每日目标默认 2 条、可配置、可顺延、跳过、替换；
- 昨日未发布草稿与昨日已发布内容的迭代队列；
- 文章研究门、主稿、定稿与完成口径接线；
- 一等视频文案衍生产物、版本谱系、动态形态决策、stale 处理；
- Today、Intelligence Settings、Proposal Ledger、Studio、Results 的原位 UI；
- 调度、手动启动、暂停/恢复、重启恢复、幂等和错误回执；
- 聚焦测试、迁移测试、真实知乎热题 + 真实 Electron 闭环验收。

### 3.2 明确不做

- 不开发知乎问题回答编辑器；
- 不自动或手动发布知乎回答；
- 不把每日目标绑定为知乎运营指标；
- 不要求每篇内容都做“短视频口播稿”；
- 不在本阶段增加抖音、视频号或小红书视频自动发布；
- 不用未公开知乎 API、逆向签名接口或绕过验证码；
- 不把目标数做成会无限积压的硬配额；
- 不因候选不足自动降低质量阈值；
- 不引入第二数据库、第二服务、独立工作台或并行内容身份；
- 不重构既有 `content_versions` / `platform_versions` 为通用 Artifact 系统；
- 不改变三类 Owner 红线和最终发布人工签发原则。

## 4. 既有基础与真实缺口

### 4.1 直接复用

- `src/main/daily-intelligence-channels.ts`：`daily_scan` → `daily_judge` 编排；
- `src/main/intelligence-channels.ts`：现有 `official_web` / `x_lists` module 与 readiness 模型；
- `source_feeds` / `source_items`：统一来源身份；
- `plans` / `plan_items`：每日方案及候选项；
- Proposal Ledger：today / shelved / adopted / dismissed / expired；
- `content_projects` / `content_versions`：文章项目与不可变核心版本；
- CAP-028 Research Job：研究证据门；
- `reviews`：Keep / Stop / Change；
- Publication → platform version → content version → project 链；
- JobPool、role grant、requestId、revision、active-root dispatcher；
- 知乎绑定浏览器账号识别和专栏发布准备能力，仅保持现状。

### 4.2 必须新增

- `zhihu_hot` intelligence module；
- 热榜观察的不可变每日证据；
- 质量评分与混合阈值决策；
- Daily Cycle / Target 的持久状态；
- 昨日迭代目标类型；
- 视频文案衍生身份和不可变版本；
- Writer 的 `video_script` 任务与脚本形态决策；
- Today / Studio / Results 的状态投影。

## 5. 核心业务模型

### 5.1 知乎热题 Source

一个知乎问题只有一个稳定 Source 身份：

- 首选稳定键：规范化问题 URL 中的 question id；
- 回退稳定键：canonical URL；
- URL 不可用时才允许 `title + normalized excerpt` 指纹；
- 同一问题再次上榜不创建第二个 `source_item`，而是新增当日 observation；
- 问题标题、URL、作者/话题信息、正文摘要按来源修订规则保存；
- 当次榜位、热度文案、采集时间、页面证据属于 observation，不覆盖历史观察。

建议新增不可变表：

```text
zhihu_hot_observations
- id
- source_item_id
- business_date
- rank
- heat_text
- question_title_snapshot
- question_url_snapshot
- excerpt_snapshot
- evidence_url
- collected_at
- scan_task_id
- input_fingerprint
UNIQUE(source_item_id, business_date, input_fingerprint)
```

`source_items` 继续是来源真源；observation 只回答“这个问题在某次扫描中是什么状态”。

### 5.2 Planner 评分

每个候选生成可解释评分，不允许只保存一个总分：

| 维度 | 分值 | 判断 |
|---|---:|---|
| 目标受众匹配 | 0–25 | 是否服务当前账号定位和受众真实问题 |
| 独立观点空间 | 0–20 | 是否能输出自己的判断，而非复述热榜 |
| 证据可得性 | 0–20 | 是否能通过可靠来源完成研究证据门 |
| 时效与生命周期 | 0–15 | 是否仍有创作窗口，是否过度依赖瞬时情绪 |
| 文章 × 视频可转化性 | 0–15 | 是否既能形成完整文章，也存在合理视频表达 |
| 执行成本 | 0–5 | 当日是否能在合理成本内完成 |

硬性风险不靠扣分掩盖：事实无法核验、明显违法侵权、需要私人数据、重复角度未形成新增价值，直接标记风险或拒绝。

默认阈值：

- `score >= 75` 且无风险标记：自动进入今日目标候选；
- `55 <= score < 75` 或存在可由 Owner 判断的边界风险：进入 Proposal Ledger；
- `score < 55`：留档但不建立创作工单；
- 过去 30 天同题同角度已生产：默认重复拒绝；若 Planner 给出明确新证据、新受众或新观点，可以边界提案方式重开。

阈值和每日目标数属于工作区设置：默认目标 2，允许 1–5；必须满足 `autoThreshold > boundaryThreshold`。修改只影响未来周期，不重写历史决策。

### 5.3 Daily Cycle 与 Target

建议新增：

```text
daily_content_cycles
- id
- business_date
- timezone
- target_count
- status: pending | running | needs_user | completed | partial | paused | failed
- plan_id
- started_at
- completed_at
- last_error_code
- created_at
- updated_at
- revision
UNIQUE(business_date)

daily_content_targets
- id
- cycle_id
- target_kind: new_content | draft_revision | published_revision
- counts_toward_goal: 0 | 1
- source_item_id
- plan_item_id
- project_id
- predecessor_content_version_id
- predecessor_publication_id
- predecessor_target_id
- carry_depth: 0 | 1
- selection_mode: automatic | owner_approved | carried
- score_snapshot_json
- status: proposed | selected | researching | drafting | article_ready | scripting | completed | blocked | skipped | carried
- blocked_reason_code
- created_at
- updated_at
- revision
```

规则：

- `new_content` 才计入每日 2 条；
- `draft_revision` / `published_revision` 属于昨日迭代队列，永不占用新内容目标；
- 一个 cycle 的同一 source 只允许一个 `new_content` target；
- 一个 predecessor version/publication 在同一 cycle 只允许一个 revision target；
- `completed` 必须同时满足 article completion 与有效 video script version；
- `skipped` 不算完成、不产生欠债；Owner 可给出原因；
- `carried` 只顺延一次到下一 business date；再次未完成则留在 Studio，不继续制造每日欠债；
- `partial` 表示周期正常结束但完成数低于目标，不等于系统失败。

### 5.4 文章主稿

文章仍使用现有 Content Project 和不可变 `content_versions`：

- 热题 Source 绑定到 `content_project_sources`；
- Plan Item 冻结角度、受众、标题/开场/结构指导；
- CAP-028 研究证据门不通过时禁止生成文章正文；
- Writer 先生成 core draft，批注/修订继续产生新 version；
- “文章定稿”定义为：项目进入 `ready` 或 `completed`，且有当前最新 core content version；
- 本功能不引入第二种“文章最终版”字段。

### 5.5 视频文案衍生产物

视频文案不是平台版本，也不是附注。新增稳定衍生身份和不可变版本：

```text
content_derivatives
- id
- project_id
- kind: video_script
- created_at
- updated_at
- revision
UNIQUE(project_id, kind)

content_derivative_versions
- id
- derivative_id
- source_content_version_id
- version_number
- format_decision_json
- title
- body
- status: draft | ready
- author: ai | user
- created_at
UNIQUE(derivative_id, version_number)
```

版本行一经写入不可修改。`finalize_version` 不是更新 draft 行，而是以 expected latest version 为输入追加一个正文相同、`status=ready` 的新版本；若期间出现新版本则返回 revision conflict。当前有效脚本始终取最大 `version_number`，因此 ready 之后又保存 draft 会让目标回到 scripting，直到再次追加 ready 版本。

`format_decision_json` 至少冻结：

- 核心传播目标；
- 受众；
- 内容适合的表达方式及理由；
- 建议时长区间；
- 叙事结构；
- 画面/演示密度；
- 节奏与语气；
- 是否需要人物出镜、屏幕演示、案例或引用。

不预设“必须是短视频口播”。Writer 可以根据内容选择解释型、故事型、教程型、观点独白、访谈提纲、长视频讲解或混合视觉叙事；验证的是决策有理由、脚本与文章一致、能实际制作，而不是命中固定模板。

stale 规则：

- `source_content_version_id` 不是项目当前定稿文章版本时，该脚本投影为 stale；
- 文章新定稿不会覆盖旧脚本；
- 目标重新完成前，必须生成引用新文章版本的 ready 脚本，或由用户明确确认旧脚本仍适用并写入新的 derivative version；
- stale 脚本可读、可比较，但不能让 target 保持 completed。

## 6. 每日运行流程

### 6.1 启动

周期由以下任一入口启动：

- 工作区配置的每日时间自动启动；
- Today 手动“开始今日内容循环”；
- Desk 自然语言命令启动。

所有入口调用同一 `daily_content_cycle.ensure` 命令。`businessDate + workspace/dataRoot` 是幂等边界；同日重复启动恢复现有周期。

### 6.2 阶段 A：昨日迭代

按上一 business date 产生两类目标：

#### 未发布草稿

- 条件：昨日 target 未完成，且项目仍为 idea / drafting / review；
- 汇总已有研究、批注、缺口和失败原因；
- Planner 决定 revise、carry、skip；
- revise 时 Writer 基于旧 version 产生新 version，不原地覆盖；
- 只允许一次自动顺延，防止欠债无限增长。

#### 已发布内容

- 通过 publication → platform version → content version → project 定位内容；
- 读取已有 Review Keep / Stop / Change、可用指标快照、发布状态和新增证据；
- 指标尚未成熟时明确写“数据不足”，不得把早期波动写成因果；
- Planner 生成本地修订 brief，Desk 可在内部权限内批准并派 Writer；
- Writer 产生本地新文章版本和对应新脚本版本；
- 不自动 prepare、publish 或更新线上内容；任何外部平台变更重新进入既有 Owner 最终确认链。

昨日迭代失败不阻塞今日新内容目标，但必须显示独立阻塞原因。

### 6.3 阶段 B：知乎热榜扫描

1. 解析绑定 BrowserProfile；
2. 检查知乎页面是否可访问、登录是否失效、是否遇到 challenge；
3. 打开官方热榜页面；
4. 等待明确 DOM readiness；
5. 读取榜位、标题、URL、热度和可见摘要；
6. 规范化 question id / URL；
7. 写 Source 与 observation；
8. 每个 source 形成成功、失败或 needs_user receipt；
9. 某个条目解析失败不丢弃其他成功条目；渠道整体失败不阻断 official_web / x_lists。

禁止：未公开接口、验证码绕过、模拟私人会话、静默使用用户日常浏览器 profile。

### 6.4 阶段 C：评分与选题

- Planner 读取冻结 observation、账号定位、近期 Topics、近 30 天项目和可用知识；
- 逐条输出分项评分、总分、风险和建议角度；
- 自动阈值以上按分数、时效和重复度排序补足目标；
- 边界分进入 Proposal Ledger；
- Owner 采用边界提案后可补入剩余名额；
- Owner 可替换、跳过已选目标；
- 候选不足时 Daily Cycle 显示 `N/2`，不得自动使用低分候选。

### 6.5 阶段 D：研究与文章

- 为 target 创建或复用一个 Plan Item 和 Content Project；
- Researcher 依据角度建立 Research Job；
- Research Gate 未满足时 target=`blocked`，不得写 core draft；
- Gate 满足后 Writer 生成文章；
- 批注和修订沿现有 Studio 版本机制运行；
- 文章进入 ready/completed 后，target=`article_ready`。

### 6.6 阶段 E：视频文案

- Writer 读取冻结的定稿文章版本，而非 Studio 当前可变文本；
- 先输出 `format_decision_json`，再生成脚本；
- 脚本必须保持文章的事实与核心观点，不得引入无证据新事实；
- 脚本可以重组顺序、语言、节奏和画面表达；
- 验证通过后 derivative version=`ready`；
- target 同时满足文章和脚本条件后转 `completed`。

### 6.7 周期结算

- 完成数达到目标且无待处理边界提案：`completed`；
- 流程正常结束但数量不足：`partial`；
- 需要登录/验证码或 Owner 边界决策：`needs_user`；
- 用户暂停：`paused`；
- 仅系统级不可恢复错误：`failed`。

结算生成可读摘要：目标数、完成数、缺口、顺延、跳过、阻塞、自动入选、Owner 入选及昨日迭代结果。

## 7. 产品界面

### 7.1 Today

在现有 Today 原位增加两个区块，不新增顶级导航：

#### 昨日迭代

- 未发布草稿；
- 已发布内容；
- 建议动作；
- 使用的 Review / 指标 / 新证据；
- revise / carry / skip 状态；
- 打开 Studio。

#### 今日内容目标

- `已完成 / 目标数`；
- 每条的来源问题、榜位、分数、选择方式；
- 研究、文章、脚本的阶段状态；
- 缺口、blocked reason、顺延标记；
- 开始/恢复周期、替换、跳过、打开 Proposal、打开 Studio。

完成率是生产反馈，不做连续打卡、惩罚、红色欠债墙或虚假激励。

### 7.2 Intelligence Settings

增加知乎热榜渠道卡：

- enabled；
- BrowserProfile 绑定；
- ready / needs_user / failed；
- 最近成功扫描时间；
- 最近条目数；
- 登录或 challenge 提示；
- 手动测试渠道。

复用现有知乎绑定浏览器身份，不新增账号真源。

### 7.3 Proposal Ledger

边界问题继续进入现有 Ledger：

- 展示分项评分和风险；
- 展示为什么未自动入选；
- 采用后补入当日剩余目标；
- 当日名额已满时采用结果进入次日候选或明确替换，不静默超配额。

### 7.4 Studio

同一 Content Project 增加双产物投影：

- 文章主稿：现有核心版本；
- 视频文案：格式决策、引用文章版本、脚本版本、draft/ready/stale；
- 文章版本变化时显示 stale 原因；
- 支持生成新脚本、比较脚本版本、确认旧脚本适用；
- 不把 video script 伪装成 `platform_versions`。

### 7.5 Results

- Review 的 Change 项提供“加入次日迭代”动作；
- 显示该 Review 是否已产生 revision target；
- 显示本地修订版本和线上 publication 的分离状态；
- 不提供绕过 Owner 的线上更新按钮。

## 8. Agent 与权限

| 角色 | 职责 | 允许写入 |
|---|---|---|
| Reporter | 抓取知乎热榜，冻结 observation，逐源回执 | intelligence/source 相关命令 |
| Planner | 评分、阈值决策、边界提案、迭代 brief、目标结算 | plan/proposal/review/daily target 命令 |
| Researcher | 为选定角度完成 Research Job 和 claims | CAP-028 既有研究命令 |
| Writer | 文章版本、视频格式决策、视频文案版本 | content / derivative 命令 |
| Desk | 编排、内部批准、恢复和任务重派 | 既有 full internal standing write power |
| Owner | 边界题决策、替换/跳过、最终外部平台发布或更新 | 既有 Owner redline 命令 |

新增命令必须注册到 Capability registry 并通过 role grant 过滤。Reporter 不得写内容，Writer 不得自选热题，Planner 不得发布，Desk 不得跨过外部平台最终确认。

建议命令面：

```text
intelligence.zhihu_hot.scan
daily_content_cycle.ensure
daily_content_cycle.pause
daily_content_cycle.resume
daily_content_target.select
daily_content_target.replace
daily_content_target.skip
daily_content_target.carry
daily_content_target.transition
content_derivative.ensure
content_derivative.save_version
content_derivative.finalize_version
```

UI、IPC、Pi MCP、scheduler 都调用同一命令面，不增加兼容写路径。

## 9. 幂等、并发与恢复

### 9.1 稳定键

- hot observation：`sourceId + businessDate + inputFingerprint`；
- daily cycle：`workspace/dataRoot + businessDate`；
- new target：`cycleId + sourceId + targetKind`；
- revision target：`cycleId + predecessorVersionId/publicationId + targetKind`；
- content project：沿 plan item / adopted proposal 既有稳定关系复用；
- derivative：`projectId + kind`；
- derivative version：`derivativeId + versionNumber`，请求重试由 requestId 回执去重。

### 9.2 乐观并发

所有可变身份表使用 `revision`。预期 revision 不匹配返回 conflict，调用方刷新后重新提案；禁止 last-write-wins。

### 9.3 重启恢复

Daily Cycle 的当前阶段、target 状态、Agent task context refs、project/version lineage 全部持久化。JobPool 仍为内存租约；重启后按现有 task/session/receipt 规则重新派发，而不是伪造原 worker 继续运行。

### 9.4 数据根隔离

所有 ID、稳定键和查询在 active data root 内解释。切换 workspace 后不得读取、恢复或完成另一 root 的 cycle / target / derivative。

## 10. 失败语义

| 情况 | 结果 | 恢复 |
|---|---|---|
| 知乎未登录或 challenge | channel / cycle `needs_user` | 用户在绑定浏览器完成后恢复同一 scan |
| 热榜 DOM 漂移 | `failed` receipt，保存诊断证据 | 更新 selector 后重试；其他渠道继续 |
| 单条问题解析失败 | 该 source failed | 其余条目正常入库 |
| 候选不足 | cycle `partial`，显示缺口 | Owner 可采用边界项或接受缺口 |
| 重复题/重复角度 | 默认不建 target | 有明确新增价值时边界提案 |
| Research Gate 不通过 | target `blocked` | 补研究，不允许先写正文 |
| 文章生成失败 | target 保持 drafting/blocked | 重派同一工单，不重复建项目 |
| 视频文案生成失败 | 文章定稿保留，target 未完成 | 重试 derivative 任务 |
| 文章新定稿导致脚本 stale | target 回退 `scripting` | 生成新脚本或确认适用并落新版本 |
| revision 冲突 | command conflict | 刷新后重新提案，不覆盖用户修改 |
| 已发布内容需要更新 | 只生成本地版本 | 重新走 Owner 平台更新确认 |
| 自动调度与手动启动竞态 | 命中同一 cycle | ensure 返回既有周期 |

失败不得降级为“成功但无内容”，不得以空脚本、占位正文或旧缓存冒充当日完成。

## 11. 验收合同

### A1：真实热榜采集

使用绑定浏览器读取一个真实知乎热榜页面；至少一个可见问题落为 Source + observation，证据包含 question URL、榜位和采集时间。重复扫描不重复建 Source。

### A2：混合阈值

固定候选输入可稳定证明：高分自动入选、边界分进入 Proposal、低分不生产；分项分数、风险和总分可读。

### A3：目标制而非硬配额

默认目标为 2。只有 1 个合格问题时，Today 显示 `1/2` 和真实缺口，不选低分题、不制造次日欠债。

### A4：研究门

一个未满足 Research Gate 的 target 不能产生文章版本；补足证据后同一 target 可继续，不重复建项目。

### A5：文章 + 视频文案

一个真实热题从 Source 进入 Content Project，文章定稿后生成引用该具体 content version 的视频文案。视频表达形态有内容依据，不强制短视频口播。

### A6：完成口径

仅有文章时 target=`article_ready`；只有 ready、非 stale 的视频文案后才能 `completed`。

### A7：未发布草稿迭代

昨日未完成草稿生成新不可变文章版本；原版本保留；顺延不超过一次。

### A8：已发布内容迭代

昨日已发布内容结合可用 Review / 指标 / 新证据生成本地新文章版本和脚本版本；线上 publication 不发生变化，未出现任何自动发布或更新。

### A9：stale 传播

文章产生新定稿后，旧脚本立即投影为 stale，target 回退到 scripting；生成引用新文章版本的 ready 脚本后重新完成。

### A10：幂等与恢复

同日重复启动、Agent 重试、应用重启后恢复，不重复创建 cycle、target、project、source observation 或 derivative version。

### A11：权限与红线

Reporter、Planner、Researcher、Writer 的新增命令均受 capability/grant 过滤；Desk 可完成内部编排；最终外部平台发布和更新仍需要 Owner 新鲜确认。

### A12：真实产品表面

打包 Electron 中可见：渠道 readiness、昨日迭代、今日目标、Proposal 边界题、Studio 双产物、stale 状态和周期结算；不是只存在于测试 fixture 或 Agent 文本。

## 12. 测试与证据策略

每项 Acceptance 只保留一个最强证明：

1. 解析器：冻结知乎热榜 DOM fixture，覆盖正常、缺字段、DOM 漂移、重复 URL；
2. 浏览器：真实绑定 BrowserProfile 冒烟，证明 readiness / challenge / 热榜读取；
3. 数据：迁移、唯一约束、不可变 derivative version、data-root isolation；
4. 评分：固定输入证明阈值、风险、重复抑制和稳定排序；
5. 状态机：cycle/target 合法转换、partial、carry-once、stale 回退；
6. 命令：requestId 幂等、revision conflict、role grant；
7. 编排：重启恢复和同日手动/调度竞态；
8. UI：真实 Electron 完成一条热题到文章+脚本，观察 Today、Studio、Results；
9. 红线：真实流程到本地新版本止步，证明没有平台发布副作用。

不把 source-text 断言当行为验收；不为同一 Acceptance 重复跑全量测试、build 和 E2E。

## 13. 交付拆分

### WMB-5330 — 契约、迁移与机器门禁

**范围**

- 将本计划的行为写入 PRD / SPEC / TECHNICAL_DESIGN / root PLAN 对应章节；
- 冻结 module、cycle、target、derivative、command 和 capability 契约；
- 增加数据库迁移与 schema/types；
- 增加 capability drift / command registration / migration gate。

**依赖**：无。

**验收**：新 schema 可从空库和既有 v0.3.0 数据根迁移；唯一约束、版本不可变、role grant 和 active-root dispatcher 约束可由聚焦测试证伪。

### WMB-5331 — 知乎热榜渠道

**范围**

- `zhihu_hot` module；
- Settings 渠道卡和 BrowserProfile readiness；
- 官方热榜浏览器动作、DOM 解析、Source/observation 写入；
- 登录、challenge、DOM drift、逐条 receipt。

**依赖**：WMB-5330。

**验收**：真实知乎热榜至少一个问题落库；重复扫描不重复 Source；其他 intelligence channels 不受该渠道失败影响。

### WMB-5332 — 评分、混合阈值与 Proposal

**范围**

- 六维评分、硬性风险、30 天重复检查；
- 自动/边界/拒绝三路；
- Proposal Ledger 展示分项理由；
- 工作区目标数和阈值设置。

**依赖**：WMB-5330、WMB-5331 的 frozen candidate contract。

**验收**：固定输入稳定命中三路；Owner 采用边界题能补入剩余目标，名额已满时不静默超配额。

### WMB-5333 — Daily Cycle、目标制与 Today

**范围**

- cycle/target command 与状态机；
- 默认 2 条、partial、skip、replace、carry-once；
- Today“今日内容目标”；
- 手动启动、暂停、恢复和结算摘要。

**依赖**：WMB-5330、WMB-5332。

**验收**：候选不足时显示真实缺口；重复 ensure 不重复目标；目标完成口径不能被只有文章或只有脚本绕过。

### WMB-5334 — 昨日迭代队列

**范围**

- draft_revision / published_revision target；
- 未发布草稿的 revise/carry/skip；
- publication → content project 链和 Review/指标/新证据汇总；
- Results“加入次日迭代”和 Today“昨日迭代”。

**依赖**：WMB-5330、WMB-5333。

**验收**：未发布草稿和已发布内容各生成一次新本地版本；不覆盖原版本、不触发平台更新、不计入每日 2 条。

### WMB-5335 — 文章生产链接线

**范围**

- target → Plan Item → Content Project 的幂等创建/复用；
- CAP-028 Research Gate；
- core draft、批注修订、ready/completed 投影；
- target researching/drafting/article_ready 状态同步。

**依赖**：WMB-5333；复用现有 CAP-028。

**验收**：Research Gate 不通过时无正文版本；通过后同一项目生成定稿文章并进入 article_ready。

### WMB-5336 — 视频文案衍生产物

**范围**

- derivative identity/version commands；
- Writer `video_script` job；
- 内容自适应 format decision；
- Studio 双产物、版本比较、ready/stale；
- 新文章定稿后的 stale 传播和重新完成。

**依赖**：WMB-5330、WMB-5335。

**验收**：脚本引用明确文章版本；表达形态由内容说明理由；文章新定稿后旧脚本不能继续让目标显示完成。

### WMB-5337 — 日调度、编排与恢复

**范围**

- 阶段 A～E 的 Desk 编排；
- 自动时间与手动入口归一；
- Agent context refs、重启重派、数据根隔离；
- 局部失败、needs_user、partial 和结算 receipt。

**依赖**：WMB-5331～WMB-5336。

**验收**：手动/调度竞态、Agent 重试和应用重启均恢复同一周期；一个渠道或昨日迭代失败不抹掉其他成功结果。

### WMB-5338 — 真实闭环验收与 clean cutover

**范围**

- 一个真实知乎热题完成 Source → Score → Target → Research → Article → Video Script → Completed；
- 一个未发布草稿和一个已发布内容完成昨日迭代；
- 打包 Electron UI 验收；
- 删除实现期间产生的临时路径、兼容写口和重复投影；
- 更新永久文档和证据。

**依赖**：WMB-5330～WMB-5337。

**验收**：A1～A12 全部由各自最强证据关闭；不存在自动平台发布、第二套工作台、重复业务身份或跨 data-root 泄漏。

## 14. 依赖与并行边界

```text
WMB-5330
  ├─ WMB-5331 ─ WMB-5332 ─ WMB-5333 ─┐
  └─ derivative schema contract ───────┼─ WMB-5335 ─ WMB-5336 ─┐
                                      ├─ WMB-5334 ─────────────┤
                                      └──────────────── WMB-5337 ─ WMB-5338
```

- WMB-5330 必须先冻结所有共享 schema、command 和 capability；
- WMB-5331 的浏览器 reader 与 WMB-5333 的状态机可在契约冻结后并行，但不共享写文件；
- WMB-5332 需要 WMB-5331 的 candidate shape，不要求真实浏览器实现完成；
- WMB-5334 和 WMB-5335 可在 WMB-5333 状态契约稳定后并行；
- WMB-5336 依赖文章完成语义；
- WMB-5337 只负责编排已完成的单元，不在编排阶段补业务能力；
- WMB-5338 是唯一综合验收，不在前序任务重复跑全量验收。

## 15. 施工许可与停止条件

本文件是已批准的方案，不是代码施工许可。进入实现前必须：

1. Owner 确认本文件；
2. WMB-5330～WMB-5338 逐条写入 `TASKS.md`；
3. 当前执行项状态进入 `doing`；
4. 每个任务冻结允许修改范围与唯一验收；
5. 超出本方案的知乎发布、通用 Artifact 重构、新平台自动发布必须另立需求，不得在验证失败时顺带实现。

任一任务发现必须新增另一套状态机、服务、数据库、内容身份或外部平台写路径，应立即停止并回到 Owner 范围复核。
