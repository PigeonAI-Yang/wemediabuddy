# WMB-5216 M7 结果回流（Outcome Feedback）实施报告

日期：2026-08-12
范围切片：结果回流（Outcome owner 侧；Health 侧与 Results 投影由并行 agent 交付）
Design: `docs/spark/2026-08-12-wmb-outcome-feedback-knowledge-health-design.md` §2–§5/§12
约束遵守：只改 WMB-5216 范围；SQLite 真源；正式知识只经 `applyKnowledgeChangeSet`；
不新增顶层 Wiki/平行业务身份/用户知识 CRUD；不改最终发布人工边界；未触碰
`src/shared/knowledge-flywheel.ts` 与任何 IPC 通道（无新增通道/命令/ChangeSet 段）。

## 1. 变更文件

| 文件 | 变更 |
| --- | --- |
| `src/main/outcome-feedback.ts` | 新增。结果回流主模块：final Review 冻结终态 → 保守知识 ChangeSet（含 Topic Wiki 原子重编译） |
| `src/main/reviews.ts` | `saveReview(status='final')` 在 `recordReviewUsage` 后、同事务内调用 `flowBackOutcome(…, false)`；失败整体回滚 |
| `tests/wmb-5216-outcome-feedback.test.mjs` | 新增。父进程测试（子进程真实 SQLite） |
| `tests/wmb-5216-outcome-feedback-child.mjs` | 新增。80 项断言验收 |
| `tests/wmb-5215-creation-usage.test.mjs` | WMB-5215 既有测试改为语义断言（按 Main 指示）：`cs-seed-2` wiki 更新读取当前 revision 而非固定 `beforeRevision: 1`，并断言结果回流版本已写入 Topic Wiki 历史 |

## 2. 设计决策（与协议对齐）

1. **唯一知识血缘 = 发布时固定 Usage Package/Record**：
   `flowBackOutcome` 只读 `readPublicationTimeUsage`（platform/core/review 包），
   结果 Note 版本的 `adoptedKnowledgeVersionIds` 只 pin 发布时冻结的 Note 版本
   （store 校验仅接受 `knowledge_note_versions` 引用；完整 wiki+note 血缘写入回执
   `impact.lineageVersionIds`）。绝不回读当前 Wiki，后续知识更新不改写历史（测试 7）。
2. **单次 final Review 只形成**：
   - 一个 `case` 观察 Note（kind=case；conclusionStatus=unverified；
     evidenceLevel=outcome_observed 或 insufficient——零/未知指标严格区分，不当 0；
     evidence = review（sourceNature=review）+ publication + metric_snapshot
     （sourceNature=performance_observation））；
   - 限域表述：keep 项精确命中既有 active creative_pattern/method/claim Note 的
     canonicalKey → 追加 `qualified` 版本，appliesTo 按平台/受众/时间窗限定。
   - **绝不新建因果 Method**（守卫：kind=method 且 beforeRevision 缺省 → OUTCOME_PLAN_INVALID；
     既有 method 的 qualified 限域表述允许，符合「或限域表述」）。
3. **重复结果限域**：同 topic + 同 platform/audience + 同规范化 keep ≥ 2 次 final Review
   才创建/强化 `creative_pattern` Note（canonicalKey 含 keep 哈希 + platform + audience 哈希），
   结论固定 `inference` + `corroborated`，appliesTo = `platform:…|audience:…|window:起..止`，
   语句含「不构成因果证明」。跨平台/跨受众不聚合；第 3 次同向结果才 `strengthened`。
4. **原子与幂等**：全部经 `applyKnowledgeChangeSet(transaction=false)` 在 final Review
   保存事务内提交；稳定 requestId `outcome:review:{reviewId}`（无 revision 后缀——
   final Review 终态不可变，一次 finalize = 一次回流）；同输入重放零增量，
   异输入 REQUEST_REPLAY_CONFLICT 且零部分写（store 原生）。
5. **Topic Wiki 原子重编译（Review 后立即可见）**：与结果知识同一 ChangeSet 内
   重编译受影响 Topic Wiki（subject_type='topic' 页）：合并既有 body（保留编译器字段），
   追加 `recentOutcomes`（reviewId/publicationId/caseNoteVersionId/patternUpdates/asOf）、
   `recentChanges`（每个新结果版本）、采纳新结果版本到 `adoptedNoteVersionIds`、
   更新 versionCount；无 topic 时跳过（结果 Note 仍落库 + 回执）。
   `getTopicWikiDetail`（WMB-5212 读模型）立即可读新版本：recentOutcomes 原始可读、
   recentChanges 进入解析后的 TopicWikiBody、receipt 按 affectedTopics=topicId 可查、
   证据含结果 Note（测试 7 覆盖）。revision 冲突/任何失败 → 整个 ChangeSet（含 review 保存）回滚。
6. **WMB-5215 既有测试语义化**：结果回流会在 final Review 保存时追加 wiki 版本，
   原测试对 `cs-seed-2` 的固定 `beforeRevision: 1` 改为读取当前 revision（语义断言），
   并新增「结果回流版本已写入 Topic Wiki 历史」断言。
7. **无 workspace 身份**（历史库/精简 fixture）→ 回流跳过、不失败（与 WMB-5215 usage 一致），
   保持既有 `reviews.test.mjs` 等兼容。

## 3. 验收证据（真实 SQLite fixture，child 80 checks PASS）

| 验收（任务要求 + Main 指示） | 测试段 | 证据 |
| --- | --- | --- |
| final Review 一次回流 | §1 | 恰 1 条 `knowledge_change_sets`（request_id=`outcome:review:{id}`、trigger_source=review、created_by=system）；case Note 1 条；回执 triggerType=review；evidence 3 类（review/publication/metric_snapshot） |
| 重复回流幂等 | §2 | `flowBackOutcome` 重放 replay=true 同 ChangeSet，ChangeSet/Note/Evidence/Receipt 零增量 |
| 异输入冲突 | §3 | 同 requestId 异输入 → REQUEST_REPLAY_CONFLICT，free note 零落库 |
| 单次高表现无 Method | §4 | views=100000 仍 case=unverified/outcome_observed；method=0；pattern=0；语句含「不证明因果」 |
| 重复结果限域 | §5/§6 | x×2 → pattern（inference+corroborated，appliesTo platform:x/audience:在英华人/window，证据含两次 Review）；xhs 单独建立；跨平台不触碰 x pattern；x×3 → strengthened（3 次样本）；受众维度独立（在英华人 vs 留学生不聚合） |
| **Review 后 Wiki 新版本立即可见** | §1/§5/§7 | 同一 ChangeSet 原子追加 Topic Wiki 版本：recentOutcomes 含 reviewId+caseNoteVersionId（§1）、pattern 建立/强化随 Review 立即可读（§5）；Topic 读模型 `getTopicWikiDetail` 回读 recentOutcomes/recentChanges/receipts/证据（§7） |
| usage/version lineage | §7 | 结果版本 pin 发布时固定 Note 版本；Wiki 更新到 wv-2 后结果血缘不变；`readPublicationTimeUsage` 仍读发布时包 |
| 失败回滚（含 Wiki） | §8 | 快照 normalized 损坏 → OUTCOME_SNAPSHOT_CORRUPT → review/usage 包/ChangeSet/case Note/回执/Wiki 版本全零写；修复后重试成功 |
| 单次限域表述 | §10 | keep 精确命中既有 pattern/method → qualified 版本（appliesTo 限域）；method 数量不变 |
| 真实保存链触发 | §11 | dispatcher → `dispatchSaveReview` → 首回流 1 次、命令级重放零增量 |
| 无 workspace 跳过 | §9 | 历史库形态 final Review 保存成功且零知识写 |

相关既有局部测试（直接相关回归，含语义化后的 WMB-5215）：`reviews.test.mjs`、
`editorial-brief.test.mjs`、`wmb-5215-creation-usage.test.mjs`、`knowledge-dossier.test.mjs`、
`knowledge-lineage.test.mjs`、`wmb-5215-knowledge-usage.test.mjs` 共 15/15 PASS。
健康侧并行切片 `wmb-5216-knowledge-health.test.mjs` 与本切片合并 17/17 PASS
（一次合并运行中健康子进程「lint boom」隔离用例出现瞬时 flake，属健康侧自有时序；
重跑全批次稳定通过）。聚焦文件 scoped typecheck（`outcome-feedback.ts` + `reviews.ts`）PASS。

未运行 formatter / linter / 全仓 typecheck / 项目级测试（按任务约束）。

## 4. 风险与边界

- **Wiki 写并发**：结果回流与编译管线都对 Topic Wiki 追加版本；事务内 BEGIN IMMEDIATE
  串行化，revision 冲突即整体回滚（零部分写）。WMB-5215 测试已改为语义断言。
- **qualify 触发面**：单次结果对「keep 文本 == 既有 Note canonicalKey」的精确命中
  追加 qualified 版本——保守（精确匹配），但会随每次复盘为同一 Note 追加版本
  （版本化历史语义，符合不可变追加）。
- **audience 空值**：当前 usage 集成未写 audience（WMB-5215 领域），回退 `any`；
  受众限域在包携带 audience 时生效（测试 §6 覆盖）。
- **指标形状**：只读常见数值字段（顶层数字或 `{value:number}`）；未知/解析失败
  视为 unknown（不当 0），全未知 → insufficient。
- **Results 页投影**：已确认 Results 视图（results-view.tsx/results-panels.tsx）目前
  无 HealthIssue/回流回执投影，由并行 agent `ImplementResultsHealthProjection` 负责
  （读取 listHealthIssues/listUpdateReceipts，只读渲染）；本切片不改 renderer。
- **健康侧联动**：`unreturned_review` 检测按 `knowledge_change_sets.request_id =
  'outcome:review:' || reviewId` 只读判读，已与本切片 requestId 契约对齐。
