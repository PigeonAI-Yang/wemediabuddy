# WMB-4917 验收证据

日期：2026-08-06

## 实机闭环（AI 工作空间，gpt-5.6-terra preset）

1. 扫描：5/5 渠道，入库 100 条（X 渠道绑定未验证时走降级，官网源照常）。
2. 判断：约 90 秒，模型按「编辑简报 + 四问」输出一个 ```json 方案块。
3. 系统代存：`parseDailyPlanOutput` 校验 → `savePlanFromSynthesisOutput` 经 dispatcher（plans.save + 自动 task grant + worker lease）落库。
4. 结果：「今日运营方案已就绪」——5 个机会：
   - Qwen3.8-Max 排到第五，但 Agentic Index 第一：模型榜单正在分裂（S）
   - DeepSeek V4 Pro 擅长跑 Shell，Kimi K3 擅长调工具：真实花费正在重写模型（OpenRouter 数据）
   - AI 服务最值钱的能力不是提示词，而是需求翻译
   - Meta Muse Code 实验：Coding Agent 能力与可用性
   - 从想法到硬件 5 天
5. 池视图：6 项，新机会带「新」徽章、热点/长青分类、「还剩 ~71h」倒计时；否掉按钮可用（前一轮实机已验证 dismiss 后池 2→1）。

截图：`.ai/wmb-4917-acceptance.png`（方案就绪态）、`.ai/today-pool-final.png`（池卡渲染）、`.ai/today-dismissed.png`（否决后）。

## 关键缺陷修复链（验收过程中实机暴露）

1. 判断路径发酵池刷新被 WMB_WRITE 守卫拦截 → 改经 dispatcher `daily.refresh_carry`，简报只读。
2. 取消对无 runner 任务失效（幽灵 resume_pending 80+ 分钟）→ control-daily cancel 直接 dispatchCancelAgentTask。
3. `wmb_get_workbench` 返回 868KB 全量工作台挤爆模型上下文 → prompt 显式禁用，简报即上下文。
4. 模型臆造工具名空转（四轮证据）→ 结构化输出路径取代工具调用；白名单兜底。
5. plans.save 归属校验只读 mcp_request_results（预存缺陷，真任务恒 partial）→ 补 command_receipts 回退（WMB-4912）。
6. 会话 JSONL 原始文本含转义，围栏解析必须先解码 assistant 段（回放测试锁定）。
7. resume 复用会话文件可能误存旧围栏 → baseline 只读本轮增量行（评审 N1）。

## 模型能力结论

DeepSeek V4 Flash（OpenCode Go 与 AMD 两条通道，openai-completions）五轮实机均无法完成判断：臆造工具名、schema 反复校验失败、bash 乱探、最终从未产出方案。gpt-5.6-terra 一次通过（30-90 秒，结构化输出合规、四问齐备、真实 sourceIds）。**判断环节的最低模型门槛已被实机标定**；当前 active preset 保留为 terra（用户可自查设置→AI 与模型切换）。
