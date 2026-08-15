# 主题审批冲突合同与自动重提（2026-08-10 主管授权翻转修订）

- 日期：2026-08-10
- 路由：Legislate
- 状态：Owner locked（历史 lock 保留；2026-08-10 主管授权翻转修订已并入 §5/§7）；施工仍须 `TASKS.md doing`
- 修订对象：`docs/spark/2026-08-10-topic-maintenance-approval-design.md`
- 2026-08-10 主管授权翻转：依 `docs/spark/2026-08-10-supervisor-authority-design.md` §8（Owner lock 全 10 项），内部审批（主题 approve/reject/reproposal_retry）归主管（desk），`agentGrantable:true`/`precise:false`/`{desk:true}`；员工与外部 Agent 不代批；红线恰三类不含内部审批。

## 1. 要解决的根因

现有提案把展示快照同时当并发锁，审批时又根据快照反推校验范围。生成和批准没有共享一份显式冲突合同：范围过宽会假 stale，范围正确时真 stale 仍只是死终态，资料员不会自动接回工作。

## 2. 唯一冲突合同

新提案持久化 `TopicMaintenanceSnapshotV2`。`before/after` 继续用于展示；新增 `conflictContract`，由同一个 builder 在提案生成时一次性产生，审批只执行该合同，不再从展示快照或关系图猜范围。

合同只冻结会改变本次批准结果的事实：

- create：canonical key 仍不存在；
- update：目标 topic revision，以及新 canonical key 未被其他 topic 占用；
- archive：目标 topic revision；
- merge：两个 topic revision、被合并主题实际迁移的正式成员、迁移对象 revision，以及保留主题上会改变去重结果的冲突键；
- reassign：from/to topic revision、准确的待迁移关系和目标端同键关系；第三主题或其他资料的无关关系变化不阻塞。

合同校验返回结构化冲突证据，不再只返回 boolean。v1 proposed 提案保留旧读法；不得重算或覆写历史快照。

## 3. 真冲突后的生命周期

```text
Owner 批准
  ├─ 合同成立 → 原事务整批 apply → approved
  └─ 合同冲突 → 原事务 stale + 写入领域 outbox
                         ↓ commit 后
                    自动派资料员
                         ↓
              基于最新现场创建新 proposed
                         ↓
                 Owner 再次批准或驳回
```

- `topic_maintenance_reproposal_jobs` 是主题领域专用持久 outbox；与 stale 状态、冲突证据在同一个 dispatcher 事务提交。
- outbox 持久化稳定 `job_id`。现有 JobSpawner 增加仅内部使用的 caller-supplied jobId 幂等入口；普通 `jobs.spawn` 输入不扩权。
- Agent 只在审批事务提交后启动。进程在提交后崩溃，启动恢复扫描 outbox；同一进程重复 kick 不重复派工。
- 新提案以 `supersedes_proposal_id` 指向旧 stale 提案。旧提案冻结证据不改写、不复活、不自动 rebase、不自动批准。
- successor 创建与 outbox 完成同一事务；唯一索引保证一个 stale 父提案最多一个直接 successor。
- 自动执行失败做有界重试；耗尽后显示需要处理，但 Owner 仍不需要手工重建主题变更。

## 4. 历史 stale

迁移不扫描、不复活既有 stale。没有 outbox 的旧记录显示为“历史失效，未分类”；只有 v2 审批产生、带结构化冲突与 outbox 的记录进入自动重提。

## 5. 授权与 Skill（2026-08-10 主管授权翻转修订）

- 主管（软件内 supervisor）的批准仍只授权当前冻结提案；真冲突不执行旧变更，只触发资料员在原 workspace 范围重新整理。
- 资料员仍只有 propose 权；successor 仍需主管新批准（`agentGrantable:true`、`precise:false`、`{desk:true}`，仅主管可授予）。
- outbox 调度状态写是 scheduler 基础设施命令，不进入任何角色 grant。
- operator Skill、资料员 prompt、主管呈报同步说明：真冲突由系统重派，内部审批归主管，不要求 Owner 手工整理。

## 6. 验收

1. 无关 topic/source/review 漂移不阻塞；目标 revision、canonical 抢占、待迁移成员变化和目标同键冲突会 stale，且正式事实零写。
2. stale、结构化 conflict、唯一 outbox、审批 receipt 同事务；注入失败全部回滚。
3. commit 前不启动 Agent；commit 后自动派 librarian。重复点击、重复 kick、冷重启均只形成一个 successor。
4. successor 来自最新现场、指向旧提案并正常待批；旧提案不可再次批准。
5. 历史 stale 不自动复活；UI 明确区分历史失效、正在重提、重提失败和已由新提案接替。

## 7. Owner lock

Owner lock 2026-08-10：

1. 提案生成时固化唯一冲突合同，审批不得二次猜范围。
2. 只拦截会改变本次审批结果的真实冲突，无关现场漂移忽略。
3. 真冲突由系统自动派资料员基于最新现场重提，不能把整理工作退给 Owner。
4. 旧提案保持冻结并由新提案接替；新提案仍须 Owner 批准，禁止自动 rebase 或自动生效。
5. 历史误判与真正 stale 分开处理，禁止粗暴复活。
6. Non-goals：不做通用审批/工作流框架，不新增权限配置 UI，**不让员工或外部 Agent 代批（内部审批归主管，2026-08-10 翻转）**，不改变发布与硬删红线。
7. Route: Legislate。
8. 用户原话「我要彻底解决」授权按以上已经对齐的四项方向继续立法与施工，不要求魔法口令。

**§7 修订注记（2026-08-10 主管授权翻转，legislative）**：本节历史 Owner lock（2026-08-10）保留为历史；依 `docs/spark/2026-08-10-supervisor-authority-design.md` §5/§8-4，第 4 项「新提案仍须 Owner 批准」与第 6 项「不让桌助或 Agent 代批」修订为——**内部审批归主管**（主题应用命令仅主管可授予，`agentGrantable:true`/`precise:false`/`{desk:true}`）；员工与外部 Agent 不代批；红线恰三类（最终发布、硬删执行、外部平台变更执行），不含内部审批。
