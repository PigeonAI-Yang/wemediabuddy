# WMB-5295 — Studio default external-research write gate

## Problem

Studio 的普通核心初稿首轮此前直接进入成稿提示；`evidence-grounded-writer` 只在模型自行判断资料不足时派研究。真实任务因此可能只凭标题、关联摘要和模型记忆保存完整正文，且没有 research 子工单或新增外部来源。

## Decision and implementation

- `src/main/agent-runner.ts`
  - 普通 `core_draft` 首轮改为研究前置：围绕项目对象、核心机制、关键事实/时效声明、现实案例、反证与限制构建 `requiredClaims`，必须调用 `wmb_dispatch_research`，随后立即停止。
  - 首轮 task context 写入 `researchGate: required`；研究续派或已批准专项调查资料包写入 `satisfied`；小红书平台版本为 `not_applicable`。
  - 研究前置轮的 orchestration goal/acceptance 改为“派出受控外部研究并停止当前写作 / 研究派单回执与父任务交接”，不再与正文保存目标冲突。
  - Pi 返回后若 research handoff 已将父任务置为 `partial`，直接返回该真实终态；若模型未成功派单，则以 `RESEARCH_DISPATCH_MISSING` 失败闭合，绝不进入 validating/complete。
  - 只有 `researchReady === true`（研究 successor 或 approved investigation package）才进入原核心写作流程；小红书平台版本保持原行为。
- `src/main/research-dispatch.ts` + `src/main/agent-task-commands.ts`
  - `research.dispatch` 成功后通过受控 task command 将当前父写手置为 `partial / research_dispatched`，并保存 `researchHandoff` 回执；同父 research 复用仍幂等。
  - 父任务不再可能在成功派单后继续被覆盖为 `succeeded`。
- `src/main/mcp-business-commands.ts`
  - 为 `content.save_version` 与 `content.import_image` 增加机器门禁：`researchGate: required` 的首轮 Studio writer 无法保存正文、平台版本或导入配图；返回 `RESEARCH_REQUIRED`。
- `src/renderer/studio-view.tsx` + `src/renderer/global.d.ts`
  - UI 能识别 `research_dispatched`，显示“已派外部研究，完成后将自动续写”；未派出时显示真实失败原因，不误报“初稿任务已完成”。

## Preserved contracts

- EvidencePack、Source SSOT、`linkPackageSourceIds()`、单跳原角色续派、研究预算、父角色白名单、同父唯一与三层止环均复用既有实现。
- 无 DB schema、依赖、权限、发布边界、UI 布局、CSS 或 foundation token 变更。
- 已批准项目专项调查资料包和 research successor 不会再次派研究；小红书平台版本仍只基于最新核心版本生成。

## Verification

2026-08-16:

```text
npm run typecheck
PASS

node --test tests/wmb-5292-evidence-gap-pi-tool.test.mjs tests/wmb-5173-research-successor.test.mjs
33 tests, 33 pass, 0 fail
```

Focused assertions cover:

1. 普通核心初稿 prompt 必须先 `wmb_dispatch_research`，且禁止联网、写作、配图和版本保存。
2. research-ready successor 与 approved investigation package 可写作且不会再次派研究。
3. first-pass task 的 `content.save_version` / `content.import_image` 机器门禁。
4. research dispatch 成功后父 writer 为 `partial / research_dispatched`，存在可审计 handoff 回执，不能再完成。
5. 既有 parent-role 白名单、三层止环、同父唯一、EvidencePack successor/recovery 全部回归通过。
