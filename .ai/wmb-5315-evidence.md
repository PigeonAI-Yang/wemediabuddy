# WMB-5315 验收证据

## 修正

- 创作编辑器删除正文画布上方的独立「定稿配图」配置栏。
- 图像模型字段不再出现在创作编辑器；配置真源保持在「设置 → AI 与模型 → 独立配图模型」。
- 比例、张数和「定稿配图」动作并入正文格式工具条。
- 没有配图运行时不渲染额外面板；有运行记录时，工具条下只显示运行、重生和撤销反馈。
- 配图任务、Provider 调用、持久化、正文插入、重生和撤销逻辑未改变。

## 真实 Electron gate

```text
node tests/e2e/runner.mjs --file tests/e2e/studio.test.mjs --scenario WMB-5312-studio-illustration-workflow
PASS 1/1
```

1100×800 实测：设置页图像模型入口可见；编辑器无模型字段、无空配图面板；工具条选择 21:9/1 张并启动真实混合配图；来源图与生成图完成，结构化比例到达 Provider，原位重生、撤销、SQLite/Renderer 重载读回均成立，page error 0。

截图：`tests/e2e/.artifacts/WMB-5312-studio-illustration-workflow-wn9wAi/studio-illustration-workflow-screenshot.png`。

设计 token 漂移门：`node --test tests/design-tokens-drift.test.mjs`，3/3 PASS。
测试 Electron 标签页已关闭；受管进程列表无运行中的测试浏览器。用户开发服务保持运行。
