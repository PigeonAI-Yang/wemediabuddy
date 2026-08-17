purpose: Studio Pi dock 将拖入图片沿冻结提交快照送到 Main 的 Pi image-batch 路径；本轮确认“预览存在但普通 context message”断点，并修复失败批次清空 pending files。

fails-when: fresh Electron 中六张图片 drop 后立即 send 不能在 Main IPC 读到六个同序附件，仍没有选择 image-batch 分支，或 failed_analysis 后六张 pending files 消失。

Loop:
Symptom: Pi composer 图片队列可见，但发送后产生普通 context message，selectedItems 为空，Pi image-batch 没有被调用；失败批次还可能被误判为成功而清空队列。

Observation packet:
- url: fresh isolated Electron E2E workspace
- viewport: 1100x800 CSS pixels
- user action: Studio Pi composer drop 六张有效 PNG，等待读取完成后立即点击发送；使用本地黑洞 provider 触发分析失败
- expected: PiComposer submit snapshot 带六张图片；preload/Main 接收 PiImageBatchChatInput；Main 先建立六附件批次再进入分析；failed_analysis 保留六张 pending files；无图片继续普通 context message
- before actual: 持久 wemediabuddy-dev 主进程已运行约 3h26m，renderer HMR 显示新队列但旧 Main IPC 没有批次记录，症状表现为普通 context message；失败结果没有 batch status 时 composer 清空队列
- after actual: 重启 dev process 后，同一路径在 Main 读到六个附件，黑洞 provider 使批次进入 failed_analysis；typed batchStatus 让 PiDock 返回 false，六张 queue item 仍可见
- screenshot: tests/e2e/.artifacts/WMB-5307-pi-image-batch-composer-a4rbFH/pi-image-batch-composer-six-send-screenshot.png
- console: tests/e2e/.artifacts/WMB-5307-pi-image-batch-composer-a4rbFH/pi-image-batch-composer-six-send-console.json（仅 Vite/React 开发信息与 Electron CSP warning，无 page error）
- dom selector: .pi-composer, .pi-image-queue-item, .pi-send-button[aria-label="发送"]
- state/store: PiComposer queued images -> frozenAttachments -> PiDock send callback -> preload chatPi -> Main pi_image_batches；ordinals 0..5 回读 drag-1.png…drag-6.png，非 completed batchStatus 返回 false 保留 queue

Hypotheses:
1. hypothesis: drop 后 submit callback 捕获旧 attachments，导致 sendText 收到空数组。
   supports: 预览存在而批次缺失，表象符合 snapshot 丢失。
   would-disprove: 新鲜 Electron 同一路径在 Main 建立六附件批次。
   result: disproved; src/renderer/pi-composer.tsx 的 sendCurrent 冻结并传出六项，fresh gate 通过。
2. hypothesis: 持久 Main 进程没有重载 WMB-5307 的 pi:chat image-batch 分支，renderer/main 版本错位后把对象落入普通 context path。
   supports: stale process uptime 约 3h26m；症状为普通 context message；当前代码 `src/main/ipc-pi-dock.ts:776-802` 以 `isPiImageBatchChatInput` 分支选择批量路径。
   would-disprove: 重启后仍无批次或附件数量不是六。
   result: confirmed; 重启后 focused gate 建立六附件并以 failed_analysis 结束。
3. hypothesis: failed_analysis response 未携带批次状态，PiDock 将失败误判为 accepted，PiComposer 因此清空 pending files。
   supports: 旧失败截图中 assistant 显示 Connection error 且 composer queue 为空；Main 返回 outcome 但 response 没有 status。
   would-disprove: failed_analysis 后 batch queue 仍显示六张且 send result 为 false。
   result: confirmed and repaired; typed batchStatus now makes PiDock return false and retains six files.

Bug type: timing-stale / runtime version skew at Main IPC dispatch plus side-effect-missing failure status propagation; not renderer state loss.

Chain traced:
- `src/renderer/pi-composer.tsx:151-180`: drop validates files, queues preview state, reads bytes asynchronously.
- `src/renderer/pi-composer.tsx:202-218`: `sendCurrent` rejects non-ready files, creates ordered `frozenAttachments`, passes them to `onSend`, and only clears on accepted result; false/rejection restores text and retains files.
- `src/renderer/pi-dock.tsx:389-487`: `sendText` preserves ordinary path when attachment array is empty; non-empty attachments create `{ message, requestId, projectId, attachments }`; lines 452-466 now classify any non-completed batch status as failure and return false.
- `src/preload/preload.ts:348-364`: `chatPi` spreads the structured input into `pi:chat` without dropping `attachments`, and now types optional `batchStatus`.
- `src/main/ipc-pi-dock.ts:776-838`: `isPiImageBatchChatInput` selects `runPiImageBatch`; stale Main lacked this branch and treated the object as normal chat; current batch return carries `batchStatus`.
- `src/main/ipc-pi-dock.ts:615-646`: batch row and its attachments are created before image analysis, giving an observable Main boundary.

Breakpoint: primary `src/main/ipc-pi-dock.ts:776-802`, specifically the `batchInput = ... isPiImageBatchChatInput(input)` guard and subsequent batch branch. The old persistent Main process was the first layer that did not consume the new structured input; renderer preview and submit snapshot were intact. Secondary `src/renderer/pi-dock.tsx:452-466`: failed batch status now reaches the clear-on-success/retain-on-failure decision.

Root cause: a stale long-lived Electron Main process served pre-WMB-5307 IPC code while the renderer had hot-reloaded the new image composer, so structured image input fell through to ordinary context chat. Separately, the current batch response represented `failed_analysis` as a transport success without a status, so the renderer cleared files. Restarting loads the batch contract; typed status propagation preserves failed input for retry. No fallback or response-text special case was added.

Files read: `src/renderer/pi-composer.tsx`, `src/renderer/pi-dock.tsx`, `src/preload/preload.ts`, `src/renderer/global.d.ts`, `src/main/ipc-pi-dock.ts`, `src/shared/pi-image-batch.ts`, `tests/e2e/harness.mjs`, `tests/e2e/studio.test.mjs`.

Files changed: `src/main/ipc-pi-dock.ts` (batchStatus response), `src/preload/preload.ts` and `src/renderer/global.d.ts` (typed status), `src/renderer/pi-dock.tsx` (return false for non-completed batches), `tests/e2e/studio.test.mjs` (six-file DOM drop, immediate send, local blackhole, Main IPC readback, retained-on-failure assertion), `.ai/frontend-debug-loop/LOOP_PROFILE.md`, `.ai/frontend-debug-loop/state.json`, and this report. No generic attachment system, schema, permission, dependency, or unrelated Pi behavior changed.

Before/after gate:
- before: old persistent Main process + HMR renderer; preview existed but no `pi_image_batches` row; a failed batch response also cleared the composer queue.
- after: restarted `wemediabuddy-dev`, then `node tests/e2e/runner.mjs --file tests/e2e/studio.test.mjs --scenario WMB-5307-pi-image-batch-composer --keep-runtime`.
- proof: pass result `dragged=true`, `sent=true`, `mainBatchSelected=true`, `attachmentCount=6`, `retainedOnFailure=true`, ordered `drag-1.png` through `drag-6.png`; `pi-image-batch-composer-six-send-console.json` has no page errors. Local endpoint `127.0.0.1:1/v1` intentionally fails analysis, so the batch ends in `failed_analysis` after six attachments are persisted while the six queue items remain visible.

Owner check:
- user-blocked-on: stale Main process version skew and failure response without batch status.
- now-usable: fresh process sends six dragged images in displayed order through batch handling and retains them after analysis failure.
- real-data-or-state: real DOM drop, real React state, real preload IPC, real SQLite-backed batch rows.
- loading/empty/error: send waits for image reads; no-image branch still sends ordinary context text; blackhole provider verifies truthful analysis failure rather than fake success; non-completed batch returns false and does not clear attachments.
- v1-v2-baseline-preserved: no UI redesign, schema change, permission change, dependency, or ordinary Pi context behavior change.
- regression-risk-checked: focused Electron gate passed at 1100x800 with six ordered Main attachments, retained queue, and no page errors; harness cleaned test Electron child.
- would-user-return-this: no.

Result: fresh-process/runtime skew confirmed and typed failed-batch status propagation repaired; WMB-5308 acceptance evidence added.
State update: loop marked done in `.ai/frontend-debug-loop/state.json`.
Clean completion: yes
Blocked reason: none.
