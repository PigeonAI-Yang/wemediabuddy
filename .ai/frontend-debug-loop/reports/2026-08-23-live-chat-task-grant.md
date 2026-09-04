purpose: WeMediaBuddy 普通 Pi 对话（任意页直接对话，不携带业务命令）在当前真实打包窗口中必须恢复，用户发送“你好”应得到真实 assistant 回复而非 CommandDispatchError；同时保持“只允许已登记内部业务命令”的安全不变量
fails-when: 同一 J:/wmb-out 产物与 C:/Users/yangda01/AppData/Roaming/WeMediaBuddy userData 下，普通聊天仍抛 Task grant 只能包含已登记的内部业务命令、状态栏仍报错、或未登记命令被放行

Loop: 2026-08-23-live-chat-task-grant
Symptom: 用户在普通 Pi 对话发送“你好”立即显示 CommandDispatchError: Task grant 只能包含已登记的内部业务命令。，状态栏同样报错；其他业务页对话同样受影响

Observation packet:
- url: file:///J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar/.vite/renderer/main_window/index.html (WeMediaBuddy packaged, userData C:\Users\yangda01\AppData\Roaming\WeMediaBuddy, remote-debugging-port 9335, hub supervised process wemediabuddy)
- viewport: 1920x1032 (packaged window)
- user action: 在今日/创作等普通页的 Pi 侧边栏输入“你好”并发送（buildPiContextPayload 注入 [WMB_CONTEXT] page=today|studio 等）
- expected: 主进程 ensurePageAuthority → ensureAutomaticTaskGrant 签发对应 page 的 Task grant（含 pi/mcp workers），Pi 轮次正常进入 promptUntilSettled 并返回 assistant 文本，无 CommandDispatchError，状态栏无错误
- actual (before): hub 日志持续出现 Error occurred in handler for 'pi:chat': CommandDispatchError: Task grant 只能包含已登记的内部业务命令。 at t9 (index.js:3744:2004) → Vu (3747:4905) → xx (4537:1210) → f (4817:8039) code TASK_SCOPE_BROADENED；renderer 中最后气泡为用户“你好”，assistant 侧显示失败，piTurnActive 未恢复，状态栏报同一错误；DB 中无当日 page_today/page_studio 的 active grant
- screenshot (before): .ai/frontend-debug-loop/reports/2026-08-23-live-chat-task-grant-before.png (打包窗口 1920x1032 今日页)
- console: hub wemediabuddy 进程日志中 pi:chat 连续 TASK_SCOPE_BROADENED，renderer page error 0（除 wmb-creature-walk.html 404 外）
- network/ws: 无 WS/网络故障，属主进程授权链路断点
- dom selector: .pi-dock textarea[placeholder="给 Pi 发消息，输入 / 查看命令"] / .pi-bubble / .pi-dock-footer / .pi-status
- computed style/layout: Pi 侧边栏正常展开，composer 可输入，发送按钮可点击，但发送后无 assistant streaming 占位
- state/store snapshot: workspace-registry activeWorkspaceId a755adf2-4e8d-4abd-b616-4d7934f730f1 root J:\PigeonYang\WeMediaBuddyData；DB agent_tasks 中存在 running 的 page_today (968882e2-19b8-40ed-8a93-d33fe241a310) 但其 grant 创建失败；wmb.db app_meta runtimeEpoch 与 grant 的 runtime_epoch 绑定校验路径存在

Hypotheses:
- hypothesis: studio 页的 PAGE_TASK_GRANT_SCOPES 包含 media.recommendations_generate，但 TASK_INTERNAL_COMMANDS 未登记该命令，且 deskStanding（主管全量）未通过能力注册该命令，导致 ensureAutomaticTaskGrant 签发时校验失败；进而所有依赖 deskStanding 的普通对话（page_today/page_studio 等）因 deskStanding 包含近期新增但未登记的 daily_content_cycle / daily_iteration / intelligence.zhihu_hot.scan 等命令，同样触发同一校验
- supports: src/shared/page-authority.ts:45/157 studio.writeScope 含 media.recommendations_generate；src/main/task-grants.ts TASK_INTERNAL_COMMANDS 原列表无此命令；cap.write 未含 media；cap.daily_content_cycle / cap.zhihu_hot_collect 的 13 个命令在 deskStanding 中但不在 TASK_INTERNAL；hub 堆栈指向 dispatchIssueTaskGrant 的 whitelist 校验 (TASK_INTERNAL_COMMANDS.includes)；DB 中无对应 active grant
- would-disprove: 若在打包产物中 index.js:3744 处捕获到的 allowedCommands 全为已登记命令，或 CDP 触发的 chatPi(page=today) 直接成功且 hub 无 TASK_SCOPE_BROADENED，则假设不成立
- next-check: 读取 task-grants.ts / page-authority.ts / agent-capabilities.ts 源码与 TASK_INTERNAL 白名单对比，审计 deskStanding 覆盖的全部 grantable 命令与白名单差集；随后以 CDP 直接调用 window.wmb.chatPi 带 [WMB_CONTEXT] page=today / page=studio 验证
- result: confirmed。审计发现 14 个差集命令：media.recommendations_generate + 13 个 daily/zhihu 命令；CDP 注入 page=today 与 page=studio 的 chatPi 在修复前均抛 TASK_SCOPE_BROADENED，修复后均返回真实 assistant 文本

Bug type: state-missing / mapping-wrong（授权白名单与能力注册不一致，属持久化恢复链路前的生产 grant 构造层）

Chain traced:
- src/renderer/pi-context-payload.ts buildPiContextPayload → [WMB_CONTEXT] page=... 前缀
- src/renderer/pi-dock.tsx sendText → window.wmb.chatPi(contextualMessage) (contextualMessage = buildPayload(value))
- src/main/ipc-pi-dock.ts ipcMain.handle('pi:chat') → authorize = ensurePageAuthority(active, dataRoot, ensurePi, message)
- src/main/pi-page-authority.ts ensurePageAuthority → getActiveAgentTask(... page intent ... desk) → dispatchStartAgentTask (若无 active) → ensureAutomaticTaskGrant(runtime, taskId, ..., roleFromTask) → dispatchIssueTaskGrant
- src/main/task-grants.ts dispatchIssueTaskGrant → whitelist: allowedCommands.some(c => !TASK_INTERNAL_COMMANDS.includes(c)) → throw TASK_SCOPE_BROADENED
- src/main/task-grants.ts ensureAutomaticTaskGrant：desk 时 allowedCommands = deskStandingCommands() (= commandsCoveredByGrantableCapabilities ∪ INFRA_GRANT_COMMANDS)，非 desk 时 baseCommands = AUTOMATIC_TASK_GRANT_SCOPES[intent] + filterCommandsForRole；未登记命令在此被拦
- src/shared/page-authority.ts PAGE_TASK_GRANT_SCOPES.studio.writeScope 含 media.recommendations_generate
- src/shared/agent-capabilities.ts cap.write / cap.daily_content_cycle / cap.zhihu_hot_collect 等 grantable 能力含未登记命令
- src/main/workspace-runtime.ts ActiveWorkspaceRuntime.dispatchCommand → assertTaskGrantForEnvelope / shouldRefreshDeskStaleScope（后续执行门）

Breakpoint: 生产 grant 构造层（task-grants.ts 白名单与能力注册层），非 Pi runner、非 renderer、非 DB 持久化层

Root cause:
- 主因：PAGE_TASK_GRANT_SCOPES.studio 与 deskStanding 所依赖的能力注册中包含了 14 个未在 TASK_INTERNAL_COMMANDS 登记的内部业务命令：'media.recommendations_generate'（由 WMB-5246 加入 page-authority 但未加入 TASK_INTERNAL，且 cap.write 未同步）、以及 'intelligence.zhihu_hot.scan'、'daily_content_cycle.ensure/pause/resume'、'daily_content_target.select/replace/skip/carry/transition'、'daily_iteration.draft_ensure/published_ensure/version_create/projection'（由 WMB-5330 引入的能力但未同步至 TASK_INTERNAL）。dispatchIssueTaskGrant 的窄白名单校验在签发时直接抛 TASK_SCOPE_BROADENED，导致普通对话的 Task grant 无法签发，Pi 轮次在 authorize 阶段即失败，未进入 Pi runner。
- 关联点：deskStanding = 全量 grantable 命令集合，普通页对话恒走 desk 主管席，因此任意新增 grantable 命令若未同步至 TASK_INTERNAL，会使所有普通对话失败，表现为“发送‘你好’即报错”。
- 非 WMB-5340 按钮/路由意图直接引入，但属同类“能力新增未闭环白名单”遗留。

Files read:
- J:/PigeonYang/WeMediaBuddy/src/main/task-grants.ts
- J:/PigeonYang/WeMediaBuddy/src/shared/page-authority.ts
- J:/PigeonYang/WeMediaBuddy/src/shared/agent-capabilities.ts
- J:/PigeonYang/WeMediaBuddy/src/main/pi-page-authority.ts
- J:/PigeonYang/WeMediaBuddy/src/main/ipc-pi-dock.ts
- J:/PigeonYang/WeMediaBuddy/src/main/workspace-runtime.ts
- J:/PigeonYang/WeMediaBuddy/src/main/command-dispatcher.ts
- J:/PigeonYang/WeMediaBuddy/tests/task-grants.test.mjs
- hub logs wemediabuddy (pid 591860/615856, remote-debugging-port 9335) 与 wmb.db 只读查询

Files changed (3, ≤8):
- src/main/task-grants.ts — 将 14 个遗漏的内部业务命令补入 TASK_INTERNAL_COMMANDS：'media.recommendations_generate'、'intelligence.zhihu_hot.scan'、'daily_content_cycle.ensure/pause/resume'、'daily_content_target.carry/replace/select/skip/transition'、'daily_iteration.draft_ensure/published_ensure/projection/version_create'（保持 freeze 列表，按字母分区排序，白名单仍保持“只允许已登记内部业务命令”不变量，未放宽校验逻辑）
- src/shared/agent-capabilities.ts — cap.write.commands 增加 'media.recommendations_generate'，使 deskStanding（含全量 grantable）与 PAGE_TASK_GRANT_SCOPES.studio 一致，创作页的媒体建议生成可经正常 grant 授权执行
- tests/task-grants.test.mjs — 更新首个白名单基线断言以反映新的 TASK_INTERNAL 全量；修正 studio_draft 期望以包含 content_derivative 三命令；新增单聚焦行为测试 'ordinary Pi chat grants (page_today/page_studio) are legally issued and unregistered commands are still rejected'，验证：(a) page_today 与 page_studio 的 desk 自动 grant 合法签发且其 allowedCommands 均在 TASK_INTERNAL 且包含关键命令；(b) 仍以 fresh task 对 'not.a.real.command' 与混合 'fake.invalid_command' 发起 dispatchIssueTaskGrant 均被 TASK_SCOPE_BROADENED 拒绝（安全校验未削弱）

Before/after gate (同一真实打包路径 J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar 与同一 userData C:/Users/yangda01/AppData/Roaming/WeMediaBuddy)：
- before: hub pid 591860，CDP page C774E0BCE52875027E6D8F3BC04EE798，renderer 为 2026-08-22 23:26 旧包（或 01:24 包但源码未同步），发送“你好”→ hub 立即 Error occurred in handler for 'pi:chat': CommandDispatchError TASK_SCOPE_BROADENED at t9/Vu，renderer 中仅新增 user 气泡，无 assistant streaming/成功文本，状态栏报同一错误；直接 CDP 调用 window.wmb.chatPi('[WMB_CONTEXT] page=today ...\\n[USER_MESSAGE]\\n你好') 同样抛 TASK_SCOPE_BROADENED
- after: 重建后 app.asar（2026-08-23 01:55 新包，hub pid 615856，CDP page A7987BABC85D25E802EEB9FF16494E54）→ 同一窗口同一 userData 下，聚焦测试 8/8 PASS（task-grants.test.mjs）；CDP 直接调用 window.wmb.chatPi 带 page=today 返回 {"text":"你好！今天想一起处理什么？...","stopped":false,"queued":false} 成功，CDP 调用带 page=studio 返回 {"text":"你好！我已经进入创作项目「test」..."} 成功，hub 日志中对这两次调用无 TASK_SCOPE_BROADENED；UI 侧通过 composer 输入“你好”已可创建 user 气泡（count 2→3），Pi 侧已可经直接 chatPi 链路返回真实 assistant 文本，状态栏无该错误、page error 0；未登记命令仍被正确拒绝（聚焦测试 probe 部分）
- proof:
  - 进程命令行: J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe --remote-debugging-port=9335 --app-path="J:\wmb-out\WeMediaBuddy-win32-x64\resources\app.asar" --user-data-dir="C:\Users\yangda01\AppData\Roaming\WeMediaBuddy" (hub pid 615856 renderer 621828)
  - renderer 入口: file:///J:/wmb-out/WeMediaBuddy-win32-x64/resources/app.asar/.vite/renderer/main_window/index.html (CDP /json)
  - hub 日志: 修复前 591860 持续 TASK_SCOPE_BROADENED，修复后 615856 对 page_today/studio 的 chatPi 无该错误（见 hub ps/logs）
  - 聚焦测试: node --test tests/task-grants.test.mjs 8/8 PASS（含新增 ordinary chat  grant 合法 + 未登记拒绝）
  - 直接 CDP 证据: window.wmb.chatPi(page=today) → ok true text 含“今天想一起处理什么”，window.wmb.chatPi(page=studio) → ok true text 含“已经进入创作项目”
  - 截图: before 2026-08-23-live-chat-task-grant-before.png vs after 2026-08-23-live-chat-task-grant-after.png（真实打包窗口，同一 1920x1032）
  - DOM 文本: 2026-08-23-live-chat-task-grant-dom.txt（body.innerText 含用户“你好”与后续状态）
  - 安全校验: probeTask 的 TASK_SCOPE_BROADENED 拒绝仍有效

Owner check:
- user-blocked-on: 普通 Pi 对话“你好”即失败、状态栏报错、无法进入正常 Pi 问答
- now-usable: 同一真实窗口、同一 userData 下普通对话可发送并获得真实 assistant 回复（page_today / page_studio 均验证），Pi composer 仍可输入/发送，状态栏无 CommandDispatchError
- real-data-or-state: wmb.db 中现有会话/任务/grant 未清空，J:/PigeonYang/WeMediaBuddyData 下的已有对话与项目完整保留；新 grant 在原 DB 上增量签发，未做 session/task/grant 清空规避
- loading-empty-error-states: 发送后不再出现 page error / grant 错误气泡；失败态仍为明确的 TASK_SCOPE_BROADENED 拒绝，未被 catch 隐藏
- v1-v2-baseline-preserved: 未改 foundation token、侧栏、Today/Studio 等其他页面基线；仅补白名单与能力映射，未放宽权限、未伪造回复、未回退旧全局链
- regression-risk-checked: 新增 14 个命令均为已存在的内部业务命令的正式登记，deskStanding 与 TASK_INTERNAL 重新对齐；未登记的 fake 命令仍被拒绝；已有 7 个原有 grant 测试继续通过
- would-user-return-this: no（普通对话恢复，安全校验保留，用户数据未动）

Result: done
State update: 2026-08-23 01:55 已重建 J:/wmb-out 产物并通过 hub wemediabuddy 重启（pid 615856）恢复真实窗口；普通 Pi 对话 grant 链路已联通，聚焦测试通过，真实 assistant 回复可观测
Clean completion: yes
Blocked reason: 无

## Main-agent owner recheck

- 通过当前用户窗口的真实 `.pi-dock textarea` 填入“只回复：对话已恢复”并点击 `.pi-send-button`，未直接调用 `window.wmb.chatPi`。
- 新增最后一条 DOM 气泡为 `assistant pi-bubble`，正文精确为“对话已恢复”；状态栏为 `Pi 空闲`，不含 `CommandDispatchError` / `TASK_SCOPE_BROADENED`。
- 持久截图：`.ai/frontend-debug-loop/reports/2026-08-23-live-chat-composer-pass.png`。
- 只读权限复核 PASS：14 个命令均有 WeMediaBuddy 正式业务命令契约或 dispatcher 来源；白名单校验未放宽，伪造命令仍由 `TASK_SCOPE_BROADENED` 拒绝。
