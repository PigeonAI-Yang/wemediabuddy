# WMB 写回契约

长期知识写回顺序：保存资料取得真实 `sourceId` → 用 `wmb_get_knowledge_context` 查询历史 → 用 `wmb_record_knowledge` 写入稳定的 `topic.canonicalKey`、`topic.title`、资料关系和核验/管理状态 → 将返回的 `topicId` 写入今日机会。相同主题不得按日期重复新建。

通过 WMB MCP 执行，不直接操作数据库。

## 资料

调用 `sources.upsert_batch` 保存：

- originalUrl、title、author、publishedAt、summary
- categories、keywords
- valueJudgment、ipRelevance、creationAngles
- recommendedPlatforms、recommendedFormats
- timeliness、priority、evidence、clientLabel

重复 URL 应增量更新且不得清空未提供的旧分析。写后通过 `sources.get/search` 或 `context.get_workbench` 核对 ID、URL和分析字段。

## 今日机会

调用 `plans.save`。每个条目引用已存在的 `sourceIds`，并保存 whyNow、audience、angle、pointOfView、平台、形式、工时、已有素材和缺失素材。

`priority` 用整数编码等级，不要写“优先级 1/2/3”给人看：

- `0` = SSS（仅突发特别重大事件，极少使用；金色扫光）
- `1` = S（金色扫光）
- `2` = A（红色）
- `3` = B（蓝色）
- `4` = C（绿色）
- `5` = D（灰蓝）
- `6` = E（灰色）
- `7` = F（低优先级灰色）

界面会显示为 `SSS级` / `S级` / `A级` / `B级` / `C级` / `D级` / `E级` / `F级`，并按此顺序递减排列。

## 当前实现门槛

若运行中的 WMB MCP 尚未暴露上述完整资料字段、资料查询或机会扩展字段，停止在写回步骤并报告具体缺口。不得把对话中的 JSON 描述成已经入库。
