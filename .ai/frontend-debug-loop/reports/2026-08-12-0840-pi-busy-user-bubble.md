# WMB-5204 Pi 忙时用户气泡与信息层级

## 根因

Pi 已收到忙时人工输入，但 renderer 把同一条消息只当作“运输队列项”：`sendText` 不写会话也不做主时间线投影；native queue 确认后，`reconcilePiLocalQueue` 又删除本地项。结果是正文先只在 `Pi 队列`，被消费后暂时无处显示，直到 canonical session readback 才迟到成为用户气泡。

这是消息身份边界错误，不是 Pi 丢消息：真人意图被运输状态临时冒充。

## 修复后的层级

1. 真人输入：点击发送后立即进入主时间线用户气泡。
2. 运输状态：本地项只记录 `pending / accepted / failed` 与 `steer / followUp`；状态显示在该用户气泡下，不重复正文。
3. canonical 会话：真实用户 entry 到达后按文本、提交时间和 FIFO 接管本地气泡；重复文本逐条配对，恰好一次。
4. 系统事件与编排：继续使用独立 `system_event` / `orchestration` 行，不伪装成人类。
5. Pi 回复：thinking、tool、text 继续作为同一 assistant 回复中的有序 segments。

idle/failed 事件不再抢先清空本地气泡；只有 canonical 用户 entry 提供接管证据后才回收。

## 真实 Electron 证据

- 改前：A 运行时提交 B，用户气泡数仍 13、最后一条仍为 A；B 只在原生队列。Pi 消费并回复后，B 才成为第 14 条用户气泡。
- 改后中间态：B 立即成为最后一条用户气泡，`data-local-status=accepted`，状态“Pi 已接收 · 当前回复”；原生队列中同正文 0 条。
- 最终版本：终验前 16 条用户气泡；提交 A、再忙时提交 B 后为 18 条，最后一条立即是 B；native 重复正文 0 条，Vite overlay=false。
- canonical 终态：B 用户气泡恰好 1 条、无本地状态残留、队列 0 条；Pi 实际回复“B终验收到”。

## 自动验证

- `wmb-5189-immediate-feedback.test.mjs`：5/5 PASS；覆盖 delivery-aware FIFO、native 状态升级不删除、队列去重、canonical 两阶段接管、重复文本和 retry 锚点隔离。
- 聚焦 WMB-5152 + WMB-5180 + WMB-5189：27/27 PASS。
- `npm test`：898/898 PASS，0 fail。
- `npm run typecheck`：PASS。

主进程 Pi 协议、会话持久化、DB schema、Capability registry、依赖与发布边界均未改变。
