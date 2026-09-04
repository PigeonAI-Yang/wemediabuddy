project-purpose: 设置页与 Pi 快捷菜单只允许用户选择当前模型实际支持的思考等级，无法确认能力时保留自动模式。
target-surface: 设置 > AI 与模型 > 模型预设 / 角色分配；Pi 对话框 > 模型与推理。
runtime-chain: Provider /models + Pi 内置模型目录 -> listPiModels thinkingLevels -> 模型选择控件 -> savePiConfig -> generated models.json thinkingLevelMap -> Pi runtime clamp。
completion-authority: real Electron STG-009 at 1600x960, focused pi-config tests, typecheck, production package build。
focused-gate: 模型切换后只显示 thinkingLevels 声明的等级；非推理/未知模型退回自动；自动可清除旧的固定 thinking；models.json 使用同一能力解析结果。
budgets: implementation attempts=1; repair attempts=1; product files max=15; scope growth=0。
stop-conditions: 需要修改 foundation brand token、Provider 鉴权协议、数据库 schema，或 Pi runtime 不接受 thinkingLevelMap。
