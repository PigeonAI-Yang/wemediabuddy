# WMB 创作知识调用协议

状态：实施前详细规格  
日期：2026-08-12  
范围：知识如何进入发现、选题、简报、创作、平台适配和复盘

## 1. 目标

知识调用必须证明“被实际用于决策或内容”，不能把查询成功当作使用成功。

```text
任务现场
→ 确定 Scope/Topic/受众/平台/阶段
→ 组装有界知识包
→ Agent 使用并留下用途记录
→ 用户可见引用与风险
→ 产物版本保存使用血缘
```

## 2. Knowledge Usage Package

每个阶段由系统生成版本化、不可变的使用包：

- workspace/Lane；
- stage；
- Topic、Source、Plan、Project；
- 受众、平台、格式和时间；
- WikiPageVersion；
- KnowledgeNoteVersion；
- Evidence 入口；
- 用户原则与禁忌；
- disputed/stale/inference 风险；
- 选择原因和裁剪原因；
- compiler/schema version；
- 创建时间和 requestId。

使用包是一次任务输入快照，不成为新知识真源。后续知识更新不改变历史使用包。

## 3. 优先级

从高到低：

1. 用户当前明确要求；
2. 用户已保存的高优先级原则、禁忌和纠正；
3. 当前任务批准的选题/创作简报；
4. 当前 Lane/Topic Wiki；
5. 直接证据和最新事实；
6. 相关历史复盘与方法；
7. Global Core 通用知识；
8. AI inference。

高优先级内容冲突时不得静默覆盖。用户当前要求可改变本次创作，但不自动改写长期原则；若表达长期意图，保存 FreeNote 并走编译。

## 4. 阶段调用

### 4.1 新资料判断

使用：Topic 当前综合、已有 Entity、相邻资料、待研究问题和来源质量。输出必须说明新资料是新增、重复、强化、反证还是背景。

### 4.2 选题呈报

使用：Topic 当前认识、受众需求、证据、争议、历史内容、表现、复盘、失效角度和用户原则。

选题必须记录：

- 使用的知识版本；
- 核心证据；
- 为什么现在值得做；
- 与历史内容的区别；
- 风险与缺料；
- 明确未采用的冲突知识及原因。

### 4.3 创作简报

简报是知识到内容的正式桥梁。包含：

- 核心命题；
- 目标受众和预期改变；
- 必须保留的事实与引用；
- 用户观点和声音原则；
- 可用/失效创作模式；
- 平台/格式边界；
- 争议处理；
- 禁止过度声称；
- 实际固定知识版本。

### 4.4 核心内容起草与修改

Writer 只读使用包。正文中的关键事实必须能回到 Evidence。使用方式标记：

- `quoted`
- `paraphrased`
- `reasoning_basis`
- `structure_pattern`
- `avoided_due_to_risk`
- `rejected_by_user`

只读取但没有影响产物的知识标记 `consulted`，不计 actual used。

### 4.5 平台适配

平台版本继承核心版本的知识血缘，并新增平台 Method/Creative Pattern。适配不能改变核心事实；发生事实变化必须回到核心内容新版本。

### 4.6 复盘

复盘使用发布时的固定内容版本、知识使用包、Publication、Metric 和用户反馈，判断哪些知识被真正检验。不能用当前已更新知识倒推历史创作当时“应该知道”。

## 5. 上下文裁剪

先保留：用户要求、原则、当前 Topic 综合、关键证据、风险。再按相关性保留历史方法和 Global。裁剪必须记录原因：

- `budget`
- `low_relevance`
- `superseded`
- `duplicate`
- `scope_mismatch`
- `stale`

stale 或 disputed 不一定删除，若它影响风险判断则必须保留并标记。

禁止按最新时间简单取最近 N 条全局复盘替代主题相关检索。

## 6. 使用证据

保存产物时记录 Usage Record：

- packageId；
- output object/version；
- knowledge version；
- usage kind；
- 可选正文 locator；
- 使用理由；
- actor；
- createdAt。

系统可以根据引用、简报、正文 locator 和 Agent 结构化结果验证。仅在 prompt 中出现不能单独证明 used。

## 7. 风险呈现

- `disputed`：显示争议双方，正文不得写成确定事实；
- `contradicted`：默认不采用，除非用于呈现历史或争议；
- `inference`：标注为分析或推断；
- `stale`：优先补编译或核验；
- `unverified`：不能作为关键事实唯一依据；
- `scope_mismatch`：不得跨平台/受众直接套用。

用户可明确接受风险，本次记录 accepted risk，不自动提升长期可信状态。

## 8. 前端

Topic、选题、Studio、平台版本和复盘均提供统一“知识使用”面板：

- 本次采用；
- 关键证据；
- 用户原则；
- 历史经验；
- 风险；
- 未采用及原因；
- 版本和来源入口。

默认显示少量高价值项，按需展开。不得展示内部 JSON 或要求用户维护 Usage Record。

## 9. 结果回流接口

Usage Package 和 Record 为结果回流提供因果边界：系统只能说某项知识被使用且结果如何，不能仅凭关联宣称它导致表现。Review 可以产生 strengthen/weaken/qualify 候选，进入编译协议。

## 10. 失败与降级

- 无 Topic：使用 Source、用户要求和 Global，明确缺少长期语境；
- Wiki stale：尝试局部重编译，失败则使用最后成功版并警告；
- 无直接证据：降级为 research need，不臆造；
- 包过大：按固定优先级裁剪并记录；
- Usage 保存失败：内容版本整体不提交，避免无血缘产物；
- 平台适配改变事实：拒绝保存，要求核心新版本；
- 用户否决知识：保留 rejected_by_user 使用记录，并将理由作为 FreeNote 候选。

## 11. 验收

1. 每个批准选题读回固定 Knowledge Usage Package。
2. 简报引用真实知识和 Evidence，不使用全局最近 N 条替代相关性。
3. 内容版本可读回 actual used 与 consulted 的差异。
4. 关键事实有 Evidence，推断和争议明确标记。
5. 平台版本继承核心血缘且不静默改事实。
6. 历史复盘使用发布当时版本，不读取未来知识改写历史。
7. 上下文裁剪有稳定优先级和原因。
8. 用户主路径不管理使用记录表单。
9. Usage 保存失败时不产生无血缘内容版本。
10. 一个真实选题可追溯 Topic Wiki→简报→正文→平台版→复盘。

## 12. 非目标

- 证明单项知识对指标的因果贡献；
- 将所有检索项标为 used；
- 在 Studio 直接编辑正式知识；
- 用无限上下文代替裁剪规则。
