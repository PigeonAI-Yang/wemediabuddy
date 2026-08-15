# WMB 图片来源 → 创作 → 发布链路设计（Source Image Creation Publishing Chain）

- 日期：2026-08-13
- 状态：Owner 已确认方案 C，本文件为正式 Spark 设计规格
- 上位设计：
  - [`2026-08-12-wmb-built-in-wiki-notes-architecture-design.md`](./2026-08-12-wmb-built-in-wiki-notes-architecture-design.md)
  - [`2026-08-12-wmb-knowledge-object-version-contract-design.md`](./2026-08-12-wmb-knowledge-object-version-contract-design.md)
  - [`2026-08-13-wmb-global-wiki-knowledge-network-design.md`](./2026-08-13-wmb-global-wiki-knowledge-network-design.md)
- 关联实现：WMB-5237 visual source lineage（`src/main/visual-source-lineage.ts`）、WMB-5228 knowledge-candidates、WMB-5229 compileSavedSource、WMB-5215 创作知识调用血缘、现有 Studio 与发布管线

本设计只定义产品和领域契约，不规定最终表名、SQL 结构、队列实现或模型提示词；对象字段以“至少包含”给出。文中以 `[现有]` 标注已实现能力，`[待实现]` 标注本设计新增能力。

## 1. 问题与目标

WeMediaBuddy 目前的图片资产链条是断裂的：图片只有“上传到平台版本”一个终点，缺少从资料原文到视觉理解、到知识证据、到创作配图、再到发布冻结的完整闭环。具体表现：

1. 采集端不保留原图：X 时间线只存图片 URL 数组（`x_list_timeline_cache.payload_json.images/imageThumbs`），渲染端远程热链 twimg；官网采集只取纯文本；小红书 MCP 只读不下载。远程 URL 不是正式资产。
2. 视觉理解管线孤立：WMB-5237 已实现 `knowledge_visual_runs` 全链路（下载 → 视觉 run → 严格 observation → 知识候选 → 编译 ChangeSet），但没有 IPC/preload/renderer/生产调用，模块零生产引用；观察不携带区域（region）。
3. 创作端无结构化图集：核心版本（`content_versions`）没有素材列，图片只作为 `wmb-asset://` Markdown 文本活在正文里；平台版本（`platform_versions.asset_ids_json`）有顺序素材绑定，但没有封面、裁剪、图注、来源血缘；媒体素材侧栏只有“已上传”列表，不呈现“来源图候选”。
4. 发布快照已冻结素材字节（`publication_snapshots`），但冻结的是平台版本 asset_ids 对应的原始 asset，裁剪/封面/图注等平台语义没有正式载体。
5. 知识回看不可达：视觉结论的 EvidenceLink.locator 指向 asset + sourceRevision，但没有区域，用户无法从知识卡片“回看原图区域”。

目标：把图片作为一等资料接入现有知识飞轮，形成“采集 → Source 图文冻结 → 视觉理解 → 知识证据 → 创作候选素材 → 核心图文版本 → 平台图文版本 → 发布快照”的完整闭环，且全部复用现有对象（Source、Source revision、assets、visual source lineage、Studio 核心/平台版本、发布快照），不复制任何 Source/Content 身份。

已确认方案 C：**结构化图文版本绑定为权威关系，正文 `wmb-asset://` 仅是编排投影**。即图片与版本的绑定关系（顺序、图注、封面、裁剪、来源）由正式绑定对象表达，正文 Markdown 引用只是编辑器内的排版投影，不再承担“图集唯一真源”的角色。

## 2. 非目标

- 实现阶段：本文件不授权实现，不拆票、不改代码、不改 schema。
- 不建设独立图片库/素材中心产品页：图片身份继续是 `assets` 表（sha256 去重），绑定是关系对象，不建立第二套图片身份或第二套素材存储。
- 不把 Markdown、Canvas、远程 URL、UI 或 `wmb-asset://` 正文文本当作真源。
- 不承诺小红书自动发布：`publication-commands.ts` 当前只允许 x/wechat 走发布命令，小红书发布边界本期不变；小红书仅做数据先行（绑定、封面、顺序、图注）。
- 不扩展 X 多图发布：现有 X 适配器只携带快照第一张图（`prepareXImage` 上传 `snapshot.assets[0]`），多图发布属于发布适配范围，本期不改。
- 不实现图片生成：AI 生成图只定义身份与 provenance 契约，不定义生成器本身。
- 不引入外部 Wiki/素材系统，不连接 Obsidian。
- 不做图片编辑器的自由变换（旋转、滤镜、九宫格等）：本期仅矩形裁剪区域（x, y, w, h）。
- 来源图自动成为候选，但**不自动插稿**；Pi 可建议，插入版本始终走用户可见的保存动作。
- 不改变人工最终发布边界：确认并发布仍是人工动作。

## 3. 原则与不变量

1. **单一真源**：SQLite 唯一业务真相。绑定是正式对象；正文、图谱、远程 URL 都是投影或参考。
2. **图片身份复用**：图片字节身份 = `assets.id`（sha256 去重，不可变字节）。任何层级的绑定都引用 asset，不复制图片身份。
3. **Source 图文冻结**：图片集合随 Source revision 冻结。新 revision 产生新绑定，旧 revision 的图片集合不可变。
4. **远程热链不得成为正式资产**：任何进入绑定、观察、版本或快照的图片必须是本地 asset（下载成功 + sha256）；远程 URL 只作为 `originalUrl` 血缘记录。
5. **失败不得伪装完整**：下载失败 → 无 asset + 失败状态保留错误；视觉失败 → failed run 保留错误；编译失败 → 整批零写；发布失败 → 现有“失败/需要人工处理/结果待对账”状态机。绝不生成占位图、假 observation 或假快照。
6. **来源图自动成为候选但不自动插稿**：候选进媒体素材侧栏与创作上下文，插入核心/平台版本必须经过用户可见的保存动作。
7. **核心与平台版本相互隔离**：核心图文绑定变更不静默改写平台绑定；平台绑定记录其基础来源（基于核心版本 N）并在漂移时提示。
8. **视觉观察必须定位具体 sourceRevision + asset + region**：EvidenceLink.locator 至少携带 sourceRevision + asset，区域观察携带 region；不能只给 URL 或自由文本。
9. **不可变版本契约延续**：content_versions、source_body_revisions、快照不可变；绑定随父对象版本语义演化（核心绑定随不可变核心版本追加，平台绑定随平台版本 revision 乐观锁更新）。
10. **AI 不硬删除正式对象**：移出/替换/恢复都是软终结 + 追加版本；asset 字节被引用时不得删除。
11. **人工最终发布边界不变**：确认并发布保持人工动作，AI 只能准备。
12. **权限与成本边界**：写入继续走 Capability 注册表、Task/Page Grant、dispatcher 和命令回执；视觉/下载/生成等高成本操作有界、可审计、有失败路径。
13. **现有业务对象不复制**：不建立 Source、Content、Publication、Review、KnowledgeNote 的平行副本。

## 4. 用户旅程

面向用户的完整旅程（对应已确认的产品结构：创作页三栏 + 平台页签；发布页三栏）：

1. **采集与冻结**：用户在今日/资料库看到一份图文资料（X 帖子、官网文章等），保存为 Source。图片随正文一起下载落为 asset，并冻结到本次 Source revision。
2. **视觉理解**：后台（或用户手动触发）对冻结图片跑视觉理解，产出结构化观察；观察成为知识候选，编译为 KnowledgeNote，证据 locator 精确指向 图片 + revision + 区域。
3. **创作候选**：用户在创作页进入关联该 Source 的内容项目，右侧“媒体素材”页签出现来源图候选（带观察结论摘要与“AI 生成/来源图”身份标识），但**不会**自动插入任何版本。
4. **核心图文版本**：用户选择 2 张图进入核心版本，图序、图注保存在核心图文绑定；正文编辑器中的 `wmb-asset://` 只是排版投影，保存时自动对账。
5. **平台版本独立调整**：X / 小红书 / 微信公众号版本从核心派生，各自独立选择封面、排序、裁剪与图注；核心后续修改不会静默改写平台绑定。
6. **发布快照冻结**：发布页确认区域显示平台、账号、内容版本、媒体素材（数量、封面、文件可用）；确认后快照冻结标题、正文与素材字节（含裁剪派生图）。小红书保持“数据先行、不自动发布”。
7. **结论回看原图区域**：Topic Wiki 知识卡片上的证据“查看原图区域”打开 Source 冻结 revision 的对应图片并高亮区域，用户可直接核对观察是否准确。

## 5. 现状复用与缺口

### 5.1 可复用现状 `[现有]`

| 环节 | 现有能力 | 位置 |
|---|---|---|
| 图片字节身份 | `assets` 表：sha256 去重、`relative_path`、mime、宽高、`origin` | `src/main/assets.ts` |
| 图片导入 | `importAsset` / `importAssetBytes` / `registerStagedAsset` | `src/main/assets.ts` |
| 远程下载 | `ensureSourceImageAsset`（本地/远程 → asset，20s 超时，UA/accept 头，sha 去重） | `src/main/visual-source-lineage.ts` |
| 视觉理解 | `knowledge_visual_runs`（v59 迁移）：sourceId + sourceRevisionId + assetId + schemaVersion + attempt 幂等、状态机 queued→running→completed/failed、completed 行不可变触发器、严格 manifest 解析、`visual_run_to_knowledge` 候选计划 | `src/main/visual-source-lineage.ts`、`src/main/db/knowledge-flywheel-migrations.ts` |
| 视觉 locator v1 | `asset:<assetId>\|sourceRevision:<sourceRevisionId>`（严格解析） | `src/main/visual-source-lineage.ts` |
| 知识编译 | `compileSourceKnowledge`：原子 ChangeSet、requestId 幂等、locator 必填、低价值零晋升 | `src/main/knowledge-compiler.ts` |
| Source 正文 revision | `source_body_revisions` 追加式不可变正文历史（v61 迁移） | `src/main/db/source-body-revision-migrations.ts`、`src/main/source-body-cache.ts` |
| Studio 平台素材 | `platform_versions.asset_ids_json` 顺序素材绑定；导入图片即加入平台 draft 并插入 `wmb-asset://` | `src/main/content.ts`、`src/main/ipc-today-studio-business.ts`、`src/renderer/studio-view.tsx` |
| 发布冻结 | `PublicationSnapshotV1`：payload + assets（id/sha256/relativePath/mimeType）字节冻结 + payloadHash/assetsHash/inputHash + causation；X 上传 assets[0]；微信编辑器回读校验；回读不一致拒绝 | `src/main/publication-operations.ts`、`src/main/publication-commands.ts`、`src/main/publishing.ts` |
| 创作知识调用 | `knowledge_usage_packages/records` 固定版本血缘 | WMB-5215 |

### 5.2 缺口 `[待实现]`

1. **采集不保留原图**：X 时间线缓存只存 URL 数组且渲染端热链；官网采集纯文本；小红书 MCP 只读。Source 保存时没有“图文冻结”动作。
2. **visual source lineage 无生产接线**：`visual-source-lineage.ts` 仅测试引用，无 IPC/preload/renderer/modelCall 注入，无后台调度。
3. **观察无区域**：observation item 无 region 字段；locator v1 只有 asset + sourceRevision 两段；知识卡片无法“回看原图区域”。
4. **核心版本无图集**：`content_versions` 无素材绑定；核心图只活在正文 Markdown 文本里。
5. **平台绑定缺语义**：`asset_ids_json` 只有顺序；缺封面、裁剪、平台图注、来源血缘；发布预览只有文件名与“文件可用”。
6. **媒体素材侧栏只是上传列表**：不呈现来源图候选、观察结论、AI 生成身份与 provenance。
7. **AI 生成图无身份**：生成的图片没有区别于“用户导入/外部来源”的正式标记与生成记录。

## 6. 对象关系与版本语义

```text
Source (source_items)                     [现有]
└─ SourceRevision (source_body_revisions) [现有]  追加式不可变正文 revision
   └─ SourceMediaBinding × N              [待实现]  图文冻结：该 revision 的图片集合（新对象）
       └─ Asset (assets, sha256 去重)     [现有]  图片字节身份
          └─ AssetProvenance              [待实现]  来源/生成/派生血缘（新对象）

VisualRun (knowledge_visual_runs)         [现有]  (sourceId, sourceRevisionId, assetId, schemaVersion)
└─ observation items（可选 region）        [待实现 region] → 知识候选
   └─ KnowledgeNoteVersion + EvidenceLink [现有]  locator 携带 region  [待实现 v2]

Content Project (content_projects)        [现有]
└─ Core Version (content_versions)        [现有]  追加式不可变
   └─ ContentMediaBinding × N             [待实现]  核心图文版本图集（新对象）
└─ Platform Version (platform_versions)   [现有]  revision 乐观锁，asset_ids_json 保留为投影
   └─ PlatformMediaBinding × N            [待实现]  平台图文编排（新对象）
      └─ 派生裁剪 Asset                   [待实现]  crop 物化的新 asset（provenance 记录）
└─ Publication (publications)             [现有]
   └─ PublicationSnapshotV1               [现有]  冻结 payload + assets 字节链
```

版本语义：

- **图片字节不可变**：`assets` 行创建后内容不变（sha256 寻址）；绑定只移动引用，不复制字节。
- **Source 图文冻结**：SourceMediaBinding 绑定在 sourceRevisionId（不可变 revision）上，形成该 revision 的图片快照；新 revision 下载新图时创建新绑定行，旧行保留。
- **核心图文版本**：content_versions 追加式不可变 → ContentMediaBinding 对每个 contentVersionId 建立图集；用户纠正通过归档旧绑定 + 新绑定，或保存新核心版本。
- **平台图文版本**：platform_versions 原地更新（revision 递增）→ PlatformMediaBinding 随父平台版本乐观锁更新，同一 platformVersionId 下 asset 唯一；`asset_ids_json` 继续作为发布管线消费的投影，与绑定在同一事务内重算。
- **发布快照**：PublicationSnapshotV1 不变，冻结 payload + assets（id/sha256/relativePath/mimeType）；裁剪已物化为独立 asset，因此快照天然冻结裁剪后的字节。
- **不可变约束**：knowledge_visual_runs completed 行不可变（现有触发器）、source_body_revisions 不可变（现有触发器）、content_versions 不可变（现有）、快照不可变（现有）；绑定不硬删（软终结 + archivedAt）。

## 7. 三类 Media Binding 契约

命名按既有约定校准（`assets`、`content_project_assets`、`platform_versions.asset_ids_json` 的下划线风格），对象名：`SourceMediaBinding` / `ContentMediaBinding` / `PlatformMediaBinding`。三者都是关系对象，图片身份一律指向 `assets.id`。

### 7.1 SourceMediaBinding（来源图文冻结）`[待实现]`

表达“某 Source revision 冻结的图片集合”，是视觉理解、证据回看与创作候选的来源真源。

至少包含：

- `id`
- `sourceId`（FK source_items）
- `sourceRevisionId`（FK source_body_revisions；绑定随 revision 冻结）
- `assetId`（FK assets；同一 revision 内唯一）
- `ordinal`（图序，0 起；同一 revision 内唯一，与正文/时间线出现顺序一致）
- `caption`（图注草案：来源 alt/上下文抽取，AI 起草，可空）
- `originalUrl`（远程原 URL；本地导入为 null）
- `download` 状态与失败语义（见 §8）
- `archivedAt` / `archivedReason`（软移除；asset 字节保留）
- `createdAt`、`createdBy`（user / pi / background_agent / system）

约束：

- 远程热链不落库：只有下载成功并 sha256 去重为 asset 的行才进入绑定。
- 同一 sourceRevisionId 内 assetId 唯一、ordinal 唯一；批量写入以保存事务的 requestId 幂等。
- 视觉 run 必须引用已存在的绑定（sourceId + sourceRevisionId + assetId），未绑定的 asset 不得入队视觉观察。

### 7.2 ContentMediaBinding（核心图文版本）`[待实现]`

表达“核心版本 Vn 的图集”，是方案 C 中“结构化图文版本绑定为权威关系”的核心载体。

至少包含：

- `id`
- `contentVersionId`（FK content_versions；不可变核心版本）
- `assetId`（FK assets；同一版本内唯一）
- `ordinal`（图序，0 起；同一版本内唯一）
- `caption`（核心图注，用户可编辑）
- `archivedAt` / `archivedReason`（软移除）
- `createdAt`、`createdBy`

约束：

- 正文 `wmb-asset://` 引用是排版投影；保存核心版本时自动对账（见 §12）：正文引用而绑定缺 → 追加到绑定末尾；绑定有而正文未引用 → 保持绑定（图集语义）。
- 核心版本变更不触碰平台绑定（隔离原则）；平台绑定通过 `baseContentVersionId` 感知来源。

### 7.3 PlatformMediaBinding（平台图文版本）`[待实现]`

表达“平台版本对图集的独立编排”，是顺序、封面、裁剪、平台图注的正式载体。

至少包含：

- `id`
- `platformVersionId`（FK platform_versions）
- `assetId`（FK assets；同一平台版本内唯一）
- `ordinal`（平台图序，0 起；同一平台版本内唯一）
- `caption`（平台图注覆盖；null = 沿用核心图注）
- `isCover`（封面标记；同一平台版本内至多一个 true）
- `cropRegion`（归一化矩形 `{x, y, width, height}` ∈ [0,1]，可为 null）
- `derivedAssetId`（FK assets，可空；裁剪物化后的新 asset）
- `archivedAt` / `archivedReason`（软移除）
- `revision`（随 platform_version 乐观锁递增）
- `createdAt`、`updatedAt`

约束：

- UI 编辑绑定；保存平台版本时绑定与 `asset_ids_json` 投影在同一事务内更新（发布管线继续消费 `asset_ids_json`，`publication-commands.ts` / `publication-operations.ts` 不改）。
- X 平台：单图发布边界（适配器只携带 assets[0]）→ 校验 `isCover` 必须位于 ordinal 0；多图发布不在本期。
- 小红书：多图顺序 + 封面 + 图注数据先行，不承诺自动发布。
- 微信公众号：图片以正文 HTML 内嵌（现有适配器 assetIds=[]）→ 绑定仅作预览/编排元数据，不改变发布行为。

## 8. 采集、下载、哈希、原 URL、顺序、图注、失败语义

### 8.1 采集 `[待实现]`

- Source 保存/冻结时，从采集来源收集图片候选：
  - X 时间线/帖子：`images` / `imageThumbs` URL 数组（现有缓存字段），按原帖媒体顺序；
  - 官网/网页正文：正文 HTML 中的图片 URL（按文档顺序）；
  - 小红书 MCP：若返回媒体 URL 则收集（只读，不做承诺）。
- 候选进入冻结流程：下载成功 → asset；下载失败 → 失败记录，不进入绑定。
- 渲染端热链（twimg 等）仅为浏览投影，不进入任何正式对象。

### 8.2 下载 `[待实现]`（复用 `ensureSourceImageAsset` 契约）

- 仅允许 `https`/`http`；20s 超时；UA + accept 头（现有实现）。
- MIME 必须 `image/*`（现有校验）；格式白名单：png / jpeg / webp / gif；SVG 不进入发布载荷（§19）。
- 单图大小上限（默认 20MB，可配置）。
- 下载失败：不创建占位 asset；绑定行记 `download_failed` + `errorCode`/`errorMessage`；有界重试（默认 ≤3 次），重试不覆盖失败历史。

### 8.3 哈希与去重 `[现有]`

- 字节 sha256 为图片身份键；同字节跨 Source/项目去重（`importAsset`/`importAssetBytes` 已实现）。
- 绑定保存 `assetId` + 快照期 `sha256`（用于确认/回读校验），内容不可变则哈希不变。

### 8.4 原 URL `[待实现]`

- 每张来源图在 SourceMediaBinding 保存 `originalUrl`；asset `origin` 继续使用 `source-visual:<sourceId>` 约定，URL 全量保留在绑定上，避免只存文件名。

### 8.5 顺序 `[待实现]`

- `ordinal` 与采集顺序一致（X 媒体数组顺序、网页文档顺序）；进入核心/平台时由用户或 AI 提案调整，绑定 ordinal 唯一。

### 8.6 图注 `[待实现]`

- 来源层：从 alt 文本/邻近正文抽取或 AI 起草，存 SourceMediaBinding.caption（草案，不进入发布载荷）。
- 核心层：ContentMediaBinding.caption（用户编辑）。
- 平台层：PlatformMediaBinding.caption 覆盖（小红书数据先行字段；X/微信发布载荷不含独立 caption 字段——X 正文内联、微信正文 HTML 内嵌）。
- AI 起草的图注必须经用户确认后才随发布载荷生效；不能把 AI 草案自动当作最终文案。

### 8.7 失败语义总表

| 环节 | 失败表现 | 不变量 |
|---|---|---|
| 下载 | binding `download_failed` + 错误码；无 asset | 不创建占位图；热链不入库 |
| 视觉运行 | run `failed` + `errorCode`/`errorMessage`；可重试新 attempt | completed 行不可变；绝不伪造 observation |
| observation 解析 | `OBSERVATION_PARSE_FAILED` 整批失败 | fail-closed；不猜测 |
| 知识编译 | ChangeSet 零写；可读回执 | locator 缺失拒绝；低价值零晋升 |
| 版本保存 | 与现有 `content.save_version` / 平台保存一致：revision 冲突 → 整体失败 | 绑定与父版本同事务 |
| 发布 | 现有状态机：失败 / 需要人工处理 / 结果待对账 | 回读不一致拒绝；禁止自动重发 |

## 9. 视觉运行与区域 locator

### 9.1 视觉运行 `[现有] + [待实现接线]`

- `knowledge_visual_runs` 与 `visual-source-lineage.ts` 全管线已实现；本设计补齐生产接线：IPC/preload（入队、重试、列表、转知识）、modelCall 注入、后台有界调度与失败重试。
- 入队输入：`sourceId + sourceRevisionId + assetId + schemaVersion`；`schemaVersion` 升到 2 以支持 region（与 v1 幂等键隔离：v1 与 v2 是不同 run）。
- 同一三元组 + schemaVersion 幂等（现有）；失败重试新 attempt（现有）。
- 仅对已绑定（SourceMediaBinding）且下载成功的 asset 入队。

### 9.2 区域（region）`[待实现]`

- observation item 增加可选 `region` 字段：归一化矩形 `{x, y, width, height}`，值 ∈ [0,1]，最多 4 位小数；缺失 = 整图。
- 严格校验：非有限数、越界、宽/高 ≤ 0 → 整批失败（fail-closed）。
- 模型 prompt 指示：观察指向图中具体区域时必须给出 region；无法定位区域时省略（整图观察）。

### 9.3 Locator v2 `[待实现]`

- v1（现有）：`asset:<assetId>|sourceRevision:<sourceRevisionId>`
- v2：在 v1 后追加可选第三段 `region:<x>,<y>,<w>,<h>`。
- 解析规则：两段 → region = 整图（保持现有行为与测试不变）；三段 → 严格解析 region；其他 → null（fail-closed）。
- `visualEvidenceLocator` 增加可选 region 参数；`parseVisualEvidenceLocator` 返回含 region 的结果；旧调用与旧测试语义不变（向后兼容）。
- 约束：sourceRevisionId 与 region 值不得包含 `|` 与 `,` 之外的非法字符；locator 必须能解析回同一血缘（现有自校验延续）。

## 10. Evidence 绑定

- 视觉观察转知识候选沿用现有 `visualRunToKnowledgeInput`：claim → `unverified`、其余 → `inference`、`evidenceLevel = single`、`relation = supports`、`requestId = visual_source:<runId>`。
- `[待实现]` locator 使用 v2：含 region 的观察在候选 locator 中携带 region；EvidenceLink.locator 原样保存（现有 `locator` 字段是字符串，无需改表）。
- `excerpt` 继续保存图中可观察细节原文（OCR/视觉细节），与 locator 共同构成证据；禁止仅自由文本。
- 视觉观察得到的 KnowledgeNote 通过现有 ChangeSet 落库，生成 KnowledgeUpdateReceipt；回执展示“从图片观察到 N 条知识”，默认不暴露 locator 内部格式。
- 观察结论回看：Topic Wiki / 知识卡片的证据项提供“查看原图区域”动作 → 解析 locator v2 → 打开 Source 冻结 revision 的 asset 并高亮 region（整图观察则整图高亮）。

## 11. 创作候选与选择规则

- **来源图自动成为候选**：内容项目关联的 Source（`content_project_sources`）其 SourceMediaBinding 图片自动进入创作页“媒体素材”页签候选区，携带：缩略图、来源（Source 标题 + revision）、图注草案、观察结论摘要（若有）、身份标识（来源图 / AI 生成 / 派生裁剪）。
- **不自动插稿**：候选绝不自动进入核心或平台版本；用户手动选择插入；Pi 可以提案（建议图序与图注），但插入必须落到用户可见的保存动作。
- 候选排序：默认按 Source 时间/图序；存在已编译观察结论的图片优先展示观察摘要；无观察的图片如实显示“尚未视觉理解”。
- 选择规则：核心图集选择权在用户；AI 建议依据视觉观察的 `valueRationale`、知识价值与内容匹配，但建议不构成自动采用。
- 已选入版本的图片在候选区标记“已在核心 V3 / X 平台 v2”，避免重复插入歧义。

## 12. 核心图文版本

- 核心版本保存（`content.save_version`）时同时写 ContentMediaBinding（新增参数：`assetIds` + 可选 `captions`）。
- 对账规则（方案 C 的落地）：保存核心版本时解析正文中全部 `wmb-asset://` 引用：
  - 正文有引用而绑定缺 → 追加到绑定末尾；
  - 绑定有而正文无引用 → 保留绑定（图集语义）；
  - 正文引用顺序变化 → 更新绑定 ordinal（正文投影是图序编辑的一种方式，绑定仍是权威）；
  - 绑定、正文引用、版本内容在同一事务内提交；失败整体回滚。
- 核心编辑器：正文区维持现有富文本/源码双模式；图集编排区（新增，原位）提供插入、排序、删除、图注编辑、拖拽。
- 核心图集变更不触碰平台绑定（隔离原则）；平台版本通过 `baseContentVersionId` 感知“基于核心版本 N”。

## 13. 平台派生、裁剪、封面、排序

- **派生**：新建平台版本时，PlatformMediaBinding 初始化为核心图集（顺序/图注继承），此后独立编辑。平台绑定记录 `baseContentVersionId`。
- **排序**：平台版本内拖拽排序，ordinal 唯一；`asset_ids_json` 投影同事务重算。
- **封面**：`isCover` 标记，同一平台版本至多一个；X 平台校验封面必须在 ordinal 0（单图发布边界）；小红书数据先行。
- **裁剪**：
  - 用户在平台版本对某图应用矩形裁剪（cropRegion 归一化）；
  - 保存时在同一事务内：按 cropRegion 从原 asset 物化新 asset（`importAssetBytes`，origin `platform-crop:<platformVersionId>`，字节 sha256 去重）→ PlatformMediaBinding.derivedAssetId 指向新 asset → `asset_ids_json` 中该位置引用派生 asset；
  - 重复裁剪产生新派生 asset，旧派生 asset 保留（provenance 链完整）；重新选择原图时绑定指回原 asset。
  - 选择物化时机为“裁剪保存”而非“发布时”：发布快照管线（按 id + sha256 查 assets）不改一行代码即可冻结裁剪字节。
- **隔离**：核心图集变更后，平台绑定保持自身编排；发布预览显示“X平台版本2 · 基于核心版本3”（现有预览文案），并提示核心已变更但平台未同步（如适用）。

## 14. 发布快照及 X/微信/小红书边界

- `PublicationSnapshotV1` 保持现有冻结语义：payload（title/body/format）+ assets（id/sha256/relativePath/mimeType）+ payloadHash/assetsHash/inputHash + causation + browserBinding；回读校验、确认失效、禁止自动重发不变。
- `[待实现]` 快照创建输入继续由平台版本提供（assets 顺序 = 绑定顺序；裁剪已物化为绑定中的派生 asset，天然进入快照）。
- 平台边界（现有不变，本设计只补数据语义）：
  - **X**：发布上传 `assets[0]`（单图）；封面 = 第一张；正文内联图注。多图发布不在本期。
  - **微信公众号**：适配器返回 `assetIds: []`，图片经编辑器内嵌正文 HTML；PlatformMediaBinding 仅作预览/编排元数据，不改发布行为。
  - **小红书**：`publication-commands.ts` 拒绝小红书发布命令（仅 x/wechat）——边界不变；本设计为小红书提供多图顺序、封面、图注的数据先行绑定，**不承诺小红书自动发布**。
- 素材状态在确认区如实展示：`文件可用` / 数量 / 封面；任一变化（含绑定顺序、裁剪、封面）使确认失效（现有 `CONFIRMATION_STALE` 语义覆盖：素材顺序或 sha256 变化 → 拒绝）。

## 15. AI 生成图身份与 provenance

- `[待实现]` 新增 `AssetProvenance`（追加式血缘记录，每 asset 可有多条）至少包含：`assetId`、`kind`（`imported` / `generated` / `derived_crop`）、`origin`、`sourceUrl`（导入）、`sourceRevisionId`（来源图）、`generator`（生成者：pi / background_agent / 用户工具）、`generationPrompt`、`generationModel`、`derivedFromAssetId`、`cropRegion`、`requestId`、`createdAt`。
- AI 生成图：`assets.origin = ai-generated:<requestId>`，身份标记 `generated`；UI 显示“AI 生成”徽标；生成图**不得冒充**来源图或用户导入图，不得作为视觉观察/知识证据的来源（观察只针对 SourceMediaBinding 来源图）。
- 派生裁剪图：provenance 记录 `derived_crop` + `derivedFromAssetId` + `cropRegion`，可沿链回溯到来源图与 Source revision。
- 生成图进入平台版本与来源图同等受发布确认约束；发布载荷不区分（平台侧无法感知来源），但 WMB 内部全程可追溯。

## 16. 移出、替换、恢复

- **移出**：从绑定移除 = 软归档（`archivedAt` + `archivedReason`）；asset 字节保留（sha256 可能被其他对象复用）；已发布快照不受影响（快照独立冻结）。
- **替换**：新绑定行 + 旧绑定行归档（核心/来源层）；平台层原地更新绑定字段（乐观锁 revision），同一平台版本内 asset 唯一（换图 = 改 assetId 并归档旧引用语义）。
- **恢复**：
  - 核心版本恢复 = 追加新版本（现有 `content_versions` 语义）+ 新版本自带新 ContentMediaBinding（恢复时从旧版本复制绑定，标记 `restored`）；
  - 平台版本恢复 = 保存历史平台版本内容（现有平台版本保存语义）+ 对应绑定；
  - 绑定被软归档后可通过新保存动作重新引用同一 asset（无需恢复归档行，避免复活已移除语义）。
- 任何移除/替换/恢复都走命令事务 + 回执，AI 不能硬删绑定或 asset。

## 17. 事务、幂等、并发

- **同事务**：Source 冻结（绑定 + revision 落库）、核心保存（版本 + ContentMediaBinding + 对账）、平台保存（版本 + PlatformMediaBinding + asset_ids_json 投影 + 裁剪物化）、发布快照创建，全部沿用现有“事务内全成功或零写”。
- **幂等**：
  - 下载：同一 `(sourceRevisionId, originalUrl, sha256)` 重放返回现有 asset，不重复导入；
  - 绑定写入：以父保存的 requestId 幂等，同 requestId 不同输入拒绝；
  - 视觉 run：现有三元组 + schemaVersion 幂等；`requestId = visual_source:<runId>` 编译幂等；
  - 快照：现有 inputHash 幂等。
- **并发**：
  - 平台版本编辑沿用乐观锁（`expectedRevision`），冲突返回当前对象与冲突清单（现有 `REVISION_CONFLICT` / `CONFIRMATION_STALE`）；
  - 绑定与投影同事务更新，避免 UI 读到不一致顺序；
  - 下载与视觉入队可并行，但同 revision 的冻结批次有界（§20）。

## 18. 权限

- 写入继续以 Capability 注册表、Task/Page Grant、dispatcher 和命令回执为授权真源。新增命令在实现阶段注册（本设计只定义语义）：
  - `source.image.freeze`：Source 图文冻结（user / background_agent）；
  - `source.image.observe`：视觉运行入队/重试/转知识（user / pi / background_agent，模型成本受限额约束）；
  - `studio.media_binding.save`：核心/平台绑定保存（user / pi）；
  - `platform.crop.apply`：裁剪物化（user；pi 提案需用户确认）；
  - 发布命令边界不变：`publication.editor_prepare_execute` 精确人工确认，最终 publish 点击永不自动；小红书发布继续拒绝。
- 创建者性质（`user` / `pi` / `background_agent` / `system`）与写权分离；AI 产物标 AI 创建，不得冒充用户操作。
- 用户自由记录与图注草案是高优先级输入，AI 起草的图注/观察需经确认或明确标记后才能进入发布载荷。

## 19. 安全与内容风险

- **远程下载**：仅 http/https；超时（现有 20s）；MIME 校验（现有）；大小上限（默认 20MB）；对私有网段/回环地址不做主动抓取（解析 URL 主机后拒绝明显内网地址）。
- **解压炸弹/超大尺寸**：导入时解析宽高（`assets.width/height`），超上限（默认长边 ≤ 16384px）拒绝；图片格式白名单 png/jpeg/webp/gif；SVG 因脚本风险不进入发布载荷（可作为来源浏览，发布时拒绝）。
- **内容风险**：
  - 视觉观察结论默认 `unverified` / `inference`，不标 `supported`（现有证据状态机）；disputed/inference 内容进入创作上下文时携带醒目标记（现有契约）；
  - AI 起草图注不得自动进入发布载荷（§8.6）；
  - AI 生成图显式标记，不冒充来源证据；
  - 来源图候选不自动插稿，避免素材误用。
- **发布侧**：确认失效语义覆盖素材顺序/字节变化（现有）；失败保留错误，不伪装成功。

## 20. 成本与限额

- **视觉运行**（模型成本主项）：
  - 每 Source revision 入队图片上限（默认 12 张，超出提示用户选择）；
  - 单 run 重试上限（默认 3 次 attempt）；失败保留错误，不无限重试；
  - 后台批处理有界、断点可恢复（对齐现有 knowledge-backfill 模式）；用户手动触发优先；
  - 每次运行记录 model/provider/promptVersion（现有字段），成本可审计。
- **下载**：单图大小上限（20MB）；单 revision 冻结图片数上限（与视觉上限一致）。
- **裁剪派生**：新 asset 计入现有 assets 目录用量（设置页 usage 已统计 assets）；重复裁剪去重（sha256）。
- **存储**：绑定是轻量关系行，字节只有一份（sha 去重）；软归档不复制字节。

## 21. 现有页面原位改造

只改造现有页面，不新增顶层图片产品页（对齐知识契约 §29 的投影约束）：

1. **创作页核心内容页签** `[待实现]`：核心编辑器新增图集编排区（插入/排序/图注/删除），绑定为权威；正文 `wmb-asset://` 投影继续可编辑。
2. **创作页平台页签** `[待实现]`：现有素材列表升级为 PlatformMediaBinding 编排（排序拖拽、封面标记、裁剪入口、平台图注、基于核心版本的漂移提示）；保存沿用现有 `content.save_version` 通道（扩展绑定参数）。
3. **创作页右侧“媒体素材”页签** `[待实现]`：增加候选区（来源图候选 + 观察结论摘要 + AI 生成/派生裁剪徽标 + 来源与 revision + “查看原图区域”）；保留已用素材列表（现有）。
4. **发布页** `[待实现]`：预览栏显示平台图集（封面/顺序/裁剪态/文件可用）；确认清单“媒体素材”显示数量与封面；其余三栏结构与人工确认边界不变。
5. **资料库 Source 详情** `[待实现]`：展示图文冻结（SourceMediaBinding 缩略图条）、视觉运行状态（queued/running/completed/failed）、观察结论入口。
6. **Topic Wiki / 知识卡片** `[待实现]`：证据项“查看原图区域” → locator v2 解析 → 打开 sourceRevision + asset + region 高亮。
7. **Pi 上下文**：创作页向 Pi 提供候选图集（asset 引用 + 观察摘要 + 来源 revision），Pi 可建议配图但不得绕过保存动作。

## 22. 状态、空态、错误态

- **冻结**：`download_pending` / `downloaded` / `download_failed` / `archived`；空态“该资料暂无图片”（不显示占位图）。
- **视觉运行**：`queued` / `running` / `completed` / `failed`（现有枚举）；媒体素材与 Source 详情如实展示状态 chip；failed 显示错误码与重试入口。
- **媒体素材页签**：无关联 Source → “关联资料中的图片会自动出现在这里”；有 Source 无图片 → “该资料暂无图片”；有候选 → 候选 + 已用分区。
- **核心/平台图集**：无图 → 空态引导（“从媒体素材选择图片”）；保存对账失败 → 整体失败提示（不回滚正文之外的数据）。
- **发布页**：`需要补充图片` 状态（现有队列页签）；素材缺失/文件不可用 → 确认清单明确标红并禁止确认；确认失效 → 现有提示。
- **回看原图区域**：locator 解析失败或 asset 已不存在 → 明确提示“原图已不可用”（不猜测跳转）。

## 23. 迁移兼容

- 新增对象通过既有迁移流追加（版本号 ≥ 62；不重写历史 migration）。
- **存量数据回填**：
  - `platform_versions.asset_ids_json` → 回填 PlatformMediaBinding（ordinal = 数组下标；X 首图 `isCover = true`；caption 为空；revision 从平台版本复制）；
  - `content_versions` 正文中的 `wmb-asset://` 引用 → 回填 ContentMediaBinding（按出现顺序，ordinal 从 0 起；回填来源标记 `migration`）；
  - 存量 `knowledge_visual_runs` 不受影响（schemaVersion 1 保持可读）。
- **投影保留**：`asset_ids_json` 继续作为发布管线投影，绑定与投影同事务更新，现有 `publication-commands.ts` / `publication-operations.ts` / `publishing.ts` 无需修改。
- **locator 向后兼容**：v2 解析器对两段 locator 保持现有行为与测试结果不变；旧 EvidenceLink 照常显示为整图观察。
- **data-root 隔离**：新表沿用 workspace 边界与现有授权；不跨 workspace 复制对象。
- **无硬删除**：回填与后续操作都不删除既有行；软归档只写状态。

## 24. 贯穿式样例：AgentForge 图文资料

以“AgentForge 图文资料”为例走查完整闭环（对象 ID 为示意）：

1. **采集与图文冻结**：用户在 X 采集到 AgentForge 产品图文帖，保存为 Source `s-agentforge`（正文 revision `rev-r5`）。冻结流程解析出 6 张原图 URL（顺序与帖子媒体数组一致），逐张下载：
   - 6 张全部下载成功，sha256 去重后得到 assets `a1`…`a6`（`origin = source-visual:s-agentforge`）；
   - `SourceMediaBinding` 6 行：`(rev-r5, a1, ordinal 0, caption "AgentForge 控制台概览", originalUrl https://…/1.png)` … `(rev-r5, a6, ordinal 5, …)`；
   - 下载失败的语义不在此例出现，单独由验收场景 3 覆盖。
2. **视觉理解与知识证据**：用户/后台对其中 3 张图（`a1`、`a3`、`a5`）入队视觉运行（schemaVersion 2）：
   - run `vr-1`（`a1`）completed：observation 2 项——claim“AgentForge 控制台展示 Agent 运行节点与状态”（region 0.05,0.1,0.9,0.5）、insight“可视化节点即工作流拓扑”（整图）；
   - run `vr-2`（`a3`）completed：1 项 claim“定价页展示按用量计费”（region 0.1,0.6,0.8,0.3）；
   - run `vr-3`（`a5`）completed：1 项 creative_pattern“截图叙事用三步流程条”（整图）；
   - 3 个 run 转知识候选 → `compileSourceKnowledge` 原子 ChangeSet：claim → `unverified`、insight/creative_pattern → `inference`、evidenceLevel `single`、locator v2 例如 `asset:a1|sourceRevision:rev-r5|region:0.05,0.1,0.9,0.5`；生成 KnowledgeUpdateReceipt。
3. **创作候选**：用户进入内容项目（关联 `s-agentforge` 与 AI 赛道 Topic）。右侧“媒体素材”候选区出现 6 张来源图，其中 `a1`、`a3`、`a5` 带观察摘要；没有任何图被自动插入版本。
4. **核心图文版本 V3**：用户选 `a1`、`a3` 进入核心：保存核心 V3 时 `ContentMediaBinding` 2 行（`a1` ordinal 0 caption“AgentForge 控制台”，`a3` ordinal 1 caption“按用量计费”）；正文写入 `![…](wmb-asset://a1)`、`![…](wmb-asset://a3)` 投影，保存时对账一致。
5. **平台版本独立调整**：X 平台版本从核心 V3 派生：选 `a1` 为封面（ordinal 0，`isCover=true`），对 `a3` 应用裁剪（region 0.1,0.6,0.8,0.3）→ 物化派生 asset `a3c`（provenance `derived_crop` + `derivedFromAssetId=a3` + cropRegion）；PlatformMediaBinding 2 行（`a1` ordinal 0 cover，`a3c` ordinal 1）；`asset_ids_json = ["a1","a3c"]` 同事务更新。小红书平台版本独立：仅选 `a1` 为封面、图注覆盖“AgentForge 控制台一览”，顺序/封面与 X 不同——核心 V3 与 X 版本互不影响。
6. **发布快照冻结**：X 平台版本进入发布确认：预览显示 `@PigeonYang`、`X平台版本 2 · 基于核心版本 3`、封面 `a1`、素材 2 张全部 `文件可用`；用户勾选并确认 → `PublicationSnapshotV1` 冻结 payload + assets `[a1, a3c]`（含裁剪字节哈希）+ causation；X 适配器上传 `assets[0] = a1`；发布后进入结果复盘。
7. **结论回看原图区域**：AI 赛道 Topic Wiki 的“AgentForge 控制台展示 Agent 运行节点”知识卡证据项点击“查看原图区域”→ 解析 `asset:a1|sourceRevision:rev-r5|region:0.05,0.1,0.9,0.5` → 打开 Source `s-agentforge` 冻结 revision `rev-r5` 的 `a1` 并高亮该区域，用户核对观察准确后无需任何操作；若有误，用户批注纠正，经 ChangeSet 更新知识。

## 25. 可证伪验收场景

1. 保存含 6 张图的 X 图文 Source 后，`SourceMediaBinding` 恰好 6 行、ordinal 0–5、originalUrl 与帖子媒体顺序一致；`assets` 按 sha256 去重（同图重复保存复用同一 asset）。
2. 相同 Source 第二次保存（同 revision）幂等：不产生重复绑定、不重复下载；同 requestId 重放返回原结果。
3. 远程图片下载失败：binding `download_failed` + 错误码，无 asset、无占位图；重试成功后再试幂等；渲染端不出现热链（无绑定即无候选）。
4. 对 3 张图入队视觉运行（schemaVersion 2）：completed 后 observation 携带 region；claim → `unverified`、其余 → `inference`、`evidenceLevel = single`；EvidenceLink.locator 可解析回 sourceRevision + asset + region；编译 ChangeSet 零写重放不新增版本。
5. locator v2 解析：两段返回整图、三段返回 region、四段/非法值返回 null；现有两段 locator 的旧测试与旧数据行为不变。
6. 媒体素材页签展示来源图候选但未插入任何版本；保存核心版本前不出现新图；Pi 建议配图后不自动插入（无用户保存动作则版本不变）。
7. 核心 V3 保存：ContentMediaBinding 2 行；正文含 `wmb-asset://a1`、`wmb-asset://a3` 且对账一致；正文引用而绑定缺时自动追加到绑定末尾；绑定有而正文无引用时绑定保留。
8. 平台版本独立调整：X 绑定封面 = ordinal 0；裁剪 `a3` → 派生 asset `a3c`（provenance 链可回溯）；`asset_ids_json` 与绑定同事务更新；核心 V3 修改后 X 绑定不变且提示“基于核心版本 N”。
9. 发布快照：确认区显示素材数量/封面/文件可用；素材顺序或字节变化（含裁剪变更）使原确认失效（`CONFIRMATION_STALE`）；快照冻结的 assets 含裁剪字节且哈希可验。
10. 平台边界：小红书平台版本数据（顺序/封面/图注）可保存，但发布命令继续被拒绝；微信发布行为与现有一致（图片内嵌正文 HTML，适配器 assetIds=[]）。
11. “查看原图区域”：知识卡证据项打开对应 sourceRevision + asset 并高亮 region；asset 缺失时提示“原图已不可用”而非猜测跳转。
12. 权限与审计：绑定/裁剪/视觉命令均产生命令回执与创建者性质；AI 不能硬删绑定或 asset（软归档 + 原因）；最终发布点击仍为人工动作。
13. 迁移回填：存量 `asset_ids_json` 回填为 PlatformMediaBinding（X 首图 cover）；存量核心正文 `wmb-asset://` 回填为 ContentMediaBinding（标记 migration）；回填后发布管线可原样消费 `asset_ids_json` 投影。
14. 成本边界：单 revision 视觉入队上限、单 run 重试上限、单图下载大小上限按默认值生效，超限提示且不产生部分假完成。

## 26. 明确未决项

- **裁剪变换范围**：本期仅归一化矩形裁剪（x, y, w, h）；旋转、圆角、滤镜、九宫格等高级变换是否支持及如何物化，留待后续设计。
- **SVG 来源图**：SVG 可作为来源浏览与视觉观察，但被排除在发布载荷之外；是否允许 SVG 正式进入平台版本（经栅格化派生）未定，当前倾向否。
- **X 多图发布**：现有适配器只上传单图；多图发布属发布适配范围，是否扩展由后续发布设计决定，本设计仅保证绑定数据可承载多图顺序。
- **小红书图文载荷格式**：多图上限、封面语法与图注格式依赖平台适配验证，本设计只做数据先行，不承诺发布。
- 其余设计决策（裁剪物化时机、对账规则、候选排序、限额默认值）均已在本文件明确，无其他未决项。
