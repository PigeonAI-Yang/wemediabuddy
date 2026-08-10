# WMB-5157 Evidence

## Root cause
- 最新误判提案 `1ba33d3b...` 的目标 topics 与其它正式对象全部未变。
- 快照含 5 条 sourceLinks；批准校验从快照全部资料反推 source scope，额外拉入 6 条 7 月已存在的第三主题关系，错误判 stale。
- 生成快照只使用显式 `reassign.sourceId`，批准校验边界与其不对称。

## Delivered
- `currentMatches` 接收 proposal changes，并从显式 reassign source 去重生成 source scope；其它严格快照比较保持。
- 已终态 stale 历史不复活；只修未来审批。

## Verification
- 最小 DB 复现修复前 `stale`，修复后 `approved`；迁移资料变为 keep|primary，既有 third|supporting 保留，旧主题 archived，无关资料关系不变。
- 真冲突：冻结后为显式迁移资料新增 third|supporting，仍 `stale`；旧主题 active，关系零迁移。
- Electron 独立数据根真实点击“批准并生效”：`relationApprovalReadback=true`；批准/驳回/失败回滚等全部读回 PASS。
- focused 10/10；最终 WMB-5150 文件 7/7；full 675/675；typecheck、lightweight、smoke、diff check PASS。

## Review
- Terra `wmb_5157_stale_diagnosis`：确认真实 5→11 查询边界不对称和最小修复。
- `wmb_5157_review` 提出显式资料第三主题冲突测试 HIGH；已补正反两路精确元组读回。
- `wmb_5157_rereview`：PASS，无 blocker/high/medium。
- Capability registry impact: no change — 既有审批校验修复。
- Pi operator Skill impact: no change — 工具名、参数、权限与提示词不变。
