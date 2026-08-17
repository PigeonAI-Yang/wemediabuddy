selected-milestone: WMB-5308
project-purpose: Studio Pi dock 将用户拖入的图片按明确顺序交给 Pi 进行正文排图，失败时保留可重试输入。
target-surface: Pi composer drag/drop queue、sendCurrent snapshot、PiDock sendText、preload chatPi、Main pi:chat image-batch branch。
runtime-chain: drag/drop -> PiComposer attachments -> frozen submit snapshot -> PiDock send callback -> preload chatPi -> pi:chat input guard -> pi_image_batch.create/import/analyze。
completion-authority: 新鲜 Electron 进程中拖入六张有效图片并立即发送；Main IPC 的 pi_image_batches 记录六个同序附件并选择批量图片路径；分析失败时六张待发送图片仍保留；无图片仍走普通 context message。
focused-gate: WMB-5307 focused Electron scenario at 1100x800 with local blackhole Pi config; six-file drag/send and Main IPC readback.
budgets: implementation attempts=1; repair attempts=1; product files max=8; scope growth=0.
stop-conditions: 修复要求新增通用附件系统、改变 Pi image-batch/backend schema、权限、foundation brand token 或依赖。
