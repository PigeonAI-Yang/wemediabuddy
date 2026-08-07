# 主题页：卡片网格 + 全页详情 + 单主题 Pi 出方案

Date: 2026-08-07  
Status: approved for spec review (not implemented)  
Owner lock: 2026-08-07 conversation

## 1. Problem

当前「主题」页是左侧主题名单 + 右侧工作台的 master-detail 侧栏模式。这与主题的真实语义不符，也和「先扫对象、再钻进去」的使用方式冲突。

## 2. Topic definition

**主题 = 值得长期跟踪的对象/议题**（例如 MCP 工具、某条基础设施 thesis），不是一次性选题卡。

主题档案应持续挂载：

- 相关资料与证据
- 判断 / 反证
- 过往机会、内容、发布与复盘回流

用途：将来某一天继续沿着同一对象往下穿，而不是每次从零找料。

## 3. Goals

1. 去掉主题页常驻左右分栏侧栏模式。
2. 首页用**主题卡网格**浏览/筛选长期对象。
3. 点卡进入**全页详情**，顶栏返回网格。
4. 详情内对**当前单主题**提供主 CTA：**让 Pi 出选题方案**。
5. 浏览主题与从主题生成方案两者并重，但不做多主题勾选。

## 4. Non-goals (this round)

- 多主题批量生成方案
- Pi 输出自动结构化写入 `plan_items` / 选题台账（可 P1）
- 领域地图 / 关系画布信息架构改版
- dossier / topic list API 或 schema 变更
- 在主题页内嵌第二套聊天 UI

## 5. Information architecture

Two states only:

| State | Role |
|---|---|
| Topic home | Search + status filters + responsive topic card grid |
| Topic detail (full page) | Single-topic dossier workspace with back affordance |

No persistent left topic list + right workbench.

### Navigation rules

- Click card → full-page detail for that topic.
- Detail header left control: `← 主题` → back to grid.
- Deep link `openTopic(id)` / `wmb-open-library-topic` → enter topic view and open detail.
- Back clears the selected detail and shows grid again (do not keep user trapped in last detail).
- Existing list memory (`libraryTopicId`) may still help deep link / restore entry, but **back means grid**.

## 6. Topic card (home)

Each card is the primary hit target.

| Element | Source / rule |
|---|---|
| Title | `title` |
| Status pill | active / watching / dormant labels already used |
| Summary | one line from `summary` if present; omit if empty |
| Counts | sources · opportunities · content (reuse list meta semantics) |
| Recency | derived from `lastSeenAt` / `firstSeenAt` (e.g. 最近 X 天前) |

Rules:

- Whole card is clickable.
- No overflow menus on the card in P0 (avoid competing with open-detail).
- Keep search, status filters, empty/error/retry, and load-more.

## 7. Topic detail (full page)

### Header

- Left: `← 主题`
- Center block: title, status pill, meta line (`资料/机会/内容/最近…`)
- Primary CTA: **让 Pi 出选题方案**
- Secondary: existing **去创作**
- Overflow/more: keep current advanced actions (canvas placement etc.) without dominating the header

### Body

Reuse existing dossier segments and data loading:

- 判断
- 证据
- 回流

Visual shell changes only; do not redesign the underlying dossier categories in P0.

If a sources rail currently depends on side-by-side list layout, re-home it inside the detail body (secondary panel / inline section). It must not reintroduce a topic-list sidebar.

## 8. Pi action protocol (single topic)

Trigger: detail header primary button **让 Pi 出选题方案**.

Behavior:

1. Ensure Pi dock is open.
2. Bind Pi page context to the current topic (existing `libraryTopicContext` / `objectType: 'topic'` path).
3. Send one fixed Chinese instruction into Pi, for example:

> 基于当前主题档案（判断、关键资料与回流），产出 1–3 条可执行选题方案：每条含标题方向、why now、时效、角度、目标读者、建议平台/体裁、还缺什么证据。不要空泛综述。

4. User continues refinement inside Pi dock.
5. If Pi is not configured: disable CTA or route user to existing settings/Pi setup messaging. Do not invent a parallel config surface.

P0 does **not** parse Pi output into plan items automatically.

## 9. Implementation approach

**Approach A — minimal shell rewrite (chosen)**

- Primary file: `src/renderer/library-topics-view.tsx`
- Styles: topic layout CSS (remove persistent `topic-list-pane` master-detail chrome; add card grid + full-page detail)
- Light touch: `src/renderer/main.tsx` only if needed to open Pi dock / ensure context plumbing for the CTA
- Keep existing topic list + dossier fetch, pagination, filters, keyboard intent where practical

Rejected for this round:

- B full rewrite of separate home/detail apps
- C dual-mode (grid + old sidebar advanced mode)

## 10. Edge cases

| Case | Behavior |
|---|---|
| No topics | existing empty copy |
| List failure | error + retry |
| Detail loading | loading state in detail shell |
| Missing summary | card omits summary line |
| Pi not configured | CTA blocked with existing setup guidance |
| Deep link to unknown/stale id | fail soft: stay/home grid + error or retry path already used by loader |
| Resize | grid 1–3 columns responsive |

## 11. Acceptance

1. Topic home is a **card grid**, not left-list / right-workbench.
2. Clicking a card opens a **full-page detail** with `← 主题` back to grid.
3. Detail still shows 判断 / 证据 / 回流 from existing dossier data.
4. **让 Pi 出选题方案** opens/focuses Pi, binds current topic context, and sends the fixed instruction.
5. `openTopic(id)` deep link still lands on that topic detail.
6. Search, status filters, and load-more still work on the grid.
7. No schema migration and no automatic write into 选题台账 in P0.

## 12. P1 candidates (out of scope now)

- Multi-select topics → one comparative brief
- Structured adopt path: Pi output → proposal ledger / plan_items
- Richer card signals (unread judgments, heat, pinned)
- Explicit “resume last topic” chip on grid after back

## 13. Spec self-review

- No TBD placeholders left for P0 behavior.
- Single-topic Pi path is explicit; multi-select excluded.
- Auto-write to ledger excluded to keep scope implementable.
- Shell-first approach reuses dossier APIs; no backend contract change required for P0.
