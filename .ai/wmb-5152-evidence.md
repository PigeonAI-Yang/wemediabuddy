# WMB-5152 Evidence

## Root cause
- 审批按钮只继承普通动作容器，没有现有 `primary-button` / `secondary-button` 语义。
- 台账默认层直接渲染状态码、revision、对象 ID 和原始关系字段。

## Delivered
- 主视图按“资料员建议 / 批准后影响 / 审批动作”组织；批准为紫罗兰主按钮，驳回为高对比次按钮。
- 状态翻译为“待你批准 / 已批准并生效 / 已驳回 / 现场已变化”。
- 完整变更默认折叠；ID、revision、relation 与批准前后原始关系只在二级“技术明细”展开。
- 审批失败与首次加载失败均保持 `role="alert"` 可见；批准和驳回使用各自的处理中提示。

## Verification
- `node --test tests/wmb-5152-topic-approval-ui.test.mjs tests/wmb-5150-topic-maintenance.test.mjs tests/wmb-5143-agents-instance-view.test.mjs`：26/26 PASS。
- `.ai/wmb-5152-ui-acceptance.mjs`：1440/1100 主次色、用户语言、二级折叠、无横溢出 PASS；真实批准、驳回、失败 alert 与批准前后关系读回 PASS。
- `npm run typecheck`、`scripts/check.ps1`、`scripts/smoke-renderer.mjs`、`git diff --check`：PASS。
- 截图：`.ai/wmb-5152-topic-1440.png`、`.ai/wmb-5152-topic-1100.png`。

## Review
- `wmb_5152_review` 三轮只读审查发现的错误可见性、明细完整性、忙碌文案和测试缺口均已修复；最终遗留测试缺口由批准/驳回/失败三条实机读回关闭。
- Capability registry impact: no change — 既有 Owner 审批命令与权限未变。
- Pi operator Skill impact: no change — 纯审批组件展示调整，不改可观察业务流程与工具协议。
