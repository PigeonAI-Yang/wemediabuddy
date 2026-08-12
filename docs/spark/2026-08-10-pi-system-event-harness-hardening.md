# Pi 系统事件 Harness 加固（WMB-5164 残余风险收口）

- 日期：2026-08-10
- 路由：Design（产品宪法不变；纯 harness 加固，PRD/SPEC/PRODUCT 零改动）
- 状态：**Owner lock locked — Owner 已于 2026-08-10 在 Owner-lock UI 选择「批准三个决策」（批准全部三个编号决策），本文件为施工授权蓝图**
- 前置：`docs/spark/2026-08-10-topic-maintenance-conflict-reproposal-design.md`（同批多任务 Design 格式）、`docs/intake-routing.md`（Design 路由）、`skill://project-harness-bootstrap`（Tier 2/2.5/3 契约）、WMB-5164 证据与残余风险
- 对齐：`docs/ai-harness.md`（机器强制同变更落地）、`docs/verification.md`（receipt 契约）、`docs/pi-operation-skill-maintenance.md`（Skill 打包验收）、SPEC CAP-014/CAP-025/CAP-027

## 1. 问题与来源事实

WMB-5164（M-5140，CAP-014/CAP-027，2026-08-10 done）在 Pi dock 引入系统事件投影后，证据文件如实记录了三项残余风险。本设计逐项给出机器强制的收口方案，全部为既有 harness 的延伸，不新建并行框架。

### 风险 A — 协议漂移（producer/detector 各持一份手抄字面量）

- **事实**：`src/main/manager-job-notify.ts:159` 生产信封时内联整段 `contextRule=这是系统推送的员工工单终态通知，不是用户闲聊。根据 JOB_EVENT 向用户汇报并做验收/下一步，不要 sleep 轮询。`；`src/main/pi-transcript-projection.ts:24` 检测器另持一份手抄前缀常量 `SYSTEM_JOB_EVENT_CONTEXT_RULE = 'contextRule=这是系统推送的员工工单终态通知'`，靠 `header.includes(前缀)` 匹配。
- **事实**：测试侧同样手抄完整信封：`tests/pi-message-flow.test.mjs:228`（JOB_EVENT 投影用例）与 `tests/pi-conversation.test.mjs:243` 各有一份逐字复制的 contextRule 行。
- **事实**：生产者改文案/字段顺序 → 检测器前缀静默失效，JOB_EVENT 不再被标记为 system_event，且没有任何测试失败（测试与检测器各自手抄，可能同时“通过”）；不存在 producer→projection 的往返行为评测，也无逐字段变异矩阵。
- [INFERENCE] 同一字面量存在三份（producer 全文、detector 前缀、测试两处全文），任意一份漂移即构成行为回退且静默。

### 风险 B — 无 kind 的遗留消息（可见文本无 provenance）

- **事实**：`kind` 由生产路径唯一写入：`manager-job-notify.ts:191` 离线会话持久化 `{ role:'user', text: visibleJobNotice(text), createdAt, kind:'system_event' }`；`pi-transcript-projection.ts:71` 仅对完整信封的 raw user 条目投影 `kind`。
- **事实**：`normalizeMessage`（pi-conversation.ts）只在 `message.kind` 已存在时保留它；遗留消息（WMB-5164 之前持久化、或 legacy `conversation.json` 迁移）只有可见文本，没有 kind。
- **事实**：`visibleJobNotice` 在持久化时剥掉 `[WMB_CONTEXT]` 头部，因此离线快照只剩可见 `[JOB_EVENT] …` 文本；完整信封只存在于 raw Pi session JSONL（`readConversationFile` 经 `preferProjectedMessages` 在读到 `sessionFile` 时重投影）。
- **结论**：遗留可见文本无法证明作者身份——它可能是旧版系统通知、也可能是恰好以 `[JOB_EVENT]` 开头的人类消息（WMB-5164 测试已证明禁止裸前缀启发式）。这是**围堵**，不是追溯恢复。

### 风险 C — 陈旧生成镜像拖垮默认测试

- **事实**：`tests/pi-operator-skill.test.mjs:156`（WMB-5144 行为评测）把 data-root 与 `out/` 打包镜像的 freshness 断言放进默认 `npm test`；`out/WeMediaBuddy-win32-x64` 是 gitignored 的旧打包产物。
- **事实**：WMB-5164 证据：`npm test` 691 total / 690 pass，唯一失败即该测试——`out/WeMediaBuddy-win32-x64/resources/skills/wemedia-buddy-operator` 修订 hash `6ad8…` ≠ canonical `ccd9…`，与任务无关。
- **事实**：`data/gamedata/pi-agent/skills/wemedia-buddy-operator` 与 `data/ukcontentdata/…` 镜像真实存在（两者及 `out/` 均 gitignored）；镜像由 `scripts/prepare-pi-runtime.mjs` 生成。
- **事实**：`scripts/check.ps1` 轻量模式只跑结构门禁（harness 文件、ledger、intake、capability registry）；`-Full` 才跑 typecheck+test+build（build = `npm run build` → electron-forge make）。`.github/workflows/release.yml` 发布门禁在 publish 前跑 typecheck/test/check:capabilities/check.ps1，当前无镜像校验。
- **事实（Forge 7.11.2 类型证据）**：`ForgeConfig` 支持 `hooks.postPackage({ platform, arch, outputPaths })`；core 在 packager 解析 `outputPaths` 之后、makers/publish 之前执行该 hook。`forge.config.ts` 的 `packagerConfig.extraResource` 已含 `'skills'`，打包产物镜像路径为 `<outputPath>/resources/skills/wemedia-buddy-operator`。
- **事实**：`docs/ai-harness.md:78`：harness 规则变更必须在同一变更内落地机器强制（check.ps1/check-*.mjs），仅改 prose 不允许。

## 2. 现有 Tier 选择

项目已是 **Tier 3 + Tier 2.5**（token 经济、anti-fabrication receipts、intake 门禁、Owner lock、双模型 review、honeypot）。本设计**不升级、不新建**任何 tier 机制：只在既有 `scripts/check.ps1` / `check-*.mjs` / 测试负面 fixture / 发布门禁的骨架内补齐三处缺口。每个 MUST 都有机器权威（脚本或测试），无 prose-only 承诺。

## 3. 显式不变量

1. **`kind` 是唯一作者身份权威**。可见信封文本永不用于推断 provenance；无回填、无启发式、无“看起来像”判定。
2. **系统事件信封只有一份 canonical 契约**（常量 + 纯 builder/parser），producer、detector、测试三方同源消费；src 与 tests 内不得再存在手抄字面量。
3. **默认源码套件不依赖生成物**。focused、`npm test` 全量、轻量 `check.ps1` 不得因缺失/陈旧的 `out/` 或 data-root 镜像而失败。
4. **harness 规则与机器强制同变更落地**（docs/ai-harness.md:78）：本设计每个决策都指名可执行权威。
5. **历史数据永不改写**。遗留消息 raw 字节不变；任何回填/迁移必须经未来、用户逐条审阅的产品 Design。
6. **镜像 freshness 由发布路径预防性把关**：CLI 缺省对缺失镜像干净跳过（本地诊断），Forge `postPackage` hook 始终 `--require-existing`（打包产物缺失/陈旧即失败）；已存在但陈旧 = 精确路径失败。

## 4. 门禁矩阵（风险 → 保证 → 机器权威 → 负面 fixture → receipt）

| 风险 | 保证 | 机器权威 | 负面 fixture / honeypot | receipt |
| --- | --- | --- | --- | --- |
| A 协议漂移 | 单一共享信封契约；漂移结构上不可能或使聚焦/全量失败 | `tests/job-event-envelope.test.mjs`（往返评测 + 变异矩阵）进 `npm test`；typecheck 覆盖共享模块 | 逐字段变异矩阵：page / objectType / contextRule / [USER_MESSAGE] 标记 / [JOB_EVENT] 前缀 / 头部顺序任一改动 → 判非 system_event；人类粘贴全部信封 token → 仍人类 | focused + typecheck + full `npm test` receipt；协议评测路径 |
| B 遗留误分类 | kind 权威；无回填；raw 字节不变 | `tests/pi-conversation.test.mjs`、`tests/pi-message-flow.test.mjs` 负面 fixture 进默认套件 | 无 kind 的 `[JOB_EVENT]` 可见文本保持 kindless；离线快照 round-trip 后文本逐字节一致；粘贴 token 矩阵保持人类 | legacy 兼容评测 receipt；围堵声明（非恢复） |
| C 陈旧镜像 | 默认源码套件干净；镜像 freshness 预防性把关——build/publish 在 maker/upload 前失败 | `scripts/check-skill-mirrors.mjs`（参数化；缺省缺失 skip、`--require-existing` 陈旧 fail 带精确路径）；`forge.config.ts` `hooks.postPackage` 对每个 `outputPath` 的 `resources/skills/wemedia-buddy-operator` 以 `--require-existing` 调用 | 临时树行为测试：fresh PASS / stale FAIL（精确路径）/ missing SKIP（缺省）与 missing FAIL（`--require-existing`） | 发布门禁位置 receipt；轻量/聚焦/全量干净 receipt；capability/skill impact；独立 review |

`docs/verification.md` 记录门禁位置（WMB-5167 落地时写入该文档对应小节）；`scripts/check.ps1` 是机器权威。**pre-push 保持轻量、不 build**。

## 5. 拟议架构与精确路径

### 5.1 决策 1（WMB-5165）— 共享信封契约 + 往返/变异评测

新共享模块（沿用 `src/shared/` 现有纯函数模式，零依赖）：

- `src/shared/job-event-envelope.ts`
  - `JOB_EVENT_CONTEXT_RULE` 常量（canonical 全文，即现 producer 行 159 文本）；
  - `buildJobEventEnvelope(input: { objectId: string; text: string }): string` —— 纯 builder，产出 `[WMB_CONTEXT]…contextRule=…\n[USER_MESSAGE]\n${text}`；
  - `isJobEventEnvelope(text: string): boolean`（或等价纯 parser）—— 完整信封判定，取代现 `pi-transcript-projection.ts:32-40` 的手写 header 检查。

消费方（全部同源）：
- `src/main/manager-job-notify.ts:157-160` → `buildJobEventEnvelope({ objectId: input.job.id, text })`；
- `src/main/pi-transcript-projection.ts:23-40` → 删除手抄前缀常量，改调 `isJobEventEnvelope`；
- `tests/pi-message-flow.test.mjs`（JOB_EVENT 投影用例）、`tests/pi-conversation.test.mjs`（离线信封 fixture）→ 经 builder 构造，删除手抄字面量。

新行为评测 `tests/job-event-envelope.test.mjs`：
- 往返：builder 产物 → `isJobEventEnvelope` true → `messagesFromPiEntries` 标 `kind:'system_event'`；
- 变异矩阵：每个字段逐一变异 → false（见 §4 负面 fixture 列）；
- honeypot：人类正文把完整信封 token 粘进 `[USER_MESSAGE]` 之后 → 仍人类。

### 5.2 决策 2（WMB-5166）— 遗留 kind 权威兼容（test-only 契约）

不改变任何生产语义；`kind` 维持唯一权威。新增/扩展负面 fixture（test-only）：
- `tests/pi-conversation.test.mjs`：构造无 kind 的遗留快照（含 `[JOB_EVENT]` 可见文本、无 sessionFile）→ `readConversationFile` 后保持 kindless，且 round-trip 文本逐字节一致（raw bytes unchanged）；
- `tests/pi-message-flow.test.mjs`：扩展粘贴 token 矩阵（信封 token 出现在正文/头部任意组合 → 不打标）；
- 明确断言：无隐式回填、原始字节不变、粘贴的人类 token 保持人类。

如该任务需要导入共享 parser（与 WMB-5165 同变更落地时），依赖 5165；否则独立。未来如需“用户逐条审阅的迁移”（把已知 WMB 生成的历史通知标记为系统事件），作为**独立产品 Design** 另提，不在本设计范围；禁止启发式自动迁移。

### 5.3 决策 3（WMB-5167）— 镜像 freshness 预防性发布门禁 + harness 策略

- 新 `scripts/check-skill-mirrors.mjs`：参数化（`--canonical <dir>` 默认 `skills/wemedia-buddy-operator`，`--mirror <dir>` 可重复，`--require-existing` 开关）；缺失 `SKILL.md` 且未加 `--require-existing` → skip（本地诊断干净）；加 `--require-existing` 后缺失 → fail；已存在 → 比对 `.wmb-install.json` revision + `SKILL.md` 字节，不一致 → exit 1 且输出**精确路径**。
- `tests/pi-operator-skill.test.mjs:156`：生成镜像断言移出默认套件；文件内 canonical 行为评测（工具/roster/dock 身份、桌助文案等）保留。
- 新 `tests/skill-mirror-check.test.mjs`：临时树行为测试——fresh PASS、stale FAIL（精确路径）、missing SKIP（缺省）、missing FAIL（`--require-existing`）；只测脚本本身，不碰真实 data roots。
- `forge.config.ts`：新增 `hooks.postPackage`——对每个 `outputPath` 以 `--require-existing` 调用 verifier 校验 `<outputPath>/resources/skills/wemedia-buddy-operator`（打包镜像由既有 `packagerConfig.extraResource: ['skills', …]` 生成）。hook 在 packager 解析 outputPaths 之后、makers/publish 之前执行：
  - `npm run build`（即 `check.ps1 -Full` 内的 build）→ 生成镜像缺失/陈旧在 maker 之前失败；
  - `npm run publish` → 同样在 maker/upload 之前失败。
  - **不新增** release.yml 步骤，也**不**在 `check.ps1` build 后重复直接调用（hook 即 build 路径上的唯一权威）。
- `docs/verification.md`：记录门禁位置（Forge `postPackage` hook；默认源码套件与 pre-push 不再依赖 `out/`）。
- 引用既有 Skill 打包验收：`docs/pi-operation-skill-maintenance.md`（打包/加载变更验收章节）。
- harness 策略变更与机器强制同一变更落地（docs/ai-harness.md:78）：脚本 + forge hook + docs 同任务。

## 6. 任务分解与依赖

| 任务 | 范围 | Capability | 依赖 |
| --- | --- | --- | --- |
| **WMB-5165** | 共享信封契约（`src/shared/job-event-envelope.ts`）+ producer/detector/tests 同源 + 往返/变异评测 `tests/job-event-envelope.test.mjs` | CAP-014, CAP-027 | 无 |
| **WMB-5166** | 遗留 kind 权威兼容负面 fixture（test-only；可能导入共享 parser） | CAP-014, CAP-025 | 仅当导入共享 parser 时依赖 5165 |
| **WMB-5167** | `scripts/check-skill-mirrors.mjs` + 临时树行为测试 + `forge.config.ts` `postPackage` hook 接线 + `docs/verification.md` 门禁位置（无 release.yml 变更） | harness（引用既有 Skill 打包验收） | 无（与 5165/5166 并行） |

Owner lock 必须**先批准全部三个编号决策**，才允许创建合同与 TASKS 行。三个任务无共享文件冲突面（5165 动 `src/shared` + 两个 src + 两个测试文件；5166 只动测试；5167 动 scripts/tests/forge.config.ts/docs），可并行实施，但按水线纪律各自独立验收。

## 7. 落地与验证（lock 之后）

1. **Phase 0**：Owner lock（§9）→ 三决策全部获批 → 才能进入合同/TASKS。
2. **WMB-5165**：focused（envelope 往返 + 变异矩阵 + pi-conversation/pi-message-flow）+ typecheck + 全量 `npm test`。
3. **WMB-5166**：focused 负面 fixture（无回填、字节不变、粘贴人类）全绿。
4. **WMB-5167**：临时树矩阵 fresh/stale/missing（缺省与 `--require-existing` 双态）全绿；轻量 `check.ps1` 干净（不依赖 out/）；`npm run build`（即 `check.ps1 -Full`）经 `postPackage` hook 对真实打包镜像通过，缺失/陈旧在 maker 前失败；`npm run publish` 同门禁；release.yml 无新增步骤。
5. **Receipt**（按 docs/verification.md 契约）：每任务记录协议评测/legacy 兼容评测/镜像 honeypot、focused/typecheck/`npm test`/轻量 receipt、发布门禁位置、`Capability registry impact: no change — …`（无命令/角色/grant 变化）、`Pi operator Skill impact: no change|updated — …`、`Independent review: …`；CAP eval 引用 CAP-014/025/027（`EVAL-CAP-014/025/027.md` 已存在，任务闭环后按需更新）。
6. **pre-push 保持轻量、不 build**：镜像校验不进轻量路径。

## 8. 被否决的替代方案

- **A：保留手抄字面量、加“字符串一致性测试”**——仍两份真源，字符串同步测试脆弱，挡不住字段顺序/标记结构漂移。否决。
- **A：信封上 zod 运行时校验**——信封是纯文本，解析即契约；引入依赖不消除 producer 字面量重复。否决。
- **A：信封版本化（`[WMB_CONTEXT v2]`）**——改变线上格式，破坏 WMB-5164 的 raw session 兼容与遗留读取；单一内部 producer 无必要。否决。
- **B：启发式自动回填**——以可见 `[JOB_EVENT]` 文本把遗留消息标成 system_event：遗留文本无 provenance，会把真实人类消息误分类并静默改写用户数据，违反 CAP-025 读≠写。否决。
- **B：对存储快照做信封重投影的追溯迁移**——持久化时头部已被 `visibleJobNotice` 剥离，快照不可恢复；声称恢复即是造假。否决。
- **B：信任含 `[WMB_CONTEXT]` 前缀的遗留文本**——混合启发式不可验证。否决。
- **C：镜像断言留在 npm test 但放宽**——静默跳过真实陈旧，门禁名存实亡；开发检出不该背负 out/。否决。
- **C：镜像校验进轻量 check.ps1**——轻量不 build，新克隆无镜像，位置错误。否决。
- **C：release.yml 在 publish 后追加镜像校验**——事后检查：maker/upload 已完成，陈旧产物已进入发布链；Forge `postPackage` hook 在 packager 之后、maker/upload 之前，才是预防性时点。否决。
- **C：`check.ps1 -Full` 在 build 后直接重复调用镜像校验**——`npm run build` 经 `postPackage` hook 已强制，直接调用是重复权威、双真源。否决。
- **C：自动删除陈旧 out/**——破坏性且动用户本地 gitignored 产物；正确做法是分离校验职责。否决。

## 9. 残余不可解风险（围堵后仍存在）

1. **WMB-5164 之前持久化的旧通知不可恢复**：头部已剥离、无 kind，只能以普通可见文本呈现；未来迁移只能是用户逐条审阅的产品功能（独立 Design），本设计不解决。
2. **契约由测试强制而非类型系统强制**：改动信封格式必须经共享模块 + 往返评测，机器可拦；但“人类绕过契约直接改两处”理论上仍可能，靠 honeypot 矩阵与独立 review 降低。
3. **镜像校验只覆盖真实打包路径**：本地不跑 build/publish 的开发者不触发 hook——这是有意取舍：默认套件与 pre-push 干净优先，Forge `postPackage` 是发布链权威。
4. **`npm test` 现存 1/691 例外**（陈旧 out/，WMB-5164 已如实记录）：在 WMB-5167 落地前保持“已知例外、不得宣称全量通过”的状态。

## 10. Owner lock（**locked** — Owner 已批准三个编号决策，本设计构成施工授权）

聊天指令（含本对话里的任何“做吧/实施”）在 Owner 显式锁本设计之前，**不是构造授权**；锁后仍需 `TASKS.md doing` 才可施工（docs/intake-routing.md 权限阶梯）。

```text
Owner lock 2026-08-10（状态：locked）：
1. 批准引入单一共享系统事件信封契约（constant + 纯 builder/parser），producer、detector 与测试同源消费，并新增 producer→projection 往返行为评测与逐字段变异/honeypot 矩阵；信封漂移必须结构上不可能或使聚焦/全量测试失败。
2. 批准对无 kind 的遗留消息采用安全围堵：不依据可见 [JOB_EVENT] 文本推断作者身份，kind 保持唯一权威，无启发式回填、raw 字节不变、粘贴的人类 token 保持人类；本项是围堵而非追溯恢复；未来用户逐条审阅的迁移作为独立产品 Design 另提，不在本次范围。
3. 批准生成式镜像校验移出默认 npm test，落地为参数化 scripts/check-skill-mirrors.mjs（缺省对缺失镜像干净跳过、陈旧既有镜像以精确路径失败），并由 forge.config.ts 的 hooks.postPackage 对每个打包 outputPath 以 --require-existing 强制校验：npm run build（check.ps1 -Full）与 npm run publish 均在 maker/upload 前失败，无 release.yml 变更；默认聚焦/全量源码测试与 pre-push 不再依赖旧 gitignored out/。
4. Non-goals：不做启发式自动迁移、不改 raw session 写格式、不改 PRD/SPEC/PRODUCT、不新增依赖、不为旧产物清理或重建、不扩展权限/角色/grant。
5. Route: Design。
6. Design path: docs/spark/2026-08-10-pi-system-event-harness-hardening.md
7. 确认记录（2026-08-10）：Owner 在 Owner-lock UI 选择「批准三个决策」，即批准上述编号决策 1、2、3 全部三项；本设计自此为施工授权（Design 蓝图），具体施工仍需 TASKS.md 对应任务转为 doing（docs/intake-routing.md 权限阶梯）。
```
