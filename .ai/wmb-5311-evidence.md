# WMB-5311 验收证据

## 交付

- Pi 正在回复时，图片按钮与「插入当前回复」保持可用；纯停止态仍保留停止按钮。
- 忙时图片消息冻结原会话、项目、requestId、lane、正文、附件顺序与本地预览，不提前创建 Main 图片批次，也不启动第二个并发 Pi turn。
- 当前回复结束后，本地队列按序提交图片批次；真实失败继续保留文字和六张附件供重试。
- Composer 只清理本次已接受提交的附件，不覆盖提交期间新加入的草稿。

## 关键实现

- `src/renderer/pi-composer.tsx`
- `src/renderer/pi-dock.tsx`
- `src/renderer/pi-dock-utils.ts`
- `tests/e2e/studio.test.mjs`

## 最强验证

- `node tests/e2e/runner.mjs --file tests/e2e/studio.test.mjs --scenario WMB-5311-pi-busy-image-queue --keep-runtime` — PASS 1/1，14.499s。
- Electron 证据目录：`tests/e2e/.artifacts/WMB-5311-pi-busy-image-queue-kX4BVV`。
- 场景覆盖：活动回复期间先排入纯文字，再排入同序六图；`maxActiveResponses === 1`；前回合结束后图片批次才出现；Main IPC/SQLite 读回六附件顺序；分析失败后 Composer 仍保留六图。
- `npm run typecheck` — PASS。
