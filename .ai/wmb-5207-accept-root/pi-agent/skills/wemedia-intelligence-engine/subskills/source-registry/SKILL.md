---
name: wemedia-source-registry
description: 维护 WMB 资讯引擎的分级信源索引、来源角色、采集器路由和启停状态。由主资讯引擎在新增、复核或停用信源时调用。
---

# Source Registry

维护 `references/source-index.json`。

1. 打开来源主页确认名称、主体和 URL。
2. 把官方品牌标识保存到仓库 `images/source-logos/`；专业账号保存该账号头像。复用同一主体已有文件，不生成、重绘或改色。
3. 在来源记录的 `logo` 字段填写本地文件名。
4. 选择 `primary`、`professional`、`signal_only` 或 `first_party`。
5. 标注来源角色、领域和采集器。
6. 失效来源先设 `enabled:false`，不要删除历史身份。
7. 运行 `node scripts/validate_source_index.mjs`。

不得因为某来源热门就提高可信等级。
