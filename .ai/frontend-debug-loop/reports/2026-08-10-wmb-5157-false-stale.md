purpose: Owner 点击批准应让无冲突的资料员整理原子生效；本轮修复跨主题关系查询边界不一致导致的假 stale。
fails-when: 提案目标主题与目标资料未变化，却因其它资料早已存在的第三主题关系被判 stale。

Loop: WMB-5157 false-stale
Symptom: 08:44 提案点击批准后立即显示“现场已变化”。
Observation packet: 真实 proposal `1ba33d3b...`；创建 00:44:06、决定 00:45:16；topics/plan/content/carry/canvas/domain/reviews 均 MATCH；sourceLinks 快照 5、批准校验 11。
Hypotheses: 真实并发变化被逐字段 diff 推翻；查询边界漂移被确认。
Bug type: side-effect-missing / timing-stale false positive
Chain traced: proposal changes → snapshotState → relationState → currentMatches → decide → stale UI。
Breakpoint: snapshotState 的 sourceIds 仅来自 reassign change；currentMatches 错从 snapshot.before.sourceLinks 全量反推 sourceIds。
Root cause: 批准校验把其它资料的第三主题旧关系扩入比较，制造 6 条无关差异。
Files read: topic-maintenance.ts、测试、真实 SQLite proposal/snapshot/current rows、审批 UI。
Files changed: `topic-maintenance.ts` 校验 source scope；数据库与 Electron 回归验收。
Before/after gate: before 精确复现 `stale`；after 同场景函数与 Electron 点击均 `approved`，迁移/归档读回成功；冻结后新增显式资料第三主题关系仍 `stale` 且零正式写。
Owner check: 新提案审批恢复；真实目标冲突、回滚、驳回、Owner-only 和历史终态均保留；would-user-return-this=no。
Result: PASS；假 stale 关闭，真 stale 边界仍在。
State update: complete。
Clean completion: yes
Blocked reason: none
