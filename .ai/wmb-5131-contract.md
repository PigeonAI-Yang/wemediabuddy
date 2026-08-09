# WMB-5131 Contract

## Route
Patch

## Goal
完成 Pi dock 依赖链的 Node ESM 相对导入收口，使直接测试导入不再触发 `ERR_MODULE_NOT_FOUND`。

## Acceptance
- [x] Main 边界相关相对导入使用 Node 可解析的 `.ts` 路径。
- [x] workspace import/profile/proposal 14/14 通过。
- [x] Electron adapter import smoke 3/3、typecheck 通过。

## Allowed paths
- `src/main/app-window.ts`, `src/main/ipc-pi-dock.ts`, `src/main/pi-config.ts`
- 直接覆盖导入边界的 `tests/*.test.mjs`
- `.ai/wmb-5131-contract.md`, `.ai/wmb-5130-5134-evidence.md`, `TASKS.md`

## Forbidden paths
- capability registry、数据库 schema、发布权限与 renderer 产品行为。

## Non-goals
- 不切换全仓 package module type；不做无关导入格式化。

## Capability and Skill impact
Capability registry: no change. Pi operator Skill: no change.

## Design / lock
- 最小 ESM 边界修复；直接导入与 Electron bundle 必须同时工作。

## Depends on
WMB-5122
