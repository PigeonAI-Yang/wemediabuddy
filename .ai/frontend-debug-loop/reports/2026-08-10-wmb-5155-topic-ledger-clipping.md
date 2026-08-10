purpose: 主题审批台账必须让主编看见资料员建议、影响、明细入口和终态说明；本轮修复真实失效提案被布局裁切。
fails-when: 真实记录 DOM 有正文但台账 client height 小于内容高度，或明细入口不可点击。

Loop: WMB-5155 topic-ledger-clipping
Symptom: 用户只看见两个空标题，无法查看或点击明细。
Observation packet: URL `127.0.0.1:27391`；原生 Electron 1600×960；真实记录 `3e2ac7ca...`；截图 `2026-08-10-wmb-5155-after-cold-restart.png`；console/network 无异常；数据库有 2 项 change、10 sourceLinks、2 planItems、3 workCarryItems。
Hypotheses: 数据缺失被真实库推翻；HMR stale 被冷重启推翻；DOM/CSS 取证确认布局裁切。
Bug type: dom-hidden / layout
Chain traced: SQLite proposal → IPC list → React state → `.topic-maintenance-row` → `.topic-maintenance-ledger` → `.topic-home` Flex。
Breakpoint: row 高 334.97px，ledger 仅 113.97px；ledger `overflow:hidden`，Flex 默认 shrink 将其压缩。
Root cause: `.topic-maintenance-ledger` 在固定高度纵向 Flex 中未退出收缩。
Files read: topic component、主题 CSS、真实 DB proposal、运行时 DOM/computed style。
Files changed: `styles-knowledge-topic.css` 一项 `flex:none`；验收脚本与回归断言。
Before/after gate: before ledger 113.97px < row 334.97px；after ledger 336.97px、clientHeight 335、scrollHeight 335，真实 details 点击 `open=true`；1440/1100 `ledgerNotClipped=true`。
Owner check: 用户路径已恢复；真实数据/失效终态/错误与审批基线保留；工具栏与主题卡未改；would-user-return-this=no。
Result: PASS；真实失效提案正文、影响、明细入口和说明完整可见可点。
State update: complete。
Clean completion: yes
Blocked reason: none
