# WMB-5307 — Pi 批量图片排图与持久化

## 交付

- Pi 输入框支持选择/拖入 1–10 张 PNG、JPEG、WebP、GIF；提交前显示缩略图、顺序、大小，支持上移、下移、移除与附带要求。
- Main 进程先校验真实图片签名和批次上限，再将全部原图持久导入当前项目；批次、附件、采用/未采用原因、失败信息和核心版本号写入 SQLite migration 73。
- Pi 请求携带正文及图片视觉内容，返回唯一 JSON manifest；机器校验 request/project/revision、正文仅新增独立图片段落、每图决策、既有 occurrence 绑定和完整 mediaBindings。
- 保存复用 `wmb_save_core_version`，同一 requestId 与 save requestId 幂等；revision 冲突保留已导入素材并落 `conflicted`，其他导入/分析/保存/回读错误落真实失败阶段。
- 成功后广播 Studio 数据变更并显示采用/保留计数；编辑器继续使用既有图片手动调整链。

## 主要文件

- `src/shared/pi-image-batch.ts`
- `src/main/db/pi-image-batch-migrations.ts`
- `src/main/pi-image-batch.ts`
- `src/main/ipc-pi-dock.ts`
- `src/preload/preload.ts`
- `src/renderer/components/pi/PiDock.tsx`
- `src/renderer/styles-pi-dock.css`
- `tests/pi-image-batch.test.mjs`
- `tests/e2e/studio.test.mjs`

## 验证

- `npm run typecheck` — PASS。
- `node --test tests/pi-image-batch.test.mjs` — 4/4 PASS：migration 73、请求幂等、伪造 MIME 拒绝、仅插图不改写正文。
- `node --test tests/design-tokens-drift.test.mjs` — 3/3 PASS。
- `node tests/e2e/runner.mjs --file tests/e2e/studio.test.mjs --scenario WMB-5307-pi-image-batch-composer` — 1/1 PASS：真实 Electron 选择两图、缩略图预览、排序、移除、1100×800 横向溢出 0、page error 0。产物：`tests/e2e/.artifacts/WMB-5307-pi-image-batch-composer-WfTzsO`。

测试标签页已关闭；隔离测试浏览器进程 `omp.browser.headless` 已确认 exited。