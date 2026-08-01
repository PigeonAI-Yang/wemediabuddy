purpose: 关系画布用于把长期知识对象显式连接；本轮恢复从端口拖线到持久关系的用户可见链路。
fails-when: 用户仍需猜测先选两个节点，或拖线后没有关系类型、方向、标签和重启读回。

Loop: 2026-07-29-semantic-edge
Symptom: 没有语义连线，无法按设计稿操作。
Observation packet: 见 state.json；真实 1100x700 Electron 截图为 `.ai/wmb-1300-canvas-1100b.png`。
Hypotheses: 实现将端口拖线降级成顶部按钮和 prompt。
Bug type: event-missing。
Chain traced: `knowledge-canvas-view.tsx` 节点 DOM -> `connect()` -> IPC `knowledge-canvas:create-relation` -> `createKnowledgeRelation()`。
Breakpoint: 节点没有连接端口和拖线事件，业务 API 虽存在但用户路径到不了。
Root cause: 首版 renderer 只实现了“选两节点后点按钮并弹 prompt”，设计稿中的端口、拖线事件、落点和关系菜单均未进入 DOM。
Files read: design HTML, renderer component/styles, business function, approved product/design register。
Files changed: `src/renderer/knowledge-canvas-view.tsx`, `src/renderer/styles.css`, loop state。
Before/after gate: before 已复现；after 代码具备节点双端口、拖线预览、落点关系菜单、有向箭头和标签，但用户要求停止窗口鼠标控制，因此不再自动操作真实窗口。
Owner check: 真实数据已载入；空状态已覆盖；全局导航和 Pi dock 保持；真实拖线仍需用户自行验收。
Result: needs_user。
State update: needs_user。
Clean completion: no。
Blocked reason: 不再控制用户鼠标；窗口级交互验收留给用户。
