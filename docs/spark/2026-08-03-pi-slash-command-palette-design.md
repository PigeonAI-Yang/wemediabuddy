# Pi 斜杆命令面板方案

- 状态：实施中
- 日期：2026-08-03
- 依赖：WMB-2503 完成
- 合同：REQ-025、AC-021、CAP-024、EVAL-027

## 1. 决策

Pi dock 复用 Codex Desktop 的核心体验：输入框首字符为 `/` 时，在输入框上方展示当前 Pi 真正可执行的命令；用户筛选、选择、补充参数后再发送。面板不是另一套命令系统，也不把 Settings、Skill 管理或业务模块搬进首屏。

唯一目录来源是当前工作空间受监管 Pi RPC 的 `get_commands`。它原生返回扩展命令、提示模板和 Skills，且这些命令可通过 `prompt` 的 `/name` 形式调用。Pi 交互终端内置的 `/settings`、`/hotkeys` 等命令不在该响应中，也不能由 RPC 执行，因此 WMB 不显示或仿造它们。

## 2. 交互

1. 空输入框输入 `/`：面板立即显示加载状态，并按需读取真实目录。
2. 继续输入：按名称和说明做不区分大小写的包含筛选，名称前缀优先；不引入模糊搜索依赖。
3. 每行显示 `/name`、说明和 `Skill` / `提示模板` / `扩展命令` 类型；Skills 保留原生 `/skill:<name>`。
4. `ArrowUp` / `ArrowDown` 移动，`Enter` / `Tab` 只插入 `/<name> `，`Escape` 关闭；鼠标点击等价。
5. 命令后输入参数时面板关闭。此后 `Enter`、`Alt+Enter`、`Shift+Enter` 沿用现有发送、下一轮和换行语义。
6. 选择本身零发送；不意外启动创作、修改数据或执行外部操作。

面板使用 `listbox` / `option` 语义，活动项保持可见。加载失败只在面板内说明；不清空草稿、不返回伪静态目录。

## 3. 数据与调用链

```text
输入框出现 / 且尚无参数
→ preload: listPiCommands()
→ Main 选择当前 data-root 并 ensurePi
→ PiRpcSupervisor.getCommands()
→ Pi RPC get_commands
→ Main 仅保留 name / description / source
→ Renderer 筛选和插入 /name
→ 用户补充参数并发送
→ 既有 pi:chat
→ Pi 原生展开 Skill / prompt / extension command
```

Main 丢弃 Pi 返回的绝对 `path` 和无效 source。Renderer 不能传入要查询或执行的命令名；目录 IPC 无参数、只读。命令执行不增加 IPC，继续经过现有 `pi:chat`、Pi 队列、MCP 和发布确认边界。

## 4. Skill 更新一致性

CAP-023 的 Skill 保存、重命名和删除会停止当前 Pi。面板每次从关闭转为打开都重新读取目录，不长期缓存；所以下一次读取会启动或复用下一个 Pi 进程，并反映安装级 Skill 最新状态。无需第二份 Skill 索引或 Renderer 合并逻辑。

## 5. 实现边界

- 从现有过长 `pi-dock.tsx` 移出 `PiComposer`，在独立文件内实现面板，不继续扩大该文件。
- 使用 React 状态、原生键盘事件和 CSS；不增加依赖、命令注册表或通用插件抽象。
- 只显示 RPC 返回的三种 source；不暴露文件路径、任意命令执行、业务确认或最终发布能力。
- Settings 仍是 Skill 管理位置；Pi dock 只负责发现和调用。

## 6. 可证伪验收

### Focused

- fake Pi RPC 对 `get_commands` 返回三种命令，Supervisor 和 Main 正确读回；空名称、未知 source、绝对 path 不进入 Renderer。
- 筛选按名称前缀优先、说明包含次之；选择结果严格为 `/<name> `。
- 结构检查覆盖 listbox/option、ArrowUp/ArrowDown、Enter/Tab/Escape 和不在选择时调用发送。

### 当前 Windows 包

- 输入 `/` 的可见列表来自真实 Pi，包含当前 operator、lane 与普通安装级 Skills，不包含 `/settings` 或 `/hotkeys`。
- 键盘和鼠标选择后输入框出现完整命令且会话数量/消息数不变；追加参数并发送后，原始 Pi session 读回对应 Skill 加载。
- Settings 依次创建、修改、删除一个临时 Skill；每次下一 Pi 进程的面板目录与 data-root Skill 副本完全一致，删除后不残留。
- 1100×700 与 1920×900 下列表不越界，键盘活动项可见，输入框和既有模型菜单/停止/队列行为不回归。

## 7. Pi 操作 Skill 维护影响

不更新 `wemedia-buddy-operator`：本能力只把 Pi 已有命令目录呈现给用户，不改变任何 WMB 业务工作流、工具名、授权步骤或错误处置。若后续新增 WMB 自有斜杆命令或改变 Skill 管理路径，才需要按维护合同同步更新该 Skill。
