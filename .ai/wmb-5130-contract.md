# WMB-5130 Contract

## Route
Patch

## Goal
关闭 2026-08-08 真实工作区与全量回归暴露的 X 观察重试、Pi 启动链、迁移夹具、读模型和 UI 合同问题，并完成 WMB-5130..5134 验收闭环。

## Acceptance
- [x] generation-safe X observation recovery；真实 stuck rows 已回收；定向生命周期测试通过。
- [x] Pi dock ESM 启动链可导入；workspace/profile 套件通过。
- [x] migration 50 fixtures 与冷库不变量通过。
- [x] stale UI contracts、Today pool readback、interrupted Pi turn、operator Skill 合同修复并通过定向测试。
- [x] `npm test` 552/552；`npm run typecheck` 通过。
- [x] Electron 当前源码实机 smoke、独立复审、证据与 ledger 收口。

## Allowed paths
- `src/main/x-observation-jobs.ts`, `src/main/x-observation-scheduler.ts`
- `src/main/app-window.ts`, `src/main/ipc-pi-dock.ts`, `src/main/pi-config.ts`, `src/main/pi-conversation.ts`, `src/main/workbench.ts`
- `src/preload/preload.ts`, `skills/wemedia-buddy-operator/SKILL.md`
- 直接覆盖上述行为的 `tests/*.test.mjs`
- `.ai/wmb-5130-contract.md`, `.ai/wmb-5130-5134-evidence.md`, `TASKS.md`

## Forbidden paths
- 发布权限、数据 schema、capability registry、人工发布边界。
- `src/renderer/studio-view.tsx` 及并行 WMB-5135 产物。

## Non-goals
- 不清空或重建真实 data root；只回收已证实无活跃执行者的卡死观察行。
- 不把测试改成源码文本快照；断言保持可观察语义。

## Capability and Skill impact
Capability registry: no change. Pi operator Skill: tool inventory 同步到注册表；不扩权。

## Depends on
WMB-5122

## Design / lock
- 根因修复优先；clean cutover；不新增 schema、命令、权限或依赖。
- Main 负责全量测试、真实 Electron smoke、独立复审、证据与 ledger 收口。
