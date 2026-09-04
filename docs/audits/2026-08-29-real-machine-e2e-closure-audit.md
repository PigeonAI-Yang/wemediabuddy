# WeMediaBuddy 真机 E2E 闭环审核报告

## 审核结论

**NOT CLOSED / 未闭环。**

当前不能把 WeMediaBuddy 的 real-machine end-to-end acceptance loop 判定为已闭环。最强、也是当前唯一需要先解决的阻塞是：**没有一轮发生在 convergence stop 之后、使用当前安装包并在正常真机路径上执行的、可因果归属到计划 `8342f64` 的完整运行；该运行必须贯穿 `Planner → 审批 → Reporter → Writer`，以成功的任务 readback 结束，并产生本轮新产生且可归属的 `research_claims >= 1` 与 `content_versions >= 1`。**

本报告以当前仓库状态为权威，以 `local://wmb-acceptance-history.md` 仅作历史重建。历史上曾经出现的“完成”、空 ledger、局部能力通过或测试通过，不能覆盖当前仓库明确记录的 blocked 状态，也不能替代上述真机因果链证据。

## 判定标准

只有以下条件同时满足，才可把本项报告改为 CLOSED：

1. 在 convergence stop 之后重新开始一轮新鲜的 Windows installed-package 真机运行；运行的安装包、`app.asar` 与当前构建一致，并能给出包/进程身份和本轮 run/job 标识。
2. 运行精确使用计划 `8342f64`，复用项目 `6ce12d8a`，并完整经过 `Planner → 审批 → Reporter → Writer`，不是只完成其中一段。
3. Planner、Reporter、Writer 及其所需审批/读取均得到终态 readback；任务必须是成功，`partial`、`failed`、缺少 readback 或仅存在孤立 receipt 均不算成功；仅有 `succeeded` 任务标签、但没有本轮 output delta 与 causal readback，也不算成功。
4. 本轮实际运行新产生、且可通过 task/run 标识回溯的 `research_claims >= 1` 与 `content_versions >= 1`。`content.save_version` 只有在对应 Writer 任务成功并完成 readback 时才可计入。
5. 输入、业务数据和结果来自真实授权的运行路径；不得用 seeded/fabricated data、默认值、手工补写或隐藏 fallback 维持链路。
6. 证据应能把当前安装包、计划/项目、每个任务终态、readback、claim/version 及时间顺序连成同一轮因果链。任何历史记录或局部测试只能作为背景，不能单独构成闭环证明。

## 历史时间线

以下是历史记录中的**曾经主张及后续反证**，不是当前仓库权威状态：

- **2026-07-28：首次广义闭环主张。** 历史记录称 ledger 为空，并列出 `tsc`、测试、Windows x64 package 和便携 EXE 启动等结果；随后 M-4800 审计指出中心 packaged EVAL 路径并未真正证明。见 `local://wmb-acceptance-history.md:11-17`，原始归档引用为 `.../2026-07-28T09-44-17-520Z_019fa81c-5771-7000-b990-8de75f3ad6e7.jsonl#AST 2031`、`#AST 2044`。
- **2026-08-05：统一内核和运行时结论被重新定性。** WMB-4800 被明确为产品/spec/architecture/contract freeze 而非实现；WMB-4803 仍带有残余失败。WMB-4809 的自有证据含 `modelExecuted=false` 和未覆盖项，不能作为完整通过；WMB-4812 后续虽有修复主张，但使用了 acceptance-only headless confirmation，历史中没有随后覆盖全产品的独立真机复跑。见 `local://wmb-acceptance-history.md:15-29`，原始归档引用包括 `.../2026-08-05T17-38-11-972Z_019fd301-1784-7000-95ad-97ab17d8ede9.jsonl#AST 383`、`.../2026-08-05T19-10-47-305Z_019fd355-dc0a-7000-99a7-afe4e3dd5313.jsonl#AST 206`、`.../2026-08-05T19-09-52-786Z_019fd355-0712-7000-9499-02d5f9554f9a.jsonl#AST 1210`、`#AST 1233`、`#AST 1504`。
- **2026-08-06–08-11：空 ledger 与运行时健康继续脱钩。** 历史记录披露了未提交改动、错误模型路由、未执行真实 X 失败分支，以及 Electron 中长时间显示 working 但没有 Pi 进程的生命周期回归。见 `local://wmb-acceptance-history.md:31-45`，原始归档引用包括 `.../2026-08-06T15-15-45-596Z_019fd7a5-0b3c-7000-9fbb-9644028c34c5.jsonl#AST 26`、`.../2026-08-08T13-29-52-171Z_019fe190-d12c-7000-af53-b927d2066e69.jsonl#AST 4040`、`#AST 4044`、`.../2026-08-10T09-20-37-864Z_019feaf9-59e7-7000-8c5a-0a959de07379.jsonl#AST 1946`、`#AST 2360`、`#AST 2424`。
- **2026-08-13–17：局部能力链通过不等于全产品闭环。** Wiki/media 能力有局部真机结果，但仍有环境依赖缺失；Zhihu 只完成编辑器准备而没有发布；研究、Writer、MCP 注册和媒体恢复路径还出现缺口或失败。见 `local://wmb-acceptance-history.md:47-57`，并特别保留其中列出的原始归档引用。
- **2026-08-24–25：最近一次历史运行仍未形成完整终态。** Wan rerun 生成候选但未保存，严格校验与 revision conflict 使 judge 为 partial；随后又暴露旧 `app.asar`、启动/进程、`app.getPath`、pending-count 和部署问题。2026-08-25 18:05:11.959Z 的最后记录只报告 Today-page score-display fix，不是整产品新鲜 E2E 闭环。见 `local://wmb-acceptance-history.md:59-61`。

历史汇总明确记载：ledger/evidence drift、packaged-vs-dev/deployment drift、非终态长等待、runtime lifecycle drift、model/output/contract failures 和 coverage substitution 是重复失败类别，见 `local://wmb-acceptance-history.md:63-70`；截至历史末尾没有覆盖最新状态的完整 Windows installed-package 全链路记录，见 `local://wmb-acceptance-history.md:72-80`。

## 当前权威状态

1. `TASKS.md:14-15`：WMB-5354 当前为 **blocked**；收敛停止后需要一轮 fresh execution wave，不能沿用旧运行或旧结论。
2. `TASKS.md:43`：当前只剩 Yann 计划 `8342f64` 的 acceptance：复用项目 `6ce12d8a`，完整执行 `Planner → 审批 → Reporter → Writer`，并满足 `research_claims >= 1`、`content_versions >= 1`。该行同时记录三次 failed/partial live jobs、wrong-path/missing-tool/read-authorization failures、`JOB_READBACK_MISSING`、没有业务数据，以及明确停止且不伪造 claims/versions。
3. `docs/spark/2026-08-23-planning-stage-architecture-repair.md:590-595` 与 `:683-685` 要求同一条因果链；它们与 `TASKS.md:43` 相互印证，不能用局部审批或孤立写入替代 Reporter/Writer 成功 readback。
4. 当前数据库残留是 stale/partial：计划为 approved rev3；项目 idea 有 rev2 和一个旧 v1；Planner/Reporter/Writer 任务只有 partial/failed，没有 task succeeded。与项目 `6ce12d8a` 匹配的唯一 post-stop task 是 `d5d3b8c5`（2026-08-25T01:04，writer）；它的状态为 failed/failed，错误为 `STUDIO_DRAFT_FAILED` timeout text，仅有 update/fail receipts，`result_refs={}`，没有 `content.save_version`。它是孤立的失败 Writer retry，不能描述为不存在任何 post-stop task，也不能视为完整链路闭环。另有挂在 failed Writer 下的 `content.save_version` receipt（如旧残留所示）也不是干净的 Writer readback，不能计入 `content_versions` 闭环。另有 `.ai/live-writer-evidence-1787544165067.json:2-30` 记录一次 partial attempt：resumed Writer 报告 `succeeded`，但 `countBefore=1`、`countAfter=1`，因此没有新产生的 `content_versions` 输出，证据仍为 partial；这不等于每一次 Writer attempt 都失败，但 succeeded 标签单独不足以证明闭环，仍需本轮 output delta 与 causal readback。（该数据库补充状态来自本轮当前状态检查输入，未附独立持久文件路径/行号；本报告不把它夸大为成功证据。）
5. `scripts/wmb-5364-installed-flow-check.mjs:17-53` 会 seed DB，`:59-83` 驱动 UI，`:86-113` 读取 plan/project；`J:/wmb-out/wmb-5364-installed-flow.json:31-44` 只显示 v1 后为空；`.ai/wmb-5364-evidence.md:44-57` 明确把它定性为 isolated seeded UI approval/project/thesis-lock，而不是 external live E2E。因此它不能改变 blocked 状态。
6. `tests/e2e/.runtime/results.json:2-13` 只证明 ST-001 smoke 的 `opened=true`；`tests/e2e/user-journeys.json:19-29` 显示 73 个 high/critical automatable journeys 中 `passing=0`、`gate=false`。两者都不证明目标因果链已闭环。

据此，当前权威 verdict 为 **NOT CLOSED**；历史“完成”记录不具备推翻当前状态的优先级。

## 未闭环问题

- **首要阻塞：缺少完整 fresh post-stop real-machine causal run，而非没有任何 post-stop task。** 数据库中唯一匹配项目的 post-stop task `d5d3b8c5` 是失败的 Writer retry；尚无一轮在收敛停止后、当前安装包、正常真机路径中，把计划 `8342f64` 和项目 `6ce12d8a` 贯穿完整链路，并以成功任务 readbacks 和新 claims/version 收尾。
- **任务终态不成立。** 现有 Planner/Reporter/Writer 运行包含 partial/failed；`.ai/live-writer-evidence-1787544165067.json:2-30` 中 resumed Writer 虽报告 `succeeded`，但 `countBefore=1`、`countAfter=1`，没有新 `content_versions` 输出，证据仍为 partial。因此不能说每一次 Writer attempt 都失败，但也没有“succeeded”标签配套本轮 output delta 与 causal readback 可证明闭环；其中 `d5d3b8c5` 为 failed/failed、`STUDIO_DRAFT_FAILED` timeout，且仅有 update/fail receipts、`result_refs={}`，没有 `content.save_version`。同时出现 wrong path、缺工具、读授权和 `JOB_READBACK_MISSING`，没有可证明的闭环成功。
- **没有可归属的业务产出。** 当前记录没有业务数据；`d5d3b8c5` 没有 `content.save_version` 和 result refs，不能从 approved plan、旧项目版本或 failed Writer 的孤立 receipt 推导新 `research_claims` / `content_versions`。
- **测试与脚本覆盖被误读的风险。** seeded UI 流程、单一 smoke 启动和全量 journey gate=false 都不能替代目标 acceptance 的外部 live 因果链。
- **部署/运行时身份仍需在下一轮显式锁定。** 历史反复出现旧 `app.asar`、debug/normal 进程混淆、headless 替代和生命周期漂移；若不在本轮记录当前包身份，无法证明运行的是当前代码。

## 可采信证据

下列证据可以可靠证明“当前尚未闭环”，但不应被误写成“已闭环”：

- 当前阻塞和 fresh-wave 要求：`TASKS.md:14-15`。
- 唯一剩余 acceptance、三次 failed/partial live jobs、readback/授权/工具错误、无业务数据和明确停止：`TASKS.md:43`。
- 计划阶段同一因果链要求：`docs/spark/2026-08-23-planning-stage-architecture-repair.md:590-595`、`:683-685`。
- seeded flow 的实际行为、输出和证据自我定性：`scripts/wmb-5364-installed-flow-check.mjs:17-53,59-83,86-113`；`J:/wmb-out/wmb-5364-installed-flow.json:31-44`；`.ai/wmb-5364-evidence.md:44-57`。
- 当前 E2E 证据边界：`tests/e2e/.runtime/results.json:2-13` 与 `tests/e2e/user-journeys.json:19-29`。
- Writer partial evidence: `.ai/live-writer-evidence-1787544165067.json:2-30` 的 resumed Writer 报告 `succeeded`，但 `countBefore=1`、`countAfter=1`，没有新产生的 `content_versions` 输出，故证据仍为 partial；它不能被误写成“所有 Writer attempt 都失败”，也不能在缺少 output delta 与 causal readback 时作为闭环成功证据。
- 历史总判定、重复失败类别和剩余证据缺口：`local://wmb-acceptance-history.md:5-7,63-80`；历史逐项时间线见 `local://wmb-acceptance-history.md:11-61`。

## 不可采信/不足证据

以下内容不足以将本项改判为 CLOSED：

- 旧的“ledger empty / all done”、局部 capability E2E、focused tests、可控异常或单页截图；历史自身已经记录这些结论被后续审计推翻或缩窄，见 `local://wmb-acceptance-history.md:11-17,23-29,35-45,63-80`。
- `scripts/wmb-5364-installed-flow-check.mjs` 及其 JSON 输出：它主动 seed DB，且证据文件明确说是 isolated seeded UI flow，不是外部 live E2E，见上述脚本/output/evidence 行段。
- `tests/e2e/.runtime/results.json:2-13` 的 `opened=true`：它只证明应用打开，不证明计划、审批、Reporter、Writer 或业务产出。
- `tests/e2e/user-journeys.json:19-29` 的统计：`passing=0`、`gate=false` 是未通过信号，不是目标 acceptance 的成功证据。
- approved plan rev3、项目旧/新 idea 版本本身：它们只证明已有状态，不证明本轮链路成功。
- failed Writer 下的 `content.save_version` receipt：没有成功 Writer task 和完整 readback 的配对关系，不能计入 `content_versions`。
- 任何 partial/failed task receipt、缺 readback 的 job、headless acceptance-only confirmation、旧安装包 `app.asar`、debug 进程结果或隐藏 fallback：均不得被重新包装为成功。特别是 `d5d3b8c5` 的失败 Writer retry 只证明失败，不是闭环 readback；failed Writer 下的孤立 `content.save_version` receipt（若来自旧残留）同样不能计入成功。

## 下一次唯一执行波次

本节只提出下一次**单一执行波次**，本报告不执行它。波次必须从收敛停止后的当前状态开始，并一次性完成以下动作：

1. **锁定新鲜真机运行身份。** 清除/隔离旧 debug 与旧 installed-package 进程，启动当前构建产生的 Windows 安装包；记录包、`app.asar`、进程、时间和 run/job 标识，确认不是 stale installed app.asar。
2. **使用真实输入执行目标链。** 在正常 installed UI/真机路径中，精确使用计划 `8342f64` 和项目 `6ce12d8a`，从 Planner 经审批到 Reporter、Writer；保留每一步的终态与 readback 关联。缺工具、缺授权或路径错误时必须显式失败并停止，不得换路继续。
3. **只接受成功终态。** 逐项确认 Planner、Reporter、Writer 及审批相关读取为 succeeded/完整终态；任一 partial、failed、`JOB_READBACK_MISSING` 或孤立 receipt 都使本波次失败，不得计入闭环。
4. **做同轮归属核验。** 直接读取本轮生成的业务状态，确认新产生且可追溯到本轮 run/task 的 `research_claims >= 1` 和 `content_versions >= 1`，并把 plan/project/task/readback/claim/version ID 串成一条因果记录。
5. **波次硬禁止。** 禁止 seeded/fabricated data、手工伪造 claims/versions、acceptance-headless substitution、stale installed app.asar、debug/normal 混淆、hidden fallback、静默替代/跳过必需阶段，以及把 partial/failed task receipts 当作 success。波次失败时保留真实失败证据，不能用补写或旧数据“修成”通过。

## 闭环验收条件

下一波次只有在以下条件全部为真时，才可解除 WMB-5354 的 blocked 并报告 CLOSED：

- 运行发生在 `TASKS.md:14-15` 要求的 post-stop fresh execution wave 中，使用当前安装包且已证明不是 stale `app.asar`。
- 计划 ID 为 `8342f64`，项目 ID 为 `6ce12d8a`，并有同一轮的完整 `Planner → 审批 → Reporter → Writer` 顺序证据。
- 相关任务全部成功并有完整 readback；不存在 partial/failed task、`JOB_READBACK_MISSING`、wrong-path、缺工具或读授权未解决项。
- 本轮直接产生、可归属且可读回的 `research_claims >= 1` 与 `content_versions >= 1`；成功 Writer 是 `content_versions` 的必要前提。
- 没有任何 seeded/fabricated data、acceptance-headless substitution、旧安装包、隐藏 fallback 或把失败 receipt 计成功的情形。
- 证据能在同一时间线中闭合“当前包 → 计划/项目 → 四阶段任务 → 成功 readback → 新 claims/version”；仅有 approved rev3、旧版本、孤立 receipt、smoke `opened=true` 或局部测试均不满足。

在这些条件成立之前，最终结论保持：**NOT CLOSED / 未闭环**。
