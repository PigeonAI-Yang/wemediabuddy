# WMB-5155 Evidence

## Root cause
- `.topic-home` 是固定高度纵向 Flex；台账默认 `flex-shrink:1`，与工具栏和主题网格共同收缩。
- 真实 row 高 334.97px，ledger 被压到 113.97px，再被自身 `overflow:hidden` 裁掉正文、明细入口和失效说明。

## Delivered
- `.topic-maintenance-ledger` 增加 `flex:none`；不新增组件、按钮或业务流程。
- 验收脚本新增 `ledgerNotClipped`，锁定容器 `scrollHeight <= clientHeight + 1`。

## Verification
- 真实库记录：2 项 change、10 条资料关联、2 条选题、3 条持续关注，排除数据缺失。
- 修复前 1440/1100 `ledgerNotClipped=false`；修复后两档均为 true、无横溢出。
- 真实 Electron 同一记录：ledger 336.97px、clientHeight 335、scrollHeight 335；“查看完整变更明细”点击后 `open=true`。
- 截图：`.ai/frontend-debug-loop/reports/2026-08-10-wmb-5155-topic-ledger-after.png`。
- 聚焦 9/9、typecheck、`scripts/check.ps1`、smoke、diff check：PASS。

## Review
- `wmb_5155_review`：实现 APPROVE；唯一 LOW 为闭环记录未收口，已同步 after 数据并改为 complete。
- Capability registry impact: no change — renderer CSS only。
- Pi operator Skill impact: no change — 不改审批语义、权限、工具或提示词。
