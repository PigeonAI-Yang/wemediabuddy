# 诊断报告：AI 项目成本复盘一文配图头部集中缺陷

- 项目 ID: `2fb16eba-6e30-4e33-8cab-2233135ced4e`《AI 项目最容易烧钱的地方，不在模型价格，而在没人做成本复盘》
- 诊断时间: 2026-08-23 09:15 UTC+8
- Data Root: `J:/PigeonYang/WeMediaBuddyData` 只读验证（wmb.db 1.3GB）
- 目标稿: content_version v2 `aff6c832-ef79-4177-9809-fde55420d157` → 配图后 v3 `fce68133-1d12-4bf4-8cd4-fcee0c361aee`（revision 3）
- 结论性质: 缺陷（planning deterministic fallback），非设计意图

---

## 1. 六图 slot / status / anchor / binding 完整表

| ordinal | itemKey | claimKey | claim heading | excerpt (≈80) | kind | purpose | ratio | state | assetId | source binding | content_version_id |
|---------|----------|----------|---------------|----------------|------|----------|-------|-------|---------|----------------|---------------------|
| 0 | `generated:c0` | c0 | # AI 项目最容易烧钱的地方…（标题行） | AI 项目最容易烧钱的地方，不在模型价格，而在没人做成本复盘 | generated | demonstration | 16:9 | completed | `43af0353-b199-4d6b-89b5-759aaf43ac5c` (`e9e7290…png` 1672×941) | null | v3 |
| 1 | `generated:c1` | c1 | ""（空 heading，无标题段落） | 如果这个月 AI 账单突然变高… | generated | background | 16:9 | completed | `574f6264-c432-499b-ae8d-17a2b82bc9b8` (`2c9e5bd…png`) | null | v3 |
| 2 | `generated:c2` | c2 | "" | 如果不能，先别急着换模型… | generated | background | 16:9 | completed | `9762b653-0dc6-4aa1-ae6e-868698046daf` (`969a456…png`) | null | v3 |
| 3 | `generated:c3` | c3 | ## 先别问“哪个模型便宜”… | 先别问“哪个模型便宜”，先问“钱花在了哪里” | generated | demonstration | 16:9 | completed | `b1978212-18c9-4337-832d-ee0c797f6247` (`dc8d71d…png`) | null | v3 |
| 4 | `generated:c4` | c4 | "" | OpenRouter 最近介绍了 Activity dashboard… | generated | background | 16:9 | completed | `b9c42533-ee96-4269-8acf-e02d932ab0f4` (`cecc78b…png`) | null | v3 |
| 5 | `generated:c5` | c5 | "" | 这件事的价值不在于多了一张漂亮的图表… | generated | background | 16:9 | completed | `2283d30c-e009-4e3f-9c83-abda6c156c0b` (`e22e528…png`) | null | v3 |

**校验**:
- `illustration_runs` 目标运行 `a7d55ff3-8f2e-431f-8165-6dc8ae555359` status=completed, target_version_id=v3，plan_json 含 items 0..5，全部 `generated`，无 source（sourceRevisionKeys 虽关联 `source:32…:r2` 两个图，但 knowledge_visual_runs=0 → generateMediaRecommendations 返回 [] → deterministic fallback 接管）。
- 失败运行 `de1c638d…` 为同 source_version 的先前 partial attempt（c1 曾 generating 后被丢弃，未入 v3）；v3 仅提交 completed run 的 6 项，全部 completed。
- 无 anchor 丢失/重复：claimKey c0..c5 唯一，ordinal 严格递增。无排序错误：bodyWithImages 按 ordinal 排序插入。
- `content_media_bindings` v3 含 6 行 ordinal 0..5，occurrence 均为 0，width_preset full / align center / caption = item.contextSummary，media_kind image，与 asset 一一对应。
- 资产均为 illustration-workflow origin，provenance kind=generated，prompt 携带正确 heading/excerpt，尺寸 1672×941。

---

## 2. 正文 v2 与 v3 结构及 6 图插入位置

### v2 无图结构（77 行，32 claims）

```
00 H1  # AI 项目最容易烧钱...
02 PARA c1  如果这个月 AI 账单突然变高...
04 PARA c2  如果不能，先别急着换模型...
06 H2   c3  ## 先别问“哪个模型便宜”...
08 PARA c4  OpenRouter 最近介绍了 Activity...
10 PARA c5  这件事的价值不在于...
12 bullets c6 + PARA c7  4×问句 + 总结
19 H2   c8  ## 一个官方内部案例...
21 PARA c9  OpenRouter 另一条帖子 6200美元...
...
29 H2   c13 ## 我建议每个 AI 项目都做一张最小成本表
31 table c15  |维度|要记录什么|
42 PARA c16..c20  三次检查 + 总结
52 H2   c21 ## 成本复盘的终点…
54 PARA c22..c27  4步顺序 + 方法说明 + 第一步建议
69 资料依据 bullets
```

### v3 带图结构（89 行，6 枚 `![alt](wmb-asset://…)` 独占段落）

```
00 H1
02 IMG c0 (插在 H1 标题行文字之后、首段之前，line 2)
04 PARA c1
06 IMG c1 (c1 段后，line 6)
08 PARA c2
10 IMG c2 (c2 段后，line 10)
12 H2 c3
14 IMG c3 (H2 标题行后，line 14)
16 PARA c4
18 IMG c4 (c4 段后，line 18)
20 PARA c5
22 IMG c5 (c5 段后，line 22)
24 bullets c6 … 29 PARA c7
31 H2 ## 一个官方内部案例  ← 之后 0 图
41 H2 ## 我建议每个 AI 项目… ← + table 0 图
64 H2 ## 成本复盘的终点… ← 0 图
69–88 资料依据 0 图
```

**观测闭合**: 6/6 图片落在正文前 22 行（约前 25% 行数），对应 claims c0..c5；剩余 claims c6..c31（75% 正文，含三个核心章节 60% 行数、表格、三次检查、成本复盘终点四步法）零配图，与用户“后半篇无图、底部空白”完全吻合。插入是 anchor 精确命中（insertAfterAnchor 按 claim.text.indexOf 定位段尾 `\n\n`），非 renderer 统一头插——renderer 仅 hoist `<p><img></p>` 为 figure，未改变顺序。

---

## 3. 链路追踪：规划 → 生成 → 绑定 → Markdown 插入 → 渲染（首错边界）

### 3.1 规划保存：`src/main/illustration-workflow.ts:184 buildDeterministicPlan`

```ts
function buildDeterministicPlan(database, run, recommendations): IllustrationPlan {
  const claims = splitContentClaims(body); // 32 claims c0..c31
  ...
  let generatedCount = 0;
  for (const claim of claims) {
    // 源图候选：recommendationByClaim.get(claim.key) → bindings.find…
    // → 本例 recommendations=[]（见 3.3），故永不命中
    if (generatedCount >= maxGenerated || !claim.text.trim()) continue;
    generatedCount += 1;
    items.push({ itemKey: `generated:${claim.key}`, ... });
  }
}
```

**首个错误边界即此函数**: 顺序遍历 claims，遇首个可生成 claim 即占用一个 max_generated 配额（默认 6），无任何与标题/段落重要性、视觉价值、占比或分散度的评分或抽样。claims 数组是文章线性顺序，因此 c0..c5 被耗尽后，c6..c31 永远无法获得 slot。anchor 本身正确（c0..c5 对应 strlen 均 >0），也无丢失/重复——错的是“选哪些 claim 配图”，不是“插在哪里”。

### 3.2 生成完成绑定：`src/main/illustration-workflow.ts:456 generatedItemComplete` + `src/main/assets.ts:registerStagedAsset`

逐项落 asset、写 `asset_provenance(generated)`、updateItem assetId/completed。v3 的 6 项均走此路径，provenance 正确。

### 3.3 正文插入：`src/main/illustration-workflow.ts:225 bodyWithImages` + `215 insertAfterAnchor`

```ts
export function bodyWithImages(body, items, database) {
  let next = body;
  const claims = new Map(splitContentClaims(body).map(c => [c.key, c]));
  for (const item of [...items].filter(completed).sort((a,b) => a.ordinal - b.ordinal)) {
    next = insertAfterAnchor(next, claims.get(item.claimKey), markdownImageForAsset(asset, item.contextSummary));
  }
}
```
`insertAfterAnchor` 精确：`body.indexOf(anchor)` → 段尾 `\n\n` → 重建。无 anchor 丢失、无排序错、无头插兜底分支（`!claim` 仅用于 c0 标题 title fallback，仍属首段前正确位置）。

### 3.4 绑定补录：`src/main/illustration-workflow.ts:238 imageDraftsForBody` + `410 finalizeRun`

`finalizeRun` 先算 `bodyWithImages` 新版 body，再 `imageDraftsForBody` 按体中 `wmb-asset://` 顺序建 ordinal 0..5 drafts，经 `saveCoreVersion` 原子写入 `content_media_bindings`。draft occurrence / widthPreset 正确。

### 3.5 Studio 渲染布局

`src/renderer/studio-view-helpers.ts:87 hoistAssetFigures` 将独立成段 `<p><img src="wmb-asset://…"></p>` 提升为 `<figure>`；`src/shared/media-token.ts:50 parseAssetImages` 仅解析，不重排。`StudioDensityRepair` 等布局改为 flex 间距，不触及插位。**renderer 未参与“集中”**：若未经历 bodyWithImages 阶段，renderer 无法凭空把正文图片前置；且 `media-bindings.ts:171` 明确“正文 token 是排版投影，绑定为权威”——顺序权威在 core version body 已冻结，renderer 只做投影。

**区分五层**: 配图规划=错（选段策略）；slot anchor=对；生成完成=对；media binding=对（由错误规划派生）；插入/渲染=对（忠实执行错误规划）。

---

## 4. 是否设计意图？引用产品合同

**不是设计意图，属缺陷**，与下列 Owner 已确认规格冲突：

- `docs/spark/2026-08-17-post-finalization-ai-illustration-design.md §7.2 配图规划器` : “每项至少包含：稳定目标段落或锚点；用途与插入理由；排序与幂等身份。**没有真实视觉价值时也允许少于 6 张生成图。禁止为凑数量配图。**” —— 期望按“目标段落表达价值”选择，而非机械取前 6。
- 同文件 §8 图片上下文包 要求“所在章节标题、目标段落及必要的前后段落”语义化取参，隐含规划应分散于文章不同章节。
- `docs/spark/2026-08-17-pi-batch-image-placement-design.md §4.5` : “Pi 必须按文章语义决定位置，**而不是机械平均分布**。首图只在图片适合作为文章入口时使用；正文图应置于其能解释或强化的段落之后。”
- `src/shared/media-recommendations.ts:195 splitContentClaims` 合同为“标题行开新段，段落以空行分隔”——claims 切分本已覆盖 32 claims，规划层应有机会评估后部 claim，但 `buildDeterministicPlan` 未评估。
- 无“先集中生成后人工定稿/插入”的合同：定稿后配图设计 §4 强调“Pi 阅读固定正文，形成结构化配图计划：目标段落、用途、来源类型、插入位置”，**未**描述“先在头部批量生成、再由人拖拽分散”的两阶段；且 §7.1 称“Studio 展示整次运行进度、各项成功/失败状态和重试入口”，亦未提二次人工分发。`media-recommendations.ts:header` 称美化建议“用途优先级 → 重叠度 → ordinal”确定性排序——当代实现 bypass 此逻辑（recommendations=[] 时 fallback 未排序挑选）。
- 相反，`docs/spark/2026-08-14-wmb-intelligence-media-production-pipeline-design.md §4.7` 要求“裁切、标注、关键帧和视频片段均创建派生Asset，原件不变且血缘可逆”及“AI建议可解释；用户可见保存动作是进入内容版本的唯一边界”——本例 6 图 caption/alt 均直接复用 claim.excerpt，无“图为什么在此”的 rationale，与该“可解释建议”合同不符。

**结论**: 代码中 `buildDeterministicPlan` 的线性前 6 消耗策略，既未被上述任何设计授权，也未落盘为“编辑考虑”；其效果（后半篇零图）与用户观测因果闭合，且与设计中“禁止为凑数配图”“语义选位”直接相悖。

---

## 5. 为什么底部无图（数据闭合）

- claims 总数 32，maxGenerated 6 → 最多 6 处可配图。
- 推荐表 `media_recommendations` 针对 v2 内容版本为 0 行（因两关联 source 中，仅 `32ce9b…:r2` 有 1 个普通来源图 asset `b1a6142…`，但其 `knowledge_visual_runs` 为 0 → `generateMediaRecommendations` 因“未理解媒体绝不声称其内容”提前 `if (evidences.length===0) return []`；另一 source `3acd10…` 无媒体）。故 `recommendationByClaim` 为空 map，来源图分支恒失败，规划完全退化为 `generatedCount <6` 的线性填充。
- 线性填充必然选中最早 6 个非空 claim：c0 标题、c1 首问、c2 判断句、c3 小标题、c4 OpenRouter 句、c5 图表价值句。c6（bullet 列表）、c7..c31（案例、成本表、终止章、四步法、复盘建议）未获机会。
- `bodyWithImages` 忠实把这 6 个 anchoring claim 各自展开为独立段落图，因此头部 25% 行数容纳 100% 配图，其余 75%（含 3 个 H2 与核心表格）空白。

---

## 6. 最小修复边界与是否需重生成

### 是否需要重生成

**不需要重生成 6 张既有图片**：6 个资产字节完整（sha256 唯一、provenance generated、1672×941、可通过 `wmb-asset://` 读取），且每张的 `request_text/contextSummary` 仅为当前序位的 claim.excerpt 派生——若改为复用，只要重绑 claimKey/excerpt 不影响字节可读性，图片可原位复用。仅当新锚点语义与旧 caption 严重不匹配（如 c0 标题图被挪到“成本表”表格处）时，publisher/读者可能觉 alt 不贴切；此时可用**可选**的单张 regenerate 覆盖，不阻塞批量重排。

### 最小修复（两择一，推荐 A）

#### 方案 A——重排现有绑定（零重生成，优先级 P0）

1. **仅改规划与插入**：在 `buildDeterministicPlan` 替换线性前 6 逻辑为“分散抽样”：对 claims 按 `heading`/`text` 价值评分（标题/表格/小标题/关键段落权重）或至少按“每章节一图 + 表格邻段一图 + 终章一图”强制分散，再取 top 6。
2. **复用同一 6 asset，改写 content_version**：基于已完成 `illustration_items` 的 6 个 assetId，重算 6 个目标 claimKey 为 disperseds `['c0','c3','c9','c15','c21','c24']` 示例（覆盖：标题、第二章标题、案例段、成本表、终章标题、四步法），调用现有 `bodyWithImages`/`imageDraftsForBody`/`saveCoreVersion` 链创建新 core version（如 v4），更新 `illustration_items.claimKey/contextSummary` 与 `content_media_bindings.ordinal/caption` 映射，不触及 asset 表。
3. **验收即生效**：Studio、预览、导出、发布快照均消费 `content_versions.body` + `content_media_bindings` 顺序，无需额外 renderer 改动。

*修复点单一文件*: `src/main/illustration-workflow.ts:184 buildDeterministicPlan`（规划）+ 轻量一次性数据迁移脚本（重绑现有 run 的 6 项 claimKey 并 finalize 新版）。不改 `assets.ts`、`media-token.ts`、`studio-view-helpers.ts`。

#### 方案 B——按标题/段落锚点重算（若决定改善 alt 贴合度）

在方案 A 基础上，对 1–2 张与新锚点语义距离最远的图执行 `illustration.item.regenerate`（携带正确 `heading+excerpt` 上下文包），其余 4 张复用。仍无需全量 6 张重生成。

### 应按何种锚定

- **按标题/段落锚点（claimKey）**，而非图序比例：将每图固定到一个 `claimKey`（即 `splitContentClaims` 的稳定段），由 `insertAfterAnchor` 精确定位段尾。**图序比例**（16:9 等）是既有 ratio 维度，与纵向分布无关；本例 6 图均为 16:9，无需改 ratio。

### 验收场景

1. **行内验收**：打开 `fce68133…` 的后继 v4 正文，断言 `parseAssetImages(body).length === 6` 且 6 个 token 分散于≥3 个 H2 之下（例如 H1后 1 图、H2#1后 2 图、H2#2后 1 图、H2#3后 1 图、H2#4后 1 图），且表格 `|维度|` 邻段有图或图注。
2. **零空白章**：任一 H2 章节（含“一个官方内部案例”“我建议每个…”“成本复盘的终点”）的正文中不再零图；末段“先回答钱花在哪里”前后 200 字符内至少 1 图。
3. **绑定一致性**：`content_media_bindings` ordinal 升序与 body 中 `wmb-asset://` 出现顺序一致；alt/caption 与 anchored claim.excerpt 匹配。
4. **复用证明**：6 个 assetId 与 v3 完全相同（或仅 1–2 个经 regenerate 替换），`assets.byte_count/sha256` 未变。
5. **渲染验收**：`studio-view-helpers.renderMarkdown` 产物的 6 个 figure 在 DOM 中分散，且 `hoistAssetFigures` 不聚合到顶部容器；导出 HTML 中图不在 `<header>` 内集中。

---

## 7. 关键证据索引（只读查询闭合）

| 证据 | 位置 | 值 |
|------|------|----|
| 项目 | content_projects | id `2fb16eba…`, revision 3, title 匹配 |
| 版本 | content_versions | v2 `aff6c832…` body 2074B 0 图; v3 `fce68133…` 2696B 6 图 |
| 运行 | illustration_runs | `a7d55ff3…` plan_json 6×generated(c0..c5), `de1c638d…` 已废弃 generating |
| 槽位 | illustration_items | ord 0..5 claim c0..c5 全 completed，asset 6 个 |
| 资产 | assets | 6 行 width 1672 height 941 origin illustration-workflow |
| 绑定 | content_media_bindings | v3 上 6 行 ordinal 0..5 caption=excerpt |
| 推荐 | media_recommendations | v2 上 0 行（visual_runs 0 → evidences 0） |
| 来源 | source_items | `32ce9b…:r2` 1 archived image 但无 visual run，`3acd10…` 无媒体 |
| 正文 | body 插入 | `bodyWithImages` ord排序 + `insertAfterAnchor` 按 claim.text 段尾插入，token 行 2/6/10/14/18/22 |
| 渲染 | studio-view-helpers | `hoistAssetFigures` 仅包装，不重排 |

---

## 8. 附：与“编辑考虑”差异的明确表述

用户任务约束：“不要把‘编辑考虑’当事实，必须指出实际数据和首个错误边界”。

- 实际数据：6/6 图的 claimKey 为 c0..c5，前 6 claims；claims c6..c31 共 26 段零图；media_recommendations 0 行为 deterministic fallback 触发条件提供了数据库级证据。
- 首个错误边界：`src/main/illustration-workflow.ts:184 buildDeterministicPlan` 的 `for (const claim of claims) { if (generatedCount >= maxGenerated) …; items.push(generated:claim.key) }` 顺序消耗——**此行之前** recommend/source 分支已因 evidences=0 而无效；**此行**即决定“哪些段配图”，直接导致头部集中；后续 `bodyWithImages`/`imageDraftsForBody`/renderer 均为正确投影，未引入新错。

---

## 9. 建议后续（可选，不在本诊断 Fix 范围）

- 为 `generateMediaRecommendations` 补充“无视觉理解时按 claim 重要性择优”或“纯 generated fallback 时按章节分散”的第二优先级策略，避免 future 文章在无外部 source 理解时再次全头集中。
- 在 `illustration_runs.plan_json` 中保留每 item 的 claim.heading/excerpt 供审计，当前已保留 contextSummary，可进一步加 `distributionScore` 字段。

---

报告路径: `J:/PigeonYang/WeMediaBuddy/.ai/frontend-debug-loop/reports/2026-08-23-article-illustration-placement.md`
验证: 报告已写入并读回；标题、§1..§8 关键章节及末尾完整（本节即末尾）。
