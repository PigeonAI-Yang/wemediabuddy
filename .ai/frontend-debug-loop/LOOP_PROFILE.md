project-purpose: 让用户在长期知识对象之间建立可追溯关系，并把精确选区交给 Pi。
target-surface: Electron 关系画布，1100px 与 1600px 桌面窗口。
runtime-chain: SQLite -> knowledge-canvas business functions -> IPC -> React state -> canvas DOM/SVG -> pointer events.
completion-authority: 同一真实窗口中从节点端口拖到另一节点，选择关系类型后出现带方向和标签的持久连线；视觉结构与已批准 HTML 设计稿同尺寸对照。
focused-gate: 真实数据、真实 Electron、重启后读回。
budgets: 每个症状一次根因修复，一次失败后的修复；不新增依赖。
stop-conditions: 无法稳定复现、根因不在当前页面、需要改变已批准产品范围。
