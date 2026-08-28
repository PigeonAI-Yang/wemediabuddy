# WMB-5363 全量测试真实性恢复证据

日期：2026-08-28

## 结论

- 冻结基线：2114 tests，2012 pass，102 fail（`.ai/wmb-5363-baseline.tap`）。
- 原失败文件全集回归：41 files，316/316 pass（`.ai/wmb-5363-original-failures-regression.tap`）。
- 最终全量 R2：2114/2114 pass，0 fail，0 skipped，0 todo（`.ai/wmb-5363-final-r2.tap`）。
- TypeScript：`npm run typecheck` PASS（`.ai/wmb-5363-typecheck.log`）。
- 未删除、未 skip 任何失败测试；过期断言均迁移到现行 SSOT 并保留等价行为覆盖。

## 根因与修复分类

### 生产回归

- 受管知乎默认 feed 写入绕过 dispatcher：将 feed 创建纳入正式业务命令事务，消除 `WMB_WRITE_REQUIRES_COMMAND_DISPATCH`。
- Writer `researchMode` 在 prompt、持久化和续派投影链丢失：贯通 `agent-runner`、Crew/UI redispatch 与 generic runner，并保留模型前置错误真相。
- 整份方案保存可接收 exact 知乎占位模板：`saveCurrentPlan` 与单项提交统一 fail-closed，返回 `validation_failed: exact_zhihu_fallback_template`。
- operator skill 缺少定向策划工具与流程：登记 `wmb_get_plan_item` / `wmb_submit_plan_item`，明确单项读取、单次提交到 `ready_for_review`，禁止整份覆盖。

### 现行合同下的 fixture / 断言漂移

- 评分 fixture 改为真实 Source/observation 证据，不再信任调用方自报旧六维字段；缺正文仍保持 pending/全 0。
- 方案 fixture 统一使用现行六维传播评分、真实不同 thesis，并显式经过 `ready_for_review → approved`；未批准场景保持 fail-closed。
- 发酵与持续关注测试以 Topic 为持久身份，plan-item carry 只承担来源/余波；保留去重、过期、恢复和 aftershock 覆盖。
- Studio 策划审批断言迁移到现行 `proposals-view.tsx` / `proposal-ledger.ts` SSOT；仍覆盖 draft/rejected 不生产、ready 待批、approved 推进、真实版本/任务和 44px ledger。
- EVAL-029 冷 fixture 从连续 schema 74 更新到 78；媒体 migration 62 hook fixture 只执行目标迁移，后续迁移由各自测试覆盖。
- 固定查询数因新增真实详情读模型由 12 更新为 15，1001 项规模仍保持 O(1)。
- knowledge backfill 的 `skipped_no_topic` 现会路由入队并计入 processed，checkpoint 断言更新为真实计数。
- orchestration 明确验证无 approved plan item 时不派 Reporter/Writer、不创建文章目标。
- canonical operator skill 更新后同步两个已安装 data-root 镜像与 SHA-256 revision，镜像 focused 12/12 PASS。

## 关键 focused 证据

- `planning-stage-studio`: 6/6
- `proposals-ledger`: 5/5
- `opportunity-pool`: 12/12
- `ferment`: 5/5
- `ferment-aftershock-no-topic`: 6/6
- `persistent-topic-fix-20260825`: 6/6
- `agent-runner`: 4/4
- `agent-tasks`: 6/6
- `eval-029-fixtures`: 9/9
- `wmb-5237-media-bindings`: 22/22
- `wmb-5241-ingest-query-chain`: 1/1
- `wmb-5337-orchestration`: 10/10
- operator mirrors: 12/12

## 最终命令

```text
npm test
tests 2114 | pass 2114 | fail 0 | skipped 0 | todo 0

npm run typecheck
tsc --noEmit
exit 0
```
