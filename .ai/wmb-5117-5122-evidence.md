# WMB-5117..5122 证据（集成收口：实机 E-0..E-6 + 独立复审 + ledger 六行 done）

- Date: 2026-08-09（最终轮；实机主轮 2026-08-08T22:06-22:09，E-3 复验 2026-08-08T22:21-22:22；结构化事实 .ai/wmb-5122-live-e0-e5.json、.ai/wmb-5122-e3-reverify.json）
- 隔离实机数据根：J:\Users\yangda01\Temp\wmb-5122-live-W2sze6\data-root；E-3 复验隔离根：J:\Users\yangda01\Temp\wmb-5122-e3re-WvUkKh\data-root（独立临时工作空间，未触碰真实数据；WMB-5116 fixture 复用）
- businessDate: 2026-08-09；MCP: http://127.0.0.1:61872/mcp（复验 MCP: http://127.0.0.1:64964/mcp）
- 总结果：E0/E1/E2a/E2b/E4/E5 PASS；E3 FAIL（fix 前，失败调查保留见下）→ **E3 final verdict: PASS（5119 fix 后复验）**；E6 全部 gates PASS；独立复审 approved

## E-0 冒烟
- `node scripts/smoke-renderer.mjs` → [wmb-smoke] ok http://127.0.0.1:27391/
- title/root/entry 检查：{"title":true,"rootEl":true,"entry":true}
- 结果：PASS @ 2026-08-08T22:07:01.906Z

## E-1 四角色并发成功（reporter+writer+librarian 同 businessDate）
- reporter job d3fff91a-e809-48a6-9433-05a3d00d8023 → succeeded code=SCAN_CHANNEL_SCANNED readback={"kind":"scan_phase_reached","phase":"channel_scanned"} task=- 2026-08-08T22:07:01.910Z → 2026-08-08T22:07:03.516Z
- writer job b57b6884-cbef-4e72-893c-f2152d6b6946 → succeeded code=CONTENT_VERSION readback={"kind":"content_version","projectId":"5a2e118e-7ee8-4b7f-9dec-27fdaa4527e5","versionId":"5970835d-96f1-4c24-a891-10cd3498db7c"} task=- 2026-08-08T22:07:01.972Z → 2026-08-08T22:07:45.893Z（真实 Pi 会话）
- librarian job aa862de6-9b49-4fb1-b46e-44c291b17a57 → succeeded code=NOOP_CONFIRMED readback={"kind":"noop_confirmed","scope":"workspace"} task=- 2026-08-08T22:07:01.976Z → 2026-08-08T22:07:51.525Z（真实 Pi 会话）
- E-1 reporter 任务终态后状态：{"taskId":"32d22f7c-b809-4a2b-9285-1a99e5250045","status":"running","phase":"channel_scanned","intent":"daily_scan"}；channel_scanned 交接 grant active=true（E-4 观察）
- 结果：PASS（elapsed 49975ms）

## E-2 R1 实机（deferred park + 晋升 ≤1s + 60s watchdog）
- (a) pool judge：planner job 3ce8161d-b834-4a81-8286-3508eb76dbbb（task 78b9a67c-6484-4708-b8ec-c1c25e73906a phase synthesizing）→ reporter job 84bf9047-cbd0-44ef-b07e-7c936fdcdc64 泊车 {"status":"waiting_resource","waitReason":"RESOURCE_JUDGE_IN_FLIGHT: 判定任务进行中（SCAN_JUDGE_IN_FLIGHT），扫描让路。","waitingSince":"2026-08-08T22:07:52.560Z","parkElapsedMs":2}；judge settle @ 2026-08-08T22:07:57.034Z → 晋升 3ms → reporter 终态 succeeded（scan_phase_reached）
- (a) 结果：PASS
- (b) watchdog：非 pool judge（coordinator legacy 全流程）task 2ebee71e-6afe-4842-a7f2-559e764cefa1 phase synthesizing（终态 cancelled）→ reporter job 145572df-25ba-42bf-b8e2-be9f5f08d3d6 泊车 {"status":"waiting_resource","waitReason":"RESOURCE_JUDGE_IN_FLIGHT: 判定任务进行中（SCAN_JUDGE_IN_FLIGHT），扫描让路。","waitingSince":"2026-08-08T22:07:59.676Z","parkElapsedMs":1}；judge settle @ 2026-08-08T22:08:02.373Z → 看门狗晋升 15ms（第 3 轮 56299ms / 第 6 轮 24022ms / 第 8 轮 15ms，均 ≤60s）→ reporter 终态 succeeded
- (b) 结果：PASS

## E-3 R2 实机（四角色 running cancel ≤5s / Pi 进程树退出 / lease 归零 / task cancelled / 无 late mutation）【fix 前失败调查，保留；superseded by E-3 复验】
- reporter: job 4423f13c-5302-420c-8282-3db5806772d3 task 363759b3-9e29-4576-8d64-5413aa806b22 lease a20c7f77-1106-4739-a7de-ff7e3ca627fe cancelMs=34ms job=cancelled task=cancelled/cancelled lateMutationReceipts=1（观察，见残余）→ PASS
- planner: job 1e0bc7cc-1cf9-4441-8e63-d184e2d3e1e4 task 55934277-614f-4a50-964e-aaec849faf1b lease 1571e169-5160-47ad-b466-c09e68b66740 cancelMs=1987ms job=cancelled task=partial/partial piBefore=1 piAfter=0 (exitMs=2397ms) → FAIL（agent_task 未落 cancelled，真实行为，见残余）
- writer: job 98495189-84ce-436a-9863-91e4a5e47c4e task 57b42de7-c6a5-4f44-b9cb-8d4dd25204e3 lease ee6c5081-f07b-458e-8629-b151631b7cf0 cancelMs=2051ms job=cancelled task=cancelled/cancelled piBefore=1 piAfter=0 (exitMs=2401ms) lateMutation=0（content_versions 6→6）→ PASS
- librarian: job c4e43456-92b4-49b1-9157-6089d7113081 task 4bfa4ae5-b942-4167-9552-89008bba9405 lease 9a7f0c0a-7285-4280-9b9a-6b6cb5ecc1aa cancelMs=2041ms job=cancelled task=cancelled/cancelled piBefore=1 piAfter=0 (exitMs=2475ms) → PASS
- lease 归零（四角色自身 lease）：true；pool 快照 {"running":0,"queued":0,"waitingResource":0,"employeeSnapshots":[{"leaseId":"a3ac7f62-9b66-4cbc-9160-769383390925","roleId":"planner"}]}（该 planner lease 非 E-3 四角色自身，见残余）
- 结果：FAIL（planner 子项）→ **superseded by E-3 复验（5119 fix 后，见下节）**

## E-4 R3 实机（grant revoke / 旧 grantId envelope 拒绝 / channel_scanned 交接 grant 保持 active）
- 终态任务 4bfa4ae5-b942-4167-9552-89008bba9405 的 task_grants：[{"id":"6c3823de-7e14-437f-a430-df7cc2273cfe","status":"revoked","revokedAt":"2026-08-08T22:08:35.706Z"}] → 无 active：true
- 旧 grantId 6c3823de-7e14-437f-a430-df7cc2273cfe 实机写：CommandReceiptV1 ok=false，error.code=TASK_GRANT_REVOKED（receiptId 768c3fbb-5e83-46c3-9e92-72ca01844596，requestId wmb5122-e4:4bfa4ae5...:reject-check，actor=pi）→ 拒绝：true
- channel_scanned 交接：task 32d22f7c-b809-4a2b-9285-1a99e5250045 state={"status":"running","phase":"channel_scanned","intent":"daily_scan"} grantActive=true（grant 2bc35f64-fdac-41be-bf0d-b5461591842d status=active）——channel_scanned 阶段 grant 未被回收（5120 终态唯一 revoke 生效）
- 结果：PASS

## E-5 R4 实机（严格 fenced no-op）
- A 围栏：job f8dc989d-01ae-42a7-a7f5-8e85a3ac19d9 → succeeded code=NOOP_CONFIRMED readback={"kind":"noop_confirmed","scope":"workspace"}；真实会话（job-f8dc989d...jsonl）末条 assistant 文本含 ```json {"wmb_noop": true} 围栏 → PASS
- B 无围栏：job f7d534df-da6b-4986-be69-7f159bbb8fc6（brief 明令不得输出 JSON 围栏）→ failed code=JOB_READBACK_MISSING（保守失败，未假成功）→ PASS
- 结果：PASS

## E-6 回归 gates（RepairCommandSuite 切片执行 + 集成最终复核）
- 聚焦 exact 六套件 75/75 pass：tests/job-pool.test.mjs、tests/job-spawner.test.mjs、tests/job-l2-integration.test.mjs、tests/job-scan-judge-race.test.mjs、tests/command-dispatcher.test.mjs、tests/pi-extension.test.mjs（node --test 全绿；command-dispatcher 4/4 含真实 startMcp 路径）
- `npm run typecheck` pass（tsc 0 errors）
- `npm run check:capabilities` pass（capability registry no change）
- `scripts/check.ps1` lightweight pass（harness / line caps / ledger / intake / capability registry）
- linecount 口径：job-spawner.ts PowerShell 行数 = 468，scripts/line-caps.json 登记 cap 468（最终复核，只降不升；各行 receipt 中 488/486 为 5117/5118 完成时点快照，序列 488→486→468 单调下降，与只降登记一致）
- 结果：PASS

## 汇总
- E0=PASS E1=PASS E2a=PASS E2b=PASS E3=FAIL（fix 前，失败调查保留并标 superseded）→ **E3 final verdict: PASS（5119 fix 后复验）** E4=PASS E5=PASS；E6 全部 gates PASS
- 结构化事实：.ai/wmb-5122-live-e0-e5.json（e3FinalVerdict="PASS (5119 fix 后复验)"、summary.e3="PASS (fix 后复验)"）；E-3 复验事实：.ai/wmb-5122-e3-reverify.json（ok=true、rolesPassed=true、leaseZero=true）
- 独立复审：ReviewResidualClosure — approved（见独立复审节）
- TASKS.md WMB-5117..5122 六行 done、0 doing；5119/5122 本轮由 doing 关闭（5119：修复 + E-3 复验；5122：集成收口）

## E-3 复验（WMB-5119 fix 后，2026-08-08T22:21-22:22，隔离根 J:\Users\yangda01\Temp\wmb-5122-e3re-WvUkKh\data-root）

5119 修复（runCancellationSequence 在 Pi 强停前先置 `controlAction='cancel'`，域 abort 路径据此转 cancelled）后，四角色真实 Pi running cancel 全项复验：

- reporter: job 335c94d7-5a76-4478-a0dc-dbca5cea1d9b task 03f1116d-3f51-41cd-a915-8e1fd798f5ab lease 0a0391c9 → job=cancelled task=cancelled cancelMs=58ms lateReceipts=1（saved_count=0 通道回执，观察项）→ PASS
- planner: job 248834e1-db47-4c98-aaac-44fde74ee1c5 task f4815c9e-c4bd-49a4-96e0-b04d6891cc2e lease ca9d555c → job=cancelled **task=cancelled**（fix 前恒 partial）cancelMs=4597ms（≤5s）Pi before=1 after=0 exitMs=2896ms → PASS
- writer: job f060739c-d489-41e0-b094-b09814459f73 task d758b782-ddd9-4f5e-bb14-9961f7102732 lease 5d5d4449 → job=cancelled task=cancelled cancelMs=2060ms Pi exitMs=2615ms lateMutation=0（content_versions 5→5）→ PASS
- librarian: job 24ae7a37-b0e2-4b2f-a281-e9e29925c6c0 task 127f5aed-9c4f-4f1a-97e7-b1556aaeeb72 lease ef609b67 → job=cancelled task=cancelled cancelMs=2092ms Pi exitMs=2832ms → PASS
- lease 归零：true（E-3 结束时 employeeSnapshots=[]，含全部四角色）
- 结果：E-3 复验 PASS（四角色 pool cancelled ≤5s / agent_task cancelled / Pi 进程树退出 / lease0；reporter 的 1 条 saved_count=0 通道回执为 cancel 竞态扫描 trace，非内容 mutation）

**coordinator lease 残留复核**（非 pool judge cancel 后 employee lease 是否释放）：
- coordinator legacy 全流程 judge（真实 Pi）→ controlDaily cancel → judge task terminal cancelled（10ms）→ employeeSnapshots 首采样（2ms）即无任何 planner lease → **lease 立即释放，无残留**。
- 结论：先前观察到的「E-3 结束时 1 个 planner lease 残留」为 fix 前 cancel 后 coordinator run slow-settle 期间的现象（该 run 的 withRuntimeWorker lease 随 run 结束才释放，采样时机在释放前）；5119 fix 后（abortDailyIntelligence 增加 stop + activeDailyRuntimes.delete，且 controlAction 前置）该现象不再复现。非探针清场、亦非永久泄漏；已修复。

## 独立复审（集成收口）
- ReviewResidualClosure — approved；major 已撤销，无 findings。（集成收口最终复审）

## 残余观察（多轮实机，逐条如实）

1. **E-3 planner：job cancel 后 agent_task 落 partial（非 cancelled）**——5119 fix 前的真实行为（4-5 轮一致）。机制：fix 前 runCancellationSequence 先 `stopResource`（≤2s，触发 Pi abortTurn+stop）→ startDailyIntelligence 的 abort-catch 走 `dispatchFinishDailyIntelligence(forcePartial)`（无 controlAction 时不走 cancelIfRequested）→ 任务先落 partial；dispatchCancelAgentTask 后到（stopResource 有界等待之后）时任务已终态被 INVALID_STATE 守卫跳过。**superseded by E-3 复验：5119 fix（Pi 强停前先置 controlAction='cancel'）后 planner/writer/librarian agent_task 均落 cancelled（见 E-3 复验节），此残余已关闭。**
2. **E-3 reporter：cancel 后 1 条 channel 回执落库（saved_count=0）**——task 已 cancelled 后 ~200ms，example.com 的 source_scan_receipt 提交（saved_count=0，未写 source_items，非内容 mutation）。fix 后仍存在（cancel 时已在途的 fetch 提交不可撤回）；E-3 复验 .ai/wmb-5122-e3-reverify.json lateReceipts=1 与之一致。设计 §11 E-3 的「无 late mutation」准则为 writer 专属（writer 实测 0），此回执作为扫描 trace 记录。
3. **非 pool judge cancel 后 coordinator run 的 employee lease 残留**——fix 前观察（第 5、8 轮）：E-2b 用 controlDaily 取消 coordinator judge（task 立即 cancelled），但 E-3 结束时 employeeSnapshots 仍含 1 个 roleId=planner lease，非 E-3 四角色自身。推断为 coordinator run（withRuntimeWorker roleId=planner）在 task cancel 后未及时 settle（Pi turn abort 传播/fallback 链延迟 [INFERENCE]），lease 随 run 结束才释放。**superseded by E-3 复验：coordinator judge cancel 后 lease 首采样（2ms）即释放，无残留——此现象由 5119 fix（abortDailyIntelligence stop + activeDailyRuntimes.delete + controlAction 前置）关闭，非探针清场、非永久泄漏。**
4. **E-2a 单轮时序波动**（第 7 轮 FAIL：judge 终态先于 reporter 派出，未泊车）——根因是 app 60s orphan-sweeper 抢占 E-1 遗留 channel_scanned orphan 自动起 judge（真实 Pi + planner lease），导致 E-2a planner 复判成功、reporter 直接扫描。探针修复（E-1 后先清场 orphan）后第 8 轮 E-2a 恢复 PASS（park + 3ms 晋升）。E-2a 共 6 轮 5 PASS，机制稳定。
5. E-0/E-1/E-2/E-4/E-5 各轮结果稳定（E-2b watchdog 晋升实测 15ms/9016ms/24022ms/46255ms/56299ms，均 ≤60s）。

## 非目标
- E-6 回归（node --test 六套件 + typecheck + check:capabilities + check.ps1）与 E-7 复审/TASKS 回执最初列为本切片非目标（测试切片由 RepairCommandSuite 负责）；该切片现已执行完毕并经集成最终复核收口——E-6 结果见 E-6 节，复审与 ledger 回执见本文件与 TASKS.md。本行仅保留历史分工说明，不再适用为现状。
- 未触碰真实 data root、未发布/硬删/平台写；临时根 W2sze6 / wmb-5122-e3re-WvUkKh 保留审计，进程已全部停止。
