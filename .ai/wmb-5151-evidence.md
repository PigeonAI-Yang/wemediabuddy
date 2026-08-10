# WMB-5151 Evidence

## Delivered
- 班组概览置顶；状态摘要、设置入口和派单压缩为第二块。
- 活动实例与历史工单合并为一个连续组件。
- 投影未就绪时概览显示读取态，不再虚构“当前无任务”；状态筛选补齐 `aria-pressed` 与筛选组语义。

## Verification
- `node --test tests/wmb-5143-agents-instance-view.test.mjs`：18/18 PASS。
- `npm run typecheck`：PASS。
- `powershell -ExecutionPolicy Bypass -File scripts/check.ps1`：PASS。
- `node scripts/smoke-renderer.mjs`：WeMediaBuddy title + `#root` PASS。
- 实机：`.ai/wmb-5151-agents-1440.png`、`.ai/wmb-5151-agents-1100.png`，无横向溢出。

## Review
- `wmb_5151_review` 确认三区顺序、交互保持与两档视觉；指出加载态和筛选辅助语义两项 medium，均已修复并由 18/18 回归锁定。
- Capability registry impact: no change — renderer-only。
- Pi operator Skill impact: no change — 不改工具、提示词或业务流程。
