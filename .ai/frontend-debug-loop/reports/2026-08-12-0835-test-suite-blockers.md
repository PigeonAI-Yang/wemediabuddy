# WMB-5203 全仓测试阻断修复

## 问题

- `wmb-5152-topic-approval-ui.test.mjs` 顶层读取已被清理的 `.ai/wmb-5152-ui-acceptance.mjs`，测试收集直接 `ENOENT`。
- `wmb-5180-orchestration-acceptance.test.mjs` 假设员工编排信封必在单行；Studio 改为多行、按 `writerTask` 选择两个 `safe` 分支后，§16-12/§16-13 被误判。

## 修复

- WMB-5152 直接约束生产 TSX/CSS：批准动作位于可见卡片头、摘要/明细层级、头部换行、小屏纵向布局及按钮宽度；不再依赖 `.ai` 临时脚本。
- WMB-5180 以 `dispatchId` 到信封调用结束的 bounded block 提取 `target`、`delivery` 和完整 safe 字面量；同时校验 Studio 小红书平台稿与核心稿两个分支。
- 仅修改两个测试文件；生产行为、Capability registry、DB schema、依赖和发布边界均未改变。

## 验证

- 聚焦：WMB-5152 + WMB-5180 + WMB-5189，共 27/27 PASS。
- 全仓：`npm test`，898/898 PASS，0 fail，359.34s。
- 类型：`npm run typecheck` PASS。
