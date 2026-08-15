# WMB 情报媒体资产化与创作调用链设计

- 日期：2026-08-14
- 状态：Owner 已确认目标与视频处理主路径；实施前正式设计规格
- 决策：Source 保存后异步归档有界原始媒体；视频采用“字幕/ASR + 镜头抽帧/OCR + 时间轴对齐”的确定性主路径，不默认把整段视频交给多模态模型
- 上位设计：[`2026-08-13-wmb-source-image-creation-publishing-chain-design.md`](./2026-08-13-wmb-source-image-creation-publishing-chain-design.md)
- 关联现状：WMB-5237、`src/main/assets.ts`、`src/main/visual-source-lineage.ts`、`content_media_bindings`、`platform_media_bindings`

本文件取代上位设计中尚未实现的 Source 图片冻结、生产视觉接线和媒体候选部分，并把范围扩展到视频。已经落地的 Studio 图片绑定、裁切、平台编译继续复用，不另建第二套系统。

## 1. 问题与目标

WMB 当前能把官网、X Lists 和研究任务中的文字保存为 Source、知识与创作上下文，但渠道媒体没有成为长期、可追溯、可供创作调用的本地资产：

1. 官网扫描只保存 URL、标题、摘要和提取文本，正文图片、视频和原始 HTML被丢弃。
2. X 已解析 `images`、`imageThumbs`、`videoPoster`、`videoUrl`，但正式写入 `source_items` 时仅保留文字和头像 URL；媒体 URL只暂存在会淘汰的 `x_list_timeline_cache`。
3. `visual-source-lineage.ts` 已能把远程图片保存为 Asset，但没有生产调用方；视频没有归档与理解管线。
4. 2026-08-14 真实主工作空间有 2,235 条 Source；X缓存含 157 个图片 URL、37 个视频 URL；渠道来源 Asset为0，`knowledge_visual_runs`为0。

目标不是备份附件，而是建立：

> 情报媒体发现 → 原始字节归档 → Source revision冻结 → 图片/视频理解 → 与观点匹配 → 非破坏派生 → 核心/平台版本绑定 → 人工确认发布

例如创作“DeepSeek-V4-Pro基准测试性能的后续影响”时，AI应能把原始Benchmark图匹配到成绩段落，把测试限制截图匹配到边界说明，把实测视频的准确时间段匹配到体验段落；没有直接证据时可以建议生成封面，但必须标为生成内容，不能冒充原始证据。

## 2. 成功标准

一条同时带图片和视频的真实渠道资料必须满足：

1. Source文字提交后，媒体候选不会因进程崩溃或X缓存淘汰而丢失。
2. 远程URL失效后，本地仍能逐字节读取已经归档的原图片和原视频。
3. 每个媒体可追溯到渠道、Source、固定revision、原URL、原顺序、采集时间和SHA-256。
4. 媒体失败不回滚文字Source，但状态、错误和不完整计数必须可见，不能产生假Asset。
5. 图片理解可回看原图区域；视频理解可回看固定时间段、字幕/ASR文本和关键帧。
6. AI能将媒体建议绑定到正文具体观点，说明用途、来源、变换与风险；允许明确“没有合适素材”。
7. 用户接受后才写入核心或平台版本；拒绝建议零版本写入。
8. 裁切、标注、关键帧和视频片段均创建派生Asset，原件不变且血缘可逆。
9. 平台版本只引用固定本地Asset；断网重启后仍可预览和继续创作。
10. AI不执行最终发布，现有人工最终发布边界不变。

## 3. 范围与非目标

### 3.1 本期包含

- 正式来源：官网、X Lists、Research/记者通过 `wmb_save_source` 保存的网页资料。
- 图片：PNG、JPEG、WebP、GIF；SVG只保存为受限来源Asset，不直接进入发布载荷。
- 视频：可直接取得字节并经文件签名确认的MP4/WebM。
- X图片、视频、poster和引用帖媒体；官网正文图、Open Graph图、直接视频；Research网页同类媒体。
- Source媒体冻结、持久归档任务、失败重试、图片理解、视频时间轴理解、Studio候选、非破坏派生、平台绑定、容量治理。

### 3.2 非目标

- 不新增顶级素材库，不复制 `assets` 身份；入口只放在资料库、Source详情和现有Studio。
- 不抓整站、无限评论附件或全部历史Source。
- 不破解DRM、加密流、登录墙、付费墙或平台访问控制；m3u8/blob/受保护流首版记为 `unsupported`。
- 不默认把整段视频交给多模态模型；仅当有界短片段经字幕/ASR、关键帧和OCR仍无法理解时，后续版本才可增加显式升级路径，本期不做。
- 不建设自由视频剪辑器；只物化用户接受的有界时间段Clip。
- 不自动插稿，不自动发布，不改变小红书专用MCP与人工发布边界。
- 不回填现有2,235条Source，也不把临时X缓存当迁移真源；从本设计实施后的新采集开始前向归档。

## 4. 原则与不变量

1. SQLite保存关系、状态、运行和血缘；`<dataRoot>/assets/<sha256>.<ext>`保存不可变字节。
2. 远程URL不是正式资产；只有下载、校验、哈希、Asset登记全部成功才是 `preserved`。
3. 原始Asset永不覆盖；所有变换创建派生Asset。
4. Source媒体集合绑定 `source:<sourceId>:r<revision>`，revision来自 `source_items.revision`，不是 `source_body_revisions` 外键。X Source没有正文revision也必须可冻结媒体。
5. Source、媒体候选和首个持久job在同一业务事务落库；下载与理解在提交后异步执行。
6. 文字优先可用；媒体失败不回滚文字，但Source不能显示为“媒体完整”。
7. 来源、派生、生成身份严格区分；生成和重绘永不作为原始证据。
8. AI建议可解释；用户可见保存动作是进入内容版本的唯一边界。
9. 所有下载、模型、ASR、OCR和抽帧有固定限制、版本身份和失败路径。
10. AI不硬删除原始媒体、不修改completed理解记录、不绕过人工发布。

## 5. 方案决定

- 只存URL：链接会失效，否决。
- 创作时按需下载：可能已失效且无法对完整素材集做选择，只保留为人工重试补充。
- **决定采用：Source保存时同步冻结候选，提交后异步归档全部有界媒体，再按价值理解和调用。**

## 6. 持久对象与身份

所有新迁移从版本64以后开始；历史迁移不修改。

### 6.1 `source_media_candidates`

一行表示某次Source revision发现的一个远程媒体槽位：

- `id`
- `source_id`
- `source_revision_key`: `source:<sourceId>:r<revision>`
- `kind`: `image | video | video_poster`
- `original_url`
- `stable_remote_identity`: `sha256(normalizedUrl)`；URL规范化只小写scheme/host、移除fragment，保留query原顺序
- `channel`: `x_lists | official_web | research`
- `post_kind`: `tweet | repost | quote | web | null`
- `parent_candidate_id`: 视频poster指向视频；引用帖媒体指向引用父候选
- `post_ordinal`、`ordinal_in_post`、`ordinal`
- `caption_hint`、`surrounding_text`
- `status`: `pending | downloading | preserved | failed | unsupported | needs_user | skipped_limit`
- `error_code`、`error_message`
- `attempt_count`、`max_attempts`（默认3）、`retry_after`
- `request_id`、`discovered_at`、`archived_at`

状态只属于Candidate和Attempt。`preserved`的定义是：同事务中已存在对应`source_media_bindings`行。失败Candidate不创建Binding。

### 6.2 `media_archive_attempts`

每次执行一行，旧失败不覆盖：

- `candidate_id`、`attempt`
- `status`: `running | succeeded | failed | needs_user | unsupported`
- `error_code`、`error_message`
- `started_at`、`finished_at`
- `runtime_name`、`runtime_version`、`parameter_hash`
- `UNIQUE(candidate_id, attempt)`

### 6.3 `source_media_bindings`

只表示已保存的本地媒体：

- `id`、`source_id`、`source_revision_key`、`candidate_id`
- `asset_id`、`kind`、`ordinal`
- `original_url`、`caption`
- `sha256`（绑定时快照）、`captured_at`
- `rights_status`: `unknown | likely_reusable | permission_required | restricted`
- `risk_flags_json`
- `created_at`、`created_by`、`archived_at`、`archived_reason`
- `UNIQUE(source_revision_key, asset_id)`
- `UNIQUE(source_revision_key, ordinal, kind)`，因此视频和poster可共享ordinal

`rights_status`默认 `unknown`。AI不能把它改成已授权；`restricted`不进入自动建议，用户强制采用需要显式确认并写operation evidence。

### 6.4 持久任务

复用现有 `jobs` 表，新增 `kind='media_archive'`，不建立第二套job系统：

- `dedupe_key = media:<sourceRevisionKey>:<candidateId>`
- payload仅含 `workspaceId/sourceId/sourceRevisionKey/candidateId`
- Candidate、初始Attempt和Job与Source保存同事务创建
- Worker乐观claim，`attempts+1`；全局下载并发3
- 启动恢复：孤儿 `downloading/running` 超过15分钟转 `DOWNLOAD_INTERRUPTED` 并按attempt上限重试
- 自动重试只处理临时 `failed`，指数退避；`unsupported/needs_user/skipped_limit`不自动重试
- M1只提供全局暂停：停止claim新job；不承诺按Source暂停

### 6.5 Asset provenance

迁移重建 `asset_provenance` 的kind约束，允许：

`imported | generated | derived_crop | derived_annotation | derived_keyframe | derived_clip | derived_transcode`

派生行必须有 `source_asset_id`、`derived_asset_id`和`transform_json`。视频变换：

- keyframe：`{timeMs,width,height}`
- clip：`{startMs,endMs,codec,copyOrTranscode}`
- transcode：`{codec,bitrate,container}`

## 7. 事务与渠道接入

### 7.1 通用事务边界

渠道业务命令在同一事务执行：

1. `upsertSource`；
2. 用返回的revision构造 `sourceRevisionKey`；
3. 写全部有界Candidate；
4. 写首个Attempt和`media_archive` Job；
5. 提交。

提交后只唤醒worker。这样即使进程立即崩溃，候选仍可从SQLite恢复，不依赖X缓存或重新抓网页。

### 7.2 X Lists

- `persistBoundXListTimeline`把当前已解析的原始顺序 `images/videoUrl/videoPoster` 带入Candidate，不能在 `upsertSource` 边界丢弃。
- 图片优先`orig`，失败退`medium`，`thumb`仅最终回退。
- 视频poster单独归档为 `video_poster`，`parent_candidate_id`指向视频。
- 引用帖媒体保留 `post_kind/parent_candidate_id`，Source排序为帖子顺序再媒体顺序，不能混进主帖媒体序列。

### 7.3 官网

官网读取必须在同次命令中保留“媒体发现快照”，只服务候选发现，不升级为第二内容真源：净化HTML最大1MiB，事务完成Candidate后即可按保留策略清理。

发现：正文`img/srcset`、`video/source/poster`、`og:image`、`og:video`。相对URL按最终规范URL解析。排除：data/blob、favicon、头像、广告位、已知tracking pixel、声明宽或高小于64px。Candidate按DOM顺序；OG图只在正文没有同URL时补入。

### 7.4 Research

`wmb_save_source`允许可选结构化 `mediaCandidates`，但服务端重新验证URL、scheme和限额，拒绝本地路径、`file:`和`wmb-asset:`。没有结构化候选时，统一发现任务重抓固定原URL；抓取失败不影响已保存Source。

## 8. 下载、安全、限制与状态分类

首版默认值是实施合同，集中为`MEDIA_LIMITS_DEFAULT`常量；设置页M4只读展示，不在M1提供任意调大：

- 图片20MiB/个；视频500MiB/个、30分钟/个
- 每Source revision最多20图、4视频、总计1GiB
- 下载并发3；连接/首字节30秒；重定向最多5跳；attempt最多3
- 图片理解最多12张/Source revision；视频理解最多4个/Source revision
- 单视频最多48关键帧、64 segment
- 用户物化Clip最长60秒；每平台版本每原视频最多3个Clip
- 无引用派生缓存保留30天

统一`fetchWithMediaGuard`逐跳执行：

1. 只允许HTTP/HTTPS；每次重定向重新解析主机和DNS；拒绝环回、私网、链路本地、DNS rebinding。
2. 先HEAD；有可信`Content-Length`且超限直接`needs_user`。HEAD 403/405或缺长度才进入流式GET。
3. GET写staging，边读边计数，越限立即中止并清理。
4. MIME由响应头和文件签名共同确认；扩展名不作权威。MP4检查`ftyp`，WebM检查EBML；图片检查对应magic bytes。
5. 视频下载完成后用固定ffprobe读取时长；超过30分钟则`needs_user`，清理staging，不登记Asset。
6. 校验完成后算SHA-256、原子注册Asset与Binding；同字节跨Source复用Asset，各Source保留独立Binding/Provenance。

状态分类：

- `unsupported`：m3u8/blob/DRM/受保护流、非允许格式；零下载或确定性终止。
- `failed`：超时、403、DNS、磁盘、临时运行错误；最多3次自动attempt。
- `needs_user`：字节/时长超限、需要登录授权、来源许可不清；不自动重试。
- `skipped_limit`：超出单Source数量/总量策略；不自动重试。
- `preserved`：Asset、Provenance、Binding同事务完成。

UI计数口径固定为当前revision Candidate总数与preserved数，例如“文字已保存，媒体3/5已保存”。

## 9. 图片理解

- 归档成功后，图片自动进入现有 `knowledge_visual_runs`，入队键为`sourceId/sourceRevisionKey/assetId/schemaVersion`，失败重试新attempt。
- 生产接通 `ensureSourceImageAsset` 的能力，但归档worker已下载的图片直接复用Asset，不二次下载。
- schemaVersion升级以支持区域：`region={x,y,width,height}`，均为0..1有限数，非法则整批fail-closed。
- 输出分类、OCR、图表结构、可观察结论、限制、适用观点；图表必须尽量抽取标题、坐标轴、图例、数值、比较对象和测试条件。
- 图片locator保持旧版兼容：整图 `asset|sourceRevision`，区域追加`region`。
- 每Source revision自动理解最多12张；其余显示“已保存，尚未理解”，用户可手动选择入队。

## 10. 视频理解的确定性主路径

### 10.1 架构决定

首版不把整段视频送给多模态模型。管线固定为：

```text
ffprobe媒体解析
  → 原生字幕优先 / 无字幕则ASR
  → 镜头检测 + 10秒间隔兜底抽帧
  → 必要时关键帧硬字幕OCR
  → 字幕、ASR、OCR、关键帧按毫秒时间轴对齐
  → AI只批量阅读有界Segment
  → 输出可核验关键帧和可引用时间段
```

### 10.2 固定运行时

- 媒体解析、字幕提取、镜头检测、抽帧、Clip：静态CPU版FFmpeg/ffprobe。
- ASR：`whisper.cpp` CPU运行时，multilingual small模型，段级时间戳，语言auto，不开word timestamps。
- 硬字幕OCR：Tesseract 5，`chi_sim + eng`，PSM 6。
- 三类二进制、模型和语言包由仓库内`media-runtime.lock.json`固定不可变下载URL、版本、SHA-256和许可证；`scripts/prepare-media-runtime.mjs`按lock准备到`.r/media-runtime/`。lock缺失或哈希不符时构建失败。
- 打包后门禁实际执行`ffprobe -version`、`whisper-cli --help`和`tesseract --version`；生产绝不回退用户PATH中的全局可执行文件。
- 首版只用CPU，避免CUDA DLL和驱动漂移。每次run记录runtime版本、模型SHA、参数哈希和promptVersion。

这里固定的是技术和供应链契约；具体发布号与SHA在WMB-5245开始前以lock文件一次性落地并成为机器SSOT，不能使用可变`latest` URL。

### 10.3 持久运行与阶段恢复

新增 `video_understanding_runs`：

- 身份：`source_id/source_revision_key/asset_id/schema_version/attempt`
- `status`: `queued | running | completed | failed`
- `stage`: `probe | transcript | keyframes | ocr | align | summarize`
- `probe_json`、`transcript_json`、`keyframes_json`、`segments_json`
- `model/provider/prompt_version/runtime_manifest_hash`
- 错误与时间字段
- 同身份+attempt唯一；completed行由DB触发器禁止更新

每个stage提交checkpoint。重试创建新attempt，但复用前一attempt中通过哈希校验的已完成stage输出，从失败stage继续；不重复下载或重复ASR。无音轨、无字幕不是失败，输出`transcriptSource='none'`。

### 10.4 Probe

ffprobe记录：容器、视频/音频/字幕轨、编码、时长、分辨率、帧率、旋转、章节。所有时间统一为整数毫秒，满足`0 ≤ start < end ≤ durationMs`。

### 10.5 文本获取优先级

1. **原生字幕优先**：枚举字幕轨；优先forced/default，其次匹配Source语言，最后第一条；记录轨index和language；提取WebVTT/SRT并规范为段。
2. **无可用字幕且有音轨时ASR**：whisper.cpp输出 `{startMs,endMs,text,source:'asr'}`。崩溃/OOM为`ASR_FAILED`，run失败并可新attempt重试。
3. **无字幕且无音轨，或ASR零段时OCR兜底**：在关键帧底部35%区域执行OCR；同时对检测为PPT/表格/标题卡的整帧做OCR。置信度低于60的行丢弃，连续相同文本按时间合并。
4. 三者均无内容：`transcriptSource='none'`，run继续，不伪造文本。

OCR引擎执行错误只产生warning并降级为none；运行时整体缺失是`MEDIA_RUNTIME_MISSING`并使视频run失败，图片链不受影响。

### 10.6 镜头与关键帧

- FFmpeg scene detection阈值0.4；小于2秒的相邻镜头合并。
- 任意10秒窗口没有镜头切换时，在10秒处增加兜底边界，保证长时间录屏/PPT可观察。
- 每个Segment起点后第一张稳定帧为代表帧；最大宽1280、保持比例、JPEG质量85。
- 相邻关键帧感知哈希相同则去重；不是比较JPEG字节。
- 全视频最多48张。超限时保留首尾、字幕/ASR含数字或专有名词的时间点、OCR文本变化点，其余按时间均匀下采样。
- 关键帧注册为`derived_keyframe` Asset，血缘记录`timeMs`。

### 10.7 时间轴对齐与Segment

确定性算法：

1. Segment初始边界为镜头边界、10秒兜底边界、字幕长空档边界的并集。
2. 小于2秒且没有独立文本/关键帧变化的段并入前段。
3. Transcript段按“最大时间重叠”归属；无重叠时按中点归属。
4. 同一Segment内保留原始Transcript段时间戳，不把文本改写成原话。
5. 无文本Segment保留关键帧并标`transcriptSource='none'`。
6. 超过64段时，优先合并连续静态、无文本变化的相邻段；不得丢失有数字、OCR变化或字幕变化的段。

Segment契约：

```text
index, startMs, endMs,
keyframeAssetId,
transcript[{startMs,endMs,text,source,confidence?}],
transcriptSource,
ocrRegions[],
summary,
quoteRange{startMs,endMs},
confidence,
warnings[]
```

AI摘要每个attempt最多调用一次，把最多64个有界Segment批量输入；每段摘要最多200字。摘要失败时保留Probe/Transcript/Keyframes/Segments并记录warning，run可完成为“结构化结果存在、摘要缺失”，不能抹掉机械处理结果。

### 10.8 视频证据locator

新增严格时间locator：

`asset:<assetId>|sourceRevision:<sourceRevisionKey>|timeRange:<startMs>-<endMs>`

必须满足`0 ≤ start < end ≤ probe.durationMs`。旧图片整图/region locator逐字兼容；非法格式返回null。Topic Wiki和Studio解析后打开本地视频并定位到startMs。

### 10.9 Clip物化

- AI只建议时间区间，不自动物化。
- 用户接受后才创建最长60秒的`derived_clip`。
- 优先无损容器copy；关键帧边界不允许准确copy时使用固定H.264/AAC参数转码并记录`derived_transcode`或clip transform。
- Clip范围、编码、运行时版本、源Asset全部入Provenance；原视频不修改。

## 11. 创作建议

生成正文或平台版本前：

1. 固定当前内容使用的Source/Knowledge版本。
2. 读取对应SourceMediaBinding与completed理解结果。
3. 将正文拆成可配媒体的观点/段落。
4. 对每个观点给0–N个建议；没有合适素材必须返回空。
5. 优先级：直接证据 > 演示/比较 > 背景 > 封面 > 装饰。
6. 每条建议必须含：固定Asset、目标段落/claim、用途、理由、建议图注、建议变换、来源与风险。
7. 未理解媒体可展示为候选，但AI不能声称其内容。
8. `restricted`不进入自动建议；`unknown`显示风险但可由用户决定。
9. 用户接受后才写Content/Platform Binding；拒绝、关闭或模型失败均零版本写。

DeepSeek例：Benchmark总表匹配“成绩领先”段；测试限制截图匹配“复现边界”段；03:18–03:46的实测Segment匹配“真实体验”段。若“竞争格局”没有直接证据，只能建议标为生成/重绘的封面或信息图。

## 12. Studio与版本绑定

不新增顶级入口。

### 12.1 Source详情

显示当前revision：图片/视频总数、已保存、处理中、失败、待人工、超限；每项显示缩略图/poster、顺序、大小、来源、状态、错误和重试。用户可查看原件、图片区域、视频时间段和血缘；默认不暴露Asset ID。

### 12.2 Studio

扩展现有媒体区域，展示来源图、原视频、关键帧和可引用Segment。建议显示目标段落、理由、图注、变换和风险。动作：接受、拒绝、替换、裁切、标注、截取。身份明确为原始/派生/生成。

视频不进入`wmb-asset://`图片token；作为结构化附件Binding。

### 12.3 Binding兼容

迁移扩展Content/Platform Binding：

- `media_kind`: `image | video | video_poster`，存量默认image
- Platform增加 `poster_asset_id`、`clip_range_json`、`duration_ms`
- asset_ids_json继续是Binding的发布投影，同事务重建

平台边界：

- X：数据层支持单视频Asset；只有在现有`prepareXVideo`路径契约通过聚焦回归后才进入准备载荷。
- 微信：首版视频仅预览/编排元数据，适配器仍不上传视频。
- 小红书：数据先行，不自动发布。

## 13. 权利、权限与删除

- Candidate保存发现来源；Binding保存`rights_status/risk_flags`。
- 风险类型：copyright、portrait、privacy、brand、paywalled、third_party_repost。
- `unknown`不等于可自由使用；`restricted`禁止AI自动建议，用户强制采用需显式确认。
- 新写命令纳入既有Capability/dispatcher：归档入队、归档重试、理解入队；AI不可获得硬删除Asset能力。
- 所有写入带requestId、workspace/data-root身份和operation evidence。
- 删除Source前读取其Asset被知识Evidence、内容/平台Binding、发布快照引用的清单；有引用则阻止普通删除并要求显式确认。删除Source关系不删除Asset字节。

## 14. 存储与清理

Asset被以下任一引用即不可清理：

- SourceMediaBinding
- ContentMediaBinding
- PlatformMediaBinding及derived/poster字段
- PublicationSnapshot assets
- AssetProvenance任一端
- Video run原视频、关键帧、Clip
- Knowledge Evidence locator解析出的assetId

M1只清理staging和失败临时文件。M4才启用引用感知GC：仅无任何引用、属于派生缓存且超过30天的Asset可自动清理；原始Source Asset、用户已采用派生Asset永不自动清理。设置页按原始/派生/staging和状态显示数量、字节与限制，不提供误导性的“一键清全部缓存”。

## 15. 分阶段实施

### WMB-5244：渠道媒体冻结

- 迁移Candidate/Attempt/Binding，扩展Provenance kind。
- X、官网、Research在Source事务内冻结候选与Job。
- 统一安全下载、限额、状态、重试和启动恢复。
- 图片和直接MP4/WebM进入Asset；Source详情显示完整度。
- 前向归档，不回填历史Source/X缓存。

验收：真实X与官网图文/视频在远程失效后仍可本地读取；旧revision不变；崩溃后候选不丢；失败无假Asset。

### WMB-5245：图片与视频理解

- 接通图片视觉生产调度及region locator。
- 落固定媒体运行时lock和打包门禁。
- 实现Probe → 原生字幕/ASR → 镜头抽帧 → OCR → 对齐 → Segment摘要。
- 阶段checkpoint、completed不可变和时间locator。

验收：字幕优先零ASR；无字幕有音轨走ASR；硬字幕走OCR；静态视频10秒兜底抽帧；失败从stage恢复不重复前序工作。

### WMB-5246：创作建议与Studio调用

- 按观点生成可审计媒体建议。
- Studio原位接受/拒绝；图片裁切/标注、视频Clip非破坏派生。
- 扩展Binding和平台数据投影。

验收：DeepSeek示例能正确匹配Benchmark图和实测Segment；拒绝零写；接受后血缘、图注、时间段完整。

### WMB-5247：容量、权利与最终验收

- 平台版本与快照冻结本地媒体。
- 引用感知GC、容量可见性、风险门。
- 同一真实工作空间跑完整E2E，断网重启验证。

## 16. 验收矩阵

必须覆盖：

1. X单图、多图、视频、poster、引用帖媒体父子关系与顺序。
2. 官网相对URL、srcset、OG图、正文图、直接视频、tracking pixel过滤。
3. Research结构化候选与无候选重抓；本地路径/内部Asset冒充被拒。
4. Source/Candidate/Job同事务；提交后崩溃、启动恢复和幂等。
5. 同URL同字节零重复；同URL内容变化新Asset；不同URL同字节复用Asset但保留独立血缘。
6. HEAD超限、流式越限、时长超限、错误MIME、SSRF、DNS rebinding、磁盘失败和三次重试。
7. m3u8/blob/DRM为unsupported；超Source策略为skipped_limit；需要登录/许可为needs_user。
8. 内嵌字幕优先且零ASR/OCR；多字幕轨选择规则可证。
9. 无字幕有音轨ASR；ASR失败新attempt，旧行不变。
10. 无字幕无音轨或ASR零段走OCR；低置信度全部丢弃时如实none。
11. 镜头阈值、2秒合并、静态10秒兜底、关键帧≤48、最大宽1280、感知哈希去重。
12. Segment对齐确定性、≤64、时间范围合法；摘要失败不丢机械结果。
13. 运行时缺失时应用可启动、图片链正常、视频run明确`MEDIA_RUNTIME_MISSING`且不回退PATH。
14. stage恢复不重复下载/ASR；completed行更新被DB拒绝。
15. 图片region和视频timeRange locator严格解析且旧locator兼容。
16. AI建议含来源、观点、用途、理由、变换与风险；无合适素材不伪造。
17. 用户接受/拒绝、revision并发冲突和失败零部分写。
18. 裁切、标注、关键帧、Clip不修改原件，Provenance可逆。
19. X/微信/小红书既有发布边界不回归，系统不自动发布。
20. GC完整引用集保护；无引用派生超30天可回收；原始Source媒体永不自动清理。
21. data-root/workspace隔离与断网重启后完整可用。

## 17. 最终产品场景

同一真实工作空间完成：

1. 从X采集含Benchmark图和实测视频的帖子，从官网采集含图表的文章。
2. Source事务内冻结Candidate；异步归档完成。
3. 冻结远程服务，仍能查看本地原图、原视频、顺序和来源。
4. 视频优先读取原生字幕；无字幕样本走ASR；硬字幕样本通过关键帧OCR补齐。
5. 打开图表区域和视频准确时间段核对理解。
6. 创建“DeepSeek-V4-Pro基准性能的后续影响”项目。
7. AI将基准图匹配成绩段、测试限制图匹配边界段、实测Segment匹配体验段；没有证据的观点不伪造。
8. 用户接受两项、拒绝一项，创建非破坏裁切和Clip，保存核心/平台版本。
9. 重启并断网，正文、图片、Clip、原视频、来源和派生血缘仍完整。
10. 验证没有自动发布，最终发布仍由用户完成。

十步全部通过，才认为情报媒体已成为AI可调用的自媒体生产资料。
