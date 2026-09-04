purpose: 设置总机必须稳定选择模型，并让设置页与 Pi 对话框对同一模型展示完全一致、经过验证的思考等级。
fails-when: 模型目录或手填值被后台刷新覆盖；同一模型在两处显示不同等级；未知模型继续显示历史固定 MAX；运行时声明与 UI 不一致。

Loop: 2026-09-04-settings-model-picker-refresh + model-reasoning-picker-consistency
Symptom: 模型列表和手填值曾被 settings 刷新覆盖；能力过滤落地后，Muse 模型在 Pi 对话框只显示自动，但设置页仍显示旧 MAX。
Observation packet: 1600x960 Electron；本地 Provider 返回无 reasoning 元数据的 muse-spark-1.3-contributor、reasoning=false 的 alpha、仅 low/high 的 beta。
Hypotheses: 首个根因为 profile effect 依赖数组身份；第二个根因为模型能力元数据曾被丢弃；本次不一致根因为 settings 的 unknown fallback 特意保留 current saved thinking，而 Pi 对话框要求 thinkingLevels 明确包含该等级。
Bug type: timing-stale；contract-missing；fallback-divergence。
Chain traced: Provider /models + Pi ModelRuntime -> listPiModels -> settings-view / pi-dock / pi-composer -> savePiConfig -> generated models.json。
Breakpoint: settings-view.tsx thinkingOptionsForModel current fallback 与 piThinking 校验时机。
Root cause: muse-spark-1.3-contributor 不在当前 Pi 内置模型目录，Provider 响应也没有 reasoning/thinkingLevelMap；MAX 只是设置页保留的历史值，不是已验证能力。
Files changed in consistency repair: src/renderer/settings-view.tsx；src/renderer/pi-dock.tsx；tests/e2e/settings.test.mjs。
Before/after gate: before 为设置页显示自动/MAX、对话框只显示自动；after 为能力目录加载前后设置页均不展示未经验证等级，Muse 两处 options 都严格等于 [auto]。
Proof: tests/e2e/.artifacts/STG-009-settings-role-provider-models-FuaWt2/pi-model-reasoning-unknown-1100-screenshot.png；STG-009 passed；node --test tests/pi-config.test.mjs passed；npm run typecheck passed。
Owner check: 用户路径可用；未知模型不猜测 MAX；有明确元数据的模型仍只显示实际支持等级；自动保存会清除旧固定 thinking。
Result: 设置页移除未知模型的历史等级回显，并在目录加载、模型切换和手填时统一回退自动；Pi 菜单切换未知模型也立即回退自动。
State update: done。
Clean completion: yes
Blocked reason: none
