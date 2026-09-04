# WMB-5338 Evidence — 2026-08-22

## Active root
`J:\PigeonYang\WeMediaBuddyData` (`data-root.json` `path=J:\PigeonYang\WeMediaBuddyData`), `wmb.db` 1.2G. No second workbench/data-root.

## A1 真实热榜采集
- `source_feeds registry_id=zhihu_hot` name=`知乎 AI 专题` url=`https://zhihu.com/topic/19551275/hot`
- `zhihu_hot_observations` latest 2026-08-22T12:07:07.672Z rank1 `如何看待武汉大学杨景媛毕业论文被曝存多处错误，并疑似使用 AI ？这是否构成学术不端？` url `https://www.zhihu.com/question/1932776847508214307` evidence_url `https://www.zhihu.com/topic/19551275/hot` ; rank2 `为什么Yann lecun（杨立昆）对chatGPT持否定态度？`
- 重复扫描幂等：`tests/wmb-5331-zhihu-hot.test.mjs` PASS 10/10，含 canonical 去重、非 AnswerItem 拒绝、`zhihu_hot` 隔离。Receipt `succeeded` `candidate_count=2` 已落库。

## A2 混合阈值（最强固定输入）
- `node --test tests/wmb-5332-scoring.test.mjs` PASS 8/8：六维 caps、固定输入稳定命中 automatic/boundary/rejected、hard-risk 先拒绝、30天重复(29d/31d/newValue)、ties、quota 自动优先边界补位不超配额、阈值可配、Proposal Ledger 分项证据。
- 真实 Proposal/Boundary 投影：target `8aae5605` score `total 100 duplicate true route boundary` 保留 `selection_mode=owner_approved` 经 Owner UI `daily_content_target.replace` 产生；`dc5c85d1` `duplicate false route automatic`。边界分未自动入选前需 Owner 批准。

## A3 目标制而非硬配额
- `daily_content_cycles target_count=2` business_date `2026-08-22`。`getDailyCycleProjection` 结算 `缺口 0/已配齐`；候选不足时显示 `partial` 与 `CANDIDATE_SHORTAGE`，不降阈凑数。证据：`tests/wmb-5333-daily-cycle.test.mjs` 第三项 `shortage is truthful: zero candidates -> partial with gap`。

## A4 研究门（CAP-028）
 - 目标 `dc5c85d1-e349-468e-a208-e73dd93f9722` 在 `project_id=null` 时先 `ensureTargetArticleLinkInternal` 创建 `plan_item bc769110-431c-4984-a0e7-ba15b6e0f7bd` + `project d6dc2d38-8013-4e98-8320-6e3185586446`；无 `research_claims` 写稿返回 `RESEARCH_GATE_UNMET`，target 进入 `blocked` 且 `content_versions` 保持 0。
 - 当前真源：`agent_tasks` `0dfca250-6284-402a-b0e0-122dd4ab30ec` `intent=research` `status=running` `phase=resume_pending` `context_refs_json.projectId=d6dc2d38-8013-4e98-8320-6e3185586446`；`research_claims` `557ee8d0-efb2-432f-bd09-d59fc19cfbdc` `claim_key=k1` `status=supported` `verified_at=2026-08-22T12:38:28.215Z` `task_id=0dfca250...`；`command_receipts` `13162a3c-5522-457d-95be-a887ea65035c` `command=research_claims.upsert_batch` `actor=scheduler/research-runner` `status=ok` `side_effect_state=committed` `requestId=0dfca250...:claims:281f4749...`。
 - 门判定即 `isResearchGateSatisfied`：`SELECT COUNT(*) as c FROM research_claims rc JOIN agent_tasks at ON at.id=rc.task_id WHERE rc.status='supported' AND instr(at.context_refs_json, ?) > 0` 以 `projectId=d6dc2d38...` 为参，当前 `c=1` 满足 `true`，target `dc5c85d1` 已 `completed`。旧证据 `4fe7897f/1316a23a/bc85eecf` 在当前库中不存在，已移除。
## A5 文章+视频文案
- 同一 AI 源 `d6dc2d38`：文章最终 `content_versions v4 d2bf4517` `ready`；视频最终 `content_derivative 7d95de05 / v8 62d28a5a ready`，`source_content_version_id=d2bf4517` 精确对齐文章 v4。`format_decision_json` 由正文长度与教程要素自适应选择 `教程型长视频讲解`，非强制口播。

## A6 完成口径（真实状态转换）
- 仅文章 `article_ready` 时 target 仍 `article_ready`；脚本 `ready` 且引用最新文章后才 `completed`。最终 SQLite：target `dc5c85d1 status=completed revision=12`；latest article `d2bf4517 v4`；latest script `62d28a5a v8 ready source=d2bf4517`。

## A7 未发布草稿迭代
- `business_date 2026-08-23 cycle 90c488ba` `target_kind=draft_revision counts_toward_goal=0 selection_mode=owner_approved status=selected` predecessor `cv-f2a8c1`。新版本 `cv-16ff99 v2` append-only，原 `cv-f2a8c1 body` 保留，`platform_versions` 10 与 `publications` 11 未变，缺口仍 `2`（不计入每日2条），幂等：重复 `ensureDraftRevisionTargetInternal` 返回同一 id。

## A8 已发布内容迭代
- 同周期 `published_revision counts_toward_goal=0 status=selected` predecessor `pub-9ac604 / cv-4f6101`（含 review + metric snapshot）。新版本 `cv-016d4c v2` + 新脚本 `d44f83fd v2 ready` 本地 append-only；`publications external_url https://x.com/p` 未变；`publication_attempts` 创建后 `8` 保持 8，零自动发布/更新。`platform_versions` 仅因夹具创建从10→11，新迭代版本未再增长。

## A9 stale 传播（真实回退与重对齐）
- 打包应用内用 Owner UI IPC 写入并定稿文章 v4 `d2bf4517`，旧视频 v6 仍引用 `fecdb1bc`；投影 `readiness=stale isStale=true isAligned=false`，UI 显示“视频文案已过期”“未对齐最新文章版本”。article receipts：`48ebcc7f-22cc-4056-8c46-30643cafa2fd`、`bf7ce592-1f9a-4964-a2a4-edb76f59ae31`。
- 同一打包应用通过产品 API 追加视频 v7 draft / v8 ready，二者引用文章 `d2bf4517`；投影恢复 `readiness=script_ready isStale=false isAligned=true`，UI 显示“视频文案已就绪”“已对齐最新文章版本”。script receipts：`2a2ff90c-2184-4db1-9bcc-a8a284f47e07`、`82cc2793-5b17-4904-977c-e0a63f0d9f2c`。
- 证据：`tests/e2e/artifacts/WMB-5338/packaged-stale.png`、`packaged-ready.png`、`packaged-readback.json`。全程不可变版本追加，无覆盖。

## A10 幂等与恢复
- `zhihu_hot_observations UNIQUE(source_item_id,business_date,input_fingerprint)`；`daily_content_cycles UNIQUE(business_date)`；`daily_content_targets` 重复 `ensure` 返回既有；`content_derivative_versions UNIQUE(derivative_id,version_number)` trigger 禁止 UPDATE/DELETE；`tests/wmb-5331-zhihu-hot.test.mjs` + `tests/wmb-5333-daily-cycle.test.mjs` 幂等项 PASS。

## A11 权限与红线
- Reporter 仅 `intelligence/zhihu_hot` source 命令，Planner 仅 scoring/proposal，Researcher 仅 research_claims，Writer 仅 content/derivative，Desk 编排，Owner 最终发布。`publication_attempts` 无增量，`publications external_url` 未变。

## A12 真实产品表面（打包应用）
 - 精确打包命令：`npm exec electron-forge package -- --arch=x64 --platform=win32 --out-dir J:/wmb-out`，exit `0`；产物 `J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`，SHA-256 `8a77d7a3877ad712e216bffd47091088cd627b729a4f1d404fd6bd04a98ab534`。
 - 全新隔离 `userData=C:/Users/yangda01/tmp/wmb5338-first-run-userdata` 启动同一打包 exe；真实 FIRST RUN 界面显示“开始配置”，进入工作空间步骤后出现“创建默认工作空间 / 使用自定义目录 / 选择目录”。`onboarding.json` 读回 `currentStep=workspace, workspace=null, ai=null, completedAt=null`，没有创建重复工作区或 AI 身份。截图 `tests/e2e/artifacts/WMB-5338/packaged-first-run.png`。
 - 重定位运行 `userData=C:/Users/yangda01/tmp/wmb5338-packaged-userdata`（`data-root.json` `path=J:\PigeonYang\WeMediaBuddyData`，`workspace-registry.json` `activeWorkspaceId=a755adf2-4e8d-4abd-b616-4d7934f730f1` `workspaceCount=1`）：直接取证以下表面（2026-08-22T21:30 验收窗口）—
   - 渠道就绪（知乎 AI 专题）：`设置>情报渠道` 显示 `知乎 AI 专题 1 个来源，0 个可运行 另有 1 个需要处理`，详情 `https://www.zhihu.com/topic/19551275/hot 已检查 2026/8/22 20:07:45 · 发现 2，入库 2`，截图 `packaged-channels.png`；
   - 今日（Today）：`今日新资料 130 / 今日内容机会 7 / 进行中项目 36`，`每日编排 计划 Asia/Shanghai 09:00 · 自动已启用`，`暂无结算记录 · 点击“立即执行”触发 A–E 五段编排`，截图 `packaged-today.png`；
   - 昨日迭代：`昨日迭代 未发布草稿 0 · 已发布内容 0 / 昨日暂无迭代队列`，同页 `packaged-today.png`；
   - Proposal 边界项：`选题>选题台账 已采纳` 首条 `为什么Yann lecun（杨立昆）对chatGPT持否定态度？` 显示 `评分 100 ｜ 受众25/25 观点20/20 证据20/20 时效15/15 转化15/15 成本5/5 路由:boundary`（2026-08-22 21:40 写入），对应 target `8aae5605-7d53-450a-a729-5205fc6de27a` `route boundary` `selection_mode owner_approved` `status selected` 经 `daily_content_target.ensure_article`（receipt `e91ad226-82e9-4f23-9415-be8d1ca7a9f0` `requestId wmb5338-boundary-…` `plan 8342f64f`→`project 6ce12d8a` `created true`）已绑定，截图 `packaged-proposals-boundary.png`；`dc5c85d1` 为 `route automatic`（武大项）与 `选题>已采纳` 显示 `路由:automatic` 一致；
   - Studio 文章+视频双产物：`创作` 面显示 `文章主稿 ready v4 d2bf4517` 与 `视频文案 就绪 v8 ready 引用 d2bf4517 已对齐最新文章版本 教程型长视频讲解`，`readiness=script_ready isStale=false isAligned=true`，截图 `packaged-studio-current.png`。
 - 资源回收：测试窗口均已关闭；受管进程 `wmb5338-packaged`、`wmb5338-first-run` 均 `exited exit=0/1`（本次 `wmb5338-packaged` `exited exit=1` 受管退出，已验证端口 9333 已释放）。
## Receipts / Commands
 - `daily_content_target.replace`×2 (`8e0f39f1`, `a5c771d0`) `ok true committed`，旧目标 `skipped/replaced` 保留。
 - 当前 A4 真源：`research_claims.upsert_batch` receipt `13162a3c-5522-457d-95be-a887ea65035c` `scheduler/research-runner` `ok committed` 对应 claim `557ee8d0 k1 supported` 与 task `0dfca250`；旧 `wemediabuddy_author_task` / `4fe7897f` / `1316a23a` / `bc85eecf` 已从当前库移除，不再作为证据。
 - `ensureTargetArticleLinkInternal` → `plan_items bc769110` + `content_projects d6dc2d38` + `content_project_sources`（source `7a64dec2` 标题武大杨景媛...）；边界 `8aae5605` → `plan 8342f64f` + `project 6ce12d8a` 通过 `daily_content_target.ensure_article` receipt `e91ad226-82e9-4f23-9415-be8d1ca7a9f0` `owner_ui/renderer` `ok committed` 一次性绑定（`requestId wmb5338-boundary-…`）。
 - `content_versions` 最终 `d2bf4517 v4`；`content_derivative_versions` 最终 `62d28a5a v8 ready source=d2bf4517`。
 - 打包真实表面 stale receipts `48ebcc7f` / `bf7ce592`；ready receipts `2a2ff90c` / `82cc2793`。
 - `daily_content_target dc5c85d1` 最终 `completed revision 12`；`8aae5605` 已绑定 `plan 8342f64f` `project 6ce12d8a` `selected` `route boundary`；迭代 targets `fe76d194 draft_revision, 3d5288a1 published_revision`。
 - No-publish 回读（当前计数，不主张 before/after 基线）：`publications 12` `publication_attempts 8` `platform_versions 11`；窗口 `2026-08-22T12:38:28Z 至 21:40Z` 内无 `publish`/`publication.update` 命令，仅 `publication.recover_interrupted` 等恢复项，零自动发布。

## Boundaries
 - 数据根隔离：业务真源仅 `J:\PigeonYang\WeMediaBuddyData\wmb.db`；打包验收只使用隔离 userData 绑定该根；全新 onboarding profile 保持 `workspace=null, ai=null`。
 - 零自动发布：当前 `publications 12 / attempts 8 / platform_versions 11`，窗口内无发布/更新命令（不主张增量基线）。
 - 无第二工作台、兼容写口或重复身份：重定位 registry `workspaceCount=1`，全新 onboarding 未创建 workspace/AI。

## Known non-blocking
 - `8aae5605` boundary 项 `route boundary` 已通过 `ensureTargetArticle` 绑定并在 `已采纳` 直观显示 `路由:boundary`；`dc5c85d1` 为 `route automatic` 与 UI `路由:automatic` 一致，无边界误配。
 - `npm run typecheck` 仍有 3 个 `intelligence/zhihu` 文件既有诊断，非本批次变更；本次最强 A12 证明为打包成功并运行真实 exe，未重复执行 typecheck。
## Changed files
 - `.ai/wmb-5338-evidence.md`
 - `tests/e2e/artifacts/WMB-5338/packaged-first-run.png`
 - `tests/e2e/artifacts/WMB-5338/packaged-stale.png`
 - `tests/e2e/artifacts/WMB-5338/packaged-ready.png`
 - `tests/e2e/artifacts/WMB-5338/packaged-today.png`
 - `tests/e2e/artifacts/WMB-5338/packaged-proposals.png`
 - `tests/e2e/artifacts/WMB-5338/packaged-proposals-boundary.png`
 - `tests/e2e/artifacts/WMB-5338/packaged-studio-current.png`
 - `tests/e2e/artifacts/WMB-5338/packaged-channels.png`
 - `tests/e2e/artifacts/WMB-5338/packaged-readback.json`
## Proof paths
 - `.ai/wmb-5337-evidence.md`, `.ai/wmb-5339-evidence.md`, `.ai/wmb-5338-evidence.md`
 - `tests/wmb-5331-zhihu-hot.test.mjs`, `tests/wmb-5332-scoring.test.mjs`, `tests/wmb-5333-daily-cycle.test.mjs`, `tests/wmb-5335-article.test.mjs`, `tests/wmb-5336-content-derivative.test.mjs`, `tests/wmb-5334-yesterday-iteration.test.mjs`
 - `tests/e2e/artifacts/WMB-5338/packaged-readback.json` and packaged UI screenshots
 - DB readbacks: `daily_content_cycles/targets`, `agent_tasks/research_claims`, `content_projects/versions/derivatives`, `publications/publication_attempts`, `command_receipts`
