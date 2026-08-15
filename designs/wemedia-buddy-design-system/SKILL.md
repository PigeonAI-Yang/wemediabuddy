---
name: wemedia-buddy-design-system
description: WeMediaBuddy 设计系统（Baoyu 格式）。当任务涉及 WMB 界面开发、组件复用、设计 token、卡片画廊或交互式 UI 起点时使用。机器 SSOT 是 src/renderer/styles-foundation.css；本 skill 只派生与演示，不改品牌 token、不改产品文件。
---

# WeMediaBuddy Design System

## 何时使用

- 为 WeMediaBuddy 界面写新组件、修 UI、做设计评审。
- 复用既有原语（按钮/标签/状态/弹窗/角色卡/creature）而不是另起一套。
- 浏览/新增组件卡片或 guideline 卡片、使用交互式 UI 起点。

## 铁律（来自权威）

1. **Token 先行**：颜色/间距/字体/圆角/动效全部走 `--*` 变量；
   组件规则永不硬编码主题色。品牌 token 只改
   `src/renderer/styles-foundation.css`（先问 owner），再同步 LSG 并跑 drift gate。
2. **契约**：One Violet（一屏一主操作）；四态（loading / error+retry /
   诚实空态 / content，loading 不渲染空态文案）；状态点+词双编码；
   三房间形态；一房一 H1；Pi 展开不得永久压缩工作区（收起或浮层）；
   placeholder 不是 label；`window.confirm` 禁用。
3. **语义**：默认中文用户语言；机器码进「技术详情」；产品名词共享 label map。

## 工作流

1. 先读 `styles.css` → `tokens/` → `styles/components.css`，确认已有原语。
2. 能用现有组件组合就组合；确需新组件：
   `components/core/<PascalCase>.jsx` + 同级 `.d.ts` + `.prompt.md` +
   `components/core/<kebab>.card.html`（`@dsCard` 注释第 1 行，引用 `../../styles.css`、
   `../../_ds_bundle.js`，按卡片模板做命名空间解析与未编译回退文案）。
3. 组件卡片 group="Components"；guideline 卡片放 `guidelines/`（group="Guidelines"，
   自包含、纯 token）；交互起点放 `ui_kits/`（group="StartingPoints"）。
4. 不手改根级生成物（`_ds_bundle.js` / `_ds_manifest.json` /
   `_adherence.oxlintrc.json` / `preview.html`），编译与预览由
   `compile-design-system.mjs` 负责。
5. 验收：键盘可达（tablist 方向键、弹窗焦点陷阱、整卡按钮）、
   双主题可用、reduced-motion 有静态等价物、每屏至多一个主操作。

## 范围

只改本包目录（`designs/wemedia-buddy-design-system/`）。不改产品文件、
不发明品牌资产、不硬编码新 hex。
