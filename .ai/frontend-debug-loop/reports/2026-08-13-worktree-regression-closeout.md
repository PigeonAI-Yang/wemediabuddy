purpose: 恢复 WMB-5235–5243 工作树的真实内容、Today、Pi 编排、设置与知识授权链路；XHS 外部二进制单独判定。
fails-when: 非 XHS 聚焦回归仍失败，或把 N+1/终态机会复活等生产问题仅用放宽断言掩盖。

Loop: worktree-regression-closeout
Symptom: npm test 1483 项中 18 项失败。
Observation packet: 内容详情查询数随版本增长；schema fixture 锁在 58 而生产为 63；旧测试冻结历史 plan fallback、14 capabilities 和源码排版；XHS 文件被 Defender 拦截。
Hypotheses: N+1 为生产 bug；schema/能力/Today/Pi 断言为契约漂移；XHS 为端点安全阻断。均经聚焦复现证实。
Bug type: data access performance regression + stale contract tests + external binary execution blocker。
Chain traced: SQLite media bindings -> getContentProject -> renderer detail；Today pool -> resolveChairDisplayItems；orchestration envelope -> PiOrchestrationRow；migration 63 -> settings/EVAL fixture。
Breakpoint: 版本循环内逐条绑定查询；旧全局数量/源码形状断言；Defender 阻止 vendor EXE 读取/执行。
Root cause: WMB-5237 增量未批量化详情读模型；WMB-5236–5240 后测试基线未同步；官方 v2.1.1 无签名 Go 二进制被本机策略判定。
Files changed: src/main/media-bindings.ts, src/main/content.ts, src/preload/preload.ts, src/renderer/today-view.tsx, focused tests/fixtures, source-root hygiene gate。
Before/after gate: before 18 fail；after 非 XHS 聚焦 65/65、typecheck PASS、design/source hygiene 5/5；完整套件运行中。
Owner check: 用户主链路契约已恢复；未改变 UI 样式或品牌 token；XHS 仍不可交付，不能标 clean。
Result: verifying。
State update: .ai/frontend-debug-loop/state.json。
Clean completion: no
Blocked reason: Windows Defender 阻止并删除 resources/xiaohongshu-mcp/xiaohongshu-mcp-windows-amd64.exe；未绕过安全策略。
