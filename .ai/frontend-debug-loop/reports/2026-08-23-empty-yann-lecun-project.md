# 空项目诊断 — 为什么《为什么Yann lecun（杨立昆）对chatGPT持否定态度?》正文为空

- 日期: 2026-08-23
- 数据根: `J:/PigeonYang/WeMediaBuddyData` (只读)
- 约束: 不重新复现、不派写、不改DB；追 skeletons → content_versions → topic/plan link → Writer job/agent_task → Research Gate → Studio mapper
- UI 观测: 创作 Studio 选该项目显示 `核心正文 idea v0`、`字数 0`、`来源 1`、`素材 0` (用户观测为事实)

## 一、精确定位

| 项 | 值 | 证据 |
|---|---|---|
| **projectId** | `6ce12d8a-d12d-449d-baca-fcdc55b0f3c8` | `content_projects.id` WHERE title LIKE '%Yann%' |
| **标题** | `为什么Yann lecun（杨立昆）对chatGPT持否定态度？` | 同上 |
| **revision / status** | `1` / `idea` | `SELECT revision, status FROM content_projects` |
| **created_at / updated_at** | `2026-08-22T13:40:03.068Z` (同值) | 同表 |
| **planItemId** | `8342f64f-916e-498a-82df-c8628917885b` | `content_projects.plan_item_id` |
| **plan** | `f332e094-4b20-4f49-8e63-73ba3b4ac93c` (`2026-08-22` Asia/Shanghai) | `plans.id` |
| **daily_target** | `8aae5605-7d53-450a-a729-5205fc6de27a` (`cycle 2f88eba4-36ae-4837-b16e-9a6a4bd14917` `new_content` `selected` `route: boundary` `owner_approved`) | `daily_content_targets` |
| **source** | `f9bed93f-14fb-433f-a9de-233271883eef` (zhihu_hot, `https://www.zhihu.com/question/582340981`, collected `2026-08-22T11:58:47.691Z`, summary 截选“采用归纳的方法，永远不可能实现可靠的演绎…”) | `source_items` + `content_project_sources` |
| **content_versions** | **0 行** ( `SELECT count(*) FROM content_versions WHERE project_id=?` => 0 ) | 无 `insertCoreVersion` 发生 |
| **content_derivatives / platform_versions** | 0 | `SELECT * FROM content_derivatives WHERE project_id=?` => [] |
| **content_project_assets** | 0 | 同上 |
| **source_body_cache** | 无记录 (NULL)；`source_body_capture_jobs` 对此 source_id 0 行 | `status` ∈ {ready, failed, empty} 未产生 |
| **衍生指标** | Studio 库计数 `versionCount 0`, `revision 1`, `latestVersion NULL` (见 `content.ts:getContentProject` → `listContentProjects` 投影) | DB 直接可证 |

## 二、时间线 — 谁/哪条正式命令创建壳，后续是否派写

### 2.1 创建命令 (唯一成功)

- **命令**: `daily_content_target.ensure_article`
- **receiptId**: `e91ad226-82e9-4f23-9415-be8d1ca7a9f0` (status `ok`)
- **requestId**: `wmb5338-boundary-1787406003062-f3fa81`
- **actor**: `owner_ui / renderer` (Owner UI 手动点击边界采纳)
- **created_at**: `2026-08-22T13:40:03.080Z` (envelope `2026-08-22T13:40:03.068Z`)
- **input**: `{ targetId: "8aae5605-7d53-450a-a729-5205fc6de27a" }`
- **data**: `{ planItemId: "8342f...", projectId: "6ce12d8a...", created: true }`
- **operation_log**: `1a66d9ac-4ac3-4fff-96cc-5e950b4b9a82` `daily_content_target.ensure_article` `daily_content_target` `8aae...` `ok` 同秒

**代码路径**:

- `src/main/ipc-daily-content-article.ts:12-26` — `registerDailyContentArticleIpc` → `dispatchBusinessCommand({ command: 'daily_content_target.ensure_article', ... }, () => ensureTargetArticleLinkInternal(db, targetId))`
- `src/main/daily-content-article.ts:12-145` — `ensureTargetArticleLinkInternal`:
  - 若 `target.plan_item_id && target.project_id` 已存在则幂等返回；否则:
  - 确保有 `cycle.plan_id` (无则创建)
  - 生成 `planItemId = randomUUID()` 并 `INSERT INTO plan_items (… title=sourceItem.title, priority=2, why_now='基于知乎热题的每日内容目标', timeliness='today', target_audience='泛科技受众', angle='深度解读该问题的核心争议与证据', point_of_view='提供独立判断与可操作建议', platforms_json='["x","xiaohongshu","wechat"]', formats_json='["article"]', title_guidance=title, opening_guidance='以问题为引…', structure_guidance='背景→拆解→证据→观点→行动', source_ids_json='["f9bed..."]', sort_order=MAX+1, revision=1)`
  - 生成 `projectId = randomUUID()` 并 `INSERT INTO content_projects (id, topic_id, plan_item_id, title, status='idea', created_at, updated_at, revision=1)` — **注意未插入任何 `content_versions`**，状态固定 `'idea'`
  - `INSERT OR IGNORE INTO content_project_sources (project_id, source_id)`
  - `UPDATE daily_content_targets SET plan_item_id=?, project_id=?, updated_at=?, revision=revision+1 WHERE id=?` (target revision 1→2)

**结果**: 壳 (plan_item + project 的 skeletons) 原子创建完成；`created:true` 返回。但此命令**仅建壳，不派写，不建版本**。

### 2.2 后续是否 spawn writer? — 否 (零 Writer job / agent_task)

- `SELECT id FROM jobs WHERE payload_json LIKE '%6ce12d8a%'` => 0
- `SELECT id FROM agent_tasks WHERE context_refs_json LIKE '%6ce12d8a%'` => 0
- `SELECT * FROM content_versions WHERE project_id='6ce...'` => 0

**对比兄弟项目**:

- `dc5c85d1-e349-468e-a208-e73dd93f9722` → `d6dc2d38-8013-4e98-8320-6e3185586446` (杨景媛) 最终 `revision 9` `ready` 4 个 versions (v1 `2026-08-22T12:22:48.867Z` 起)，但其首版也并非来自自动 orchestration，而是 `wmb5338-packaged-stale-save` 手动种子 (`daily_content_article.save_draft` receipts `a4ccb51d`, `48ebcc7f`)。无独有偶，Yann 项目未被该 packaged seed 包含。
- `7a135c98-d0c8-4531-8620-5d995203278a` → `87b6d0ca-38b4-435c-98f2-477fe8b49457` (OpenCode/DeepSeek) 同为 `idea` 0 版本，但至少曾有 `studio_draft` `459ee6cb-9d22-4872-8e8b-d8b884045121` (`partial` `research_dispatched` `2026-08-22T11:31:23.265Z`→`11:32:30`) 验证链路可派。

### 2.3 调用链为何停止 — 首个未发生转换

**唯一首错/缺口**: `daily_orchestration Stage D` (研究与文章) 的 writer spawn 未对 `8aae5605` 发生。

- **Stage D 定义** `src/main/daily-orchestration.ts:270-334` (`createProductionStageD`):
  ```ts
  for (const t of newTargets) { // filter target_kind == 'new_content'
    // ...
    const link = await runMutation({ command: 'daily_content_target.ensure_article', … }, () => ensureLink(db, t.id));
    projectId = link.projectId;
    const spawner = getActiveJobSpawner();
    if (spawner) {
      spawner.spawn({ roleId:'reporter', … }, reporterJobId); // 1
      spawner.spawn({ roleId:'writer', projectId, writerTask:'core_draft', … }, writerJobId); // 2
    }
  }
  ```
  Stage D 是**唯一**既建壳又派 `reporter`+`writer` 的闭环；手动 `ensure_article` (Owner UI click) 只执行 `ensureLink` 前半段。

- **证据**: 最后两次 `daily_orchestration.settle` 均在 `8aae` target 存在前执行:
  - `855608a8-…` `2026-08-22T12:04:33.529Z` completed (stages A:completed B:completed C:completed D:completed `已入队 4` E:completed)
  - `26ace450-…` `2026-08-22T12:07:07.845Z` completed (同上, D `已入队 4`, 但此时 `8aae` 尚未创建 — `8aae` `created_at 12:10:25.094Z`，在 settle 之后)
  - 此后 **无任何** `daily_orchestration.settle` (搜 `command_receipts WHERE command='daily_orchestration.settle' AND created_at > '2026-08-22T12:07'` => 0 直到次日 `2026-08-23T01:00 needs_user`)
  - 手动 `e91ad226` 于 `13:40:03` 仅 `ensure_article`，无 spawner 调用。

**结论**: 按真实落地语义，`ensure_article` 命令的成功 ≠ 写作启动。Orchestration 与手动路径分叉：Orchestration 的 D 已无机会再跑，手动路径又无 writer 派发，导致 **project 停留在 `status='idea'` `revision=1` `versions=0`** 的占位状态。正好落在 `Studio` 的 `idea` 初态，无任何 `Research Gate` 或 `Writer` 参与。

**文件:符号/行** (首错边界):
- `src/main/daily-orchestration.ts:270:createProductionStageD` — 设计上唯一负责 `ensureLink` + `spawner.spawn(writer)` 的闭环，未对 `13:40:03` 后的新 target 重跑。
- `src/main/daily-content-article.ts:12:ensureTargetArticleLinkInternal` — 合同内仅建 `plan_items` + `content_projects` (status `'idea'`) + `content_project_sources`，**不**建 `content_versions`，亦不触 `JobSpawner`。
- `src/main/daily-content-cycle.ts:9:LEGAL_TRANSITIONS` 本应支持 `selected → drafting → article_ready`，但该 transition 仅由 writer 的 `saveTargetArticleDraftInternal`/`finalizeTargetArticleInternal` 触发，从未被调用。

## 三、Studio `idea v0` 的 view-model fallback 来源与“已保存”措辞

### 3.1 版本投影

- **Backend 预取**: `src/main/content.ts:333:createContentProject` / `daily-content-article.ts:127` 仅写 `content_projects`，无 `content_versions`。因此:
  - `content_versions` 表对 `6ce` 为 0 行
  - `content.ts:714:getStudio` 与 `192:getContentProject` 对 `revisions` 的查询 `SELECT id, version_number AS number … FROM content_versions WHERE project_id=? ORDER BY version_number DESC` 返回 `[]`
  - 前端 `detail = await window.wmb.getStudioProject(selected.id)` → `selected.revisions === []`, `selected.revision === 1` (projects 表 revision，非版本数), `selected.versionCount === 0` ( `SELECT COUNT(*) FROM content_versions` )

### 3.2 前端 fallback 链

- `src/renderer/studio-view.tsx:118` `const latest = selected?.revisions[0];` => `undefined`
- `src/renderer/studio-view.tsx:172, 235, 294` `const latestBody = detail?.revisions[0]?.body ?? '';` => `''`; `setBody('')`; `editorBody = ''`
- `src/renderer/studio-view.tsx:403` `const characterCount = editorBody.replace(/\s/g, '').length;` => `0` → UI `字数 0`
- `src/renderer/studio-view.tsx:1049,1059` `selected.sources.length` => `1` (来自 `content_project_sources JOIN source_items`), `selected.assets.length` => `0` → UI `来源 1` / `素材 0`
- `src/renderer/studio-view-panels.tsx:92` 顶部状态:
  ```tsx
  <span className={`studio-doc-state${dirty?' dirty':''}`}>
    {documentLabel ?? `核心正文 · 第 ${selected.versionCount} 版`} · <b>{dirty?'有未保存修改':'已保存'}</b> · {formatTime(...)}
  </span>
  ```
  - 当 `selected` 存在且 `revisions.length===0`, `selected.versionCount===0` → 文案实为 `核心正文 · 第 0 版 · 已保存` (自由区的 `idea v0` 即为此)
  - `dirty` 判定 `src/renderer/studio-view.tsx:30: bodyDraft !== (latest?.body ?? '')` → `'' !== ''` => `false` → 分支 `已保存`
  - 历史面板 `studio-view-panels.tsx:203` 也显示 `版本 0`
- 底部状态条 `src/renderer/studio-view.tsx:1226` 同理:
  ```tsx
  {message || (readOnlyVersion?'历史版本只读': dirty?'未保存': anyDirty?'其他页签有未保存修改':'已保存')}
  ```
  无 `latest` 且 `dirty===false` 时固定 `'已保存'`。

**是否为误导性 UI — 是，轻度误导**:

- 合同语义上 `idea` 初态应表示“占位/待写”，但 Studio 复用了“已保存”这一原本表示“与 DB 无脏差”的编辑器状态语义。用户看到“已保存”会误读为“正文已写入并持久化”，而实际是“当前空表单与空 DB 一致，故无脏修改”。
- 更准确的区分应为: `versionCount===0` 时显示 `尚未生成正文` / `想法` / `待写作`，而非复用保存态。当前实现未为 `idea+0版` 做例外文案，导致截图中 `idea v0` + `已保存` 并置显得自相矛盾。
- 同时，中间态 `idea` 在筛选上是合法占位 (见 `content.ts:42` status 枚举)，但文案未在空版时切换。

## 四、对照选题批准/创建项目合同 — 正常占位还是 orchestration 断链

**属 orchestration 断链，非预期“正常占位”**，理由:

- **正常占位的条件** (见 `daily-content-cycle.ts:7` `LEGAL_TRANSITIONS`): `proposed → selected → researching/drafting → article_ready → scripting → completed`。若属正常，`selected` 后的下一步应是 `researching` 或 `drafting` (由 reporter/writer job 置位)，并应在 `content_versions` 中出现至少 v1 提纲 (如 `createProjectFromPlanItem` 插入的 `# 标题 / 核心观点 /…` 结构)。但 `6ce` 从未离开 `selected` → `idea` 的第一步，`target.status` 仍为 `selected` (未进入 `drafting`/`blocked`)，`project.status` 仍为 `idea`。
- **Proposal 侧证据**: `.ai/wmb-5338-evidence.md:52` 记录该选题在提案台账 `评分 100` `route:boundary` `selection_mode owner_approved` 已被采纳并通过 `ensureTargetArticleLinkInternal` 绑定 `plan 8342f64f` + `project 6ce12d8a`，视为“已采纳边界项”。可复现打包中 `packaged-proposals-boundary.png` 显示 `路由:boundary` 与 `dc5c` 的 `automatic` 并列，说明上游“选题”已完成。
- **合同层面**: `daily-content-article.ts:79-117` 的 `ensureTargetArticleLinkInternal` 合同显式只保证“选题→plan→project 的绑定”，不保证正文生成；正文生成合同在 `stage D` (orchestration) 或手动“派写”。由于 `stage D` 未覆盖此 target，且手动 click 未补派，故下游 `investigation`/`writer` 合同均未履行，属于**半链成功**。
- **Research Gate 维度**: `src/main/daily-content-article.ts:147:isResearchGateSatisfied` 检查 `research_claims` 中 `supported` 数量，`dc5c` 对应 claim `557ee8d0 k1` 已满足；但 `6ce` 从未建 `research` task，故连门判定都未触发。
- **与 `d6dc` 的反例**: `d6dc` 虽也缺 `ensure_article` 命令中的正文，但后续被 `wmb5338-packaged-stale-save` 人工种子补齐至 `ready`，证明链路本需外部触发补写；`6ce` 未被纳入该补种名单，暴露种子名单与台账“已采纳”不一致的间隙。

**首错函数/条件** 汇总:

- `daily-orchestration.ts:270` `createProductionStageD` — `newTargets` 的 `enqueued` 未包含 `8aae` (因执行窗口在 `12:07` 早于其创建)
- `daily-content-article.ts:12` `ensureTargetArticleLinkInternal` — `INSERT INTO content_projects … status='idea'` 后即 `UPDATE daily_content_targets` 返回，不含 `content_versions` 插入
- `job-spawner.ts:479` `getActiveJobSpawner()` — 此时 `null` (非 orchestration 上下文)，故无 `writer` spawn
- `daily-content-cycle.ts:9` `LEGAL_TRANSITIONS` — `selected→drafting` 的合法跃迁从未被触发器 (`saveTargetArticleDraftInternal`) 调用

## 五、最小恢复 (不执行，仅建议)

| 选项 | 动作 | 是否需先研究 | 适用性 |
|---|---|---|---|
| **A: 直接派 writer (最小)** | 在当前 `projectId=6ce12d8a…` 上 `spawner.spawn({ roleId:'writer', projectId, writerTask:'core_draft', businessDate:'2026-08-22' })` 或等价 `agent_tasks.start { intent:'studio_draft', contextRefs:{ projectId, writerTask:'core_draft', businessDate:'2026-08-22' } }`，`brief` 内带 `title` 与 `sourceId f9bed...`。`researchGate` 当前为空，若策略为 `required` 则会自动先 `research_dispatched` 再续写；若想跳过研究则设 `researchMode:'prohibited'` 或 `researchGate:'exempt'` (如 `wmb-5348` 的 boundary seed 做法)。 | 否 (可选) | 若确认选题争议点可仅凭已有 zhihu 摘要 + 通识判断写作，选择 A。最短路径 1 个 job。 |
| **B: 先研究再写 (建议)** | 先 `spawner.spawn({ roleId:'reporter', businessDate:'2026-08-22', projectId? })` 或 `research` task (`intent:'research'`) 针对 `projectId` 产生 `research_claims` (如 Yann 对 LLM 局限、技术路线、Jepa 等主张)，待 `isResearchGateSatisfied` => `supported>=1` 后再 A。 | 是 | 选题属争议解读型，需核实 Yann 对 ChatGPT/LLM 的公开言论与 JePa vs 自回归等技术依据，避免幻觉。符合 `writer-research` 闭环 (`HANDOFF` `research_dispatched`→`resume`) 契约。 |
| **C: 用户补方向** | 仅当 Owner 对“否定态度”的立场/投放平台有强偏好时，需 Owner 先补充 `point_of_view / angle / platforms` (如改为 `深度解读该问题的核心争议与证据` → 更细化 `技术路线 vs 产品评价` ) 再 A/B。当前 `plan_item` 的 `point_of_view` 已有“提供独立判断与可操作建议”，未缺失。 | 按需 | 若_owner 希望控制叙事 (如“不是否定 ChatGPT 本身，而是对其技术路线的怀疑”)，可先补一句方向再派。 |

**推荐**: **B** (先研究) 优于 A，因为:
- 源仅一条 zhihu 摘要且 `source_body_cache` 为空 (无全文归档)，Writer 若直写需依赖模型记忆，违背 `evidence-grounded-writer`。
- 兄弟项目 `d6dc` 的补救路径先建了 `research_claims k1 supported` 再写稿，同类选题宜一致。
- 无需用户补方向，现 `plan_item` 的 `angle/point_of_view/platforms` 已完整 (见 `plan_items` 行)，除非 Owner 另有产品化要求。

**不需的操作**: 不必重建 `plan`/`target`/`project` (已幂等绑定)，不必重跑 `daily_orchestration` 全量，也不应删除重建。

## 六、Studio 映射/渲染链追踪

1. **DB → content.ts 投影**: `getContentProject('6ce…')` → `{ id, title, status:'idea', revision:1, revisions:[], sources:[{id:'f9bed…', title:'...'}], assets:[], platformVersions:{}, ... }`
2. **IPC → Renderer**: `window.wmb.getStudioProject` → `setSelected(detail)` → `selected.revisions.length===0`
3. **Editor state**: `useEffect([selected?.revisions[0]?.id])` → `editorBody=''` `editorTitle=title`
4. **Metrics**: `characterCount = 0`, `sources.length=1`, `assets.length=0` → 截图 `0字 1来源 0素材`
5. **Header**: `StudioEditorTop` → `核心正文 · 第 0 版 · 已保存` (由 `versionCount=0` + `dirty=false` 计算)
6. **Status bar bottom**: 同逻辑 `已保存`
7. **历史/版本 tab**: `版本 0`；切 `versions` 无条目

链路上无 `content_versions` → 无 `mediaBindings` → 无 `platformVersions` → 无 `Dual` → `illustrationRuns` 不适用。

## 七、报告自检与读回

- 报告文件已写入: `.ai/frontend-debug-loop/reports/2026-08-23-empty-yann-lecun-project.md`
- 本次诊断为只读查询，未调用任何 `create*`/`save*`/`dispatch*` 突变，不改 `J:/PigeonYang/WeMediaBuddyData/wmb.db`。
- 所有 DB 结论均由 `python sqlite3` 对真实 `wmb.db` 只读查询复核；代码结论均指向具体文件:行。

## 八、结论一句话

建壳成功 (`daily_content_target.ensure_article` `owner_ui` `e91ad226` `2026-08-22T13:40:03` `created:true` `revision 1` `idea`)，但后续写作未发生 (`jobs`/`agent_tasks`/`content_versions` 均为 0)，因手动 `ensure` 不派 writer 且最后 `daily_orchestration Stage D` (`completed` `已入队 4` at `12:07`) 执行窗口早于 `target 8aae` 创建 (`12:10:25`)，导致 `Stage D` 无法覆盖此边界采纳项；Studio 对 `versionCount 0` 时仍显示 `已保存` 属编辑器“无脏差”语义的复用，轻度误导。

---

*附: 关键 receipt 读回 (`command_receipts.e91ad226`):*

```json
{"receiptId":"e91ad226-82e9-4f23-9415-be8d1ca7a9f0","ok":true,"command":"daily_content_target.ensure_article","requestId":"wmb5338-boundary-1787406003062-f3fa81","actor":{"type":"owner_ui","id":"renderer"},"input":{"targetId":"8aae5605-7d53-450a-a729-5205fc6de27a"},"data":{"planItemId":"8342f64f-916e-498a-82df-c8628917885b","projectId":"6ce12d8a-d12d-449d-baca-fcdc55b0f3c8","created":true}}
```

*数据快照: project `6ce12d8a` `idea` `revision 1` `2026-08-22T13:40:03.068Z`; target `8aae5605` `selected` `owner_approved` `boundary` `revision 2`; source `f9bed93f` `zhihu_hot` `https://www.zhihu.com/question/582340981`; versions 0; jobs 0; agent_tasks 0.*
