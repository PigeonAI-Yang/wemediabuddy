# WMB-5156 Evidence

## Delivered
- 删除“变更前主题 / 批准后主题”两份重复清单和不可交互状态标签。
- 展开区只列真实变化，以普通文字表达名称、状态、类型、说明和主题识别方式的变化。
- 没有主题字段变化时显示“主题状态不变，仅调整关联内容”；完整快照仍在二级技术明细。

## Verification
- 真实失效记录只显示 1 条变化：`状态：持续关注 → 已归档`；`changedRows=1`、旧标题 false、伪状态控件 0、横溢出 false。
- summary-only：`说明：无 → 新的主题说明`；relation-only：正确显示主题状态不变。两条实机读回均 PASS。
- `.ai/wmb-5152-ui-acceptance.mjs`：1440/1100 全绿；批准、驳回、失败、终态和技术明细保持。
- 截图：`.ai/wmb-5156-topic-real.png`。
- 聚焦 9/9、typecheck、`scripts/check.ps1`、smoke、diff check：PASS。

## Review
- `wmb_5156_review` 指出 summary/kind/canonical_key 漏比较 HIGH；已补全部可审批主题字段。
- `wmb_5156_rereview`：PASS，HIGH 关闭，无新 blocker/high/medium。
- Capability registry impact: no change — renderer-only。
- Pi operator Skill impact: no change — 不改审批、权限、工具与提示词。
