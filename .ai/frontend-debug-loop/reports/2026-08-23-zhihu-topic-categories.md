# WMB-5342：知乎人工智能话题五分类接入

## 结果

已将知乎「人工智能」话题的五个官方分类接入发现页：

| 分类 | 官方路径 | 展示形态 |
| --- | --- | --- |
| 索引 | `/topic/19551275/index` | 本轮官方页面摘要 |
| 简介 | `/topic/19551275/intro` | 本轮官方页面摘要 |
| 讨论 | `/topic/19551275/hot` | 问题列表 |
| 精华 | `/topic/19551275/top-answers` | 问题列表 |
| 等待回答 | `/topic/19551275/unanswered` | 问题列表 |

分类 URL 由主进程 `ZHIHU_TOPIC_CATEGORY_MAP` 单点定义。讨论、精华、等待回答沿用 `zhihu_hot_observations`，读取时按 `evidence_url` 精确隔离；索引与简介不伪造数据库持久化，只显示本轮真实读取的官方摘要。

## 刷新与权限路径

发现页刷新不再重读本地缓存。调用链为：

`ZhihuHotView` → preload 窄接口 → `zhihu-hot:refresh-category` → installation-owned BrowserProfile → 官方分类 DOM → 既有 `dispatchZhihuHotScan` / `dispatchZhihuHotFailure` → `intelligence.zhihu_hot.scan` receipt。

没有新增 capability、grant、数据库迁移、依赖或发布路径。Daily 与 Settings 的默认知乎来源仍是讨论 `/hot`。

## 不抢鼠标合同

知乎读取显式调用 `startBrowser(profile, { mode: 'quiet' })`。该模式由既有 browser helper 使用 `windowsHide`、最小化、屏外位置与 `WS_EX_NOACTIVATE`；分类读取只创建后台 CDP page、`goto` 并读取 DOM。实现不调用 `bringToFront`、mouse、keyboard、click 或 type。登录失效、安全验证和页面结构漂移只返回 needs_user/failed，不接管用户输入。

## UI 行为

- 知乎入口内部提供「索引、简介、讨论、精华、等待回答」五个 tab；
- 默认显示讨论，保留既有落库数据；
- 刷新期间显示「正在刷新…」并禁用刷新按钮；
- 结束后显示 succeeded、needs_user 或 failed；
- 列表分类提供问题标题、摘要、热度、采集时间和知乎原文；
- 摘要分类明确提示内容只在当前会话展示；
- CSS 仅使用 foundation token，无新增颜色字面量。

## 修改范围

- `src/main/zhihu-hot-channel.ts`
- `src/main/ipc-intelligence-channels.ts`
- `src/preload/preload.ts`
- `src/renderer/global.d.ts`
- `src/renderer/zhihu-hot-view.tsx`
- `src/renderer/styles-workflow-library.css`
- `tests/wmb-5331-zhihu-hot.test.mjs`
- `tests/discover-settings-boundary.test.mjs`
- `TASKS.md`

## 验证证据

1. `node --test tests/wmb-5331-zhihu-hot.test.mjs tests/discover-settings-boundary.test.mjs`
   - 15 pass / 0 fail；覆盖五分类固定映射、canonical 去重、按 evidence URL 精确隔离、后台-only 读取与既有 receipt 刷新路径。
2. `node --test tests/design-tokens-drift.test.mjs`
   - 3 pass / 0 fail；页面 CSS 颜色字面量门禁通过。
3. `npm run package`
   - Electron Forge 主进程、preload、renderer 全部构建成功；postPackage skills mirror 与媒体运行时门禁通过；最终产物：`J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`。

## 登录态门槛根因与最终验收

Owner 已登录是事实。此前失败由 `zhihuHotReadiness` 错误要求 `expectedAccountSnapshot.zhihu` 持久化标记造成；该标记陈旧或缺失时，即使真实 BrowserProfile 已登录也会被提前挡成 `ZHIHU_HOT_NEEDS_USER`。现已删除这层平台快照前置门槛：只要求当前 workspace 拥有 verified BrowserProfile，知乎登录真相改由真实页面导航后的 signin/challenge DOM 判断。

使用真实 `J:/PigeonYang/WeMediaBuddyData/wmb.db`、installation browser registry 和 quiet BrowserProfile 后台读取，未调用鼠标、键盘或前台激活。实测结果：索引成功（摘要 49 字符）、简介成功（摘要 1600 字符）、精华成功（16 条）、等待回答成功（20 条）。讨论首次暴露旧 `.ContentItem.AnswerItem` 选择器漂移；随后改为与其他列表分类相同的 main 内 canonical question-link 解析器，单独复测成功（5 条，官方 `/topic/19551275/hot`）。新增回归测试证明：BrowserProfile 已验证但没有陈旧 Zhihu snapshot 时，readiness 必须为 ready。聚焦测试 15/15 PASS；最终 Forge package/postPackage 通过。临时探针已删除。
