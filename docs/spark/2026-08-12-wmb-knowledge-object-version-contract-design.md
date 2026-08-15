# WMB 知识对象与版本契约设计

状态：Owner 已确认详细设计  
日期：2026-08-12  
范围：知识对象、关系、证据、版本、生命周期和原子变更契约，不授权实现

上位架构：[`2026-08-12-wmb-built-in-wiki-notes-architecture-design.md`](./2026-08-12-wmb-built-in-wiki-notes-architecture-design.md)

## 1. 目标

本设计定义 WMB 内建 Wiki + 笔记系统的正式知识对象契约，使自由记录能够被 AI 自动提炼为可复用知识，并被持续编译为可读 Wiki，同时满足：

- SQLite 是唯一事实源；
- 用户原话与 AI 产物严格分离；
- Entity 拥有独立稳定身份；
- 知识与 Wiki 正文使用不可变版本；
- 证据连接到具体知识版本；
- 自动更新直接生效但完整可逆；
- 一次可解释的知识变化以 Change Set 原子提交；
- 归档、替代、合并和拒绝均保留历史，不硬删除；
- 现有 Source、Topic、Content、Publication、Review 等业务对象不被复制。

本设计只定义产品和领域契约，不规定最终表名、SQL 结构、队列实现或模型提示词。

## 2. 复用现有 WMB 约定

后续实现必须复用而不是建立第二套惯例：

1. 稳定对象 ID 与 `canonicalKey`；
2. 当前行 `revision` + 写入时 `expectedRevision` 乐观锁；
3. 类似 `content_versions` 的追加式不可变版本；
4. 类型化关系和真实业务对象 ID；
5. `requestId` 幂等回放和命令回执；
6. `archivedAt` 及显式状态表达软终结；
7. Studio Annotation 的保守文本锚点迁移；
8. 事务内全成功或零写；
9. Capability、Task/Page Grant 和精确资源边界继续是写入授权真源。

以下现有对象不得直接冒充新知识真源：

- Canvas Node：仅是可视化投影；
- Topic dossier：是业务记录聚合读模型；
- `topic.summary`：只有当前摘要，缺少正式版本和知识单元；
- Method Finding：依附 Review，缺少独立知识身份和逐版证据；
- `operation_log` / command receipts：只有操作审计，不能替代内容版本；
- Pi 聊天消息：可以成为自由记录来源，但聊天本身不是正式知识。

## 3. Scope：全局知识核与赛道 Wiki

所有正式知识对象必须属于一个 Knowledge Scope：

- `global`：全局知识核；
- `lane`：一个明确赛道 Wiki。

Lane Scope 必须指向 WMB 已存在且当前工作空间允许访问的赛道身份。对象不能通过填写任意字符串跨越 workspace/data-root 隔离。

一项知识默认产生于其证据和业务结果所在的 Lane。AI 判断其可跨赛道复用时，在 Global Scope 创建或更新对应知识对象并建立晋升关系，而不是把原 Lane 对象搬走。

同一对象不能同时属于多个 Scope。跨 Scope 复用通过关系表达。Global 对象必须保留其 Lane 来源、适用边界和晋升 Change Set。

## 4. 正式对象集合

一等对象：

1. `FreeNote`
2. `KnowledgeEntity`
3. `KnowledgeNote`
4. `KnowledgeNoteVersion`
5. `WikiPage`
6. `WikiPageVersion`
7. `KnowledgeRelation`
8. `EvidenceLink`
9. `KnowledgeAnnotation`
10. `KnowledgeChangeSet`

继续复用的现有业务对象包括 Source、Topic、Content Project、Content Version、Platform Version、Publication、Publication Snapshot、Metric Snapshot、Review、Method Finding、Workspace/Lane 和 Operation Receipt。

## 5. FreeNote：原始记录契约

### 5.1 职责

FreeNote 表达一次被 WMB 捕捉的原始输入。它负责保存原意和现场，不负责表达正式知识。

来源至少包括：

- 用户快速记录；
- 用户在任意业务页的笔记或补充；
- Pi 对话中用户明确表达的观点、经验、原则或纠正；
- 用户批准、拒绝或修改内容时给出的理由；
- 用户对 Source、Topic、Content 或 Review 的观察；
- 系统从明确业务事件捕捉的待消化文本。

### 5.2 不变量

- 原文创建后不可修改；
- 保存作者性质、时间、Scope、工作空间、页面、会话、任务和关联业务对象；
- AI 提炼文本不能覆盖或替代原文；
- 一条 FreeNote 可以产生零条、一条或多条 KnowledgeNote；
- 未形成知识不等于捕捉失败；
- 用户后续纠正应创建新的 FreeNote 或 KnowledgeAnnotation，并关联原记录；
- FreeNote 不直接进入 Wiki 正文，必须经过可追溯的提炼或显式引用。

### 5.3 处理状态

- `captured`：已捕捉，尚未完成判断；
- `processed`：相关内容已完成知识化；
- `partially_processed`：只有部分内容已知识化；
- `ignored`：当前判断不值得长期知识化；
- `archived`：退出默认收件箱和自动处理。

`ignored` 和 `archived` 均不删除原文。新的用户批注、证据或上下文可以通过新 Change Set 将其重新置为待处理状态。处理状态变化必须带 revision 并留下原因。

## 6. KnowledgeEntity：稳定实体身份

### 6.1 职责

KnowledgeEntity 表达可被不同来源、Topic、KnowledgeNote 和 WikiPage 长期反复引用的现实或业务实体。Entity 与描述它的 Wiki 页面分离。

初始实体类型：

- `person`
- `organization`
- `product`
- `platform`
- `policy`
- `institution`
- `place`
- `publication_channel`
- `other`

新增核心实体类型需要扩展正式词典；不得用不同拼写规避类型约束。

### 6.2 稳定身份

Entity 至少具有：

- 永久 ID；
- Scope；
- 规范名称；
- 规范键；
- 实体类型；
- 别名；
- 可选外部身份；
- 生命周期；
- revision；
- 创建和更新时间。

Entity ID 回答“它是谁”，Wiki Page 回答“我们当前如何理解它”。Wiki 重编译、恢复或归档不改变 Entity ID。

### 6.3 消歧与合并

AI 判断两个 Entity 为同一身份时，必须通过 Change Set：

1. 选择一个保留 Entity；
2. 将另一个置为 `merged`；
3. 写入明确 `mergedIntoEntityId`；
4. 新版本和新关系统一引用保留 Entity；
5. 默认读取将旧 Entity 解析到保留 Entity；
6. 旧版本、旧证据和旧关系保留原始引用，不批量伪造历史；
7. 合并可通过新的 Change Set 撤销或纠正。

只有规范键或外部身份足以证明相同时才能自动合并；名字相似不能单独构成合并依据。

## 7. KnowledgeNote：原子知识身份

### 7.1 知识类型

KnowledgeNote 的正式类型：

- `claim`：可被证据支持、反驳或标记待核实的事实与主张；
- `insight`：基于一个或多个事实形成的解释或判断；
- `concept`：概念、定义、边界及相关概念；
- `case`：具有背景、做法、结果和启示的案例；
- `method`：可重复使用的方法、步骤、启发式或决策规则；
- `question`：尚待研究、验证或解决的问题；
- `creative_pattern`：标题、开头、结构、表达、素材或平台适配模式。

Entity 不是 KnowledgeNote 类型。人物、公司、产品、平台、机构和政策必须使用 KnowledgeEntity。

### 7.2 稳定身份

KnowledgeNote 当前对象至少具有：

- 永久 ID；
- Scope；
- `kind`；
- Scope 内稳定 `canonicalKey`；
- 生命周期；
- 当前版本 ID；
- revision；
- 创建和更新时间；
- 可选替代或合并目标。

稳定身份表示“同一项知识”；表述、证据状态、适用边界和当前判断存入 KnowledgeNoteVersion。

KnowledgeNote 的 `kind` 创建后默认不变。若发现类型判断错误，使用新对象 + `superseded` 或 `merged` 关系，不静默改写旧身份。

### 7.3 原子性

一条 KnowledgeNote 应表达一项可独立复用、引用、支持、反驳或限制的认识。以下情况必须拆分：

- 一个句子包含多个可独立验证的 Claim；
- 同一方法对不同平台具有不同适用结论；
- 一项洞察同时包含事实与行动建议；
- 一个 Case 中的背景、结果和通用方法需要被分别复用。

拆分后可以用核心关系重新连接，不能为了“原子化”丢失上下文。

## 8. KnowledgeNoteVersion：不可变认识版本

每个版本至少包含：

- `versionNumber`；
- 标题或简短名称；
- 核心 statement；
- 可选解释正文；
- 结论状态；
- 证据等级；
- 适用范围；
- 有效时间或时效边界；
- 采用的 Entity、Topic 和其他知识引用；
- 变更类型与原因；
- 创建者性质；
- 所属 Change Set；
- 创建时间；
- 可选恢复来源版本。

版本创建后不可修改、不可删除。当前对象仅通过 `currentVersionId` 指向当前版本。

### 8.1 结论状态

Claim 支持：

- `unverified`
- `supported`
- `disputed`
- `contradicted`
- `superseded`
- `not_applicable`
- `inference`

状态定义：

- `unverified`：尚无足够证据判定；
- `supported`：当前证据达到支持门槛；
- `disputed`：支持与反证同时达到有效门槛；
- `contradicted`：当前主要有效证据反驳；
- `superseded`：旧结论曾有适用性，但被新结论替代；
- `not_applicable`：在声明范围内不适用；
- `inference`：AI 综合推断，不能显示为外部事实。

非 Claim 类型必须使用与其语义相符的状态子集或专门状态。Question 不能标记为 `supported`，Method 不能仅凭存在就标记为事实成立。具体状态矩阵在实现规格中固定，不能由模型自由造词。

### 8.2 证据等级

- `none`
- `single`
- `corroborated`
- `primary`
- `outcome_observed`
- `mixed`
- `insufficient`

证据等级描述证据结构，不是 0–100 可信分，也不直接等同于结论真伪：

- `single`：只有一个有效来源；
- `corroborated`：存在多个相互独立的有效来源；
- `primary`：具有直接官方、一手或原始材料；
- `outcome_observed`：具有 WMB 业务结果或表现观察；
- `mixed`：同时存在有效支持与反证；
- `insufficient`：现有材料不足以支持当前表述；
- `none`：尚无证据链接。

不得根据来源数量机械覆盖来源质量、独立性、时效和适用范围。

## 9. WikiPage：综合阅读身份

### 9.1 页面类型

- `map`
- `topic`
- `entity`
- `method`
- `synthesis`

### 9.2 稳定身份

WikiPage 当前对象至少具有：

- 永久 ID；
- Scope；
- `pageType`；
- Scope 内 `canonicalKey`；
- Subject 引用；
- 生命周期；
- 当前版本 ID；
- 编译状态；
- revision；
- 创建和更新时间。

### 9.3 Subject 约束

- `map` 必须指向一个 Scope；
- `topic` 必须指向一个现有 Topic；
- `entity` 必须指向一个 KnowledgeEntity；
- `method` 应指向一个主 Method KnowledgeNote；
- `synthesis` 可以没有单一 Subject，但必须声明综合问题、Scope 和覆盖边界。

同一 Scope 内，一个 Subject 默认最多有一个同类型 active WikiPage。WikiPage 不替代 Topic、Entity 或 Method 的身份。

## 10. WikiPageVersion：不可变综合版本

每个版本至少包含：

- `versionNumber`；
- 标题；
- 结构化正文；
- 页面实际采用的 KnowledgeNoteVersion 列表；
- 直接引用的业务对象；
- 争议、低置信和陈旧标记；
- 变更摘要；
- 可读 diff；
- 编译原因；
- 所属 Change Set；
- 创建者性质与时间；
- 可选恢复来源版本。

页面版本创建后不可修改、不可删除。旧 WikiPageVersion 引用固定 KnowledgeNoteVersion，不能因知识当前版本变化而被静默重解释。

知识变化后，受影响的 WikiPage 必须在同一 Change Set 中生成新版本，或显式标记为 `stale` 并记录未编译原因。正式创作使用 stale 页面时必须显式提示并优先补编译，不能无提示当作当前最佳综合。

编译状态：

- `current`
- `stale`
- `compiling`
- `failed`

`compiling` 与 `failed` 是运行和读回状态，不得伪装为已有新版本。

## 11. KnowledgeRelation：知识关系契约

### 11.1 核心关系词典

证据与推理：

- `supports`
- `contradicts`
- `qualifies`
- `supersedes`
- `derived_from`

主题与归属：

- `about`
- `part_of`
- `applies_to`
- `instance_of`
- `related_to`

创作与方法：

- `uses_method`
- `validates_pattern`
- `invalidates_pattern`
- `effective_for`
- `ineffective_for`
- `inspired`

实体关系：

- `created_by`
- `owned_by`
- `operated_by`
- `competes_with`
- `replaces`

每种核心关系必须在注册表中声明：

- 允许的起点对象类型；
- 允许的终点对象类型；
- 是否有方向；
- 是否允许重复或多个；
- 是否参与知识状态判定；
- 是否进入创作召回；
- 反向读取名称；
- 归档和替代时的解析规则。

模型只能从注册表选择核心关系，不能创建近义拼写。

### 11.2 扩展关系

核心词典无法表达时允许：

```text
extension:<namespace>:<relation>
```

扩展关系必须具有：

- 稳定 key；
- 人类可读名称和定义；
- 起点与终点类型；
- 创建 Scope；
- 创建 Change Set；
- 创建理由。

扩展关系默认：

- 不参与可信状态计算；
- 不决定权限或关键业务状态；
- 不成为唯一的创作召回依据；
- 可以进入关系探索和 Wiki 编译；
- 达到复用需求后由正式词典升级归并。

升级后保留旧 key 的历史解析，不批量改写旧版本。

### 11.3 关系版本语义

KnowledgeRelation 是有身份的可终结关系。创建后保留创建 Change Set；失效时记录终结 Change Set 和原因。关系不能硬删。

关系的表述语义发生实质变化时，终结旧关系并创建新关系，而不是原地改变 relation type 或端点。

## 12. EvidenceLink：版本级证据契约

EvidenceLink 独立于普通 KnowledgeRelation。它表达：某个真实输入如何支持、反驳、限制或产生某一个 KnowledgeNoteVersion。

至少包含：

- `knowledgeNoteVersionId`；
- `evidenceObjectType`；
- `evidenceObjectId`；
- `relation`：`supports` / `contradicts` / `qualifies` / `derived_from`；
- 来源性质；
- 可选摘录、定位信息或结构化取值；
- 观察时间；
- 创建者性质；
- 创建 Change Set。

### 12.1 来源性质

- `primary_source`
- `secondary_source`
- `user_statement`
- `user_experience`
- `business_record`
- `performance_observation`
- `review`
- `derived_knowledge`
- `ai_inference`

必须保持以下边界：

- 用户陈述不自动等于外部事实；
- 用户经验可以支持经验性 Insight，但不能冒充普遍规律；
- 表现观察不自动构成因果证据；
- AI 推断必须显式标注，不能伪装成 Source；
- `derived_knowledge` 必须引用具体 KnowledgeNoteVersion；
- Source、Content 和 Review 等引用必须使用真实对象 ID；
- 证据失效、对象归档或知识被替代时 EvidenceLink 仍保留。

EvidenceLink 必须连接具体 KnowledgeNoteVersion，不能只连接稳定 KnowledgeNote。否则旧证据可能被错误解释成支持后续改写的表述。

WikiPageVersion 通过采用的 KnowledgeNoteVersion 继承其证据，同时保存页面实际采用的版本清单。页面中的直接业务事实还必须保存直接业务对象引用。

## 13. KnowledgeAnnotation：用户干预契约

### 13.1 可批注对象

- FreeNote；
- KnowledgeEntity；
- KnowledgeNote 的具体版本；
- WikiPage 的具体版本或文本区间；
- KnowledgeChangeSet。

### 13.2 不变量

- 批注原文创建后不可修改；
- 保存用户身份、时间、Scope、目标对象和现场；
- 文本区间批注保存 quoted text、前后上下文和位置锚点；
- AI 消化批注后通过新 Change Set 产生正式变更；
- 批注与 Change Set 建立来源关系；
- 处理状态变化不能删除批注；
- 批注不得进入 Wiki 正文、Content 正文或发布载荷，除非 AI 生成正式版本且保留来源。

### 13.3 批注意图

至少支持：纠正、限域、降信、强调、要求研究、合并、拆分、恢复和普通评论。AI 可以识别意图，但用户原文仍是权威输入。

### 13.4 文本迁移

Wiki 新版本生成后沿用 Studio Annotation 的保守原则：

- 唯一可靠定位则迁移；
- 文本被删除则标记 `deleted`；
- 存在多个候选则标记 `ambiguous`；
- 用户主动移除则标记 `user_removed`；
- 宁可失去锚点，也不能挂到相似但错误的段落。

## 14. KnowledgeChangeSet：原子知识变化

### 14.1 职责

Change Set 是自动知识维护的事务边界，表达一次可解释的知识变化，而不是任意批量任务。

示例：

> 新发布结果支持“数字团队”叙事在小红书普通创作者受众中的有效性，需要强化一条 Creative Pattern、限制适用范围并重编译两个 Wiki 页面。

### 14.2 内容

一个 Change Set 可以包含：

- FreeNote 处理状态变化；
- Entity 创建、更新、合并或终结；
- KnowledgeNote 创建或生命周期变化；
- KnowledgeNoteVersion 创建；
- KnowledgeRelation 创建或终结；
- EvidenceLink 创建；
- WikiPage 创建或生命周期变化；
- WikiPageVersion 创建；
- 跨赛道晋升；
- KnowledgeAnnotation 处理状态变化；
- 知识变化日志和命令回执。

### 14.3 原子性与并发

- Change Set 所有业务写在一个事务中全部成功或零写；
- 任一引用不存在、类型不合法、权限越界、revision 冲突或证据契约失败则整体失败；
- 不相关变化必须拆分为不同 Change Set，避免扩大失败域；
- 每个被修改的当前对象必须携带 `beforeRevision`；
- 成功后记录 `afterRevision`；
- `requestId` 在工作空间内保证幂等；相同请求重放返回原结果，不新增版本；
- 相同 `requestId` 配不同输入必须失败；
- Change Set 不允许部分成功状态；运行失败与业务拒绝必须可区分；
- 自动更新不进入人工审批队列，提交成功即成为当前知识。

### 14.4 变化类型

至少记录：

- `created`
- `strengthened`
- `weakened`
- `contradicted`
- `qualified`
- `superseded`
- `merged`
- `promoted`
- `archived`
- `rejected`
- `restored`
- `recompiled`

一个 Change Set 可以包含多种对象变化，但必须有一个人类可读的总体原因和触发来源。

## 15. 版本与恢复

### 15.1 不可变版本

KnowledgeNoteVersion 和 WikiPageVersion 一旦创建，不得修改或删除。禁止通过后台修复、合并或恢复重写历史版本。

### 15.2 恢复是追加版本

恢复旧版本时创建新版本：

```text
V1 → V2 → V3（当前错误）
            ↓ 恢复 V1
           V4（内容来自 V1）
```

V4 必须记录：

- `changeType = restored`；
- `restoredFromVersionId = V1`；
- 触发恢复的用户批注或命令；
- 执行恢复的 Change Set。

V2 和 V3 继续保留。恢复后 revision 正常递增。

### 15.3 Note 与 Wiki 独立版本

KnowledgeNoteVersion 更新不能静默改变旧 WikiPageVersion。Change Set 必须：

- 同步生成所有受影响页面的新版本；或
- 将无法编译的页面标记为 stale 并记录明确原因。

不能更新当前知识却让旧页面继续显示为 current。

## 16. 生命周期

KnowledgeEntity、KnowledgeNote 和 WikiPage 使用：

- `active`
- `archived`
- `superseded`
- `merged`
- `rejected`

语义：

- `active`：当前参与 Wiki 编译和自动创作召回；
- `archived`：暂时退出默认使用，但未被判断错误；
- `superseded`：被更新对象替代，必须指向替代目标；
- `merged`：与另一稳定对象重复，必须指向保留目标；
- `rejected`：确认不应成为正式知识，但保留来源和审计。

约束：

- 默认召回只使用 active；
- 历史和版本视图可读取所有状态；
- merged 默认解析到保留对象；
- superseded 默认返回替代对象并保留替代链；
- archived 不进入自动创作上下文；
- rejected 不参与 Wiki 编译和召回；
- EvidenceLink、旧关系和旧版本不因对象终结而删除；
- 生命周期变化通过 Change Set 执行并带 expectedRevision；
- 禁止 AI 硬删除正式知识对象。

FreeNote 使用其独立处理状态，不套用上述知识生命周期。

## 17. 读取与解析规则

1. 默认业务读取解析 merged 和 superseded 链，但返回解析信息，不能让调用者误以为原 ID 从未存在；
2. 解析链必须防循环，并设置有界深度；检测到循环应失败并进入知识健康检查；
3. Wiki 编译固定引用具体 KnowledgeNoteVersion；
4. 当前知识读取返回稳定对象、当前版本、生命周期、Scope、证据摘要和最近 Change Set；
5. 创作召回默认排除 archived、merged 原对象、superseded 原对象和 rejected；
6. disputed、contradicted、inference、stale 内容可以进入创作上下文，但必须携带醒目标记，不能作为无条件事实；
7. 查询 Global 与 Lane 时必须保留来源 Scope 和适用边界，不能把 Global 自动扩展为无边界普遍规律。

## 18. 权限与作者身份

对象和版本必须区分创建者性质：

- `user`
- `pi`
- `background_agent`
- `system`
- `migration`

该字段只表示产物来源，不单独授予写权。写入仍必须通过 Capability 注册表、Task/Page Grant、资源边界、dispatcher 和命令回执。

用户自由记录和批注是高优先级输入，但 AI 生成的结构化版本仍标为 AI 创建；不能把 AI 改写冒充用户文本。

最终发布、平台副作用和硬删除红线不因知识系统增加而改变。

## 19. 失败处理

- **提炼失败**：FreeNote 保持 captured 或 partially_processed，记录可读错误，不生成空 KnowledgeNote；
- **引用缺失**：整个 Change Set 零写；
- **revision 冲突**：返回当前对象和冲突对象列表，重新基于最新状态编译，不覆盖；
- **证据不足**：允许创建 unverified/inference 版本，但不得标记 supported；
- **实体消歧不确定**：创建独立候选或保持 unresolved，不凭名字相似合并；
- **Wiki 编译失败**：知识变化若不能保持页面一致，则整批回滚；只有设计明确允许 stale 的情形可提交并记录原因；
- **批注锚点丢失**：标记 deleted/ambiguous，不猜测迁移；
- **幂等输入冲突**：相同 requestId 不同输入直接拒绝；
- **生命周期链循环**：读取失败并产生健康问题，不自动选择任一对象；
- **越权 Scope 引用**：整个 Change Set 拒绝，不复制外部根对象规避边界。

## 20. 架构级验收标准

1. FreeNote 原文和现场不可被 AI 改写；一条记录可产生多条知识，也可被忽略而不伪装失败。
2. Entity 与 Entity WikiPage 具有不同稳定身份；页面重编译不改变 Entity ID。
3. 同名实体不会仅凭名称自动合并；真实合并保留旧 ID、旧引用、合并目标和完整历史。
4. KnowledgeNote 只有七种正式类型，Entity 不作为 Note 类型；类型错误通过新对象和替代关系处理。
5. KnowledgeNoteVersion 与 WikiPageVersion 创建后不可修改或删除；当前对象只移动版本指针并递增 revision。
6. Claim 同时读回结论状态、证据等级和逐条来源性质，不提供伪精确 0–100 可信分。
7. EvidenceLink 指向具体 KnowledgeNoteVersion，并连接真实业务对象或固定知识版本。
8. WikiPageVersion 能读回实际采用的 KnowledgeNoteVersion；知识更新不会静默改变旧页面含义。
9. 核心关系只能来自注册词典；扩展关系有命名空间、定义和类型边界，且默认不参与关键推理。
10. 一个 Change Set 内对象、关系、证据和 Wiki 版本全部成功或零写；幂等重放不新增版本。
11. 恢复旧版本会追加 restored 新版本，错误版本及其证据链仍可读。
12. archived、superseded、merged、rejected 均保留历史；默认召回只使用 active，并正确解析替代和合并目标。
13. 用户批注原文保留，AI 消化后通过 Change Set 生效；文本迁移无法可靠定位时不会挂错段落。
14. disputed、contradicted、inference 和 stale 内容进入创作时带明确风险标记。
15. 任一对象的作者性质与真实写权分离；知识系统不能绕过现有 capability/grant/dispatcher。
16. 全流程不建立 Source、Topic、Content、Publication 或 Review 的平行副本，不以 Canvas、dossier、summary、operation log 或聊天记录冒充知识真源。

## 21. 非目标

本阶段不设计：

- 最终 SQL 表和索引；
- 模型提示词与编译算法；
- 全文、向量或混合检索实现；
- Wiki 和笔记 UI 视觉稿；
- 定时任务或队列调度；
- 关系可视化布局；
- 外部 Wiki/Obsidian 同步；
- 云同步或多人协作；
- 自动因果归因；
- 允许 AI 硬删除知识。

## 22. 后续设计输入

下一份《AI 知识编译协议》必须以本契约为输入，明确：

- 从 FreeNote 和业务事件识别知识候选；
- 原子拆分、去重、实体消歧和类型判断；
- 结论状态与证据等级计算；
- 核心/扩展关系选择；
- Lane 到 Global 的自动晋升；
- 受影响 WikiPage 的确定与编译；
- Change Set 规划、校验、提交和失败降级；
- 用户批注及结果回流的再编译路径。

后续设计不得削弱本契约的不可变版本、版本级证据、原子 Change Set、无硬删除、单一真源和权限边界。

## 23. 体验校准补充：对象契约不得成为用户工作流

本契约服务于 Wiki 编译、证据追溯、可逆自动化和创作调用，不定义一个面向用户的 Knowledge Note 管理后台。后续实现必须满足：

- Topic Wiki Page 是默认阅读产物；
- FreeNote、KnowledgeNote、EvidenceLink、KnowledgeRelation 和 ChangeSet 默认由 AI 在后台生成与维护；
- 用户通过资料、主题、关系画布、Pi、创作和复盘现有前端感知和纠正知识；
- 状态、证据和版本按需展开，不要求用户填写类型、关系、等级或生命周期；
- 一个对象能否创建不是产品完成证据，必须证明其改变 Wiki 并进入真实创作。

## 24. KnowledgeUpdateReceipt：可读知识变化回执

每个成功或部分失败的 Ingest、Query 写回、Lint 修复、Creation 调用和 Review 回流都必须产生可读回执。回执可以复用 ChangeSet 和 command receipt 的权威数据，但它是一等读模型，不是新的知识真源。

回执至少包含：

- 触发类型：`ingest` / `query` / `lint` / `creation` / `review`；
- 输入来源、业务对象和 requestId；
- 新建、命中去重、强化、削弱、限制、冲突、替代、晋升和未处理数量；
- 受影响的 Topic、Entity、Method、Synthesis 和 WikiPageVersion；
- 对观察主题、选题和内容项目的影响；
- 自动协调、保留争议和失败项的可读原因；
- 对应 ChangeSet 和版本差异入口；
- 发生时间与创建者性质。

默认回执只展示用户能理解的知识变化；内部对象 ID、关系 key、before/after revision 和事务详情放在追溯层。相同 requestId 幂等重放必须返回同一回执，不生成第二条知识变化。

## 25. QueryArtifact：问答写回契约

Pi 的回答不是自动成为 Wiki 正文。一次 Query 应形成临时 QueryArtifact，用于判断是否产生新知识。QueryArtifact 至少记录：

- 用户问题与回答摘要；
- 实际读取的 WikiPageVersion、KnowledgeNoteVersion 和 Evidence；
- 新增综合、限定、反证或待研究问题候选；
- 是否写回及不写回原因；
- 写回 ChangeSet 和 KnowledgeUpdateReceipt。

处理规则：

- 纯复述已有知识：不创建 KnowledgeNote，回执说明未产生新沉淀；
- 新的可复用限定、比较或综合：通过 ChangeSet 更新知识和 Wiki；
- 跨多个 Topic 的稳定综合：创建或更新 Synthesis Wiki Page；
- 用户原则、经验或纠正：先保存不可变 FreeNote，再提炼；
- 一次性操作、闲聊和低价值内容：不强制知识化。

QueryArtifact 是有界处理记录，不是永久知识页面。只有被 ChangeSet 采用的内容进入正式知识。

## 26. KnowledgeHealthIssue：Lint 结果契约

Lint 发现的问题必须形成可读、可定位、可终结的 KnowledgeHealthIssue。它不是 KnowledgeNote，也不改变业务事实。

初始问题类型：

- `stale_claim`
- `unresolved_contradiction`
- `unsupported_claim`
- `duplicate_entity`
- `duplicate_knowledge`
- `orphan_knowledge`
- `missing_wiki_page`
- `stale_wiki_page`
- `broken_reference`
- `unreturned_review`
- `underperforming_method`
- `overgeneralized_global`
- `unanswered_high_value_question`

问题至少包含：Scope、影响对象、严重度、发现依据、建议动作、状态、发现/更新时间和可选解决 ChangeSet。

状态：

- `open`
- `repairing`
- `resolved`
- `accepted_risk`
- `false_positive`

确定性问题可自动修复并生成 ChangeSet 与回执；需要解释判断的问题保持 open 或 accepted_risk，不用“图谱一致”名义强行消除争议。Lint 必须可增量运行，也必须支持有界全局检查。

## 27. 自动协调与争议保留契约

ChangeSet 在处理矛盾时必须声明 resolution mode：

- `replaced_current`：新事实明确替代旧事实；
- `time_bounded`：旧事实保留历史有效期，新事实成为当前；
- `scope_split`：差异来自平台、受众、格式或赛道，拆分适用范围；
- `kept_disputed`：有效证据仍有实质分歧；
- `insufficient`：证据不足，不改变当前结论；
- `manual_correction`：用户批注纠正。

允许自动替代的典型情况限于官方政策、价格、职位、产品版本、明确有效期和强身份依据的重复。价值判断、因果不确定、可信来源分歧和小样本表现必须保留争议或限域。

## 28. 稀疏结构化契约

为避免对象体系反过来增加编译成本，后续实现必须遵守：

1. 输入可以只形成 Source 或 FreeNote，不必生成 KnowledgeNote；
2. 只有可独立验证、反驳、复用或跨页面引用的认识才成为 KnowledgeNote；
3. 只有会被长期反复引用的身份才成为 KnowledgeEntity；
4. 优先更新既有对象，禁止用新对象规避去重与 revision 冲突；
5. Evidence Level 由 EvidenceLink 的性质、独立性和时效推导，不由模型手填分数；
6. 扩展关系是例外；`related_to` 不得成为无法判断时的默认输出；
7. WikiPageVersion 是编译主产物，内部对象数量不是质量或产量指标；
8. 每个 ChangeSet 必须限制受影响对象范围，不允许一次输入无界重写全库；
9. 无法可靠结构化时保留原始输入并产生健康问题，不写入貌似完整的伪知识。

## 29. 现有前端投影约束

- `LibraryTopicsView` 是唯一 Topic Wiki 前端，WikiPage 的当前版本和变化历史必须投影到该页面，不新增平行 Topic 路由；
- `LibraryView` 是 Source/Raw/Evidence/Inbox/Receipt/Health 前端，不能新增 KnowledgeNote 表格要求用户维护；
- `KnowledgeCanvasView` 是正式对象引用和关系探索视图，Canvas Node 不能升级为 KnowledgeEntity、KnowledgeNote 或 WikiPage 的真源；
- Pi 展示 QueryArtifact 的“本次沉淀”，创作页展示实际采用的固定知识版本；
- 已退役的 `DomainMapView` / `TopicDossierView` 不得复活形成第二套知识首页或主题详情。

## 30. 新增验收标准

17. 每次 Ingest、Query 写回、Lint 修复、Creation 和 Review 回流均能读回 KnowledgeUpdateReceipt；默认文案表达知识变化而非事务字段。
18. Query 纯复述不制造重复知识；形成新综合时能追溯实际读取的固定 Wiki/Knowledge 版本和写回 ChangeSet。
19. Lint 问题具有稳定类型、状态、影响对象和解决依据；自动修复与保留争议可区分。
20. 自动矛盾处理记录 replaced/time-bounded/scope-split/disputed/insufficient/manual 模式，不以删除旧版本制造一致性。
21. 一份低价值输入可以零 KnowledgeNote 成功完成；系统不以对象产量判断摄取质量。
22. Topic、资料库和关系画布原位承接 Wiki 阅读、Evidence 与关系探索，不出现平行知识产品和重复身份。
