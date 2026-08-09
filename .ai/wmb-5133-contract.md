# WMB-5133 Contract

## Route
Patch

## Goal
按当前产品真源收口残余 UI/runtime 合同，并根治 Today pool business-day readback、Pi 中断恢复与 operator Skill 工具清单缺口。

## Acceptance
- [x] 仅修正已被当前源码行为推翻的陈旧测试断言。
- [x] Today pool 以请求业务日末为投影时钟。
- [x] 普通 Pi read 保留 live streaming；runtime 启动前立即恢复崩溃遗留；canonical transcript 不回滚新用户回合。
- [x] packaged operator Skill 工具清单与注册表一致且不扩权。
- [x] UI/runtime 35/35+18/18、pool 12/12、Pi 18/18 通过；独立复审关闭全部 finding。

## Allowed paths
- `src/main/workbench.ts`, `src/main/pi-conversation.ts`, `src/main/index.ts`
- `skills/wemedia-buddy-operator/SKILL.md`
- 直接覆盖上述行为的 `tests/*.test.mjs`
- `.ai/wmb-5133-contract.md`, `.ai/wmb-5130-5134-evidence.md`, `TASKS.md`

## Forbidden paths
- capability registry、发布确认边界、数据库 schema、WMB-5135 Studio 样式范围。

## Non-goals
- 不以源码文本快照替代行为断言；不加入超时启发式恢复。

## Capability and Skill impact
Capability registry: no change. Pi operator Skill: updated，仅同步已注册工具清单。

## Design / lock
- 当前产品源码是陈旧测试的真源；真实 source defect 必须根因修复并由行为测试覆盖。

## Depends on
WMB-5122
