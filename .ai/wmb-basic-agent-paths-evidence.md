# 所有智能体基本工作路径验收

Date: 2026-08-07

## Owner 要求

不要只测子系统；基本工作路径必须覆盖并跑通。

## 命令

```text
node --test tests/basic-agent-paths.test.mjs tests/daily-handoff-orphan.test.mjs tests/worker-lease-wiring.test.mjs tests/job-12-integration.test.mjs
npm test
```

## 结果

| 套件 | 结果 |
|---|---|
| basic-agent-paths + handoff + lease + job-12 | 41/41 pass |
| 全量 `npm test` | **477/477 pass** |

## 覆盖的基本工作（目录）

| 块 | 内容 |
|---|---|
| A 今日扫判门闩 | 有协调器 reused；扫完 `channel_scanned` 无协调器 → judgeOnly；resume/full；判断中不双开 |
| A 孤儿 | `channel_scanned` 超时算孤儿；desk/employee 双 desk 抢占；后台必须 employee |
| C 任务生命周期 | 桌助 page.today；记者 daily_scan 取消；写手 studio.draft 失败；策划 results.review |
| D 工桌 | 四角色都能派；session 路径；cancel 释 lease |
| E 权限 | writer 不能 plans.save；reporter 只采集；desk 无 standing 零 |
| F 进度 | report_progress 真写入 |

## 为对齐扫判拆分做的测试修正（非业务回退）

- `daily_intelligence` → `daily_scan` / `daily_judge` 意图族
- `channel_scanned` 协调器路径改为 handoff 而非死 reuse
- EVAL-029 `schemaVersion` 46→49
- M-5001：裸高价值资料不再自动进持续关注台（测试跟产品）
- `website_sources` 标签列 `input_text`（修 `name` 列不存在）

## 结论

智能体基本工作路径现有硬门闩套件，绿的是主路径门闩与生命周期，不是「测了个子系统」。
全量 477 条同步绿。
