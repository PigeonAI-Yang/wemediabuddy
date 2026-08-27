# WMB-5360 验收证据

- 日期：2026-08-28
- 状态：done
- 范围：Planner Source coverage、水印硬门、自动评分与 Owner 审批边界。

## 结果

- migration v78 仅新增 `plan_source_decisions`；唯一键为 `(plan_id, source_id, source_revision)`。
- Planner 候选边界为本轮增量 Source 与 reactivated Evidence Pack Source 的并集。
- 方案合法引用边界为 lane relevant Source 与 reactivated Source 的并集。
- 每个候选必须恰有一个 `selected / excluded / unresolved / blocked` 决策；缺失、重复、越界、stale revision、selected 与 item 引用不一致均在替换 current plan 前失败。
- plans、plan_items、plan_source_decisions 同事务写入；coverage 失败不会生成新 plan，因此外层不会推进 judge watermark。
- Source revision 由服务端冻结，Planner 不猜不可见 revision。
- 有效六维评分仅推进到 `ready_for_review`，不再直接 `approved`，也不提前播种 carry；Owner 批准入口保持唯一批准路径。
- 两处评分校验均补上 `score_total_mismatch`；pending/invalid/malformed 不可批准。
- 正常 daily_judge 链保留一次自动 scoring recovery；只有异常未收口时才暴露“继续评分”。

## Gate

```text
WMB-5360 + scoring + planning orchestration focused:
32 tests, 32 pass, 0 fail

Broader planning/proposals gate:
63 pass, 6 fail
```

宽 gate 的 6 个失败均为既有/过时 fixture：5 个仍预期未评分或已评分保存直接成为 approved，或使用完全相同 POV/angle/audience 被既有 thesis 去重拒绝；1 个旧断言预期 pending reasons 为空，而当前诚实 pending 合同固定保存六个 0 分理由。它们不构成本任务生产回归。评分总分缺口已从该轮识别并修复。

```text
npm run typecheck
PASS
```

独立只读审查 30 分钟未返回证据，已按项目生命周期规则终止；主 Agent 直接复核并关闭了“scored 直接 approved”和“总分不校验”两项真实缺口。
