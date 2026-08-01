# 今日情报 · 官宣导线重构方案

Status: done (W0–W2 2026-07-31); List members_add prepared pending user confirm
Date: 2026-07-31  
Trigger: 今日漏抓 **DeepSeek-V4-Flash**、**Seedance 2.5**；根因不是主题 UI，是 A 类官宣未走硬导线  
Scope: 今日情报最小业务闭环 —— **导线保命 + 记者增亮 + 编辑裁决**  
Owner constraint: **已绑定 X List「AI前沿」必须进入今日情报扫描队列**；必要官方账号/对象要能进该列表  

Related:
- Skill: `skills/wemedia-intelligence-engine/`
- Runtime: `src/main/agent-runner.ts`（6 主题航线 × Pi 4min）
- X Lists: binding `AI前沿` `list_id=2082851520417255750` `@KimbomArtist`
- Evidence: DB 中 deepseek/seedance/即梦 相关 `source_items` = 0

---

## 0. 一句话

> **大厂发版是通讯社电讯，不是记者今天运气好不好。**  
> 今日情报第一段必须变成：**按信源打卡表 + 已绑定 AI前沿 List 做导线巡检**；Pi 只解释与选题，不再负责“有没有发版”。

---

## 1. 问题诊断（有证据）

### 1.1 现象

| 事件 | DB |
|---|---|
| DeepSeek V4 Flash | 0 条 |
| Seedance 2.5 / 即梦 / volcengine | 0 条 |
| 今日入库 | 以 HN/社区/评测为主 |

### 1.2 已有资产（不应推倒）

1. **Skill 编辑部骨架完整**：scout / evidence / opportunity / source-registry / collectors。  
2. **`source-index.json` 已有 primary+release 池**（OpenAI/Anthropic/Google…），但 DeepSeek 仅 GitHub org；**无字节/Seed/即梦**。  
3. **X Lists 已产品化**：绑定、timeline cache、MCP（`wmb_list_x_list_bindings` / `wmb_read_x_list_timeline` / members…）。  
4. **「AI前沿」已绑定且 enabled**，并有 timeline 缓存；但 **不在 daily_intelligence 队列里**。

### 1.3 断裂点

| 断裂 | 现状 | 后果 |
|---|---|---|
| 名单 ≠ 打卡 | Skill 写“从 source-index 选两类”；runner 跑 6 条主题航线 | Pi 即兴搜，不逐源打卡 |
| 源表缺口 | DeepSeek 无官网/changelog；字节系全无 | 发了也扫不到 |
| 失败传染 | 官方航线整段 4min，一端挂了易整线隔离 | OpenAI 挂 → 整条官方线凉 |
| X List 旁路 | AI前沿只服务发现页/人工浏览 | 最强实时雷达没进保命队列 |
| A/C 策略混用 | SOP“先扫两类”适合社区 | 不适合官宣 |

### 1.4 新闻部分工（本方案采用）

```text
导线（机器/确定性）  →  A 类官宣 + 绑定 List 动态 必扫
记者（Pi）            →  解释、冲突、角度、机会
编辑（规则函数）      →  定级、去重、归主题、进今日
```

---

## 2. 目标闭环（最小可验收）

```text
[导线层]
  1) primary+release 官方源表逐条拉取（单源失败不传染）
  2) 所有 enabled 的 X List bindings（至少 AI前沿）拉 timeline
  3) 命中 → source_items（去重）+ 可选 record_knowledge
        ↓
[编辑层]
  4) 定级 A/B/C；A 默认高优进今日
        ↓
[记者层]
  5) Pi 只基于已入库资料做机会/判断（可再补 B/C 航线）
        ↓
[验收]
  6) DSV4-Flash、Seedance 2.5 能稳定入库并在今日可见
```

成功标准：

1. **漏发可归因到具体源 ID 变红**，而不是“今天 Pi 没聊到”。  
2. **AI前沿 List 每次今日情报必跑**（enabled binding）。  
3. **单源失败不影响其他源**。  
4. 人可补录并反哺源表（P1）。

---

## 3. 信息架构：扫描队列长什么样

今日情报队列分 **三段**，顺序固定：

### Stage W0 — 绑定 X List 导线（硬）

输入：`x_list_bindings` where `enabled=1`  
当前必有：

| account | list_id | name |
|---|---|---|
| @KimbomArtist | 2082851520417255750 | **AI前沿** |

动作：

1. `read_timeline`（可先读 cache，再 refresh；refresh 失败则用 cache + 标 stale）  
2. 每条 post → 候选线索（signal）；若作者是官方账号或帖内含官方链接 → 升 A 候选  
3. 写入 `source_items`（URL= post url 或解析出的官方 URL；保留 tweet 为证据链）  
4. checkpoint：`completedListIds: string[]`

**Owner 要求落地：**

- AI前沿 **必须**在队列；  
- 必要官方账号（DeepSeek / ByteDance Seed / OpenAI / Anthropic / Google …）应作为 **List 成员** 被维护；  
- 成员维护走现有 X List 能力（members_add 操作流），方案层定义“该有谁”，执行层可半自动建议 + 人工确认。

### Stage W1 — 官方网页/文档导线（硬）

输入：`source-index.json` 中  
`enabled && trust_level==primary && roles includes release`  
（可再加 `kind in official_*`）

动作：逐源 fetch（collector 路由），解析最近更新，入库。  
checkpoint：`completedSourceIds: string[]` + per-source health。

### Stage W2 — Pi 增亮航线（软，可缩）

保留现有主题航线中的 **B/C**（社区/Skill/案例等），但：

- **不再承担 A 类发现责任**  
- 官方航线从“Pi 自由搜”改为“只消化 W0/W1 已入库 A 类 + 补漏提示”  
- 超时/失败不否定 W0/W1 成果

---

## 4. 源表合同（source-index 升级）

### 4.1 必补条目（P0）

在 `skills/wemedia-intelligence-engine/references/source-index.json` 增加/修正：

**DeepSeek（多通道）**

- 官网/新闻或博客（若有稳定 URL）  
- API 文档 / changelog（platform 域）  
- 保留 `deepseek-github` 作 code/release 镜像  

**字节系视频/模型（Seedance 入口）**

- 火山引擎 / 即梦 / Seed 官方发布或文档页（实施时用可稳定打开的官方 URL；无稳定页则先用 **X 官方账号 + List** 兜底并标 `wire_via: x_list`）  
- 相关 GitHub/HF 若存在再加 secondary  

**原则：**  
A 类至少 **双通道**（官网/文档 + X 或 GitHub）。单通道允许上线但 health 标 `single_path`。

### 4.2 字段建议（最小增量）

现有字段保留。可选增强（不必一次 migration）：

```json
{
  "id": "deepseek-api-docs",
  "wire_priority": 10,
  "wire_group": "official_release",
  "channels": ["web", "x", "github"],
  "x_handles": ["@deepseek_ai"],
  "must_check": true
}
```

P0 若怕改 schema：用约定  
`must_check = trust_level==primary && roles.includes('release') && enabled`。

### 4.3 AI前沿 List 成员合同（Owner 要求）

List 不是装饰，是 **实时官宣雷达**。成员应覆盖：

**厂商/产品官号（示例，实施时以可验证 handle 为准）**

- DeepSeek 官方  
- OpenAI / Anthropic / Google DeepMind / xAI  
- 字节 Seed / 即梦 / 火山相关官号  
- 其他你已认定的前沿信号号（研究员可 `professional`，不替代官号）

维护流程：

1. 方案/脚本给出 **建议 members 清单**（diff 当前 members）  
2. 通过 X Lists `members_add` 准备→确认（已有 operation 流）  
3. 绑定保持 enabled  
4. 今日情报 W0 只认 **bindings.enabled**，不认“发现页随手点开”

---

## 5. 运行时改造（agent-runner）

### 5.1 队列伪代码

```text
startDailyIntelligence:
  W0: for list in enabledBindings:
        try refresh timeline; on fail use cache+warn
        upsert posts/official links as sources
        checkpoint listId
  W1: for src in primaryReleaseSources:
        try collect(src); on fail mark health red; continue
        checkpoint sourceId
  W2: optional Pi routes for B/C + synthesis plan
  complete if workbench has sources/opportunities readback
```

### 5.2 与现网兼容

- checkpoint 从只 `completedRoutes` 扩展为：

```ts
{
  completedRoutes?: string[];      // 旧 W2
  completedListIds?: string[];     // 新 W0
  completedSourceIds?: string[];   // 新 W1
  sourceHealth?: Record<string, { ok: boolean; at: string; error?: string }>
}
```

- 旧任务可继续；新字段缺省当空。  
- **W0/W1 尽量确定性代码路径**（Node fetch + 现有 x-list browser），少依赖 Pi 超时。  
- Pi 仍写 plan/机会；A 类入库不依赖 Pi。

### 5.3 Skill 文案同步（小改，大影响）

`collection-sop.md` / 主 SKILL：

- A 类：`must_check` 源 **全量打卡**，禁止“先两类”。  
- C 类：仍可抽样。  
- 明确：`enabled x_list_bindings` 属于导线，不是可选社区彩蛋。  
- `collectors/x.md`：增加 **X List timeline** 路径（bindings → timeline → 官方链接回源）。

---

## 6. 数据写入合同

### 6.1 source_items

- 官宣页：`original_url` = 官方 canonical  
- 推文线索：`original_url` = status URL；summary 含作者与要点；若解析到官方链接，**另存/关联**官方 URL（优先官方为 primary）  
- 去重：现有 URL/指纹  
- priority：A 类默认高（0–2 档），具体映射进 opportunity 时再判  

### 6.2 不在 P0 做

- 全自动关注全世界  
- 向量检索  
- 新爬虫平台 UI  
- 替换整份 Skill 哲学（侵略性表达等保留）  
- 主题页/资料库 UI  

---

## 7. 分阶段实施

### Phase W0 — 合同与名单（可当天）

1. 重写本计划（本文）✅  
2. 补 `source-index.json`：DeepSeek 多通道 + 字节/Seedance 通道  
3. 更新 `source-index.md` 核心池文案  
4. 导出 AI前沿 **建议 members** 清单（相对当前 members 的 diff）  
5. 校验脚本：`validate_source_index.mjs` 通过  

验收：

- [x] source-index 含 deepseek 非仅 github  
- [x] source-index 含 bytedance/seed/jimeng 至少一条稳定入口或显式 `wire_via:x_list`  
- [x] 文档写明 AI前沿 list_id 与绑定账号  

### Phase W1 — 队列接线（核心）

1. `agent-runner`：W0 绑定 List → W1 primary release → W2 Pi  
2. X List：优先 cache，再 live refresh；失败隔离  
3. progress 文案：`正在巡检 X List：AI前沿` / `正在巡检官方源：DeepSeek …`  
4. MCP/Skill 提示词：禁止 Pi 跳过 W0/W1  

验收：

- [ ] 跑今日情报日志出现 AI前沿 list_id  
- [ ] 人为 mock/实网：List 新帖或官方页更新能进 `source_items`  
- [ ] OpenAI 源失败时 DeepSeek/List 仍继续  

### Phase W2 — 验收钉与补录

1. 针对 **DSV4-Flash、Seedance 2.5** 做补录或复跑，确认链路  
2. 今日页 A 类置顶（若今日排序仍按旧逻辑，最小改 workbench 新鲜度+官宣加权）  
3. 源健康只读查询（MCP 或设置页一行，可 P1）  
4. 手工补录 API/入口（P1）  

验收：

- [ ] 两条新闻在库且今日可见  
- [ ] 复跑不产生脏重复（URL 去重）  

### Phase W3 — List 成员治理（与 Owner 列表要求闭环）

1. 建议 members 一键生成 operation（members_add）  
2. 人工确认后写入 List  
3. 定期：members 与 source-index `x_handles` 对账  

---

## 8. 文件清单

**必改**

- `INTELLIGENCE_WIRE_PLAN.md`（本文）  
- `skills/wemedia-intelligence-engine/references/source-index.json`  
- `skills/wemedia-intelligence-engine/references/source-index.md`  
- `skills/wemedia-intelligence-engine/references/collection-sop.md`  
- `skills/wemedia-intelligence-engine/references/collectors/x.md`  
- `skills/wemedia-intelligence-engine/SKILL.md`（A/C 策略一句）  
- `src/main/agent-runner.ts`  

**按需**

- `src/main/x-list-execution.ts` / timeline cache helpers（W0 refresh）  
- `src/main/sources.ts`（若需 official 标记字段）  
- `src/main/workbench.ts`（A 类置顶）  
- `tests/*intelligence*wire*`（新 focused）  
- X List members 操作（产品已有，走 prepare/confirm）  

---

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 官方页反爬/地区限制 | 双通道；失败标红不阻断；X List 作镜像 |
| List 时间线噪声大 | 官号/链接收紧；专业号仅 signal；编辑层过滤 |
| Pi 与导线重复入库 | URL 去重；W2 禁止再“发现”已 checkpoint 源 |
| members_add 需登录/确认 | 保持人工确认；建议清单自动、写入半自动 |
| 把 AI博主/薅羊毛列表也强扫 | **默认只扫 enabled bindings**；Owner 可关；本方案强制至少 AI前沿 enabled |

---

## 10. 明确非目标

- 重做主题页 UI  
- 发现页榜单替代导线  
- 取消 Pi（Pi 仍做机会与表达）  
- 一次接入 100 家源  
- 自动发布  

---

## 11. 决策（已采纳）

1. 导线 / 记者 / 编辑 三分 — **采纳**  
2. A 类靠打卡表，不靠 Pi 灵感 — **采纳**  
3. **AI前沿 X List 进入今日情报硬队列** — **Owner 要求，采纳**  
4. 必要官方对象进 AI前沿成员 — **Owner 要求，采纳**  
5. 先 W0 名单+合同，再 W1 runner — **默认**  

---

## 12. 建议立即执行顺序

```text
1. 补 source-index（DeepSeek 多通道 + 字节/Seedance）
2. 固化 AI前沿 list_id 为 daily W0 必扫
3. agent-runner 插入 W0/W1 checkpoint
4. 建议并（半自动）补齐 List 官方成员
5. 用 DSV4-Flash + Seedance 2.5 做端到端验收钉
```

无新异议则按 Phase W0 → W1 开工。
