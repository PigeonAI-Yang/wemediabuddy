purpose: AI 与模型页应让用户区分“读取本机配置”和“真实连接 Provider”，并让获取模型操作产生就地、可信、可见的结果。
fails-when: 查找动作仍被误解为联网验证，或点击获取模型后当前视口没有进度、成功或失败反馈。

Loop: 2026-09-02-provider-discovery-and-model-fetch
Symptom: 查找按钮样式与相邻文字动作不一致；107ms 即显示“已发现”；载入 Antigravity Cockpit 后获取模型看似无效。
Observation packet: 安装版 1568x958。发现耗时 107ms。原获取模型失败为“凭证命令退出码 1”，提示位于 top=1715px，超出 960px 视口。
Hypotheses: discovery 只读取本机配置；renderer 将命令参数用空格拼接后又按换行拆分，导致 PowerShell 参数数组损坏。
Bug type: event 正常，side-effect 输入错误 + feedback DOM 位置错误 + 文案语义错误。
Chain traced: 查找按钮 -> discoverPiProviders -> 本机配置文件；候选载入 -> renderer credential draft -> listPiModels IPC -> credential command -> /models -> model picker。
Breakpoint: `src/renderer/settings-view.tsx` 的 `applyDiscoveredProvider()` 与反馈渲染位置。
Root cause: “发现”没有联网含义但 UI 声称“已发现”；`args.join(' ')` 破坏命令参数；获取模型反馈复用页面底部状态，当前视口不可见。
Files changed: `src/renderer/settings-view.tsx`, `src/renderer/styles-studio.css`, `tests/e2e/settings.test.mjs`。
Before/after gate: 三个工具栏按钮现在 class、height 33.5px、padding、透明背景和无边框完全一致。查找后明确显示“从本机配置文件找到 1 项，尚未验证连接”。载入后真实请求耗时 651ms，返回 14 个模型，状态位于 top=786px 的当前视口。
Owner check: 真实安装版、真实 Antigravity Cockpit、真实模型列表；loading/empty/error/success 文案齐；旧设置结构和品牌 token 未改。
Result: 修复并覆盖安装版。
State update: done。
Clean completion: yes。
Blocked reason: none。
