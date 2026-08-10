purpose: 主题页用于浏览主题；本轮把审批与历史从首页大卡片移到筛选后的独立台账入口。
fails-when: 首页仍显示台账、入口换行/不可点、恢复只是回放旧成功，或旧提案被复活/批准。

Loop: wmb-5160-topic-ledger-page
Symptom: 顶部台账长期占空间，历史 stale 统一要求 Owner 处理。
Observation packet: 真实 Electron 显示 3 条大卡片；历史记录文案错误。DPR=1，无 console 异常。
Hypotheses: 展示层未消费持久 reproposal/successor 状态；台账应为独立子页。两项均由 API/DOM 证实。
Bug type: selector/view-model + information architecture + missing recovery event.
Chain traced: SQLite proposal/outbox → list IPC → renderer presentation → Topic toolbar/subpage → Owner resume IPC → dispatcher → scheduler.
Breakpoint: `topic-maintenance-ledger.tsx` 状态投影与 `library-topics-view.tsx` 首页挂载位置。
Root cause: 所有 stale 共用一条文案，且完整台账直接挂在首页；失败 outbox 没有 Owner 恢复适配器。
Files changed: renderer Topic/ledger/CSS，resume IPC/preload/type，operator Skill 与 desk/librarian prompt，tests/EVAL。
Before/after gate: before 首页先显示整块台账；after 搜索、筛选、整理台账同行，点击进入独立页。Electron 恢复 readback 为 pending/attempts=0/stable jobId，返回首页后 ledger=false，overflow=false。
Owner check: 正常批准仍单击原子生效；loading/empty/error 有显式状态；历史不复活；retry exhausted 才显示真实恢复按钮；无内部术语。
Result: PASS — full 685/685，focused 19/19，typecheck/capability/lightweight/smoke PASS。
State update: complete.
Clean completion: yes
Blocked reason: none
