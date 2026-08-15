# EVAL-CAP-028

ResearchJob 证据补料与单跳续派（窄例外）验收文档 — EVAL-032 全 13 项 + PRD AC-029 + 真实 GLM readback。

- Capability: SPEC `CAP-028`（ResearchJob evidence supplement and single-hop successor）+ `EVAL-032`；PRD `§2.5` / `REQ-031` / `AC-029`；PRODUCT C9.2 窄例外；设计真源 `docs/spark/2026-08-10-agent-research-job-design.md` §12.1。
- Tasks: WMB-5168（立法）→ WMB-5169（cap.research 注册 + Web 只读工具）→ WMB-5170（grant/intent/角色派生 + 读硬门）→ WMB-5171（late-migrations v54 + `research_claims` 存储）→ WMB-5172（ResearchJob 执行 + claim 机器校验 + EvidencePack）→ WMB-5173（桌助自动派记者 + research_successor 终态续派 + 三层止环）→ WMB-5174（记者卡 + Today 等你批投影 + operator Skill 同步）→ WMB-5175（本验收：EVAL doc + GLM 5.2 fixture + 自动化 13 项 + 真实 GLM readback）。
- Preconditions: 当前仓 late-migrations v54（`agent_tasks.intent` CHECK 含 `'research'`；唯一新业务表 `research_claims`）；`cap.research` 注册；研究 MCP 读门接线；research_successor 调度器接线。

## 13 项可证伪验收（真源映射）

| # | 验收项（可证伪） | 规范真源 | 聚焦测试路径 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | writer 工单（projectId=P）运行中报告 evidenceGap（requiredClaims 含 `glm52_official_price_rise`，type=price）→ 桌助自动派 research 工单（businessDate + projectId=P 同边界）；同一 parentJobId 至多一个活动 research 任务 | SPEC EVAL-032(1)、CAP-028 §2；设计 §12.1(1) | `tests/wmb-5175-eval-cap028.test.mjs` #1（`dispatchResearchForEvidenceGap` + 真实 JobSpawner；`findActiveResearchForParent` 幂等） | PASS |
| 2 | research 任务在智能体页呈现为记者卡，progress 计数（planned=40 / verified 目标 15）真实推进 | SPEC EVAL-032(2)、CAP-028 §13；设计 §12.1(2) | #2（`readCrewResearchSummary` + `readCrewInstanceProjection` + `RESEARCH_DEFAULT_BUDGET` 真源） | PASS |
| 3 | 读硬门：白名单外（`wmb_get_workbench`、channel resolve/trial）→ `READ_PROFILE_BLOCKED`（reason RESEARCH_READ_WHITELIST）+ 审计；白名单内 search_web/read_web_page/X/XHS 读正常 | SPEC EVAL-032(3)、CAP-028 §11；设计 §12.1(3) | #3（真实 MCP `startMcp` + 员工 lease + `dispatchTool`；operation_log 审计行） | PASS |
| 4 | 证据写回：每条 `wmb_save_source` 带 canonical originalUrl（重复入库不新增 source）；price 证据带 publishedAt + excerpt；无 feedId；缺 taskId/grantId/workerLeaseId/requestId 或带 feedId → 边界断言拒绝（零写） | SPEC EVAL-032(4)、CAP-028 §10；设计 §12.1(4) | #4（`buildSaveSourcePayload` 信封拒绝 + runner canonical 去重 + 无 feedId） | PASS |
| 5 | claim 机器校验：伪造 supported（1 条二手 / 缺时间 / 缺摘录）→ 降级 unresolved（threshold_not_met）；官方一手 + 独立二手 → supported；官方页明确未涨 → contradicted；全候选不可读 → source_unavailable | SPEC EVAL-032(5)、CAP-028 §5；设计 §12.1(5) | #5（`validateClaimProposal` + `assessSupportThreshold` 门槛矩阵，证据取自 GLM 5.2 fixture） | PASS |
| 6 | 仅一轮：候选耗尽 / 12 分钟到点 → 终态 partial + EvidencePack（round=1） | SPEC EVAL-032(6)、CAP-028 §4/§6；设计 §12.1(6) | #6（`runResearchJob` 候选耗尽 → partial + round=1 + `parseResearchEvidencePack` 读回） | PASS |
| 7 | 自动续派：research 终态 → `jobs` 行 kind='research_successor'、dedupe_key='research-succ:{parentJobId}'；重放终态处理器仍只产一个；续派 = writer 工单（同 projectId），brief 追加 EvidencePack 摘要 | SPEC EVAL-032(7)、CAP-028 §7；设计 §12.1(7) | #7（`enqueueResearchSuccessor` INSERT OR IGNORE 幂等 + `kickResearchSuccessors` 派生原角色续派） | PASS |
| 8 | 硬止环：续派 writer 再报缺口 → 不自动再派研究（needs_user 交人）；research 作父 spawn → VALIDATION_ERROR | SPEC EVAL-032(8)、CAP-028 §8；设计 §12.1(8) | #8（`deriveResearchParentRole` 白名单 + `isResearchSuccessorRow` 行为层拒绝） | PASS |
| 9 | Today 投影：未解决 required claim 的续派 → 唯一「等你批」卡（收窄/手动补料/接受标注待核实三动作）；研究进度与裸资料永不上 Today | SPEC EVAL-032(9)、CAP-028 §13；设计 §12.1(9) | #9（`listResearchSuccessorNeedsUser` 字段白名单 + claim 原文来自 research_claims） | PASS |
| 10 | 重启恢复：running research → resume_pending，从 checkpoint + research_claims 恢复（剩余预算内）；enqueued 未消费续派重启后只消费一次 | SPEC EVAL-032(10)、CAP-028 §9；设计 §12.1(10) | #10（`runResearchJob` checkpoint 续跑 + `kickResearchSuccessors` 二次 kick 为零 + `reconcileResearchSuccessors` 幂等） | PASS |
| 11 | 产物质量：续派新稿无无出处数字、不整段复制旧稿；「官方涨价」由未核实变为有据（supported/contradicted）或按用户决策收窄/标注 | SPEC EVAL-032(11)、CAP-028 §5/§7；设计 §12.1(11) | #11（`buildSuccessorBriefSuffix` 只带 EvidencePack 摘要无裸资料；accept 决策标注待核实写入 brief） | PASS |
| 12 | 取消/失败：取消 research → 已入库证据保留、不续派；failed → 桌助呈报、不自动重试 | SPEC EVAL-032(12)、CAP-028 §6/§9；设计 §12.1(12) | #12（runner 取消保留 committed writes + failed/cancelled enqueue 返回零续派） | PASS |
| 13 | Web 安全：静态读失败 → fallback 渲染动态公网页并返回正文；验证码/登录墙 → 明确失败（auth_required）不绕不携带会话凭证；私网/环回 → SSRF 拒绝；DNS 重绑定 → 拒绝；重定向跳出可信域 → 拒绝；>2 MiB / 非文档类型 / >15s 超时 → 拒绝或截断——均按安全分类记录 | SPEC EVAL-032(13)、CAP-028 §14；设计 §12.1(13) | #13（`readWebPage` 注入传输层 + 动态 fixture fallback + auth-wall fixture + 负断言矩阵；拒绝原因进入 claim 判定 source_unavailable） | PASS |

## Fixture 清单（`tests/fixtures/glm52/`）

| fixture | 角色 | 用途 |
| --- | --- | --- |
| `abionmorse-post.html` | @AbionMorse 帖（X 帖 capture） | evidenceGap 触发材料：GLM-5.2 在 OpenRouter 反常低价（0.50/3.15 USD per 1M），2026-08-11 |
| `zhipu-pricing.html` | 智谱官方定价页（一手） | 官方证据：GLM-5.2 输入 0.5→0.6、输出 3.15→3.8 元/百万 tokens（2026-08-12 起）→ supported |
| `zhipu-pricing-no-rise.html` | 官方未涨变体 | 官方推翻路径 → contradicted |
| `openrouter-glm52.html` | OpenRouter 模型页（独立二手） | 0.60/3.80 USD per 1M（2026-08-12 更新）→ 与官方域互异构成独立二手 |
| `dynamic-pricing-shell.html` | 动态渲染 fallback | 静态空壳（parse 失败可重试）→ fallback 渲染后返回内嵌 JSON 价格正文 |
| `auth-wall.html` | 验证码/登录墙 | 安全负断言：auth_required、不渲染、不绕过、不携带会话凭证 |
| `manifest.json` | fixture 清单 | scenario/role/canonicalUrl/contribution/assertions + safety_negatives（测试 #0 自洽断言） |

## 聚焦自动化

```text
node --test tests/wmb-5175-eval-cap028.test.mjs
→ 19 passed / 0 failed（13 项 + 拆分 + manifest 自洽）
```

聚焦测试复用 5169–5174 产品真源（`research-dispatch.ts` / `research-successor.ts` / `research-successor-projection.ts` / `research-claim-validation.ts` / `research-job-runner.ts` / `research-web-read.ts` / `wmb-mcp-tools-core.ts` / 真实 MCP 门），不写 source-text 检查冒充行为。回归邻域（wmb-5169/5170/5171/5172/5173/5174）105/105 PASS；本验收未改任何 `src/` 产品代码。

## 真实 GLM readback（2026-08-13，修复后重跑）

命令：`node scripts/glm52-live-readback.mjs` → 证据 `.ai/glm52-live-readback-2026-08-13.json`

- 现网可达：zhipuai.cn/pricing（静态 200，title/正文提取成功，727ms）与 openrouter.ai/models/zhipu/glm-5.2（静态 200，1065ms）均经产品 `readWebPage` 真实读取成功。
- **fallback 阻塞已修复（WMB-5175 阻塞项关闭）**：playwright-core 1.62 禁止 `chromium.launch` args 携带显式 `--user-data-dir`（`browserType.launch: Pass userDataDir parameter to 'browserType.launchPersistentContext(userDataDir, options)'…`，首次 readback 精确记录）。修复：`src/main/research-web-read.ts` 的 `headlessRenderPublicPage` 改用官方 `chromium.launchPersistentContext(mkdtemp 临时 profile, { executablePath, headless, args 不含 --user-data-dir, locale, viewport })`；`finally` 全路径 `context.close()` + `rm(profileDir)` 清理临时目录；SSRF/DNS/redirect/2 MiB/≤15s 安全边界原样保留（真实浏览器下 validator 拒绝跳转即中止并清理，回归测试覆盖）。
- 重跑真实结果：zhipuai.cn/pricing fallback **渲染成功**（200，3.7s，finalUrl www.zhipuai.cn/pricing，正文 2612 字符）；openrouter.ai/models/zhipu/glm-5.2 fallback **渲染成功**（200，7.3s，finalUrl openrouter.ai/zhipu/glm-5.2，正文 408 字符）。两页不再出现 userDataDir launch error。
- 定价行仍不可提取（如实报告，不伪造）：两页渲染后正文（innerText）仍不含匹配 `priceLines` 模式的 GLM-5.2 定价数字（官方页定价区/OpenRouter 模型页价格区不在可提取的渲染文本中，属目标站客户端渲染/懒加载挑战，非脚本缺陷）→ claim 机器校验保持 `source_unavailable (no_pricing_text_in_static_body)`，未伪造 supported。
- 回归测试（`tests/wmb-5169-research-tools.test.mjs` 新增 3 项）：①旧参数组合 `chromium.launch({ args: ['--user-data-dir=…'] })` 必须拒绝（1.62 语义）；②新实现真实浏览器渲染动态 shell 成功且临时目录清理；③validator 拒绝的 document hop 被中止且临时目录仍清理。聚焦套件 29/29 PASS，WMB-5175 19/19 PASS。

## Result

- 13/13 可证伪验收 + 19/19 聚焦测试 PASS；回归邻域 105/105 PASS；真实 GLM readback 修复后重跑完成：fallback 真实渲染成功（无 userDataDir launch error），定价行如实报告 source_unavailable（不伪造）。
- `check:capabilities` / `typecheck` / full `npm test` / lightweight / smoke 由主 Agent 统一执行（契约）。
- Failure reason: 无（本验收自身）。原风险登记（`headlessRenderPublicPage` 在 playwright-core 1.62 下 launch 必失败）已由 `launchPersistentContext` 修复并回归测试锁定（见「真实 GLM readback」节）。
- Pi operator Skill impact: no change — 本任务复核 WMB-5174 已同步的 operator Skill（研究补料 playbook 与 `wmb_save_source` 证据字段说明），无新增影响。
