# AI×个人商业化成长 · 配方落地实施设计

- 日期：2026-08-07
- 状态：Owner 已拍板，进入台账
- 战略方案：`docs/spark/2026-08-07-ai-personal-commercialization-wmb-plan.md`
- 能力审计：会话 `local://wmb-capability-audit.md`（结论已吸入战略方案 B 章）
- 范围：把现有 `official.ai` + `wemedia-intelligence-engine` **拧焦**为商业化成长配方；**不**新开赛道、**不**改发布主链、**不**插队 M-4950 选题台账代码面

---

## 0. Owner 锁定（2026-08-07）

| # | 决议 | 落地含义 |
|---|---|---|
| Q1 | 显示名改为「AI × 商业化成长」 | `official.ai.displayName` |
| Q2 | 小红书 90 天接受「客户端人工发布 + 状态跟踪」 | 本里程碑 **不** 做 xhs prep；PRD 补丁要点另记，不改正文 |
| Q3 | 复盘商业化信号先映射 summary/notes 跑两周 | 本里程碑只交付 **模板文案/Skill**，不加 ReviewRecord 列 |
| Q4 | 升 `officialTemplateVersion` + 现有 AI 根 re-ensure | 必须实现「官方根可升级」路径；`ensure` 现状不够 |
| Q5 | 增补一人公司/工具实测 X List | **配置操作 + 推荐清单**；不写死未验证 list_id |

---

## 1. 问题与约束

### 1.1 现状缺口（实现层）

1. `OFFICIAL_WORKSPACE_TEMPLATES['official.ai']` 仍是泛 AI 文案（displayName=`AI`）。
2. `ensureOfficialWorkspaceProfile`：**已有 profile 直接 return**，升模板版本 **不会** 推到已有数据根。
3. 已有根升级合法路径是 `activateWorkspaceProfile(db, nextProfile, expectedRevision)`，需 `revision = current+1` 且无 running agent task。
4. 每日四问在两处：
   - 运行时硬编码：`src/main/agent-runner.ts` → `dailyPrompt`（真正进模型）
   - Skill/标准：`skills/wemedia-intelligence-engine/**`、`references/opportunity-standard.md`
5. 栏目骨架、复盘商业化三件套、方法种子：**无代码对象**，靠简报/Skill/方法库数据承载。
6. X List 绑定是根内业务配置 + execution grant，**不能**在模板里伪造 list_id。

### 1.2 非目标

- 不改 M-4950（WMB-4946/4947/4948）文件面优先权冲突时让路
- 不做小红书编辑器自动化、不做 xhs/wechat 指标补齐（P2/夜灯）
- 不加 method_findings 聚合 UI（P1 另挂）
- 不加 ReviewRecord 新列（两周后再议）
- 不新建 official 模板 id / 不新建 intelligencePackId

### 1.3 成功标准（里程碑门）

1. 新创建的 AI 根：身份块即为商业化文案。
2. **已有** official.ai 根：启动或显式 ensure 后吃到 template v2 文案（revision+1，officialTemplateVersion=2）。
3. 一次真实/夹具今日判断：机会的 why/angle 能体现五维或商业化四问，不再纯「泛 AI 资讯」。
4. Pi 创作提示能按六栏目骨架约束结构（至少 structureGuidance / Skill 层可见）。
5. Owner 按操作清单可完成 List 增补；无 List 时主灯仍可跑（不制造假 blocker）。
6. 聚焦测试 + typecheck 通过；不强制本里程碑全量改所有历史 package 文案断言（只修被模板默认值打到的测试）。

---

## 2. 目标文案真源（写入代码的最终字符串）

> 战略方案 A 章为产品语言；本节为 **落库/进 prompt 的压缩版**（避免 identity 块过长挤爆上下文）。

### 2.1 `official.ai` template v2

```text
displayName: AI × 商业化成长
audience: 已在用 AI 干活、想靠「内容→信任→付费」独立收入的中文创作者与独立开发者；要可复现实验与真实卡点，不要躺赚话术
contentGoal: 公开用 AI 做内容、跑实验、沉淀方法，把一个人靠内容和产品活下去的路径讲清楚并持续兑现
editorialBrief: 编辑使命=公开用 AI 把自己做成能靠内容和产品活下去的人。五维=认知/技能/表达/获客/产品化。优先：真实实验与公开开发回执、可复现用法、受众重复问题、可变现/可产品化信号。降权：纯公告搬运、宏大综述、无观点热点、无法验证的赚钱承诺。机会按 SSS–F 全保留合格项。发布是夜灯（X 主战场；小红书客户端人工发）。
officialTemplateVersion: 2
```

platforms / packs 不变：`wemedia-intelligence-engine@1`、`wmb-core-creation@1`、`x|xiaohongshu|wechat`。

### 2.2 商业化判断四问（写入 dailyPrompt + opportunity-standard）

在保留现有「为什么是现在 / 为什么是你 / 独特说法 / 证据」执行骨架上，**叠加**身份校验句（不拆 JSON schema）：

```text
每个机会在四问之外必须点明：命中五维哪一环（认知/技能/表达/获客/产品化）；
说不出环节 → 降权或丢弃。值得尝试要有可动手动作；无实验/无观点的公告搬运不进方案。
需求信号仅当重复问题信号出现时轻点一句，禁止硬造变现故事。
```

### 2.3 六栏目（写入 editorialBrief 附注 + creation/operator Skill，不进 DB 新表）

压缩进 `editorialBrief` 末尾或独立 reference 由 Skill 引用：

1. 实验日志 30% — 目标→动作→AI插手→卡点→回执→无效步骤→下一步  
2. 开发日志 20% — 今日一刀→回执→余味  
3. 原则卡 15% — 判断→物证→边界→反例  
4. 机会判断 15% — 为何现在→强观点→标题/开头→来源  
5. 周复盘 10% — 兑现→图景→追问原话→重复问题→需求信号→K/S/C  
6. 变现实验 10% — 仅真实成交/失败：场景→报价→过程→结果→教训  

创作时：`structureGuidance` 必须点名栏目并套骨架；禁用写法见战略方案 A7。

### 2.4 复盘商业化三件套（映射，无新列）

写入 `skills/wemedia-buddy-operator`（或 reviews 相关指引）固定模板：

```text
【商业化信号】
- 追问原话：（平台/篇目 + 原话 ≥2）
- 重复问题：（问题 + 次数；≥3 → 需求信号候选）
- 需求信号：（有人是否问工具/模板/服务；最小形态假设）
【本周】兑现了什么 | 图景是否还真 | 五维偏科 | K/S/C
```

`ReviewRecord.summary` 前半 Keep/Stop/Change；三件套进 `summary` 后半或 notes（以当前 reviews API 实际字段为准，实施时读 `reviews.ts` 对齐，**不加列**）。

### 2.5 方法种子 12 条

战略方案 A12 原文；通过一次性脚本或 Owner 操作说明写入 `method_findings`（status 可用的可引用态）。优先 **fixture/脚本 + 文档**，避免脏写生产根；生产根由 Owner 在 WMB 内确认导入或首周复盘手录。

---

## 3. 代码改动设计

### 3.1 WMB-4961 — 模板 v2 + 官方根 re-ensure

**文件：** `src/main/workspace-profiles.ts`（主）、相关 tests

**改动：**

1. 更新 `OFFICIAL_WORKSPACE_TEMPLATES['official.ai']` 为 §2.1，`officialTemplateVersion: 2`。
2. 新增纯函数，例如：

```ts
export function buildOfficialTemplateProfile(
  templateId: OfficialTemplateId,
  revision: number
): WorkspaceProfileV1
```

3. 扩展 `ensureOfficialWorkspaceProfile` 语义（**仅 official 血统**）：

```text
if (!existing) insert template@revision1 (但 ai 模板 version 字段=2，revision 仍从 1 起 for brand-new)
if existing.officialTemplateId === templateId
   AND existing.officialTemplateVersion < template.officialTemplateVersion
   AND profileStillOfficialLineage(existing, templateId)  // 见下
   AND no running agent_tasks
→ activateWorkspaceProfile(existing.revision → +1) 写入新文案与新 officialTemplateVersion
else return existing
```

**血统判定 `profileStillOfficialLineage`（防覆盖用户自定义）：**

- `officialTemplateId` 匹配；且
- `profileId` 仍为官方 `profile.ai.official`；且
- 可选：`intelligencePackId` 仍为模板 pack  
- **不要** 用 displayName 相等判断（用户可能已手改名）  
- 若用户曾用 `activateWorkspaceProfile` 改成完全自定义但仍留着 officialTemplateId——用 profileId + officialTemplateId 双条件；若 Owner 根是 enroll 官方根，应满足。

4. **启动路径：** 确认 `enroll` / 打开 AI 根时会调用 `ensureOfficialWorkspaceProfile`（`workspaces.ts` 已有）。若仅首次插入、日常 open 不 ensure：在 `ActiveWorkspaceRuntime.open` 或 data-root 激活后对 official 根补一次 ensure（选 **单一** 调用点，避免双写；实施时 grep ensure 调用链定夺）。

5. **测试：**
   - 新根：文案=v2  
   - 旧根 version=1 官方血统：ensure 后 version=2、revision+1、文案更新  
   - 旧根 officialTemplateId=null 自定义：ensure 不改  
   - running task 时：不升级、不抛致命（返回 existing 或可预期错误——选 **跳过升级** 更稳）  
   - 修 `editorial-brief.test.mjs` 等依赖旧「AI」displayName 的断言

### 3.2 WMB-4962 — 判断 prompt + 情报 Skill 拧焦

**文件：**

- `src/main/agent-runner.ts` — `dailyPrompt` 判断要求段  
- `skills/wemedia-intelligence-engine/SKILL.md`  
- `skills/wemedia-intelligence-engine/subskills/opportunity-editor/SKILL.md`  
- `skills/wemedia-intelligence-engine/references/opportunity-standard.md`  
- 若存在 operator 同步拷贝：按仓库既有「三份 hash 一致」规则同步  
- `tests/agent-runner.test.mjs`（prompt 片段断言）

**改动要点：**

1. `dailyPrompt` 第 1–2 条注入商业化身份与五维命中要求（§2.2）；**不改** JSON schema 字段名。  
2. `structureGuidance` 说明行加：`须点名六栏目之一并套对应骨架`。  
3. opportunity-standard 四问与编辑器 Skill 与上对齐；中骗边界一句。  
4. 情报引擎「内容立场」补：主菜判断/创作，禁止自动发帖叙事。

### 3.3 WMB-4963 — lane-gate 文案与赛道描述

**文件：** `src/main/agent-runner.ts` gate section 文案；必要时 `lane-gate.ts` 注释/reason 展示文案；`tests/lane-gate-*.mjs` 仅当文案断言存在时改

**改动：**

- Tier1 提示：相关 = 服务「AI×商业化成长 / 五维」；  
- irrelevant 示例导向：lifestyle 噪音、纯宏大行业综述、躺赚毒鸡汤（reasonCode 仍用现有枚举，不扩库除非已有合适 code）。  
- **不改** Tier0 官方源直通逻辑。

### 3.4 WMB-4964 — 创作/复盘/方法种子（Skill + 文档 + 可选种子脚本）

**文件：**

- `skills/wemedia-buddy-operator/SKILL.md`（及同步副本）  
- `skills/evidence-grounded-writer/SKILL.md`（若创作路由打到它：加栏目骨架引用，避免空话扩写）  
- `.ai/commercialization-method-seeds.md`（12 条可粘贴）  
- 可选：`scripts/seed-commercialization-method-findings.mjs`（只写临时 DB 或显式路径，默认 dry-run）

**复盘：** 仅模板，无 schema。  
**方法种子：** 文档必交付；脚本可选。

### 3.5 WMB-4965 — Owner 操作清单 + 实机/夹具验收

**交付：**

- `.ai/wmb-4965-owner-ops-checklist.md`  
  - 设置里确认显示名  
  - 新建/绑定 X List 推荐方向（一人公司、工具实测；**不写死 list_id**）  
  - 官网源增补建议（定价页/独立开发者服务商——能配多少配多少）  
  - 回执习惯：实验后 source 或 content note  
  - 小红书人工发口径  
  - 14 天 runbook 指针（战略方案 §5）  
- 验收证据：`.ai/wmb-4965-evidence.md`  
  - 夹具或实机：`assembleEditorialBrief` 身份块字段快照  
  - 一次 judge prompt 含五维/商业化句子（单测即可算代码验收；实机 Today 截图加分）

### 3.6 明确延后（写入战略方案已有 P1/P2，本里程碑不建 task 或只建 todo 占位）

| 项 | 何时 |
|---|---|
| 方法库聚合 UI | P1 另里程碑 |
| Review 专用字段 | 两周样本后 |
| 需求信号自动候选 | P2 |
| 小红书 prep | P2；口径已接受人工 |
| PRD 5.4 补丁句 | 文档任务可选，不阻断 |

---

## 4. 任务链（台账）

里程碑：**M-4960** AI×个人商业化成长配方落地  

| Task | 内容 | Depends | 类型 |
|---|---|---|---|
| WMB-4960 | 冻结本设计 + 挂链 + Owner 决议入档 | — | docs/ledger |
| WMB-4961 | official.ai v2 + ensure 升级路径 + tests | 4960 | code |
| WMB-4962 | dailyPrompt + intelligence Skill/standard 商业化四问与栏目 | 4960 | code+skill |
| WMB-4963 | lane-gate/判断门文案拧焦 | 4961,4962 | code |
| WMB-4964 | operator/复盘模板 + 方法种子文档（+可选脚本） | 4960 | skill+docs |
| WMB-4965 | Owner ops checklist + 验收证据 | 4961–4964 | docs+verify |

**并行：** 4961 ∥ 4962 ∥ 4964（4960 完成后）；4963 在 4961+4962 后；与 **WMB-4946/4947** 并行时避开 `proposals*` 文件。

**CAP：** 主要 CAP-002/003/014/015/021（文案与身份注入，不改授权模型）。

---

## 5. 未来 PRD 补丁要点（不改正文，仅记录）

1. 首个 AI 官方工作空间编辑身份对齐「AI × 个人商业化成长」。  
2. 小红书：90 天内「客户端人工发布 + 状态跟踪」为可接受交付口径。  
3. 叙事 Priority 不变。

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| ensure 升级覆盖用户手改受众 | 仅 official 血统 + profileId 官方 |
| running task 时升级失败 | 跳过升级，下轮 open 再试 |
| 测试大量写死 displayName `AI` | 4961 修直接依赖 ensure 默认值的测试 |
| List 无 id 无法代码化 | Owner checklist，不造假绑定 |
| 与 4946 抢主做 | 台账 496\* 保持 todo，主做仍 4946 直到 Owner 切 |

---

## 7. 实施顺序（执行者 checklist）

1. 落地 4961 模板+ensure（先测试再实根）  
2. 落地 4962 prompt/Skill  
3. 落地 4963 gate 文案  
4. 落地 4964 模板与种子文档  
5. 4965 验收写证据  
6. Owner：绑定 List、开 14 天实验（产品外）

---

## 8. 与战略方案映射

| 战略 P0 | Task |
|---|---|
| P0-1 配方拧焦 | 4961 + 4962 + 4963 |
| P0-2 栏目骨架 | 4962 + 4964 |
| P0-3 情报源 + 回执习惯 | 4965 checklist（List/源）；回执=习惯不写代码 |
