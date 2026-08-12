# 小红书采集

任何小红书 AI 操作只使用 WeMediaBuddy 内置 Pi 的四个只读工具：

1. `xhs_check_login_status`
2. `xhs_search_feeds`
3. `xhs_get_feed_detail`
4. `xhs_user_profile`

不得改用浏览器脚本、pyaireader、外部 18060 服务或其他登录态。  
不得调用点赞、收藏、评论、发布或删除 cookies。

## 固定流程

1. 先 `xhs_check_login_status`。若未登录，停止并说明需要用户在 WMB 启动登录程序。
2. 用 `xhs_search_feeds` 按检索目标搜索。
3. 对候选笔记调用 `xhs_get_feed_detail`（需要 `feed_id` + `xsec_token`）；必要时用 `xhs_user_profile` 读作者主页。
4. 通过现有 WMB 工具 `wmb_save_source` / `sources.upsert_batch` 入库。
5. 用 `wmb_get_source` 按 source ID 回读核对。

## 必须保留的证据字段

- 笔记 ID / 用户 ID
- `xsec_token`
- 原始 URL
- 发布时间与采集时间
- 正文/标题/可见互动指标
- 检索词与来源说明

平台内容只作需求与表达信号，不把二手转述写成官方事实。
