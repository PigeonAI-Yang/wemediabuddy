# WMB-5312 验收证据

## 交付

- 新增 migration 74：配图运行、单图项与生成来源记录；状态、失败、幂等 requestId、比例、替换前资产及正文版本均可重启读回。
- 启动时冻结正文、来源 ID/revision key 与 body hash；复用来源图片前要求已完成的视觉理解证据。
- 来源事实图优先；独立图片 Provider 只处理生成项，最多 6 张，支持 `1:1 / 4:3 / 3:4 / 16:9 / 9:16 / 21:9 / 9:21`。
- 成功结果通过现有 Asset、项目关联、正文版本与媒体 Binding 协议原子落库；失败保留旧正文与已成功项。
- Studio 提供显式「为当前定稿配图」、单图重试、比例及补充要求重新生成、原位替换和撤销；正式正文不写入“AI 生成”标签或水印。

## 关键实现

- `src/main/illustration-workflow.ts`
- `src/main/db/illustration-migrations.ts`
- `src/main/visual-source-lineage.ts`
- `src/shared/illustration-workflow.ts`
- `src/preload/preload.ts`
- `src/renderer/studio-view.tsx`
- `src/renderer/settings-view.tsx`
- `tests/illustration-workflow.test.mjs`
- `tests/e2e/studio.test.mjs`

## 最强验证

- `node --test tests/illustration-workflow.test.mjs` — PASS 4/4；覆盖来源图消费与固定快照、7 比例/最多 6 张/部分成功、重生原位替换与撤销、Provider 失败真相及 stale 正文冲突。
- `node tests/e2e/runner.mjs --file tests/e2e/studio.test.mjs --scenario WMB-5312-studio-illustration-workflow --keep-runtime` — PASS 1/1，14.571s。
- Electron 证据目录：`tests/e2e/.artifacts/WMB-5312-studio-illustration-workflow-kEhRUC`。
- 场景覆盖：来源图与生成图混合完成、正文新版本/Binding/Asset/生成来源 SQLite 读回、比例+要求重生、撤销恢复、无“AI 生成”正文标签、page error 0。
- `npm run typecheck` — PASS。
