# X 采集

## 账号时间线

调用 `pyaireader` Skill 并遵循其 X 登录态和真实平台读取规范。使用独立 pyaireader profile，按窄主题查询，打开 `source-index.json` 中启用的 X 账号或相关原帖。保存作者、链接、时间和核心观点；外部事实需要时再回原始来源。

## X List 绑定 → timeline（导线）

今日情报 **W0** 必须走绑定 List，不靠自由搜索：

1. `wmb_list_x_list_bindings` — 读取已接入 WMB 的 List；只处理 `enabled`。
2. 对每个 enabled binding：`wmb_read_x_list_timeline`（可先 cache，再 live；refresh 失败则用 cache 并标 stale）。
3. 每条 post 写入/去重到绑定的 `sourceFeedId`；作者为官号或正文含官方链接时升 A 候选。

### AI前沿（硬要求）

当绑定存在且 enabled 时 **必跑**：

| 字段 | 值 |
|---|---|
| account | `@KimbomArtist` |
| name | AI前沿 |
| list_id | `2082851520417255750` |

建议成员（DeepSeek / OpenAI / Anthropic / Google DeepMind / xAI / ByteDance Seed·即梦相关官号）见 `.ai/ai-frontier-list-members-suggested.json`；成员变更走现有 `members_add` 确认流，不在采集时静默改 List。
