# Pi 页面上下文能力排查 + 统一「点选焦点」清单

- 日期：2026-08-07
- 状态：排查结论 + 改造 backlog（未开工）
- 相关代码：`src/renderer/main.tsx`（`piContext`）、`src/renderer/pi-dock.tsx`（`buildPayload` / chip）、各 `*-view.tsx`
- Owner 产品意图（锁定）：

> **和今日页一样：在列表/卡片上点一下，就把该对象标成当前 Pi 上下文焦点；不必先「进入」详情页/编辑器。**  
> 进入详情可以是另一动作；**点选焦点 ≠ 导航进入。**

---

## 0. 机制一句话（现状）

```text
页面 UI 选中/聚焦
  → main.tsx 组装 PiContextRef
  → PiDock 发消息时拼 [WMB_CONTEXT]...[USER_MESSAGE]
  → Pi 只「自动吃到」这段里有的东西
  → 不够再靠 wmb_* 工具二次读取
```

- **设置页**：不挂 Pi dock（故意）。
- **不是**整页 DOM/截图自动塞给模型。
- Chip 文案 ≠ 真有厚上下文（可能只有 pageLabel）。

---

## 1. Owner 交互合同（改造必须遵守）

### 1.1 三种动作拆开

| 动作 | 用户手势（建议） | 结果 |
|---|---|---|
| **点选焦点** | 单击卡片空白/主区域 | 加入/切换 Pi 上下文焦点；**不跳转** |
| **进入** | 双击 / 明确按钮「打开」 | 导航到详情/编辑器 |
| **清空焦点** | 点页面空白（今日已有）/ Chip 清除 | 去掉选中，只留页级上下文 |

### 1.2 焦点模式（建议统一，避免每页一套）

| 模式 | 适用 | 行为 |
|---|---|---|
| **单焦点 `focus`** | 选题、发布、结果、主题列表、创作项目列表、资料库条目 | 同时最多 1 个主对象；再点另一个则替换；再点同一对象可取消 |
| **多选集合** | 今日机会/资料、发现榜单、画布节点 | 可多选，有上限；主 object* 可用「第一个选中」 |
| **范围上下文** | 发现 X List 时间线 | 列表可见范围自动带上；点帖 = 帖级焦点 |

### 1.3 视觉与 Chip（全站一致）

- 卡片 `selected` / `focus` 描边或角标，文案可 hover：`点击加入 Pi 上下文` / `再次点击取消`
- Pi 顶栏 Chip：`{页名} · {对象短标题}` 或 `已选 N 项`
- 未选中：Chip = 仅页名（诚实，不装有内容）

### 1.4 载荷诚实规则

- 摘要默认可以进 context；**全文/正文**仅在已加载或明确「附带正文」后进入（今日资料已有 bodyStatus 模式，应复用）。
- 禁止把「打开过列表」伪装成「已把全部列表塞给 Pi」。

---

## 2. 分页现状矩阵

图例：

- **点选焦点**：能否不进入详情就指定 Pi 对象  
- **载荷厚度**：自动塞进 `[WMB_CONTEXT]` 的丰富度  
- **缺口**：相对 Owner 合同差什么  

| 页面 | 点选焦点 | 进入 vs 点选分离 | 自动进 Pi 的内容 | 载荷厚度 | 现状结论 | 主要缺口 |
|---|---|---|---|---|---|---|
| **今日** | 有（机会多选 + 资料多选，有上限） | **是**（点选不导航） | selectedItems 字段、selectedSources 摘要/正文摘录、fermenting 截断 | 中～强 | **标杆** | 发酵是否可点选单条仍弱；清空靠点空白 |
| **发现 · X Lists** | 有（帖级）；列表范围自动 | 点帖聚焦，不必然进外站 | list 元数据 + visiblePosts + selectedPost | 强（可见范围） | 达标偏强 | 未加载更早帖不可假装有；与「单焦点」文案对齐 |
| **发现 · 榜单** | 有（点项目/榜单 toggle） | 是 | ranking boards/items | 中 | 基本达标 | 与单焦点规范统一文案/清空 |
| **选题** | **无**（`selected={false} onToggle={()=>{}}`） | 否；主题链是进入 | 仅 pageLabel | **几乎无** | **严重缺口** | 必须可点选 plan_item；载荷对齐机会字段 |
| **主题** | 弱（当前打开的 topic 自动当 context） | **否**：靠进入主题 | topic id/title + 可选 focus | 弱～中 | 半套 | 列表态点选主题、档案内点选子对象（资料/内容/复盘）不进入编辑 |
| **资料库** | 有（聚焦条 → pageFocus，可含正文） | 偏「聚焦=打开详情」耦合 | focus 对象 | 中 | 半套 | 明确「列表点选焦点」vs「打开详情」；列表行可选中不打开 drawer |
| **画布** | 有（当前页/多选节点） | 是 | preview manifest | **最强** | 达标 | 保持；规范文案与 Chip |
| **创作 · 列表** | 弱（选中项目常等于进入编辑） | **否** 倾向进入 | project id/title | 弱～中 | 半套 | 库列表单击 = Pi 焦点；双击/按钮 = 打开编辑 |
| **创作 · 编辑中** | 弱 | 已在内 | id/title + focus；**正文不保证**每次在 context | 中 | 半套 | 打开项目时自动 focus=当前版本文摘或明确「带正文给 Pi」 |
| **发布** | 弱（selectedId，偏工作选中） | 选中≈当前工作项 | publication id/标题/正文截断 | 弱 | 半套 | 单击列表项 = Pi 焦点；载荷加平台/状态/关联 projectId |
| **结果** | **几乎无**（代码默认找一个 published） | 否 | 一个默认 published 的浅元数据 | **弱** | **严重缺口** | 可点选发布结果；带指标摘要 + 是否已有复盘 |
| **设置** | 无 dock | — | — | — | 故意不支持 | 保持；不改 |

---

## 3. 载荷字段目标（按对象类型）

改造时 `buildPayload` / `PiContextRef` 应对齐，避免每页私货 JSON。

### 3.1 通用头（已有）

`page, pageLabel, objectType, objectId, objectTitle, contextRule, focus`

### 3.2 对象最小载荷（目标）

| objectType | 最小自动字段 | 可选加厚 |
|---|---|---|
| `plan_item` | id, title, whyNow, angle, pointOfView, title/opening/structureGuidance, sourceIds, priority, planDate | 关联 source 摘要 |
| `source` | id, title, url, summary, author, dates | bodyExcerpt if ready |
| `topic` | id, title | 最近机会/内容计数 |
| `project` | id, title, status | 最新 version 正文摘录、sourceIds |
| `publication` | id, platform, status, title, projectId | body 截断、account |
| `result` / published | publication 上 + metrics 最近快照摘要 | review keep/stop/change 若有 |
| `x_list` / `x_list_post` | 已有 xListContext | — |
| `ranking_item` | 已有 rankingContext | — |
| `canvas_nodes` | 已有 manifest | — |
| `fermenting_item` | id, title, state, sourceIds, aftershocks | — |

### 3.3 contextRule 文案（按模式）

- 单焦点：`focus 是用户点选的当前对象，未进入详情也可能只有摘要。`
- 多选：`selected* 为用户显式点选，不要假设未选中的列表项。`
- 范围：X List 现有 rule 保留。

---

## 4. 详细改造清单（可进台账）

> 建议里程碑名：**M-4970 Pi 页面点选焦点统一**  
> 原则：先合同与组件，再逐页接线；不打断 M-4950/业务主链时可并行。

### P0 — 合同与基础设施

| ID | 项 | 验收 |
|---|---|---|
| C0-1 | 写死交互合同（本文 §1）进 DESIGN/短文；Chip 文案表 | 设计评审通过 |
| C0-2 | 抽取共用 `usePiFocus` / `PiSelectable`（单击选、双击进、selected 样式、title） | 至少 1 页复用 |
| C0-3 | `PiContextRef` 扩展：`focusMode: 'none'\|'single'\|'multi'\|'scope'`；结果/选题专用字段不散落 | 类型编译过 |
| C0-4 | `buildPayload` 按 objectType 统一序列化 + 单测（无对象/单焦点/多选/画布） | 单测绿 |
| C0-5 | Chip 与清空：支持 clear focus；切页清空（已有 view effect，核对 multi 状态） | 切页无脏选中 |

### P0 — 严重缺口页

| ID | 页 | 项 | 验收 |
|---|---|---|---|
| P0-选题-1 | 选题 | 卡片单击 toggle **单焦点**（或与今日一致可多选，默认先单焦点）；`onToggle` 接到 main state | Chip 显示选题标题；发送 payload 含 plan_item 字段 |
| P0-选题-2 | 选题 | 「打开主题/创作」保持独立按钮，不占用单击焦点 | 单击不 navigate |
| P0-结果-1 | 结果 | 结果列表/卡片可点选；不要默默塞「任意一个 published」除非用户选或显式「当前」 | 未选中时 object 可空；选中后有 id |
| P0-结果-2 | 结果 | 载荷含 platform、status、最近 metrics 摘要、是否有 final review | payload 字段断言/手工 |
| P0-创作列表-1 | 创作 | 项目行：单击 = focus project；进入编辑 = 双击或「打开」 | 列表点选不进编辑器 |
| P0-创作编辑-1 | 创作 | 进入编辑后自动 focus=当前项目，并尽量带最新正文摘录（限长） | Chip 含标题；payload 有 excerpt 或明确 none |

### P1 — 半套补齐

| ID | 页 | 项 | 验收 |
|---|---|---|---|
| P1-发布-1 | 发布 | 列表单击 = Pi 焦点（可与工作 selectedId 合一，但语义写清） | 点选切换 Chip |
| P1-发布-2 | 发布 | 载荷加 platform/status/projectId/准备态 | 字段齐全 |
| P1-资料-1 | 资料库 | 列表行支持「仅焦点」：单击选中；打开详情另一控件 | 不打开详情也能讨论摘要 |
| P1-资料-2 | 资料库 | 详情打开时同步 focus，可附正文（沿用今日 body 模式） | 与今日 bodyStatus 一致 |
| P1-主题-1 | 主题 | 左侧主题列表单击 = focus topic，不必进入档案主区也可聊（若 IA 允许） | 列表点选生效 |
| P1-主题-2 | 主题 | 档案内：资料/内容/复盘条目可点选为 focus 子对象 | Chip 显示子对象 |
| P1-今日-1 | 今日 | 持续关注 rail 单条可点选进 focus/多选 | 可选中发酵项 |
| P1-发现-1 | 发现 | 榜单/X List 文案与清空手势对齐合同 | 体验一致 |

### P2 — 加厚与诚实

| ID | 项 | 验收 |
|---|---|---|
| P2-1 | 结果：一键「把评论/指标摘要给 Pi」（仍无全网抓评论前，只用已有 metrics） | 有按钮与 payload |
| P2-2 | 创作：显式「附带全文给 Pi」避免默默截断误解 | 用户可控 |
| P2-3 | 上下文预算：超长摘录截断 + 在 contextRule 声明 | 有 max chars |
| P2-4 | 设置页保持无 dock；若将来要诊断 Pi，另开，不混业务焦点 | 不回退 |

### 非目标（本清单不做）

- 整页截图 / DOM 送给模型  
- 设置页业务对话  
- 自动抓评论区/私信/弹幕（需求信号自动化的上游，另案）  
- 替换 MCP 工具读取（焦点是减少「瞎问」，不是禁止工具）

---

## 5. 建议实现顺序（干活用）

```text
1. C0 合同 + PiSelectable + buildPayload 单测
2. 选题点选 + 结果点选（体感缺口最大）
3. 创作列表单击焦点 / 编辑自动 focus+摘录
4. 发布 / 资料 / 主题 对齐
5. 今日发酵点选 + 文案统一
6. P2 加厚
```

### 建议台账草（未写入 TASKS，待 Owner 点头再挂）

| Task | 内容 |
|---|---|
| WMB-4970 | 冻结本文为设计 + 挂链 |
| WMB-4971 | C0 基础设施 + payload 单测 |
| WMB-4972 | 选题点选焦点 |
| WMB-4973 | 结果点选焦点 + metrics/review 浅载荷 |
| WMB-4974 | 创作列表/编辑 focus 分离与正文摘录 |
| WMB-4975 | 发布/资料/主题对齐点选合同 |
| WMB-4976 | 今日发酵点选 + 全站 Chip/清空/文案一致 + 验收 |

---

## 6. 验收总门（里程碑完成时）

1. **选题 / 结果 / 创作列表**：均可「只点选、不进入」把对象送进 Pi Chip。  
2. 发送一条「总结这个」时，Pi 用户消息前缀中能看到对应 id+关键字段（抓一条网络/日志或单测 buildPayload）。  
3. 今日既有多选行为不回退。  
4. 画布 / X List 既有能力不回退。  
5. 未选中时 Chip 不谎称已带具体对象。  
6. 设置仍无业务 Pi dock。

---

## 7. 和你原话的对齐确认

| 你的话 | 落点 |
|---|---|
| 要清单 | 本文 §2 矩阵 + §4 改造项 |
| 像今日一样点组件当上下文 | §1 合同；标杆=今日 Opportunity/feed |
| 而不是进入它 | 单击≠navigate；进入另手势 |
| 单选某个东西 | 默认 **单焦点**；今日/画布/榜单保留多选集合 |

若确认挂台账，下一步只做：**WMB-4970 写入 PLAN/TASKS**，然后从 4971/4972 开工。
