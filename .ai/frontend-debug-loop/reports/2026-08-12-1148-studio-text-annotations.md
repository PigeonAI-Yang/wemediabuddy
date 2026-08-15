purpose: Studio 正文问题批注让主编精准指出问题、独立持久化且不污染正文，并在下一次主动发言中把当前稿与开放批注交给 Pi。
fails-when: 批注进入 Markdown、保存后锚点错误、跨正文泄漏、重开丢失，或 Pi payload/徽标与当前开放批注不一致。

Loop: WMB-5207
Symptom: 批注能力此前不存在；正文问题只能写回稿件或靠聊天描述，缺少稳定锚点、管理面与 Pi 交接。
Observation packet:
- url: http://127.0.0.1:27391/（隔离 Electron/CDP）
- viewport: 1600×1000
- user action: 新建项目→源码选区→右键标记并说明→右栏定位/更新→保存→编辑前方文字→再次保存→读取 SQLite/IPC→主动向 Pi 发送
- expected: 批注独立显示与持久化，正文不含标记；严格前置编辑平移锚点；发送时显示并带入 1 条开放批注。
- actual: 选区 17..28 创建成功；保存后正文无 marker；范围内编辑自动 resolved，随后严格前置插入后开放批注仍为 1 条且从 52..64 平移至 59..71；重开 IPC/SQLite 读回一致；Pi composer 显示“已带入 1 条正文批注”。
- screenshot: 无新增截图；DOM、IPC、SQLite 与完整测试输出为主证据。
- console/network: Vite overlay=false；隔离验收 profile 的伪 acceptance key 触发 safeStorage 解密错误，未用作 Pi 网络成功证据。
- dom selector: [aria-label="问题标记"]、.studio-annotation-panel、.pi-annotation-badge、[contenteditable=true]
- state/store snapshot: project=9dda4f73-cc8b-4ea2-ac76-af5d59710f19，revision=3；open annotation startOffset=59/endOffset=71，quotedText=“边界批注用于验证保存顺序”。

Hypotheses: 批注若作为独立范围记录并在保存事务内迁移，则正文可保持纯净、重开可靠且 Pi 可只在显式发送时获得当前快照。真实 Electron 与 DB/IPC readback 支持；43 条聚焦合同覆盖失败边界。
Bug type: permanent feature / full renderer→IPC→SQLite→focus snapshot→Pi payload chain.
Chain traced: studio-view selection/overlay/panel → preload annotation IPC → studio-annotations main store → migration v55 → save core/platform transaction → Studio focus → pi-context-payload → Pi composer badge/chatPi.
Breakpoint: 原产品链路缺少独立 annotation entity、选区投影、保存迁移与 Pi context fragment。
Root cause: 不是单点 bug；WMB-5207 批准规格要求新增完整垂直切片。
Files changed: shared/studio-annotations.ts；src/main/studio-annotations.ts；src/main/db/migrations.ts；src/main/content.ts；src/main/pi-context-payload.ts；src/preload/preload.ts；src/renderer/global.d.ts；src/renderer/studio-annotations.ts；src/renderer/studio-annotation-layer.tsx；src/renderer/studio-view-panels.tsx；src/renderer/studio-view.tsx；src/renderer/pi-context-payload.ts；src/renderer/pi-dock.tsx；src/renderer/pi-composer.tsx；src/renderer/styles.css；tests/wmb-5207-*.test.mjs；schema-version fixtures/tests。
Before/after gate:
- before: 无独立正文批注路径。
- after: 核心正文真实选区、右键创建、说明保存、范围内编辑自动解决、严格前置编辑平移、保存/重开、IPC/SQLite 读回和 Pi 徽标全部走通；正文逐字不含批注 marker。
- proof: WMB-5207 focused 43/43；npm test 942/942；npm run typecheck PASS；Electron DB/IPC readback project revision=3、open row 59..71。
Owner check:
- user-blocked-on: 已解除。
- now-usable: 核心正文真实路径已完整验收；平台正文同构路径由聚焦 DB/UI 合同覆盖。
- real-data-or-state: 隔离 data-root 真 SQLite、真 preload IPC、真 Electron DOM。
- loading-empty-error-states: 聚焦合同覆盖 loading/error/retry/无批注；真实路径观察成功态。
- v1-v2-baseline-preserved: 正文 Markdown、复制/发布载荷、版本历史未写入 marker；全仓 942/942。
- regression-risk-checked: core/platform 保存事务、scope 隔离、迁移歧义/删除/重开、主题/reduced-motion、Pi 预算。
- would-user-return-this: no。
Result: PASS。
State update: WMB-5207 done；schema fixture 基线从 54 同步到 migration 55。
Clean completion: yes
Blocked reason: none
