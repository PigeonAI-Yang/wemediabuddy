# 采集 SOP

## 顺序

1. **导线（硬）先于记者（软）**：先跑 A 类 must_check 全量打卡，再做主题/社区增亮。
2. 合并同一事件；只核验会改变结论的关键事实。
3. 保存标题、时间、原始链接和一句价值判断。
4. 保存全部达到机会标准的去重结果，按 `SSS → S → A → B → C → D → E → F` 排序后写入 WMB。

## A 类 must_check（全量，禁止“先两类”）

下列来源每次今日情报 **必须全部巡检**，单源失败只标红该源，不中断队列：

1. `source-index.json` 中全部  
   `enabled === true && trust_level === "primary" && roles includes "release"`  
   （含 DeepSeek 多通道、ByteDance Seed / Seedance / 即梦 / Dreamina、OpenAI/Anthropic 等）。
2. 全部 **enabled** 的 X List bindings（`wmb_list_x_list_bindings`）。  
   当前硬绑定：`@KimbomArtist` / **AI前沿** / `list_id=2082851520417255750` → `wmb_read_x_list_timeline`。
3. 命中官宣或官方链接 → 入库 `source_items`（URL 去重）；推文线索保留 status URL，解析出的官方 URL 优先作 primary。

约定：`must_check = enabled && primary && roles.includes("release")`；enabled X List bindings 视同 must_check。

## C 类（可抽样）

社区、趋势、HN/Reddit、专业人士讨论、Google Trends 等 `signal_only` / 非 release 源：结果不足再扩展，允许抽样，不承担“有没有发版”责任。

## 失败处理

页面打不开时换官方入口、X 官号或 List 缓存，并记录缺口；不为凑齐流程继续消耗时间。Pi 主题航线不得替代 A 类导线。
