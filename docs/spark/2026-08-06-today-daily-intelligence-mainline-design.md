# 今日情报主线收敛设计

日期：2026-08-06

状态：待 Owner 确认后实施

范围：Today 页「开始今日情报 → 扫描渠道 → 生成运营方案 → 进入创作」的完整用户叙事与状态展示；不改渠道模块能力本身，不大改 Pi 判断业务。

## 1. 问题

产品主线在 PRD 中是清晰的：

```text
每日侦察 → 资料入库 → 机会判断 → 运营方案 → 人机讨论/创作
```

但 Today 页当前把同一条流程拆成多套互相打架的语言：

| 系统真实情况 | 用户看到的 |
| --- | --- |
| 渠道扫了一部分 | 「部分完成 / 已保存可用资料」 |
| 方案还没生成 | 右侧「创建今日运营方案」假待办 |
| 后台任务可继续 | 「需要人工处理后流程才能继续」 |
| 命令条 / 空状态 / 右侧栏 | 各说各话 |

根因不是某一个按钮，而是：

1. **没有单一用户态模型**：renderer 直接拼 `task.status`、`task.phase`、`pendingActions`、`plan`、本地 `running`；
2. **`pendingActions` 被滥用**：`getToday()` 在没有 plan 时硬塞「创建今日运营方案」，把系统未完成伪装成人工作；
3. **进度语义过碎**：后端 phase 十几个，前端逐字展示，用户读不懂整条流水线；
4. **局部补丁叠加**：启动闪动、requestId、浏览器验证、假成功等修复没有统一叙事契约，体验更散。

Owner 反馈定性：不是“某个文案不对”，而是**完整今日情报流程被拆得乱七八糟**。

## 2. 目标

把 Today 页收敛成**一条主线、一个状态源、两个用户动作**。

### 2.1 用户只感知 4 步

```text
1. 启动
2. 扫描渠道
3. 生成方案
4. 完成
```

### 2.2 用户只做 2 类动作

1. **系统活**：开始 / 继续今日情报  
2. **人的活**：从方案开创作；以及真正阻塞时的登录/配置

### 2.3 展示契约

- 顶部命令条、中部空状态/机会列表、右侧栏，必须读**同一** `TodayRunView`
- 任何“待你处理”卡片必须可点、说清做什么、点完能继续主线
- 禁止再出现“看起来像待办、实际不可操作”的占位
- 非运行态命令条可保留一行次级 stats（数量来自 `TodayRunView.stats`），但它是数字，不是第二套叙事
- 空状态文案禁止手写按钮名；需要指路时用 `{primaryLabel}` 从 view 内插值，保证文案与真实 CTA 字节级一致

## 3. 非目标

- 不重做渠道模块、资料模型、方案校验规则
- 不改 Pi 判断算法与 prompt 权威
- 不引入新权限、新角色、新页面
- 不把 Studio / Results / Library 一并重构（只要求 Today 主线自洽）
- 不把 partial 强行改写成 succeeded（诚实状态保留）

## 4. 核心模型：`TodayRunView`

在 renderer（或 thin main helper）新增**纯函数**投影，禁止 UI 各处自行 if/else 拼状态。

```ts
type TodayStep = 'idle' | 'starting' | 'scanning' | 'judging' | 'done' | 'partial' | 'needs_user' | 'failed';

type TodayRunView = {
  step: TodayStep;
  headline: string;          // 命令条主句，唯一真相
  detail: string;            // 一句解释（failed 态放 errorMessage 摘要，超 120 字截断加省略号）
  primaryCta: {
    kind: 'start' | 'continue' | 'open_settings_browser' | 'open_settings_channels' | 'none';
    label: string;
    /** 破坏性动作：点击前弹确认框，文案由此字段供给；undefined = 直接执行 */
    confirm?: string;
  };
  secondaryCtas: Array<{ id: 'view_sources' | 'save_partial' | 'cancel' | 'open_studio' | 'refresh'; label: string; disabled?: boolean }>;
  progress?: {
    label: string;           // 例如「渠道 3/5」或「正在生成方案」
    ratio?: number;          // 0-1；judging 可为 indeterminate
    currentSource?: string;
    /** 运行期诊断信息（计数条、最后事件、停滞提示），默认折叠在「详情」下，不占主叙事 */
    diagnostics?: Array<string>;
    stalled?: { waitSec: number } | null;  // 心跳停滞：只给等待时长，禁止猜测性措辞
  };
  blockers: Array<{
    code: string;
    title: string;
    body: string;
    action: 'open_settings_browser' | 'open_settings_channels' | 'retry';
  }>;
  /** 非运行态次级统计（≤3 项）；不提供则不渲染 */
  stats?: Array<{ label: string; value: string; tone?: 'up' | 'amber' }>;
  showOpportunityEmpty: boolean;
  opportunityEmptyTitle: string;
  opportunityEmptyBody: string;   // 可含 {primaryLabel} 占位，渲染时替换
};
```

### 4.1 后端 phase → 用户 step

| backend `status` / `phase` | step |
| --- | --- |
| 无 task | `idle` |
| `running` + `starting` / `resume_pending` / `resuming` | `starting` |
| `running` + `channel_preflight` / `scanning_sources` / `planning_sources` | `scanning` |
| `running` + `channel_scanned` / `running_pi` / `judging_opportunities` / `synthesizing` / `validating` | `judging` |
| `succeeded` / `completed` | `done` |
| `partial` | `partial` |
| `needs_user` | `needs_user` |
| `failed` / `cancelled` / `interrupted` | `failed`（文案区分） |

本地 optimistic `startingRef` 只允许把 UI 推到 `starting`，不得与其它 step 并行编造文案。

### 4.2 CTA 矩阵

| step | 主按钮 | 说明 |
| --- | --- | --- |
| `idle` 且无今日 plan | 开始今日情报 | 唯一启动入口 |
| `idle` 且有今日 plan | 重新侦察 | 保留，但副文案说明会刷新资料与方案 |
| `starting` / `scanning` / `judging` | 无主启动按钮 | 显示进度；次要：查看资料 / 保存并停止 / 取消 |
| `partial` | **继续生成方案** | 不说“待你创建方案” |
| `needs_user` | **继续今日情报**（点完回到 blockers，已解决的项不再出现） | 具体修复动作只存在于右侧 blocker 卡 |
| `failed` | 重试今日情报 | detail 展示真实 errorMessage 摘要 |
| `done` 有机会 | 去创作 | 机会列表是主内容；次级：重新侦察 |
| `done` 零机会 | 重新侦察（次级：查看资料） | 空成功是合法结果（PRD AC-017），禁止再用「还在准备中」引导用户重复跑 |

约束：同一时刻页面上**只有一个** primary；secondaryCtas 顺序与 label 固定（见 5.1 动作表）。

### 4.3 blockers 规则（替代假 pendingActions）

`pendingActions: string[]` **退役为展示输入**。Today 不再因为“没有 plan”生成人工待办。

只允许这些 blocker 来源：

1. `task.status === 'needs_user'` 且 `errorCode` 可映射  
2. preflight：浏览器未验证 / 渠道未配置 / Pi 未配置  
3. 渠道回执聚合后**全部** `needs_user`（已有 CAP-021 语义）

每条 blocker 必须带：

- 人话标题
- 一句话原因
- 一个可执行 action

映射示例：

| code | title | action |
| --- | --- | --- |
| `BROWSER_NEEDS_USER` / 浏览器未验证 | 先验证浏览器账号 | `open_settings_browser` |
| `CHANNELS_NOT_CONFIGURED` | 先配置情报渠道 | `open_settings_channels` |
| `CHANNELS_NEEDS_USER` | 渠道未就绪（登录或配置） | `open_settings_channels` 或 browser |
| `PI_CONFIG_REQUIRED` | 先配置创作助手连接 | 打开设置 → AI |

没有 action 的文案不得进入右侧「待你处理」。

## 5. 页面分区职责（收敛后）

### 5.1 顶部命令条（唯一指挥塔）

只负责：

- 主句 `headline`
- 进度 `progress`
- 主/次 CTA

禁止：

- 与中部/右侧不同的状态判断
- 展示内部 phase 英文或技术 code（code 可进 detail 次行，默认折叠）

主句文案规范（固定词典，不临时发挥）：

| step | headline |
| --- | --- |
| idle | 点「开始今日情报」，扫描渠道并生成今日运营方案 |
| starting | 正在启动今日情报 |
| scanning | 正在扫描情报渠道 |
| judging | 正在生成今日运营方案 |
| partial | 资料已入库，今日方案还没生成完 |
| needs_user | 需要你处理一项前置问题后才能继续 |
| failed | 今日情报未完成 |
| done | 今日运营方案已就绪 |
| done（零机会） | 今日侦察完成，暂无新机会 |

非运行态（idle/done/partial/needs_user/failed）可渲染一行次级 stats（`view.stats`，≤3 项：今日新资料 / 内容机会 / 进行中项目）。它是数字摘要，不是第二套句子，禁止与 headline 冲突。

固定动作表（secondaryCtas 顺序与 label，不临时发挥）：

| id | label | 出现条件 |
| --- | --- | --- |
| refresh | 刷新 | idle / done |
| view_sources | 查看资料 | 所有非 starting 态 |
| save_partial | 保存并停止 | running 且有 task.id |
| cancel | 取消任务 | running（需 confirm） |
| open_studio | 去创作 | done 且有机会 |

授权是自动的，不是用户动作：点击「开始今日情报」或「继续今日情报」即触发该任务的最小权限授权——runner 在 `onTaskReady` 按任务 intent 自动签发（如 studio_draft 仅含 `content.save_version` 等必需命令）、复用同任务既有授权；授权写入仅在该任务保持 running 且 worker lease 有效时成立，并受固定到期时间约束。页面不提供任何单独的授权入口或 grant 管理 UI。

退役项：`formatTodayActionLine` 与 renderer 内 `statusText` 状态机（today-view.tsx 当前把失败只写给页脚，命令条仍显示 idle 主句——必须由 4901 一并消灭）；`phaseLabels` 词典移入 `today-run-view.ts` 仅供内部投影，不再 export 给组件。

### 5.2 中部机会区

- `done` 且有 plan items：展示机会列表（现有 Opportunity 卡）
- 其它：单一 empty-state，文案只读 `TodayRunView.opportunityEmpty*`
- partial：明确「不是让你手写方案；点继续生成」

### 5.3 右侧栏

优先级从上到下：

1. **真实 blockers**（若有；仅 needs_user 出现，标题「待你处理 · N」，卡片带 action 与完整文案）
2. 今日入库资料 feed（含「已选 N/5 进 Pi」选择条；选择条是三级内容，不得压过 blockers）

删除：

- 「创建今日运营方案」假卡
- 任何无 action 的 ✋ 卡
- 不要把发酵轨搬进右侧栏：`FermentingRail` 保持当前位置（机会区下方），它服务跨日复盘，不是今日主线待办

### 5.4 页脚/全局 status

若 `onStatusChange` 仍使用，必须直接转发 `headline`，禁止第三套句子。

### 5.5 状态稳定与动效规则

1. 命令条 running / idle 两种形态保持**稳定 min-height**，切换时禁止整页跳变（右侧 rail 高度跟随机会区，命令条跳动会连坐）
2. 进度条维持「有值即 ≥6% 宽 + judging 用 indeterminate」的既有规则，不新增宽度动画；进度文案只在 step 或计数变化时更新，禁止每 5s 轮询重写
3. 心跳停滞用中性文案「已等待 {n}，可取消后重试」，禁止「疑似卡死」类猜测性措辞；固定在 meta 行内展示，不改变布局
4. `startingRef` 只允许把 UI 从 idle 推到 starting，任何失败/返回路径不得闪回 idle（§4.1 约束）；step 切换不加入场动画，避免 5s 轮询下闪烁
5. 中部 empty-state 文案随 step 整体替换即可；如需过渡用 `key={step}`，不做逐词动画

### 5.6 破坏性操作确认

- 「重新侦察」：confirm「重新侦察会用新结果替换今日方案，继续？」
- 「取消任务」：confirm「未保存的渠道结果会丢弃；想保留请先「保存并停止」」

两者的确认文案由 `primaryCta.confirm` / 对应 secondary 项的 confirm 字段供给，写入 TodayRunView，不散落在组件里。

## 6. 运行时与数据契约（尽量少动后端）

### 6.1 保持

- CAP-021 冻结渠道 + 逐来源回执
- partial 保留成功渠道结果
- requestId 每次点击唯一（已修，纳入回归）
- 任务先创建再慢操作（已修，纳入回归）

### 6.2 必改

1. **`getToday().pendingActions`**
   - 默认 `[]`
   - 若未来要保留字段，只允许由真实 blocker 投影填充，不再因缺 plan 写入

2. **Today renderer 状态源**
   - 抽出 `deriveTodayRunView({ today, task, preflight, localStarting })`
   - `today-view.tsx` 只渲染 view，不散落业务 if

3. **partial 主 CTA**
   - label 固定为「继续生成方案」
   - 行为仍调用 `startDailyIntelligence`（复用/续跑既有语义）
   - 若后续要真续跑 checkpoint，另开任务；本设计不阻塞于新后端
   - 注意：`startDailyIntelligence` 会先跑 preflight，若此时浏览器/渠道又变成 needs_user，直接落 blockers——这是诚实路径，不是 bug，copy 不得提前承诺“一键直达”

4. **needs_user 可导航**
   - blocker action 必须能打开设置对应 section（browser / channels / ai）
   - 若现设置路由不支持 section deep-link，本里程碑补最小 deep-link

5. **empty-success 分支**（PRD AC-017 要求零更新/空方案可成功）
   - `succeeded` + 0 items → step=`done`，走「done（零机会）」copy
   - 禁止显示「还在准备中」并引导用户再跑一遍：那会把“合法空结果”伪装成“没跑完”

### 6.3 明确不在本里程碑伪造的能力

- 不把“缺 plan”自动变成 succeeded
- 不在 UI 假装 Pi 已生成方案
- 不新增第二套任务系统

## 7. 交互时序（用户可见）

### 7.1 首次开始

```text
点击「开始今日情报」
→ 立即 step=starting（无闪回 idle）
→ 任务入库后 step=scanning（渠道进度）
→ 渠道完成后 step=judging（方案生成，可 indeterminate）
→ 成功 step=done，中部出现机会
```

### 7.2 部分完成

```text
step=partial
headline=资料已入库，今日方案还没生成完
primaryCta=继续生成方案
右侧无假待办
```

### 7.3 真需要人

```text
step=needs_user
右侧 blocker 可点
完成登录/配置后回到 Today
主按钮变为「继续今日情报」
```

## 8. 文案原则

1. **说人话，说下一步**：先结果，后原因  
2. **系统未完成 ≠ 你要手工做**  
3. **一个页面同一时刻只有一个主 CTA**  
4. **错误展示 errorMessage 原文摘要，不吞掉**  
5. 禁止：`流程才能继续` 却不给入口；禁止内部词：`receipt`、`phase`、`grant` 作为主文案

## 9. 实施切片（可分配）

### WMB-4900 设计冻结与台账挂载（docs-only）

- 本设计进入 `docs/spark/`
- `PLAN.md` 增加 M-4900
- `TASKS.md` 挂载 4901–4903
- 验收：文档与台账一致；无代码

### WMB-4901 TodayRunView 单一状态源

- 新增 `src/renderer/today-run-view.ts`（纯函数 + 单测）
- `today-view.tsx` 改为只消费 `TodayRunView`
- 删除散落 status 文案拼装（含 `formatTodayActionLine`、组件内 `statusText`、running 态的散装计数条）
- 单测 fixture 全覆盖：idle-无plan / idle-有plan / starting / scanning / judging / partial / needs_user-浏览器 / needs_user-渠道 / failed / done-有机会 / done-零机会（空成功）
- 验收：同一 fixture 下命令条/空状态/右侧 blocker 文案字节级一致

### WMB-4902 假待办清除与 CTA 矩阵

- `workbench.getToday` 不再因缺 plan 写入 pending
- partial/failed/needs_user/idle CTA 按矩阵落地
- 设置 deep-link（browser/channels/ai）最小接通
- 验收：手动路径
  1. 无 plan 时右侧无「创建今日运营方案」
  2. partial 主按钮为「继续生成方案」
  3. needs_user 卡片可进入设置对应页

### WMB-4903 启动/续跑体验回归与证据

- 固化：optimistic starting 不闪回、requestId 不冲突、任务先创建
- 补 focused 测试 + `.ai/wmb-4903-evidence.md`
- 实机：点开始 → 扫描 → 判断 → 完成/partial 全路径录屏或分步截图说明
- 验收：typecheck；focused 测试通过；实机无假待办、无互相矛盾文案

## 10. 验收标准（Owner 可直接打分）

1. 用户能用一句话说清当前在 4 步中的哪一步  
2. 任意时刻页面上不超过一个主行动按钮含义  
3. 未完成方案时，不会出现“请你创建方案”的人工卡  
4. 真阻塞时，卡片可点且点完知道回 Today 继续  
5. 命令条、空状态、右侧栏不出现互相矛盾句子  
6. 不回退 CAP-021：渠道回执、partial 保真、空方案可成功等后端语义保持

## 11. 风险与顺序

| 风险 | 处理 |
| --- | --- |
| 只改文案不改状态源，散装复发 | 4901 必须先合并，4902 依赖它 |
| deep-link 设置成本 | 最小实现：`openSettings(section)`；做不到则 blocker 文案写明路径且主 CTA 仍可 retry |
| partial 续跑仍可能重扫 | 本里程碑先诚实 CTA；真 checkpoint 续跑单开后续任务 |
| 与旧 action-line 指标条冲突 | 指标条保留数字，主句改由 TodayRunView 供给 |

## 12. 决策请求（Owner）

确认以下冻结项后开始 4901：

1. Today 只服务「跑完一轮情报并得到方案」  
2. 采用 `TodayRunView` 单一状态源  
3. 假 pending「创建今日运营方案」永久删除  
4. partial 主 CTA 文案固定为「继续生成方案」  
5. 非运行态命令条保留一行次级 stats（今日新资料 / 内容机会 / 进行中项目，由 `view.stats` 供给，≤3 项）——K3 建议保留，但只当数字摘要不当叙事  
6. needs_user 主 CTA 固定为「继续今日情报」，具体修复动作全部收敛到右侧 blocker 卡——K3 建议采纳

确认后按 WMB-4901 → 4902 → 4903 顺序实施，禁止再对 Today 做无设计的局部文案补丁。

## 13. K3 设计评审与修订（2026-08-06）

### 13.1 结论

设计方向正确（单一状态源 + CTA 矩阵 + 假待办退役），**可进入 4901**。但存在 5 个必须修正的缺口：空成功态缺失、needs_user 主 CTA 未定、运行期诊断信息无安放处、破坏性操作无确认、命令条形态切换的布局跳动风险。本节的修订已并入正文（见 13.3），本节同时是 4901 的**唯一文案源**。

评审依据（实读）：`today-view.tsx`（散装状态机 `statusText`、`formatTodayActionLine`、running 态 6 格计数条、`judgmentPhase` 硬编码 phase 列表）、`today-view-parts.tsx`（`phaseLabels` 13 个内部词、action line 四参数）、`workbench.ts:74-109`（`getToday` 已返回 `pendingActions: []`，4902 后端一半已落地，UI 侧 ✋ 卡渲染逻辑仍存活）、PRD（AC-017 空方案可成功、REQ-022 逐来源回执）。

### 13.2 评审发现（严重度排序）

| # | 问题 | 证据 | 严重度 |
| --- | --- | --- | --- |
| 1 | **空成功态缺失**：succeeded + 0 机会时中部仍显示「还在准备中 / 点开始今日情报」，把合法空结果伪装成未跑完，与 PRD AC-017 直接冲突 | today-view.tsx empty-state 分支只看 `running`/`partial`，不看 succeeded | 高 |
| 2 | **失败在指挥塔不可见**：failed 时命令条仍渲染 idle 主句与 stats，错误只经 `onStatusChange` 进页脚 | today-view.tsx `setTaskStatus` + `<p>{todayActionLine}</p>` | 高 |
| 3 | **needs_user 主 CTA 未冻结**：4.2 原写「卡片动作决定」，7.3 又写「继续今日情报」，两处矛盾 | 设计文档自冲突 | 高 |
| 4 | **运行期信息没有归属**：6 格计数条、`lastEventText`、`reallyStuck`（「疑似卡死」猜测性措辞）都堆在命令条主区，是「拼装感」的最大来源 | today-view.tsx running 分支 | 中 |
| 5 | **破坏性动作无确认**：「重新侦察」静默覆盖今日方案、「取消任务」可能丢未保存结果 | today-view.tsx 两个 onClick 直接执行 | 中 |
| 6 | 命令条 running/idle 形态高度差异大，切换时 rail 连坐跳动 | ResizeObserver 同步逻辑依赖 opps 高度 | 中 |
| 7 | 空状态 body 手写「点上方『开始今日情报』」，label 一变文案就错 | today-view.tsx partial body | 低 |
| 8 | `phaseLabels` 13 个内部词（等待恢复/正在规划来源…）仍会出现在命令条 | today-view.tsx `taskPhaseLabel` | 低 |

### 13.3 已并入正文的修订

- §4 TodayRunView：+`stats`、+`primaryCta.confirm`、`secondaryCtas` 改对象数组（id+label+disabled）、`progress.diagnostics`/`stalled` 折叠区、empty body 支持 `{primaryLabel}` 插值
- §4.2 CTA 矩阵：needs_user 主按钮冻结「继续今日情报」；done 拆「有机会/零机会」两行
- §5.1：命令条非运行态 stats 规范；固定 secondary 动作表（任务授权改为自动最小权限、无单独授权 UI）；`formatTodayActionLine` 与组件内 `statusText` 退役
- §5.3：发酵轨不搬进右侧栏，右侧栏 = blockers + feed
- §5.5 状态稳定与动效规则、§5.6 破坏性操作确认
- §6.2：+empty-success 分支；partial 续跑 preflight 可能再落 blockers 属诚实路径
- §9 WMB-4901：+11 个 fixture 清单
- §12：+决策项 5、6（含 K3 建议）

### 13.4 完整文案矩阵（4901 唯一文案源；与 §5.1 词典冲突处以本节为准）

| step | headline | detail | primary CTA | 中部空状态 title / body |
| --- | --- | --- | --- | --- |
| idle 无 plan | 点「开始今日情报」，扫描渠道并生成今日运营方案 | 每天一轮：渠道 → 机会 → 方案 | 开始今日情报 | 今日内容机会还在准备中 / 点「{primaryLabel}」，系统会自动扫描并生成今日运营方案。 |
| idle 有 plan | 今日运营方案已就绪 | 重新侦察会刷新资料并替换今日方案 | 重新侦察（confirm） | —（机会列表） |
| starting | 正在启动今日情报 | 正在连接情报渠道 | — | 正在侦察今日内容机会 / 来源扫描和整理完成后，机会会自动出现在这里。 |
| scanning | 正在扫描情报渠道 | 渠道 3/5 · 正在处理：{source} | — | 同 starting |
| judging | 正在生成今日运营方案 | 渠道已完成，正在整理内容机会 | — | 正在生成今日运营方案 / 机会生成后会自动出现，无需你操作。 |
| partial | 资料已入库，今日方案还没生成完 | 已保存部分渠道结果 | 继续生成方案 | 资料已入库，方案还没生成完 / 点「{primaryLabel}」让系统接着完成，不用手工写；已入库资料可在右侧查看。 |
| needs_user | 需要你处理一项前置问题后才能继续 | {blocker.title}：{原因一句} | 继续今日情报 | 今天的机会还没生成 / 先处理右侧「待你处理」卡片，完成后点「{primaryLabel}」。 |
| failed | 今日情报未完成 | {errorMessage 摘要 ≤120 字} | 重试今日情报 | 今日情报未完成 / 原因：{errorMessage}。点「{primaryLabel}」重新开始；已保存资料不会丢。 |
| done 有机会 | 今日运营方案已就绪 | {N} 个内容机会 · {SSS} 个优先 | 去创作 | —（机会列表） |
| done 零机会 | 今日侦察完成，暂无新机会 | 零更新也是有效结果 | 重新侦察（confirm） | 今天没有新的内容机会 / 渠道检查完成，没有发现值得做的机会；可点「{primaryLabel}」换一轮，或在右侧查看资料。 |

### 13.5 布局优先级（信息层级）

1. 命令条 = 状态 + 唯一主 CTA + 至多一行 stats（数字）
2. 中部机会区 = 结果本体（done 时）；非 done 时单一 empty-state
3. 右侧栏 = blockers（仅 needs_user）→ 今日资料 feed → 选择条（三级）
4. 发酵轨：保持在机会区下方，**不**进右侧栏（跨日复盘 ≠ 今日待办）
5. 全局 status（onStatusChange）= headline 直传，无第三套句子

### 13.6 渐进披露

- 运行期：命令条只露 headline + 进度条 + 当前来源；计数条（渠道/已扫描/失败/核验/保存/机会）、最后事件、停滞提示全部折叠进「详情」
- 停滞提示改为中性：「已等待 {n}，可取消后重试」；不猜「卡死」
- done：机会列表直接展示；「查看全部资料」走既有 SourceList 抽屉
- 次级动作 ≤3 个且顺序固定（§5.1 动作表）；同屏唯一 primary

### 13.7 组件结构（4901 目标形态）

```
today-run-view.ts           deriveTodayRunView() + 全部文案词典 + phaseLabels 内部表（纯函数，单测 11 fixture）
today-command-bar.tsx       读 view：headline / detail / stats / progress / primary+secondary CTAs
today-blockers.tsx          右侧 blocker 卡（读 view.blockers；无 blockers 不渲染）
today-empty-state.tsx       读 view.opportunityEmpty*；{primaryLabel} 内插
today-opportunity-list.tsx  既有 Opportunity 卡（不变）
today-view.tsx              仅组装 + 数据接线（task 轮询、preflight 传入、onStatusChange=headline 直传）
```

### 13.8 仍开放给 Owner 的决策（K3 已给建议）

1. §12-5 stats：K3 建议保留 3 项数字摘要（新资料/机会/进行中项目），不做第四句叙事
2. §12-6 needs_user 主 CTA「继续今日情报」：K3 建议采纳（retry 语义，已解决 blocker 不再弹）
3. 真续跑 checkpoint：本里程碑不做（partial 继续 = 重跑语义 + 诚实 copy），单开后续任务
4. 「去创作」按钮的目标页：沿用 openStudio，不改跳转逻辑
