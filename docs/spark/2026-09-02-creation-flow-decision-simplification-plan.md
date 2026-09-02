# 创作流程决策点精简实施计划

状态：实施中  
日期：2026-09-02  
里程碑：M-5391  
任务：WMB-5391–WMB-5395

## 1. 问题

当前专项创作链已经具备真实 Planner、Owner、Reporter、主管验收、Writer、来源追溯、任务回执和重启恢复能力，但内部状态机被直接暴露为用户流程。一个普通选题可能要求 Owner 依次执行：批准方案、开始调查、批准提纲、验收资料包、批准写作方向、开始写作、审阅正文。

其中只有两类判断必须由 Owner 完成：

1. 选题及中心主张是否值得生产。
2. 最终成稿是否满足发布要求。

提纲生成、资料包验收、写作方向冻结和 Writer 派发属于内部生产控制。默认把这些步骤交给 Owner，造成重复授权、跨页寻找操作和流程停滞。

## 2. 决策

将正常路径收敛为一次生产授权：

```text
候选方案
  → Owner 批准并开始创作
  → 自动建项目
  → 自动初始化调查
  → 主管拟定并冻结提纲
  → Reporter 调查
  → 主管验收资料包并冻结写作方向
  → 自动派 Writer
  → 正文待审
  → Owner 审稿
```

底层状态、不可变版本、来源 SSOT、主张锁、receipt、幂等恢复和人工发布边界全部保留。只收敛默认用户决策点，不删除真实性与安全门。

## 3. 产品合同

### 3.1 单一生产授权

- Proposals 的批准主动作统一为“批准并开始创作”。
- 批准命令成功后，必须复用现有 Plan Item → Content Project 身份链并自动推进生产。
- 同一批准 requestId 重放不得复制项目、调查档案、任务或正文版本。
- 已批准项目的恢复必须从当前真实状态继续，不回退到早期人工按钮。

### 3.2 正常路径自动推进

- 调查档案自动初始化，不再要求 Owner 点击“开始调查”。
- 主管负责生成并冻结调查提纲；正常提纲不再要求 Owner 审批。
- Reporter 资料包交付后，主管自动验收。
- 证据足够时，主管形成并冻结写作方向，自动派 Writer。
- `ready_to_write` 不再要求 Owner 再次点击“开始写作”。

### 3.3 异常才请求 Owner

只有以下情况可进入可见 `needs_user`：

- 调查范围或中心主张相对批准方案发生实质变化。
- 现有证据无法支持可核查事实，需要选择补查、收窄、观点稿继续或停止。
- 外部权限、凭据、费用或敏感业务取舍需要 Owner。
- 状态机检测到冲突、陈旧 revision 或无法安全自动恢复。

普通内部阶段、任务 ID、revision、receipt 和工单细节不得成为 Owner 的必经操作。

### 3.4 渐进披露

- Studio 默认围绕正文和当前生产状态。
- 调查作为“依据与进度”详情存在，可查看完整提纲、资料包、来源、方向、任务和历史。
- 默认只展示当前阶段、来源数量、证据缺口、冻结方向和真实错误恢复动作。
- 高级详情保留全部审计能力，不建立第二套调查数据或 UI 状态。

### 3.5 Today 与 Proposals 职责

- Today 只回答“现在最该处理什么”。
- 选题批准、否决和完整方案只在 Proposals 的同一详情面完成。
- Today 的待批准入口必须深链到对应 Proposals 详情，不复制审批表单或命令。

## 4. 不改范围

- 不修改 foundation 品牌 token。
- 不新增数据库或平行来源库，除非现有状态无法表达本计划合同；若无需 schema，则保持 v81 不变。
- 不删除调查历史、来源、claim、主张锁、版本或 receipt。
- 不放宽事实真实性、Writer 主张锁、权限、Capability、发布和人工最终确认边界。
- 不恢复 legacy daily orchestration 或绕过 Workspace Orchestrator。
- 不把失败、部分完成或证据不足包装为成功。

## 5. 实施任务

### WMB-5391：冻结计划与任务合同

交付：本计划、活动任务台账、明确的顺序依赖和验收命令。  
验证：`npm run check:task-ledger`。

### WMB-5392：单一授权与自动生产推进

交付：批准方案后自动初始化调查并按真实状态续派；正常提纲自动冻结；`ready_to_write` 自动派 Writer；全部命令保持幂等和精确身份。  
重点文件：`src/main/plan-item-approval.ts`、`src/main/project-investigation.ts`、`src/main/project-investigation-supervisor.ts`、`src/main/job-pool.ts` 及现有调用方。  
验证：新增聚焦行为测试，覆盖一次批准到 Writer 派发、重放零复制、恢复续派、失败真相。

### WMB-5393：异常驱动的 Owner 决策

交付：正常资料包自动验收和冻结方向；只有主张变化、证据不足或外部边界进入 `needs_user`；保留补查、扩展、观点稿、停止四类真实恢复。  
重点文件：调查 domain、主管 runner、needs-user 投影及聚焦测试。  
验证：聚焦状态矩阵证明正常路径零 Owner 中间审批，异常路径仍 fail-closed 且可恢复。

### WMB-5394：Studio 与 Today 交互收敛

交付：Studio 默认正文/生产状态，调查降为可展开“依据与进度”；删除正常路径的开始调查、批准提纲、验收资料包、批准方向和开始写作按钮；Today 待批准入口只深链 Proposals；批准按钮使用“批准并开始创作”。  
重点文件：`src/renderer/studio-investigation-panel.tsx`、`src/renderer/studio-view.tsx`、`src/renderer/proposals-view.tsx`、`src/renderer/today-view.tsx`、现有 Studio CSS。  
验证：renderer 聚焦合同、设计 token 漂移门和真实 Electron 1100×800 主路径。

### WMB-5395：端到端验收与清理

交付：同一真实工作空间完成方案批准到正文待审；确认正常路径仅一次生产授权；异常项目仍显示真实决策卡；删除由本次切换产生的孤立按钮、文案、处理器和测试 fixture。  
验证：真实 Electron 场景、聚焦测试、`npm run typecheck`、`node --test tests/design-tokens-drift.test.mjs`、`npm run check:task-ledger`。

## 6. 验收标准

1. 正常项目从方案批准到 Writer 开始执行只需一次用户点击。
2. 正常路径不显示调查提纲审批、资料包验收、方向审批或开始写作按钮。
3. 证据不足、主张变化和外部边界仍会生成可见且可执行的 Owner 决策。
4. Proposals 是唯一选题审批表面；Today 仅导航到该表面。
5. Studio 默认显示正文或明确的生产中状态，完整调查记录仍可展开查看。
6. 同一 request 重放与应用重启不复制项目、调查、任务或版本。
7. 来源、主张锁、版本、receipt、权限和人工发布边界不退化。
8. 1100×800 无横向溢出，page error 为 0，foundation token 无漂移。

## 7. 停止条件

WMB-5395 通过后停止流程级删减。后续只根据真实使用证据修复局部卡点，不再预设新的审批层或并行工作台。
