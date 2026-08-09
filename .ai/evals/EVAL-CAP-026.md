# EVAL-CAP-026

- Capability: 固定角色 `desk`/`reporter`/`planner`/`writer`/`librarian` + Capability registry（`src/shared/agent-capabilities.ts`）作为 Agent 写权限唯一来源，与 task/page grants、precise-execution gates 相交；发布点击/硬删红线不出现在自动角色 grant。
- Tasks: WMB-5100 … WMB-5106（M-5100 CAP-026 基线）与 WMB-5116（M-5110 角色执行统一收口）。账本行：`TASKS.archive.md` WMB-5100–WMB-5106、WMB-5116 均 `done`，WMB-5116 为最大 CAP-026 任务（WMB-5116 ≥ 水线 4810，触发本 eval 门禁）。
- Preconditions: registry v1 + grant filter + overlays（迁移 v49）；`daily_scan`/`daily_judge` AUTOMATIC 分区；`GenericEmployeeRunner` 统一执行四角色工单；隔离实机数据根可用；ReviewWmb5116 已 approved。
- Steps:
  1. WMB-5100–5106：立法 registry 与 harness 门禁；`ensureAutomaticTaskGrant` 角色过滤 + overlay 交集；`daily_scan`+reporter / `daily_judge`+planner 分区；lease `roleId` + `agents:roster-status` + Agents 页 live poll；settings 仅 disable 默认绑定 agentGrantable。
  2. WMB-5116：外部 spawn 去 `intent`；`role-job-registry.ts` 唯一派生四员工角色（× intent 逐项相等）；四角色统一 `GenericEmployeeRunner` 单入口单生命周期；`waiting_resource` 两原因（`RESOURCE_LOCK_CONFLICT`/`RESOURCE_LEASE_BUSY`）+ FIFO 晋升；五终态统一映射、取消优先；librarian effective grant = `page_library` ∩ 角色能力 ∩ precise gate（不扩权）。
  3. 实机验证（隔离数据根）：三角色同启业务读回、running 取消、资料员真实 Pi 会话、renderer identity smoke。
  4. 独立复审 ReviewWmb5116：四项原 finding 全关闭，approved。
- Expected observable results: SPEC §1.1 全部七条均有 registry 结构与命令/实机证据支撑；权限链（registry ∩ grant ∩ precise）由 focused tests 与实机业务读回覆盖；红线能力 `agentGrantable: false` 不在自动 grant 内；`npm run check:capabilities` 门禁对 registry 变更保持通过。
- Requirements-to-evidence matrix:

  | # | SPEC §1.1 条款 | Evidence |
  |---|----------------|----------|
  | 1 | 固定五角色，lane-stable 工作身份 | `src/shared/agent-capabilities.ts`（`RoleId` union、`ROLE_CATALOG`）；WMB-5116 `role-job-registry.ts` 唯一派生 reporter/planner/writer/librarian；check 输出 `5 roles`；`tests/agent-capabilities.test.mjs` + `tests/role-capability-p1.test.mjs` → 10/10 |
  | 2 | 写权限 = registry ∩ task/page grants ∩ precise gates；prompt/Skill 不能单独授权 | `src/main/task-grants.ts:220` `ensureAutomaticTaskGrant`（`filterCommandsForRole` + `roleWriteCommandsWithOverlays`）；WMB-5116 librarian effective grant 相交（`page_library` ∩ librarian 能力 ∩ precise gate），实机 no-op 确认 |
  | 3 | writer 可读 library/topic/plan、无 organize 命令；librarian 可 organize、无 `plans.save`/主笔命令 | registry `cap.library_organize`（`sources.lane_restore`/`sources.update_status`/`knowledge.record_batch`）与 `defaultRoleBindings` 角色分离；实机 writer `CONTENT_VERSION` + librarian `NOOP_CONFIRMED` 业务读回 |
  | 4 | 最终发布点击与硬删不在自动 grant（`agentGrantable: false` 红线） | `cap.publish_prep`/`cap.hard_delete`/`cap.platform_mutation` 均 `agentGrantable: false`、Precise+Owner UI only；`npm run check:capabilities` 门禁强制 |
  | 5 | 新写命令须先登记默认角色绑定，违规必败 | `scripts/check-capability-registry.mjs` + `check.ps1` harness；`npm run check:capabilities` → pass（20 commands / 17 grantable / 5 roles；registry no change） |
  | 6 | 一等 Agents roster 从共享 API 投影角色运行态；权限 UI 不早于 P0 registry+filter+roster | `src/main/role-roster.ts` + `agents:roster-status` + Agents 页 live poll（WMB-5105/WMB-5102）；settings 仅 disable 默认绑定 agentGrantable（WMB-5106）；WMB-5116 `role-roster` 反向投影不受影响 |
  | 7 | lane packs 零授权命令绑定，切换 lane 不需重设计角色目录 | registry 无 lane 轴：`agent-capabilities.ts` 无 lane-pack 绑定，角色/能力全局、`daily_scan`/`daily_judge` lane-agnostic；设计 `docs/spark/2026-08-07-role-permission-design.md` §11.4 |

- Command evidence（引自 `.ai/wmb-5116-evidence.md` 与 `.ai/wmb-5100-5106-evidence.md` 记录，本 eval 创建时未重跑）:
  - `node --test tests/job-pool.test.mjs tests/job-spawner.test.mjs tests/job-l2-integration.test.mjs` → 33/33 pass（WMB-5116 focused）
  - `npm run typecheck` → pass；`npx tsc --noEmit -p tsconfig.json` → exit 0
  - `npm run check:capabilities` → pass（20 commands / 17 grantable / 5 roles；capability registry no change）；WMB-5100–5106 记录同样为 `Capability registry check passed`
  - `node --test tests/agent-capabilities.test.mjs tests/role-capability-p1.test.mjs` → 10/10 pass
  - 归档前 lightweight gate：`powershell -ExecutionPolicy Bypass -File scripts/check.ps1` → pass（harness / line caps / ledger / intake / capability registry）
- Manual/live evidence（引自 `.ai/wmb-5116-evidence.md`）:
  - 隔离实机数据根 `J:/Users/yangda01/Temp/wmb-5116-live-cc7v44bl/data-root`（独立临时工作空间，未触碰真实数据）。
  - 三角色同启（2026-08-08T17:06:51Z）：reporter job `bb79…` → succeeded，业务读回 `SCAN_CHANNEL_SCANNED`；writer job `b517…` → succeeded，业务读回 `CONTENT_VERSION`（`versionId`=`6af9…`）；librarian job `df7e…` → succeeded，业务读回 `NOOP_CONFIRMED`。
  - running 取消：librarian job `5b92…`（task `975d…`、lease `4571…`）17:07:51.309 → 17:07:52.534 落 `cancelled`（≈1.2s，满足 ≤5s 门）；agent_task `status`/`phase`/`errorCode` = `cancelled`/`cancelled`/`CANCELLED`；pool `employeeSnapshots` 不含该 lease。
  - 资料员真实 Pi：session `job-bd2d9e14-...jsonl` 为真实 Pi 会话，末尾回复无需更改，job succeeded `NOOP_CONFIRMED`。
  - renderer identity smoke：`smoke-renderer` 通过，页面身份 WeMediaBuddy `<title>` + `#root`，地址 127.0.0.1:27391。
- Independent review: ReviewWmb5116 — 四项原 finding 全关闭，approved（`.ai/wmb-5116-evidence.md`）。
- Result: pass
- Failure reason: none。归档后 lightweight gate 唯一剩余失败即缺本 eval（`scripts/check-ledger.mjs`：CAP-026 全 done 且 max task WMB-5116 ≥ 4810 → 要求 `.ai/evals/EVAL-CAP-026.md`），本文件解除该门禁。
- Residual risks:
  - 非 librarian 的 Pi 子进程取消采用 lease 阻写而非强杀（Pi 进程未被强制终止）。
  - 非 organize 的 readback-missing 保守失败（缺业务读回时保守落失败）。
  - grant 签发后无显式 revoke 路径。
  - no-op 措辞可能保守假阴性：真实无变更但末条回复未命中标记时保守失败，不放宽为假成功。
  - 单一 Pi worker mutex 仍存在（lease 携带 roleId 但仅一个 worker 槽位）。
  - Overlay UI 仅 disable 默认绑定 cap（无权限扩张面）。
  - 兼容期 `daily_intelligence` intent 仍被接受。
- Pi operator Skill impact: WMB-5116 已更新 — 明确 proposal-only、Owner UI exact grant、operation states、executionGrantId 与 grant 不可复用规则（CAP-026 相关）；角色专属 Skill 目录拆分留待后续。
