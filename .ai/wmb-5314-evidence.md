# WMB-5314 验收证据

## 根因

`RoleOverviewRow` 的当前态包含三类真实来源：JobPool `projection.active`、未进入 JobPool 的 running/needs_user `RosterRow`、主管 Pi worker 占用。中央「进行中的任务」此前只读取第一类，因此会与角色卡同屏冲突。

## 修复

- `AgentsRosterView` 合并三类当前来源，并按角色去重：已有 JobPool 实例时不重复渲染 roster 行。
- 新增 `ActiveRosterTask`，在中央区展示真实角色、状态、摘要、进度、intent/task ID 和「查看运行明细」入口。
- 只有 JobPool、legacy roster、desk 占用全部为空时才显示「当前无进行中的任务」。
- legacy/desk 卡不伪造 JobPool 取消能力，不改变任务生命周期。

## 真实 Electron gate

```text
node tests/e2e/runner.mjs --file tests/e2e/agents.test.mjs --scenario AG-008-agents-legacy-task-avatar
PASS 1/1
```

覆盖：JobPool 投影为空、SQLite 持久记者任务 running；顶部角色卡与中央区同时显示 `task-e2e-legacy-scan`、工作中、25% 和同一真实摘要；中央空态不存在；从中央入口打开同一任务详情；关闭后焦点归还触发按钮；page error 0。

证据目录：`tests/e2e/.artifacts/AG-008-agents-legacy-task-avatar-pJnJ8z`。

测试 Electron 标签页由 runner 关闭；受管进程列表无运行中的测试浏览器。用户原有 `wemediabuddy-dev` 保持运行。
