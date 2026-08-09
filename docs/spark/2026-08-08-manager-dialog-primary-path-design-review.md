# 主管对话框主路径设计 · Designer 审计

Date: 2026-08-08
Author: ManagerDialogDesigner（设计意见，只读审计，无代码改动）
Reviewed:

- `docs/spark/2026-08-08-manager-dialog-primary-path-design.md`（主审）
- `docs/spark/2026-08-08-manager-as-primary-agent-design.md`（控制面目标）
- `docs/spark/2026-08-08-manager-orchestration-design.md`（MCP 工具切片）
- `docs/spark/2026-08-07-fixed-role-agents-ux-design.md`（固定角色 UX）
- `docs/spark/2026-08-07-product-form-agent-desk-constitution.md`（产品形态宪法）

代码取证（只读）：`pi-dock.tsx` / `pi-dock-header.tsx` / `pi-dock-transcript.tsx` / `today-view.tsx` / `today-command-bar.tsx` / `today-run-view.ts` / `discover-view.tsx`。

---

## 1. Verdict

**是——「点今日情报 = 对话里派工」作为主路径模型成立**，且是宪法（Codex Desktop 型 Agent 主路径）的正确实现：按钮下单、主管接单、员工 subagent、人在对话里监工与批关键节点、可批对象落 Today。比现状「按钮旁路管道 + 班组页监工墙」更贴合产品形态。

但有保留：**必须同时落地 M1–M5 五条 Must-fix 才允许进入 P1 实施**，其中 M2（结构化消息 = 主进程契约）与 M5（收件人模型与 fixed-role 文档冲突裁决）是两个文档层面尚未闭合的语义分叉，需要 Owner 一句话锁定。若跳过 M1（单一事实源）直接上卡片，现码里已经存在的双进度源会立刻打架。

一句话：**方向对，但「对话成为主舞台」这个体感靠的不是聊天渲染，而是 ManagerTask 作为唯一真源 + 结构化消息契约 + 收件人模型裁决这三件事。**

---

## 2. Must-fix（P1 阻塞项）

### M1. 单一事实源：ManagerTask 是唯一进度真源，现码三处会打架

文档 §9 承诺「命令条与对话任务卡同一事实源」，但现码里已经存在三个互相独立的进度面：

- `today-view.tsx:159-172` 每 5s poll `getAgentTask({ intent:'daily_intelligence' })`（running 时），Today 命令条据此渲染；
- `discover-view.tsx:175` `discover-task-stream`（`role="status"`），发现页独立读同一 intent 的 agent_task；
- 新方案加入的 dock 任务卡。

三处若各自读各自的来源，文档自己的验收第 4 条「命令条与任务卡状态一致」必然翻车。**必须：今日情报入口 `startDailyIntelligence`（today-view.tsx:262）改道 `dispatchManagerTask`；三处全部改为投影同一 ManagerTask row / 同一事件流；`controlDailyIntelligence` 的 cancel（:349）与 save_partial（:317）迁到 ManagerTask 语义。** 任何新的进度呈现（命令条/值班条/科室流/班组页）必须在设计时显式声明投影源 = ManagerTask，并加 dev 断言：同一时刻命令条与任务卡数字一致。

### M2. 结构化消息类型是主进程契约，不是渲染层后补

任务卡 / 编排事件 / 呈报卡需要：

- 扩展 `PiChatMessage` / `PiMessageSegment`（`main/pi-conversation.ts`，现 `PiDockMessage = PiChatMessage`，只有 assistant/user/tool 等段型）增加结构化 kind；
- 持久化 + 会话回放（`wmb_list_manager_tasks`，doc §7.3 已列但必须进 P1 计划，不是 P2）；
- streaming 就地 patch：同一 taskId 卡片按 taskId 索引更新，避免整卡重插。

这是跨进程（main ↔ renderer）契约，工作量主要在 main 侧。P1 计划必须包含主进程改造与旧会话数据迁移，否则渲染层做不了任何事。

### M3. waiting_human 分叉：微决策留对话，批准回 Today

宪法：最终可批对象落 Today/Proposals，「不落在聊天里假装完成」。因此：

- **对话内**：改目标、取消、继续（微决策，本身即对话内容）；
- **跳转**：批方案/批选题/去创作 → 任务卡 waiting_human 主按钮 = 「去今日批准 →」，聚焦 Today 主席可批/Proposals 对应对象。

**禁止在聊天里做完整批准 UI**（勾选/确认表单进 dock）。聊天是讨论面，Today 是决策面——这正是「对话框是作战室」与「不变成聊天 App」的分界。

### M4. P1 串行 ManagerTask，第二个点击 = 按钮即提示

P1 只允许一个 active ManagerTask。运行中再点「今日情报」→ 命令条主按钮变「对话中 · 查看进度」（聚焦 dock 任务卡），不派第二单、不弹错误 toast。理由：(a) desk 单一主管租赁、单一编排焦点；(b) 双时间线在同一对话里交错 = 双进度反模式；(c) 并行属于 P3（会话级作用域、每单独立时间线）。

**明确区分**：一单内的并行 job（记者扫描 + 写手起草并行租赁，doc 3 F3 的场景）**允许且鼓励**；并行 ManagerTask **P1 禁止**。文档要写明这个区分，否则 doc 3 的 F3 会误导实现。

### M5. 收件人模型冲突裁决（与 fixed-role UX 文档的语义分叉）

- 本稿（primary）：人只对主管说话；员工是 subagent；员工不直接与人对话。
- `2026-08-07-fixed-role-agents-ux-design.md`：单 dock + 收件人切换，点员工名牌 = 「给这位员工打电话」，每角色独立会话/租赁，人可直接问记者进度（F2）。

两者直接冲突：**员工到底是「主管的 subagent」还是「人可以直接通话的同仁」？** 本稿 Q7 自认了这个矛盾但未裁决。

Designer 建议（P1 裁决）：**dock 收件人钉死主管**；员工名牌降级为**状态投影**（谁在跑/卡在哪，只读），点击 = 问主管或跳智能体页；直接员工对话是「第二个指挥官」，与「员工 = subagent」硬规则矛盾，P1 不做，P3 再议。此裁决需 Owner 一句话锁定，并回写两文档互相引用，否则实现阶段必撕裂。

---

## 3. Should-improve

### S1. 编排事件密度（答 Q2）

时间线只记**主管级决策 + 角色级里程碑**：派单 / 角色完成 / 失败 / 卡点 / 接力 / 呈报。员工内部工具行一律进 SubagentBlock 折叠区。节流：同一 job 每 30–60s 至多一条时间线事件；「扫描 3/5」这类进度**只 patch 卡片、不上时间线**。时间线 = 决策日志（低密度、可扫读）；卡片 = 进度条（高密度、就地 patch）。验收叙事里的「进度 2/5」应理解为卡片 patch，不是事件行。

### S2. 任务卡钉顶 vs 内联（答 Q1）

**内联卡片 + 头部迷你状态条**，不是全卡钉顶。全卡钉顶会：(a) 变成 dock 内第二状态栏；(b) 挡住输入框风险；(c) 与对话流割裂。方案：

```
PiDockHeader 下新增 ManagerRunStrip（≤1 行）：
  [状态点] 今日情报 · 记者扫描 3/5 · [查看]
  点击 → 滚动聚焦对话内任务卡
```

这是 build-status 同款模式（GitHub Actions 式），不是聊天 App 病。全卡留在对话流内作为结构化消息。任务完成后 strip 消失，卡片留在对话里（当日）。

### S3. SubagentBlock 展开深度（答 Q3）

允许展开看完整 tool-line（复用 `PiToolLine` 视觉语言，组件已存在），但：默认折叠；streaming 期间不自动展开；单块渲染上限（建议最近 50 行）+「查看完整日志」跳智能体页；块内只读、无交互。主编需要透明性，但默认态必须克制。

### S4. 命令条降级（答 Q4）

运行态命令条 = **下单按钮 + 一行投影**（状态词 + 「查看对话进度 →」）。删除命令条内的 phase 细节文案（「正在扫描情报渠道」「正在生成今日运营方案」这类，见 today-run-view.ts 现状）——那是第二控制台。阻塞类（needs_user）保留在 Today blockers（决策面），dock 卡显示 waiting_human，两者指向同一 ManagerTask 状态。`deriveTodayRunView` 改从 ManagerTask 投影。

### S5. 空/忙/卡/失败文案（答 Q8，示例，敏锐克制主编台）

| 态 | 文案 |
|---|---|
| 主管空态（dock 无任务） | 「主管在。今日情报尚未开始——在今日页点「开始今日情报」即可下工单。」 |
| 运行中（卡上） | 「今日情报 · 主管已派记者扫描 5/8 渠道 · 最新：{来源}」 |
| 等待你（卡上） | 「策划方案已呈报。去今日批准 →」 |
| 部分成功 | 「记者完成 5/8 渠道，2 个失败（{列表}）。方案已生成但不含这些渠道 → 查看方案」 |
| 失败 | 「今日情报卡住：渠道 {X} 登录失效 → 去设置修复」 |
| 取消确认 | 「取消会停止已派记者并保留已入库资料。取消？ 」 |

规则（沿用 doc 3 §7）：永远回答「谁 + 在干什么 + 卡在哪 + 主编能做什么（等 / 催 / 批 / 派）」。**禁止**「正在全力为您处理」「任务处理中…」类 AI 服务腔；禁止编造 ETA 与未发生的成功（doc §8 已有，需进验收）。

### S6. 模型控件存量清理（anti-goal 3）

dock 现码有模型菜单（`pi-dock.tsx` modelLabel / modelMenuOpen）。主管主路径下对话面必须零模型控件：主管名牌只显示「主管」，模型是角色预设（设置页配置）。P1 顺带隐藏存量菜单，否则与宪法 anti-goal 3 直接冲突。

### S7. 会话菜单稀释「作战室」语义

header 会话菜单若主管会话与一堆普通 Pi 会话平铺，会稀释「主管 = 作战室」的语义。P1 建议：主管会话组高亮置顶，或新建会话默认落主管收件人。

### S8. reduced motion / 视觉

状态点沿用颜色 + 文字双编码（WCAG AA，doc 3 §8 已约定）；卡片 patch 无闪烁无脉冲；滚动跟随仅在 `isPiConversationNearBottom`（既有 util）时发生；角色色先入 token 再入卡，禁止散落 hex。

---

## 4. Owner 待决问题（实现前需一句话锁定）

1. **收件人模型终局**：dock 永远钉死主管（严格 subagent 版，我建议）vs 保留名牌切换（doc 3 同仁版）？P1 裁决建议：钉死 + 名牌降级为状态投影。
2. **直接员工对话去留**：doc 3 F2「点记者问进度」是否保留为只读询问？若保留，双指挥权（人命令员工 vs 主管编排）如何仲裁？建议 P1 全部经主管（主管有 `message_job`）。
3. **并行 ManagerTask 终局**：P3 允许多单并行（会话级作用域）还是永远单执行轨？P1 已建议串行，但需要终局表述防止 P3 反悔时推倒重来。
4. **waiting_human 微决策清单**：改目标/取消/继续留对话，「批方案/批选题」跳 Today——清单是否锁定？「继续」确认弹窗是否也迁对话内？
5. **逃生舱可见性**：`legacy_pipeline` 是设置项 + 隐藏手势，还是仅隐藏手势？（P1 验收说「默认不再直打旧管道」，需明确用户可见性）
6. **discover-task-stream 去留**：发现页的 `role="status"` 任务流是保留为前线投影，还是并进副舞台只留智能体页？（现码存在，三面投影要统一口径）
7. **任务卡生命周期**：已呈报/已完成卡片保留到何时？次日是否归档？（影响 strip 显隐与持久化范围）

---

## 5. 建议组件层级（Recommended component hierarchy）

```
PiDock（既有壳，主进程消息契约扩展）
├── PiDockHeader（既有）
│   ├── 会话 trigger（改：主管会话组置顶高亮）
│   ├── context chip / authority chip（既有，不动）
│   └── ManagerRunStrip（新 · ≤1 行迷你状态条：状态点 + 一句话 + 滚到卡）
├── PiDockTranscript（既有）
│   ├── PiDockMessage（扩展 PiMessageSegment：新增 structured kinds）
│   │   ├── ManagerTaskCard（新 · 唯一 live 播报器）
│   │   │   ├── 状态点（双编码） + 标题 + 当前步骤（lastHumanVisibleSummary）
│   │   │   ├── SubagentChip 行（子任务 chips：角色 + 状态）
│   │   │   └── 主按钮（取消 | 继续 | 去今日批准 | 查看方案 · 随状态变）
│   │   ├── OrchestrationEvent（新 · 里程碑级时间线行，低密度）
│   │   ├── SubagentBlock（新 · 默认折叠；展开复用 PiToolLine，只读，≤50 行）
│   │   └── ReportCard（新 · 摘要 3–6 条 + CTA：打开今日方案 / 去创作）
│   └── 既有 assistant/user/tool-line 消息（不动）
└── PiComposer（既有 · placeholder 随任务态/收件人变）

Today 侧（全部为 ManagerTask 投影，不新增原子）
├── TodayCommandBar（改：下单按钮 + 一行投影 + 「对话中 · 查看进度」）
└── TodayBlockers（既有 · waiting_human 的批准面 / 阻断修复面）
```

新原子共 **5 个**：ManagerTaskCard、OrchestrationEvent、SubagentBlock、ReportCard、ManagerRunStrip。其余全部复用既有 token / 组件（状态点双编码、pi-tool-line、command-bar token、编辑台克制皮肤）。不需要新对话框壳、不需要新页面。

---

## 6. P1 验收增量（P1 acceptance deltas）

保留原 5 条，并作以下增补/强化：

1. ✅ 点今日情报 → 主管对话出现任务卡并自动开跑（保留）
2. ✅ 对话可见：已派记者、进度摘要、完成/失败（保留）
3. ✅ 人可在对话取消（保留）
4. **强化**：命令条 / 值班条 / 科室流 / dock 卡**全部投影同一 ManagerTask**，同一时刻数字一致（可断言，M1）
5. ✅ 默认不再 UI 直打旧管道（保留；逃生舱可见性按 Q5 裁决）
6. **新增**：dock 出现主管身份 + ManagerRunStrip；员工名牌为状态投影，无直接员工对话入口（M5）
7. **新增**：运行中再次点击「今日情报」→ 按钮变「对话中 · 查看进度」，不产生第二个 ManagerTask（M4）
8. **新增**：waiting_human 卡主按钮跳 Today 主席可批；对话内无完整批准 UI（M3）
9. **新增**：结构化消息（卡/事件/呈报）可持久化并在恢复会话时回放（M2，`wmb_list_manager_tasks`）
10. **新增**：状态迁移在**单一** live region 播报，patch 静默；dock 卡与 Today blocker 不双播（§7）
11. **新增**：对话面零模型控件；主管名牌不显示模型名（S6）
12. **新增**：时间线仅含里程碑级事件；「3/5」类进度仅 patch 卡片（S1）

---

## 7. 无障碍：live region 策略（答 Q10）

- **一个播报器原则**：ManagerTaskCard 容器 = 唯一 `role="status" aria-live="polite"`（或视觉隐藏 live region 播报 `lastHumanVisibleSummary` 的变化）。**只有状态迁移（accepted→running→waiting_human→reporting→终态）或摘要语义变化才播报**；「3/5 → 4/5」数字 patch 静默或节流（≥3s 且内容不同才播）。`aria-atomic=false` + 文本 diff。
- 时间线 = `role="log" aria-live="polite"`（追加语义，不整体重读）；因只含里程碑行，天然低吵。
- SubagentBlock 无 live region；内部变化并入卡片摘要或完全静默。
- **防双播**：dock 卡与 Today blockers（现 `role="status"`）只择一播——按焦点裁决：焦点在 dock → 卡播；焦点在 Today → 命令条/阻断区播。P1 最简实现：只在 dock 卡播，Today 侧静态。
- patch 不夺焦点；自动滚动仅在对话接近底部（`isPiConversationNearBottom` 既有 util）时跟随；`prefers-reduced-motion` 下全部静默更新。
- 状态点双编码（颜色 + 文字）沿用，WCAG AA。

---

## 8. Anti-goals 检查表

| 反目标 | 状态 | 说明 |
|---|---|---|
| 聊天 App 漂移 | ⚠️ 基本可防，残留 2 处 | 主缓解成立：Today 仍桌、命令条下单+投影、批准落 Today、事件低密度、strip 非 feed。残留：(a) 会话菜单若普通 Pi 会话与主管会话平铺会稀释作战室语义（S7）；(b) 模型菜单存量（S6）。 |
| 双进度源 | ❌ **现码已违反** | today poll 5s + discover 流 + 未来 dock 卡 = 三面。M1 必修，否则必打架。 |
| 自动多跳 | ✅ 设计可防，需工具层硬化 | 员工禁转派 + 单跳有界 + UI 不出边。建议：主管「先派记者，未完不派策划」不只靠 skill 提示，`spawn_job` 工具层加 phase 门校验（spawn planner 时要求 reporter 子任务成功终态），否则提示词不可证伪。 |
| 反模式对照（doc §3） | ✅ | dock 做 5 个聊天首页 → 名牌降级投影后不成立；进度只写命令条对话空白 → M1 保证卡片真源；必须开班组页才知派没派 → 卡片 + strip 解决。 |
| 一次点击多个互不关联后台任务且对话不感知 | ✅ | `dispatchManagerTask` 返回 managerTaskId + 立即插卡，对话可见。 |

---

## 9. Feasibility notes（读码所得）

- `pi-dock-header.tsx` **现无收件人概念**（标题「Pi」+ 会话菜单 + context/authority chip）。「默认收件人 = 主管」需要新增身份/收件人槽位；P1 最小实现 = 钉死主管 + 名牌文案 + strip，不做完整分段控件。
- `pi-dock-transcript.tsx`：`PiDockMessage = PiChatMessage`，已有 `PiToolLine`、活动标记 `role="status" aria-live="polite"`、native queue live region——SubagentBlock 复用 tool-line 视觉可行，live 策略有可参照先例。
- `today-view.tsx:262` `window.wmb.startDailyIntelligence` 直打管道，`:172` running 时 5s poll，`:317/:349` cancel/save_partial 走 `controlDailyIntelligence`——改道点与迁移面明确。
- `discover-view.tsx:175` `discover-task-stream`（role=status）是第三进度面，需纳入投影口径（Q6）。
- dock 现存模型菜单（`pi-dock.tsx` modelLabel/modelMenuOpen）与 anti-goal 3 冲突，P1 顺带隐藏。

---

## 10. 结论重申

模型成立，可以进 P1，但**顺序敏感**：先 M1（单一事实源改道）→ M2（主进程结构化消息契约）→ M5（收件人裁决）→ 再渲染卡片。M3/M4 是交互边界，成本低但决定「这是作战室还是聊天 App」。

> 主路径劳动者是主管 Agent；对话框是作战室；按钮是下单；员工是 subagent；人通过对话完成监工与批准。—— **成立，前提是 ManagerTask 作唯一真源、结构化消息进主进程、收件人钉死主管。**

---


## Owner locks (2026-08-08)

1. **Dock 收件人钉死主管**：人只对主管说话；员工是 subagent，不是可直呼同仁。员工名牌 = 状态投影（只读）；点名牌 = 问主管或跳智能体页，P1 不做直接员工对话。
2. **P1 串行唯一 ManagerTask**：同一时刻最多一个 active 主管任务。运行中再点今日情报 → 按钮变为「对话中 · 查看进度」，聚焦对话任务卡，不派第二单。一单内并行员工 job 仍允许。
3. **waiting_human 批准回今日**：改目标/取消/继续留在对话；批方案/批选题/去创作 → 跳 Today/Proposals 决策面。禁止聊天内完整批准 UI。

Source: Owner 会话 2026-08-08 明确确认 1是 2是 3是。
Designer review: `2026-08-08-manager-dialog-primary-path-design-review.md` M3/M4/M5.
