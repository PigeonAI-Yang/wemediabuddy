purpose: 同轮完成智能体三卡合一、发现页冗余标题与完成态卡删除、全局界面字体统一。
fails-when: 智能体班组概览/席位/派单仍是三个独立外卡；发现页仍显示“发现 + 描述”或 `.discover-task-stream`；“榜单/Lists”继续使用 mono；表单控件字体不继承全局字体；任一页面横向溢出。

Loop: agents-discover-typography
Changes:
- `agents-roster-view.tsx`: 用 `.agents-team-card` 包住概览、五席位与派单栏。
- `styles-agents.css`: 只保留一个外边框；三块内部以 1px divider 分区，移除各自外卡边框/圆角/背景。
- `discover-view.tsx`: 删除顶部“发现 + 描述”标题行；删除今日情报任务卡及其轮询状态、类型和 headline 映射。
- `styles-workflow-library.css`: 删除退役 `.discover-task-stream*` 样式。
- `styles-foundation.css`: 建立 `--font-sans`；root、button、input、textarea、select 统一继承同一字体栈。
- `styles-workflow.css`: `.page-command-stat strong` 从 mono 改为全局 sans，修正“榜单 / Lists”。

Electron proof:
- Agents: `.agents-team-card=1`；原三个 `.agents-roster` 直属独立卡数量 `0`；内部顺序为 `page-command / agents-seat-strip / agents-spawn-bar`；无页面横向溢出。
- Discover: `.page-command-title-row=0`；`.discover-task-stream=0`；“榜单 / Lists”computed font 与 root 完全一致；抽样的 button/input/textarea/select 全部与 root 一致；无页面横向溢出。
- screenshots: `reports/2026-08-08-agents-three-in-one-after.webp`, `reports/2026-08-08-discover-cleanup-fonts-after.webp`。
- runtime: component cutover 后完整 reload；最终两个页面均在真实 Electron 中可见可用。

Verification notes:
- `npm run typecheck -- --pretty false`: 全仓仍有 30 diagnostics / 9 files。改动文件中只有 `agents-roster-view.tsx` 的 2 条既有 `waitingResource` 类型契约问题；Discover 与样式变更没有诊断。没有 suppress 或 fallback。
- 本轮是 UI 改动，以真实 Electron DOM/computed-style/截图为主验收；未新增无行为价值的源码文本测试。

Owner check: 四项用户要求同轮完成；未删除榜单/Lists 导航功能、派单功能或角色席位交互。
Result: pass。
Clean completion: yes。
Blocked reason: none。
