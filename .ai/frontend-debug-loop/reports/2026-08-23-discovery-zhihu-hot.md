# WMB-5341：发现页知乎 AI 热题独立入口

## 交付

- 「发现」顶部新增与「榜单」「Lists」并列的「知乎热题 / AI 话题」入口。
- 新模式只读当前 workspace 的 `zhihu_hot_observations`，限定官方 AI 专题证据 URL，并按 Source 取最新有效 observation。
- 列表展示排名、问题标题、摘要、热度、采集时间、资料库状态和知乎原文外链；提供 loading、empty、error、只读刷新。
- 未新增采集器、迁移、权限、发布路径或品牌 token。

## 验证

- `node --test tests/wmb-5331-zhihu-hot.test.mjs tests/discover-settings-boundary.test.mjs`：12/12 PASS。
- `npm run typecheck`：0 错误。
- `npm run package`：Forge package 成功，main/preload/renderer 与 postPackage 门禁均通过。
- 真实打包 Electron，1365×768 CSS viewport / 1600×960 device surface：
  - 三入口同时可见；「知乎热题」激活。
  - 显示 `2026-08-22 · 3 个热题`，三个标题来自官方 AI 专题 observation。
  - 已入库按钮均为 disabled，未触发重复保存。
  - 读取失败文案未出现；`documentElement.scrollWidth - clientWidth = 0`。

## 证据

- 截图：`.ai/frontend-debug-loop/reports/2026-08-23-discovery-zhihu-hot.webp`
- 打包应用：`J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`
- 真实产品窗口已保留打开，供 Owner 直接检查。
