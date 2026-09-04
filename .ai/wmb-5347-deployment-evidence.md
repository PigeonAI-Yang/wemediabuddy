# WMB-5347/WMB-5348 联合部署证据 — R2

- **Package**: `J:/wmb-out-5348-r2/WeMediaBuddy-win32-x64/WeMediaBuddy.exe` 225781760 2026-08-23T08:05:00Z（R2，含 WMB-5347 `researchMode=prohibited` 受限写作 + WMB-5348 R2 单行44px ledger 与 min-height:0/overflow:auto 链路），`WMB_OUT_DIR=J:/wmb-out-5348-r2` 单次 package，旧包 `J:/wmb-out`/`J:/wmb-out-5348` 保留未覆盖；`electron-forge package` 校验 `check-skill-mirrors PASS`、`media-runtime-gate` ffprobe/whisper/tesseract 均通过。
- **App**: 受管 `wemediabuddy-user` pid 724252（`J:/wmb-out-5348-r2/.../WeMediaBuddy.exe --remote-debugging-port=9338 --user-data-dir=C:\Users\yangda01\AppData\Roaming\WeMediaBuddy`，绑定真实 data root `J:/PigeonYang/WeMediaBuddyData` via `data-root.json`），CDP `http://127.0.0.1:9338/json` title `WeMediaBuddy` url `file:///...app.asar/.vite/renderer/main_window/index.html` 响应，`status-bar` footer 34px 可见，Pi 空闲，最终进程保持运行。
- **Request/Job**: 复用未绑定 `requestId=f4a2ec15-e653-4d1e-84e9-081303e6d54c`，单次 `window.wmb.jobsSpawn({roleId:writer, projectId:2fb16eba..., writerTask:core_draft, researchMode:prohibited, research_mode:prohibited, brief:原WMB-5347观点型方法文brief})` → `jobId=daf89f21-4d2e-4daa-8556-e996aa4a470d` `taskId=b646db00-d7fe-45b5-9af3-87602866d8e5` `status=running→succeeded` `report code=CONTENT_VERSION` `finishedAt=2026-08-23T08:10:45.970Z`；仅按 `jobId` 轮询 `jobsGet`，无二次派工，丢失响应按 `jobId` 回读。
- **DB 终态 (只读)**:
  - `agent_tasks.b646db00` `intent=studio_draft` `status=succeeded` `phase=completed` `business_date=2026-08-23`；`context_refs_json` `roleId=writer` `projectId=2fb16eba...` `writerTask=core_draft` `researchMode=prohibited` `research_mode=prohibited` `researchGate=exempt` `researchGateReason=prohibited_brief_exempt` `modelPolicySnapshot writer`；`result_refs_json` `{projectId, contentVersionId:aff6c832..., versionNumber:2}` 无 `researchHandoff`/`research_dispatched`。
  - `content_projects.2fb16eba` `revision 1→2` `updated_at=2026-08-23T08:10:28.473Z` `status=drafting`；`content_versions` v1 len316 + v2 `aff6c832 len2074 author=ai` 非空，正文头 `如果这个月 AI 账单突然变高…` 围绕 Activity dashboard 与内部6200美元案例展开，已兑现 brief“观点型方法文、不能支持的事实删除或标个人建议”。
  - 新 research child 0：`SELECT count(*) FROM agent_tasks WHERE intent='research' AND created_at>task.created_at` =0；`content_project_sources` 仍2条（OpenRouter @OpenRouter），未新增外部来源；`RESEARCH_GATE_EXEMPT_INVALID` 边界未触发。
- **Studio 真实UI (长正文压力下)**:
  - 路径：侧边「创作」→ 列表 `studio-project-row` 首行 `S AI 项目最容易... 2fb16eba` `2 个版本 2026/8/23 16:10:28` → 点击「打开」→ 编辑器 `studio-document` 显示 v2 正文（DOM 内 `# AI 项目最容易...` 与三级“先别问哪个模型便宜”可见，`api getStudioProject` revision2 version2 一致）。
  - 测量（1600×960 窗口，renderer 1600 内宽）：`studio-illustration-summary-bar` **44px** `text="暂无配图0/0·比例 … 张数 定稿配图"`；`studio-dual-ledger` **44px** 横向两段 `row 44px×2` (`主产物 drafting v2·aff6c832` `衍生产物 待生成 —`) `isSingleRow true`；`ledgerRect bottom 909` < `footer.status-bar top 926` **+17px 间隙**，`appShell bottom 960`；`studio-canvas` `scrollHeight 2811` > `clientHeight 559` **内部滚动**，`studio-document` `min-height:0 display:flex overflow:hidden`，`ledger flex:none` 无 fixed/absolute 覆盖；`overflowX false` `docScrollWidth 1600 == clientWidth`。
  - 控制台/pageerror：`consoles=[]` `pageerror=[]`（仅 Electron Security Warning 无业务错误）。
  - 截图：`/.ai/wmb-5347-deployment-R2-studio.png` 163KB（创作库 → 编辑器，顶部28px工具栏+44px摘要条+可滚动纸张2811px+44px ledger 两段并列+34px全局状态栏，ledger 两段文字完整，无横溢/遮挡） + 旧 R2 长文 125KB/101KB 保留于 `/.ai/wmb-5348-evidence.md`。
  - 交互：`studio-writing-status` 字数1870·来源2·素材0 已保存；`listStudioProjects` 首项 revision2 versionCount2；`status-bar` Pi空闲/AI就绪 全可见。
- **进程回收**: 仅关闭 CDP playwright `browser.close()` 断开 ws，未关闭用户 app；`wemediabuddy-user` 仍 `running` `responding`，`Get-CimInstance WeMediaBuddy.exe` 主/GPU/utility/renderer 四进程存活；测试性 `ws://.../page/...` 临时连接已关闭，无残留浏览器标签。
- **TASKS 更新**: `WMB-5347` 与 `WMB-5348` 已在 `TASKS.md` 追加本部署 evidence 引用与真实正文/视口结果，未新增范围。
- **结论**: 一次 package 成功、一次 writer `prohibited` 成功且 `revision1→2` 无研究派生、Studio 真实 UI 在长正文下保持 44px摘要与44px横向 ledger 完整可见且可点，应用保持运行，测试连接已回收。

*Generated: 2026-08-23 Asia/Shanghai, data root J:/PigeonYang/WeMediaBuddyData, project 2fb16eba-6e30-4e33-8cab-2233135ced4e*

- **2026-08-23 16:17 复验（1920×1032 窗口）**: bar44 ledger44 row44×2 isSingleRow true ledgerBottom981 < statusBarTop998 gap17 overflowX false canvas 2563>669 v2Visible true pageerror[] screenshot wmb-5347-deployment-R2-studio-verified.png 218KB；一次job仍1条 jobsList filtered count1；app responding 4进程存活。
