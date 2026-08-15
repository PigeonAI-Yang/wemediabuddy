# WMB-5232 激活创作使用与结果回流（真实保存链聚焦验收）

日期：2026-08-13
Design: `docs/spark/2026-08-12-wmb-creation-knowledge-usage-protocol-design.md` §2/§4/§6/§10
范围：`src/main/content.ts`（copy 血缘修复）、`src/main/knowledge-usage-integration.ts`（零知识语义契约文档）、
新增 `tests/wmb-5232-creation-usage-activation.test.mjs`（6 项聚焦验收）。
未触碰：query-writeback / operator Skill / renderer 视觉 / 台账 / schema（5231 兄弟代理的 Query/Skill 文件零接触）。

## 1. 空 Usage 根因（已复现并最小修复）

用真实编译 Topic fixture（`compileSourceKnowledge` 正式管线，非手工 apply）走五阶段保存 API
（选题呈报 → 简报 → 核心正文 → 平台版本 → 复盘），发现一条真实空 Usage 路径：

- **根因**：`copyContentVersionToNewProject`（「复制版本为新项目」保存链入口）创建副本时
  只继承 sourceIds、**丢失来源项目 topicId** → 副本 `content_projects.topic_id = NULL` →
  副本首个核心版本 `recordCoreDraftUsage` 解析零知识 → core/platform/review 全部生成
  **空血缘 Usage 包**（wiki/note/evidence 全空、零记录），尽管来源项目挂载已编译 Topic。
- **最小修复**（`src/main/content.ts`，+5/-1）：副本创建时继承来源项目 `topic_id`；
  首个核心版本即冻结与来源同一批固定 Wiki/Note/Evidence 版本。
- **修复前证据**：副本 `topic_id=null`、core 包 `wiki=[]/notes=[]/topicId=null`；
  **修复后**：副本 `topic_id=来源`、core 包 `wiki=[编译W1]/notes=[采纳N1]/evidence=[E1]`（测试 2）。

其余五阶段入口（proposal/brief/core/platform/review）经编译 fixture 全链路验证
每阶段包均读回非空且有效的固定版本引用（测试 1：6 个包全部非空）。

## 2. used/consulted 语义（测试 1/5/6）

- 六种用途（reasoning_basis/structure_pattern/…）= used=1；`consulted` = used=0（store CHECK 派生）。
- 提案阶段全部 consulted（不冒充 used）；简报/核心 Wiki=reasoning_basis(used)、Note=consulted；
  平台=structure_pattern(used)、Note=consulted；used/consulted 合计 = 记录总数（投影一致）。

## 3. 零知识语义（显式契约，测试 3）

选「如实空血缘」而非跳过（最符合既有契约：§2 每阶段一个稳定 requestId 包 +
`getKnowledgeUsagePackageByRequest` 反查固定血缘 + `readPublicationTimeUsage` 一致性）：

- 无 Topic / 无已编译 Wiki 的业务对象：包**存在**、血缘**如实为空**、**零记录**（不冒充 used/consulted）；
- 绝不回填后续编译知识（不可变血缘）；回执 `impact.lineagePresent=false`；
- case 观察 Note 仍保守形成但 `adoptedKnowledgeVersionIds=[]`（不伪造引用）；
- 全程零因果 Method。
- 契约已写入 `knowledge-usage-integration.ts` 头注释（WMB-5232 显式段落）。

## 4. 平台换基拒绝（测试 4）

平台版本更新换基到不同核心版本（事实变化）→ `REQUEST_REPLAY_CONFLICT`，内容零变更
（仍指原核心版本、revision 不变）；未换基更新正常（血缘创建时已固定，同一包 id，不重复写）。

## 5. final Review 保守回流（测试 5）

- 只读发布时固定 Usage（`readPublicationTimeUsage`）：知识更新后历史复盘仍 pin 发布时
  wiki/note 版本，case Note `adoptedKnowledgeVersionIds` 只含发布时 Note 版本（不回读 nv-2）；
- 只保守形成：case 观察（unverified/outcome_observed 或 insufficient）、keep 精确命中既有
  Note → 限域 qualified（inference、appliesTo=`platform:x|audience:|window:`）、同向重复 ≥2 次 →
  限域 creative_pattern（inference+corroborated、语句含「不构成因果证明」）；
- **零新因果 Method**（单次与两次复盘后 method=0）；单次结果零 pattern；
- 同一 ChangeSet 原子更新 Topic Wiki（recentOutcomes 立即可见，新版本 id = 回执
  `wikiPageVersions[0]`）+ Receipt（triggerType=review、affectedTopics=topic）。

## 6. 投影（测试 6）

`getTopicWikiDetail.creationImpact` 在五阶段（复盘前）全量命中固定版本：total=10
（proposal/brief/core1/core2/platform × wiki+note），含全部阶段 outputObjectType，
wiki 记录 used=1 / note 记录 used=0 语义正确。

## 7. 验收证据与命令

聚焦测试（新增 6 项 + 相关回归）：

```
node --test tests/wmb-5232-creation-usage-activation.test.mjs        → 6/6 PASS
node --test tests/wmb-5215-creation-usage.test.mjs tests/wmb-5215-knowledge-usage.test.mjs tests/wmb-5216-outcome-feedback.test.mjs tests/content-version-project.test.mjs tests/content.test.mjs tests/content-lifecycle.test.mjs → 10/10 PASS
node --test tests/wmb-5212-topic-library-read-models.test.mjs tests/wmb-5218-knowledge-flywheel-e2e.test.mjs tests/wmb-5211-knowledge-compiler.test.mjs tests/wmb-5214-query-writeback.test.mjs tests/wmb-5228-knowledge-candidates.test.mjs → 5/5 PASS
```

未运行 formatter / linter / typecheck / 全套（按任务约束，由主 Agent 统一执行）。

## 8. 变更文件

| 文件 | 变更 |
| --- | --- |
| `src/main/content.ts` | `copyContentVersionToNewProject` 继承来源项目 topicId（空 Usage 根因修复，+5/-1） |
| `src/main/knowledge-usage-integration.ts` | 头注释新增「零知识语义」显式契约（仅文档，无行为变化） |
| `tests/wmb-5232-creation-usage-activation.test.mjs` | 新增 6 项聚焦验收 |

## 9. 风险与边界

- **副本语义**：副本现在继承来源 Topic 归属（此前只继承 sourceIds）；这是血缘正确性修复，
  若产品未来希望「复制为脱离 Topic 的空白项目」需显式传 null 语义（当前契约：副本保持知识上下文）。
- **跨代理**：WMB-5233 兄弟代理将加改 `knowledge.ts`/`knowledge-topic-library.ts`（additive）；
  本测试只消费稳定字段（creationImpact），合并冲突风险低。
- **投影口径**：`creationImpact` 以当前 Wiki 版本为键；Review 重编译 Wiki 后早期 wiki-page 记录
  不再命中该投影（note 版本记录仍可见）——既有 WMB-5212 设计口径，非本任务回归。
