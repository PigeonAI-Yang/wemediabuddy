# WeMediaBuddy 全面诊断（2026-08-08）

> 并发修订说明（23:32 复核）：诊断期间另一线程仍在修改 agent/job 契约文件。初次快照的 21 个 TypeScript 错误已降为 12 个；agent-work/basic-agent 两组原 4 个失败已转绿。下文原始数字保留为当时快照，因果归属见当前会话答复。X observation 悬挂、资料员历史秒失败、Discover 旧结构断言和 migration-50 fixture 仍成立。

## 结论

当前应用“可打开、可浏览、核心数据可读”，但不能判定为工程健康。最主要问题不在界面，而在运行时与契约层：X 观察队列存在确定的悬挂状态，资料员工单存在真实秒失败且错误证据被压平，TypeScript 已失去绿线，完整测试套件既失败又不退出。界面层本轮没有发现横向溢出、空白页、字体漂移或点击导航崩溃。

## 验证范围

- 真实 Electron：1769×1006，逐页打开「今日、智能体、发现、资料库、选题、创作、发布、结果、系统、画布、设置」。
- 每页采集：renderer exception、页面可见错误文本、document/workspace overflow、root font、表单可访问名称、空白页。
- 运行时：Electron/Vite/MCP 进程、Pi 模型端点、agent roster/job pool、应用日志。
- 数据：SQLite `PRAGMA quick_check`、关键表、source 去重、agent task、X observation job、publication 终态。
- 工程：`npm run typecheck`、`npm test`、关键失败用例单独复现。

视觉证据：`reports/2026-08-08-comprehensive-diagnosis-agents.webp`

## P0：先修

### 1. X 观察任务会被永久留在 `running`

**现场证据**

- `jobs(kind='x_list_observation')`：`running=15`、`pending=5`、`succeeded=1125`、`needs_user=106`。
- 15 条 running 行没有 `last_error`；其中 10 条 attempts=46、5 条 attempts=47；本轮检查时仍未自动回收。
- `src/main/x-observation-jobs.ts:258-266`：任务 claim 后，如果 `isCurrent()` 在 timeline 读取后变 false，代码直接 `continue`，没有 finish、reset 或 lease ownership handoff。
- `recoverRunningXObservationJobs()` 只在 scheduler `start()` 时把 running 重置为 pending。一次 HMR/运行代切换即可再次把已 claim 行留为 running；当前 scheduler 不再拥有这些行，也不会二次回收。

**影响**

X List 延迟观察会静默漏跑；大量重载后 attempts 持续增长，运行态不代表真实执行态。

**修复方向**

claim 后所有退出分支必须落确定终态或 CAS 重置为 pending；恢复应带 generation/owner，而不是无条件全表 reset。增加“generation 失效发生在 timeline 返回后”的可复现测试。

### 2. 资料员工单真实秒失败，且错误被压平成无信息 `JOB_FAILED`

**现场证据**

- 真实任务 `8262163f-4adc-4436-92e8-02bb9317e4d5`：`page_library`，创建到失败仅 32ms；`pi_session_id=null`、events/progress 为空、`error_code=JOB_FAILED`、`error_message=工单执行失败`。
- 对应 roster 显示资料员“最近：failed”；没有生成 `agent/sessions/job-*.jsonl`，故失败发生在可审计 Pi 会话之前。
- 同一时间段写手任务成功生成真实 session 文件，说明不是整个 Pi runtime 永久不可用。
- `JobSpawner`/`GenericEmployeeRunner` 有多层错误映射；最终 DB 仅保留通用错误，原始启动异常不可追溯。

**影响**

资料库批量整理不可依赖；用户只能看到失败，无法知道是 prerequisite、grant、layout、extension、runtime spawn 还是 provider。

**修复方向**

先补可观察性：pool report、agent_task error、应用日志必须保留同一个原始 code/message 和 jobId；随后用原简报复现，定位发生在 `dispatchStartAgentTask → onTaskReady → ensurePiConversationLayout/preparePiExtension → startPiRuntimeWithFallback` 的哪一步。不要只改 UI 文案。

## P1：工程绿线已断

### 3. TypeScript：21 个错误，分布于 8 个主进程文件

`npm run typecheck` 失败。主要簇：

- `AgentTaskProgress` 契约漂移：`message`、`streamActivityAt` 的生产者/消费者不一致。
- runtime resource 泛型错误：把 `{url}` 当成要求 `close()` 的 `Closable`。
- role job union 收窄失败：librarian 没有 `businessDate`，child `roleId` 被扩成 string。
- `job-pool` nullable pick 未收窄。
- `agent-runner` readonly 数组被 push、参数对象读取不存在的 `sessionFile`。

当前 Electron 能跑是因为 dev bundler 转译不做完整类型验收；这不是可发布状态。

### 4. 完整测试套件失败且 300 秒不退出

`npm test` 在 300 秒被终止；终止前已观察到至少 125 pass、17 fail，且没有最终 summary。失败分四类：

1. **Node ESM 运行失败**：`ipc-pi-dock.ts` 多个本地 import 缺 `.ts`，导致 `ERR_MODULE_NOT_FOUND: src/main/pi-conversation`，连带 command dispatcher、content list/detail、daily channels、proposal 等子进程测试失败。
2. **迁移 fixture 过期**：EVAL-029 仍断言 schema migrations 精确到 49；仓库已经有 migration 50，单文件复现为 4 pass / 5 fail。
3. **角色契约测试过期**：测试仍期望 `桌助`，产品已经切到 `主管`；writer spawn 测试没有按新契约传 `projectId`。
4. **结构/行为断言过期**：Discover 测试硬匹配旧 `<nav>` 源码结构；daily gate 测试仍期待 orphan judging `return_active`，现实现会先 partial 收尸，再以 stage lock 启动 judge-only。

另外，套件在最后一组 stress 输出后长期不退出，说明至少有测试子进程/句柄泄漏或未 settle promise；需在上述确定失败修完后用 `--test-reporter`/逐文件二分定位。

### 5. Agent 状态语义仍显混乱

- 当前 roster 全部 idle，但主管与写手的最近任务是 `interrupted`；这是本次 dev main 重载后恢复产生的真实终态，不是当前仍运行。
- planner 最近任务已 completed，说明 daily 主链后来能完成。
- job pool 当前空；roster 的“最近状态”与“当前状态”需要继续明确区分，避免用户把历史 failed/interrupted 理解为正在故障。

## P2：已观察但非当前阻断

### 6. Pi 主会话曾出现瞬时连接错误，当前已恢复

- session `0b45f297-...jsonl` 在 13:51 连续记录 `deepseek-v4-flash / openai-responses / Connection error`。
- 当前通过应用正式 `listPiModels` 路径验证：profile `OpenCode Go`，25 个模型，选中模型存在。
- 因此结论是历史瞬时 provider/网络失败，不是当前配置永久失效。

### 7. 一条小红书发布记录为 `unknown`

- publication `dd387e10-...`，错误 `PUBLICATION_UNKNOWN`：小红书发布结果无法唯一匹配。
- 这是 2026-07-27 的明确历史终态，有 code/message，不属于数据库损坏；应由“人工确认/重对账”流程处理。

## 正常项

- SQLite `PRAGMA quick_check = ok`；63 张表可读。
- `source_items` canonical URL 重复=0、content fingerprint 重复=0。
- 11 个 Electron 页面均成功显示；页面根节点不是空白。
- 全部页面 `documentOverflowX=false`、workspace overflow=false。
- root 字体统一为 `Inter, PingFang SC, Microsoft YaHei UI, Segoe UI, system-ui, sans-serif`；未发现局部字体漂移。
- 页面导航期间捕获到 0 个新的 renderer exception。
- 表单“无 label”初筛均为 wrapped-label 或有 placeholder；未确认真实无障碍名称缺失。

## 建议修复顺序

1. 修 X observation claim 后失效分支，清理现存 15 条悬挂 running，并以 fixture 验证不再复发。
2. 为资料员失败链补原始错误持久化，再复现并修根因。
3. 修 21 个 TypeScript 错误，统一 `AgentTaskProgress`/runtime/role job 契约。
4. 修 ESM import、migration 50 fixture、角色与 Discover/Daily 过期测试。
5. 定位测试套件不退出的句柄；最后跑完整 typecheck + test + 真实 Electron 页面烟测。
