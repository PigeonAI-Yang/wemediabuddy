# WMB-5201 写手小红书平台版本路由修复

## Problem

主管已派给写手“生成小红书平台版本”，但员工运行时固定执行 `wmb_save_content`，将平台改写结果误存成新的核心正文版本。仅在 brief 中写任务类型也不能改变这条固定工作流。

## Root cause

- `wmb_spawn_job` 没有角色专用的结构化任务类型。
- 写手 prompt 只有核心初稿保存步骤，未提供 `wmb_save_platform_version` 路径。
- worker completion/readback 把任意写手终态统一判为 `CONTENT_VERSION`，无法证明目标平台版本实际落库。

## Repair

- `src/main/manager-tools.ts`：为 writer 工单新增 `writerTask=core_draft|xiaohongshu_platform_version`，并进入结构化 job input。
- `src/main/agent-runner.ts`：新增小红书平台版本专用 writer prompt；要求基于现有核心稿保存 `platform=xiaohongshu, format=note`，禁止新增核心正文版本。
- `src/main/agent-runner-prompts.ts`：员工 prompt 纳入工单 brief，避免派工约束丢失。
- `src/main/workspace-intelligence.ts`：按 expected deliverable 校验实际保存结果，返回 `XIAOHONGSHU_PLATFORM_VERSION` 与专用 readback；缺失交付物不得成功。
- `.pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts`：主管 MCP schema/description 暴露并要求 writerTask。
- 测试覆盖专用 prompt、参数传播、正确终态和错误交付物拒绝。

## Verification

- `node --test --test-concurrency=1 --experimental-strip-types tests/agents-roster-conflict.test.mjs tests/agent-runner-prompts.test.mjs tests/wmb-5142-instance-projection.test.mjs tests/job-event-envelope.test.mjs tests/wmb-5198-pi-final-sync.test.mjs`：141/141 PASS。
- `npm run typecheck`：PASS。
- 真实开发版 Electron/CDP：主管以独立参数 `writerTask=xiaohongshu_platform_version` 派写手工单 `95c9e9f2`；终态 `XIAOHONGSHU_PLATFORM_VERSION`，readback `kind=xiaohongshu_platform_version`。
- 创作页读回：目标项目显示 X 1 个版本、小红书 2 个版本；最新小红书 note 绑定核心第 7 版，标题为“做 AI 副业，第一步不是买会员❗先写一份小样，找 10 个人问 3 件事”。工单前后核心正文保持 revision 10，没有新增 v11。
- 首次以旧 worker 启动的真实诊断工单误存了核心 v10；它是修复前行为的留存证据，本次未执行破坏性删除。后续修复工单没有继续产生核心版本。

## Result

用户请求的写手小红书平台版本已真实生成并保存到 WMB；没有执行小红书外部发布，符合人工最终发布边界。
