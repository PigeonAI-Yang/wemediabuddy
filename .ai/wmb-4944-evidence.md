# WMB-4944 — 资料库「已移出」视图（原因徽标 + 恢复 + 7 日冷却 UX）

日期：2026-08-07 ｜ 任务：WMB-4944 ｜ 前置：WMB-4943（有效库管线，done）

设计：`.ai/2026-08-07-lane-relevance-gate-design.md` §6「已移出」视图 + §8.1 WMB-4944 + §9-C（主编覆写闭环）。

## 交付内容

### 1. 后端：归档列表携带最新判定原因（徽标数据源）

`src/main/knowledge.ts` — `listKnowledgeSources` 的 SELECT 追加 `source_lane_judgments` 最新一行
（追加型语义：按 `judged_at DESC, id DESC` 取首行），以 `json_object` 子查询返回
`laneJudgment: { decision, reasonCode, reason, judgedBy, judgedAt }`；JS 侧解析并移除内部
`laneJudgmentJson` 字段。无判定行的条目 `laneJudgment === null` → 渲染层显示「主编归档」；
AI/系统判定不相关的条目 → 「AI 判定不相关：{reason}」。`listWatchingSources`/计数查询不触碰
（watching 非 archived，无需徽标）。默认列表（有效库）排除 archived 的既有口径不受影响
（回归由 `knowledge-child.mjs` 与本次 fixture 覆盖）。

### 2. IPC / preload：主编恢复路径（owner UI）

- `src/main/ipc-knowledge-content.ts` — 新增 `knowledge:lane-restore` handler：
  `requireBusinessRuntime` → `readWorkspaceProfile` 派生 `workspaceLane`（当前配方
  `intelligencePackId`）→ `dispatchLaneRestore`（既有 `sources.lane_restore` 命令，CommandEnvelopeV1 +
  回执，WMB-4941 契约）→ `requireReceiptData` 返回 `{ source, judgment, restored }`。
  恢复成功由 `dispatchLaneRestore` 广播 `dataChanged`（scopes: sources/library/today）。
- `src/preload/preload.ts` — 暴露 `laneRestoreSource({ sourceId, expectedRevision, reason? })`。
- `src/renderer/global.d.ts` — 同步 `laneRestoreSource` 返回类型。

### 3. 渲染层：资料库「已移出」视图

`src/renderer/library-view-parts.ts` — `LibrarySection` 增 `'removed'`；`LibrarySourceItem` 增
`laneJudgment` 字段；`isLibrarySection` 同步。
`src/renderer/library-view.tsx`：

- 导航第三个页签「已移出」（`localStorage` 记忆沿用 `sectionStorageKey`）。
- `loadRemoved`：`listKnowledgeSources({ managementStatus: 'archived', limit: 100 })`；section 挂载 +
  `onDataChanged`（library/sources scope）自动刷新。
- 行内徽标：`AI 判定不相关：{reason}`（amber）/ `主编归档`（gray，无判定行或判定非 irrelevant）。
- 行内「恢复」按钮 → 确认面板（文案取自设计 §6）：「恢复后该资料回到有效资料库，7 天内不会再被自动判定」
  → 确认后 `laneRestoreSource({ sourceId, expectedRevision: source.revision })`；
  陈旧 revision 冲突（REVISION_CONFLICT）显示错误并刷新列表后可重试。
- 点击行仍可打开资料详情（既有 drawer）。

`src/renderer/styles-workflow-library.css` — `.removed-head/.removed-hint`、`.lane-badge.amber/.gray`、
`.lib-row-wrap`（行分隔保留）、`.lane-restore-confirm/.lane-restore-actions`。

### 4. 测试

新增 `tests/lane-gate-removed-view.test.mjs`（2/2）：

1. **列表徽标数据**：AI 判定不相关（`dispatchLaneGate` agent、lifestyle_noise + reason）→ archived
   列表可见且 `laneJudgment` 字段齐全（decision/reasonCode/reason/judgedBy/judgedAt）；主编手动归档
   （dispatcher fixture，无判定行）→ `laneJudgment === null`；默认列表不含两条归档项；未判定有效资料
   无 `laneJudgment` 噪音。
2. **恢复闭环 + 7 日冷却**：`dispatchLaneRestore` → 已移出列表不再包含、默认列表可见；
   `getLatestLaneJudgment` 为 `judgedBy=editor, decision=relevant, reasonCode=editor_override`；
   `shouldSkipJudgment` 恢复后 7 日内 true、期满 false（同 source_id 不重判，即使被渠道重采）。

## 验收对照（设计 §9-C + 任务 Acceptance）

| 验收项 | 结果 |
|---|---|
| archived + lane judgment 在「已移出」可见（带原因徽标） | ✅ fixture + 列表 join 读回 |
| 恢复 → active + editor 判定行 | ✅ `dispatchLaneRestore` 测试（restored=true、editor 行） |
| 7 日不重判为系统级（lane-gate `shouldSkipJudgment`，恢复写 editor 行后生效） | ✅ 4941 契约 + 本次测试双覆盖 |
| typecheck + focused tests | ✅ 见下 |

## 验证证据

- 新测试：`node --test --test-concurrency=1 tests/lane-gate-removed-view.test.mjs` → 2/2 pass。
- 聚焦回归：lane-gate-contract / lane-gate-run / knowledge / search-sources-effective-only /
  lane-gate-removed-view → 23/23 pass。
- 全套：`npm test` → 355/355 pass。
- `npm run typecheck` → pass（tsc --noEmit 零错误）。

## 非目标（遵守）

- 未做 4945 端到端验收（真实混合扫描一轮 + 徽标/恢复闭环实机）；本任务仅单元/fixture 级。
- 未新增 `management_status` 枚举（设计 §3.4：MVP 复用 archived + 徽标区分，完整版落 `filtered`）。
- 未改采集/四问/机会池/carry（§7 非目标原样）。

## 关联

- 数据契约/命令：WMB-4941（`sources.lane_gate` / `sources.lane_restore` + 7 日冷却 helper）。
- 编排：WMB-4942（Tier 0/1 归档写路径）。
- 有效库管线：WMB-4943（默认过滤 / searchSources / 今日口径）。
