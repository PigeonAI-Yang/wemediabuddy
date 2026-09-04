# 2026-08-23 发现页账号与刷新反馈（WMB-5345/5346）

purpose: 发现页和今日资料流必须把操作状态留在触发按钮内，并把真实 X 账号身份与采集任务标签分开。
fails-when: 知乎刷新在分类栏左侧新增状态文字，或任一 X 资料行把“巡检打卡”显示成账号 ID。

## Loop

### Symptom
- 知乎分类刷新时，按钮之外出现“正在刷新”文字并挤占标题栏。
- 今日 X 资料卡的账号行被 heartbeat 标签“巡检打卡”覆盖。

### Root cause
- `zhihu-hot-view.tsx` 把异步状态同时投影到按钮和标题栏旁路文本。
- `sourceOriginLabel` 在识别 X host 前先运行 heartbeat 判定；短 X 帖会被误判为巡检任务，覆盖已有 `author` handle。
- X Lists 卡片未在 view-model 边界拒绝任务标签作为 `authorHandle`。

### Repair
- 刷新按钮使用 `idle/loading/success/failure` 原位状态机：loading 禁用并 `aria-busy=true`，success 短暂显示完成图标，failure 显示失败图标与可访问提示；移除左侧状态文字和占位。
- X host 优先规范化可信 `@handle`；缺失时显示“账号暂不可见”。非 X heartbeat 标签继续留在来源/任务语义位置。
- X Lists cached/live mapper 同样过滤“巡检打卡”等污染值，不从正文猜账号。

### Focused gate
- `node --test tests/wmb-5345-zhihu-refresh-button.test.mjs tests/wmb-5346-discovery-account.test.mjs`: 9/9 PASS。
- 隔离 Forge package：`J:/wmb-out-5346/WeMediaBuddy-win32-x64/WeMediaBuddy.exe`，Vite/Forge/postPackage PASS。

### Real UI gate
- 真实 data root 的 Today 资料流读取到 168 个 X 来源标签；前 20 个均为真实 `@handle`，`polluted=[]`，`overflow=0`。
- 知乎“等待回答”真实按钮 DOM 依次记录：`刷新知乎等待回答` → `正在刷新知乎等待回答`（disabled、`aria-busy=true`）→ `刷新失败，请重试`。隔离 userData 未绑定 BrowserProfile，因此本次真实刷新正确进入 failure；success→idle 由聚焦合同覆盖。
- `.zhihu-hot-refresh-status` 不存在，分类栏无“正在刷新”旁路文字，`overflow=0`，`pageerror=[]`。
- 截图：`2026-08-23-discovery-account-after.png`、`2026-08-23-zhihu-refresh-after.png`。

### Owner check
- user-blocked-on: 状态文案污染布局；任务标签冒充账号。
- now-usable: 刷新状态归属按钮；X 账号行显示真实 handle 或明确不可见。
- real-data-or-state: 真实 workspace/data root、真实 Today 来源与真实刷新调用。
- loading-empty-error-states: loading/success/failure/idle 合同完整；真实 failure 未被吞掉。
- v1-v2-baseline-preserved: 榜单、Lists、采集、权限、DB schema、Pi dock 未改变。
- regression-risk-checked: 9/9 聚焦合同，真实 UI overflow/pageerror 检查。
- would-user-return-this: no。

Clean completion: yes

## Resource cleanup
- 测试浏览器标签页与 CDP 会话已关闭。
- 受管 `wmb-discovery-ui-check` Electron 及子进程已停止并复核退出。

