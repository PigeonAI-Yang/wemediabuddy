# CAP-027 / 多 Worker 边界测试方案

- 日期：2026-08-07
- 状态：待 Owner 锁定后执行
- 触发：Owner 在刚拉起的开发版中，今日扫描进行时 Dock 报「当前 Pi worker lease 尚未释放」——证明此前「边界测试」只覆盖 JobPool 单测，**未覆盖主路径 Electron 并发**。
- 关联：`docs/spark/2026-08-07-desk-manager-job-runtime.md`、M-5110、截图事故（扫描占 desk 席）

---

## 0. 结论（先读）

1. **边界测试必须分四层**，缺一层就不许声称「测过并发」：
   - L0 纯逻辑（JobPool / lease map）
   - L1 主进程接线（谁占 desk / employee）
   - L2 无头/半集成（真 runtime + 假 Pi）
   - L3 有头 E2E（真 Electron 窗口，Owner 同款操作）
2. **P0 闸门（放行开发版给 Owner 前必过）**：今日扫描进行中，Dock 能说话且**不得**出现「Pi worker lease 尚未释放」。
3. 旧有 `job-pool-stress` **只算 L0**，不能再对外叫「边界测试完成」。
4. 每条用例必须：**前置 · 操作 · 期望 · 禁止现象 · 证据**；期望写用户可见句，不写“应该差不多”。

---

## 1. 目标与非目标

### 1.1 目标

验证「Desk 经理席 + 员工工单/后台任务」在真实产品路径上：

- **占座正确**：desk 只服务 Owner 对话；扫描/工单/studio 后台走 employee
- **并发正确**：扫描中可聊；双员工不冲突实体可并行；冲突实体有明确错误
- **回收正确**：取消/失败/完成后面板与 lease 不泄漏
- **背压正确**：maxWorkers、软帽、排队可解释

### 1.2 非目标

- 不测模型回答质量、文案文采
- 不测五路无界并行、多窗口 Electron
- 不测 CAP-026 注册表全矩阵（另有 `check:capabilities`）
- 不做「跑全量 tests/*.mjs 就算并发验收」

---

## 2. 风险地图（测什么由事故反推）

| ID | 风险 | 用户可见症状 | 根因层 | 曾暴露 |
| --- | --- | --- | --- | --- |
| R1 | 后台任务误占 desk lease | 扫描/跑任务时 Dock：「lease 尚未释放」 | L1 接线 | **是（Owner 截图）** |
| R2 | desk 双开 | 第二个对话/ensurePi 互踢 | L1 | 单测有 desk 独占 |
| R3 | complete 先于 release | 高压下后续工单软帽失败 | L1 spawner | 压力测已挖出并修 |
| R4 | maxWorkers 与 lease 软帽脱节 | 设 8+ 仍撞总帽 8 | L0/L1 | 已 clamp 员工≤7 |
| R5 | 同 planDate 双写 | 静默覆盖或怪错 | L0 锁 + 写路径 | 池级有；E2E 不足 |
| R6 | 取消不释放 | 取消后仍不能聊/不能再派 | L1/L3 | 未做有头 |
| R7 | UI 槽位谎报 | 班组工单 0 但实际在跑或反向 | L3 | 未做有头 |
| R8 | 扫描+派单+聊天三重 | 卡死/乱序 | L3 | 未做 |
| R9 | 软帽满时行为 | 挂死/OOM/无提示 | L0/L1 | fail-fast JOB_SLOT_BUSY |
| R10 | 进程重启/热更 | 旧 lease 语义残留 | L3 | 未做 |

---

## 3. 四层测试金字塔

```
L3 有头 E2E（Electron）     ← Owner 验收同款；P0 必须
L2 半集成（真 DB+runtime，假 Pi execute）
L1 接线契约（index/withRuntimeWorker purpose 断言）
L0 纯逻辑（JobPool/lease map/stress）  ← 现有 33 测主要在这
```

**放行规则：**

| 宣称 | 最低门槛 |
| --- | --- |
| 「池子逻辑 OK」 | L0 绿 |
| 「并发架构可开发自测」 | L0+L1+L2 绿 |
| 「可给 Owner 上手」 | **L0+L1+L2+L3-P0 全绿** |
| 「M-5110 闭环」 | 上表 + 证据包截图/日志 |

---

## 4. L0 — 纯逻辑（已有，保持）

**目录：** `tests/job-pool.test.mjs`、`job-pool-stress.test.mjs`、`job-spawner.test.mjs`、`workspace-runtime.test.mjs`

| 用例 | 期望 |
| --- | --- |
| L0-01 默认 maxWorkers=2 | 第 3 单 queued |
| L0-02 FIFO 晋升 | complete 后队首 running |
| L0-03 cancel 释槽 | 排队单晋升 |
| L0-04 planDate/projectId 锁 | 第二持锁 → JOB_LOCK_CONFLICT |
| L0-05 maxWorkers 边界 | 0/负/小数/拒绝；>7 拒绝 |
| L0-06 缩容 | 不杀 running，只挡新晋升 |
| L0-07 200 单 drain | 无卡死、槽归零 |
| L0-08 desk 独占 + multi employee | snapshots 可 desk+N employee |
| L0-09 软帽 8 | 第 9 个 lease busy |
| L0-10 软帽满 spawn | failed + JOB_SLOT_BUSY（不挂死） |

**命令：**

```bash
node --test tests/job-pool.test.mjs tests/job-pool-stress.test.mjs tests/job-spawner.test.mjs tests/workspace-runtime.test.mjs
```

**缺口（L0 补一条）：**  
`withRuntimeWorker` 不在 L0——必须在 L1。

---

## 5. L1 — 接线契约（P0，现在缺）

**目的：** 防止再出现「扫描占 desk」。不启动完整 UI，但断言 **源码/行为契约**。

### 5.1 静态契约（快、CI 必跑）

新建 `tests/worker-lease-wiring.test.mjs`（或脚本）：

| 用例 | 断言 |
| --- | --- |
| L1-S1 | `withRuntimeWorker` 内 `acquireWorkerLease(..., 'employee')` |
| L1-S2 | `ensurePi` 内 `acquireWorkerLease(..., 'desk')` |
| L1-S3 | `job-spawner` 仅 `employee` |
| L1-S4 | 禁止 `withRuntimeWorker` 再写 `'desk'`（正则/AST） |

> 静态不能替代动态，但能挡住回退。

### 5.2 动态契约（真 runtime，假 work）

| 用例 | 步骤 | 期望 |
| --- | --- | --- |
| L1-D1 后台占 employee | mock `withRuntimeWorker` 跑空 work，同时 `acquireWorkerLease(null,null,'desk')` | desk 可获取；snapshots 含 employee+desk |
| L1-D2 desk 占位时后台仍可 | 先 desk ensure，再 withRuntimeWorker | employee 成功；desk 仍在 |
| L1-D3 双 desk | 连续两次 desk acquire | 第二次 WORKSPACE_BUSY/尚未释放 |
| L1-D4 release 后 desk 可再取 | employee 跑完 finally release | desk 对话路径无残留 |

**禁止现象：** 任意后台路径 `purpose==='desk'`。

---

## 6. L2 — 半集成（假 Pi，真调度）

**目的：** 不依赖真模型 API，验证 spawn/list/cancel/锁/看板数据。

| 用例 | 步骤 | 期望 |
| --- | --- | --- |
| L2-01 双员工不同实体 | maxWorkers=2 spawn reporter+writer | 皆 succeeded；两 leaseId 不同 |
| L2-02 第三单排队 | 再 spawn planner | queued → 前序结束后 running |
| L2-03 同 planDate | 两单同 planDate | 第二 JOB_LOCK_CONFLICT 或失败码可见 |
| L2-04 cancel 半程 | running 时 cancel | ≤5s 终态；employee lease=0 |
| L2-05 jobs:list 与 pool 一致 | 并发中读 IPC | running/queued 计数一致 |
| L2-06 setMaxWorkers(3) | 扩容 | 排队晋升；>7 throw |
| L2-07 session 路径 | spawn 后 | 存在 `agent/sessions/job-<id>.jsonl` 约定（可空文件） |

**实现要点：** `JobSpawner({ execute: async () => { delay; return 'succeeded' } })`，已有基础，补 IPC 层测。

---

## 7. L3 — 有头 E2E（Owner 同款，P0 核心）

**环境：**

- 数据根：专用测试根或 Owner 当前根（需注明）
- 启动：`npm start` / hub `wmb-dev`
- 工具：手工清单 + 可选 Playwright/CDP（有则自动化，无则手工勾选）

### 7.1 P0 闸门（无此不开 Owner 验收会）

| ID | 名称 | 前置 | 操作 | 期望 | 禁止 |
| --- | --- | --- | --- | --- | --- |
| **E0-01** | **扫描中可聊** | 今日可点扫描；Pi 已配置 | 1) 点今日情报扫描 2) 进度条出现「正在扫描」3) 立即在 Dock 发「你好」 | 扫描继续；Dock **有回复或至少进入发送中**；底栏/气泡 **无**「Pi worker lease 尚未释放」 | 双份 lease 错误；扫描被聊天踢死（除非产品规定） |
| **E0-02** | **聊完扫描仍在** | E0-01 中 | 聊天一轮后看今日进度 | 渠道进度仍前进或可取消 | 进度冻死且无错误说明 |
| **E0-03** | **取消扫描后可聊** | 扫描中 | 点取消任务 → 再聊 | 取消成功；随后对话正常 | 取消后仍 lease 未释放 |
| **E0-04** | **班组工单 chip** | 扫描中 | 看「班组工单 N」 | N 与真实后台任务语义一致（或 0 但说明是日报非 jobs 体系——**若日报不走 jobs，chip 不计入则文档写明**） | 谎报导致以为没任务 |

> E0-04 若产品定义「日报 ≠ jobs 工单」，必须在 UI 文案区分「后台任务」vs「员工工单」，避免 Owner 以为 0 就是空闲。

### 7.2 P1 工单看板

| ID | 操作 | 期望 |
| --- | --- | --- |
| E1-01 | 智能体页派 1 记者（短 brief） | 出现 running；可取消 |
| E1-02 | 连续派 3 单 max=2 | 2 running + 1 排队 UI |
| E1-03 | 取消排队单 | 消失/终态，不占槽 |
| E1-04 | 今日 chip 跳转智能体 | 落到工单区 |

### 7.3 P1 扫描 ∥ 工单 ∥ 对话（三重）

| ID | 操作 | 期望 |
| --- | --- | --- |
| E1-10 | 扫描中 + 智能体派资料员 + Dock 说话 | 三线：扫描 employee、工单 employee、desk 对话；无 lease 尚未释放 |
| E1-11 | 扫描中点设置再回今日 | 状态不丢、无卡死 |

### 7.4 P2 压力（可周更）

| ID | 操作 | 期望 |
| --- | --- | --- |
| E2-01 | 快速连点扫描 | 单飞或明确拒绝，不双开 desk |
| E2-02 | 派单连点 10 次 | 排队/拒绝有提示，不崩 |
| E2-03 | 跑满员工 7 后再派 | 明确失败/排队文案，不白屏 |

### 7.5 每条 L3 证据

- 窗口截图（含底栏状态）
- 操作时间线（几点几分点了什么）
- 若失败：主进程日志尾 80 行（`.wmb-dev.out.log` / `.err.log`）
- 写入 `.ai/wmb-5110-l3-e2e-YYYYMMDD.md`

---

## 8. 用例优先级与排期

### Sprint A — 止血（半天，阻塞 Owner）

1. L1-S1～S4 静态接线（防回退）  
2. L1-D1～D2 动态 desk∥employee  
3. **E0-01～E0-03 手工有头**（你或自动化）  
4. 证据包 + 开发版仅在此绿后交付  

### Sprint B — 工单闭环（1 天）

5. L2-01～L2-07  
6. E1-01～E1-04  
7. E1-10 三重并发  

### Sprint C — 硬化（按需）

8. E2 压力  
9. 日报任务是否并入 jobs 语义 / chip 文案  
10. 热重载/重启 lease 残留  

---

## 9. 自动化建议（避免再「只跑 node 单测」）

| 层 | 手段 | CI |
| --- | --- | --- |
| L0 | `node --test` 现有 | 每 PR |
| L1-S | wiring 正则/AST 测试 | 每 PR |
| L1-D | runtime + mock execute | 每 PR |
| L2 | IPC 经临时 BrowserWindow 或直接调 register 函数 | 每 PR 或 nightly |
| L3 | Playwright/CDP 连 Electron；至少 E0-01 录制脚本 | nightly + release |

**CI 门禁文案（建议写进 verification.md）：**

```
并发相关 PR：
- 必须 L0 + L1-S 绿
- 改 withRuntimeWorker/ensurePi/job-spawner：必须 L1-D 绿
- 标 "owner-ready"：必须附 L3 E0-01 证据路径
```

---

## 10. 手工 L3 脚本（可直接照做）

### 脚本 A — 扫描中聊天（P0）

```
前置：开发版已起；Pi profile 可用；今日页
1. 打开今日
2. 点击开始/刷新情报扫描
3. 确认顶栏：正在扫描 + 渠道进度
4. 3 秒内切到 Dock，输入「你好」回车
5. 观察 15 秒

通过：
- 无「Pi worker lease 尚未释放」
- 扫描进度仍在或可取消
- 对话有回或明确「发送中/失败原因」且原因不是 lease

失败：截全屏（含底栏）+ 记时间
```

### 脚本 B — 取消后恢复

```
1. 扫描中点「取消任务」
2. 等状态非 running
3. Dock 再发「还在吗」

通过：正常对话；底栏无 lease 错误
```

### 脚本 C — 智能体派单

```
1. 侧栏智能体
2. 角色记者，brief「只回报你是谁」，派单
3. 看 running / 取消

通过：有工单行；取消后槽位回收
```

---

## 11. 与「为什么另开会话」的测试映射

| 设计主张 | 用哪条测伪 |
| --- | --- |
| Desk 不占员工槽 | E0-01、L1-D1 |
| 员工独立 session | L2-07 路径；L3 取消不影响 Desk |
| 同实体互斥 | L0-04、L2-03 |
| 背压 | L0-05、E2-03 |
| 扫描≠占话筒 | **E0-01（血的教训）** |

---

## 12. 定义「完成」

**边界测试方案执行完成** 当且仅当：

1. Sprint A 全绿且 E0-01 证据入库  
2. TASKS/证据不再把「仅 L0」写成并发验收完成  
3. CI 含 L1-S 防 desk 回退  
4. Owner 按脚本 A 复测通过一次  

**未完成信号（任一即否）：**

- 扫描中再聊出 lease 文案  
- 只有 job-pool 测试绿就开验收会  
- 开发版重启后未跑 E0-01  

---

## 13. 立即执行清单（给执行者）

- [ ] 落地 `tests/worker-lease-wiring.test.mjs`（L1-S）  
- [ ] 落地 L1-D1/D2 runtime 测  
- [ ] 手工或 CDP 跑脚本 A/B，写 `.ai/wmb-5110-l3-e2e-2026-08-07.md`  
- [ ] 确认日报任务与「班组工单」chip 语义（0 是否误导）  
- [ ] 通过后再 `npm start` 交给 Owner  

---

## 14. 附录：事故复盘（本方案的缘起）

| 项 | 内容 |
| --- | --- |
| 现象 | 今日扫描中 Dock/底栏：「当前 Pi worker lease 尚未释放」 |
| 错误回应 | 归咎「旧进程」——不成立，即为当次拉起的开发版 |
| 技术根因 | `withRuntimeWorker` 使用 `purpose:'desk'`，与 Dock `ensurePi` 抢席 |
| 测试根因 | 只做 L0，把压力当边界，**无 L3 P0** |
| 修复方向 | 后台 → employee；desk 仅对话；E0-01 永续回归 |
