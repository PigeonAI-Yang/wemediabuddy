# 主题页重构方案（飞轮轴承版）

Status: done (F0–F2 implemented 2026-07-31)
Date: 2026-07-31  
Supersedes: 同文件先前「资料库·主题工作台 / Phase A-B-C done」稿  
Scope: 一级导航 `主题` 页的信息架构、视觉语义与默认阅读路径  
Non-scope: 资料库 IA、重新发现算法、Domain Map、Canvas 能力扩展、自动写判断

---

## 0. 一句话

**主题页不是知识库后台，是知识飞轮的轴承：**  
让人在某个长期主题上，快速接上「现在信什么 → 凭什么 → 历史教了什么 → 下一步怎么转」。

成功标准不是资料全、分类全，而是：

> 打开主题后 3 秒内，能做出比上次更好的判断，并知道为什么。

---

## 1. 飞轮里它是什么

### 1.1 闭环（来自 CAP-015 / compounding）

```text
新资料（今日/发现）
  → 归入稳定主题
    → 形成/修正判断
      → 机会与内容（创作）
        → 发布与复盘
          → 回流主题判断
            → 再遇新资料时更快更准
```

复利发生在 **判断被反复使用并变强**，不在页面功能变多。

### 1.2 各页分工（不可抢戏）

| 页面 | 职责 | 不是 |
|---|---|---|
| 今日 / 发现 | 新东西进来 | 长期判断主场 |
| **主题** | **跨天判断单元的续写与调用** | 资料管理后台 / 迷你知识库 SaaS |
| 资料库 | 单条证据生命周期 | 主题阅读主路径 |
| 创作 | 把判断写成稿 | 主题归档 |
| 发布 / 结果 | 交付与表现 | 判断编辑器 |
| 画布 | 临时关系整理 | 真相库 / 主入口 |
| 完整档案 | 深挖 8 类历史 | 默认首页 |

### 1.3 主题页必须完成的 3 个飞轮动作

1. **续上判断**：现在信什么；关键证据/反证。  
2. **承接回流**：机会/内容/复盘 keep·stop·change 如何修正判断。  
3. **送去下一轮**：去创作、标观察、等新资料——不把人留在档案里。

做不到这三件 = 页存在但飞轮空转。

---

## 2. 现状诊断（相对飞轮目标）

代码与实机已具备：一级 `topic` 路由、`LibraryTopicsView`、dossier 真判断源、资料 revision 操作、deep mode、Pi topic context。

但语义仍偏「知识库产品」：

| 问题 | 表现 | 飞轮伤害 |
|---|---|---|
| 双层宣传头 | `library-home-head`（长期记忆…）+ 内头 `长期主题` | 先受教育，后干活 |
| 与外页语义断裂 | 今日/发现/创作是操作台；主题是子系统 | 认知切换成本高 |
| 默认信息过载 | 筛选 chip + 统计卡 + segment + 完整档案 + 放画布同时抢视线 | 判断不是第一焦点 |
| 结构像 App-in-App | 自创 `library-topic-*` 体系，不像 studio 满高分栏 | 「另一个产品」感 |
| 回流弱于陈列 | 机会/复盘在 segment 深处，默认不像「教训」 | 复利不可感 |
| 下一步弱 | 缺少明确「基于此判断去创作 / 标记观察」主行动 | 飞轮断在出口 |

工程上 Phase A 的数据真源方向仍保留（dossier judgments，禁止 findings 正则冒充）。  
本版方案 **改的是优先级与页面语义**，不是推倒后端。

---

## 3. 产品定义（锁死）

```text
主题 = 可复利的判断单元
主题页 = 维护并调用这些判断单元的地方
```

默认屏只突出四块（顺序即优先级）：

1. **当前判断**（可空，空也必须诚实）  
2. **关键证据 / 反证**（服务判断，不是资料库翻版）  
3. **历史回流**（机会 → 内容 → 复盘 keep/stop/change）  
4. **下一步**（去创作 / 观察 / 完整档案后置）

列表、搜索、状态过滤、完整档案、画布 = 附属，不是主角。

### 3.1 明确非目标

- 知识图谱主页、canvas-first  
- Domain Map 回归主导航  
- 默认 8-tab 档案倾倒  
- 自动合并主题 / 向量检索 / 因果归因文案  
- 恢复上下文包产品面  
- 把资料库重新嵌进主题页  
- 为“系统感”增加第三层导航

---

## 4. 目标信息架构

### 4.1 导航（已部分落地，保持）

```text
知识资产
├─ 主题      ★ 一级（本方案）
├─ 资料库    资料 + 重新发现
└─ 关系画布  后置整理
```

全局搜索点主题 → `navigate('topic')` + `wmb-open-library-topic`（已有）。  
资料上下文「打开主题」→ 同上。

### 4.2 页面布局（对齐创作页语义）

参考 `studio-view` 满高主从，而不是 `library-page` 长卷说明文。

```text
┌─ topic-layout（满高，无外页宣传头）─────────────────────────────┐
│ ┌ list 280-320 ┐  ┌ work ─────────────────────────────────────┐ │
│ │ 搜索          │  │ 单行对象头：title · status · 一行 meta      │ │
│ │ 轻过滤（可选） │  │ 主行动：去创作 | 更多…（档案/画布）         │ │
│ │ 主题行列表     │  │──────────────────────────────────────────│ │
│ │ title         │  │ tabs（轻）：判断 | 证据 | 回流               │ │
│ │ meta 一行     │  │──────────────────────────────────────────│ │
│ │               │  │ 主列：当前 tab 内容（判断优先）              │ │
│ │               │  │ （宽屏可选：证据缩略 rail，不默认三列看板）   │ │
│ └───────────────┘  └──────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

### 4.3 与旧方案的关键差异

| 旧（工作台/档案） | 新（飞轮轴承） |
|---|---|
| 资料库内 tab「主题」 | 一级「主题」 |
| 外层 eyebrow 说明文 | **删除** 外层 `library-home-head` 宣传块 |
| 默认三列/重 segment 看板 | 默认 **判断优先单主列** |
| 统计 2×2 卡片墙 | **一行 meta** |
| 完整档案与主路径同级 | **更多菜单后置** |
| 像知识库 SaaS | 像 **创作页的长期版** |

### 4.4 三个轻 tab 的内容合同

| Tab | 主内容 | 真源 | 禁止 |
|---|---|---|---|
| **判断**（默认） | `judgments`（plan POV）；空态诚实；method_findings 仅次级且标明「不是当前判断」 | dossier `judgments` / `method_findings` | findings 正则冒充 |
| **证据** | 支撑证据 + 反证分组；relation；核验/管理快捷（有 revision 时） | dossier `sources` + `counter_evidence` | 做成完整资料库翻版 |
| **回流** | 机会 → 内容 → 复盘（keep/stop/change）时间序；文案用「关联」不写因果 | context opportunities + dossier content_history / reviews / metrics | 只显示 count meta |

### 4.5 列表行合同

一行可读：

- title  
- status（active / watching / dormant；archived 默认不进）  
- 相对 lastSeen  
- sourceCount · opportunityCount（content/pub 有则显示，不撑爆一行）

搜索 + 状态过滤保留，但是 **列表工具**，不是页头英雄区。

### 4.6 主行动合同

右栏对象头主行动（最多 1 个主按钮 + 溢出）：

- **去创作**：有关联 project → `onOpenStudio`；无则进入创作新建路径（若现网无「从主题新建」API，则先 `navigate('studio')` 并带 topicId 到 localStorage，P1 补创建）  
- 更多：完整档案、放画布、（P1）标记 watching

---

## 5. 视觉与设计语义

### 5.1 对齐外页的规则

1. **不要第二套产品皮肤**：复用 studio 分栏节奏、page-heading/对象头密度、editor-tabs 级 tab。  
2. **一个页头就够**：对象头 = 标题行，不写飞轮说明文。  
3. **满高工作台**：`topic-layout` 占满 workspace，避免 page 长滚动 + 内嵌再滚动的双滚动地狱。  
4. **主列优先**：判断长文可读；证据/回流服务判断。  
5. **空态是产品**：无判断时写清「尚未沉淀判断」，引导从证据或今日机会来，不塞假内容。

### 5.2 建议 class 语义（实施时可渐进）

- 外层：`topic-layout`（对标 `studio-layout` / `studio-library` 的满高思路）  
- 列表：`topic-list-pane`  
- 右栏：`topic-work-pane`  
- 对象头：`topic-object-head`（单行 + meta + actions）  
- tabs：`topic-work-tabs`（对标 `editor-tabs` 视觉权重）  
- 废弃作为默认的：外层 `library-home-head` 在 topic 路由上的使用、重型 `library-topic-stats` 卡片墙作为第一视线

保留 dossier/API 层；CSS 可先映射重排，再收敛命名。

---

## 6. 数据与状态（继承，不推倒）

### 6.1 继续使用

- `listKnowledgeTopics` 分页页包 + contentCount/publicationCount  
- `getKnowledgeTopicDossier` 为判断/证据/档案真源  
- `getKnowledgeContext` 补 opportunities  
- `wmb-open-library-topic`  
- Pi：`view==='topic'` 时 objectType=topic  

### 6.2 默认加载策略（服务判断优先）

进入主题 / 切换主题：

1. 并行：list（若需）+ dossier judgments（header counts）+ sources 摘要（供判断旁证或 rail）  
2. 默认 tab = 判断  
3. 回流 tab 懒加载  
4. 完整档案仅在用户打开时加载  

### 6.3 状态边界

- 主题页 state 与资料库 source drawer state 继续隔离  
- 离开 `topic` 视图清除 Pi topic context（已有）  
- 不在主题页恢复 library 三 tab  

---

## 7. 分阶段实施

### Phase F0 — 语义复位（P0，一个 PR）

**目标：** 看起来像 WMB 操作台，默认先看到判断。

1. 去掉 topic 路由外层 `library-home-head` 宣传头（`main.tsx` 薄包装改为满高 `topic-layout` 壳）。  
2. `LibraryTopicsView` 默认布局改为满高主从；对象头单行化；统计改一行 meta。  
3. 默认 tab=判断；去掉默认三列看板感。  
4. 完整档案 / 放画布 移入「更多」或次级按钮。  
5. 回流 tab 文案与结构强调 keep/stop/change 教训，而非陈列。  
6. 主行动「去创作」可见（能 navigate studio；有 projectId 则直达）。  
7. 视觉权重向 studio/editor-tabs 靠拢（不等全面 redesign 也可先减噪）。

验收：

- [ ] 侧栏点「主题」：无「长期记忆/跨天…」说明英雄区  
- [ ] 首屏主视线是当前判断（或诚实空态），不是统计卡/档案  
- [ ] 判断仍来自 dossier judgments，无 regex 假判断  
- [ ] 证据 tab 可见 relation/反证；回流可见复盘 K/S/C（有数据时）  
- [ ] Pi 仍为 `主题 · {title}`  
- [ ] `npm run typecheck` 绿；library-topics-open 契约测试绿  
- [ ] 与创作页并排截图：同为满高主从操作台，而非两套产品

### Phase F1 — 飞轮出口（P1）

1. 从主题一键创建/打开创作（topicId 关联，若缺 API 则补最小后端）  
2. 列表 watching 过滤与「标记观察」  
3. 宽屏判断主列 + 证据 rail（可选，不回归三列等重）  
4. 回流条目跳转结果/发布（若有 id）  
5. 今日/资料「归入本主题」的回跳锚点统一  

验收：

- [ ] 有内容项目的主题可一键进创作  
- [ ] 回流 keep/stop/change 可展开阅读  
- [ ] 完整档案 counts 与对象头 meta 一致  

### Phase F2 — 收敛（P2）

1. 键盘：列表上下、1/2/3 切 tab（可继承现有）  
2. CSS 命名与死规则清理  
3. focused 测试：默认 tab=判断、无外层宣传头 DOM  
4. 文档与 compounding 计划交叉链接更新  

---

## 8. 文件清单（实施时）

**必改**

- `src/renderer/main.tsx` — topic 壳层去宣传头、满高挂载  
- `src/renderer/library-topics-view.tsx` — 信息架构与默认路径  
- `src/renderer/styles-knowledge.css`（及必要的 workflow）— 操作台语义  

**按需**

- `src/main/knowledge.ts` — 仅 F1 需要「从主题创建项目」时  
- `tests/library-topics-open.test.mjs` — 契约随壳层微调  
- `KNOWLEDGE_COMPOUNDING_PLAN.md` — 补一句「主题页=飞轮轴承」交叉链  

**只读锚点**

- `src/renderer/studio-view.tsx` — 满高主从语义参考  
- `getKnowledgeTopicDossier` / `topicDossierCategories`  

---

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 减噪被当成砍功能 | F0 只改默认优先级与壳；能力进「更多/tab」 |
| 又做成三列看板 | 验收截图对照 studio；禁止默认三列 grid |
| Vite CSS 热更新丢规则 | 样式走已 import 的 knowledge 链；改后硬刷新验收计算样式 |
| 无判断时页面「空」 | 空态文案 + 证据/回流仍可达；不造假判断 |
| 与旧方案文档混淆 | 本文件 status=proposed 覆盖旧 done 叙述；实施以本版 F0/F1/F2 为准 |

---

## 10. 成功标准（Owner 可感）

主观：

> 点进主题，像打开一个长期选题的工作台：先接判断，再看证据与教训，然后知道下一步去哪。  
> 不再像进入一个需要学习的知识库产品。

客观：F0 验收清单全部勾选。

---

## 11. 决策（已采纳）

1. 主题一级导航 — **已采纳**  
2. 页面定位 = 飞轮轴承 / 可复利判断单元 — **已采纳**  
3. 视觉语义对齐创作操作台，不做知识库 SaaS — **已采纳**  
4. 完整档案后置 — **已采纳**  
5. F0 零后端可做 — **默认是**

---

## 12. 建议立即执行顺序

```text
F0-1  main 去 topic 宣传头，满高壳
F0-2  TopicsView 对象头单行 + 默认判断主列
F0-3  档案/画布降级 + 去创作主行动
F0-4  样式减噪对齐 studio
F0-5  typecheck + 实机首屏验收
```

无新异议则按 F0 开工。
