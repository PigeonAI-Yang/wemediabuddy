# WMB-4811 跨页面设计实现证据

## 范围与决定

本任务落实 `DESIGN.md` 的界面层设计规则，不修改 `PRD.md`、`SPEC.md` 或 `TECHNICAL_DESIGN.md`：

- Today、Studio、Results 的指标条改为可执行的业务句子；
- Studio 项目统计从数据库真实汇总读取，不再以当前 50 条分页结果冒充总数；
- Library 按今天、昨天、近 7 天、更早分组，并在卡面显示来源域名、使用状态和关联数量；
- Studio 编辑格式栏按段落、行内格式、列表、插入、编辑形成语义分组；
- Today、Publish、Results、Studio、Channels 等业务界面移除 MCP、revision、operation、Task grant、外部 Agent 等内部工程措辞，改用用户语言。

Pi operator Skill impact: no change — 本任务只改变呈现、只读汇总及控件语义分组；没有新增或改变 Pi/MCP 工具、操作顺序、授权边界、任务状态、错误恢复或最终发布确认流程。

## 实现路径

- Studio 真实汇总：`src/main/content.ts` → `src/main/ipc-today-studio-business.ts` (`studio:summary`) → `src/preload/preload.ts` → `src/renderer/global.d.ts` → `src/renderer/studio-view.tsx`。
- Today / Results 行动句：`src/renderer/today-view.tsx`、`src/renderer/results-view.tsx`。
- Library 分组与卡面：`src/renderer/library-view.tsx`、`src/renderer/styles-knowledge.css`。
- Studio 格式栏：`src/renderer/studio-view-panels.tsx`、`src/renderer/styles-studio.css`。
- 用户语言：`src/renderer/main.tsx`、`src/renderer/publishing-results-view.tsx`、`src/renderer/intelligence-channels-view.tsx`、`src/renderer/task-grant-control.tsx`、`src/renderer/studio-view.tsx`、`src/renderer/settings-view.tsx`。
- Studio 汇总回归：`tests/content-list-detail-child.mjs`。

## 聚焦验证

- `npm run typecheck`：通过。
- `node --test tests/content-list-detail.test.mjs`：1 passed，0 failed。
- `node scripts/smoke-renderer.mjs`：`[wmb-smoke] ok http://127.0.0.1:27391/`。
- 真实 Electron（1600×960）DOM 读回：
  - Studio：`10 全部 / 10 创作中 / 0 待审 / 0 待发布 / 0 已完成 / 7 已归档`；行动句 `10 个创作中，本周更新 6 个。`；5 个格式语义组、4 条分隔线；无横向溢出。
  - Library：今天 24 条、昨天 17 条、近 7 天 9 条，共 50 张资料卡；无横向溢出。
  - Results：`本周期 3 条已发布，2 条已复盘；1 条发布超过 72h 待复盘，见底部待复盘队列。`；无横向溢出。
  - Publish：显示 `AI 接入服务`，未出现 `MCP 服务`、`publication rev`、`operation`、`revision`、`Task grant`、`外部 Agent`；无横向溢出。

## 最终验收

- `npm test`：258 passed，0 failed，0 cancelled，0 skipped；161266 ms。
- `npm run build`：Electron Forge 为 win32 x64 成功完成 main、preload、renderer production bundles 与 package；产物 `out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe` 和 `out/WeMediaBuddy-win32-x64/resources/app.asar` 存在。
- 打包应用真实启动并通过 CDP 读回：标题 `WeMediaBuddy`；renderer 使用 `file:` 协议加载 `app.asar/.vite/renderer/main_window/index.html`；`#root` 有内容；文档宽度与视口均为 1600，无横向溢出。
- Forge 当前未配置 maker，因此正式项目脚本交付的是可运行 Windows 目录，不宣称生成 MSI 或 Setup.exe。

## 残余风险

- 本任务没有改变发布确认或业务状态机；验证覆盖了设计要求涉及的真实页面与打包启动，但没有对每一种数据规模执行截图级视觉差分。
