selected-milestone: WMB-5223
project-purpose: 主题 Wiki 是用户读取当前综合、变化依据和下一步创作行动的主界面，不是知识对象调试台。
target-surface: 主题详情 header、七段 Wiki 导航、当前认识、最近变化、证据/创作影响/待研究/完整档案、版本历史。
runtime-chain: Topic/Wiki read model -> renderer state -> library-topics-view -> topic Wiki DOM -> computed layout -> 用户首屏理解与操作。
completion-authority: 在用户截图同尺度 1183x871 下，首屏层级明确、正文可读、空态收敛、技术日志降权、唯一主 CTA 清晰；真实数据与所有既有动作保留。
focused-gate: 主题 renderer 聚焦测试 + typecheck + 真实 Electron 1183x871 截图、DOM 几何与交互抽查。
budgets: implementation attempts=1; repair attempts=2; product files max=2; scope growth=0.
stop-conditions: 需要改变 foundation 品牌 token、主题业务语义、IPC/schema/权限、七段知识合同或新增依赖。
