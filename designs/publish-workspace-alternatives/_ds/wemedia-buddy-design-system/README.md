# WeMediaBuddy Design System

WeMediaBuddy（WMB）的 Baoyu 格式设计系统包：机器 SSOT 是
`src/renderer/styles-foundation.css`，本包只派生、不另起品牌 token。

## 结构

```
wemedia-buddy-design-system/
├── styles.css              # 唯一入口（IMPORT-ONLY），消费端只引这一个文件
├── tokens/                 # 派生 token：colors / typography / spacing / shape-motion
├── styles/
│   └── components.css      # 组件与外壳样式（ds-* 原语 + WMB creature + 房间形态）
├── components/core/        # 11 个组件族：PascalCase.jsx + .d.ts + .prompt.md + .card.html
├── guidelines/             # ≥12 张聚焦的 guideline/foundation 卡片（纯 token 驱动）
├── ui_kits/
│   └── editorial-terminal/ # 交互式起点（tagged StartingPoints）
├── readme.md
└── SKILL.md
```

## 11 个组件族

`WmbCreatureMark` · `Button` · `IconButton` · `ChipFilter` · `StatusPill` ·
`TabList` · `PageCommand` · `StatePanel` · `FormField` · `AppModal` · `RoleCard`

每个组件族 = PascalCase JSX 源码 + 同级 d.ts 契约 + prompt 说明 + `@dsCard`
第一行注释的演示卡片。卡片相对引用 `../../styles.css` 与根级生成的
`_ds_bundle.js` / `_ds_manifest.json`，由编译脚本注入组件命名空间。

## 使用

- 消费者：`<link rel="stylesheet" href="…/styles.css">`（唯一入口）。
- 组件：编译后从 `_ds_manifest.json` 的 `namespace` 取命名空间对象，
  组件即其属性（如 `ns.Button`）。未编译时卡片显示提示文案。
- 主题：`<html data-theme="dark|light">` 切换，同一批语义变量换极性。
- 卡片：每张卡片的 `@dsCard` 注释必须是文件第 1 行；
  组件卡片引用 bundle；guideline 卡片自包含、只依赖 token。

## 编译

根级 `_ds_bundle.js`、`_ds_manifest.json`、`_adherence.oxlintrc.json`、
`preview.html` 由 `compile-design-system.mjs` 生成，不进版本库、不手改。

## 权威与变更协议

- 品牌级 token 只改 `src/renderer/styles-foundation.css`，再跑
  `node scripts/sync-design-doc-from-foundation.mjs` 与
  `node --test tests/design-tokens-drift.test.mjs`。
- 组件规则永不硬编码主题色；hex allowlist 只允许收缩。
- 本包内新增/修改组件或卡片不改动任何产品文件。

## 契约来源

`PRODUCT.md`（C1–C9 形态宪法）· `.ai/wmb-5258-evidence.md`（统一前端契约）·
`docs/design/living-style-guide.html`（人类可读面）。
