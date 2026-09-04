# WMB-5339 知乎 AI 专题来源纠偏证据

## Problem

每日知乎来源错误使用全站 `https://www.zhihu.com/hot`，泛娱乐、历史等问题会进入 observation、评分与 Today 目标。仅做关键词事后过滤会掩盖错误来源，不能保证来源语义。

## Decision

- 唯一来源 clean-cutover 到知乎官方 AI 话题热门页 `https://www.zhihu.com/topic/19551275/hot`。
- BrowserProfile、可见 DOM、公开页面和既有 receipt/needs_user/DOM_DRIFT 边界不变。
- 生产采集仅接受话题 `main[role="main"]` 内 `.ContentItem.AnswerItem` 的 `.ContentItem-title a[href*="/question/"]`；导航、推荐和作者链接被结构性排除。
- URL 规范化为官方 question canonical URL；重复问题按 canonical URL 去重。
- 用户当前 Today 中两个旧全站 `/hot` 目标通过 Owner UI `daily_content_target.replace` 正式命令替换为本次 AI 话题扫描候选；旧目标保留为 `skipped/replaced` 历史记录，没有删除业务事实或触发发布。

## Proof

1. 聚焦合同：`node --test tests/wmb-5331-zhihu-hot.test.mjs` → 10/10 PASS。覆盖官方 AI 话题 URL、真实 ContentItem DOM、非 AnswerItem/话题外卡片拒绝、canonical 去重、重复扫描幂等、独立 receipt 与 UI 名称。
2. 真实 BrowserProfile：Electron 重启加载新主进程后，Today「立即执行」完成；B 阶段显示 `观测 2 条`，C 阶段显示 `已配齐 2/2`。
3. SQLite 读回：最新 `zhihu_hot_observations`（`2026-08-22T12:07:07.672Z`）两条标题分别为“如何看待武汉大学杨景媛毕业论文被曝存多处错误，并疑似使用 AI？”与“为什么 Yann LeCun 对 ChatGPT 持否定态度？”，`evidence_url` 均为官方 AI 话题页。
4. Source registry 读回：`registry_id=zhihu_hot` 的名称为“知乎 AI 专题”，URL 为 `https://zhihu.com/topic/19551275/hot`。
5. 当前 Today 旧目标替换生成两条 `CommandReceiptV1`，命令均为 `daily_content_target.replace`，`ok=true`、`sideEffectState=committed`；新目标 source 分别指向上述两条 AI 话题候选。

## Scope held

未使用未公开 API；未新增关键词后过滤；未删除旧 observation；未自动发布；未改变 BrowserProfile 所有权、权限、数据库 schema 或品牌 token。
