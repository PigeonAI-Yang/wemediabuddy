# WMB-5144 Evidence — Pi operator Skill 多实例感知 + 桌助呈报/续派路径

- 日期：2026-08-10
- 合同：`.ai/wmb-5144-contract.md`（实施阶段）；设计真源 `docs/spark/2026-08-08-agent-crew-multi-instance-design.md` §9/§10/§11/§16.2、PRODUCT C9、PRD REQ-028/REQ-029 + AC-024..AC-027、SPEC CAP-027（EVAL-030）；规程 `docs/pi-operation-skill-maintenance.md`
- 改动文件（复审 P2 收口后）：
  - `src/main/pi-operator-skill.ts`（PI_AUTHORITY_SYSTEM_PROMPT 多实例感知登记）
  - `skills/wemedia-buddy-operator/SKILL.md`（canonical：主管派工章节重写为实例驱动语义；P2 收口补桌助边界/旧标签兼容说明）
  - `tests/pi-operator-skill.test.mjs`（静态 + 行为 eval 防回归；P2 收口新增桌助身份一致性 eval）
  - 镜像同步：`data/gamedata`、`data/ukcontentdata`（经 `installPiOperatorSkillForDataRoots` 内容哈希刷新）、`out/WeMediaBuddy-win32-x64/resources/skills/wemedia-buddy-operator`（打包副本，逐字节复制）
  - P2 收口文案对齐（仅模型可见 label/description/输出文案，零 schema/行为变更）：`.pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts`、`src/main/mcp.ts`、`src/main/mcp-job-tools.ts`、`src/main/role-roster.ts`（desk 行展示映射）、`src/main/ipc-pi-dock.ts`、`src/main/manager-dispatch.ts`、`src/main/manager-orchestration.ts`

## 登记前后提示词 diff（pi-operator-skill.ts）

`PI_AUTHORITY_SYSTEM_PROMPT`（桌助主对话 + 员工实例统一注入）：

- 前：`你是 WeMediaBuddy 的主编席主管（desk）。你管理记者/策划/写手/资料员，不替代员工长跑…`
- 后：`你是 WeMediaBuddy 的桌助（desk，唯一常驻对话面）：协调入口，主管是主编本人，桌助不代行主管职权。你管理记者/策划/写手/资料员…`
- 新增（§16.2 行为契约 3 + §10 硬边界）：`同一角色可能同时有多个工单实例；实例一律以 jobId 精确指认，员工实例只对当前 job 的上下文负责，不引用其他实例会话、不假设自己是唯一在岗员工`；`不可派工给桌助自己`；`maxWorkers 是全角色共享并发上限，0=派工停用`；`状态语义：queued=排队等容量，waiting_resource=等资源（不占并发），running=工作中，needs_user=等你批（终态，不占 worker、不持 lease/grant/锁，需人处理）`；`对进度/状态的回答只来自班组投影 API 的持久事实（roster/jobs/task），禁止编造进度或状态`。
- 保留全部既有硬边界断言文本（禁止直接写文件或数据库 / 禁止最终发布 / UI 确认边界 / taskId+grantId+workerLeaseId / [WMB_AUTHORITY_BLOCKED] / librarian no-op 围栏 `{"wmb_noop":true}`）。
- 删除旧隐喻：`主编席` 移除；提示词中 槽位/坐席/工位/待命/席位 零出现。

## SKILL.md 主管派工与工单编排 diff（canonical）

删除：`wmb_list_agents_roster` 读**席位**状态（旧槽位隐喻）；「不可派主管自己」。

新增五条实例驱动操作协议：

1. 多实例是常态：同角色可同时多实例；实例一等身份 `jobId`；指认/继续/取消/传话/续派一律精确 `jobId`，显示编号仅活动期可见、跨重启不可指认；员工只对当前 job 上下文负责、不引用其他实例会话、不假设自己是唯一在岗员工。
2. 读取 → 判断 → 精确动作：先读投影事实（`wmb_list_agents_roster` / `wmb_list_jobs` / `wmb_get_job`），再按精确 `jobId` 执行；禁止编造进度或状态。
3. 状态语义：`queued`=排队等容量；`waiting_resource`=等资源（不占并发，释放后晋升，不得说成失败）；`running`=工作中；`needs_user`=等你批（终态：不占 worker、不持 lease/grant/锁，需人处理或关闭后才闭环，不自动重试）；终态退出活动视图。
4. 活动与历史不混淆：活动视图=queued/waiting_resource/running + 终态 needs_user；历史只从持久面重建（`agent_tasks.context_refs_json` 为锚），重启后仍在；续派=从 context_refs_json 重建原 RoleJobRequest（jobId/roleId/brief/边界参数）+ 结果摘要，派新单（新 jobId），不伪称同 ID。
5. 桌助边界：协调入口、主管是主编本人；无 standing 写权、不占员工执行容量；`wmb_spawn_job` roleId 只接受 reporter/planner/writer/librarian，不可派桌助自己；留言≠代批；`maxWorkers`（0..7）共享并发上限非每角色配额，0=派工停用（spawn 拒绝）。

工具真实性与参数：本 Skill 提及的全部 wmb_* 工具名与参数（jobId/body/roleId/brief/projectId/stage/businessDate 等）逐项对照 `.pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts` 真实 ToolDefinition 登记（wmb_list_agents_roster / wmb_list_jobs / wmb_get_job / wmb_spawn_job / wmb_cancel_job / wmb_message_job / wmb_list_job_messages / wmb_daily_readiness / wmb_continue_after_scan / wmb_run_daily_stage），无臆造工具；工具清单契约测试（documented == registered）通过。运行时/注册表/schema/UI/TASKS/规范零改动。

## 镜像同步（Skill sync）

- 同步前：data-root 镜像 revision `41aac72d…`（陈旧）；打包副本 SKILL.md 与 canonical 一致但含旧「席位」文案。
- 同步后：三处镜像（data/gamedata、data/ukcontentdata、out 打包副本）与 canonical 树哈希逐字节一致（含 SKILL.md + agents/openai.yaml），`.wmb-install.json` revision = canonical `b6fe74f32ef3c12442e75431a6bc0095e680c948d46346b8caa89984f7879e29`；槽位/坐席/工位/待命/席位 全镜像零出现。
- 数据根刷新走既有内容哈希安装机制（非手改生成产物），lane Skills 未被触碰（既有 pi-operator-install 测试覆盖）。

## 复审 P2 收口：模型可见文案对齐「桌助不是主管」

ReviewWmb5144 唯一 P2：桌助身份翻转只落在提示词与 Skill 字符串上，模型实际消费的工具面与事实源仍按旧主管人设表述（wmb_list_agents_roster「主管监工用/席位」、wmb_spawn_job「不可派主管自己」、daily 工具「主管选用」、roster desk 行 labelZh='主管'/roomZh='主编席'），与「桌助不代行主管职权」直接矛盾。本收口仅改模型可见 label/description/输出文案与展示映射；工具名/参数/schema/权限/命令/运行时行为零改动。

文案对齐面（before → after，全部仅字符串）：

- `.pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts`（Pi 工具面）：
  - `wmb_list_agents_roster` label「读取班组席位」→「读取班组投影」；description「读取主管/记者/策划/写手/资料员席位状态与进度摘要。主管监工用。」→「读取班组投影：桌助/记者/策划/写手/资料员的活动状态与进度摘要。桌助协调用。」
  - `wmb_list_jobs`「主管读进度用」→「桌助读进度用」；`wmb_spawn_job` label「主管派工」→「桌助派工」、description「不可派主管自己」→「不可派工给桌助自己」；`wmb_cancel_job`「主管取消员工工单」→「桌助取消员工工单」；`wmb_message_job`「主管向指定工单传话」→「桌助向指定工单传话」（`[主管] 前缀` 为运行时实际写入标记，属行为面，保留并如实描述）；`wmb_list_job_messages`「读取主管给某工单」→「读取桌助给某工单」；`wmb_continue_after_scan`/`wmb_run_daily_stage`「主管选用/主管启动」→「桌助选用/桌助启动」。
- `src/main/mcp.ts`（MCP 原始 description）：`agents.roster`「读取固定角色班组席位状态（主管/…）」→「读取固定角色班组投影状态（桌助/记者/策划/写手/资料员）…」；`daily.readiness`「是否续接由主管决定」→「由桌助决定」；`daily.continue_after_scan`「主管工具」→「桌助工具」；`daily.run_stage`「主管启动…由主管选用」→「桌助启动…由桌助选用」。
- `src/main/mcp-job-tools.ts`（同一组工具的 raw MCP 面）：`jobs.list`/`jobs.get`/`jobs.spawn`/`jobs.cancel`/`jobs.message` 描述全部「主管」→「桌助」；`jobs.get` 的 monitor.how/note 输出文案「终态会推送主管」「主管无需轮询」→「终态会推送」「桌助无需轮询」。
- `src/main/role-roster.ts`（roster desk 行展示映射，agent-capabilities 为禁止触碰面）：新增 `DESK_ROSTER_FACE = { labelZh: '桌助', roomZh: '协调入口' }`，`buildRoleRoster` 对 `roleId === 'desk'` 的行使用该展示面；注册表 `ROLE_CATALOG.desk`（主管/主编席）与权限语义零改动。roster 模型输出与 UI 投影行一致显示「桌助/协调入口」。
- `src/main/ipc-pi-dock.ts`：桌助回合注入的 contextRule「你是主管。自动编排是你的工具：…」→「你是桌助。自动编排是你的工具：…」（消除同会话内与 PI_AUTHORITY_SYSTEM_PROMPT 桌助身份的直接冲突）。
- `src/main/manager-dispatch.ts`：今日情报编排 prompt「你是主管，编排方式由你选：」→「你是桌助，…」；pageLabel「班组 · 主管」→「班组 · 桌助」。
- `src/main/manager-orchestration.ts`：`continueAfterScan` 输出 message「已按主管指令续接策划」→「已按桌助指令续接策划」。
- `skills/wemedia-buddy-operator/SKILL.md`（canonical）：章节「主管派工与工单编排」→「桌助派工与工单编排」；工具清单分组「主管与工单编排」→「桌助派工与工单编排」；桌助边界条目补充「班组投影（wmb_list_agents_roster）里 desk 行就是桌助（协调入口），主管是主编本人，若遇旧数据把 desk 标为主管/主编席，一律按桌助/协调入口理解，不因此自认主管」——Skill 明确兼容旧数据标签。

保留面（行为/禁止触碰，本收口不碰）：`agent-capabilities.ts`（注册表）、`page-authority.ts`、JobPool/workspace-runtime 运行时语义、`job-spawner.ts` 写入 task progress 的 `[主管]` 前缀（运行时输出标记，改前缀=改行为，非文案）、UI 侧 ROLE_CATALOG 直用（renderer 不在本合同路径）。发布红线（最终确认/激活/最终发布只由用户在 WMB UI）在提示词/Skill/工具描述全部保留。

## ApproveWmb5144 P2 收口：desk 卡头使用 roster 投影标签（AlignDeskCardHeader）

ApproveWmb5144 唯一 P2：桌面组卡头（renderRoleHead）仍直用 ROLE_CATALOG.desk（主管/主编席），与 roster 投影行展示面（DESK_ROSTER_FACE 桌助/协调入口，role-roster.ts 已由上一收口对齐）在桌面组内并存，违反 PRODUCT C9.6「桌助是协调入口不是主管工位」。本收口让卡头从 roster 投影行取标签，关闭 renderer 侧 ROLE_CATALOG.desk 直用。

- 改动文件（纯展示：renderer 视图 + DOM 门测试 + 本证据；注册表/权限/运行时零改动）：
  - `src/renderer/agents-roster-view.tsx`：renderRoleHead 对 desk 的 meta 解析为 `{ labelZh: deskRow?.labelZh ?? '桌助', roomZh: deskRow?.roomZh ?? '协调入口' }`（roster 投影行优先；缺数据 fallback 为桌助/协调入口，不回落 ROLE_CATALOG.desk）；员工角色卡头仍 ROLE_CATALOG；头像裁剪对话框 desk 标签同走投影行（点击桌助头像不再出现「主管」）。行数按 check.ps1 的 (Get-Content).Count 口径 467 → 467 不变。
  - `tests/agents-roster-conflict.test.mjs`：新增 1 条 DOM 门「roster view DOM gates: desk card head uses roster projection labels, no 主管/主编席 (WMB-5144 P2)」（10 → 11 条）：
    - desk 头 labelZh/roomZh 表达式以 roster 行优先、fallback 为桌助/协调入口（`deskRow?.labelZh ?? '桌助'` / `deskRow?.roomZh ?? '协调入口'`），不回落 ROLE_CATALOG.desk
    - 用户可见文案：视图含「桌助」「协调入口」、不含「主管/主编席」字面量（旧隐喻整体消失）
    - 员工角色卡头仍走 ROLE_CATALOG（注册表零改动守卫）
    - 头像裁剪对话框 desk 标签走投影行
  - `.ai/wmb-5144-evidence.md`（本段）
- 验证（聚焦 + typecheck，按合同跳过项目级检查）：
  - `node --test --test-concurrency=1 tests/wmb-5143-agents-instance-view.test.mjs tests/agents-roster-conflict.test.mjs`：**23/23 PASS**（12 + 11，含新增 WMB-5144 P2 DOM 门）
  - `npx tsc --noEmit`：PASS（0 错误）
  - line-cap：agents-roster-view.tsx 按 check.ps1 的 (Get-Content).Count 口径 467 = scripts/line-caps.json 注册值（棘轮不动，line-caps.json 无改动）；tests/agents-roster-conflict.test.mjs 现 128 行、tests/wmb-5143-agents-instance-view.test.mjs 187 行（均 ≤500 无注册 cap）
- 保留面：`agent-capabilities.ts`/`page-authority.ts` 零触碰；roleLabel（工单/实例角色标签解析）维持 ROLE_CATALOG——desk 不可 spawn、desk 无实例卡，页面运行时不存在 roleLabel('desk') 渲染路径；修复范围仅上述三文件。

## 聚焦测试（Skill 门）

- `tests/pi-operator-skill.test.mjs`：6/6 通过（工具清单契约 + UK lane + WMB-5144 静态 eval（多实例/状态语义/桌助边界/maxWorkers0/历史活动/禁词零出现）+ 提示词面 eval + **P2 收口桌助身份一致性 eval（Pi 工具面/raw MCP 面/roster 展示映射/dock contextRule 全对齐）** + 镜像一致性行为 eval）。
- `tests/pi-operator-install.test.mjs`：4/4 通过（含「Pi system prompts keep detailed operating playbooks in the shared Skill」接线断言）。
- `tests/pi-extension.test.mjs`：7/7 通过（WMB-5133 工具清单契约 + no-op 围栏 + SKILL.md 断言）。
- 技能家族聚焦：pi-skill-library / pi-skills-settings / pi-skill-routing / pi-command-palette / pi-conversation 全部通过。
- `git diff --check` 通过（仅他任务文件预存 LF/CRLF 提示，本变更三文件干净）。

## EVAL-CAP-027 skill 面

多实例感知文本按维护规程登记于既有提示词落点（pi-operator-skill.ts + skills/wemedia-buddy-operator/SKILL.md），明确「同一角色可能同时有多个工单实例；只对当前 job 上下文负责；不引用其他实例会话；不假设自己是唯一在岗员工」；无虚构待命态、无空占位语义、desk 不可 spawn、needs_user 零资源保留、活动/历史由投影 API 单源——skill 面通过（对应 EVAL-CAP-027 步骤 5/6 的提示词侧断言由上述聚焦测试覆盖）。

## 门禁交接

`npm run typecheck` 与 `npm run check:capabilities`（G1）为项目级命令，按任务约束由主 Agent 统一执行；本任务变更仅为字符串常量与 markdown 文本，未触碰 agent-capabilities/page-authority/运行时语义（Capability registry impact: no change）。

Pi operator Skill impact: updated — 多实例感知提示词按 docs/pi-operation-skill-maintenance.md 规程登记于 PI_AUTHORITY_SYSTEM_PROMPT 与 skills/wemedia-buddy-operator/SKILL.md；删除席位隐喻，新增读取→判断→精确动作协议、四态语义（needs_user 不占 worker）、桌助边界（不占容量/不可 spawn）、maxWorkers=0 含义、历史/活动与续派合同；三处镜像同步一致；聚焦 Skill 门与测试通过。
