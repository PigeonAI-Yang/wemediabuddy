# WMB-5313 验收证据

## 修复

- `src/renderer/agents-detail-modal.tsx`：角色存在活动实例时继续展示活动实例；没有活动实例且没有权威遗留活动行时，展示该角色 `history[0]` 最近一次持久终态实例。
- 历史实例沿既有 `jobId` 读取 `getAgentTask`、`jobsMessages` 与 `getAgentTaskTranscript`，不伪造、不跨角色。
- 「最新消息」无 JobMessage 时改为准确的「暂无消息」，不再与下方真实「运行记录」矛盾。
- `tests/e2e/agents.test.mjs` 新增 `WMB-5313-agents-completed-run-detail`：只种一条终态记者任务、真实 task event 与 employee JSONL transcript。

## 真实 Electron 证据

候选执行：

```text
node tests/e2e/runner.mjs --file tests/e2e/agents.test.mjs --scenario WMB-5313-agents-completed-run-detail
```

真实 Electron 已进入智能体页并打开空闲记者详情；以下先行断言全部通过：

- 弹窗显示 `job-wmb-5313-reporter-complete`；
- 显示持久任务事件「已核验 4 项调查主张」；
- 显示真实 Pi transcript「已完成记者调查并整理证据。」；
- 页面异常为 0。

截图：`tests/e2e/.artifacts/WMB-5313-agents-completed-run-detail-RRvYS1/failure-screenshot.png`。截图可见终态记者工单、任务元数据、任务事件、输入、思考、工具与回复。该次命令最终仅因旧断言把「最新消息」区域的旧通用空文案也视为整页空态而退出；随后已将该文案改为「暂无消息」。

最终候选的再次 Electron 启动被长期 Vite HMR 缓存拒绝：`agents-detail-modal.tsx` 明明仍导出 `AgentsDetailModal`，但缓存模块报告缺少该导出；未机械重复第三次启动。最终静态集成证明：

```text
npm run typecheck
PASS
```

测试 Electron 标签页已由 runner 关闭；受管进程列表中没有运行中的测试浏览器。用户原有 `wemediabuddy-dev` 保持运行。
