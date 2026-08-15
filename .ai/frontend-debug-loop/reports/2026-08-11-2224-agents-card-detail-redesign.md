# WMB-5195 — 智能体高卡与运行明细

## Observation packet

- Surface: 开发版 Electron「智能体」页。
- Symptom: 五个固定角色是 85.5px 文字主导矮卡；头像不是视觉中心；没有进度轨与整卡详情交互；`agents-team-card` / `agents-spawn-bar` 手动派单区与 Pi 主管派工主路径重复。
- Expected: 五角色高卡、大头像居中、真实进度主导；整卡点击查看当前实例的真实进度、消息和工具调用；手动派单区完整删除。
- Root cause: overview 仍使用旧紧凑行布局；renderer 只读 roster/crew projection，无法读取任意员工 session transcript；`instanceProgressRatio` 还按 phase 猜测 0.62/0.28/0.15；派单区未随 Pi 主管主路径切换清理。

## Repair

- `src/renderer/agents-roster-overview.tsx`、`styles-agents-overview.css`: 五角色整卡 button；60px 圆形头像；角色/科室、进度轨、状态层级；按内容区 auto-fit，Pi 展开时不压扁卡片。
- `src/renderer/agents-roster-view.tsx`、`agents-detail-drawer.tsx`、`styles-agents.css`: 删除整个手动派单区；保留角色/Skill 配置、活动实例、历史工单与续派；新增右侧运行明细 drawer、多实例切换、ESC/背板关闭和返回焦点。员工按 selected job 重读；主管以 roster taskId 读取真实任务，并复用当前 Pi conversation + dock `onPiEvent` 流实时归并 tool/thinking/text，轮询时保留尚未持久化的 streaming 消息。
- `src/main/pi-transcript-projection.ts`、`ipc-today-studio-business.ts`、`preload.ts`、`global.d.ts`: 新增 jobId-only `agents:task-transcript` 只读链路；authoritative crew projection 反查 session；daily/employee 文件名白名单与 data-root containment；缺失、错 jobId、穿越或解析失败返回 null。
- `src/main/crew-instance-projection.ts`: `progressRatio` 仅在 running 且 `planned > 0` 时使用 clamp(processed/planned)，删除 phase 猜值。
- 空闲卡进度填充宽度固定为 0；running 且无真实比例显示不确定轨，不显示数字百分比。
- `src/renderer/pi-dock-utils.ts`: 提取可测试的 dock transcript 事件投影与磁盘/实时流对账；非 dock 事件不混入主管记录。

## Verification

- `npm run typecheck`: exit 0。
- 聚焦回归：`pi-message-flow` + `wmb-5142-instance-projection` + `wmb-5143-agents-instance-view` + `wmb-5195-task-transcript`，60/60 PASS；其中主管实时流覆盖 tool 输入/输出、thinking、text、idle 收束、非 dock 隔离与轮询不覆盖 live tool。
- transcript 安全矩阵 5/5 PASS：合法 employee/daily session 可读；未知 job、缺文件、损坏 JSONL、路径穿越、错 jobId 均 fail-closed。
- 真实开发版 Electron：
  - 1672×920：五卡单行，均 189×181px，头像 60px；四张空闲卡 fill width 全为 0；手动派单 DOM 数 0；整页 `scrollWidth === innerWidth === 1672`。
  - 1366×850：卡片按内容区 3+2 换行，均 219×181px，科室仍可见，无横向溢出。
  - 1100×760：卡片 2+2+1，均 200×181px；详情 drawer x=257/w=420，Pi x=677/w=423，二者相邻不重叠，无横向溢出。
  - 点击记者/策划/写手卡均打开对应 drawer；当前无员工活动实例时精确显示「暂无运行明细」；ESC 关闭后焦点返回原卡。
  - 点击主管卡：真实显示状态「工作中」、进度 15%、taskId/intent/phase，当前 Pi 会话 16 条可见消息中识别 23 条 tool 记录；drawer 与 Pi overlap=0；手动派单 DOM=0；`scrollWidth === innerWidth === 1939`；page/console errors=`[]`。
- 当前实机没有活动员工实例，因此员工真实工具消息的非空视觉态由 seeded employee/daily transcript 行为测试覆盖；未伪造活动任务用于截图。

Capability registry impact: no change. Pi operator Skill impact: no change. DB schema / dependency impact: no change.
