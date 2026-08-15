# WMB 结果回流与知识健康协议

状态：实施前详细规格  
日期：2026-08-12  
范围：发布结果如何成为知识证据，以及 Lint/维护闭环

## 1. 目标

```text
Content Usage
→ Publication
→ Metric Snapshots
→ Review
→ Knowledge Candidates
→ Compilation
→ Wiki New Version
→ Next Creation
```

结果回流必须保守处理因果；知识健康必须主动运行且可逆。

## 2. 结果输入冻结

一次 Review 编译冻结：

- Content/Platform Version；
- 发布时 Knowledge Usage Package；
- Publication identity；
- Metric Snapshot 时间序列；
- 用户反馈和公开反馈；
- Review Keep/Stop/Change；
- Method Finding；
- 平台、格式、受众、时间窗口；
- 数据缺失和采集限制。

不得使用发布后的新知识重解释发布时决策。

## 3. 结果证据性质

- 单次发布：`performance_observation`，可形成 Case/Question/qualify；
- 同 Topic 多次同方向结果：可 strengthen Creative Pattern/Method；
- 跨 Topic/Lane 独立复现：可产生 Global 晋升候选；
- 用户明确修改理由：`user_statement`/`user_experience`；
- Review：解释性证据，不自动等于事实；
- 平台指标：受分发、账号、时机和样本影响，不单独证明因果。

零指标与未知严格区分。没有稳定 Publication identity 的结果不进入正式表现证据。

## 4. 回流变化分类

Review 只能建议：

- `observe`
- `strengthen`
- `weaken`
- `qualify`
- `contradict`
- `new_case`
- `new_method`
- `new_pattern`
- `new_question`
- `no_knowledge_change`

进入正式知识前必须走编译协议、证据门、去重和 Scope 判断。

## 5. 防伪因果规则

系统默认使用：

- “本次使用了 X，结果为 Y”；
- “X 与 Y 在该样本中相关”；
- “该结果支持继续观察/限制范围”。

禁止默认使用：

- “X 导致 Y”；
- “该方法已被证明有效”；
- “低表现说明知识错误”。

升级到较强方法结论至少需要重复结果、合理机制、稳定测量和主要混杂因素说明。否则保持 outcome_observed、mixed 或 insufficient。

## 6. Lint 运行层级

### 6.1 局部增量 Lint

触发：Ingest、Query 写回、Review、恢复、合并、晋升后。只检查受影响对象及有限关系邻域。

### 6.2 打开时健康读回

打开 Topic、Source、Canvas、Studio 时读回已有 HealthIssue 和当前 stale 状态，不执行无界模型任务。

### 6.3 有界周期 Lint

复用现有 worker/job pool，在空闲或计划窗口扫描分页对象。保存 checkpoint，可暂停恢复；不建立第二调度系统。

## 7. 检查器

### 确定性检查

- broken reference；
- version/current pointer 不一致；
- merge/supersede 循环；
- stale Wiki 仍标 current；
- Evidence 指向不存在对象；
- final Review 未回流；
- Usage Record 指向错误 Scope；
- 已过明确有效期的 Claim；
- 重复强外部身份 Entity。

### AI 辅助检查

- 有效来源主张冲突；
- 疑似重复知识；
- Claim 超出证据；
- Global 过度泛化；
- 反复出现但无正式页面的概念；
- 未命名跨 Topic 模式；
- 方法长期表现不佳；
- 高价值 Question 长期未解决。

AI 辅助结果先形成 HealthIssue；只有满足自动协调边界才修复。

## 8. 自动修复

可以自动：

- 修复确定性引用和 current pointer；
- 标 stale 并重新编译；
- 明确时效替代；
- 强身份重复合并；
- 已有 Review 的幂等回流；
- 补确定性反向关系。

不得自动裁决：

- 可信来源实质分歧；
- 因果关系；
- 价值判断；
- 小样本方法优劣；
- 不确定实体消歧；
- 仅靠语义相似的 Topic 合并。

每个修复通过 ChangeSet，生成回执并可恢复。

## 9. HealthIssue 生命周期

`open → repairing → resolved`，或 `accepted_risk / false_positive`。

- repairing 必须引用任务或 ChangeSet；
- resolved 必须记录解决依据；
- accepted_risk 必须说明范围和复查条件；
- false_positive 保留检测器版本，避免重复报警；
- 新证据可重开 resolved/accepted risk，形成新事件。

## 10. 主动综合

周期 Lint 可识别重复洞察和跨 Topic 模式，创建 Synthesis 候选。要求：

- 至少两个独立知识来源或明确的单一高价值机制；
- 固定采用版本；
- 写明 Scope 和边界；
- 低证据标 inference；
- 去重既有 Synthesis；
- 通过正常 ChangeSet 编译。

主动综合不是自动生成长文章，不以数量为目标。

## 11. 前端投影

- 资料库 Knowledge Health：完整问题队列；
- Topic：只显示影响当前 Topic 的健康问题和回流；
- Canvas 健康视图：关系化展示；
- Results/Review：显示本次回流候选和最终更新；
- Today：仅显示需要用户决策或影响当前工作的高严重度问题，不倾倒维护日志。

## 12. 失败与恢复

- 指标不完整：保留未知，不当 0；
- Review failed/cancelled：保留已有证据，不自动形成最终知识；
- 回流 revision 冲突：零写重编译；
- Lint 中断：checkpoint 续跑，不重复 Issue；
- 自动修复失败：Issue 回 open，记录错误；
- 模型检测异常：不修改知识；
- 周期维护不可用：不阻塞创作，显示健康检查过期。

## 13. 验收

1. 单次高表现只形成观察，不自动证明方法有效。
2. 多次结果能按平台/受众限域强化知识。
3. Review 使用发布时知识版本。
4. final Review 恰好回流一次，重放幂等。
5. 局部 Lint 只触及有界对象。
6. 周期 Lint 可暂停恢复且不重复报警。
7. 确定性问题自动修复，争议保持 open。
8. 所有修复有 ChangeSet、回执和恢复能力。
9. HealthIssue 状态和解决依据可读回。
10. Topic/Library/Canvas/Results 投影同一问题身份。
11. Today 只显示可决策高价值问题。
12. 结果回流后下一轮选题能引用真实 Review/Method/Wiki 新版本。

## 14. 非目标

- 自动证明因果；
- 用单次指标训练普遍规则；
- 新建调度平台；
- 为保持图谱整洁强制消除争议；
- 将维护日志倾倒到 Today。
