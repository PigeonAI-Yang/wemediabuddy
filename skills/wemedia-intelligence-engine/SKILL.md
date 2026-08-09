---
name: wemedia-intelligence-engine
description: 为 AI 自媒体快速发现外部信息，核对关键事实，形成自己的内容机会并写入 WeMediaBuddy。用户要求更新今日情报、寻找 AI 选题、扫描新产品/开源项目/Skill/MCP、核验热点或生成内容机会时使用。
---

# WeMedia Intelligence Engine

目标：尽快找到值得发布的信息，形成自己的判断和内容，服务「AI × 个人商业化成长」——公开用 AI 把自己做成能靠内容和产品活下去的人。不为流程而流程。

## 内容立场

我们不是无情的信息转发器。我们有侵略性、大胆，又克制：

- 主动寻找变化背后的冲突、机会和未来，不复述公告；
- 每个机会点明五维命中环（认知/技能/表达/获客/产品化）；
- 标题可以夸张，开头必须有爆点，观点要把远方的愿景拉近；
- 正文必须兑现标题：事实、数字、案例和收益不编造，预测明确是判断；
- 放大真实意义，不制造虚假事实；让人愿意点开，读完又承认没有被骗；
- 主菜是判断与创作，发布是夜灯；禁止自动发帖工具叙事。

## 导线优先（硬）

今日情报 **先官方导线，后主题增亮**：

1. **W0** enabled X List bindings（至少 **AI前沿** `list_id=2082851520417255750` @KimbomArtist）拉 timeline；
2. **W1** `source-index` 中全部 `primary + release` 官方源逐条打卡（DeepSeek / ByteDance Seed / 即梦等含在内）；
3. **W2** 再跑 Pi 主题/社区航线做解释与选题。

**Pi 不单独发现 A 类。** 有没有发版以 W0/W1 入库为准；主题 scout 不得跳过导线，也不得用“先扫两类”代替 A 类全量。

## 执行

0. **daily_intelligence 判断任务（最高优先级）**：以上方注入的「编辑简报」为全部判断上下文；发现与扫描已由渠道完成，不得探索文件系统、不得臆造工具名、**不得调用 `wmb_get_workbench`（全量工作台会挤爆上下文）**。只做四问判断（含五维命中 + 六栏目 structureGuidance）→ 用 `wmb_get_knowledge_context` 查同主题历史 → 用 `wmb_save_plan` 写回 → 结束。出现一次 Tool not found 立即停止臆造并回到简报。
1. 按 [采集 SOP](references/collection-sop.md)：A 类 must_check 全量；C 类可抽样。信源见 [信源索引](references/source-index.md)。
2. 按任务读取一个发现模块：
   - 外部发布、产品、项目和论文：[information-scout](subskills/information-scout/SKILL.md)
   - 社区讨论、趋势和用户问题：[community-demand-scout](subskills/community-demand-scout/SKILL.md)
3. 用 [evidence-organizer](subskills/evidence-organizer/SKILL.md) 合并重复事件。价格、政策、性能、商业数字等关键陈述回到原始来源；普通线索保留链接即可。
4. 用 [opportunity-editor](subskills/opportunity-editor/SKILL.md) 保留全部达到机会标准的去重结果，并按 `SSS → S → A → B → C → D → E → F` 排序。
5. 每条资料写入后先用 `wmb_get_knowledge_context` 查询同主题历史，再用 `wmb_record_knowledge` 归入稳定主题并记录核验/管理状态。
6. 按 [WMB 字段映射](references/wmb-field-map.md) 写入今日方案并读回一次；每个机会必须回填真实 `topicId`，没有相关历史复盘时不得引用无关复盘。

维护信源时读取 [source-registry](subskills/source-registry/SKILL.md)。不同站点的工具和读取方法保留在 `references/collectors/`，只读本次实际使用的文件；X List 路径见 [collectors/x.md](references/collectors/x.md)。

## 给用户的结果

直接给出：

- 今天全部达到标准的内容机会，按 `SSS → F` 递减排列；
- 每个机会为什么值得做、我们的强观点、标题爆点、开头钩子、原始来源和缺失素材；
- WMB 是否保存成功。

只有来源失败或证据缺口影响结论时才报告异常。不输出冗长运行日志，不创建定时器、爬虫平台、评分系统或自动发布流程。
