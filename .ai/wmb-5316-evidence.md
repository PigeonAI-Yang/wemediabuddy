# WMB-5316 验收证据

修正正文工具条定稿配图组的几何系统：

- 比例选择、张数输入、动作按钮统一为 32px 高并处于同一基线。
- 比例与张数值统一居中；隐藏 number 原生步进器，避免文本被挤偏。
- 比例字段 72px、张数字段 48px、按钮最小 88px；字段内边距统一按 8px 节奏。
- 组内控件及标签—字段间距统一为 8px；组前分隔留白为 12px。
- 比例选择使用一致的自绘箭头，不再受平台原生 select 内边距影响。

真实 Electron：`WMB-5312-studio-illustration-workflow` 1/1 PASS。计算样式断言确认三控件高度 32px、顶部差 ≤1px、两个字段 `text-align:center`、组间和标签间距均为 8px；完整配图、重生、撤销、重载流程继续通过，page error 0。

截图：`tests/e2e/.artifacts/WMB-5312-studio-illustration-workflow-GGz1C8/studio-illustration-workflow-screenshot.png`。

设计 token：`tests/design-tokens-drift.test.mjs` 3/3 PASS。
