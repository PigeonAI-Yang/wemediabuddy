# 真实用户全功能漫游验收

Date: 2026-08-08  
App: Electron + CDP `9222`，数据根 `WeMediaBuddyData`

## 原则

不按测试条数交付。按**真窗口可点、可见终态**交付。

脚本：`.ai/user-walkthrough.mjs`  
产物：`.ai/walkthrough-out/`（截图 + `report.json`）

```text
node .ai/user-walkthrough.mjs
→ pagesTried 11, pagesOk 11, blockers 0
```

## 页面漫游（11/11 可进）

| 页 | 可见内容（摘录） | 截图 |
|---|---|---|
| 今日 | 机会卡、持续关注、资料流、命令条 | `nav-today.png` |
| 智能体 | 班组席位：主编席空闲，四员工待命，槽位 0/2 | `nav-agents.png` |
| 发现 | X Lists / 渠道 5/5 | `nav-discover.png` |
| 选题 | 台账 今日可批 6 等 | `nav-proposals.png` |
| 创作 | 15 个创作中项目列表 | `nav-studio.png` |
| 发布 | 公众号发布闭环任务可见 | `nav-publish.png` |
| 结果 | 周期发布/复盘统计可见 | `nav-results.png` |
| 主题 | 主题卡列表 | `nav-topic.png` |
| 资料库 | 观察中 30 条 | `nav-library.png` |
| 关系画布 | 画布工具条/列表 | `nav-canvas.png` |
| 设置 | AI 与模型等分区 | `nav-settings.png` |

## 漫游中发现并已修

1. **今日条误报「未完成/用户取消」**  
   已有 current 方案 + 8 机会时，仍被更晚的 `cancelled`/`partial` 任务盖住。  
   - `getLatestDailyIntelligenceTask`：成功优先于更晚取消  
   - `mapTaskToStep`：有已交付方案时 cancelled/failed → `done`  
   - 现场 UI 已变为：**「今日运营方案已就绪」**，主 CTA「去创作」

2. **模型 gate 脏 id 整轮失败**  
   `模型判定了不在本轮待判清单中的资料` 直接 fail-closed。  
   - 已改为：**忽略未知/重复 id**，只强制「待判清单不可漏」  
   - 构建产物已含 `accepted.push` 路径

3. **班组席位串位**（此前）  
   employee 不再冒充 desk snapshot；漫游时主编席显示空闲。

## 当前真机终态（交付时）

- UI 今日：**方案已就绪**，机会可见（DeepSeek API 涨价等），8 机会 / 15 进行中项目  
- 智能体：主编席空闲，员工待命  
- DB current plan：`2026-08-08`，summary 含成本结构/商单等，plan_items 仍在  
- 最近一次自动重判曾 `partial`（脏 id，旧进程）；**展示层已不再被它打成失败墙**

## 配套自动化（非交付主证据）

```text
node --test tests/agent-work-paths.test.mjs tests/today-run-view.test.mjs tests/lane-gate-run.test.mjs
→ 32/32 pass
```

## 仍不能吹的

- 没有对「发布到真实平台」「完整 Pi 长对话写稿」做无人值守商业闭环验收  
- 重新侦察若模型**漏判** pending，仍会 fail-closed（设计如此）  
- 漫游是 CDP 驱动真 Electron，不是人工手感 100% 替代

## 交付结论

**主工作台 11 页可进可看；今日主路径在「有方案」时显示正确；席位不串；脏 id 不再整轮杀死判断。**  
可以按「真实用户能用主功能」交付这一版；不是「宇宙无 bug」。
