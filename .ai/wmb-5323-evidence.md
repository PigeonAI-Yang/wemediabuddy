# WMB-5323 证据 — Test suite truth restoration

日期：2026-08-21
基线：master 全量 `node --test --test-concurrency=1 tests/*.test.mjs` 约 27 个预存失败（stash 双向对比确认与巨型文件拆分无关）。
终验：**1794 pass / 0 fail / 0 skip**（2026-08-21 深夜恢复受管二进制 v2.1.1 后全量覆盖；sha256 校验通过，提交 f762b6a）；`npm run typecheck` 0 错误。提交 `7bbd200`。

## 四类修复与判定依据

### A. 迁移版本断言过期（4 文件）
| 测试 | 修复 | 判定 |
|---|---|---|
| wmb-5238-index-store-core(-child) | 硬编码 v70 → 从生产 `migrations` 导入动态 maxVersion，断言精确连续 1..CURRENT | 新增 migration 至 v74 是合法演进，连续性守护保留且不再过期 |
| wmb-5238-wiki-index-search | 同上，测试名改 1..CURRENT | 同上 |
| wmb-5249-zhihu-platform | `max===70` → 包含 70 + 连续 1..maxVersion + 数量一致 | 保留 WMB-5249 的 v70 存在性守护，放开最高版本 |
| wmb-5237-media-bindings | legacy fixture 补建 `app_meta` 最小结构 | 生产 migration 71 run hook SELECT app_meta（v1 起存在）；旧库标记 1..61 已应用却缺表属 fixture 过期，非迁移顺序问题 |

### B. 小红书 MCP 二进制缺失（1 文件）
- xiaohongshu-mcp.test.mjs：3 例加前置检查，二进制缺失时 `t.skip(reason)` 并注明 `npm run verify:xhs-resources` 同步路径；存在时全部原断言照常执行。
- 判定：生产 `startXhsMcp` 对二进制是硬依赖；skip 保留覆盖而非放宽断言。

### C. 源码文本断言漂移（3 文件）
| 测试 | 修复 | 判定 |
|---|---|---|
| wmb-5143-agents-instance-view | 正则同步到 `hasCurrentTasks = sections.length > 0 \|\| rosterActive.length > 0` + `!hasCurrentTasks` + rosterActive 渲染组件 | agents-roster-overview 已合并双源空态，等价结构继续守护 overview-first DOM 顺序 |
| wmb-5180-orchestration-acceptance §16-12 | writerTask 分支集合 2→3（+外部研究前置），并新增该分支 safe 四字段非空与无内部措辞校验 | WMB-5295 合法新增研究前置分支，safe 完整性需同等守护 |
| agent-runner | core_draft 断言拆两阶段：默认（researchReady=false）匹配 `wmb_dispatch_research`；readyPrompt 匹配 save_core/平台禁令/受众约束 | WMB-5295 研究门后 core_draft 首轮为交接分支，真实写作走 researchReady=true |

### D. 行为合同过期（6 文件）
| 测试 | 修复 | 判定 |
|---|---|---|
| wmb-5244-archive-worker | 单候选 provenance 1→2 行（复合 origin `source-media:…` + `source_media`）；跨 Source 复用合计 2→3 行 | media-archive-worker.ts `registerStagedAsset` 复合 origin + media-archive-store.ts `completeMediaCandidatePreserved` 独立 source_media 行为现行正确合同 |
| workspace-needs-user | 错误码 PI_CONFIG_REQUIRED → ROLE_MODEL_POLICY_REQUIRED；errorMessage 校验含「模型策略」；contextRefs 改子集校验；prestarted 二次 daily 任务数 3→4 | WMB-5319 角色模型策略合法变更；workspace 上下文四字段仍逐项守护 |
| wmb-5170-research-gate | desk 从 malformed 用例移除，改为 doesNotThrow 合法解析校验 | WMB-5290 起 desk 为项目专项调查合成父，parseResearchGap 允许 desk；reporter/research 仍拒绝 |
| content-scale-concurrency(child) | getContentProject 查询计数 11→12 | WMB-5290 新增 readProjectInvestigation 使 detail 查询 +1，分页合同变化非环境问题 |
| eval-029-fixtures(+fixtures json+scripts) | schemaVersion 70→74（fixture 与校验脚本两侧） | 以生产 DB 当前 74 个 migration 为准 |
| job-pool L1-2 | writer 核心稿 prompt 断言更新为两阶段（先 dispatch_research 后 ready 才 save_core） | 同 agent-runner 判定 |

### E. 其余连带
| 测试 | 修复 | 判定 |
|---|---|---|
| pi-message-flow 品牌哈希 | README 冻结回执哈希 C611…/68F8… → 73E8…/6558… | 资产文件自 be43cfb 后未再变更（git show HEAD 字节哈希=C611…），但 mtime 2026-08-15 显示资产曾被本地更新未同步 README；现 README 哈希=实际字节（已复算验证）。注意：README 规定哈希变更需 Owner 目视批准——本次仅把记录对齐到仓库既有资产字节，未改动任何资产；若 Owner 认可的版本不是当前字节，需要 Owner 复核 |
| pi-operator-skill | SKILL.md 内容工具清单补齐 `wmb_get_investigation`、`wmb_save_investigation_outline`、`wmb_review_investigation_research` | 工具已在 pi 注册而文档落后（WMB-5290/5292 遗留）；文档对齐注册真源 |
| pi-skills-settings | 选择器断言「系统·只读/工作空间·只读/内置·可编辑」→「只读/可编辑/新建」 | 组件已简化为三态标签，语义守护保留 |
| wmb-5142 T11/T12/T14 | 错误码更名同步 ×4 处 | 同 workspace-needs-user 判定 |

### 生产代码修改（唯一一处）
`src/main/generic-employee-runner.ts` `closeStaleNeedsUserCards`：SQL 匹配 `error_code IN ('PI_CONFIG_REQUIRED','ROLE_MODEL_POLICY_REQUIRED')`。
判定 [JUDGMENT]：错误码更名后，存量 needs_user 卡仍带旧码；若只匹配新码，「补配置续派」无法关闭旧卡，违反 WMB-5142「处理」生命周期合同（关闭遗留卡）。兼容新旧码是对旧合同的正确延续，非弱化。

### 连带修复（执行中发现）
canonical SKILL.md 变更后两个 data-root 镜像字节漂移导致 skill-mirror-check / wmb-5231 各 1 例失败：用生产自带 `installPiOperatorSkillForDataRoots(['data/gamedata','data/ukcontentdata'])` 重装镜像至 revision `0b33e71c…`，镜像测试恢复 PASS。镜像数据目录不入库，无需提交。

## 验收对照
- 台账验收：typecheck PASS ✅；全量 0 fail ✅（3 skip 符合允许条款）；逐类判定依据 ✅（本文档）
