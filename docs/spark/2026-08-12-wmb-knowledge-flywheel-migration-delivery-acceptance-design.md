# WMB 知识飞轮迁移、施工拆分与端到端验收

状态：实施前交付规格  
日期：2026-08-12  
范围：现有系统迁移、施工顺序、切换和真实验收，不授权实现

## 1. 目标

在不破坏现有 Source→Topic→Opportunity→Content→Publication→Review 闭环的前提下，原位升级为内建 Wiki 知识飞轮。禁止大爆炸替换、双写长期存在、伪造历史版本和创建平行 Topic/Source 身份。

## 2. 迁移原则

- SQLite 单一真源；
- 只追加 schema，迁移阶段不改写原始正文；
- 现有对象 ID 全保留；
- 新读模型可回退到旧 dossier/context；
- 新写路径启用后清除旧写路径，不留长期兼容 shim；
- 每阶段有独立可观察验收和回滚边界；
- 公开发布和平台红线不变。

## 3. 现有对象映射

- `source_items` → Evidence/Raw，不复制；
- `topics` → Topic 稳定身份，不复制；
- `topic_source_links` → 既有来源关系，继续有效；
- `method_findings` → 编译 Method 候选，不原地冒充 KnowledgeNote；
- dossier/context → 旧数据读模型与 Wiki 编译输入；
- Canvas nodes → 引用布局，不迁移为知识对象；
- content/publication/review → 使用和结果证据；
- command receipts → ChangeSet/KnowledgeUpdateReceipt 追溯基础；
- retired knowledge domain UI → 删除；数据若仍有真实使用，映射 Scope Map 后再决定归档。

## 4. 历史初始化

不得批量声称历史知识已被完整验证。初始化顺序：

1. 建立 Global/Lane Scope；
2. 为现有 active Topic 创建唯一 Topic WikiPage 身份；
3. 使用 topic.summary + dossier 生成 `migration` 初始 Wiki 版本，标明 derived from legacy data；
4. 从高价值 verified Source、final Review、Method Finding 提取候选；
5. 仅在证据明确时创建 KnowledgeNote；
6. 其余保留为 Raw/Evidence，交后续增量编译；
7. 创建初始化回执和健康问题；
8. 数量、ID、关系和发布链迁移前后一致。

历史初始化不自动合并 Topic，不把所有提及词创建 Entity，不伪造过去的 ChangeSet。

## 5. 施工阶段

### M1：核心存储与命令

交付稳定对象、不可变版本、EvidenceLink、Relation、Annotation、ChangeSet、Receipt、QueryArtifact、HealthIssue；注册 capability、dispatcher、requestId 幂等和 read APIs。

验收：事务零部分写、revision 冲突、恢复追加版本、合并链防循环。

### M2：编译器最小闭环

只支持 ingest 一个 Source→现有 Topic Wiki→Receipt。先覆盖 Claim、Entity、qualify/disputed，不一次实现所有主动综合。

验收：真实资料更新旧 Wiki，不生成孤立摘要；低价值输入零知识成功。

### M3：主题与资料库原位改造

升级 `LibraryTopicsView`、`LibraryView`；加入当前综合、变化、证据、版本、回执、待处理和健康。删除退役平行组件。

验收：无新增顶层 Wiki；深链和自动刷新成立。

### M4：关系画布改造

扩展允许引用类型，增加关系/变化/健康视图，dataChanged 订阅和正式详情跳转。

验收：节点仍是引用；删除节点不删知识；刷新不丢交互状态。

### M5：Query 写回

Pi 形成 QueryArtifact、去重、写回和本次沉淀。

验收：纯复述不重复；新综合更新 Synthesis；用户纠正先保留 FreeNote。

### M6：创作调用

Knowledge Usage Package/Record 接入选题、简报、Studio、平台版本。

验收：实际使用可追溯，consulted 不冒充 used，平台适配不改核心事实。

### M7：结果回流与健康

Review 编译、局部 Lint、周期 Lint、HealthIssue、自动确定性修复和主动综合。

验收：单次结果不伪因果；任务可暂停恢复；争议不被强行消除。

### M8：旧路径清理与完整验收

删除旧提示词式可选查询、固定轮询、持续关注双轨、退役路由、本地存储旧键和无调用 APIs。执行真实端到端验收。

## 6. 跨阶段接口冻结

在 M1 前冻结：

- 对象类型和生命周期；
- ChangeSet/Receipt schema；
- 编译输入 envelope；
- Usage Package/Record；
- HealthIssue；
- dataChanged scopes；
- Topic/Source/Canvas 深链协议。

后续变更必须迁移所有调用方，禁止双 schema 长期共存。

## 7. 数据切换

- 读路径可短期 feature-gated 回退旧 dossier；
- 写路径不能双写两套知识；
- 新编译器启用前旧业务继续运行；
- 启用后所有知识写入只经 ChangeSet；
- 失败回滚只回退功能开关和未提交迁移，不能删除已成功不可变版本；
- schema migration 必须幂等并有备份/checkpoint。

## 8. 真实端到端场景

### 场景 A：Ingest

现有 AI Agent Topic 已有 Entity、Claim、Method 和内容历史。摄取新官方资料：命中 Entity，新增 Claim，官方新事实替代过期事实，另一解释保持 disputed，Topic Wiki 更新，回执出现并影响真实选题。

### 场景 B：Query

用户向 Pi 比较两份资料。回答使用固定 Wiki/Knowledge 版本，形成新限定和 Synthesis，自动写回；再次同问不重复创建。

### 场景 C：Creation

从该 Topic 批准选题，生成简报和正文；实际知识版本可见，争议正确表述，平台版不改事实。

### 场景 D：Review

回填稳定 Publication、指标和复盘。单次结果形成观察和限域，不写因果；Wiki 更新并在下一轮选题出现。

### 场景 E：Lint

故意制造 stale 页面、broken reference、可信来源冲突和重复实体候选。确定性问题自动修复；冲突保持 open；合并不确定不执行。

### 场景 F：恢复与并发

两个 Agent 基于同一旧 revision 编译。首个成功，第二个零写冲突重编译。用户恢复旧 Wiki 产生新版本，旧错误版本仍可读。

## 9. 数据不变量验收

- Source、Topic、Content、Publication、Review 数量和 ID 不丢失；
- 旧贡献链仍可查询；
- 一个 Topic 只有一个稳定身份；
- 不可变版本不可 UPDATE/DELETE；
- Evidence 指向存在对象和固定版本；
- merged/superseded 无循环；
- requestId 重放不增行；
- Canvas 删除不删除正式对象；
- 工作空间和 data-root 不串线。

## 10. 产品体验验收

- 用户投入资料后能在同一工作流看见知识变化；
- Topic 默认可读，不先展示内部对象表；
- 资料库可读 Raw、Evidence、Receipt 和 Health；
- 画布可看关系、变化和健康；
- Pi 问答会沉淀；
- 创作可见实际采用知识；
- Review 进入下一轮；
- 用户无需分类、建链接或维护知识卡；
- 无 Obsidian 或外部软件依赖。

## 11. 工程验证策略

- 每个永久契约新增行为测试；
- migrations 使用真实旧 schema fixture；
- ChangeSet 事务、幂等、revision 和恢复使用数据库集成验证；
- 编译器使用固定输入和可证伪预期，不测试 prompt 文本；
- UI 用真实运行应用验证 Topic/Library/Canvas/Pi/Studio；
- 端到端使用一套可清理的本地 workspace fixture；
- 最终烟测运行实际 Ingest→Query→Creation→Review→Lint，而非只跑测试文件。

## 12. 发布闸门

不得发布如果：

- 仍有平行 Topic/Wiki 身份；
- 编译失败可产生半对象；
- Query 纯复述制造知识；
- Studio 无实际 usage 血缘；
- Review 自动写因果；
- Lint 自动消除不确定争议；
- UI 要求用户管理内部对象；
- 真实最小闭环未通过。

## 13. 完成定义

M1–M8 全部通过，六个真实场景成立，旧路径清理完成，四大闭环在同一工作空间端到端可观察，才算知识飞轮交付完成。任何“表已建”“API 已通”“页面已搭”都不是替代证明。
