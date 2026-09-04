# AI 官网来源安装态修复

## 问题

AI 主工作空间的官方来源注册表已有 17 个启用的 `official-web` 来源，但设置页读取根目录数据库的 `website_sources`。该表为 0，因此用户看到“官网渠道 0”。

## 根因

注册表 `skills/wemedia-intelligence-engine/references/source-index.json` 与工作空间可管理渠道表之间没有启动同步。后台扫描链和 UI 使用了两套未连接的来源投影。

## 修复

- `loadOfficialWebsiteSources()` 从当前 intelligence pack 读取启用的 `official-web` 来源。
- AI 工作空间启动、写保护安装前，`syncOfficialWebsiteSources()` 将缺失来源幂等写入本根的 `source_feeds + website_sources`。
- 仅 `wemedia-intelligence-engine` 工作空间执行；UK 与游戏工作空间不注入 AI 官网来源。
- 初始化来源标记为 enabled/ready，但 `last_checked_at` 保持 NULL，避免伪造已扫描事实。

## 安装态验证

- 安装路径：`C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe`
- 工作空间数据库：`J:/PigeonYang/WeMediaBuddyData/wmb.db`
- `website_sources`：17 行，全部 `enabled=1`、`resolution_status='ready'`。
- 真实 Electron 设置 > 情报渠道：显示 17 个官网 URL；OpenAI News、Anthropic News 可见；每项提供“立即扫描”。
- 幂等测试：首次配置 17，第二次配置 0、识别 existing 17。

## 自动验证

- `node --test tests/intelligence-channels.test.mjs`：3/3 passed。
- `npm run typecheck`：passed。
- `npm run package`：passed，已覆盖安装并启动验证。
