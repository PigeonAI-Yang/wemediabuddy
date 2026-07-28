# 信源索引

机器可校验的完整清单位于 [source-index.json](source-index.json)。执行扫描时按 `enabled`、`domain`、`roles` 和 `trust_level` 选择来源。

## 分级

- `primary`：官方公告、官方文档、官方仓库、论文原文；可证明事实。
- `professional`：可信专业人士、研究者和深度媒体；用于解释和发现反例。
- `signal_only`：趋势榜、社区、搜索和评论；只能产生线索或需求信号。
- `first_party`：用户自己的实验、产品、评论和数据；用于形成独特角度，仍需保留原件。

## 当前核心池

- 官方模型与产品：OpenAI、Anthropic、Google/DeepMind、Microsoft、Meta、NVIDIA、Mistral、xAI、DeepSeek、Qwen、Moonshot。
- 开源与研究：GitHub Trending、Hugging Face Models/Spaces/Papers、arXiv、OpenReview。
- 新产品：Product Hunt、Hacker News Show HN。
- 社区与需求：X 专业人士白名单、Hacker News、Reddit LocalLLaMA、Google Trends、用户自己的评论和实践。

新增来源必须先由 `source-registry` 核对身份、原始 URL、角色和可信等级。
