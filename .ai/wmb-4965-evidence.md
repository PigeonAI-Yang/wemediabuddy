# M-4960 / WMB-4961–4965 验收证据

日期：2026-08-07

## 代码

- `src/main/workspace-profiles.ts`：`official.ai` template v2；`buildOfficialTemplateProfile`；官方血统 re-ensure via `activateWorkspaceProfile`；running task 跳过升级
- `src/main/agent-runner.ts`：`dailyPrompt` 商业化五维/六栏目；gate 文案拧焦
- Skills：`wemedia-intelligence-engine`、`opportunity-editor`、`opportunity-standard`、`wemedia-buddy-operator`

## 文档

- `.ai/2026-08-07-ai-commercialization-recipe-impl.md`
- `.ai/commercialization-method-seeds.md`
- `.ai/wmb-4965-owner-ops-checklist.md`
- `docs/spark/2026-08-07-ai-personal-commercialization-wmb-plan.md`

## 测试

```text
node --test tests/workspace-profile-ensure-upgrade.test.mjs tests/editorial-brief.test.mjs tests/agent-runner.test.mjs tests/lane-gate-run.test.mjs
→ 18/18 pass
npm run typecheck → exit 0
```

## 身份块抽样（ensure 新根）

- displayName: `AI × 商业化成长`
- officialTemplateVersion: `2`
- audience 含 `内容→信任→付费`
- editorialBrief 含 `五维`

## Prompt 抽样

- 含 `五维`、`六栏目`、`为什么是现在`
- gate 段含商业化成长 / 躺赚毒鸡汤降权指引
