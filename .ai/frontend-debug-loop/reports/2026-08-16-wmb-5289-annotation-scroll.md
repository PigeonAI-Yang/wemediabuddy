purpose: 创作页让主编在正文当前位置记录问题；本轮修复批注菜单到说明输入的焦点交接，不得改变阅读位置。
fails-when: 同一长正文深处右键路径中，说明输入出现后 `.studio-canvas.scrollTop` 与打开前不一致，或批注说明未落库。

Loop: WMB-5289 Studio annotation popup scroll stability
Symptom: 用户在正文深处右键选择「标记并说明」后，编辑画布跳回顶部。
Observation packet: 真实 Electron ST-004；渲染编辑长正文第 36 段；打开前 scrollTop=1492，打开后 scrollTop=0；浮层为 fixed，失败发生在 IPC 之前。
Hypotheses: 菜单卸载时用普通 `focus()` 恢复到大型富文本编辑器，Chromium 为展示焦点元素而将其起点滚入视口。若 `preventScroll` 后同一路径仍跳动则推翻。
Bug type: timing-stale / focus side effect。
Chain traced: rich selection -> `handleEditorContextMenu` -> `StudioAnnotationMenu` -> menu item -> `StudioAnnotationNoteInput` -> `createStudioAnnotation` -> overlay + SQLite。
Breakpoint: `src/renderer/studio-annotation-layer.tsx` 菜单和说明输入的自动聚焦与焦点恢复。
Root cause: 四个焦点交接使用 `HTMLElement.focus()`，未禁止浏览器隐式滚动；菜单关闭并恢复富文本编辑器焦点时，`.studio-canvas` 被拉到顶部。
Files read: `src/renderer/studio-view.tsx`, `src/renderer/studio-annotation-layer.tsx`, `src/renderer/styles-studio.css`, `tests/e2e/studio.test.mjs`。
Files changed: `src/renderer/studio-annotation-layer.tsx`, `tests/e2e/studio.test.mjs`。
Before/after gate: before 1492 -> 0；after 精确差值 <=2，说明输入保持焦点，输入「E2E 深处批注说明」后创建成功并由 SQLite 读回；既有源码模式批注创建、列表、编辑说明和持久化继续通过。
Owner check: user-blocked-on=深处标注时丢失阅读位置；now-usable=yes；real-data-or-state=真实 selection、React 状态、Studio annotation IPC 与 SQLite；loading-empty-error-states=未改变；v1-v2-baseline-preserved=yes；regression-risk-checked=ST-004 全路径；would-user-return-this=no。
Result: resolved。
State update: `.ai/frontend-debug-loop/state.json` resolved。
Clean completion: yes
Blocked reason: none
