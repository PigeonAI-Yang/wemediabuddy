# 智能体页增强可视化（实施稿）

- 日期：2026-08-07
- Designer: AgentsVizDesigner
- 状态：已实现（renderer）

## 结论

智能体页从「名册+列表」升级为可观测操作面：

1. **工位占用条 SeatStrip**（desk + 4 员工席）  
2. **状态双编码**（点形 + 词 + 色）  
3. **工单板三轨**（执行中 / 排队中 / 终态）  
4. **扫描 vs 工单** 标签区分；冲突 callout  
5. 空态教一步派单  

零新 IPC。实现文件：`agents-roster-view.tsx`、`styles-agents.css`、`styles-foundation.css`（`--status-running`）、`today-command-bar.tsx` chip。

## 验收对照

- 工位条 5 格常驻首屏  
- desk 占用/冲突可见  
- 三轨 + 类型过滤  
- 令牌化 status-running，去掉硬编码主路径  
- 导航「智能体」不变  

详见 designer 输出与代码。
