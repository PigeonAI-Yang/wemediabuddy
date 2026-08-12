# WMB AI 知识编译协议

状态：上位架构已批准，本协议用于实施设计  
日期：2026-08-12  
范围：Ingest、Query、Lint、Creation、Review 共用的知识编译流程，不授权实现

上位设计：

- [`2026-08-12-wmb-built-in-wiki-notes-architecture-design.md`](./2026-08-12-wmb-built-in-wiki-notes-architecture-design.md)
- [`2026-08-12-wmb-knowledge-object-version-contract-design.md`](./2026-08-12-wmb-knowledge-object-version-contract-design.md)

## 1. 目标与成功定义

编译协议把一次输入整合进现有知识，而不是生成孤立摘要：

```text
Source / FreeNote / QueryArtifact / Review / HealthIssue
→ 识别增量
→ 检索既有知识
→ 消歧与去重
→ 规划知识变化
→ 校验证据与边界
→ 原子提交 ChangeSet
→ 重编译受影响 Wiki
→ KnowledgeUpdateReceipt
```

成功必须同时满足：

1. 原始输入被保存且不被 AI 改写；
2. 已有知识优先被更新，不能用新对象逃避去重；
3. 新结论保留证据性质、时效和适用范围；
4. 受影响 Wiki 反映当前最佳认识；
5. 用户能看到“改变了什么”；
6. 相关知识进入真实选题或创作上下文；
7. 低价值输入可以零 KnowledgeNote 成功完成。

对象产量、关系数量和模型输出长度不是成功指标。

## 2. 编译输入

### 2.1 输入类型

- `ingest`：新保存或正文更新的 Source；
- `free_note`：用户自由记录、原则、经验或纠正；
- `query`：Pi 问答形成的 QueryArtifact；
- `review`：Publication、Metric、Review 和 Method Finding；
- `lint_repair`：KnowledgeHealthIssue 的确定性修复；
- `migration`：现有对象的受控初始化。

### 2.2 Frozen Input Envelope

编译开始时冻结：

- workspace/data-root 和 Lane Scope；
- 触发对象 ID、revision、内容指纹和时间；
- 用户/Agent/系统作者性质；
- requestId、taskId 和权限边界；
- 关联 Topic、Content、Publication 等业务对象；
- 当前 schema/compiler version；
- 预算和允许影响范围。

执行过程中源对象变化则拒绝陈旧提交，重新基于最新输入编译。不得混用不同 revision 的内容。

## 3. 编译阶段

### 3.1 Stage A：保存与规范化

1. 确认原始输入已经持久化；
2. 规范 URL、时间、作者和来源身份；
3. 检查 canonical URL、内容指纹或稳定业务 ID 去重；
4. 提取可定位的原文片段，不只保存 AI 摘要；
5. 记录无法读取、正文缺失、登录墙、时效未知等限制。

命中已有 Source 时更新允许的分析字段或正文缓存，不创建第二个 Source 身份。

### 3.2 Stage B：候选提取

AI 从输入中提取候选：

- Entity mention；
- Claim；
- Insight；
- Concept；
- Case；
- Method；
- Question；
- Creative Pattern；
- Topic 归属；
- 可能影响的 Wiki 页面。

每个候选必须携带原文 locator、来源性质、有效时间、适用范围和提取理由。无法定位到输入或现有固定知识版本的候选不得进入正式 ChangeSet。

### 3.3 Stage C：价值门

候选只有满足至少一项才进入知识规划：

- 可独立验证或反驳；
- 会在未来判断或创作中复用；
- 改变既有认识；
- 增加重要适用边界；
- 形成跨来源综合；
- 暴露高价值问题或知识缺口；
- 记录可复用的创作方法或用户原则。

以下默认不晋升：

- 纯复述；
- 无未来复用价值的细节；
- 导航、寒暄和一次性操作；
- 无法定位依据的模型联想；
- 仅因关键词重叠产生的弱关联。

未晋升候选保留在原始输入或 QueryArtifact 中，不创建空知识。

### 3.4 Stage D：有界检索

检索顺序：

1. 当前 Scope Map 和 Topic Wiki 当前版本；
2. 触发对象已关联 Topic、Entity 和 KnowledgeNote；
3. canonicalKey、别名、外部身份和稳定业务关系；
4. 相关 Wiki 实际采用的固定知识版本；
5. 必要时扩大到 Global Core 或相邻 Topic。

检索必须有界：候选数、页面数、关系跳数、正文长度和时间预算固定。命中不足可以标记 unresolved，不允许无界扫描全库。

### 3.5 Stage E：实体消歧

Entity 匹配证据优先级：

1. 相同外部稳定身份；
2. 相同规范 URL、账号、机构 ID 或产品 ID；
3. 规范名称 + 类型 + 组织/产品上下文一致；
4. 别名和关系上下文一致。

仅名称相似不能自动合并。存在多个合理候选时：

- 保持独立候选或 unresolved；
- 创建 KnowledgeHealthIssue；
- 不把关系写到任意一个对象。

### 3.6 Stage F：知识去重与变更分类

候选与既有知识比较后只能选择：

- `no_change`：纯复述，不写新版本；
- `create`：确属新知识；
- `strengthen`：新增独立支持证据；
- `weaken`：证据质量、时效或适用性降低；
- `qualify`：增加平台、受众、格式、时间或赛道边界；
- `contradict`：出现有效反证；
- `supersede`：新结论替代旧当前结论；
- `scope_split`：不同范围分别成立；
- `merge`：稳定身份重复；
- `promote`：Lane 知识抽象进入 Global Core；
- `new_question`：产生高价值待研究问题。

模型必须给出旧对象 ID、旧版本 ID、差异和选择理由。无法解释为什么不是更新旧对象时，不得创建新对象。

## 4. 来源质量画像

每个 Source/Evidence 形成多维画像，不汇总为单一分数：

- `provenance`：官方/一手、同行评审、独立研究、专业媒体、社区、营销等；
- `independence`：是否独立于被评价对象，是否存在商业或机构利益；
- `method_rigor`：方法、样本、数据和可复现性；
- `claim_fit`：主张是否超过证据；
- `recency`：对该 Claim 是否仍然有效；
- `directness`：直接证据、转述或推断；
- `applicability`：对当前 Lane、受众、平台和问题的适用性。

画像来自可观察事实和显式推断；未知保持 unknown。证据等级由 EvidenceLink 的数量、独立性、性质、时效和冲突推导，不由模型任意填分。

## 5. 结论协调

### 5.1 自动替代

仅在以下条件自动切换当前结论：

- 新官方政策、价格、职位或产品版本明确取代旧事实；
- 旧事实具有明确有效期且已经过期；
- 新一手证据直接推翻仅由较低等级来源支持的旧结论；
- 强身份依据确认重复实体或知识。

记录 `replaced_current` 或 `time_bounded`，保留旧版本和原有效期。

### 5.2 范围拆分

不同平台、受众、格式、地区、时间或 Lane 结果不同时，优先 `scope_split`，不强迫一个全局结论胜出。

### 5.3 保留争议

以下使用 `kept_disputed`：

- 多个可信来源有实质分歧；
- 价值判断或解释框架不同；
- 因果关系不确定；
- 业务样本不足；
- 来源质量无法可靠比较。

Wiki 当前页必须明确争议双方、各自证据、适用范围和未解决原因。

### 5.4 证据不足

使用 `insufficient`，不改变当前结论。可以创建 Question 或 HealthIssue，但不能把候选写成 supported。

## 6. Lane 到 Global 的晋升

AI 可以自动晋升，但必须同时满足：

- 知识可脱离单一事件复用；
- 适用范围能够被明确描述；
- 至少有充分论证表明不是 Lane 偶然现象；
- Global 版本保留 Lane 来源和限制；
- 不与既有 Global 知识重复。

单赛道但具有明显通用机制的用户原则或方法可以晋升，不机械要求两个赛道；此时必须标注证据仍主要来自一个 Lane。晋升是创建/更新 Global 对象和关系，原 Lane 对象不删除。

## 7. 受影响 Wiki 判定

ChangeSet 只重编译可证明受影响的页面：

- 候选所属 Topic Page；
- 引用被更新固定版本的 Entity/Method Page；
- 直接采用旧知识版本的 Synthesis Page；
- Scope Map 的近期变化与健康摘要；
- 明确受晋升影响的 Global 页面。

禁止因关键词相似无界重写。受影响集合在提交前冻结。无法在预算内编译的页面标记 stale 并产生 HealthIssue；当前知识与页面严重不一致时整批回滚。

## 8. Wiki 编译格式

Wiki 是人类主阅读产物，同时要利于 AI 检索。每个页面版本包含：

- 一段自足的“当前认识”；
- as-of 时间和适用范围；
- 关键结论与固定知识版本引用；
- 支持证据、反证和争议；
- 已验证与失效经验；
- 对创作的影响；
- 待研究问题；
- 最近变化；
- 相关 Topic/Entity/Method/Synthesis；
- 机器可读元数据。

正文应简洁、自足、可扫描。不得把完整内部对象 JSON、模型思考、工具输出或证据表格直接写入正文。详细证据按需展开。

Map Page 优先导航和变化；Topic Page 优先当前认识和创作影响；Entity Page 优先当前身份、变化和相关主张；Method Page 优先步骤、适用边界、证据和失败条件；Synthesis Page 优先问题、综合结论、差异和开放问题。

## 9. ChangeSet 规划与校验

计划必须包含：

- 总体变化原因；
- 触发对象和固定 revision；
- 每个对象的 create/update/terminate 行为；
- 新版本完整 payload；
- EvidenceLink 和 KnowledgeRelation；
- 矛盾 resolution mode；
- 受影响 Wiki 和版本；
- FreeNote/QueryArtifact/HealthIssue 状态变化；
- 预期 KnowledgeUpdateReceipt；
- beforeRevision 列表和 requestId。

提交前机器校验：类型矩阵、Scope、真实引用、状态合法性、证据门槛、版本连续性、无关系自环、无合并/替代循环、权限、预算和幂等输入哈希。

模型不能直接绕过计划校验写库。

## 10. Query 写回

QueryArtifact 生成后执行：

1. 固定本轮实际读取的 Wiki/Knowledge 版本；
2. 把回答拆成“已有知识复述”和“新增认识候选”；
3. 对新增候选走价值门、去重、证据和协调；
4. 只有有长期价值的部分进入 ChangeSet；
5. 回执显示本次使用和本次沉淀。

回答本身不是证据。新的综合必须引用回答所依据的固定版本；用户新提供的经验先成为 FreeNote/Evidence。禁止把模型生成的流畅表述当作新事实。

## 11. Lint 修复编译

Lint 只对确定性问题自动生成修复 ChangeSet：

- broken reference；
- 明确过期；
- 强身份重复；
- 页面仍引用 superseded 固定版本；
- 已完成 Review 未回流；
- 可确定的缺失反向关系。

来源冲突、因果判断、方法效果和 Global 泛化问题默认不自动裁决，只生成 HealthIssue 或研究任务。

## 12. Creation 与 Review 编译

创作调用本身只记录使用，不自动证明知识正确。以下可以成为新输入：

- 用户对稿件的明确纠正和修改理由；
- 选题批准/拒绝理由；
- 平台版本差异；
- Publication、Metric、Review；
- Keep/Stop/Change 和 Method Finding。

单次表现不得自动产生普遍因果结论。结果优先：增加观察、限制范围、形成 Case 或 Question；只有多次独立结果或强机制证据才强化 Method/Creative Pattern。

## 13. 失败与降级

- 原文不可读：保存 Source 和限制，产生补料问题，不编造正文；
- 模型输出不合法：零写，保存失败原因，可重试；
- revision 冲突：零写，基于最新版本重新检索与规划；
- 超预算：提交已完整且独立的 ChangeSet；未完成部分不产生半对象；
- Wiki 编译失败：严重不一致则回滚；允许 stale 时创建 HealthIssue；
- 消歧不确定：不合并；
- 证据不足：unverified/inference/question，不标 supported；
- 同 requestId 不同输入：拒绝；
- 输入低价值：零知识变化成功，并生成说明回执。

## 14. 知识变化回执

回执默认展示：

- 输入是否新建或去重；
- 新增、强化、削弱、限域、冲突、替代和晋升；
- 更新的 Wiki；
- 对 Topic、选题和创作的影响；
- 保留的争议和未处理项；
- 失败/降级原因；
- 版本差异入口。

内部 ID 和事务详情只在追溯层展示。

## 15. 真实场景验收

使用一个已有 Topic、Entity、旧 Claim、旧 Method 和历史内容的工作空间：

1. 摄取一份新资料；
2. 命中已有 Entity，不重复创建；
3. 新增一项有原文 locator 的 Claim；
4. 新证据限制旧 Method 的平台适用范围；
5. 与一个可信旧来源存在分歧，保持 disputed；
6. 重编译唯一 Topic Wiki；
7. 回执准确说明新增、限域、争议和影响；
8. 新知识进入一个真实选题简报；
9. 用户向 Pi 追问并形成跨资料综合；
10. Query 写回 Synthesis，纯复述部分不重复创建；
11. Lint 能发现并读回故意制造的 stale 页面；
12. 任一步失败不产生半个 ChangeSet。

## 16. 验收标准

1. 同一输入幂等重放不增加对象、版本或回执。
2. 已有对象优先更新，模型必须解释所有 create 决策。
3. 每条正式候选能定位原文或固定知识版本。
4. 来源质量为多维画像，无总分和伪精确置信度。
5. 自动替代、范围拆分、保留争议和证据不足可稳定区分。
6. 受影响 Wiki 集合有界且可解释。
7. Wiki 正文不包含模型思考、工具垃圾或内部 JSON。
8. Query 回答不会直接冒充事实；新综合引用实际读取版本。
9. 低价值输入允许零 KnowledgeNote 成功。
10. 编译失败、冲突和超预算不会产生半成品知识。
11. 回执能让用户不查看 ChangeSet 也理解知识变化。
12. 真实场景完整跑通 Ingest→Wiki→Creation→Review，并能再进入下一轮。

## 17. 非目标

- 最终模型或供应商选择；
- 最终 prompt 文案；
- 向量数据库；
- 无界全库 Agent；
- 自动因果归因；
- 用对象数量衡量质量；
- 把内部结构暴露为用户表单。
