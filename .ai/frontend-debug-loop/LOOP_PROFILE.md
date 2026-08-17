selected-milestone: WMB-5322
project-purpose: 设置页需要让用户先理解 Provider 预设与五角色策略的关系，再低摩擦地配置每个候选的模型、推理强度和顺序。
target-surface: 设置 > AI 与模型 > 模型预设与角色分配。
runtime-chain: settings snapshot -> role policy draft -> candidate rows/actions -> saveRoleModelPolicies IPC.
completion-authority: TASKS.md WMB-5322 doing row + designer-reviewed hierarchy + real Electron STG-009 at 1100x800.
focused-gate: Provider 管理与角色分配层级清晰；候选行不再同时呈现多个同权菜单/文字动作；添加、推理强度、排序、移除和保存仍可用。
budgets: implementation attempts=1; repair attempts=1; product files max=3; scope growth=0.
stop-conditions: 需要改后端合同/DB schema/依赖、角色运行时语义、权限/发布边界或 foundation brand token。
