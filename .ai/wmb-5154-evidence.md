# WMB-5154 Evidence

## Root cause
- 主题首页、台账容器和待批卡头分别独立渲染了重复标题/状态；审批动作已经完整表达待决策状态。

## Delivered
- 删除可见页面标题“主题”和台账标题“主题整理提案台账”，保留两个容器的 `aria-label`。
- `proposed` 不再渲染“待你批准”；`approved`、`rejected`、`stale` 继续显示结果标签。
- 删除两个标题对应的死样式；按仓库 ratchet 规则收紧受影响文件行数上限。

## Verification
- 先补失败检查：4 项中 2 项失败，稳定复现重复标题与待批标签；修复后聚焦组合 9/9 PASS。
- `npm run typecheck`、`scripts/check.ps1`、`node scripts/smoke-renderer.mjs`、`git diff --check`：PASS。
- `.ai/wmb-5152-ui-acceptance.mjs`：1440/1100 均 `redundancyRemoved=true`、动作真实可见可点、无横溢出；批准/驳回/失败/终态读回 PASS。
- 截图：`.ai/wmb-5154-topic-1440.png`、`.ai/wmb-5154-topic-1100.png`。

## Review
- `wmb_5154_review`：APPROVE，0 critical/high/medium/low；可访问名称 Chrome AX Tree 实测保留。
- Capability registry impact: no change — renderer-only。
- Pi operator Skill impact: no change — 不改审批行为、权限、工具或提示词。
