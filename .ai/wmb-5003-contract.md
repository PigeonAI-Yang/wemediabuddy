# WMB-5003 Contract

## Route
Design

## Goal
FermentingRail 主题化 UI + 术语表 + 创建/打开路径：今日「持续关注」rail 的长期关注身份从 plan_item/source 行切换为 topic 行（PLAN.md M-5001 第 3 项）。

## Acceptance
- [x] FermentingRail 标题「持续关注 · 主题 · N」；行=主题；徽章「主题」；空态文案「主题」（证据 `.ai/wmb-5001-5004-evidence.md` §3）
- [x] `createFromCarry` 支持 `topic` → 创建 studio 项目并绑定 `topicId`
- [x] `TodayView` 接受 `openTopic`；main 接线
- [x] M-5001 门禁相关测试（`tests/ferment.test.mjs` / `ferment-aftershock-no-topic` / `today-desk-display` / `today-creation-actions`）16/16 + tsc exit 0 —— 证据记录（WMB-5004 交付），非本次复跑

## Allowed paths
- src/renderer/today-view-panels.tsx（FermentingRail）
- src/renderer/today-view.tsx（createFromCarry / openTopic 接线）
- src/renderer/main.tsx（openTopic 主接线）
- src/renderer/library-topics-view.tsx（主题视图）
- src/main/**（main 接线；证据未记录精确路径）
- tests/ferment.test.mjs
- tests/ferment-aftershock-no-topic.test.mjs
- tests/today-desk-display.test.mjs
- tests/today-creation-actions.test.mjs
- docs/spark/2026-08-07-continuous-attention-topic-progress-design.md
- PLAN.md

## Forbidden paths
- 平台发布与硬删路径（publication-*、browser 发布、物理删除）
- `work_carry_items` 决策层删除（proposals 台账依赖指纹态行）
- 机会池 / 主席重设计（M-4930 语义）
- Capability registry（`agent-capabilities.ts` / `page-authority.ts`）

## Non-goals
- 不重设计主席 / 机会池
- plan_item open/dismiss 保留在 proposals/carry 状态机——不是关注身份
- topic 归纳保持 LLM / 多日绑定 + 证据链接；无 regex 主判
- 不新增自由表单 merge agent

## Capability registry impact
no change — rail 投影/UI；无工具/grant 变更（证据 `.ai/wmb-5001-5004-evidence.md`）

## Depends on
WMB-5002（PLAN.md M-5001 顺序）

## Design / lock
- Design: `docs/spark/2026-08-07-continuous-attention-topic-progress-design.md`
- Owner lock（继承 M-5000，PLAN.md M-5001 记录 2026-08-07）：
  1. Rail 长期关注身份 = Topic only。
  2. 停止裸高价值源上桌。
  3. plan_item open/dismiss 留在 proposals/carry——非关注身份。
  4. topic 归纳保持 LLM/多日绑定 + 证据链接；无 regex 主判。
- Historical baseline note：本合约为追溯登记。证据文件声称 TASKS.md 已登记 WMB-5001..5004，但 TASKS.md / TASKS.archive.md / git 历史均无对应行；验收项以 `.ai/wmb-5001-5004-evidence.md` 记录为准，未复跑、不补造验收结果。
