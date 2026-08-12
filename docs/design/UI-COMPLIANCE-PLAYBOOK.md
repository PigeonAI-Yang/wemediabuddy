# UI 权威合规 — 完整实施指令（Oh My Pi）

**用途：** 下面整段提示词一次粘贴给 Oh My Pi，即启动**整仓前端 UI 对齐权威**的完整工程。不要拆成「第一批 / 第二批 / Wave」让用户再派活。

**权威链：** `CLAUDE.md` → `src/renderer/styles-foundation.css` → `docs/design/living-style-guide.html`。冲突以 foundation 为准。

---

## 完整实施指令（复制下方整块）

```
【完整实施指令 · WeMediaBuddy 前端 UI 全量权威合规】

你是本仓库的主代理（Oh My Pi）。这是一次**端到端、一次做完**的工程指令，不是分批战役。用户不会管理「第一批 / 第二批 / Wave」。你自己盘点范围、自己排工、自己最大化并行、自己验收循环，直到 Definition of Done 全部满足为止。中途只在硬约束触发时向用户提问（例如要改 brand token）；不要为了「确认下一批」来找用户。

════════════════════════════════════
一、目标（唯一使命）
════════════════════════════════════

让 **全部** renderer 前端 UI 表面（所有页面、面板、dock、弹层、空态、状态条、设置、引导、相关样式与用户可见文案）完整符合：

1. `docs/design/living-style-guide.html`（人类可读的活样式指南）
2. `CLAUDE.md`「Visual Design Authority」（Oh My Pi 主入口；与 AGENTS.md、.cursor/rules/design-authority.mdc 同规）
3. Machine SSOT：`src/renderer/styles-foundation.css`（墨夜 · Inter · accent `#8b7cff` · topbar `56px`）

「符合权威」= **token 对齐 + DESIGN 原则（One Violet / 每视图一主操作 / User Language）+ 层级与密度合理**。不是随便美化，不是换皮，不是另起一套视觉语言。

使命覆盖三类工作（视为同一工程的内部阶段，不是用户触发的三波）：
- Token 清偿：页面 CSS / 必要 TSX 中的硬编码 hex、rgb()、hsl() → foundation 变量
- 层级与交互：One Violet、一主 CTA、Flat-by-Default / One Boundary、高密度但不拥挤
- 用户语言：去掉暴露给用户的工程词（MCP / IPC / CDP / revision 等）；文案像给真人用的产品

════════════════════════════════════
二、Definition of Done（可度量，全部满足才算完成）
════════════════════════════════════

全部满足才可向用户宣告「完成」：

D1. **硬编码色清零（允许债务归零）**
   - `src/renderer/styles-*.css`（除 foundation 外）与相关 renderer TSX 中，品牌/chrome 色不再使用一锤子 hex / rgb() / hsl()；一律 `var(--…)`。
   - `tests/design-tokens-hex-allowlist.json` **shrink only**：最终 entries 为空，或文件按仓库约定删除/清空且 drift 门禁仍绿。禁止扩表。

D2. **漂移测试绿**
   - 反复执行且最终通过：`node --test tests/design-tokens-drift.test.mjs`
   - 若改过 foundation（且仅在用户批准 brand 之外的合法语义扩展后），按需跑 `node scripts/sync-design-doc-from-foundation.mjs`，保证 DESIGN.md 同步块不手改错乱。

D3. **原则落地（抽查可证伪）**
   - One Violet：紫实色面积克制（约 ≤10% 量级），不作大面积铺紫。
   - 每个主要视图最多一个最强主 CTA；次要操作用弱样式。
   - 用户可见文案无工程黑话；状态/空态/按钮用产品语言。

D4. **活指南仍准确**
   - `living-style-guide.html` 与 foundation 一致；若你只改了页面消费方式而未改 token，指南无需虚构新色板。
   - 任何文档 / prototype / 记忆与 foundation 冲突 → **foundation 胜**。

D5. **范围穷尽**
   - 你从 allowlist + `src/renderer` 文件树自行发现的全部 UI 表面均已处理；不得因「用户没列页面」而漏页。

════════════════════════════════════
三、硬约束（违者视为失败，须撤回）
════════════════════════════════════

C1. **禁止擅自改 brand token。** 未经用户明确批准，不得改 foundation 中的：`--accent*`、`--app-bg`、`--font-sans` / Inter 栈、`--topbar-height`、核心 ink / surface / border 色阶。不要「优化」色板。

C2. **共享文件编辑协议**
   - 子代理对以下文件 **只读**：`styles-foundation.css`、`CLAUDE.md`、`AGENTS.md`、`.cursor/rules/design-authority.mdc`、`tests/design-tokens-hex-allowlist.json`、`tests/design-tokens-drift.test.mjs`、`docs/design/living-style-guide.html`。
   - 仅 **父代理** 在合并后：shrink allowlist、跑 drift test、必要时（用户批准后）改 foundation / 同步 DESIGN。
   - 页面 CSS 禁止新造品牌 hex；只复用已有 `var(--accent)` / `--ink` / `--surface` / `--border` / 语义色等。

C3. **非 SSOT**
   - `prototype/`、`.impeccable/design.json` 仅历史探索，**绝不当执行真相**。

C4. **文件互斥**
   - 任意时刻，两个子代理不得写同一文件。父代理划分 disjoint 文件所有权。

C5. **不做范围外事**
   - 不借机大重构业务逻辑、不改 IPC/后端、不换路由架构、不引入与权威无关的新设计体系。

════════════════════════════════════
四、执行模型（你自己并行到底；用户不派批次）
════════════════════════════════════

E1. **父代理先做总计划（内部产物，不必停下来等用户批准「第几批」）**
   - 读权威：CLAUDE.md Visual Design Authority、foundation、living-style-guide、本文件、allowlist、drift test。
   - 自行盘点：`tests/design-tokens-hex-allowlist.json` 全部条目 + `src/renderer/styles-*.css` + 相关 TSX/组件中的内联色与用户文案表面。
   - 产出：表面清单、文件所有权图、并行波次表（仅供你内部调度）、风险点（共享壳层、今日/创作等高债务文件）。

E2. **最大化安全并发**
   - 在文件互斥前提下，**spawn 尽可能多的并发子代理**（系统允许的最大安全并发）。
   - 每个子代理收到：明确目标、互斥可写文件白名单、只读权威路径、禁止项、完成时须回报的 diff 摘要。
   - 建议内部优先级（仍由你调度，不要写成「做完来找用户」）：债务最重的 CSS 先清 token（历史参考：workflow → studio → pi → knowledge / today / library → x-lists → topic / results / agents …），同时可对已清 token 的表面并行做层级与文案；**token、层级、文案是同一使命的组成部分**，不要等用户再说「开始 Wave B」。

E3. **父代理合并循环（直到 Done）**
   - 收齐子代理 → 解决冲突 → `node --test tests/design-tokens-drift.test.mjs`
   - 从 allowlist **删除已清条目**（shrink only）
   - 更新内部剩余 offender 表 → 立刻再派下一组互斥子任务
   - **不要**中途对用户说「第一批好了，要不要第二批？」；除非撞上 C1 必须问，或遇到无法自动解决的真实阻塞（缺权限、测试基建坏了等）。

E4. **继续条件**
   - 只要仍存在：allowlist 非空、或 styles-*.css / 相关 TSX 仍有违规硬编码色、或抽查到原则/文案违规 → 继续 E2–E3。
   - 全部 D1–D5 满足 → 进入最终报告。

════════════════════════════════════
五、范围盘点（必须你自己完成）
════════════════════════════════════

至少覆盖（自行核实文件树，可增不可假装没有）：

- 全部 `src/renderer/styles-*.css`（foundation 只读，除非用户批准 brand 外合法变更）
- 主导航与壳层：今日、创作/Studio、Pi dock、智能体、发现/X Lists、选题/提案、资料/知识/主题、结果、设置、引导/onboarding、更新提示等
- 与上述表面绑定的 TSX：仅当必须去掉内联色或修正用户可见文案时修改；改前纳入互斥白名单
- allowlist 里出现的每一个 file+match，最终必须消失或被合法 token 替换

启动时用 allowlist 计数作基线；结束时对照同一文件证明 shrink 到空（或门禁认可的等价状态）。

════════════════════════════════════
六、工作内容（同一使命内完成，勿拆成用户侧 Wave）
════════════════════════════════════

对每个表面，父/子代理应做到：

1. **Token：** hex/rgb/hsl → 最近义 foundation 变量；不确定时选语义最接近的 ink/surface/border/accent/danger 等，禁止新造品牌色。
2. **层级：** 主按钮唯一最强；次要弱化；避免多处同等强调；控制紫实色面积；边界/阴影遵循 Flat-by-Default / One Boundary。
3. **文案：** 用户可见字符串去工程词；保持中文产品语气与现有语气一致，不滥加营销腔。
4. **验证：** 局部改完即可由父代理跑 drift；最终全绿。

════════════════════════════════════
七、验证闭环
════════════════════════════════════

V1. 每次合并后跑：`node --test tests/design-tokens-drift.test.mjs`
V2. 维护剩余 allowlist / offender 计数，单调不增
V3. 抽查高流量表面（今日、创作、Pi、智能体）的一主 CTA 与文案
V4. 若测试红：先修再继续并行；禁止带红扩战
V5. 全部绿灯 + allowlist 空 + 原则抽查通过 → 停止改动，写最终报告

════════════════════════════════════
八、最终报告格式（完成时一次性交给用户）
════════════════════════════════════

用中文，结构如下：

1. **结论：** 是否达到 Definition of Done（是/否；若否列出未闭合项）
2. **范围清单：** 处理过的 styles-*.css 与主要 TSX 表面（完整列表）
3. **Token：** allowlist 起始条数 → 结束条数；drift test 最终命令与结果
4. **原则：** One Violet / 一主 CTA / 用户语言 — 各举 2–3 个已修表面为例
5. **并行执行摘要：** 子代理数量级、文件互斥如何保证、父代理合并次数
6. **未改 / 需用户决定：** 若曾因 brand token 请示或仍有阻塞，单列
7. **风险与后续：** 仅残留真实风险；不要把「下一批任务」塞回给用户

════════════════════════════════════
九、立即执行
════════════════════════════════════

现在开始：读取权威 → 自行盘点全量表面 → 制定互斥并行计划 → **最大化并发子代理开工** → 合并、测、缩 allowlist → 循环直至 D1–D5 全部满足 → 按第八节交最终报告。

禁止：向用户索要页面列表；禁止「先做第一批再来找我」；禁止把 token / 层级 / 文案拆成三次要用户触发的战役；禁止改 brand token 而不问；禁止扩 allowlist；禁止两子代理写同一文件；禁止把 prototype 当 SSOT。

开工。
```

---

## 附：权威与门禁速查（给人看的，不是第二套派活）

| 项 | 路径 |
|---|---|
| Oh My Pi 主入口 | `CLAUDE.md` |
| Machine SSOT | `src/renderer/styles-foundation.css` |
| 活指南 | `docs/design/living-style-guide.html` |
| 漂移测试 | `tests/design-tokens-drift.test.mjs` |
| Allowlist（只缩） | `tests/design-tokens-hex-allowlist.json` |
| 同步脚本 | `scripts/sync-design-doc-from-foundation.mjs` |

历史债务参考（启动时以 allowlist 实况为准，勿当作用户批次）：workflow / studio / pi 通常最重，其余 `styles-*.css` 一并纳入同一使命。
