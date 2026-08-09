# 五智能体工作路径验收

Date: 2026-08-08

## 验收原则（这次按这个交）

不报「全量 N 条绿」当完成。按角色交：

1. 任务能启动（正确 intent + roleId）
2. 授权命令对（能干 / 不能干）
3. 席位不串（employee ≠ 主编席）
4. 能推进到可观察状态

命令：

```text
node --test tests/agent-work-paths.test.mjs tests/basic-agent-paths.test.mjs tests/worker-lease-wiring.test.mjs
→ 39/39 pass
```

专用套件：`tests/agent-work-paths.test.mjs`（9 条）

---

## 角色结果

| 角色 | 房间 | 主 intent | 路径验收 | 证据 |
|---|---|---|---|---|
| **桌助 desk** | 主编席 | `page_today` | **PASS** | 独占 desk lease；第二 desk 拒绝；standing 写权=0；employee 并存且 `getWorkerSnapshot` 不回落 employee；page_today start→cancel |
| **记者 reporter** | 前线 | `daily_scan` | **PASS** | grant=`report_progress`+`sources.upsert_batch`；无 `plans.save`；progress→`scanning_sources`；roster 记 running，desk 非 running |
| **策划 planner** | 策划组 | `daily_judge` | **PASS** | `channel_scanned`→gate=`start_judge_only`；rebind intent=`daily_judge`；grant 含 `plans.save`+`lane_gate`；无 `content.save_version`；席位不占 desk |
| **写手 writer** | 写字间 | `studio_draft` | **PASS** | 真实 content_project 上 start；grant 含 `content.save_version`；无 `plans.save`/扫库；roster writer running |
| **资料员 librarian** | 资料室 | `page_library` | **PASS*** | standing 写权非空且无 plans.save；page_library 可 start；`page_library` 自动 grant 可能 TASK_SCOPE_EMPTY（只读页）→ **工单 JobSpawner spawn→succeeded 仍过** |
| **交叉** | — | 四员工 spawn | **PASS** | JobSpawner 四角色均 succeeded；lease.roleId 正确；deskSnapshot 不为 employee |

\*资料员：页任务写权取决于 page scope；派工单路径完整通过。

---

## 权限矩阵（越权形状）

| 角色 | 必须有 | 必须无 |
|---|---|---|
| desk | （无 standing 写） | 一切业务写 standing |
| reporter | `sources.upsert_batch` | `plans.save` |
| planner | `plans.save` | `content.save_version`（judge 默认） |
| writer | `content.save_version` | `plans.save` |
| librarian | 库整理 standing | `plans.save` |

---

## 真实数据根只读对照（`WeMediaBuddyData/wmb.db`）

| 角色 | 现场最近任务 | 说明 |
|---|---|---|
| desk | `page_today` cancelled ORPHAN | 有过页任务，曾被收尸 |
| reporter | `daily_scan` partial | 扫过；未每次干净收尾 |
| planner | `daily_judge` 曾 **succeeded**（`6252670f`） | 事件：`方案已保存：8 个机会…`；当前 plan `2026-08-08` current |
| writer | `studio_draft` succeeded（7-28） | 有历史成功，非今日 |
| librarian | **从未有 `page_library` 任务** | 套件补了路径；现场未用过 |

---

## 明确没冒充的

- 没有再拿「全量 477」代替五角色验收
- 没有声称五角色都在**当前 UI 会话**里各点过一遍（要完整 UI E2E 需 App 在线 + 人工/浏览器驱动）
- 资料员现场历史为空：测试证明**能跑**，不证明**你已经用过**

---

## 回归入口

```text
node --test tests/agent-work-paths.test.mjs
```

以后改角色/授权/席位，先过这 9 条再谈别的。
