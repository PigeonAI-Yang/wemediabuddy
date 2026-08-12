# WMB 内建 Wiki 与知识飞轮设计包

日期：2026-08-12  
状态：设计完整，待 Owner 审阅后进入实施计划与 TASKS 施工授权

## 设计真源与阅读顺序

1. [`WMB 内建 Wiki + 笔记与知识飞轮架构设计`](./2026-08-12-wmb-built-in-wiki-notes-architecture-design.md)  
   产品目标、全局知识核 + 赛道 Wiki、四大闭环、现有前端职责。

2. [`WMB 知识对象与版本契约`](./2026-08-12-wmb-knowledge-object-version-contract-design.md)  
   FreeNote、Entity、KnowledgeNote、WikiPage、证据、版本、ChangeSet、Receipt、QueryArtifact、HealthIssue。

3. [`WMB AI 知识编译协议`](./2026-08-12-wmb-ai-knowledge-compilation-protocol-design.md)  
   输入保存、候选提取、价值门、去重、消歧、来源质量、矛盾协调、Wiki 重编译和回执。

4. [`WMB 现有知识前端原位改造规格`](./2026-08-12-wmb-existing-knowledge-surfaces-retrofit-design.md)  
   主题、资料库、关系画布、Pi 和 Studio 原位升级，不新增平行 Wiki。

5. [`WMB 创作知识调用协议`](./2026-08-12-wmb-creation-knowledge-usage-protocol-design.md)  
   选题、简报、正文、平台适配、复盘的固定知识版本、裁剪、用途和血缘。

6. [`WMB 结果回流与知识健康协议`](./2026-08-12-wmb-outcome-feedback-knowledge-health-design.md)  
   发布结果的保守回流、局部/周期 Lint、HealthIssue、自动修复和主动综合。

7. [`WMB 知识飞轮迁移、施工拆分与端到端验收`](./2026-08-12-wmb-knowledge-flywheel-migration-delivery-acceptance-design.md)  
   历史初始化、M1–M8 施工顺序、切换、真实场景、数据不变量和发布闸门。

## 不可破坏的统一决策

- 不连接 Obsidian 或其他知识软件；
- SQLite 是唯一事实源；
- 不新增顶层 Wiki 应用；
- `LibraryTopicsView` 是唯一 Topic Wiki 前端；
- `LibraryView` 承担 Raw、Evidence、Inbox、Receipt 和 Health；
- `KnowledgeCanvasView` 是引用式关系、变化和健康探索，不是真源；
- Pi 的好答案自动去重写回；
- 创作保存实际采用的固定知识版本；
- Review 和指标只形成保守证据，不自动声称因果；
- 所有正式知识更新经原子 ChangeSet，自动生效、版本不可变、可恢复；
- 内部结构默认隐藏，用户不管理知识卡、关系或证据表单；
- Ingest、Query、Lint、Creation 四个闭环必须以真实工作空间端到端通过。

## 实施入口

下一步不是继续扩展设计，而是将 M1–M8 转为项目实施计划和 `TASKS.md` 施工任务。必须先冻结跨阶段接口，再从 M1 核心存储和命令开始；M2 只实现一个真实 Source 更新既有 Topic Wiki 的最小编译闭环，验证体验后再铺开后续阶段。
