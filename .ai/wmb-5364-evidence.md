# WMB-5364 传播优先选题机制整改证据

日期：2026-08-29

## 结论

- 产品主目标已统一为：真实性是准入硬门，传播价值是排序与选题主目标。
- 旧评分不能冒充新评分；`propagation_v2` 固定为现实变化 25、冲突/认知缺口 20、读者利害 20、为何现在 15、一句话可转述性 15、账号适配 5。
- 每个可审批选题必须完成事件层、用户层、产业/社会层三种语义不同的中心主张竞争；最高传播价值候选若仍缺证据，保留为 `research_required` 并进入补料，不得退化为安全小题。
- Owner 批准会冻结中心主张、传播承诺与事实/推断/观点边界；Writer 初始正文读入该锁，不得擅自软化主线。

## GLM 黄金失败回归

- 旧方案“免费是否值得用”即使字段完整、旧分 87，也会因缺少三层主张竞争而被判 `invalid: thesis_competition_missing`。
- 有国产芯片承载证据时，产业层“国产算力开始承接大规模公共 AI 服务”可以成为最高分赢家；边界只允许写成商业服务规模扩大的信号，不得扩写为整个国产 GPU 行业已经成熟。
- 缺少承载证据时，产业主张仍保留但标记 `research_required`，不可批准；旧评分同样不能通过 `propagation_v2` 校验。
- 回归：`tests/wmb-5364-editorial-thesis-regression.test.mjs`。

## 历史热点盲测

- 读取真实业务库 `J:/PigeonYang/WeMediaBuddyData/wmb.db` 的 20 条历史 `plan_items`，评估时隐藏标题与 ID，冻结赢家后恢复身份。
- 12 条主线明确提升，8 条保持原有较强主线，0 条回退，ID 20/20、重复 0。
- GLM 样本在真实现有证据下正确保留产业主张并返回 `research_required`，未伪造国产芯片承载事实。
- 明细：`.ai/wmb-5364-historical-blind-benchmark.md`、`.ai/wmb-5364-historical-blind-benchmark.json`。

## 测试与构建

- TypeScript：`npm run typecheck` PASS。
- 最终全量：`npm test`，2159 tests / 2159 pass / 0 fail / 0 skip / 0 todo，耗时 1,106,269.2812 ms。
- 原有失败测试逐项迁移到正式合同；未为绿灯删除测试，故意验证旧评分应失败的负向测试继续保留。
- `npm run build` PASS；Skills 镜像一致，ffprobe、Whisper、Tesseract 打包后真实执行门禁均通过。

## 打包、安装与产物身份

- Setup：`J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe`
- Setup 大小：782,733,312 字节；2026-08-29 08:51:31；SHA-256：`18423FD02598CC1FA583727EFD3AEB012FE93580A90B2D014542CF0EE0AD96B0`。
- 静默安装退出码 0；注册表读回版本 `0.3.0`，安装根 `C:/Users/yangda01/AppData/Local/WeMediaBuddy`。
- 安装前 `app.asar`：5,863,527 字节，SHA-256 `EFDC07BB89FD87939A67E48A3FA86BA742B11BA16F21168C76F5FB0353996A5F`。
- 本轮安装前 `app.asar`：5,876,926 字节，SHA-256 `D3B53AA8157F3CC18A6960173A2E62781FC3DE7E5599CD35A65C43EF3D7F5DDA`。
- 本轮安装后 `app.asar`：5,880,271 字节，2026-08-29 08:52:25，SHA-256 `D4410434D787E31F739676993E300B7866B0BB19D973F758A71C2571E1B6A2E7`；确认换成包含真实性来源硬门的当前构建。

## 真实 Electron 与隔离安装态读回

真实业务数据根 `J:/PigeonYang/WeMediaBuddyData`：

- 新安装版从 `app-0.3.0/resources/app.asar` 启动，Today shell/layout 正常，无 console error/page error。
- 2026-08-29 及回看 14 天均无可推荐项目，当前状态为 `clean_empty`；这只证明真实空态与安装启动，不冒充完整推荐卡验收。
- 只读证据：`J:/wmb-out/wmb-5364-installed-readback.json`、`J:/wmb-out/wmb-5364-installed-today.png`。

同一安装产物、隔离数据根的完整流程：

- Today 主推荐渲染标题、为什么现在、目标读者、内容角度、核心观点、内容结构，不再只有标题。
- `propagation_v2` 91 分方案可以审批；点击“开始创作”后创建唯一 Studio project 和 1 个初始版本，正文长度 680。
- `planning_status=approved`；`thesis_lock_v1` 冻结产业层赢家、标题/开头传播承诺和 claim boundaries；初始正文含“已批准中心主张”及完整产业主张。
- 批准后原推荐退出 Today，结果为 `clean_empty`，没有错误跳转或残留可批动作。
- 证据：`J:/wmb-out/wmb-5364-installed-flow.json`、`J:/wmb-out/wmb-5364-installed-flow-before.png`、`J:/wmb-out/wmb-5364-installed-flow-after.png`。
- 可复跑脚本：`.ai/verify-wmb-5364-installed.mjs`、`.ai/verify-wmb-5364-installed-flow.mjs`。

## 边界

- 真实业务库当前没有可批选题，因此未为了验收修改真实选题；完整卡、批准事务和 Writer 主张锁使用同一安装产物的隔离数据根验收。
- 最终平台发布仍为人工动作；本任务没有发布内容。

## 最终对抗审计与修复

- 审计先证明两个 P0 反例：truth-gate claim 可引用计划外伪造 Source；评分后 Source 被归档仍可批准。最小回归先稳定得到 5 tests / 3 pass / 2 fail，再开始修复。
- 第二轮代码审查继续找到四个旁路：蛇形 `score_reasons_json`、无评分草稿引用 archived Source、`source_ids_json` 校验后写丢、底层 `transitionPlanItem` 直接批准。四个反例均先写成失败测试，得到 11 tests / 7 pass / 4 fail。
- 最终 `tests/wmb-5364-boundary-regression.test.mjs` 11/11 PASS：保存、定向提交、底层批准迁移、Owner 批准四层都验证 Source 存在、canonical URL 有效、未 archived；truth-gate claim 引用必须属于当前方案 Source 集合；蛇形别名与 JSON 来源字段不能旁路。
- 全量首轮暴露 `zhihu-hot-scoring` 使用系统 `Date.now()` 而忽略冻结 `nowIso`，导致评分随日期从 100 漂到 95、路由从 boundary 漂到 rejected；改为使用同一评分时点后 `tests/wmb-5332-scoring.test.mjs` 8/8 PASS，最终全量 2159/2159。
- 最终只读代码复核结论 PASS：上述四个 HIGH 与评分时间漂移全部关闭，无新增 HIGH。
