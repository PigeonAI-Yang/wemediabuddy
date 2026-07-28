---
name: WeMediaBuddy
description: AI 自媒体终端的私人主编式产品界面
colors:
  dark-app-bg: "#090C11"
  dark-topbar: "#0A0E14"
  dark-sidebar: "#0B0F15"
  dark-panel: "#0C1118"
  dark-surface: "#0F141C"
  dark-surface-raised: "#10151D"
  dark-surface-hover: "#181E28"
  dark-surface-selected: "#1D2230"
  dark-tag: "#1B2029"
  dark-ink: "#F3F5F8"
  dark-ink-soft: "#D1D5DC"
  dark-muted: "#AEB5C0"
  dark-muted-low: "#929AA6"
  dark-border: "#303743"
  dark-border-soft: "#252B35"
  violet: "#7657EF"
  violet-hover: "#886CF4"
  violet-soft: "#A98FFF"
  link-dark: "#71A1FF"
  day-app-bg: "#F5F3FB"
  day-topbar: "#FFFFFF"
  day-sidebar: "#F8F7FC"
  day-surface: "#FFFFFF"
  day-surface-raised: "#FBFAFF"
  day-surface-hover: "#F0ECFA"
  day-surface-selected: "#EBE6F8"
  day-ink: "#211D2B"
  day-ink-soft: "#3E384A"
  day-muted: "#625B70"
  day-border: "#D9D4E4"
  day-violet: "#6844DB"
  day-violet-hover: "#5733C7"
  link-day: "#315FBA"
  success: "#31C777"
  warning: "#B0791C"
  danger: "#C42B3A"
typography:
  display:
    fontFamily: "Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1.16
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: "Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.4
rounded:
  control: "7px"
  nav: "9px"
  card: "10px"
  panel: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.violet}"
    textColor: "#FFFFFF"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "11px 18px"
  button-primary-hover:
    backgroundColor: "{colors.violet-hover}"
    textColor: "#FFFFFF"
    rounded: "{rounded.control}"
    padding: "11px 18px"
  button-secondary:
    backgroundColor: "{colors.dark-surface-raised}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  card-primary:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.panel}"
    padding: "20px 24px"
  nav-item-active:
    backgroundColor: "{colors.dark-surface-selected}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.nav}"
    height: "52px"
---

# Design System: WeMediaBuddy

## Overview

**Creative North Star: “私人主编台”**

界面服务于一个高频决策：用户今天应该讲什么，以及为什么值得讲。它要像一位敏锐、可信、克制的私人主编，把资料、判断、创作、发布与结果放在同一条可追溯链路里；产品内部运行状态默认退场，只有异常时才进入系统诊断。

黑夜紫罗兰是默认主题，适合长时间专注工作；白昼紫罗兰使用同一语义 token（设计变量）映射到明亮表面，不改变信息层级。正式 Logo 唯一来源是 `images/logo.png`，使用时裁切 W+眼睛符号或横向字标，不得重绘变体；真正的 SVG 母版交付后替换，不改变布局占位。

参考图固定保存在 `docs/design/references/`：首页决定内容层级；创作图提供项目/编辑/上下文三栏；发布图提供队列/预览/确认三栏；结果图提供内容列表/快照/复盘主从结构。生成图只作为结构参考，出现的内部工程措辞、Logo 漂移和虚构数据不得直接进入产品。

**Key Characteristics:**

- 内容机会和用户判断优先，系统状态退到诊断页。
- 高密度但不拥挤，使用清晰分栏、分组线和稳定对齐。
- 一个主操作，一个首选对象；次级信息弱化而不消失。
- 每个判断、发布和复盘都能追溯来源、版本或时间快照。
- 顶栏固定 64px；宽屏导航 224px，中屏 208px，紧凑窗口 76px。
- 1600px 以上完整多栏；1280–1599px 收紧辅助栏；1100–1279px 辅助栏变抽屉；禁止横向滚动。
- 每页右侧保留同一个 Pi 对话区，宽屏约 360–400px；贴边小箭头收起后归还页面宽度，切页不重建会话。

## Colors

紫罗兰只表达当前选择、主操作和关键判断；它不是装饰背景。黑夜与白昼主题共享相同角色名称，组件不得直接写死主题颜色。

### Primary

- **主编紫罗兰**：主按钮、当前标签、当前导航和首选内容边框。
- **柔和紫罗兰**：字段标题、页面标签和低强度强调。
- **交互紫罗兰**：只用于主操作悬停，不用于大面积表面。

### Secondary

- **可信链接蓝**：打开原文、证据和外部页面链接。
- **确认绿**：已核对、文件可用和已完成。
- **等待琥珀**：需要素材、等待处理和中优先级。
- **异常红**：发布失败、危险操作和窗口关闭悬停；禁止作为普通装饰。

### Neutral

- 黑夜主题通过应用底、侧栏、面板、表面和抬升表面形成五级深色层次。
- 白昼主题通过冷白、淡紫灰和白色表面形成同等层次，不使用米黄或纸张色。
- 主文字、次文字、弱文字必须保持三级对比；正文不得使用弱文字色。
- 分隔线统一 1px，默认使用低对比边框；强边框只用于输入和可操作控件。

**The One Violet Voice Rule.** 单屏紫罗兰实色面积不得超过约 10%；如果多个区域同时发紫，层级已经失控。

**The Status Is Semantic Rule.** 绿色、琥珀色和红色只表达真实状态，必须同时有文字或图标，禁止只靠颜色。

## Typography

**Display Font:** Segoe UI / Microsoft YaHei UI  
**Body Font:** Segoe UI / Microsoft YaHei UI  
**Label Font:** Segoe UI / Microsoft YaHei UI

**Character:** 单一系统无衬线字体承担全部角色，用字号、字重与间距建立编辑感。界面标签务实克制，标题明确，不使用营销式大字或装饰字体。

### Hierarchy

- **Display**（700，34px，1.16）：页面唯一主标题，例如“今天有什么值得做？”。
- **Headline**（700，25px，1.35）：首选内容、发布对象或结果对象标题，最大约 34 个中文字符宽。
- **Title**（650，18px，1.4）：面板、项目、资料和分区标题。
- **Body**（400，15px，1.55）：判断、正文、说明与预览；连续文本控制在 65–75ch。
- **Label**（650，13px，1.4）：字段名、标签、时间和状态；不全大写，不增加夸张字距。

**The User Language Rule.** 界面禁止出现 MCP、IPC、CDP、revision、外部 Agent 等内部工程术语；翻译成用户正在处理的资料、版本、账号、来源和状态。

**The No-Collision Rule.** 标题必须允许自然换行，按钮标签不得压缩，文本与边框最小内距 16px。

## Elevation

系统以色阶、1px 边框和区域分隔建立深度，默认不使用投影。首选对象通过主色边框和更清晰的表面层次获得优先级；抽屉通过遮罩和位置变化建立前后关系。宽泛柔影、玻璃模糊和发光禁止出现。

**The Flat-by-Default Rule.** 表面静止时保持平面；只有抽屉、系统弹层或拖拽对象允许真实提升。

**The One Boundary Rule.** 一个容器只使用边框、色阶或阴影中的一种主要分层手段，禁止边框再叠加大模糊阴影。

## Components

### Buttons

- **Shape:** 轻微圆角（7–8px），高度 38–44px。
- **Primary:** 紫罗兰实色、白字、11px 18px 内距；每个视图最多一个最强主按钮。
- **Hover / Focus:** 悬停使用更深紫罗兰；键盘焦点使用 2px 紫罗兰外轮廓，偏移 2px。
- **Secondary:** 主题抬升表面 + 1px 强边框；用于刷新、打开浏览器和返回修改。
- **Ghost:** 透明背景，只用于顶栏与行内次级操作。
- **Danger:** 仅删除、关闭或不可逆操作使用红色，发布确认不使用恐吓式红色。

### Chips

- **Style:** 5px 圆角、13px 标签、紧凑内距；默认使用主题标签底色。
- **State:** 当前状态可用紫罗兰；成功、等待和失败使用语义色并配文字。
- **Use:** 平台、内容形式、优先级、版本状态；禁止用 chip（标签）承载长句。

### Cards / Containers

- **Corner Style:** 小卡 10px，主要面板 12px。
- **Background:** 使用主题表面 token；首选对象可以使用紫罗兰 1px 边框。
- **Shadow Strategy:** 无常驻阴影。
- **Border:** 1px；列表内部优先用分隔线，不给每一行重复套卡片。
- **Internal Padding:** 主要面板 20–24px，紧凑列表 14–18px。

### Inputs / Fields

- **Style:** 抬升表面、1px 强边框、7px 圆角、最小 40px 高。
- **Focus:** 紫罗兰焦点轮廓，不使用发光。
- **Error / Disabled:** 错误使用红色文字与明确原因；禁用降低强调但仍需可读。
- **Editing:** 创作正文使用大面积连续编辑面，不把每个字段做成独立浮动卡片。

### Navigation

- 无边框标题栏高 64px，品牌左置、日期居中、主题/搜索/窗口控制右置。
- 侧栏宽屏 224px、中屏 208px、紧凑 76px；导航项高 52px、圆角 9px。
- 当前项使用主题选中表面和紫罗兰状态标记；紧凑模式只显示图标并保留 tooltip（提示）。
- “系统诊断”和“设置”固定在底部，正常状态不显示红点或健康信息。
- 滚动条默认透明，悬停或焦点时显示 8px 主题细滚动条。

### Pi Conversation Dock

- 位于所有页面最右侧，不作为单独导航页面。
- 顶部只显示 Pi、当前状态和最小必要上下文。
- 中部连续显示对话与任务进度；不展示模型思维链。
- 底部使用单一输入区和发送按钮。
- 左边缘提供 24–28px 的箭头按钮；展开/收起使用 180–220ms ease-out，并支持 reduced motion。
- 收起后不得留下空白占位；展开状态跨页面保持。
- 页面辅助信息不得与 Pi 同时占用固定右栏，改为主内容分区、页签或按需抽屉。

### Opportunity Brief

- 首页核心组件按“为什么现在值得做 → 建议表达角度 → 核心观点 → 怎么讲 → 关联资料”排列。
- 不使用传播潜力、账号匹配百分比等无法解释的综合分数。
- 首选机会占据最强视觉层级，其他机会降为紧凑列表或小卡。

### Studio Workspace

- 创作页固定为项目导航、核心编辑、上下文三栏。
- 核心内容与 X、小红书、微信公众号版本使用同一组页签，不拆成互不关联的页面。
- 右栏只容纳关联资料、个人观点、创作决策和媒体素材。

### Publish Confirmation

- 发布页固定为待发布队列、最终内容预览、发布前确认三栏。
- 确认区域必须同时显示平台、账号、内容版本、媒体素材和一次性确认说明。
- 任何一项变化都使确认失效；“结果待对账”禁止自动重发。

### Results Review

- 结果页以已发布内容列表和单个对象详情组成主从布局。
- 指标必须携带采集时间与来源；不可见显示“暂不可见”，禁止写成 0。
- 增长过程使用离散时间点，不绘制虚构中间曲线。
- 复盘固定使用 Keep（保留）、Stop（停止）、Change（改变），每条结论关联证据。

## Do's and Don'ts

### Do:

- **Do** 让每个页面先回答一个用户问题：有什么值得做、证据在哪、怎么创作、发布什么、结果说明什么。
- **Do** 使用正式 `images/logo.png` 的 W+眼睛符号或横向字标，保持比例与造型一致。
- **Do** 默认使用黑夜紫罗兰，并保证白昼紫罗兰拥有完全一致的语义层级。
- **Do** 保持顶栏、导航、按钮、标签、边框和间距在五个主页面完全一致。
- **Do** 让资料、版本、账号、素材、快照和复盘结论可追溯。
- **Do** 默认假设系统正常；只有异常时引导进入系统诊断。
- **Do** 空状态只使用标题、说明和必要操作，不放装饰性方块图标。
- **Do** 在 1672px、1366px 和 1100px 三档检查布局，确保无横向溢出。

### Don't:

- **Don't** 做成 SaaS 数据驾驶舱、任务看板、系统健康大屏、脱离业务现场的 AI 聊天首页或无来源的热度排行榜。
- **Don't** 在业务页面暴露 MCP、IPC、CDP、revision、外部 Agent 等内部工程措辞。
- **Don't** 显示虚构热度、传播评分、账号匹配百分比或综合表现分。
- **Don't** 使用内容生产 Kanban（看板）代替真实的资料、编辑、确认和复盘工作流。
- **Don't** 让 MCP、数据库、浏览器正常状态占据首屏或业务页面。
- **Don't** 使用玻璃拟态、霓虹赛博朋克、大面积渐变、渐变文字或宽泛柔影。
- **Don't** 使用 24px 以上卡片圆角、彩色粗侧边条或重复嵌套卡片。
- **Don't** 在每个空状态放字母、汉字或图标方块。
- **Don't** 把不可见指标写成 0，也不要把点击成功当成发布成功。
- **Don't** 直接照搬生成图中的 Logo、假数据、内部文案或不一致图标。
